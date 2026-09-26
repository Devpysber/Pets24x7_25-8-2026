// JSON API for the Pets24x7 Admin Portal SPA (/dashboard/admin/ on the static site).
// Every route is DB-backed and admin-authenticated. No hardcoded fallback data.
//
//   GET  /api/admin/overview
//   GET  /api/admin/vendors                 ?status=
//   POST /api/admin/vendors/:id/status      { status }
//   GET  /api/admin/parents
//   GET  /api/admin/listings                (claimed listings, enriched from static index)
//   POST /api/admin/listings                create one directory listing
//   GET|PATCH|DELETE /api/admin/listings/:id
//   POST /api/admin/listings/:id/hide|unhide
//   POST|PUT /api/admin/listings/:id/photos, DELETE /api/admin/listings/:id/photos/:idx
//   GET  /api/admin/directory               ?q=&city=&category=&hidden=all|only|exclude
//   GET  /api/admin/services
//   GET  /api/admin/enquiries
//   GET  /api/admin/marketing               campaigns + metrics
//   POST /api/admin/marketing/:id/status    { status }
//   GET  /api/admin/payments                ?status=
//   GET  /api/admin/memberships             ?status=
//   GET  /api/admin/reviews                 ?status=
//   POST /api/admin/reviews/:id/publish
//   POST /api/admin/reviews/:id/reject      { reason? }

import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { vendorSubscriptionStore } from '../vendors/vendor.subscriptions.routes.js';
import { syncVendorToListingIndex } from '../vendors/dashboard.routes.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, HttpError, NotFoundError } from '../shared/errors.js';
import {
  addAndPersistImportedListing,
  findListingByPhone,
  findListingsByNameCity,
  getListingById,
  indexSize,
  indexStats,
  listingRecordFromRow,
  listingSlug,
  removeListingFromIndex,
  removeListingFromJsonMirror,
  searchListings,
  setListingHiddenInIndex,
  setListingHiddenInJsonMirror,
  suggestListings,
  type ListingRecord,
} from '../listings/index.js';
import { cleanPhoto, MAX_LISTING_PHOTOS, parsePhotos } from '../listings/photos.js';
import { clearPopularCache } from '../listings/lookup.routes.js';
import { normalizePhone } from '../shared/phone.js';
import { notify } from '../whatsapp/notify.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignApprovedEmail,
  campaignCancelledEmail,
  campaignCompletedEmail,
  membershipExpiredEmail,
  reviewPublishedEmail,
  reviewRejectedEmail,
  vendorApprovedEmail,
  vendorRejectedEmail,
  vendorSuspendedEmail,
} from '../mail/action-templates.js';
import { accountDeletedEmail, reviewThanksEmail, vendorReactivatedEmail } from '../mail/lifecycle-templates.js';
import { applyFeaturedStatus } from './admin.extra.routes.js';

export const adminApiRouter = Router();
adminApiRouter.use(requireAuth('admin'));

const rupees = (minor: number) => Math.round(minor / 100);

// Server-side paging for the admin tables. `?page=&perPage=` (perPage also as
// `limit`); with neither, the first page is the same newest-N slice the
// panel always got, so existing callers are unchanged. Every list response
// carries `total`, `page` and `perPage` so a table can page past the slice.
function paging(query: Record<string, unknown>, defaultPerPage: number) {
  const n = (v: unknown) => Math.floor(Number(v));
  const rawPer = n(query.perPage ?? query.limit);
  const perPage = Number.isFinite(rawPer) && rawPer > 0 ? Math.min(rawPer, 500) : defaultPerPage;
  const rawPage = n(query.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return { page, perPage, skip: (page - 1) * perPage, take: perPage };
}

// Case-insensitive `contains`. `mode: 'insensitive'` is Postgres-only (the
// MySQL client types reject it); MySQL's *_ci collation already ignores case.
function containsCi(search: string) {
  return {
    contains: search,
    ...((process.env.DATABASE_URL ?? '').startsWith('postgres') ? ({ mode: 'insensitive' } as const) : {}),
  };
}

/**
 * The one listing total the whole admin portal quotes.
 *
 * The directory index already contains every scraped listing, and a claimed
 * vendor usually points at one of those rows — adding the two counts is what
 * made the dashboard read one higher than the Vendors tab. Only a vendor whose
 * listing is NOT in the index (a self-registered business) adds to the total.
 */
export async function totalListingCount(): Promise<number> {
  // Hidden listings included: they are still in the directory, only kept
  // off the public site (whose counters, indexStats(), leave them out).
  const base = indexSize();
  let extra = 0;
  try {
    // Bounded: a genuinely unbounded scan here would get slower every time a
    // vendor claims a listing. 50k comfortably covers the current scale (a
    // few thousand claimed vendors) with headroom; beyond that this count
    // should move to a DB-side query instead of an in-Node filter.
    const claimed = await prisma.vendor.findMany({
      where: { listingId: { not: null } },
      select: { listingId: true },
      take: 50_000,
    });
    extra = claimed.filter((v) => v.listingId && !getListingById(v.listingId)).length;
  } catch {
    // DB offline — the index count alone is still the honest number.
  }
  return base + extra;
}

// ---------- Overview ----------
adminApiRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const idxStats = indexStats();
    const [
      totalVendors,
      pendingVendors,
      activeVendors,
      claimedVendors,
      petParents,
      activeListings,
      totalEnquiries,
      activeCampaigns,
      pendingCampaigns,
      reportedReviews,
      pendingReviews,
      revenueAgg,
      monthRevenueAgg,
      recentVendors,
      recentParents,
      recentEnquiries,
      recentPayments,
      activeMemberships,
    ] = await Promise.all([
      prisma.vendor.count({ where: { claimedAt: { not: null } } }),
      prisma.vendor.count({ where: { status: 'PENDING' } }),
      prisma.vendor.count({ where: { status: 'ACTIVE', claimedAt: { not: null } } }),
      prisma.vendor.count({ where: { listingId: { not: null }, claimedAt: { not: null } } }),
      prisma.petParent.count(),
      prisma.vendor.count({ where: { status: 'ACTIVE', listingId: { not: null }, claimedAt: { not: null } } }),
      prisma.enquiry.count(),
      prisma.marketingCampaign.count({ where: { status: 'ACTIVE' } }),
      prisma.marketingCampaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.review.count({ where: { status: 'HIDDEN' } }),
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { status: 'SUCCESS' } }),
      prisma.payment.aggregate({
        _sum: { amountMinor: true },
        where: { status: 'SUCCESS', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
      prisma.vendor.findMany({ where: { claimedAt: { not: null } }, orderBy: { createdAt: 'desc' }, take: 5, select: { businessName: true, city: true, createdAt: true } }),
      prisma.petParent.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, city: true, createdAt: true } }),
      prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, listingName: true, category: true, createdAt: true } }),
      prisma.payment.findMany({ where: { status: 'SUCCESS' }, orderBy: { createdAt: 'desc' }, take: 5, select: { amountMinor: true, purpose: true, createdAt: true } }),
      prisma.membership.count({ where: { status: 'ACTIVE' } }),
    ]);

    const [
      enquiriesByStatusRaw,
      membershipsByPlanRaw,
      campaignsByGoalRaw,
      featuredPurchased,
      featuredCount,
    ] = await Promise.all([
      prisma.enquiry.groupBy({ by: ['status'], _count: { _all: true } }),
      // Live members only: a PENDING row is an abandoned checkout, not a subscriber.
      prisma.membership.groupBy({ by: ['planId'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
      // Grow Business purchases are campaigns + featured slots a vendor paid for
      // (or was granted): the rows Grow Business buyers lists by default, per
      // purchaseKind(). A checkout that was abandoned, or cancelled after its
      // payment failed, is not a purchase; counting CANCELLED rows here made
      // this chart show sales that the buyers tab (rightly) did not.
      prisma.marketingCampaign.groupBy({
        by: ['goal'],
        where: {
          OR: [
            { payment: { is: { status: { in: ['SUCCESS', 'REFUNDED'] } } } },
            { status: { notIn: ['PENDING_PAYMENT', 'CANCELLED'] } },
          ],
        },
        _count: { _all: true },
      }),
      prisma.featuredListing.count({
        where: {
          OR: [
            { payment: { is: { status: { in: ['SUCCESS', 'REFUNDED'] } } } },
            { status: { notIn: ['PENDING_PAYMENT', 'CANCELLED'] } },
          ],
        },
      }),
      prisma.featuredListing.count({ where: { status: 'ACTIVE', endsAt: { gt: new Date() } } }),
    ]);

    const totalListings = await totalListingCount();
    // Real index numbers. A fallback here would print a healthy-looking figure
    // on a server whose directory failed to load, hiding the actual fault.
    const totalCities = idxStats.cities ?? 0;
    const totalCategories = idxStats.categories ?? 0;
    const totalClaimedListings = claimedVendors;
    const totalSubscriptions = activeMemberships;
    // Grow Business = the vendor-side advertising products running right now.
    // This used to count gold pet-parent memberships, which are not a business plan.
    const totalGrowBusinessPlan = activeCampaigns + featuredCount;

    // Enquiries Lead Status Breakdown
    const enquiryMap: Record<string, number> = { NEW: 0, RESPONDED: 0, COMPLETED: 0, ARCHIVED: 0 };
    for (const item of enquiriesByStatusRaw) {
      enquiryMap[item.status] = item._count._all;
    }
    // Real counts only. The previous version substituted percentages of a total
    // whenever a status had none, so an empty platform still drew a healthy
    // funnel — a chart that cannot show bad news is worth nothing.
    const enquiryConversion = {
      labels: ['Responded / Contacted', 'New Leads', 'Completed / Converted', 'Archived'],
      counts: [
        enquiryMap.RESPONDED ?? 0,
        enquiryMap.NEW ?? 0,
        enquiryMap.COMPLETED ?? 0,
        enquiryMap.ARCHIVED ?? 0,
      ],
    };

    // Grow Business Plan Breakdown — what vendors actually bought, by product.
    // Real rows, and zeros when there are none.
    const goalCount = (g: string) =>
      (campaignsByGoalRaw as Array<{ goal: string; _count: { _all: number } }>).find((x) => x.goal === g)?._count._all ?? 0;
    const growPlanBreakdown = {
      labels: ['WhatsApp Enquiry Campaigns', 'Website Lead Campaigns', 'Profile Visit Campaigns', 'Featured Top Placements'],
      counts: [goalCount('WHATSAPP_ENQUIRIES'), goalCount('WEBSITE_LEADS'), goalCount('PROFILE_VISITS'), featuredPurchased],
    };

    // Pet Parent Subscriptions Breakdown
    const planList = await prisma.membershipPlan.findMany({ select: { id: true, name: true } });
    const planMap: Record<string, number> = {};
    for (const item of membershipsByPlanRaw) {
      const p = planList.find((x) => x.id === item.planId);
      const name = p ? p.name : 'Standard Subscription';
      planMap[name] = (planMap[name] || 0) + item._count._all;
    }
    // One slice per plan that actually has members. An empty platform charts
    // nothing rather than three invented tiers.
    const subscriptionBreakdown = {
      labels: Object.keys(planMap),
      counts: Object.values(planMap),
    };

    // Category and City distribution — straight from the live index. The old
    // invented fallback figures drew a full chart even when the index was empty.
    const topCats = idxStats.topCategories ?? [];
    const topCities = idxStats.topCities ?? [];

    // Real history: each month is what the platform actually held at the end of
    // it. The old version multiplied today's total by a hand-picked curve, so
    // the "growth" line was decoration rather than data.
    const MONTHS_BACK = 9;
    const monthStart = (offset: number) => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth() - offset, 1);
    };
    const monthEdges: Date[] = [];
    for (let i = MONTHS_BACK - 1; i >= 0; i--) monthEdges.push(monthStart(i));
    const monthLabels = monthEdges.map((d) => d.toLocaleString('en-US', { month: 'short' }));
    const upTo = monthEdges.map((d, i) =>
      i === monthEdges.length - 1 ? new Date() : monthEdges[i + 1]!,
    );

    const [vendorHistory, parentHistory] = await Promise.all([
      Promise.all(upTo.map((end) => prisma.vendor.count({ where: { createdAt: { lt: end } } }))),
      Promise.all(upTo.map((end) => prisma.petParent.count({ where: { createdAt: { lt: end } } }))),
    ]);
    // Imported rows carry a date; the scraped baseline does not, so it is
    // counted as having always been there, which is true of the directory.
    // The baseline is one number — counted once, not once per month.
    const listingBase = await prisma.listing.count({ where: { importedAt: null } }).catch(() => 0);
    const listingHistory = await Promise.all(
      upTo.map(async (end) => {
        const added = await prisma.listing.count({ where: { importedAt: { lt: end } } }).catch(() => 0);
        return listingBase + added;
      }),
    );

    const growthTrajectory = {
      months: monthLabels,
      listings: listingHistory,
      vendors: vendorHistory,
      parents: parentHistory,
    };

    const pendingActions = [
      { id: 'pa1', text: `${pendingVendors} vendors awaiting approval`, target: 'vendors', count: pendingVendors },
      { id: 'pa2', text: `${pendingCampaigns} campaigns pending review`, target: 'grow-buyers', count: pendingCampaigns },
      { id: 'pa3', text: `${pendingReviews} reviews awaiting moderation`, target: 'reviews', count: pendingReviews },
      { id: 'pa4', text: `${reportedReviews} reported reviews`, target: 'reviews', count: reportedReviews },
    ].filter((a) => a.count > 0);

    const fmtActivity = (title: string, detail: string, at: Date) => ({
      id: `${title}-${at.getTime()}`,
      title,
      detail: `${detail} · ${at.toLocaleString()}`,
      at,
    });
    const recentActivity = [
      ...recentVendors.map((v) => fmtActivity('New vendor registered', `${v.businessName} · ${v.city ?? '—'}`, v.createdAt)),
      ...recentParents.map((p) => fmtActivity('New pet parent registered', p.name ?? 'Pet Parent', p.createdAt)),
      ...recentEnquiries.map((e) => fmtActivity('New enquiry', `${e.name} → ${e.listingName ?? e.category ?? 'vendor'}`, e.createdAt)),
      ...recentPayments.map((p) => fmtActivity('Payment received', `₹${rupees(p.amountMinor).toLocaleString()} · ${p.purpose}`, p.createdAt)),
    ]
      // Newest first by timestamp. Sorting on `detail` ordered the feed by the
      // business / parent name that string starts with, not by when it happened.
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 10);

    res.json({
      ok: true,
      stats: {
        totalListings,
        totalClaimedListings,
        totalSubscriptions,
        totalCategories,
        totalCities,
        totalGrowBusinessPlan,

        totalVendors,
        petParents,
        activeListings,
        totalEnquiries,
        activeCampaigns,
        revenue: rupees(revenueAgg._sum.amountMinor ?? 0),
        revenueThisMonth: rupees(monthRevenueAgg._sum.amountMinor ?? 0),
        pendingVendors,
        activeVendors,
      },
      analytics: {
        growthTrajectory,
        categoryShare: {
          labels: topCats.map((c) => c.name),
          counts: topCats.map((c) => c.count),
        },
        cityCoverage: {
          labels: topCities.map((c) => c.name),
          counts: topCities.map((c) => c.count),
        },
        enquiryConversion,
        growPlanBreakdown,
        subscriptionBreakdown,
      },
      pendingActions,
      recentActivity,
    });
  }),
);

// ---------- Vendors ----------
adminApiRouter.get(
  '/vendors',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '').toUpperCase();
    const search = String(req.query.q ?? req.query.search ?? '').toLowerCase().trim();
    const category = String(req.query.category ?? '').toLowerCase().trim();

    // Search runs in the database, so a vendor older than the newest 200 can
    // still be found. The page itself stays capped.
    // `mode: 'insensitive'` is Postgres-only (the MySQL client types reject it);
    // MySQL's *_ci collation already compares case-insensitively.
    const ci = {
      contains: search,
      ...((process.env.DATABASE_URL ?? '').startsWith('postgres') ? ({ mode: 'insensitive' } as const) : {}),
    };
    const dbWhere = search
      ? { OR: [{ businessName: ci }, { ownerName: ci }, { email: ci }, { phone: { contains: search } }, { city: ci }, { locality: ci }, { category: ci }] }
      : {};

    // The headline counts come from count() over the whole table. Deriving them
    // from the 200-row page made every tile stop at 200 once the platform grew.
    // A status filter is applied in the database too. Filtering only the newest
    // 200 rows in memory meant a claim waiting longer than that never showed
    // under "Pending", however long it had been waiting.
    const statusWhere: Prisma.VendorWhereInput | null =
      status === 'ACTIVE' || status === 'CLAIMED'
        ? { claimedAt: { not: null }, status: { in: ['ACTIVE', 'CLAIMED'] } }
        : status === 'PENDING' || status === 'SUSPENDED' || status === 'REJECTED'
          ? { status }
          : status === 'UNCLAIMED'
            ? { claimedAt: null, status: { not: 'PENDING' } }
            : null;
    const pageWhere: Prisma.VendorWhereInput = statusWhere ? { AND: [dbWhere, statusWhere] } : dbWhere;

    const [pageVendors, actionableVendors, registeredVendorsCount, activeVendorsCount, pendingVendorsCount, claimedListingsCount] = await Promise.all([
      prisma.vendor.findMany({ where: pageWhere, orderBy: { createdAt: 'desc' }, take: 200 }),
      // Unfiltered, the panel filters client-side — so the rows an admin has to
      // act on ride along even when they are older than the newest 200.
      statusWhere
        ? Promise.resolve([])
        : prisma.vendor.findMany({
            where: { AND: [dbWhere, { status: { in: ['PENDING', 'SUSPENDED'] } }] },
            orderBy: { createdAt: 'desc' },
            take: 200,
          }),
      prisma.vendor.count({ where: { OR: [{ claimedAt: { not: null } }, { status: 'PENDING' }] } }),
      prisma.vendor.count({ where: { claimedAt: { not: null }, status: { in: ['ACTIVE', 'CLAIMED'] } } }),
      prisma.vendor.count({ where: { status: 'PENDING' } }),
      prisma.vendor.count({ where: { claimedAt: { not: null } } }),
    ]);
    const seen = new Set(pageVendors.map((v) => v.id));
    const dbVendors = [...pageVendors, ...actionableVendors.filter((v) => !seen.has(v.id))];

    const formattedDbVendors = dbVendors.map((v) => {
      const isClaimed = v.claimedAt !== null;
      const effectiveStatus = isClaimed
        ? (v.status === 'ACTIVE' ? 'CLAIMED' : v.status)
        : (v.status === 'PENDING' ? 'PENDING' : 'UNCLAIMED');

      return {
        id: v.id,
        name: v.businessName,
        owner: isClaimed ? (v.ownerName || v.email || v.phone || 'Registered Owner') : '(Unclaimed Directory Listing)',
        email: isClaimed ? (v.email || '—') : '—',
        emailVerified: v.emailVerified,
        phone: v.phone || '—',
        category: v.category || 'Pet Service',
        location: [v.locality, v.city].filter(Boolean).join(', ') || v.city || '—',
        listingId: v.listingId,
        status: effectiveStatus,
        // The account's real status. `status` above is a display label (a live
        // claimed vendor reads CLAIMED), so action buttons must key off this.
        rawStatus: v.status,
        claimedAt: v.claimedAt,
        approvedAt: v.approvedAt,
        createdAt: v.createdAt,
        source: isClaimed ? 'REGISTERED_VENDOR' : 'DIRECTORY_LISTING',
      };
    });

    let directoryListingsFormatted: any[] = [];

    if (status === 'UNCLAIMED' || status === 'ALL' || status === '') {
      // Newest first: an import adds rows at the end of the index, and a capped
      // search that walks 34k scraped rows first would never reach them — which
      // is why a fresh import bumped the count but showed nothing in the table.
      const rawListings = searchListings({ q: search, category, limit: 100, newestFirst: true, includeHidden: true });
      directoryListingsFormatted = rawListings.map((l) => ({
        id: l.id,
        name: l.name,
        owner: '(Unclaimed Directory Listing)',
        email: '—',
        emailVerified: false,
        phone: l.phone || '—',
        category: l.category || 'Pet Service',
        location: [l.address, l.city].filter(Boolean).join(', ') || l.city || '—',
        listingId: l.id,
        status: 'UNCLAIMED',
        claimedAt: null,
        approvedAt: null,
        createdAt: new Date().toISOString(),
        source: 'DIRECTORY_LISTING',
        hidden: !!l.hidden,
      }));
    }

    let combinedVendors = [...formattedDbVendors, ...directoryListingsFormatted];

    if (status && status !== 'ALL') {
      // A live claimed business is labelled CLAIMED, so "ACTIVE" (what the
      // panel's filter sends) has to match that label, not the raw status.
      const wanted = status === 'ACTIVE' ? 'CLAIMED' : status;
      combinedVendors = combinedVendors.filter((v) => String(v.status).toUpperCase() === wanted);
    }

    if (search) {
      combinedVendors = combinedVendors.filter((v) =>
        v.name.toLowerCase().includes(search) ||
        v.owner.toLowerCase().includes(search) ||
        v.category.toLowerCase().includes(search) ||
        v.location.toLowerCase().includes(search) ||
        v.phone.toLowerCase().includes(search)
      );
    }

    res.json({
      ok: true,
      vendors: combinedVendors,
      totalDirectoryListings: await totalListingCount(),
      registeredVendorsCount,
      activeVendorsCount,
      pendingVendorsCount,
      claimedListingsCount,
    });
  }),
);

const VendorStatusBody = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED']), reason: z.string().max(240).optional() });

adminApiRouter.post(
  '/vendors/:id/status',
  asyncHandler(async (req, res) => {
    const parsed = VendorStatusBody.parse(req.body);
    const status = parsed.status;
    // The panel always sends `reason`, empty when there is none — store and
    // mail null rather than an empty "Reason:" line.
    const reason = parsed.reason?.trim() || undefined;
    const id = req.params.id ?? '';
    const existing = await prisma.vendor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Vendor not found');

    const data: Record<string, unknown> = { status };
    if (status === 'ACTIVE') data.approvedAt = new Date();
    if (status === 'REJECTED') data.rejectedReason = reason ?? null;
    // Disabling an account has to end its live sessions too, or the vendor's
    // existing 30-day cookie keeps working as if nothing happened.
    if (status === 'SUSPENDED' || status === 'REJECTED') data.sessionsRevokedAt = new Date();

    const v = await prisma.vendor.update({ where: { id }, data });
    // A PENDING claim's profile edits were kept off the public listing (see
    // syncVendorToListingIndex). Push them now, or the listing keeps showing
    // the pre-edit details after we tell the vendor it is "approved and live".
    if (status === 'ACTIVE' && status !== existing.status) {
      await syncVendorToListingIndex(v).catch((err) =>
        req.log.warn({ err, vendorId: id }, 'listing index sync failed after vendor approval'),
      );
    }
    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: req.auth!.sub,
        action: `vendor.${status.toLowerCase()}`,
        meta: { vendorId: id, reason: reason ?? null },
        ipAddress: req.ip ?? null,
      },
    });
    // Lifting a suspension is not a first approval: it gets its own wording
    // ("your listing is live again") rather than a second welcome.
    const reinstated = status === 'ACTIVE' && existing.status === 'SUSPENDED';
    if (status !== existing.status && v.phone) {
      if (status === 'ACTIVE') {
        notify(
          v.phone,
          reinstated
            ? `Your Pets24x7 listing "${v.businessName}" is live again. Sign in at pets24x7.com to manage it.`
            : `Your Pets24x7 listing "${v.businessName}" is approved and live. Sign in at pets24x7.com to manage it.`,
        ).catch(() => {});
      } else if (status === 'REJECTED') {
        notify(v.phone, `Your Pets24x7 listing claim for "${v.businessName}" was not approved.${reason ? ' Reason: ' + reason : ''}`).catch(() => {});
      }
    }
    if (status !== existing.status) {
      if (reinstated) notifyIf(v.email, (to) => vendorReactivatedEmail(to, v.businessName));
      else if (status === 'ACTIVE') notifyIf(v.email, (to) => vendorApprovedEmail(to, v.businessName));
      else if (status === 'REJECTED') notifyIf(v.email, (to) => vendorRejectedEmail(to, v.businessName, reason ?? null));
      else if (status === 'SUSPENDED') notifyIf(v.email, (to) => vendorSuspendedEmail(to, v.businessName));
    }
    res.json({ ok: true, id: v.id, status: v.status });
  }),
);

// ---------- Delete a vendor ----------
// Everything the vendor owns goes with them (services, campaigns, featured
// slots, reviews, claims). Payments are money records and are kept: the rows
// that point at a campaign or a featured slot are unhooked first, both so the
// delete does not trip a foreign key and so the ledger still adds up.
adminApiRouter.delete(
  '/vendors/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      select: { id: true, businessName: true, email: true, phone: true, listingId: true },
    });
    if (!vendor) throw new NotFoundError('Vendor not found');

    const [campaigns, featured] = await Promise.all([
      prisma.marketingCampaign.findMany({ where: { vendorId: id }, select: { id: true } }),
      prisma.featuredListing.findMany({ where: { vendorId: id }, select: { id: true } }),
    ]);

    await prisma.$transaction(async (tx) => {
      if (campaigns.length) {
        await tx.payment.updateMany({
          where: { campaignId: { in: campaigns.map((c) => c.id) } },
          data: { campaignId: null },
        });
      }
      if (featured.length) {
        await tx.payment.updateMany({
          where: { featuredListingId: { in: featured.map((f) => f.id) } },
          data: { featuredListingId: null },
        });
      }
      await tx.vendor.delete({ where: { id } });
    });

    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: req.auth!.sub,
        action: 'vendor.delete',
        meta: {
          vendorId: id,
          businessName: vendor.businessName,
          email: vendor.email,
          phone: vendor.phone,
          listingId: vendor.listingId,
        },
        ipAddress: req.ip ?? null,
      },
    });

    res.json({ ok: true, id, businessName: vendor.businessName });
  }),
);

// ---------- One directory listing, in full ----------
// The Vendors table mixes registered accounts with the 34k directory rows, and
// a directory row has no vendor record behind it — so "View" had nothing to
// show and there was no way to correct or remove a bad entry. These routes
// cover a listing whether or not anyone has claimed it:
//
//   POST   /listings                    create one listing (409 on a likely duplicate unless force)
//   GET    /listings/:id                everything about one listing
//   PATCH  /listings/:id                edit any directory field (incl. hidden)
//   DELETE /listings/:id                remove an unclaimed listing
//   POST   /listings/:id/hide|unhide    take it off / put it back on every public API
//   POST   /listings/:id/photos         add photos       { photos: string[] } | { photo: string }
//   PUT    /listings/:id/photos         replace / reorder { photos: string[] } | { order: number[] }
//   DELETE /listings/:id/photos/:idx    remove one photo

/** Full admin view of a listings row (plus the index copy when the row is missing). */
function adminListingShape(
  id: string,
  row: Prisma.ListingGetPayload<object> | null,
  indexed: ReturnType<typeof getListingById>,
  vendor: { businessName: string; address: string | null; website: string | null } | null,
) {
  const country = String(row?.country ?? indexed?.country ?? 'IN').toLowerCase();
  const citySlug = row?.citySlug ?? indexed?.city_slug ?? '';
  const photos = parsePhotos(row?.photos);
  return {
    id,
    name: row?.name ?? indexed?.name ?? vendor?.businessName ?? '—',
    category: row?.category ?? indexed?.category ?? '—',
    categorySlug: row?.categorySlug ?? indexed?.category_slug ?? null,
    categoryIcon: row?.categoryIcon ?? indexed?.category_icon ?? null,
    city: row?.city ?? indexed?.city ?? '—',
    citySlug: citySlug || null,
    // True when the claim points at a directory row that is gone.
    orphanedClaim: !row && !indexed && !!vendor,
    state: row?.state ?? indexed?.state ?? null,
    country: row?.country ?? indexed?.country ?? 'IN',
    locality: row?.locality ?? null,
    // What the public page shows: a verified business's own address/website
    // first. `directory` below holds the listing's own values for the edit form.
    address: vendor?.address ?? row?.address ?? indexed?.address ?? null,
    phone: row?.phone ?? indexed?.phone ?? null,
    website: vendor?.website ?? row?.website ?? indexed?.website ?? null,
    pincode: row?.pincode ?? indexed?.pincode ?? null,
    email: row?.email ?? null,
    whatsapp: row?.whatsapp ?? null,
    description: row?.description ?? null,
    openingHours: row?.openingHours ?? null,
    services: row?.services ?? null,
    rating: row?.rating ?? indexed?.rating ?? 0,
    reviewCount: row?.reviewCount ?? indexed?.review_count ?? 0,
    googleCid: row?.googleCid ?? indexed?.google_cid ?? null,
    gmbLink: row?.gmbLink ?? indexed?.gmb_link ?? null,
    photos,
    photoCount: photos.length,
    maxPhotos: MAX_LISTING_PHOTOS,
    hidden: row?.hidden ?? indexed?.hidden ?? false,
    claimStatus: row?.claimStatus ?? indexed?.claimStatus ?? 'UNCLAIMED',
    publicUrl: citySlug ? `/${country}/${citySlug}/${id}/` : null,
    claimed: !!vendor,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
    importedAt: row?.importedAt ?? null,
    directory: {
      address: row?.address ?? indexed?.address ?? null,
      website: row?.website ?? indexed?.website ?? null,
    },
  };
}

adminApiRouter.get(
  '/listings/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const row = await prisma.listing.findUnique({ where: { id } });
    const indexed = getListingById(id);

    const vendor = await prisma.vendor
      .findUnique({
        where: { listingId: id },
        select: {
          id: true, businessName: true, email: true, phone: true, status: true,
          claimedAt: true, imageUrl: true, galleryImages: true, about: true,
          openingHours: true, servicesList: true, website: true, address: true,
        },
      })
      .catch(() => null);

    const [enquiries, reviews, activity] = await Promise.all([
      prisma.enquiry.count({ where: { listingId: id } }).catch(() => 0),
      prisma.review.count({ where: { listingId: id, status: 'PUBLISHED' } }).catch(() => 0),
      prisma.listingActivity.groupBy({ by: ['kind'], where: { listingId: id }, _count: { _all: true } }).catch(() => []),
    ]);
    const taps: Record<string, number> = {};
    for (const a of activity as Array<{ kind: string; _count: { _all: number } }>) taps[a.kind] = a._count._all;

    // A vendor can hold a claim on a listing the directory no longer has. That
    // is a broken record worth showing, not a 404 — it is exactly the case an
    // admin needs to see and fix.
    if (!row && !indexed && !vendor) throw new NotFoundError('Listing not found');

    res.json({
      ok: true,
      listing: adminListingShape(id, row, indexed, vendor),
      vendor: vendor
        ? { ...vendor, galleryImages: parseGalleryText(vendor.galleryImages) }
        : null,
      stats: {
        enquiries,
        reviews,
        phoneTaps: taps.phone_click ?? 0,
        whatsappTaps: taps.whatsapp_click ?? 0,
        views: taps.listing_view ?? 0,
      },
    });
  }),
);

// Field rules shared by create and edit. '' clears an optional field.
const optStr = (max: number) => z.string().trim().max(max).optional();
const googleCidField = z
  .string()
  .trim()
  .max(64)
  .regex(/^\d*$/, 'Google CID must be digits only (as in maps.google.com/?cid=…)')
  .optional();
const gmbLinkField = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => !v || /^https?:\/\/[^\s"'<>`]+$/.test(v), 'Google Maps link must be an http(s) URL')
  .refine((v) => {
    const m = /[?&]cid=([^&#]*)/.exec(v);
    return !m || /^\d+$/.test(m[1] ?? '');
  }, 'The cid= in the Google Maps link must be digits only')
  .optional();
const websiteField = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => !v || /^(https?:\/\/)?[^\s"'<>`]+\.[^\s"'<>`]+$/.test(v), 'Website must be a web address')
  .optional();
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(191)
  .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Email is not valid')
  .optional();

const ListingFields = {
  name: z.string().trim().min(2).max(255),
  category: z.string().trim().min(2).max(160),
  city: z.string().trim().min(2).max(160),
  state: optStr(120),
  country: z.enum(['IN', 'US']),
  locality: optStr(160),
  address: optStr(1000),
  pincode: optStr(20),
  phone: optStr(32),
  whatsapp: optStr(32),
  email: emailField,
  website: websiteField,
  description: optStr(5000),
  openingHours: optStr(1000),
  services: optStr(2000),
  googleCid: googleCidField,
  gmbLink: gmbLinkField,
  hidden: z.boolean().optional(),
};

/** '' -> null, trimmed; undefined stays undefined (field not sent). */
const blankToNull = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);

/** A phone as the importer stores it, or a 400 naming the field. */
function adminPhone(raw: string | undefined, country: 'IN' | 'US', label: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw.trim()) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new BadRequestError(`${label} "${raw}" is not a valid number`);
  return normalizePhone(raw, country);
}

/** Likely duplicates of a new listing: same last-10 phone, or same name in the same city. */
async function listingDuplicates(name: string, city: string, phone: string | null) {
  const out = new Map<string, { id: string; name: string; city: string; phone: string | null; category: string; hidden: boolean; source: 'LISTING' | 'VENDOR'; matchedOn: string[] }>();
  const add = (m: { id: string; name: string; city: string; phone: string | null; category: string; hidden?: boolean; source: 'LISTING' | 'VENDOR' }, on: string) => {
    const cur = out.get(`${m.source}:${m.id}`);
    if (cur) { if (!cur.matchedOn.includes(on)) cur.matchedOn.push(on); return; }
    out.set(`${m.source}:${m.id}`, { ...m, hidden: !!m.hidden, matchedOn: [on] });
  };
  const last10 = phone ? phone.replace(/\D/g, '').slice(-10) : '';
  if (last10.length >= 7) {
    const rows = await prisma.listing.findMany({
      where: { phoneLast10: last10 },
      select: { id: true, name: true, city: true, phone: true, category: true, hidden: true },
      take: 5,
    });
    for (const r of rows) add({ ...r, source: 'LISTING' }, 'phone');
    // Rows only in the index (JSON-seeded, or written before phoneLast10).
    for (const r of findListingByPhone(last10)) {
      add({ id: r.id, name: r.name, city: r.city, phone: r.phone ?? null, category: r.category, hidden: r.hidden, source: 'LISTING' }, 'phone');
    }
    const vendors = await prisma.vendor.findMany({
      where: { phone: { endsWith: last10 } },
      select: { id: true, businessName: true, city: true, phone: true, category: true, listingId: true },
      take: 5,
    });
    for (const v of vendors) {
      if (v.listingId && out.has(`LISTING:${v.listingId}`)) continue;
      add({ id: v.id, name: v.businessName, city: v.city ?? '', phone: v.phone, category: v.category ?? '', source: 'VENDOR' }, 'phone');
    }
  }
  for (const r of findListingsByNameCity(name, city)) {
    add({ id: r.id, name: r.name, city: r.city, phone: r.phone ?? null, category: r.category, hidden: r.hidden, source: 'LISTING' }, 'name_city');
  }
  return [...out.values()].slice(0, 10);
}

/** Directory-style id: name slug plus 8 digits, like the scraped rows. */
async function newListingId(name: string): Promise<string> {
  const base = listingSlug(name, 'listing').slice(0, 80).replace(/-+$/, '') || 'listing';
  for (let i = 0; i < 5; i++) {
    const id = `${base}-${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
    if (!getListingById(id) && !(await prisma.listing.findUnique({ where: { id }, select: { id: true } }))) return id;
  }
  return `listing_adm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

const ListingCreateBody = z.object({
  ...ListingFields,
  country: ListingFields.country.default('IN'),
  // Create anyway when the duplicate check finds a match.
  force: z.boolean().optional().default(false),
});

adminApiRouter.post(
  '/listings',
  asyncHandler(async (req, res) => {
    const body = ListingCreateBody.parse(req.body ?? {});
    const country = body.country;
    const phone = adminPhone(body.phone, country, 'Phone') ?? null;
    const whatsapp = adminPhone(body.whatsapp, country, 'WhatsApp') ?? null;

    if (!body.force) {
      const matches = await listingDuplicates(body.name, body.city, phone);
      if (matches.length) {
        throw new HttpError(
          409,
          `This looks like a listing already on Pets24x7 ("${matches[0]!.name}", ${matches[0]!.city}). Send force: true to create it anyway.`,
          'duplicate_listing',
          { matches },
        );
      }
    }

    // Slugs exactly as the importer computes them.
    const id = await newListingId(body.name);
    const record: ListingRecord = {
      id,
      name: body.name,
      category: body.category,
      category_slug: listingSlug(body.category, 'pet-service'),
      city: body.city,
      city_slug: listingSlug(body.city, 'unknown'),
      country,
      ...(blankToNull(body.state) ? { state: blankToNull(body.state)! } : {}),
      ...(blankToNull(body.address) ? { address: blankToNull(body.address)! } : {}),
      ...(phone ? { phone } : {}),
      ...(blankToNull(body.website) ? { website: blankToNull(body.website)! } : {}),
      ...(blankToNull(body.pincode) ? { pincode: blankToNull(body.pincode)! } : {}),
      ...(blankToNull(body.googleCid) ? { google_cid: blankToNull(body.googleCid)! } : {}),
      ...(blankToNull(body.gmbLink) ? { gmb_link: blankToNull(body.gmbLink)! } : {}),
      // No reviews yet, so no rating — same as an imported row.
      rating: 0,
      review_count: 0,
      claimStatus: 'UNCLAIMED',
      hidden: body.hidden ?? false,
      description: blankToNull(body.description) ?? null,
      opening_hours: blankToNull(body.openingHours) ?? null,
      services: blankToNull(body.services) ?? null,
      email: blankToNull(body.email) ?? null,
      whatsapp,
      locality: blankToNull(body.locality) ?? null,
    };

    // The importer's write path: index, MySQL, JSON mirror in one go.
    await addAndPersistImportedListing(record);
    const row = await prisma.listing.findUnique({ where: { id } });
    if (!row) {
      // addAndPersist logs and swallows a MySQL failure; do not report success.
      removeListingFromIndex(id);
      throw new HttpError(500, 'The listing could not be saved. Try again.', 'save_failed');
    }

    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN', actorId: req.auth!.sub, action: 'listing.create',
        meta: { listingId: id, name: row.name, city: row.city, forced: body.force }, ipAddress: req.ip ?? null,
      },
    });

    res.status(201).json({ ok: true, listing: adminListingShape(id, row, getListingById(id), null) });
  }),
);

const ListingPatchBody = z.object({
  name: ListingFields.name.optional(),
  category: ListingFields.category.optional(),
  city: ListingFields.city.optional(),
  state: ListingFields.state,
  country: ListingFields.country.optional(),
  locality: ListingFields.locality,
  address: ListingFields.address,
  pincode: ListingFields.pincode,
  phone: ListingFields.phone,
  whatsapp: ListingFields.whatsapp,
  email: ListingFields.email,
  website: ListingFields.website,
  description: ListingFields.description,
  openingHours: ListingFields.openingHours,
  services: ListingFields.services,
  googleCid: ListingFields.googleCid,
  gmbLink: ListingFields.gmbLink,
  hidden: ListingFields.hidden,
});

/** Fields a claimed business's own profile save writes back over the listing. */
const VENDOR_SYNCED_FIELDS = ['name', 'category', 'city', 'country', 'address', 'phone', 'website', 'pincode'];

adminApiRouter.patch(
  '/listings/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const body = ListingPatchBody.parse(req.body ?? {});
    const existing = await prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Listing not found');

    const country = (body.country ?? (existing.country === 'US' ? 'US' : 'IN')) as 'IN' | 'US';
    const phone = adminPhone(body.phone, country, 'Phone');
    const data: Prisma.ListingUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.category !== undefined ? { category: body.category, categorySlug: listingSlug(body.category, 'pet-service') } : {}),
      ...(body.city !== undefined ? { city: body.city, citySlug: listingSlug(body.city, 'unknown') } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.state !== undefined ? { state: blankToNull(body.state) } : {}),
      ...(body.locality !== undefined ? { locality: blankToNull(body.locality) } : {}),
      ...(body.address !== undefined ? { address: blankToNull(body.address) } : {}),
      ...(body.pincode !== undefined ? { pincode: blankToNull(body.pincode) } : {}),
      ...(phone !== undefined ? { phone, phoneLast10: phone ? phone.replace(/\D/g, '').slice(-10) || null : null } : {}),
      ...(body.whatsapp !== undefined ? { whatsapp: adminPhone(body.whatsapp, country, 'WhatsApp') } : {}),
      ...(body.email !== undefined ? { email: blankToNull(body.email) } : {}),
      ...(body.website !== undefined ? { website: blankToNull(body.website) } : {}),
      ...(body.description !== undefined ? { description: blankToNull(body.description) } : {}),
      ...(body.openingHours !== undefined ? { openingHours: blankToNull(body.openingHours) } : {}),
      ...(body.services !== undefined ? { services: blankToNull(body.services) } : {}),
      ...(body.googleCid !== undefined ? { googleCid: blankToNull(body.googleCid) } : {}),
      ...(body.gmbLink !== undefined ? { gmbLink: blankToNull(body.gmbLink) } : {}),
      ...(body.hidden !== undefined ? { hidden: body.hidden } : {}),
      // Marks it as touched, which also floats it to the front of the
      // in-memory index on the next boot.
      importedAt: new Date(),
    };

    const updated = await prisma.listing.update({ where: { id }, data });
    const changed = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);

    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN', actorId: req.auth!.sub, action: 'listing.update',
        meta: { listingId: id, changed }, ipAddress: req.ip ?? null,
      },
    });

    // Keep the running index in step, or the site shows the old values until
    // the next restart. Built from the whole saved row: rebuilding it from the
    // edited fields alone wrote NULL over the state, Google CID/Maps link and
    // category icon of every listing an admin touched.
    await addAndPersistImportedListing(listingRecordFromRow(updated)).catch(() => {});
    if (body.hidden !== undefined && body.hidden !== existing.hidden) clearPopularCache();

    // A claimed listing still belongs to its business: the edit stands, but
    // their next profile save writes these fields back from their account.
    const vendor = await prisma.vendor
      .findUnique({ where: { listingId: id }, select: { businessName: true, address: true, website: true } })
      .catch(() => null);
    const overwritten = vendor ? changed.filter((k) => VENDOR_SYNCED_FIELDS.includes(k)) : [];

    res.json({
      ok: true,
      listing: adminListingShape(id, updated, getListingById(id), vendor),
      ...(overwritten.length
        ? {
            warning: `"${vendor!.businessName}" has claimed this listing. When they next save their profile, any of ${overwritten.join(', ')} set on their account replaces this edit.`,
          }
        : {}),
    });
  }),
);

/** POST /listings/:id/hide and /unhide. */
function hideRoute(hidden: boolean) {
  return asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const existing = await prisma.listing.findUnique({ where: { id }, select: { id: true, name: true, city: true, hidden: true } });
    if (!existing) throw new NotFoundError('Listing not found');
    if (existing.hidden !== hidden) {
      await prisma.listing.update({ where: { id }, data: { hidden } });
      await prisma.auditLog.create({
        data: {
          actorType: 'ADMIN', actorId: req.auth!.sub, action: hidden ? 'listing.hide' : 'listing.unhide',
          meta: { listingId: id, name: existing.name, city: existing.city }, ipAddress: req.ip ?? null,
        },
      });
    }
    setListingHiddenInIndex(id, hidden);
    await setListingHiddenInJsonMirror(id, hidden);
    clearPopularCache();
    res.json({ ok: true, id, hidden, changed: existing.hidden !== hidden });
  });
}
adminApiRouter.post('/listings/:id/hide', hideRoute(true));
adminApiRouter.post('/listings/:id/unhide', hideRoute(false));

// ----- Photos for a directory listing -----
const PhotosAddBody = z
  .object({ photo: z.string().optional(), photos: z.array(z.string()).max(MAX_LISTING_PHOTOS).optional() })
  .refine((b) => !!b.photo || !!b.photos?.length, 'Send photo or photos');
const PhotosPutBody = z
  .object({ photos: z.array(z.string()).max(MAX_LISTING_PHOTOS).optional(), order: z.array(z.number().int().min(0)).optional() })
  .refine((b) => !!b.photos || !!b.order, 'Send photos (the new list) or order (current indexes in the new order)');

async function listingPhotosOrThrow(id: string) {
  const row = await prisma.listing.findUnique({ where: { id }, select: { id: true, photos: true } });
  if (!row) throw new NotFoundError('Listing not found');
  return parsePhotos(row.photos);
}

async function savePhotos(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], id: string, photos: string[], action: string, meta: Record<string, unknown>) {
  await prisma.listing.update({ where: { id }, data: { photos: photos.length ? photos : Prisma.DbNull } });
  await prisma.auditLog.create({
    data: {
      actorType: 'ADMIN', actorId: req.auth!.sub, action,
      meta: { listingId: id, count: photos.length, ...meta } as Prisma.InputJsonValue, ipAddress: req.ip ?? null,
    },
  });
  const claimed = await prisma.vendor.count({ where: { listingId: id, claimedAt: { not: null } } }).catch(() => 0);
  return {
    ok: true,
    id,
    photos,
    count: photos.length,
    maxPhotos: MAX_LISTING_PHOTOS,
    // The public page shows the business's own photos instead, when it has any.
    ...(claimed ? { note: 'This listing is claimed: its business’s own photos, when it has any, are shown instead of these.' } : {}),
  };
}

adminApiRouter.post(
  '/listings/:id/photos',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const body = PhotosAddBody.parse(req.body ?? {});
    const current = await listingPhotosOrThrow(id);
    const incoming = [...(body.photo ? [body.photo] : []), ...(body.photos ?? [])].map(cleanPhoto);
    if (current.length + incoming.length > MAX_LISTING_PHOTOS) {
      throw new BadRequestError(`A listing holds at most ${MAX_LISTING_PHOTOS} photos (it has ${current.length}).`);
    }
    res.status(201).json(await savePhotos(req, id, [...current, ...incoming], 'listing.photos.add', { added: incoming.length }));
  }),
);

adminApiRouter.put(
  '/listings/:id/photos',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const body = PhotosPutBody.parse(req.body ?? {});
    const current = await listingPhotosOrThrow(id);
    let next: string[];
    if (body.order) {
      const valid =
        body.order.length === current.length &&
        new Set(body.order).size === current.length &&
        body.order.every((i) => i < current.length);
      if (!valid) throw new BadRequestError(`order must list each of the ${current.length} current photo indexes (0-${current.length - 1}) once`);
      next = body.order.map((i) => current[i]!);
    } else {
      // Photos already stored come back exactly as served; anything new is checked.
      next = body.photos!.map((p) => (current.includes(p) ? p : cleanPhoto(p)));
    }
    res.json(await savePhotos(req, id, next, 'listing.photos.update', { order: body.order ?? null }));
  }),
);

adminApiRouter.delete(
  '/listings/:id/photos/:idx',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const idx = Number(req.params.idx);
    const current = await listingPhotosOrThrow(id);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) throw new NotFoundError('No photo at that position');
    const next = current.filter((_, i) => i !== idx);
    res.json(await savePhotos(req, id, next, 'listing.photos.delete', { removedIndex: idx }));
  }),
);

adminApiRouter.delete(
  '/listings/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const existing = await prisma.listing.findUnique({ where: { id }, select: { id: true, name: true, city: true } });
    if (!existing) throw new NotFoundError('Listing not found');

    // A claimed listing belongs to a business with an account. Removing it from
    // under them would leave a dashboard pointing at nothing, so that has to be
    // a deliberate vendor deletion instead.
    const vendor = await prisma.vendor.findUnique({ where: { listingId: id }, select: { businessName: true } });
    if (vendor) {
      throw new BadRequestError(
        `"${vendor.businessName}" has claimed this listing. Delete the vendor account first if you really mean to remove it.`,
      );
    }

    // Rows that point at the listing by id (listingId has no foreign key) go
    // with it, in one transaction. Reviews left on the directory page are
    // taken out of circulation rather than deleted, so the pet parent's own
    // history keeps them: a pending one would otherwise sit in the moderation
    // queue for a page that no longer exists, and a published one would keep
    // counting. (Reviews with a vendorId belong to a vendor account; there is
    // none here, the claimed case is refused above.) Its click and view log
    // is only about this listing and is dropped.
    const moderated = { moderatedBy: req.auth!.sub, moderatedAt: new Date(), moderationReason: 'The listing was deleted.' };
    const [pendingClosed, publishedHidden, activityRemoved] = await prisma.$transaction([
      prisma.review.updateMany({
        where: { listingId: id, vendorId: null, status: 'PENDING' },
        data: { status: 'REJECTED', ...moderated },
      }),
      prisma.review.updateMany({
        where: { listingId: id, vendorId: null, status: 'PUBLISHED' },
        data: { status: 'HIDDEN', ...moderated },
      }),
      prisma.listingActivity.deleteMany({ where: { listingId: id } }),
      prisma.listing.delete({ where: { id } }),
    ]);
    removeListingFromIndex(id);
    await removeListingFromJsonMirror(id);

    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN', actorId: req.auth!.sub, action: 'listing.delete',
        meta: {
          listingId: id, name: existing.name, city: existing.city,
          reviewsRejected: pendingClosed.count, reviewsHidden: publishedHidden.count, activityRemoved: activityRemoved.count,
        },
        ipAddress: req.ip ?? null,
      },
    });

    res.json({ ok: true, id, name: existing.name });
  }),
);

/** Gallery is stored as JSON text; a bad row must not break the panel. */
function parseGalleryText(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

// ---------- Pet parents ----------
adminApiRouter.get(
  '/parents',
  asyncHandler(async (req, res) => {
    const pg = paging(req.query, 200);
    const search = String(req.query.q ?? req.query.search ?? '').trim();
    const ci = containsCi(search);
    const where = search
      ? { OR: [{ name: ci }, { email: ci }, { phone: { contains: search } }, { city: ci }] }
      : {};
    const [parents, total] = await Promise.all([
      prisma.petParent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
        include: { pets: { select: { name: true, species: true } }, _count: { select: { enquiries: true, memberships: true } } },
      }),
      prisma.petParent.count({ where }),
    ]);
    res.json({
      ok: true,
      total,
      page: pg.page,
      perPage: pg.perPage,
      parents: parents.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email ?? '—',
        phone: p.phone,
        location: [p.city, p.country].filter(Boolean).join(', ') || '—',
        pets: p.pets.map((pt) => `${pt.name} (${pt.species})`).join(', ') || 'No pets yet',
        petCount: p.pets.length,
        enquiries: p._count.enquiries,
        memberships: p._count.memberships,
        createdAt: p.createdAt,
      })),
    });
  }),
);

// ---------- Delete a pet parent ----------
// Pets, saved listings, memberships and sign-in tokens are owned by the parent
// and go with them. Enquiries and payments are business records: they stay, with
// the link to the deleted account cleared.
adminApiRouter.delete(
  '/parents/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const parent = await prisma.petParent.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!parent) throw new NotFoundError('Pet parent not found');

    const memberships = await prisma.membership.findMany({ where: { parentId: id }, select: { id: true } });

    await prisma.$transaction(async (tx) => {
      await tx.enquiry.updateMany({ where: { petParentId: id }, data: { petParentId: null } });
      if (memberships.length) {
        await tx.payment.updateMany({
          where: { membershipId: { in: memberships.map((m) => m.id) } },
          data: { membershipId: null },
        });
      }
      await tx.payment.updateMany({ where: { parentId: id }, data: { parentId: null } });
      await tx.petParent.delete({ where: { id } });
    });

    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: req.auth!.sub,
        action: 'parent.delete',
        meta: { parentId: id, name: parent.name, email: parent.email, phone: parent.phone },
        ipAddress: req.ip ?? null,
      },
    });
    notifyIf(parent.email, (to) => accountDeletedEmail(to, parent.name ?? 'there'));

    res.json({ ok: true, id, name: parent.name });
  }),
);

// ---------- The whole directory, browsable ----------
// The Vendors table only reaches the businesses that registered. Everything
// the public actually sees — the 34k scraped rows — had no screen in the panel
// at all, so a bad entry spotted on the site could not be found here. This
// searches the live index the site serves from, pages through it, and says
// which rows a business has claimed.
adminApiRouter.get(
  '/directory',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const city = String(req.query.city ?? '').trim();
    const category = String(req.query.category ?? '').trim();
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const perPage = Math.min(60, Math.max(12, parseInt(String(req.query.perPage ?? '24'), 10) || 24));
    // Hidden listings are off the public site but always reachable here.
    const hiddenQ = String(req.query.hidden ?? 'all').toLowerCase();
    const includeHidden = hiddenQ === 'only' ? ('only' as const) : hiddenQ !== 'exclude';

    // searchListings caps a single call at 200, so paging is done over a
    // deliberately wider slice rather than by asking for an unbounded list.
    const WINDOW = 200;
    const found = searchListings({ q, city, category, limit: WINDOW, includeHidden });
    const start = (page - 1) * perPage;
    const slice = found.slice(start, start + perPage);

    const claims = slice.length
      ? await prisma.vendor
          .findMany({
            where: { listingId: { in: slice.map((l) => l.id) } },
            select: {
              listingId: true, id: true, businessName: true, status: true,
              claimedAt: true, imageUrl: true, galleryImages: true, email: true,
            },
          })
          .catch(() => [])
      : [];
    const claimBy = new Map(claims.filter((c) => c.listingId).map((c) => [c.listingId as string, c]));
    // Admin-attached photo counts, without pulling the (inline) images.
    const listingPhotoCounts = new Map<string, number>();
    if (slice.length) {
      try {
        const rows = await prisma.$queryRaw<Array<{ id: string; n: bigint | number | null }>>(
          Prisma.sql`SELECT id, JSON_LENGTH(photos) AS n FROM listings WHERE id IN (${Prisma.join(slice.map((l) => l.id))}) AND photos IS NOT NULL`,
        );
        for (const r of rows) listingPhotoCounts.set(r.id, Number(r.n ?? 0));
      } catch {
        // Not MySQL (local Postgres) or table unreadable: counts read as 0.
      }
    }

    res.json({
      ok: true,
      page,
      perPage,
      hidden: includeHidden === 'only' ? 'only' : includeHidden ? 'all' : 'exclude',
      // The index is walked lazily, so this is "at least this many" once the
      // window is full — said plainly rather than printed as a total.
      matched: found.length,
      capped: found.length >= WINDOW,
      listings: slice.map((l) => {
        const v = claimBy.get(l.id);
        return {
          id: l.id,
          name: l.name,
          category: l.category,
          categorySlug: l.category_slug,
          city: l.city,
          state: l.state ?? null,
          address: l.address ?? null,
          phone: l.phone ?? null,
          rating: l.rating,
          reviewCount: l.review_count,
          publicUrl: `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`,
          claimed: !!v,
          vendorId: v?.id ?? null,
          vendorStatus: v?.status ?? null,
          vendorEmail: v?.email ?? null,
          // A photo the business uploaded. Where there is none the panel falls
          // back to the same category photo the public page shows, so what an
          // admin sees is what a visitor sees.
          imageUrl: v?.imageUrl ?? null,
          photoCount: (v?.imageUrl ? 1 : 0) + parseGalleryText(v?.galleryImages).length,
          // Photos an admin attached to the listing itself (shown while the
          // business has none of its own).
          listingPhotoCount: listingPhotoCounts.get(l.id) ?? 0,
          // Off the public site: search, city pages, detail, recommendations.
          hidden: !!l.hidden,
        };
      }),
    });
  }),
);

// Type-ahead for the directory search boxes.
adminApiRouter.get(
  '/directory/suggest',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.field ?? 'name');
    const field = raw === 'city' || raw === 'category' ? raw : 'name';
    const suggestions = suggestListings(field, String(req.query.q ?? '').slice(0, 80), {
      city: String(req.query.city ?? '').slice(0, 80),
      category: String(req.query.category ?? '').slice(0, 80),
      limit: 8,
    });
    res.json({ ok: true, field, suggestions });
  }),
);

// ---------- Listings (claimed) ----------
adminApiRouter.get(
  '/listings',
  asyncHandler(async (_req, res) => {
    const vendors = await prisma.vendor.findMany({
      where: { listingId: { not: null }, claimedAt: { not: null } },
      orderBy: { claimedAt: 'desc' },
      take: 200,
    });
    const listings = vendors.map((v) => {
      const l = v.listingId ? getListingById(v.listingId) : undefined;
      return {
        id: v.listingId,
        name: l?.name ?? v.businessName,
        category: l?.category ?? v.category ?? '—',
        location: l?.city ?? v.city ?? '—',
        rating: l?.rating ?? null,
        reviewCount: l?.review_count ?? 0,
        vendorId: v.id,
        vendorStatus: v.status,
        claimedAt: v.claimedAt,
      };
    });
    res.json({ ok: true, listings });
  }),
);

// ---------- Services ----------
adminApiRouter.get(
  '/services',
  asyncHandler(async (req, res) => {
    const pg = paging(req.query, 300);
    const status = String(req.query.status ?? '').toUpperCase();
    const where = ['ACTIVE', 'HIDDEN'].includes(status) ? { status: status as any } : {};
    const [services, total] = await Promise.all([
      prisma.service.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
        include: { vendor: { select: { businessName: true, city: true } } },
      }),
      prisma.service.count({ where }),
    ]);
    res.json({
      ok: true,
      total,
      page: pg.page,
      perPage: pg.perPage,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        vendor: s.vendor.businessName,
        location: s.vendor.city ?? '—',
        price: rupees(s.priceMinor),
        duration: s.durationLabel,
        status: s.status,
        createdAt: s.createdAt,
      })),
    });
  }),
);

// ---------- Enquiries ----------
adminApiRouter.get(
  '/enquiries',
  asyncHandler(async (req, res) => {
    const pg = paging(req.query, 300);
    const search = String(req.query.q ?? req.query.search ?? '').trim();
    const status = String(req.query.status ?? '').toUpperCase();
    const ci = containsCi(search);
    const where = {
      ...(['NEW', 'RESPONDED', 'COMPLETED', 'ARCHIVED'].includes(status) ? { status: status as any } : {}),
      ...(search
        ? { OR: [{ name: ci }, { phone: { contains: search } }, { listingName: ci }, { category: ci }, { city: ci }] }
        : {}),
    };
    const [enquiries, total] = await Promise.all([
      prisma.enquiry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: pg.skip, take: pg.take }),
      prisma.enquiry.count({ where }),
    ]);
    res.json({
      ok: true,
      total,
      page: pg.page,
      perPage: pg.perPage,
      enquiries: enquiries.map((e) => ({
        id: e.id,
        parent: e.name,
        phone: e.phone,
        vendor: e.listingName ?? '—',
        service: e.category ?? 'General enquiry',
        city: e.city ?? '—',
        source: e.source ?? '—',
        status: e.status,
        notes: e.notes,
        date: e.createdAt,
      })),
    });
  }),
);

// ---------- Marketing campaigns ----------
adminApiRouter.get(
  '/marketing',
  asyncHandler(async (_req, res) => {
    const [campaigns, active, pendingReview, completed, revenueAgg] = await Promise.all([
      prisma.marketingCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { vendor: { select: { businessName: true } }, payment: { select: { status: true, amountMinor: true } } },
      }),
      prisma.marketingCampaign.count({ where: { status: 'ACTIVE' } }),
      prisma.marketingCampaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.marketingCampaign.count({ where: { status: 'COMPLETED' } }),
      prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { purpose: 'CAMPAIGN', status: 'SUCCESS' } }),
    ]);
    res.json({
      ok: true,
      metrics: { active, pending: pendingReview, completed, revenue: rupees(revenueAgg._sum.amountMinor ?? 0) },
      campaigns: campaigns.map((c) => ({
        id: c.id,
        vendor: c.vendor.businessName,
        goal: c.goal,
        duration: `${c.durationDays} Days`,
        amount: rupees(c.priceMinor),
        // Only a SUCCESS payment is money received; `amount` is the plan price.
        paid: c.payment?.status === 'SUCCESS',
        amountPaid: c.payment?.status === 'SUCCESS' ? rupees(c.priceMinor) : 0,
        purchaseLabel: PURCHASE_LABEL[purchaseKind(c.status, c.payment?.status)],
        status: c.status,
        paymentStatus: c.payment?.status ?? null,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        createdAt: c.createdAt,
      })),
    });
  }),
);

const CampaignStatusBody = z.object({ status: z.enum(['PENDING_REVIEW', 'ACTIVE', 'COMPLETED', 'CANCELLED']) });

type CampaignStatusValue = z.infer<typeof CampaignStatusBody>['status'];

/**
 * One campaign status change, shared by the Marketing tab and the Grow Business
 * buyers tab so both set the run window, write the audit row and mail the vendor
 * the same way. Returns null when no campaign has that id.
 */
async function applyCampaignStatus(
  actor: { sub: string; ip: string | null },
  id: string,
  status: CampaignStatusValue,
) {
  const existing = await prisma.marketingCampaign.findUnique({ where: { id } });
  if (!existing) return null;

  const data: Record<string, unknown> = { status };
  if (status === 'ACTIVE' && (!existing.startsAt || (existing.endsAt && existing.endsAt <= new Date()))) {
    // First approval, or reactivating a run whose window already closed: the
    // run starts today for its full length. Reusing an old window made
    // "Reactivate" produce a campaign that was ACTIVE but already over.
    const now = new Date();
    data.startsAt = now;
    data.endsAt = new Date(now.getTime() + existing.durationDays * 24 * 3600 * 1000);
  }
  const c = await prisma.marketingCampaign.update({ where: { id }, data });
  await prisma.auditLog.create({
    data: { actorType: 'ADMIN', actorId: actor.sub, action: `campaign.${status.toLowerCase()}`, meta: { campaignId: id }, ipAddress: actor.ip },
  });
  if (status !== existing.status) {
    const vendor = await prisma.vendor
      .findUnique({ where: { id: c.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    const goal = String(c.goal);
    if (vendor?.email) {
      if (status === 'ACTIVE') {
        notifyIf(vendor.email, (to) =>
          campaignApprovedEmail(to, vendor.businessName, { goal, durationDays: c.durationDays }, c.endsAt),
        );
      } else if (status === 'CANCELLED') {
        notifyIf(vendor.email, (to) => campaignCancelledEmail(to, vendor.businessName, goal));
      } else if (status === 'COMPLETED') {
        notifyIf(vendor.email, (to) => campaignCompletedEmail(to, vendor.businessName, goal));
      }
    }
  }
  return c;
}

adminApiRouter.post(
  '/marketing/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = CampaignStatusBody.parse(req.body);
    const c = await applyCampaignStatus({ sub: req.auth!.sub, ip: req.ip ?? null }, req.params.id ?? '', status);
    if (!c) throw new NotFoundError('Campaign not found');
    res.json({ ok: true, id: c.id, status: c.status });
  }),
);

// ---------- Payments ----------
adminApiRouter.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '');
    const where = ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELLED'].includes(status)
      ? { status: status as any }
      : {};
    const pg = paging(req.query, 200);
    const [payments, byStatus, monthAgg, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
        include: {
          parent: { select: { name: true } },
          membership: { include: { plan: { select: { name: true } } } },
          campaign: { include: { vendor: { select: { businessName: true } } } },
          featuredListing: { include: { vendor: { select: { businessName: true } } } },
        },
      }),
      prisma.payment.groupBy({ by: ['status'], _count: true, _sum: { amountMinor: true } }),
      prisma.payment.aggregate({
        _sum: { amountMinor: true },
        where: { status: 'SUCCESS', createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
      }),
      prisma.payment.count({ where }),
    ]);

    const sumFor = (s: string) => rupees(byStatus.find((b) => b.status === s)?._sum.amountMinor ?? 0);

    res.json({
      ok: true,
      total,
      page: pg.page,
      perPage: pg.perPage,
      metrics: {
        total: byStatus.reduce((acc, b) => acc + (b.status === 'SUCCESS' ? rupees(b._sum.amountMinor ?? 0) : 0), 0),
        thisMonth: rupees(monthAgg._sum.amountMinor ?? 0),
        pending: sumFor('PENDING') + sumFor('INITIATED'),
        refunds: sumFor('REFUNDED'),
      },
      payments: payments.map((p) => {
        const who =
          p.parent?.name ??
          p.campaign?.vendor.businessName ??
          p.featuredListing?.vendor.businessName ??
          '—';
        const item =
          p.membership?.plan.name ??
          (p.campaign ? `Campaign · ${p.campaign.durationDays} Days` : null) ??
          (p.featuredListing ? `Featured · ${p.featuredListing.durationDays} Days` : null) ??
          p.purpose;
        return {
          id: p.id,
          payer: who,
          item,
          purpose: p.purpose,
          amount: rupees(p.amountMinor),
          currency: p.currency,
          status: p.status,
          txnId: p.gatewayTxnId ?? p.merchantTxnId,
          date: p.createdAt,
        };
      }),
    });
  }),
);

// ---------- Memberships ----------
adminApiRouter.get(
  '/memberships',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '');
    const where = ['ACTIVE', 'PENDING', 'EXPIRED', 'CANCELLED', 'REFUNDED'].includes(status)
      ? { status: status as any }
      : {};
    const [memberships, active, pending, expired] = await Promise.all([
      prisma.membership.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { parent: { select: { name: true, phone: true } }, plan: { select: { name: true, tier: true } } },
      }),
      prisma.membership.count({ where: { status: 'ACTIVE' } }),
      prisma.membership.count({ where: { status: 'PENDING' } }),
      prisma.membership.count({ where: { status: 'EXPIRED' } }),
    ]);
    res.json({
      ok: true,
      metrics: { active, pending, expired },
      memberships: memberships.map((m) => ({
        id: m.id,
        parent: m.parent.name,
        phone: m.parent.phone,
        plan: m.plan.name,
        tier: m.plan.tier,
        amount: rupees(m.pricePaidMinor),
        status: m.status,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        createdAt: m.createdAt,
      })),
    });
  }),
);

// ---------- Reviews ----------
adminApiRouter.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '');
    const where = ['PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN'].includes(status) ? { status: status as any } : {};
    const pg = paging(req.query, 200);
    const [reviews, pending, published, rejected, total] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pg.skip,
        take: pg.take,
        include: { vendor: { select: { businessName: true } } },
      }),
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.review.count({ where: { status: 'PUBLISHED' } }),
      prisma.review.count({ where: { status: 'REJECTED' } }),
      prisma.review.count({ where }),
    ]);
    res.json({
      ok: true,
      total,
      page: pg.page,
      perPage: pg.perPage,
      metrics: { pending, published, rejected },
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewer: r.reviewerName,
        vendor: r.vendor?.businessName ?? r.listingName ?? 'Unclaimed listing',
        listingId: r.listingId,
        rating: r.rating,
        comment: r.text,
        status: r.status,
        date: r.createdAt,
      })),
    });
  }),
);

// The business behind a review. A review left before the listing was claimed
// has no vendorId, but the vendor who has since claimed that listing is still
// the one to tell.
async function reviewVendor(r: { vendorId: string | null; listingId: string | null }) {
  const select = { email: true, businessName: true } as const;
  if (r.vendorId) return prisma.vendor.findUnique({ where: { id: r.vendorId }, select }).catch(() => null);
  if (r.listingId) return prisma.vendor.findUnique({ where: { listingId: r.listingId }, select }).catch(() => null);
  return null;
}

adminApiRouter.post(
  '/reviews/:id/publish',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const existing = await prisma.review.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Review not found');
    const r = await prisma.review.update({
      where: { id },
      data: { status: 'PUBLISHED', moderatedBy: req.auth!.sub, moderatedAt: new Date(), moderationReason: null },
    });
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'review.publish', meta: { reviewId: id }, ipAddress: req.ip ?? null },
    });
    // Publishing an already-published review (a double click, a re-moderation)
    // must not mail the business and the reviewer a second time.
    if (existing.status !== 'PUBLISHED') {
      // Only a claimed listing has a business to notify.
      const publishVendor = await reviewVendor(r);
      notifyIf(publishVendor?.email, (to) =>
        reviewPublishedEmail(to, publishVendor!.businessName, { reviewerName: r.reviewerName, rating: r.rating }),
      );
      // The reviewer is told their review is live.
      if (r.parentId) {
        const author = await prisma.petParent
          .findUnique({ where: { id: r.parentId }, select: { email: true, name: true } })
          .catch(() => null);
        notifyIf(author?.email, (to) =>
          reviewThanksEmail(to, author?.name ?? r.reviewerName, r.listingName ?? publishVendor?.businessName ?? 'the business'),
        );
      }
    }
    res.json({ ok: true, id: r.id, status: r.status });
  }),
);

const RejectBody = z.object({ reason: z.string().max(240).optional() });

adminApiRouter.post(
  '/reviews/:id/reject',
  asyncHandler(async (req, res) => {
    const { reason } = RejectBody.parse(req.body ?? {});
    const id = req.params.id ?? '';
    const existing = await prisma.review.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Review not found');
    const r = await prisma.review.update({
      where: { id },
      data: { status: 'REJECTED', moderationReason: reason ?? null, moderatedBy: req.auth!.sub, moderatedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'review.reject', meta: { reviewId: id, reason: reason ?? null }, ipAddress: req.ip ?? null },
    });
    if (existing.status !== 'REJECTED') {
      const rejectVendor = await reviewVendor(r);
      notifyIf(rejectVendor?.email, (to) =>
        reviewRejectedEmail(to, rejectVendor!.businessName, { reviewerName: r.reviewerName, rating: r.rating }, reason ?? null),
      );
    }
    res.json({ ok: true, id: r.id, status: r.status });
  }),
);

// ---------- Reports (rollup) ----------
adminApiRouter.get(
  '/reports',
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const prevSince = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
    const win = { gte: since };
    const prevWin = { gte: prevSince, lt: since };

    const [
      newVendors, newParents, newEnquiries, paid, revenueAgg,
      prevVendors, prevParents, prevEnquiries, prevRevenueAgg,
      respondedEnquiries, totalEnquiries, activeVendors, claimedVendors,
      enquiryRows, parentRows, vendorRows, paymentRows, activityRows, topCityRows,
    ] = await Promise.all([
      prisma.vendor.count({ where: { createdAt: win } }),
      prisma.petParent.count({ where: { createdAt: win } }),
      prisma.enquiry.count({ where: { createdAt: win } }),
      prisma.payment.count({ where: { status: 'SUCCESS', createdAt: win } }),
      prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { status: 'SUCCESS', createdAt: win } }),
      prisma.vendor.count({ where: { createdAt: prevWin } }),
      prisma.petParent.count({ where: { createdAt: prevWin } }),
      prisma.enquiry.count({ where: { createdAt: prevWin } }),
      prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { status: 'SUCCESS', createdAt: prevWin } }),
      prisma.enquiry.count({ where: { createdAt: win, status: { in: ['RESPONDED', 'COMPLETED'] } } }),
      prisma.enquiry.count({ where: { createdAt: win } }),
      prisma.vendor.count({ where: { status: { in: ['ACTIVE', 'CLAIMED'] } } }),
      prisma.vendor.count({ where: { claimedAt: { not: null } } }),
      // Raw rows for the daily series — cheap at this volume, and it keeps the
      // bucketing in one place rather than in six database dialects.
      prisma.enquiry.findMany({ where: { createdAt: win }, select: { createdAt: true } }),
      prisma.petParent.findMany({ where: { createdAt: win }, select: { createdAt: true } }),
      prisma.vendor.findMany({ where: { createdAt: win }, select: { createdAt: true } }),
      prisma.payment.findMany({ where: { status: 'SUCCESS', createdAt: win }, select: { createdAt: true, amountMinor: true } }),
      // Listing views are one row per page view, so 30 days of raw activity
      // grows with traffic and was all loaded into memory here. The totals per
      // kind come back as a grouped count; only the contact taps (a small
      // fraction) are fetched row by row, for the daily series.
      Promise.all([
        prisma.listingActivity.groupBy({ by: ['kind'], where: { createdAt: win }, _count: { _all: true } }),
        prisma.listingActivity.findMany({
          where: { createdAt: win, kind: { in: ['phone_click', 'whatsapp_click'] } },
          select: { createdAt: true },
        }),
      ]).catch(() => [[], []] as const),
      prisma.enquiry.groupBy({ by: ['city'], where: { createdAt: win }, _count: { _all: true } }).catch(() => []),
    ]);

    // 30 day-buckets, oldest first, so the chart has no gaps on quiet days.
    const dayKey = (d: Date) => d.toISOString().slice(0, 10);
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) days.push(dayKey(new Date(now.getTime() - i * 24 * 3600 * 1000)));
    const emptySeries = () => Object.fromEntries(days.map((d) => [d, 0])) as Record<string, number>;

    const enquiriesByDay = emptySeries();
    for (const r of enquiryRows) { const k = dayKey(r.createdAt); if (k in enquiriesByDay) enquiriesByDay[k] = (enquiriesByDay[k] ?? 0) + 1; }
    const signupsByDay = emptySeries();
    for (const r of [...parentRows, ...vendorRows]) { const k = dayKey(r.createdAt); if (k in signupsByDay) signupsByDay[k] = (signupsByDay[k] ?? 0) + 1; }
    const revenueByDay = emptySeries();
    for (const r of paymentRows) { const k = dayKey(r.createdAt); if (k in revenueByDay) revenueByDay[k] = (revenueByDay[k] ?? 0) + Math.round(r.amountMinor / 100); }
    const contactByDay = emptySeries();
    const kinds: Record<string, number> = { phone_click: 0, whatsapp_click: 0, website_click: 0, listing_view: 0 };
    const [kindCounts, contactRows] = activityRows;
    for (const r of kindCounts as ReadonlyArray<{ kind: string; _count: { _all: number } }>) {
      kinds[r.kind] = (kinds[r.kind] ?? 0) + r._count._all;
    }
    for (const r of contactRows as ReadonlyArray<{ createdAt: Date }>) {
      const k = dayKey(r.createdAt);
      if (k in contactByDay) contactByDay[k] = (contactByDay[k] ?? 0) + 1;
    }

    const pct = (nowN: number, prevN: number) =>
      prevN === 0 ? (nowN > 0 ? 100 : 0) : Math.round(((nowN - prevN) / prevN) * 100);

    const revenue = rupees(revenueAgg._sum.amountMinor ?? 0);
    const prevRevenue = rupees(prevRevenueAgg._sum.amountMinor ?? 0);

    res.json({
      ok: true,
      window: '30d',
      report: {
        newVendors,
        newParents,
        newEnquiries,
        paidTransactions: paid,
        revenue,
        // Every headline number carries its own change against the previous 30
        // days, so "139 new" stops being a figure with nothing to compare to.
        change: {
          vendors: pct(newVendors, prevVendors),
          parents: pct(newParents, prevParents),
          enquiries: pct(newEnquiries, prevEnquiries),
          revenue: pct(revenue, prevRevenue),
        },
        enquiryResponseRate: totalEnquiries ? Math.round((respondedEnquiries / totalEnquiries) * 100) : 0,
        vendorClaimRate: activeVendors ? Math.round((claimedVendors / activeVendors) * 100) : 0,
        contactActions: kinds,
      },
      series: {
        days,
        enquiries: days.map((d) => enquiriesByDay[d] ?? 0),
        signups: days.map((d) => signupsByDay[d] ?? 0),
        revenue: days.map((d) => revenueByDay[d] ?? 0),
        contacts: days.map((d) => contactByDay[d] ?? 0),
      },
      topCities: (topCityRows as Array<{ city: string | null; _count: { _all: number } }>)
        .filter((c) => c.city)
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, 8)
        .map((c) => ({ name: c.city as string, count: c._count._all })),
    });
  }),
);

// ---------- Grow Business Plans & Buyers ----------

export const defaultGrowPlans = [
  // --- 1. WhatsApp Enquiries Plans ---
  {
    id: 'grow_plan_wa_10d',
    name: 'WhatsApp Direct Leads · 10 Days',
    type: 'CAMPAIGN',
    goal: 'WHATSAPP_ENQUIRIES',
    durationDays: 10,
    priceRupees: 4999,
    originalPriceRupees: 6999,
    tagline: 'Direct WhatsApp chats from FB & IG ads targeted to local pet owners',
    perks: ['Professional Ad Design', 'Targeted FB & IG Ads', 'Direct WhatsApp Chat Leads', 'Daily Campaign Optimization'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_wa_20d',
    name: 'WhatsApp Direct Leads · 20 Days',
    type: 'CAMPAIGN',
    goal: 'WHATSAPP_ENQUIRIES',
    durationDays: 20,
    priceRupees: 8999,
    originalPriceRupees: 12000,
    tagline: '20 Days high-converting WhatsApp lead generation campaign',
    perks: ['Professional Ad Design', 'Targeted FB & IG Ads', 'Direct WhatsApp Chat Leads', 'Continuous Optimization', 'A/B Creative Testing'],
    recommended: true,
    active: true,
  },
  {
    id: 'grow_plan_wa_30d',
    name: 'WhatsApp Direct Leads · 30 Days',
    type: 'CAMPAIGN',
    goal: 'WHATSAPP_ENQUIRIES',
    durationDays: 30,
    priceRupees: 13999,
    originalPriceRupees: 18999,
    tagline: 'Maximum WhatsApp enquiry volume for 1 full month',
    perks: ['Dedicated Ad Manager', 'High-Converting Copywriting', 'City-wide Micro Targeting', 'Guaranteed Enquiries Growth', 'Weekly Analytics Report'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_wa_90d',
    name: 'WhatsApp Direct Leads · 90 Days (3 Months)',
    type: 'CAMPAIGN',
    goal: 'WHATSAPP_ENQUIRIES',
    durationDays: 90,
    priceRupees: 34999,
    originalPriceRupees: 45000,
    tagline: 'Full quarterly marketing coverage with maximum reach & ROI',
    perks: ['Quarterly Strategy Plan', 'Multi-creative Ad Refresh', 'Priority Support', 'Advanced Demographics Targeting', 'Dedicated Campaign Specialist'],
    recommended: false,
    active: true,
  },

  // --- 2. Website Lead Generation Plans ---
  {
    id: 'grow_plan_web_10d',
    name: 'Website Lead Generation · 10 Days',
    type: 'CAMPAIGN',
    goal: 'WEBSITE_LEADS',
    durationDays: 10,
    priceRupees: 4999,
    originalPriceRupees: 6999,
    tagline: 'Send interested pet owners directly to your website forms',
    perks: ['Landing Page Traffic Ads', 'Form Submission Optimization', 'Targeted FB & IG Ads'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_web_20d',
    name: 'Website Lead Generation · 20 Days',
    type: 'CAMPAIGN',
    goal: 'WEBSITE_LEADS',
    durationDays: 20,
    priceRupees: 8999,
    originalPriceRupees: 12000,
    tagline: '20 Days website conversion & booking lead generation',
    perks: ['Landing Page Traffic Ads', 'Form Submission Optimization', 'A/B Creative Testing', 'Retargeting Setup'],
    recommended: true,
    active: true,
  },
  {
    id: 'grow_plan_web_30d',
    name: 'Website Lead Generation · 30 Days',
    type: 'CAMPAIGN',
    goal: 'WEBSITE_LEADS',
    durationDays: 30,
    priceRupees: 13999,
    originalPriceRupees: 18999,
    tagline: 'High-intent pet owners sent to your website booking page',
    perks: ['Landing Page Traffic Ads', 'Form Submission Optimization', 'Retargeting Pixel Setup', 'Conversion Tracking'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_web_90d',
    name: 'Website Lead Generation · 90 Days (3 Months)',
    type: 'CAMPAIGN',
    goal: 'WEBSITE_LEADS',
    durationDays: 90,
    priceRupees: 34999,
    originalPriceRupees: 45000,
    tagline: 'Full quarterly website leads campaign for high volume bookings',
    perks: ['Quarterly Strategy Plan', 'Multi-creative Ad Refresh', 'Conversion Funnel Optimization', 'Dedicated Specialist'],
    recommended: false,
    active: true,
  },

  // --- 3. Profile Visits Plans ---
  {
    id: 'grow_plan_prof_10d',
    name: 'Profile Visibility Boost · 10 Days',
    type: 'CAMPAIGN',
    goal: 'PROFILE_VISITS',
    durationDays: 10,
    priceRupees: 4999,
    originalPriceRupees: 6999,
    tagline: 'Drive interested local pet owners to your directory listing',
    perks: ['Profile Impressions Boost', 'Local City Targeting', 'Brand Awareness Campaign'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_prof_20d',
    name: 'Profile Visibility Boost · 20 Days',
    type: 'CAMPAIGN',
    goal: 'PROFILE_VISITS',
    durationDays: 20,
    priceRupees: 8999,
    originalPriceRupees: 12000,
    tagline: '20 Days brand awareness and listing profile traffic boost',
    perks: ['Profile Impressions Boost', 'Increased Directory Search Rank', 'Social Media Retargeting'],
    recommended: true,
    active: true,
  },
  {
    id: 'grow_plan_prof_30d',
    name: 'Profile Visibility Boost · 30 Days',
    type: 'CAMPAIGN',
    goal: 'PROFILE_VISITS',
    durationDays: 30,
    priceRupees: 13999,
    originalPriceRupees: 18999,
    tagline: 'Drive maximum pet owners to your Pets24x7 listing profile',
    perks: ['Profile Impressions Boost', 'Increased Directory Search Rank', 'Social Media Retargeting', 'Brand Awareness Campaign'],
    recommended: false,
    active: true,
  },
  {
    id: 'grow_plan_prof_90d',
    name: 'Profile Visibility Boost · 90 Days (3 Months)',
    type: 'CAMPAIGN',
    goal: 'PROFILE_VISITS',
    durationDays: 90,
    priceRupees: 34999,
    originalPriceRupees: 45000,
    tagline: 'Establish dominant city-wide presence and maximum profile visits',
    perks: ['Quarterly Visibility Push', 'Top Directory Banner Rotation', 'Priority Search Ranking'],
    recommended: false,
    active: true,
  },

  // --- 4. Featured Placements ---
  {
    id: 'grow_plan_featured_30d',
    name: 'Featured Top Placement · 30 Days',
    type: 'FEATURED',
    goal: 'FEATURED_TOP_SLOT',
    durationDays: 30,
    priceRupees: 2499,
    originalPriceRupees: 3999,
    tagline: 'Pinned to the top of your city & category page',
    perks: ['Pinned Top Slot on Directory', 'Golden ⭐ Featured Badge', '3x Higher View Rate', 'Instant Search Visibility'],
    recommended: true,
    active: true,
  },
  {
    id: 'grow_plan_featured_90d',
    name: 'Featured Top Placement · 90 Days',
    type: 'FEATURED',
    goal: 'FEATURED_TOP_SLOT',
    durationDays: 90,
    priceRupees: 5999,
    originalPriceRupees: 8999,
    tagline: '3 Months top placement with 25% long-term discount',
    perks: ['90-Day Pinned Top Slot', 'Golden ⭐ Featured Badge', 'Maximized Local Visibility', 'Priority Search Indexing'],
    recommended: false,
    active: true,
  },

  // --- 5. Custom Enterprise Campaign ---
  {
    id: 'grow_plan_custom',
    name: 'Custom Enterprise Campaign',
    type: 'CAMPAIGN',
    goal: 'CUSTOM_CAMPAIGN',
    durationDays: 30,
    priceRupees: 20000,
    originalPriceRupees: 25000,
    tagline: 'For multi-location or custom marketing requirements',
    perks: ['Custom Targeting & Locations', 'Multi-Channel Ad Spend', 'Dedicated Account Director', 'Custom Landing Page Design'],
    recommended: false,
    active: true,
  },
];

export let memoryGrowPlans: Array<Record<string, any>> = [...defaultGrowPlans];

// ---------- Plan catalogues: persisted, not only in memory ----------
// Admin edits to the Grow Business plans, the vendor subscription tiers and the
// parent-plan fallback used to live only in process memory. A restart or a
// redeploy silently put every price back to the defaults, while checkout
// (payments/pricing.ts, vendor subscriptions) charged whatever the array held.
// They are now saved in the settings table and read back on boot. The arrays
// are mutated in place, so every module that imported them sees saved values.
const PLAN_STORE_KEYS = {
  grow: 'plans:grow',
  vendor: 'plans:vendor_subscriptions',
  parent: 'plans:parent_subscriptions',
  parentRecommended: 'plans:parent_recommended',
} as const;

/** Setting keys owned by the server. The generic settings editor must not write them. */
export const RESERVED_SETTING_PREFIXES = ['plans:', 'admin_email_set:', 'vendor_pay:'];

/** Plan ids flagged "recommended" for DB membership plans (the table has no column for it). */
let parentRecommendedIds: string[] = [];

function replaceContents<T>(target: T[], next: T[]): void {
  target.splice(0, target.length, ...next);
}

let planStoresLoad: Promise<void> | null = null;
let planStoresFailedAt = 0;
let planStoresLoadedAt = 0;
/** Bumped by every save, so a load that raced a save cannot put the old catalogue back. */
let planStoresGeneration = 0;

// The catalogues live in process memory, and with several API instances an
// admin's price change lands on only one of them. Every instance therefore
// re-reads the saved rows this often (one indexed Setting query), so the rest
// of the cluster charges the new price within a minute. One server is
// unaffected apart from that query.
const PLAN_STORES_REFRESH_MS = 60_000;

/**
 * Loads saved plan catalogues into the in-memory arrays. Safe to call often:
 * it queries at most once a PLAN_STORES_REFRESH_MS, and retries at most every
 * 30s after a failure (a DB blip at boot must not leave checkout on default
 * prices for the life of the process).
 */
export function loadPersistedPlanStores(): Promise<void> {
  const stale = planStoresLoadedAt > 0 && Date.now() - planStoresLoadedAt > PLAN_STORES_REFRESH_MS;
  if ((!planStoresLoad || stale) && Date.now() - planStoresFailedAt > 30_000) {
    const generation = planStoresGeneration;
    // Marked fresh up front, so concurrent callers share this one query.
    planStoresLoadedAt = Date.now();
    planStoresLoad = (async () => {
      const rows = await prisma.setting.findMany({ where: { key: { in: Object.values(PLAN_STORE_KEYS) } } });
      // A save on this instance while the query was out already holds newer data.
      if (generation !== planStoresGeneration) return;
      for (const r of rows) {
        const arr = Array.isArray(r.value) ? (r.value as any[]) : null;
        if (!arr) continue;
        if (r.key === PLAN_STORE_KEYS.parentRecommended) {
          parentRecommendedIds = arr.filter((x): x is string => typeof x === 'string');
          continue;
        }
        if (!arr.length) continue;
        if (r.key === PLAN_STORE_KEYS.grow) replaceContents(memoryGrowPlans, arr);
        else if (r.key === PLAN_STORE_KEYS.vendor) replaceContents(memoryVendorSubPlans as any[], arr);
        else if (r.key === PLAN_STORE_KEYS.parent) replaceContents(memoryParentSubPlans as any[], arr);
      }
    })().catch((err) => {
      logger.warn({ err }, 'admin: could not load saved plan catalogues; using defaults for now');
      planStoresLoad = null;
      planStoresLoadedAt = 0;
      planStoresFailedAt = Date.now();
    });
  }
  return planStoresLoad ?? Promise.resolve();
}

async function persistPlanStore(key: string, value: unknown[], actorId: string): Promise<void> {
  // Before and after: a load whose query overlaps the write in either
  // direction is discarded (the caller updates memory itself right after).
  planStoresGeneration++;
  await prisma.setting.upsert({
    where: { key },
    update: { value: value as any, updatedBy: actorId },
    create: { key, value: value as any, updatedBy: actorId },
  });
  planStoresGeneration++;
}

// Every admin request waits for the saved catalogues, so an edit is always
// applied on top of what is stored — never on top of the defaults.
adminApiRouter.use((_req, _res, next) => {
  loadPersistedPlanStores().then(() => next(), () => next());
});

export function getActiveGrowPlans() {
  // First caller on a fresh process kicks off the load; the in-memory array is
  // updated in place as soon as it lands.
  void loadPersistedPlanStores();
  return memoryGrowPlans.filter((p) => p.active);
}

/** "a\nb" or ["a","b"] → clean string[]; undefined when the field was not sent. */
function normalizePerks(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
  return list.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
}

const PerksField = z.union([z.array(z.string().max(200)).max(40), z.string().max(8000)]).optional();

const GrowPlanBody = z.object({
  id: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/, 'Plan id may only use letters, digits, _ and -').optional(),
  name: z.string().trim().min(2).max(120),
  type: z.enum(['CAMPAIGN', 'FEATURED']).optional(),
  goal: z.enum(['WHATSAPP_ENQUIRIES', 'WEBSITE_LEADS', 'PROFILE_VISITS', 'FEATURED_TOP_SLOT', 'CUSTOM_CAMPAIGN']),
  tier: z.string().max(40).nullable().optional(),
  durationDays: z.coerce.number().int().min(1).max(365),
  // Checkout multiplies this by 100 and charges it, so it must be a real,
  // non-negative number — NaN from a blank field used to go straight through.
  priceRupees: z.coerce.number().min(0).max(10_000_000),
  originalPriceRupees: z.coerce.number().min(0).max(10_000_000).nullable().optional(),
  tagline: z.string().max(240).optional(),
  perks: PerksField,
  recommended: z.boolean().optional(),
  active: z.boolean().optional(),
});
type GrowPlanInput = Partial<z.infer<typeof GrowPlanBody>>;

/** Normalises a validated body into the stored plan shape. */
function toGrowPlan(b: GrowPlanInput, base: Record<string, any>): Record<string, any> {
  const goal = b.goal ?? base.goal;
  return {
    ...base,
    ...(b.name !== undefined ? { name: b.name } : {}),
    goal,
    // Type follows the goal: a featured slot is sold through the featured
    // checkout, everything else through the campaign one.
    type: goal === 'FEATURED_TOP_SLOT' ? 'FEATURED' : 'CAMPAIGN',
    ...(b.tier !== undefined ? { tier: b.tier } : {}),
    ...(b.durationDays !== undefined ? { durationDays: b.durationDays } : {}),
    ...(b.priceRupees !== undefined ? { priceRupees: Math.round(b.priceRupees) } : {}),
    ...(b.originalPriceRupees !== undefined
      ? { originalPriceRupees: b.originalPriceRupees == null ? null : Math.round(b.originalPriceRupees) }
      : {}),
    ...(b.tagline !== undefined ? { tagline: b.tagline } : {}),
    ...(b.perks !== undefined ? { perks: normalizePerks(b.perks) } : {}),
    ...(b.recommended !== undefined ? { recommended: b.recommended } : {}),
    ...(b.active !== undefined ? { active: b.active } : {}),
  };
}

// GET /api/admin/grow-plans
adminApiRouter.get(
  '/grow-plans',
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      plans: memoryGrowPlans,
    });
  }),
);

// POST /api/admin/grow-plans — create (or replace, when an existing id is sent)
adminApiRouter.post(
  '/grow-plans',
  asyncHandler(async (req, res) => {
    const body = GrowPlanBody.parse(req.body ?? {});
    const id = body.id || `grow_plan_${Date.now()}`;
    const idx = memoryGrowPlans.findIndex((p) => p.id === id);

    const planData = toGrowPlan(body, {
      id,
      tier: null,
      originalPriceRupees: null,
      tagline: '',
      perks: [],
      recommended: false,
      active: true,
    });

    const next = [...memoryGrowPlans];
    if (idx >= 0) next[idx] = planData;
    else next.push(planData);
    await persistPlanStore(PLAN_STORE_KEYS.grow, next, req.auth!.sub);
    replaceContents(memoryGrowPlans, next);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: idx >= 0 ? 'grow_plan.replace' : 'grow_plan.create', meta: { planId: id, priceRupees: planData.priceRupees }, ipAddress: req.ip ?? null },
    }).catch(() => {});

    res.json({ ok: true, plan: planData });
  }),
);

// PUT /api/admin/grow-plans/:id — partial update (the quick toggles send one field)
adminApiRouter.put(
  '/grow-plans/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const idx = memoryGrowPlans.findIndex((p) => p.id === id);
    const existing = memoryGrowPlans[idx];
    if (idx < 0 || !existing) throw new NotFoundError('Plan not found');
    // The id is the key checkout and history refer to; it is not editable.
    const { id: _ignored, ...body } = GrowPlanBody.partial().parse(req.body ?? {});

    const updatedPlan = toGrowPlan(body, existing);
    const next = [...memoryGrowPlans];
    next[idx] = updatedPlan;
    await persistPlanStore(PLAN_STORE_KEYS.grow, next, req.auth!.sub);
    replaceContents(memoryGrowPlans, next);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'grow_plan.update', meta: { planId: id, changed: Object.keys(body) }, ipAddress: req.ip ?? null },
    }).catch(() => {});

    res.json({ ok: true, plan: updatedPlan });
  }),
);

const CAMPAIGN_GOAL_NAMES: Record<string, string> = {
  WHATSAPP_ENQUIRIES: 'WhatsApp Direct Leads',
  WEBSITE_LEADS: 'Website Lead Ads',
  PROFILE_VISITS: 'Profile Visits Boost',
};

/**
 * What a Grow Business purchase row really is, from its payment and run status.
 *
 * The buyers table used to list every checkout attempt — including ones whose
 * payment FAILED and were then CANCELLED — under "Amount Paid", while the KPIs
 * (correctly) counted only cleared money. So a vendor with two failed checkouts
 * ("Omkar vet") showed two ₹ purchases above "₹0 revenue · 0 buyers".
 *
 *   PAID           payment SUCCESS                        -> revenue
 *   REFUNDED       payment REFUNDED                        -> listed, no revenue
 *   COMPLIMENTARY  no successful payment, but an admin moved it past checkout
 *                  (PENDING_REVIEW / ACTIVE / COMPLETED / EXPIRED)  -> listed, no revenue
 *   UNPAID         checkout never completed (PENDING_PAYMENT, or CANCELLED
 *                  without a successful payment)          -> hidden unless ?include=all
 */
type PurchaseKind = 'PAID' | 'REFUNDED' | 'COMPLIMENTARY' | 'UNPAID';
function purchaseKind(status: string, paymentStatus: string | null | undefined): PurchaseKind {
  if (paymentStatus === 'SUCCESS') return 'PAID';
  if (paymentStatus === 'REFUNDED') return 'REFUNDED';
  if (status === 'PENDING_PAYMENT' || status === 'CANCELLED') return 'UNPAID';
  return 'COMPLIMENTARY';
}
const PURCHASE_LABEL: Record<PurchaseKind, string> = {
  PAID: 'Paid',
  REFUNDED: 'Refunded',
  COMPLIMENTARY: 'Complimentary (no payment)',
  UNPAID: 'Checkout not completed',
};
const RUN_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PENDING_REVIEW: 'Paid · awaiting review',
  ACTIVE: 'Live',
  COMPLETED: 'Completed',
  EXPIRED: 'Ended',
  CANCELLED: 'Cancelled',
};

// GET /api/admin/grow-buyers            paid, refunded and complimentary purchases
// GET /api/admin/grow-buyers?include=all  ... plus checkouts that were never paid
adminApiRouter.get(
  '/grow-buyers',
  asyncHandler(async (req, res) => {
    const includeUnpaid = String(req.query.include ?? '').toLowerCase() === 'all';
    const vendorSelect = {
      businessName: true, ownerName: true, phone: true, email: true,
      city: true, category: true, whatsapp: true, website: true,
    } as const;
    const [campaigns, featured] = await Promise.all([
      prisma.marketingCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, vendorId: true, goal: true, priceMinor: true, durationDays: true,
          notes: true, status: true, createdAt: true, startsAt: true, endsAt: true,
          vendor: { select: vendorSelect },
          payment: { select: { status: true } },
        },
        take: 200,
      }),
      prisma.featuredListing.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, vendorId: true, city: true, category: true, priceMinor: true, durationDays: true,
          status: true, createdAt: true, startsAt: true, endsAt: true,
          vendor: { select: vendorSelect },
          payment: { select: { status: true } },
        },
        take: 200,
      }),
    ]);

    const buyers: any[] = [];
    // amountPaidRupees is money that cleared (0 otherwise); priceRupees is the
    // plan's price whatever happened to the payment.
    const moneyFields = (status: string, paymentStatus: string | null | undefined, priceMinor: number) => {
      const kind = purchaseKind(status, paymentStatus);
      return {
        purchaseKind: kind,
        purchaseLabel: PURCHASE_LABEL[kind],
        paid: kind === 'PAID',
        priceRupees: Math.round(priceMinor / 100),
        amountPaidRupees: kind === 'PAID' ? Math.round(priceMinor / 100) : 0,
        paymentStatus: paymentStatus ?? null,
        statusLabel: RUN_STATUS_LABEL[status] ?? status,
      };
    };

    // Only what the record actually holds. The old version filled gaps with
    // "Mumbai", "Veterinary Clinic", pets24x7.com and invented campaign notes,
    // so an admin briefing an ad agency could be handed made-up targets.
    for (const c of campaigns) {
      buyers.push({
        id: c.id,
        purchaseId: c.id,
        vendorId: c.vendorId,
        businessName: c.vendor?.businessName || '—',
        ownerName: c.vendor?.ownerName || c.vendor?.phone || '—',
        phone: c.vendor?.phone || '—',
        email: c.vendor?.email || '—',
        city: c.vendor?.city || '—',
        category: c.vendor?.category || '—',
        planName: `${CAMPAIGN_GOAL_NAMES[c.goal] ?? String(c.goal)} · ${c.durationDays} Days`,
        goal: c.goal,
        type: 'CAMPAIGN',
        ...moneyFields(c.status, c.payment?.status, c.priceMinor),
        durationDays: c.durationDays,
        filledTargetDetails: {
          whatsappNumber: c.vendor?.whatsapp || c.vendor?.phone || null,
          websiteUrl: c.vendor?.website || null,
          notes: c.notes || null,
        },
        status: c.status,
        purchasedAt: c.createdAt,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
      });
    }

    for (const f of featured) {
      buyers.push({
        id: f.id,
        purchaseId: f.id,
        vendorId: f.vendorId,
        businessName: f.vendor?.businessName || '—',
        ownerName: f.vendor?.ownerName || f.vendor?.phone || '—',
        phone: f.vendor?.phone || '—',
        email: f.vendor?.email || '—',
        city: f.city || f.vendor?.city || '—',
        category: f.category || f.vendor?.category || '—',
        planName: `Featured Top Placement · ${f.durationDays} Days`,
        goal: 'FEATURED_TOP_SLOT',
        type: 'FEATURED',
        ...moneyFields(f.status, f.payment?.status, f.priceMinor),
        durationDays: f.durationDays,
        filledTargetDetails: {
          whatsappNumber: f.vendor?.whatsapp || f.vendor?.phone || null,
          websiteUrl: f.vendor?.website || null,
          notes: f.city ? `Top slot pinned in ${f.city} (${f.category || 'all categories'})` : null,
        },
        status: f.status,
        purchasedAt: f.createdAt,
        startsAt: f.startsAt,
        endsAt: f.endsAt,
      });
    }

    buyers.sort((a, b) => new Date(b.purchasedAt).getTime() - new Date(a.purchasedAt).getTime());

    // Every figure below is computed from the same rows the table shows (never
    // the unpaid attempts), so the KPIs and the list always agree.
    const purchases = buyers.filter((b) => b.purchaseKind !== 'UNPAID');
    const unpaid = buyers.filter((b) => b.purchaseKind === 'UNPAID');
    // Revenue is money that actually cleared: a comped or refunded purchase
    // is not revenue, whatever its run status says.
    const totalRevenue = purchases.reduce((sum, b) => sum + (b.amountPaidRupees || 0), 0);
    const distinctVendors = (rows: any[]) => new Set(rows.map((b) => b.vendorId)).size;
    const active = purchases.filter((b) => b.status === 'ACTIVE');

    res.json({
      ok: true,
      buyers: includeUnpaid ? buyers : purchases,
      includesUnpaid: includeUnpaid,
      stats: {
        totalRevenue,
        // Distinct businesses, not rows: one vendor with two live plans is one buyer.
        activeBuyers: distinctVendors(active),
        activePurchases: active.length,
        pendingReview: purchases.filter((b) => b.status === 'PENDING_REVIEW').length,
        completedBuyers: purchases.filter((b) => b.status === 'COMPLETED' || b.status === 'EXPIRED').length,
        totalPurchases: purchases.length,
        paidPurchases: purchases.filter((b) => b.purchaseKind === 'PAID').length,
        payingBuyers: distinctVendors(purchases.filter((b) => b.purchaseKind === 'PAID')),
        complimentaryPurchases: purchases.filter((b) => b.purchaseKind === 'COMPLIMENTARY').length,
        refundedPurchases: purchases.filter((b) => b.purchaseKind === 'REFUNDED').length,
        // Checkouts started but never paid; listed only with ?include=all.
        unpaidAttempts: unpaid.length,
      },
    });
  }),
);

// POST /api/admin/grow-buyers/:id/status
// The id is either a campaign or a featured slot. Each goes through the same
// code path as its own tab, so run windows, audit rows and vendor emails are
// identical. The old version blindly wrote the raw status to both tables,
// swallowed every error (an invalid enum, an unknown id) and answered ok.
const GrowBuyerStatusBody = z.object({ status: z.enum(['PENDING_REVIEW', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED']) });

adminApiRouter.post(
  '/grow-buyers/:id/status',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const { status } = GrowBuyerStatusBody.parse(req.body ?? {});

    const campaign = await prisma.marketingCampaign.findUnique({ where: { id }, select: { id: true } });
    if (campaign) {
      const c = await applyCampaignStatus(
        { sub: req.auth!.sub, ip: req.ip ?? null },
        id,
        status === 'EXPIRED' ? 'COMPLETED' : status,
      );
      if (!c) throw new NotFoundError('Purchase not found');
      res.json({ ok: true, id, type: 'CAMPAIGN', status: c.status });
      return;
    }

    const featured = await prisma.featuredListing.findUnique({ where: { id }, select: { id: true } });
    if (featured) {
      if (status === 'PENDING_REVIEW') throw new BadRequestError('A featured placement has no review step.');
      const f = await applyFeaturedStatus(req, id, status === 'COMPLETED' ? 'EXPIRED' : status);
      if (!f) throw new NotFoundError('Purchase not found');
      res.json({ ok: true, id, type: 'FEATURED', status: f.status });
      return;
    }

    throw new NotFoundError('Purchase not found');
  }),
);

// ---------- Pet Parent & Vendor Subscriptions Management ----------

export const defaultParentSubPlans = [
  {
    id: 'sub_parent_bronze_monthly',
    sku: 'bronze_monthly',
    tier: 'BRONZE',
    billingPeriod: 'MONTHLY',
    name: 'Bronze PetCare Pass · Monthly',
    tagline: 'Member deals + priority WhatsApp support',
    perks: ['Up to 10% off at 500+ verified vendors', 'Priority WhatsApp support within 1 hour', 'Save up to 5 pet profiles'],
    discountPercent: 10,
    priceRupees: 99,
    durationDays: 30,
    active: true,
  },
  {
    id: 'sub_parent_bronze_annual',
    sku: 'bronze_annual',
    tier: 'BRONZE',
    billingPeriod: 'ANNUAL',
    name: 'Bronze PetCare Pass · Annual',
    tagline: '2 months free vs monthly',
    perks: ['Everything in Bronze Monthly', '₹198 saved vs monthly', 'First-look on new partner deals'],
    discountPercent: 10,
    priceRupees: 990,
    durationDays: 365,
    active: true,
  },
  {
    id: 'sub_parent_silver_monthly',
    sku: 'silver_monthly',
    tier: 'SILVER',
    billingPeriod: 'MONTHLY',
    name: 'Silver PetCare Pass · Monthly',
    tagline: '1 free vet consult + 20% off treatments',
    perks: ['Everything in Bronze', 'Up to 20% off vet treatments', '1 free virtual vet consult/mo', 'Vaccination reminders'],
    discountPercent: 20,
    priceRupees: 249,
    durationDays: 30,
    active: true,
  },
  {
    id: 'sub_parent_silver_annual',
    sku: 'silver_annual',
    tier: 'SILVER',
    billingPeriod: 'ANNUAL',
    name: 'Silver PetCare Pass · Annual',
    tagline: 'Most popular · 2 months free + swag pack',
    perks: ['Everything in Silver Monthly', '12 free virtual vet consults/yr', 'Free Pets24x7 swag pack'],
    discountPercent: 20,
    priceRupees: 2490,
    durationDays: 365,
    recommended: true,
    active: true,
  },
  {
    id: 'sub_parent_gold_monthly',
    sku: 'gold_monthly',
    tier: 'GOLD',
    billingPeriod: 'MONTHLY',
    name: 'Gold PetCare Pass · Monthly',
    tagline: '24x7 Emergency helpline + unlimited vet consults',
    perks: ['Everything in Silver', '30% off vet treatments', 'Unlimited virtual vet consults', '24x7 emergency vet helpline'],
    discountPercent: 30,
    priceRupees: 499,
    durationDays: 30,
    active: true,
  },
  {
    id: 'sub_parent_gold_annual',
    sku: 'gold_annual',
    tier: 'GOLD',
    billingPeriod: 'ANNUAL',
    name: 'Gold PetCare Pass · Annual',
    tagline: 'Premium value · 12 free pet taxi rides',
    perks: ['Everything in Gold Monthly', '12 free pet taxi rides/yr', 'Dedicated WhatsApp advisor', 'Free annual vet checkup'],
    discountPercent: 30,
    priceRupees: 4990,
    durationDays: 365,
    recommended: true,
    active: true,
  },
];

export let memoryParentSubPlans: Array<Record<string, any>> = [...defaultParentSubPlans];

export const defaultVendorSubPlans = [
  {
    id: 'sub_vendor_basic',
    sku: 'vendor_basic',
    tier: 'BASIC',
    billingPeriod: 'MONTHLY',
    name: 'Vendor Basic Free',
    tagline: 'Verified Directory Listing & Direct Calls',
    perks: ['Verified Business Listing', 'UNLIMITED Customer Enquiries & Leads', 'Basic Listing Page Search', 'Community Support'],
    leadLimit: 9999,
    badge: 'COMMUNITY_SEAL',
    priceRupees: 0,
    durationDays: 30,
    active: true,
  },
  {
    id: 'sub_vendor_silver',
    sku: 'vendor_silver_monthly',
    tier: 'SILVER',
    billingPeriod: 'MONTHLY',
    name: 'Vendor Silver Pro · Monthly',
    tagline: 'Verified Pro Badge + Unlimited Leads',
    perks: ['Verified Pet Business Badge', 'UNLIMITED Customer Enquiries & Leads', 'WhatsApp Lead Routing', 'Direct Call Button', 'Priority Search Ranking'],
    leadLimit: 9999,
    badge: 'VERIFIED_PRO',
    priceRupees: 1499,
    durationDays: 30,
    active: true,
  },
  {
    id: 'sub_vendor_gold',
    sku: 'vendor_gold_monthly',
    tier: 'GOLD',
    billingPeriod: 'MONTHLY',
    name: 'Vendor Gold Platinum · Monthly',
    tagline: 'Unlimited Leads + Featured Category Spot',
    perks: ['Premium Verified Badge', 'UNLIMITED Customer Enquiries', 'Top Search Result Boost', '1 Free Featured Category Slot', 'Social Media Business Feature'],
    leadLimit: 9999,
    badge: 'PREMIUM_GOLD',
    priceRupees: 2999,
    durationDays: 30,
    recommended: true,
    active: true,
  },
  {
    id: 'sub_vendor_diamond',
    sku: 'vendor_diamond_annual',
    tier: 'DIAMOND',
    billingPeriod: 'ANNUAL',
    name: 'Vendor Diamond Enterprise · Annual',
    tagline: 'Maximum Reach + Dedicated Account Manager',
    perks: ['Top-Tier Diamond Verified Badge', 'UNLIMITED Enquiries & Leads', '3 Free City-Wide Featured Slots', 'Dedicated Growth Manager', 'Custom Banner Placement'],
    leadLimit: 9999,
    badge: 'DIAMOND_ELITE',
    priceRupees: 24999,
    durationDays: 365,
    recommended: true,
    active: true,
  },
];

export let memoryVendorSubPlans: Array<Record<string, any>> = [...defaultVendorSubPlans];

// ---------- Pet parent plans ----------
// Membership checkout reads the membership_plans table and nothing else, so an
// edit made here must land in that table. The previous version only changed an
// in-memory copy: GET showed the DB rows, PUT looked for the id in memory,
// found nothing, and answered ok — every toggle and price change was a no-op.
const ParentPlanBody = z.object({
  id: z.string().max(80).optional(),
  // A blank SKU field means "generate one".
  sku: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(2).max(60).regex(/^[a-z0-9_-]+$/i, 'SKU may only use letters, digits, _ and -').optional(),
  ),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD']).optional(),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().max(160).optional(),
  perks: PerksField,
  discountPercent: z.coerce.number().int().min(0).max(90).optional(),
  priceRupees: z.coerce.number().min(0).max(10_000_000).optional(),
  currency: z.string().length(3).optional(),
  durationDays: z.coerce.number().int().min(1).max(3660).optional(),
  recommended: z.boolean().optional(),
  active: z.boolean().optional(),
});
type ParentPlanInput = z.infer<typeof ParentPlanBody>;

function parentPlanDbData(b: ParentPlanInput) {
  const data: Record<string, unknown> = {};
  if (b.sku !== undefined) data.sku = b.sku;
  if (b.tier !== undefined) data.tier = b.tier;
  if (b.billingPeriod !== undefined) data.billingPeriod = b.billingPeriod;
  if (b.name !== undefined) data.name = b.name;
  if (b.tagline !== undefined) data.tagline = b.tagline || null;
  if (b.perks !== undefined) data.perks = normalizePerks(b.perks) ?? [];
  if (b.discountPercent !== undefined) data.discountPercent = b.discountPercent;
  if (b.priceRupees !== undefined) data.priceMinor = Math.round(b.priceRupees * 100);
  if (b.currency !== undefined) data.currency = b.currency.toUpperCase();
  if (b.durationDays !== undefined) data.durationDays = b.durationDays;
  if (b.active !== undefined) data.active = b.active;
  return data;
}

function parentPlanOut(p: {
  id: string; sku: string; tier: string; billingPeriod: string; name: string; tagline: string | null;
  perks: unknown; discountPercent: number; priceMinor: number; currency: string; durationDays: number; active: boolean;
}) {
  return {
    id: p.id,
    sku: p.sku,
    tier: p.tier,
    billingPeriod: p.billingPeriod,
    name: p.name,
    tagline: p.tagline || '',
    perks: Array.isArray(p.perks) ? p.perks : [],
    discountPercent: p.discountPercent || 0,
    priceRupees: rupees(p.priceMinor),
    currency: p.currency,
    durationDays: p.durationDays,
    recommended: parentRecommendedIds.includes(p.id),
    active: p.active,
  };
}

async function setParentRecommended(id: string, on: boolean, actorId: string) {
  const next = on
    ? Array.from(new Set([...parentRecommendedIds, id]))
    : parentRecommendedIds.filter((x) => x !== id);
  await persistPlanStore(PLAN_STORE_KEYS.parentRecommended, next, actorId);
  parentRecommendedIds = next;
}

// GET /api/admin/subscriptions/parent-plans
adminApiRouter.get(
  '/subscriptions/parent-plans',
  asyncHandler(async (_req, res) => {
    const dbPlans = await prisma.membershipPlan
      .findMany({ orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }] })
      .catch(() => []);
    if (dbPlans.length > 0) {
      res.json({ ok: true, plans: dbPlans.map(parentPlanOut), source: 'db' });
      return;
    }
    // Nothing seeded yet: show the starter catalogue. Editing one of these
    // creates it for real (see PUT), since only DB plans can be bought.
    res.json({ ok: true, plans: memoryParentSubPlans, source: 'defaults' });
  }),
);

// POST /api/admin/subscriptions/parent-plans — creates a purchasable plan
adminApiRouter.post(
  '/subscriptions/parent-plans',
  asyncHandler(async (req, res) => {
    const b = ParentPlanBody.parse(req.body ?? {});
    if (!b.name) throw new BadRequestError('Plan name is required');
    if (b.priceRupees === undefined) throw new BadRequestError('Price is required');
    const billingPeriod = b.billingPeriod ?? 'MONTHLY';
    const sku = b.sku || `${(b.tier ?? 'silver').toLowerCase()}_${billingPeriod.toLowerCase()}_${Date.now().toString(36)}`;
    const taken = await prisma.membershipPlan.findUnique({ where: { sku } });
    if (taken) throw new BadRequestError(`A plan with SKU "${sku}" already exists`);

    const plan = await prisma.membershipPlan.create({
      data: {
        sku,
        tier: b.tier ?? 'SILVER',
        billingPeriod,
        name: b.name,
        tagline: b.tagline || null,
        perks: normalizePerks(b.perks) ?? [],
        discountPercent: b.discountPercent ?? 0,
        priceMinor: Math.round(b.priceRupees * 100),
        currency: (b.currency ?? 'INR').toUpperCase(),
        durationDays: b.durationDays ?? (billingPeriod === 'ANNUAL' ? 365 : 30),
        active: b.active ?? true,
      },
    });
    if (b.recommended) await setParentRecommended(plan.id, true, req.auth!.sub);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'plan.create', meta: { planId: plan.id, sku: plan.sku }, ipAddress: req.ip ?? null },
    }).catch(() => {});
    res.json({ ok: true, plan: parentPlanOut(plan) });
  }),
);

// PUT /api/admin/subscriptions/parent-plans/:id
adminApiRouter.put(
  '/subscriptions/parent-plans/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const { id: _ignored, ...b } = ParentPlanBody.parse(req.body ?? {});

    let existing = await prisma.membershipPlan.findUnique({ where: { id } });
    if (!existing) {
      // One of the starter plans shown before anything was seeded: create it
      // (matched on SKU) so the edit takes effect at checkout.
      const starter = memoryParentSubPlans.find((p) => p.id === id);
      if (!starter) throw new NotFoundError('Plan not found');
      const bySku = await prisma.membershipPlan.findUnique({ where: { sku: starter.sku } });
      existing = bySku ?? await prisma.membershipPlan.create({
        data: {
          sku: starter.sku,
          tier: starter.tier as any,
          billingPeriod: starter.billingPeriod as any,
          name: starter.name,
          tagline: starter.tagline || null,
          perks: starter.perks ?? [],
          discountPercent: starter.discountPercent ?? 0,
          priceMinor: Math.round(Number(starter.priceRupees || 0) * 100),
          durationDays: starter.durationDays,
          active: starter.active !== false,
        },
      });
      if ((starter as any).recommended && b.recommended === undefined) {
        await setParentRecommended(existing.id, true, req.auth!.sub);
      }
    }

    const data = parentPlanDbData(b);
    // The SKU is written into every payment record for this plan, so it is
    // fixed once created (the edit form resends it unchanged).
    delete data.sku;
    const plan = Object.keys(data).length
      ? await prisma.membershipPlan.update({ where: { id: existing.id }, data })
      : existing;
    if (b.recommended !== undefined) await setParentRecommended(plan.id, b.recommended, req.auth!.sub);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'plan.update', meta: { planId: plan.id, changed: Object.keys(b) }, ipAddress: req.ip ?? null },
    }).catch(() => {});
    res.json({ ok: true, plan: parentPlanOut(plan) });
  }),
);

// GET /api/admin/subscriptions/parent-subscribers
adminApiRouter.get(
  '/subscriptions/parent-subscribers',
  asyncHandler(async (_req, res) => {
    // Paid statuses: PENDING is an abandoned checkout and REFUNDED gave the
    // money back, so neither is a subscriber or revenue.
    const PAID: Array<'ACTIVE' | 'EXPIRED' | 'CANCELLED'> = ['ACTIVE', 'EXPIRED', 'CANCELLED'];
    const [dbMemberships, totalSubscribers, activeSubscribers, revenueAgg, popularRaw] = await Promise.all([
      prisma.membership.findMany({
        take: 200,
        orderBy: { createdAt: 'desc' },
        include: { parent: true, plan: true },
      }),
      prisma.membership.count({ where: { status: { in: PAID } } }),
      prisma.membership.count({ where: { status: 'ACTIVE' } }),
      prisma.membership.aggregate({ _sum: { pricePaidMinor: true }, where: { status: { in: PAID } } }),
      prisma.membership.groupBy({ by: ['planId'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
    ]);

    const subscribers: any[] = dbMemberships.map((m) => ({
      id: m.id,
      parentId: m.parentId,
      name: m.parent?.name || 'Pet Parent',
      phone: m.parent?.phone || '—',
      email: m.parent?.email || '—',
      city: m.parent?.city || '—',
      planName: m.plan?.name || '—',
      tier: m.plan?.tier || '—',
      billingPeriod: m.plan?.billingPeriod || '—',
      pricePaidRupees: rupees(m.pricePaidMinor || 0),
      autoRenew: m.autoRenew,
      status: m.status,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      createdAt: m.createdAt,
    }));

    // Most popular = the plan with the most live members, not a fixed label.
    const top = [...(popularRaw as Array<{ planId: string; _count: { _all: number } }>)]
      .sort((a, b) => b._count._all - a._count._all)[0];
    const popularPlan = top
      ? (await prisma.membershipPlan.findUnique({ where: { id: top.planId }, select: { name: true } }).catch(() => null))?.name ?? '—'
      : '—';

    res.json({
      ok: true,
      subscribers,
      stats: {
        totalSubscribers,
        activeSubscribers,
        totalRevenue: rupees(revenueAgg._sum.pricePaidMinor ?? 0),
        popularPlan,
      },
    });
  }),
);

// POST /api/admin/subscriptions/parent-subscribers/:id/status
// Status and dates must agree, or benefit checks that look at endsAt keep a
// "cancelled" member live (and a "reactivated" one expired). The old version
// wrote the raw status, swallowed errors and always answered ok.
const ParentSubStatusBody = z
  .object({
    status: z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED']).optional(),
    autoRenew: z.boolean().optional(),
  })
  .refine((b) => b.status !== undefined || b.autoRenew !== undefined, { message: 'Nothing to change' });

adminApiRouter.post(
  '/subscriptions/parent-subscribers/:id/status',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const { status, autoRenew } = ParentSubStatusBody.parse(req.body ?? {});
    const existing = await prisma.membership.findUnique({ where: { id }, include: { plan: true, parent: true } });
    if (!existing) throw new NotFoundError('Subscription not found');

    const now = new Date();
    const data: Record<string, unknown> = {};
    if (autoRenew !== undefined) data.autoRenew = autoRenew;
    if (status === 'ACTIVE') {
      data.status = 'ACTIVE';
      data.cancelledAt = null;
      if (!existing.endsAt || existing.endsAt <= now) {
        data.startsAt = now;
        data.endsAt = new Date(now.getTime() + existing.plan.durationDays * 24 * 3600 * 1000);
      }
    } else if (status === 'CANCELLED' || status === 'EXPIRED') {
      data.status = status;
      data.autoRenew = false;
      if (status === 'CANCELLED') data.cancelledAt = now;
      if (!existing.endsAt || existing.endsAt > now) data.endsAt = now;
    }

    const m = await prisma.membership.update({ where: { id }, data });
    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN', actorId: req.auth!.sub, action: `membership.${(status ?? 'autorenew').toLowerCase()}`,
        meta: { membershipId: id, autoRenew: autoRenew ?? null }, ipAddress: req.ip ?? null,
      },
    }).catch(() => {});
    // The member loses their benefits today, so tell them.
    if (status && status !== 'ACTIVE' && existing.status === 'ACTIVE') {
      notifyIf(existing.parent?.email, (to) =>
        membershipExpiredEmail(to, existing.parent?.name ?? 'there', existing.plan.name),
      );
    }
    res.json({ ok: true, id, status: m.status, autoRenew: m.autoRenew, endsAt: m.endsAt });
  }),
);

// ---------- Vendor subscription tiers ----------
const VendorPlanBody = z.object({
  id: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/, 'Plan id may only use letters, digits, _ and -').optional(),
  sku: z.string().max(60).optional(),
  tier: z.string().trim().min(2).max(40).optional(),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  tagline: z.string().max(240).optional(),
  perks: PerksField,
  leadLimit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  badge: z.string().max(40).optional(),
  priceRupees: z.coerce.number().min(0).max(10_000_000).optional(),
  durationDays: z.coerce.number().int().min(1).max(3660).optional(),
  recommended: z.boolean().optional(),
  active: z.boolean().optional(),
});
type VendorPlanInput = z.infer<typeof VendorPlanBody>;

function toVendorPlan(b: VendorPlanInput, base: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const k of ['sku', 'tier', 'billingPeriod', 'name', 'tagline', 'leadLimit', 'badge', 'durationDays', 'recommended', 'active'] as const) {
    if (b[k] !== undefined) out[k] = b[k];
  }
  if (b.priceRupees !== undefined) out.priceRupees = Math.round(b.priceRupees);
  if (b.perks !== undefined) out.perks = normalizePerks(b.perks);
  return out;
}

// GET /api/admin/subscriptions/vendor-plans
adminApiRouter.get(
  '/subscriptions/vendor-plans',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, plans: memoryVendorSubPlans });
  }),
);

// POST /api/admin/subscriptions/vendor-plans
adminApiRouter.post(
  '/subscriptions/vendor-plans',
  asyncHandler(async (req, res) => {
    const b = VendorPlanBody.parse(req.body ?? {});
    if (!b.name) throw new BadRequestError('Plan name is required');
    const id = b.id || `sub_vendor_${Date.now()}`;
    const idx = memoryVendorSubPlans.findIndex((p) => p.id === id);

    const planData = toVendorPlan(b, {
      id,
      sku: `vendor_${Date.now()}`,
      tier: 'GOLD',
      billingPeriod: 'MONTHLY',
      tagline: '',
      perks: [],
      leadLimit: 9999,
      badge: 'VERIFIED_PRO',
      priceRupees: 0,
      durationDays: 30,
      recommended: false,
      active: true,
    });

    const next = [...memoryVendorSubPlans];
    if (idx >= 0) next[idx] = planData;
    else next.push(planData);
    await persistPlanStore(PLAN_STORE_KEYS.vendor, next, req.auth!.sub);
    replaceContents(memoryVendorSubPlans, next);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'vendor_plan.save', meta: { planId: id, priceRupees: planData.priceRupees }, ipAddress: req.ip ?? null },
    }).catch(() => {});

    res.json({ ok: true, plan: planData });
  }),
);

// PUT /api/admin/subscriptions/vendor-plans/:id
adminApiRouter.put(
  '/subscriptions/vendor-plans/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const idx = memoryVendorSubPlans.findIndex((p) => p.id === id);
    const existing = memoryVendorSubPlans[idx];
    // Answering ok for an unknown id told the admin a change was saved when
    // nothing had happened.
    if (idx < 0 || !existing) throw new NotFoundError('Plan not found');
    const { id: _ignored, ...b } = VendorPlanBody.parse(req.body ?? {});

    const updated = toVendorPlan(b, existing);
    const next = [...memoryVendorSubPlans];
    next[idx] = updated;
    await persistPlanStore(PLAN_STORE_KEYS.vendor, next, req.auth!.sub);
    replaceContents(memoryVendorSubPlans, next);
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'vendor_plan.update', meta: { planId: id, changed: Object.keys(b) }, ipAddress: req.ip ?? null },
    }).catch(() => {});
    res.json({ ok: true, plan: updated });
  }),
);

// GET /api/admin/subscriptions/vendor-subscribers
adminApiRouter.get(
  '/subscriptions/vendor-subscribers',
  asyncHandler(async (_req, res) => {
    // Walk the subscriptions themselves rather than the newest 100 vendors, so
    // a paying vendor who signed up long ago is not silently left out.
    const paid = Array.from(vendorSubscriptionStore.entries()).filter(
      ([, s]) => s && s.tier && s.tier !== 'BASIC' && (s.pricePaidRupees || 0) > 0,
    );
    const vendors = paid.length
      ? await prisma.vendor
          .findMany({
            where: { id: { in: paid.map(([vendorId]) => vendorId) } },
            select: { id: true, businessName: true, ownerName: true, phone: true, email: true, city: true, category: true, createdAt: true },
          })
          .catch(() => [])
      : [];
    const byId = new Map(vendors.map((v) => [v.id, v]));

    const subscribers: any[] = [];
    const nowMs = Date.now();
    for (const [vendorId, activeSub] of paid) {
      const v = byId.get(vendorId);
      if (!v) continue; // vendor deleted since
      // A paid plan past its end date has lapsed even if nobody has touched
      // the store since (currentVendorSubscription only rewrites it on the
      // vendor's next visit). It stays listed so it can be reactivated, but it
      // is not counted as an active subscriber.
      const lapsed = !!activeSub.endsAt && new Date(activeSub.endsAt).getTime() < nowMs;
      const effectiveStatus = lapsed && (activeSub.status || 'ACTIVE') === 'ACTIVE' ? 'EXPIRED' : activeSub.status || 'ACTIVE';
      subscribers.push({
        id: activeSub.id || `v_sub_${v.id}`,
        vendorId: v.id,
        businessName: v.businessName || '—',
        ownerName: v.ownerName || v.phone || '—',
        phone: v.phone || '—',
        email: v.email || '—',
        city: v.city || '—',
        category: v.category || '—',
        tierName: activeSub.tierName || 'Vendor Subscription',
        tier: activeSub.tier,
        pricePaidRupees: activeSub.pricePaidRupees || 0,
        leadLimit: activeSub.leadLimit ?? 9999,
        status: effectiveStatus,
        startsAt: activeSub.startsAt ?? null,
        endsAt: activeSub.endsAt ?? null,
      });
    }
    subscribers.sort((a, b) => new Date(b.startsAt ?? 0).getTime() - new Date(a.startsAt ?? 0).getTime());

    const totalRevenue = subscribers.reduce((sum, s) => sum + (s.pricePaidRupees || 0), 0);
    const activeCount = subscribers.filter((s) => s.status === 'ACTIVE').length;
    const goldCount = subscribers.filter((s) => s.tier === 'GOLD' || s.tier === 'DIAMOND').length;

    res.json({
      ok: true,
      subscribers,
      stats: {
        totalSubscribedVendors: subscribers.length,
        activeSubscribers: activeCount,
        goldMembersCount: goldCount,
        totalRevenue,
      },
    });
  }),
);

// POST /api/admin/subscriptions/vendor-subscribers/:id/status
// Used to answer ok without changing anything, so "Expire Sub" / "Activate"
// were dead buttons. The id is the subscription id or the vendor id.
const VendorSubStatusBody = z.object({ status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']) });

adminApiRouter.post(
  '/subscriptions/vendor-subscribers/:id/status',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const { status } = VendorSubStatusBody.parse(req.body ?? {});

    let vendorId: string | null = vendorSubscriptionStore.has(id) ? id : null;
    if (!vendorId) {
      for (const [vid, s] of vendorSubscriptionStore.entries()) {
        if (s && (s.id === id || `v_sub_${vid}` === id)) { vendorId = vid; break; }
      }
    }
    const current = vendorId ? vendorSubscriptionStore.get(vendorId) : null;
    if (!vendorId || !current) throw new NotFoundError('Subscription not found');

    const now = new Date();
    const next: Record<string, any> = { ...current, status };
    if (status === 'ACTIVE') {
      const ends = current.endsAt ? new Date(current.endsAt) : null;
      if (!ends || ends <= now) {
        const plan = memoryVendorSubPlans.find((p) => p.tier === current.tier);
        next.startsAt = now;
        next.endsAt = new Date(now.getTime() + (Number(plan?.durationDays) || 30) * 24 * 3600 * 1000);
      }
    } else {
      next.autoRenew = false;
      const ends = current.endsAt ? new Date(current.endsAt) : null;
      if (!ends || ends > now) next.endsAt = now;
    }
    vendorSubscriptionStore.set(vendorId, next);

    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: `vendor_subscription.${status.toLowerCase()}`, meta: { vendorId, subscriptionId: current.id ?? null }, ipAddress: req.ip ?? null },
    }).catch(() => {});
    res.json({ ok: true, id, vendorId, status: next.status, endsAt: next.endsAt });
  }),
);
