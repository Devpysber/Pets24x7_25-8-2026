// JSON API for the Pets24x7 Admin Portal SPA (/dashboard/admin/ on the static site).
// Every route is DB-backed and admin-authenticated. No hardcoded fallback data.
//
//   GET  /api/admin/overview
//   GET  /api/admin/vendors                 ?status=
//   POST /api/admin/vendors/:id/status      { status }
//   GET  /api/admin/parents
//   GET  /api/admin/listings                (claimed listings, enriched from static index)
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

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { getListingById } from '../listings/index.js';
import { notify } from '../whatsapp/notify.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignApprovedEmail,
  campaignCancelledEmail,
  campaignCompletedEmail,
  reviewPublishedEmail,
  reviewRejectedEmail,
  vendorApprovedEmail,
  vendorRejectedEmail,
  vendorSuspendedEmail,
} from '../mail/action-templates.js';

export const adminApiRouter = Router();
adminApiRouter.use(requireAuth('admin'));

const rupees = (minor: number) => Math.round(minor / 100);

// ---------- Overview ----------
adminApiRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const [
      totalVendors,
      pendingVendors,
      activeVendors,
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
    ] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { status: 'PENDING' } }),
      prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      prisma.petParent.count(),
      prisma.vendor.count({ where: { status: 'ACTIVE', listingId: { not: null } } }),
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
      prisma.vendor.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { businessName: true, city: true, createdAt: true } }),
      prisma.petParent.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, city: true, createdAt: true } }),
      prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { name: true, listingName: true, category: true, createdAt: true } }),
      prisma.payment.findMany({ where: { status: 'SUCCESS' }, orderBy: { createdAt: 'desc' }, take: 5, select: { amountMinor: true, purpose: true, createdAt: true } }),
    ]);

    const pendingActions = [
      { id: 'pa1', text: `${pendingVendors} vendors awaiting approval`, target: 'vendors', count: pendingVendors },
      { id: 'pa2', text: `${pendingCampaigns} campaigns pending review`, target: 'marketing', count: pendingCampaigns },
      { id: 'pa3', text: `${pendingReviews} reviews awaiting moderation`, target: 'reviews', count: pendingReviews },
      { id: 'pa4', text: `${reportedReviews} reported reviews`, target: 'reviews', count: reportedReviews },
    ].filter((a) => a.count > 0);

    const fmtActivity = (title: string, detail: string, at: Date) => ({
      id: `${title}-${at.getTime()}`,
      title,
      detail: `${detail} · ${at.toLocaleString()}`,
    });
    const recentActivity = [
      ...recentVendors.map((v) => fmtActivity('New vendor registered', `${v.businessName} · ${v.city ?? '—'}`, v.createdAt)),
      ...recentParents.map((p) => fmtActivity('New pet parent registered', p.name ?? 'Pet Parent', p.createdAt)),
      ...recentEnquiries.map((e) => fmtActivity('New enquiry', `${e.name} → ${e.listingName ?? e.category ?? 'vendor'}`, e.createdAt)),
      ...recentPayments.map((p) => fmtActivity('Payment received', `₹${rupees(p.amountMinor).toLocaleString()} · ${p.purpose}`, p.createdAt)),
    ]
      .sort((a, b) => b.detail.localeCompare(a.detail))
      .slice(0, 10);

    res.json({
      ok: true,
      stats: {
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
      pendingActions,
      recentActivity,
    });
  }),
);

// ---------- Vendors ----------
adminApiRouter.get(
  '/vendors',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status ?? '');
    const where = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'].includes(status) ? { status: status as any } : {};
    const vendors = await prisma.vendor.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({
      ok: true,
      vendors: vendors.map((v) => ({
        id: v.id,
        name: v.businessName,
        owner: v.email ?? v.phone,
        email: v.email,
        // Staff need to know whether an address is proven before they rely on
        // it to reach a vendor.
        emailVerified: v.emailVerified,
        phone: v.phone,
        category: v.category ?? '—',
        location: [v.city, v.country].filter(Boolean).join(', ') || '—',
        listingId: v.listingId,
        status: v.status,
        claimedAt: v.claimedAt,
        approvedAt: v.approvedAt,
        createdAt: v.createdAt,
      })),
    });
  }),
);

const VendorStatusBody = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED']), reason: z.string().max(240).optional() });

adminApiRouter.post(
  '/vendors/:id/status',
  asyncHandler(async (req, res) => {
    const { status, reason } = VendorStatusBody.parse(req.body);
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
    await prisma.auditLog.create({
      data: {
        actorType: 'ADMIN',
        actorId: req.auth!.sub,
        action: `vendor.${status.toLowerCase()}`,
        meta: { vendorId: id, reason: reason ?? null },
        ipAddress: req.ip ?? null,
      },
    });
    if (status === 'ACTIVE' && existing.status !== 'ACTIVE' && v.phone) {
      notify(v.phone, `Your Pets24x7 listing "${v.businessName}" is approved and live. Sign in at pets24x7.com to manage it.`).catch(() => {});
    } else if (status === 'REJECTED' && v.phone) {
      notify(v.phone, `Your Pets24x7 listing claim for "${v.businessName}" was not approved.${reason ? ' Reason: ' + reason : ''}`).catch(() => {});
    }
    if (status !== existing.status) {
      if (status === 'ACTIVE') notifyIf(v.email, (to) => vendorApprovedEmail(to, v.businessName));
      else if (status === 'REJECTED') notifyIf(v.email, (to) => vendorRejectedEmail(to, v.businessName, reason ?? null));
      else if (status === 'SUSPENDED') notifyIf(v.email, (to) => vendorSuspendedEmail(to, v.businessName));
    }
    res.json({ ok: true, id: v.id, status: v.status });
  }),
);

// ---------- Pet parents ----------
adminApiRouter.get(
  '/parents',
  asyncHandler(async (_req, res) => {
    const parents = await prisma.petParent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { pets: { select: { name: true, species: true } }, _count: { select: { enquiries: true, memberships: true } } },
    });
    res.json({
      ok: true,
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

// ---------- Listings (claimed) ----------
adminApiRouter.get(
  '/listings',
  asyncHandler(async (_req, res) => {
    const vendors = await prisma.vendor.findMany({
      where: { listingId: { not: null } },
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
  asyncHandler(async (_req, res) => {
    const services = await prisma.service.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { vendor: { select: { businessName: true, city: true } } },
    });
    res.json({
      ok: true,
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
  asyncHandler(async (_req, res) => {
    const enquiries = await prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 300 });
    res.json({
      ok: true,
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

adminApiRouter.post(
  '/marketing/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = CampaignStatusBody.parse(req.body);
    const id = req.params.id ?? '';
    const existing = await prisma.marketingCampaign.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Campaign not found');

    const data: Record<string, unknown> = { status };
    if (status === 'ACTIVE' && !existing.startsAt) {
      const now = new Date();
      data.startsAt = now;
      data.endsAt = new Date(now.getTime() + existing.durationDays * 24 * 3600 * 1000);
    }
    const c = await prisma.marketingCampaign.update({ where: { id }, data });
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: `campaign.${status.toLowerCase()}`, meta: { campaignId: id }, ipAddress: req.ip ?? null },
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
    const [payments, byStatus, monthAgg] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
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
    ]);

    const sumFor = (s: string) => rupees(byStatus.find((b) => b.status === s)?._sum.amountMinor ?? 0);

    res.json({
      ok: true,
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
    const [reviews, pending, published, rejected] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { vendor: { select: { businessName: true } } },
      }),
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.review.count({ where: { status: 'PUBLISHED' } }),
      prisma.review.count({ where: { status: 'REJECTED' } }),
    ]);
    res.json({
      ok: true,
      metrics: { pending, published, rejected },
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewer: r.reviewerName,
        vendor: r.vendor.businessName,
        rating: r.rating,
        comment: r.text,
        status: r.status,
        date: r.createdAt,
      })),
    });
  }),
);

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
    const publishVendor = await prisma.vendor
      .findUnique({ where: { id: r.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(publishVendor?.email, (to) =>
      reviewPublishedEmail(to, publishVendor!.businessName, { reviewerName: r.reviewerName, rating: r.rating }),
    );
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
    const rejectVendor = await prisma.vendor
      .findUnique({ where: { id: r.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(rejectVendor?.email, (to) =>
      reviewRejectedEmail(to, rejectVendor!.businessName, { reviewerName: r.reviewerName, rating: r.rating }, reason ?? null),
    );
    res.json({ ok: true, id: r.id, status: r.status });
  }),
);

// ---------- Reports (rollup) ----------
adminApiRouter.get(
  '/reports',
  asyncHandler(async (_req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [newVendors, newParents, newEnquiries, paid, revenueAgg] = await Promise.all([
      prisma.vendor.count({ where: { createdAt: { gte: since } } }),
      prisma.petParent.count({ where: { createdAt: { gte: since } } }),
      prisma.enquiry.count({ where: { createdAt: { gte: since } } }),
      prisma.payment.count({ where: { status: 'SUCCESS', createdAt: { gte: since } } }),
      prisma.payment.aggregate({ _sum: { amountMinor: true }, where: { status: 'SUCCESS', createdAt: { gte: since } } }),
    ]);
    res.json({
      ok: true,
      window: '30d',
      report: {
        newVendors,
        newParents,
        newEnquiries,
        paidTransactions: paid,
        revenue: rupees(revenueAgg._sum.amountMinor ?? 0),
      },
    });
  }),
);
