// Admin action center — GET /api/admin/reco/insights.
//
// Precomputed every 15 minutes by jobs/reco-jobs.ts (and on demand by
// POST /api/admin/reco/rebuild). Every query is a bounded groupBy or findMany
// over a date-ranged, indexed column, so the cost does not grow with the
// directory: approvals waiting, vendors worth nudging, upsell candidates,
// 7-day demand trends, supply gaps, featured-slot delivery and campaign
// audiences that pre-fill (never send) the mail composer.

import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { profileCompletion, type ProfileCompletionInput } from '../../vendors/profile-completion.js';
import { getListingById, shownRating } from '../../listings/index.js';
import { normalizeEmail } from '../../mail/optout.js';
import { kv } from '../../shared/kv.js';
import { APPROVED_VENDOR_STATUSES } from '../../shared/vendor-status.js';
import { getRecoConfig, type RecoConfig } from './config.js';
import { cityCategoryListings, cityListings, countryOfCity } from './city-index.js';
import { ensureSignals, type Snapshot } from './signals.js';
import { CONTACT_KINDS, DAY_MS, dayDate, median, siteBase, ymd } from './util.js';

type GroupByFn = (args: unknown) => Promise<unknown>;
type CountRow = Record<string, string | null> & { _count: { _all: number } };

const MIN_GAP_MS = 20 * 3600 * 1000;

async function groupCount(model: 'listingActivity' | 'enquiry', by: string[], where: object, take = 500): Promise<CountRow[]> {
  try {
    const fn = (prisma[model] as unknown as { groupBy: GroupByFn }).groupBy;
    return (await fn({
      by,
      where,
      _count: { _all: true },
      orderBy: { _count: { [by[0]!]: 'desc' } },
      take,
    })) as CountRow[];
  } catch {
    return [];
  }
}

function toMap(rows: CountRow[], key: (r: CountRow) => string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + r._count._all);
  }
  return m;
}

function growthPct(cur: number, prev: number): number {
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

/**
 * The vendor's profile completion, as the vendor sees it on their dashboard
 * and in /api/reco/vendor (vendors/profile-completion.ts).
 */
export function profileCompleteness(v: ProfileCompletionInput): number {
  return profileCompletion(v).percent;
}

function profileGaps(v: { imageUrl: string | null; about: string | null; servicesList: string | null; openingHours: string | null }): string[] {
  const gaps: string[] = [];
  if (!v.imageUrl) gaps.push('photo');
  if (!v.about?.trim()) gaps.push('description');
  if (!v.servicesList?.trim()) gaps.push('services');
  if (!v.openingHours?.trim()) gaps.push('opening hours');
  return gaps;
}

export interface AdminInsights {
  ok: true;
  generatedAt: string;
  approvals: Array<Record<string, unknown>>;
  nudges: Array<Record<string, unknown>>;
  upsell: Array<Record<string, unknown>>;
  trends: {
    windowDays: 7;
    cities: Array<Record<string, unknown>>;
    categories: Array<Record<string, unknown>>;
    supplyGaps: Array<Record<string, unknown>>;
  };
  featured: Array<Record<string, unknown>>;
  campaigns: Array<Record<string, unknown>>;
}

async function compute(config: RecoConfig, snap: Snapshot): Promise<AdminInsights> {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d14 = new Date(now.getTime() - 14 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const staleBefore = new Date(now.getTime() - config.admin.staleEnquiryHours * 3600 * 1000);
  const contact = { kind: { in: CONTACT_KINDS } };

  const [
    pending,
    tapsByCity30,
    enqByCity30,
    vendors,
    stale,
    featuredRows,
    tapsCityCur,
    tapsCityPrev,
    enqCityCur,
    enqCityPrev,
    tapsCatCur,
    tapsCatPrev,
    enqCatCur,
    enqCatPrev,
    tapsCityCat30,
    enqCityCat30,
    parentsWithEmail,
    activeVendorsWithEmail,
    membersActive,
  ] = await Promise.all([
    prisma.vendor
      .findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 200,
        select: { id: true, businessName: true, city: true, category: true, status: true, createdAt: true, listingId: true },
      })
      .catch(() => []),
    groupCount('listingActivity', ['city'], { ...contact, createdAt: { gte: d30 } }),
    groupCount('enquiry', ['city'], { createdAt: { gte: d30 } }),
    prisma.vendor
      .findMany({
        where: {
          status: { in: [...APPROVED_VENDOR_STATUSES] },
          OR: [{ claimedAt: { not: null } }, { passwordHash: { not: null } }],
        },
        orderBy: { id: 'asc' },
        take: 2000,
        select: {
          id: true,
          businessName: true,
          email: true,
          emailVerified: true,
          city: true,
          category: true,
          listingId: true,
          imageUrl: true,
          galleryImages: true,
          about: true,
          servicesList: true,
          openingHours: true,
          website: true,
          whatsapp: true,
          status: true,
          lastMarketingAt: true,
          claimedAt: true,
        },
      })
      .catch(() => []),
    groupCount('enquiry', ['listingId'], { status: 'NEW', createdAt: { lt: staleBefore }, listingId: { not: null } }, 2000),
    prisma.featuredListing
      .findMany({
        where: { OR: [{ status: 'ACTIVE' }, { status: 'EXPIRED', endsAt: { gte: d30 } }] },
        orderBy: { endsAt: 'asc' },
        take: 1000,
        select: {
          id: true,
          vendorId: true,
          listingId: true,
          city: true,
          category: true,
          startsAt: true,
          endsAt: true,
          status: true,
          vendor: { select: { businessName: true } },
        },
      })
      .catch(() => []),
    groupCount('listingActivity', ['city'], { ...contact, createdAt: { gte: d7 } }),
    groupCount('listingActivity', ['city'], { ...contact, createdAt: { gte: d14, lt: d7 } }),
    groupCount('enquiry', ['city'], { createdAt: { gte: d7 } }),
    groupCount('enquiry', ['city'], { createdAt: { gte: d14, lt: d7 } }),
    groupCount('listingActivity', ['category'], { ...contact, createdAt: { gte: d7 } }),
    groupCount('listingActivity', ['category'], { ...contact, createdAt: { gte: d14, lt: d7 } }),
    groupCount('enquiry', ['category'], { createdAt: { gte: d7 } }),
    groupCount('enquiry', ['category'], { createdAt: { gte: d14, lt: d7 } }),
    groupCount('listingActivity', ['city', 'category'], { ...contact, createdAt: { gte: d30 } }, 1000),
    groupCount('enquiry', ['city', 'category'], { createdAt: { gte: d30 } }, 1000),
    prisma.petParent.count({ where: { email: { not: null } } }).catch(() => 0),
    prisma.vendor.count({ where: { email: { not: null }, status: { in: [...APPROVED_VENDOR_STATUSES] } } }).catch(() => 0),
    prisma.membership.count({ where: { status: 'ACTIVE' } }).catch(() => 0),
  ]);

  const lower = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();
  const cityDemand = toMap(tapsByCity30, (r) => lower(r.city));
  for (const [k, n] of toMap(enqByCity30, (r) => lower(r.city))) cityDemand.set(k, (cityDemand.get(k) ?? 0) + n);

  // ---- Approvals: longest-waiting first, weighted by the demand they would serve ----
  const approvals = pending
    .map((v) => {
      const l = v.listingId ? getListingById(v.listingId) : undefined;
      const waitingHours = Math.round((now.getTime() - v.createdAt.getTime()) / 3600000);
      const demand = cityDemand.get(lower(v.city ?? l?.city)) ?? 0;
      const rating = l ? shownRating(l) || null : null;
      const reviews = l ? Number(l.review_count) || 0 : 0;
      const score = Math.round(Math.min(waitingHours, 240) / 2.4 + Math.log10(1 + demand) * 15 + (rating ?? 0) * 3 + Math.log10(1 + reviews) * 4);
      const why = [
        `Waiting ${waitingHours >= 48 ? `${Math.round(waitingHours / 24)} days` : `${waitingHours}h`}`,
        demand ? `${demand} contacts in ${v.city ?? l?.city ?? 'the city'} (30d)` : null,
        rating ? `${rating.toFixed(1)}★ on Google` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        vendorId: v.id,
        businessName: v.businessName,
        city: v.city ?? l?.city ?? null,
        category: v.category ?? l?.category ?? null,
        status: v.status,
        waitingHours,
        listingRating: rating,
        listingReviews: reviews,
        cityDemand30d: demand,
        score,
        why,
      };
    })
    .sort((a, b) => b.score - a.score);

  // ---- Opt-outs for the vendors we might nudge, in chunks ----
  const optedOut = new Set<string>();
  const emails = vendors.map((v) => v.email).filter((e): e is string => !!e).map(normalizeEmail);
  for (let i = 0; i < emails.length; i += 500) {
    const rows = await prisma.emailOptOut
      .findMany({ where: { email: { in: emails.slice(i, i + 500) } }, select: { email: true } })
      .catch(() => []);
    for (const r of rows) optedOut.add(r.email);
  }
  const staleByListing = toMap(stale, (r) => r.listingId);

  // ---- Nudges ----
  const nudges = vendors
    .map((v) => {
      const l = v.listingId ? getListingById(v.listingId) : undefined;
      const staleEnquiries = v.listingId ? staleByListing.get(v.listingId) ?? 0 : 0;
      const gaps = profileGaps(v);
      let kind: 'open_enquiries' | 'profile_gaps' | 'collect_reviews' | 'unverified_email' | null = null;
      let detail = '';
      if (staleEnquiries > 0) {
        kind = 'open_enquiries';
        detail = `${staleEnquiries} enquir${staleEnquiries === 1 ? 'y' : 'ies'} unanswered for over ${config.admin.staleEnquiryHours}h`;
      } else if (v.email && !v.emailVerified) {
        kind = 'unverified_email';
        detail = 'Business email not verified — enquiry alerts may not reach them';
      } else if (gaps.length) {
        kind = 'profile_gaps';
        detail = `Missing ${gaps.join(', ')}`;
      } else if (l && (Number(l.review_count) || 0) < 5) {
        kind = 'collect_reviews';
        detail = `Only ${Number(l.review_count) || 0} Google reviews`;
      }
      if (!kind) return null;
      const email = v.email ? normalizeEmail(v.email) : null;
      const canNudge =
        kind !== 'unverified_email' &&
        !!email &&
        v.emailVerified &&
        !optedOut.has(email) &&
        (!v.lastMarketingAt || now.getTime() - v.lastMarketingAt.getTime() >= MIN_GAP_MS);
      return {
        vendorId: v.id,
        businessName: v.businessName,
        email: v.email,
        kind,
        detail,
        ...(kind === 'open_enquiries' ? { staleEnquiries } : {}),
        views30d: v.listingId ? snap.views30d.get(v.listingId) ?? 0 : 0,
        lastMarketingAt: v.lastMarketingAt ? v.lastMarketingAt.toISOString() : null,
        canNudge,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const kindRank = { open_enquiries: 0, unverified_email: 1, profile_gaps: 2, collect_reviews: 3 } as const;
  nudges.sort(
    (a, b) =>
      kindRank[a.kind] - kindRank[b.kind] ||
      ((b as { staleEnquiries?: number }).staleEnquiries ?? 0) - ((a as { staleEnquiries?: number }).staleEnquiries ?? 0) ||
      b.views30d - a.views30d,
  );

  // ---- Featured slot state per vendor ----
  const activeByVendor = new Map<string, { endsAt: Date | null; queued: boolean }>();
  const expiredByVendor = new Map<string, Date>();
  for (const f of featuredRows) {
    if (f.status === 'ACTIVE' && f.endsAt && f.endsAt > now) {
      const cur = activeByVendor.get(f.vendorId) ?? { endsAt: null, queued: false };
      if (f.startsAt && f.startsAt > now) cur.queued = true;
      else if (!cur.endsAt || (f.endsAt && f.endsAt > cur.endsAt)) cur.endsAt = f.endsAt;
      activeByVendor.set(f.vendorId, cur);
    } else if (f.status === 'EXPIRED' && f.endsAt) {
      const prev = expiredByVendor.get(f.vendorId);
      if (!prev || f.endsAt > prev) expiredByVendor.set(f.vendorId, f.endsAt);
    }
  }

  // ---- Upsell ----
  // Service rows and reviews feed the shared completion figure; counted once
  // for every claimed vendor rather than per row.
  const claimedIds = vendors.filter((v) => v.listingId && v.claimedAt).map((v) => v.id);
  const claimedListingIds = vendors.filter((v) => v.listingId && v.claimedAt).map((v) => v.listingId as string);
  const [svcRows, reviewByVendor, reviewByListing] = claimedIds.length
    ? await Promise.all([
        prisma.service.groupBy({ by: ['vendorId'], where: { vendorId: { in: claimedIds } }, _count: { _all: true } }).catch(() => []),
        prisma.review.groupBy({ by: ['vendorId'], where: { vendorId: { in: claimedIds } }, _count: { _all: true } }).catch(() => []),
        prisma.review
          .groupBy({ by: ['listingId'], where: { vendorId: null, listingId: { in: claimedListingIds } }, _count: { _all: true } })
          .catch(() => []),
      ])
    : [[], [], []];
  const serviceCountBy = new Map(svcRows.map((r) => [r.vendorId, r._count._all]));
  const reviewedVendors = new Set(reviewByVendor.map((r) => r.vendorId).filter((x): x is string => !!x));
  const reviewedListings = new Set(reviewByListing.map((r) => r.listingId).filter((x): x is string => !!x));

  const upsell: Array<Record<string, unknown> & { views30d: number; rank: number }> = [];
  for (const v of vendors) {
    if (!v.listingId || !v.claimedAt) continue;
    const l = getListingById(v.listingId);
    if (!l) continue;
    const views30d = snap.views30d.get(l.id) ?? 0;
    const taps30d = snap.taps30d.get(l.id) ?? 0;
    const completeness = profileCompleteness({
      ...v,
      listingWebsite: l.website ?? null,
      serviceCount: serviceCountBy.get(v.id) ?? 0,
      hasReviews: reviewedVendors.has(v.id) || reviewedListings.has(l.id),
    });
    const competitors = Math.max(0, cityCategoryListings(l.city_slug || l.city, String(l.country), l.category_slug).length - 1);
    const act = activeByVendor.get(v.id);
    const base = { vendorId: v.id, businessName: v.businessName, city: l.city, category: l.category, views30d, taps30d, completeness, competitors };
    if (act?.endsAt && !act.queued && act.endsAt.getTime() - now.getTime() < config.vendor.renewWithinDays * DAY_MS) {
      const days = Math.max(0, Math.ceil((act.endsAt.getTime() - now.getTime()) / DAY_MS));
      upsell.push({ ...base, kind: 'renew_featured', featuredEndsAt: act.endsAt.toISOString(), why: `Featured ends in ${days} day${days === 1 ? '' : 's'} with nothing queued`, rank: 0 });
      continue;
    }
    if (act) continue;
    const expired = expiredByVendor.get(v.id);
    if (expired) {
      upsell.push({ ...base, kind: 'win_back_featured', featuredEndsAt: expired.toISOString(), why: `Featured lapsed ${Math.round((now.getTime() - expired.getTime()) / DAY_MS)} days ago`, rank: 1 });
      continue;
    }
    if (completeness >= config.vendor.minCompletenessForBoost && competitors >= config.vendor.minCompetitorsForBoost) {
      upsell.push({ ...base, kind: 'boost_featured', featuredEndsAt: null, why: `${competitors} competitors in ${l.city}; profile ${completeness}% complete`, rank: 2 });
    } else if (views30d >= 50) {
      upsell.push({ ...base, kind: 'campaign', featuredEndsAt: null, why: `${views30d} profile views this month — a campaign can convert more`, rank: 3 });
    }
  }
  upsell.sort((a, b) => a.rank - b.rank || b.views30d - a.views30d);

  // ---- Featured delivery ----
  let statsByFeatured = new Map<string, { imp: number; clk: number }>();
  let enqByListing = new Map<string, number>();
  if (featuredRows.length) {
    try {
      const fn = prisma.recoStatDaily.groupBy as unknown as GroupByFn;
      const rows = (await fn({
        by: ['featuredId'],
        // `day` is a UTC-midnight date: compare against d30's own day, or the
        // oldest day of the window was always left out.
        where: { featuredId: { in: featuredRows.map((f) => f.id) }, sponsored: true, day: { gte: dayDate(ymd(d30)) } },
        _sum: { impressions: true, clicks: true },
      })) as Array<{ featuredId: string | null; _sum: { impressions: number | null; clicks: number | null } }>;
      statsByFeatured = new Map(
        rows.filter((r) => r.featuredId).map((r) => [r.featuredId!, { imp: r._sum.impressions ?? 0, clk: r._sum.clicks ?? 0 }]),
      );
    } catch {
      // no stats yet
    }
    enqByListing = toMap(
      await groupCount('enquiry', ['listingId'], { listingId: { in: [...new Set(featuredRows.map((f) => f.listingId))] }, createdAt: { gte: d30 } }, 1000),
      (r) => r.listingId,
    );
  }
  const ctrs = [...statsByFeatured.values()].filter((s) => s.imp >= 100).map((s) => s.clk / s.imp);
  const ctrMedian = median(ctrs) ?? 0;
  const featured = featuredRows.map((f) => {
    const s = statsByFeatured.get(f.id) ?? { imp: 0, clk: 0 };
    const ctr = s.imp > 0 ? Math.round((s.clk / s.imp) * 10000) / 10000 : 0;
    const live = f.status === 'ACTIVE' && (!f.startsAt || f.startsAt <= now) && (!f.endsAt || f.endsAt > now);
    const startedAt = f.startsAt ?? null;
    let flag: 'OK' | 'UNDERPERFORMING' | 'NO_DELIVERY' = 'OK';
    let suggestion = 'Delivering normally.';
    if (live && s.imp === 0 && (!startedAt || now.getTime() - startedAt.getTime() > DAY_MS)) {
      flag = 'NO_DELIVERY';
      suggestion = 'No sponsored impressions yet — check the listing is in the index and its city/category pages get traffic.';
    } else if (s.imp >= 100 && ctrMedian > 0 && ctr < ctrMedian * config.admin.underperformCtrRatio) {
      flag = 'UNDERPERFORMING';
      suggestion = 'CTR well below other sponsors — suggest a better photo, description and services to the vendor.';
    } else if (!live) {
      suggestion = f.status === 'ACTIVE' ? 'Queued — starts when the current placement ends.' : 'Ended.';
    }
    return {
      featuredId: f.id,
      vendorId: f.vendorId,
      businessName: f.vendor?.businessName ?? null,
      listingId: f.listingId,
      city: f.city,
      category: f.category,
      status: f.status,
      startsAt: f.startsAt ? f.startsAt.toISOString() : null,
      endsAt: f.endsAt ? f.endsAt.toISOString() : null,
      impressions: s.imp,
      clicks: s.clk,
      ctr,
      taps: snap.taps30d.get(f.listingId) ?? 0,
      enquiries: enqByListing.get(f.listingId) ?? 0,
      sponsoredCtrMedian: Math.round(ctrMedian * 10000) / 10000,
      flag,
      suggestion,
    };
  });

  // ---- Trends ----
  const trendRows = (
    tapsCur: CountRow[],
    tapsPrev: CountRow[],
    enqCur: CountRow[],
    enqPrev: CountRow[],
    field: 'city' | 'category',
  ) => {
    // Case-insensitive: activity rows and enquiries spell the same city
    // differently ("Mumbai" / "mumbai"), which split one city into two rows.
    const display = new Map<string, string>();
    const keyOf = (r: CountRow) => {
      const raw = r[field] ? String(r[field]).trim() : '';
      if (!raw) return null;
      const k = raw.toLowerCase();
      if (!display.has(k)) display.set(k, raw);
      return k;
    };
    const tc = toMap(tapsCur, keyOf);
    const tp = toMap(tapsPrev, keyOf);
    const ec = toMap(enqCur, keyOf);
    const ep = toMap(enqPrev, keyOf);
    const keys = new Set([...tc.keys(), ...tp.keys(), ...ec.keys(), ...ep.keys()]);
    return [...keys]
      .map((k) => {
        const taps = tc.get(k) ?? 0;
        const prevTaps = tp.get(k) ?? 0;
        const enquiries = ec.get(k) ?? 0;
        const prevEnquiries = ep.get(k) ?? 0;
        const name = display.get(k) ?? k;
        return { name, taps, enquiries, prevTaps, prevEnquiries, growthPct: growthPct(taps + enquiries, prevTaps + prevEnquiries) };
      })
      .filter((r) => r.taps + r.enquiries + r.prevTaps + r.prevEnquiries >= 3)
      .sort((a, b) => b.taps + b.enquiries - (a.taps + a.enquiries) || b.growthPct - a.growthPct)
      .slice(0, 50);
  };
  const cities = trendRows(tapsCityCur, tapsCityPrev, enqCityCur, enqCityPrev, 'city').map(({ name, ...r }) => ({
    city: name,
    country: countryOfCity(name),
    ...r,
  }));
  const categories = trendRows(tapsCatCur, tapsCatPrev, enqCatCur, enqCatPrev, 'category').map(({ name, ...r }) => ({ category: name, ...r }));

  // ---- Supply gaps: demand per claimed listing, by city + category ----
  const demandCC = new Map<string, { city: string; category: string; n: number }>();
  const addDemand = (rows: CountRow[]) => {
    for (const r of rows) {
      if (!r.city || !r.category) continue;
      const k = `${lower(r.city)}|${lower(r.category)}`;
      const cur = demandCC.get(k) ?? { city: String(r.city), category: String(r.category), n: 0 };
      cur.n += r._count._all;
      demandCC.set(k, cur);
    }
  };
  addDemand(tapsCityCat30);
  addDemand(enqCityCat30);
  const claimedCC = new Map<string, number>();
  for (const id of snap.approvedClaimed) {
    const l = getListingById(id);
    if (!l) continue;
    const k = `${lower(l.city)}|${lower(l.category)}`;
    claimedCC.set(k, (claimedCC.get(k) ?? 0) + 1);
  }
  const supplyGaps = [...demandCC.entries()]
    .filter(([, d]) => d.n >= 5)
    .map(([k, d]) => {
      const claimed = claimedCC.get(k) ?? 0;
      return { key: k, ...d, claimed, demandPerClaimed: Math.round((d.n / Math.max(1, claimed)) * 10) / 10 };
    })
    .sort((a, b) => b.demandPerClaimed - a.demandPerClaimed)
    .slice(0, 30)
    .map((g) => {
      const listings = cityListings(g.city, '').filter((l) => lower(l.category) === lower(g.category)).length;
      return {
        city: g.city,
        category: g.category,
        demand30d: g.n,
        claimedListings: g.claimed,
        listings,
        demandPerClaimed: g.demandPerClaimed,
      };
    });

  // ---- Campaign audiences (pre-fill only; the composer confirms the count) ----
  const gapsCount = nudges.filter((n) => n.kind === 'profile_gaps').length;
  const topCity = cities.find((c) => c.growthPct > 0);
  const topGap = supplyGaps[0];
  const campaigns: Array<Record<string, unknown>> = [];
  if (gapsCount > 0) {
    campaigns.push({
      id: 'vendors_profile_gaps',
      audience: 'vendors',
      title: 'Help businesses finish their profiles',
      description: `${gapsCount} approved businesses are missing a photo, description, services or hours. A short how-to lifts their enquiries.`,
      size: activeVendorsWithEmail,
      filter: { audience: 'active_vendors' },
      suggestedTemplateId: 'custom',
      suggestedData: {
        subject: 'Three minutes that bring you more enquiries',
        heading: 'Finish your Pets24x7 listing',
        message:
          'Hi,\n\nListings with a photo, a short description, services and opening hours are contacted far more often than those without.\n\nOpen your dashboard to add what is missing.\n\n— Team Pets24x7',
        buttonLabel: 'Open my dashboard',
        buttonUrl: `${siteBase()}/dashboard/vendor/?view=listing`,
      },
    });
  }
  if (topCity) {
    campaigns.push({
      id: 'parents_trending_city',
      audience: 'parents',
      title: `Demand is up ${topCity.growthPct}% in ${topCity.city}`,
      description: `Pet owners in ${topCity.city} contacted businesses ${topCity.taps + topCity.enquiries} times this week. A "what's popular near you" note keeps parents coming back.`,
      size: parentsWithEmail,
      filter: { audience: 'parents' },
      suggestedTemplateId: 'custom',
      suggestedData: {
        subject: `What pet parents are booking this week`,
        heading: 'Popular near you',
        message: `Hi,\n\nPet parents in ${topCity.city} have been busy this week. See the best-rated services near you on Pets24x7.\n\n— Team Pets24x7`,
        buttonLabel: 'See what is popular',
        buttonUrl: `${siteBase()}/`,
      },
    });
  }
  if (topGap) {
    campaigns.push({
      id: 'vendors_supply_gap',
      audience: 'vendors',
      title: `Few claimed ${topGap.category} businesses in ${topGap.city}`,
      description: `${topGap.demand30d} pet-owner contacts in 30 days for ${topGap.claimedListings} claimed listing(s). Invite businesses to claim and respond. For unclaimed listings use scripts/claim-campaign.mjs.`,
      size: activeVendorsWithEmail,
      filter: { audience: 'active_vendors' },
      suggestedTemplateId: 'custom',
      suggestedData: {
        subject: `Pet owners in ${topGap.city} are looking for ${topGap.category.toLowerCase()}`,
        heading: 'Demand is growing',
        message: `Hi,\n\nPet owners in ${topGap.city} contacted ${topGap.category.toLowerCase()} businesses ${topGap.demand30d} times in the last month. Make sure your listing is complete and you reply quickly.\n\n— Team Pets24x7`,
      },
    });
  }
  if (membersActive > 0) {
    campaigns.push({
      id: 'members_perks',
      audience: 'parents',
      title: 'Remind members of their perks',
      description: `${membersActive} active members. A perks reminder improves renewal.`,
      size: membersActive,
      filter: { audience: 'members' },
      suggestedTemplateId: 'custom',
      suggestedData: {
        subject: 'Your Pets24x7 membership perks',
        heading: 'Make the most of your membership',
        message: 'Hi,\n\nA quick reminder of the discounts and priority support your membership includes.\n\n— Team Pets24x7',
        buttonLabel: 'See my membership',
        buttonUrl: `${siteBase()}/dashboard/parent/?view=membership`,
      },
    });
  }

  return {
    ok: true,
    generatedAt: now.toISOString(),
    approvals,
    nudges,
    upsell: upsell.map(({ rank: _rank, ...u }) => u),
    trends: { windowDays: 7, cities, categories, supplyGaps },
    featured,
    campaigns,
  };
}

let cached: { at: number; data: AdminInsights } | null = null;
let running: Promise<AdminInsights> | null = null;

/**
 * The last computed copy, in the shared kv. With several instances only the
 * one holding the job lease recomputes on schedule (jobs/reco-jobs.ts); the
 * others read its result here instead of each running the same queries.
 * Skipped without REDIS_URL: one server has nobody to share it with.
 */
const SHARED_KEY = 'reco:v1:admin-insights';
const SHARED_TTL_MS = 60 * 60_000;

/** Recomputes now (single-flight) and publishes the result to the other instances. */
export function recomputeAdminInsights(): Promise<AdminInsights> {
  if (!running) {
    running = (async () => {
      const [config, snap] = await Promise.all([getRecoConfig(), ensureSignals()]);
      const data = await compute(config, snap);
      cached = { at: Date.now(), data };
      if (kv.backend === 'redis') await kv.setJson(SHARED_KEY, cached, SHARED_TTL_MS);
      return data;
    })().finally(() => (running = null));
  }
  return running;
}

/** Cached insights, recomputed when older than config.cacheTtlSec.admin. */
export async function getAdminInsights(): Promise<AdminInsights> {
  const config = await getRecoConfig();
  const maxAge = config.cacheTtlSec.admin * 1000;
  if (cached && Date.now() - cached.at < maxAge) return cached.data;
  // Another instance may have computed a fresher copy.
  const peer = kv.backend === 'redis' ? await kv.getJson<{ at: number; data: AdminInsights }>(SHARED_KEY) : null;
  if (peer && (!cached || peer.at > cached.at)) cached = peer;
  if (cached && Date.now() - cached.at < maxAge) return cached.data;
  if (cached) {
    // Serve the stale copy while a refresh runs in the background.
    void recomputeAdminInsights().catch((err) => logger.warn({ err }, 'reco admin insights refresh failed'));
    return cached.data;
  }
  return recomputeAdminInsights();
}
