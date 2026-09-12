// Admin JSON API — part 2. Membership plans, payments/refunds, featured
// listings, deals, events, WhatsApp log, audit log, settings, manual vendor
// creation, enquiry + service moderation. All DB-backed, admin-authenticated.

import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { setAuthCookie } from '../auth/jwt.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { normalizePhone } from '../shared/phone.js';
import { getListingById } from '../listings/index.js';
import { getFeaturedOptions } from '../payments/pricing.js';
import { notifyIf } from '../mail/notify.js';
import { adminProfileChangedEmail } from '../mail/action-templates.js';
import { logger } from '../logger.js';
import { createRefund } from '../payments/razorpay.js';
import {
  enquiryStatusEmail,
  featuredEndedEmail,
  paymentRefundedEmail,
  serviceModeratedEmail,
  vendorWelcomeEmail,
} from '../mail/action-templates.js';

export const adminExtraRouter = Router();
adminExtraRouter.use(requireAuth('admin'));

const rupees = (m: number) => Math.round(m / 100);
async function audit(req: any, action: string, meta: object) {
  await prisma.auditLog.create({
    data: { actorType: 'ADMIN', actorId: req.auth!.sub, action, meta, ipAddress: req.ip ?? null },
  }).catch(() => {});
}

// ---------------- Membership plans ----------------
adminExtraRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.membershipPlan.findMany({ orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }] });
    res.json({ ok: true, plans });
  }),
);

const PlanBody = z.object({
  sku: z.string().min(2).max(60),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD']),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']),
  name: z.string().min(2).max(80),
  tagline: z.string().max(160).optional(),
  perks: z.array(z.string().max(160)).max(20).optional(),
  // Headline member benefit shown as a badge across the site.
  discountPercent: z.number().int().min(0).max(90).optional(),
  priceMinor: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  durationDays: z.number().int().min(1).max(3660),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

adminExtraRouter.post(
  '/plans',
  asyncHandler(async (req, res) => {
    const b = PlanBody.parse(req.body);
    const plan = await prisma.membershipPlan.create({
      data: {
        sku: b.sku, tier: b.tier, billingPeriod: b.billingPeriod, name: b.name,
        tagline: b.tagline ?? null, perks: b.perks ?? [], discountPercent: b.discountPercent ?? 0,
        priceMinor: b.priceMinor,
        currency: b.currency ?? 'INR', durationDays: b.durationDays,
        active: b.active ?? true, sortOrder: b.sortOrder ?? 0,
      },
    });
    await audit(req, 'plan.create', { planId: plan.id, sku: plan.sku });
    res.status(201).json({ ok: true, plan });
  }),
);

adminExtraRouter.patch(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const b = PlanBody.partial().parse(req.body);
    const existing = await prisma.membershipPlan.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Plan not found');
    const data: Record<string, unknown> = {};
    for (const k of ['sku', 'tier', 'billingPeriod', 'name', 'tagline', 'priceMinor', 'currency', 'durationDays', 'active', 'sortOrder'] as const) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.perks !== undefined) data.perks = b.perks;
    if (b.discountPercent !== undefined) data.discountPercent = b.discountPercent;
    const plan = await prisma.membershipPlan.update({ where: { id: existing.id }, data });
    await audit(req, 'plan.update', { planId: plan.id });
    res.json({ ok: true, plan });
  }),
);

// ---------------- Payments — refund ----------------
adminExtraRouter.post(
  '/payments/:id/refund',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const p = await prisma.payment.findUnique({
      where: { id },
      include: {
        parent: true,
        membership: { include: { plan: true, parent: true } },
        campaign: { include: { vendor: true } },
        featuredListing: { include: { vendor: true } },
      },
    });
    if (!p) throw new NotFoundError('Payment not found');
    if (p.status !== 'SUCCESS') throw new BadRequestError('Only successful payments can be refunded');

    // Move the money first. Marking the row REFUNDED without calling the
    // gateway told the payer their refund was on its way while the money never
    // left our account — so a gateway failure must abort the whole thing.
    const reason = String(req.body?.reason ?? 'admin refund').slice(0, 200);
    let refundId: string | null = null;
    if (p.gateway === 'RAZORPAY') {
      if (!p.gatewayTxnId) throw new BadRequestError('This payment has no Razorpay payment id to refund');
      try {
        const refund = await createRefund({
          paymentId: p.gatewayTxnId,
          amountMinor: p.amountMinor,
          notes: { merchantTxnId: p.merchantTxnId, reason },
          // Same payment, same refund — a double click cannot pay out twice.
          idempotencyKey: `refund_${p.id}`,
        });
        refundId = refund.id;
      } catch (err: any) {
        logger.warn({ err, paymentId: p.id }, 'admin refund: gateway refused');
        throw new BadRequestError(`Refund failed at Razorpay: ${err?.message ?? 'unknown error'}`);
      }
    } else {
      // Retired gateway (PhonePe). Nothing to call — the money has to be sent
      // back by hand, so say so instead of silently marking it refunded.
      throw new BadRequestError(
        'This payment was taken on the retired PhonePe integration. Refund it in the PhonePe dashboard, then mark it here.',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id },
        data: { status: 'REFUNDED', errorMessage: refundId ? `${reason} (refund ${refundId})` : reason },
      });
      // A refunded membership must actually stop: leaving endsAt in the future
      // kept every benefit live after the money went back.
      const refundedAt = new Date();
      if (p.membershipId) {
        await tx.membership.update({
          where: { id: p.membershipId },
          data: { status: 'REFUNDED', cancelledAt: refundedAt, endsAt: refundedAt, autoRenew: false },
        });
      }
      if (p.campaignId) await tx.marketingCampaign.update({ where: { id: p.campaignId }, data: { status: 'CANCELLED' } });
      if (p.featuredListingId) {
        await tx.featuredListing.update({
          where: { id: p.featuredListingId },
          data: { status: 'CANCELLED', endsAt: refundedAt },
        });
      }
    });
    const what = p.membership
      ? `your ${p.membership.plan.name} membership`
      : p.campaign
        ? 'your marketing campaign'
        : p.featuredListing
          ? 'your featured placement'
          : 'your Pets24x7 purchase';
    const payerEmail =
      p.membership?.parent?.email ??
      p.parent?.email ??
      p.campaign?.vendor?.email ??
      p.featuredListing?.vendor?.email ??
      null;
    const payerName =
      p.membership?.parent?.name ??
      p.parent?.name ??
      p.campaign?.vendor?.businessName ??
      p.featuredListing?.vendor?.businessName ??
      'there';
    notifyIf(payerEmail, (to) =>
      paymentRefundedEmail(to, payerName, what, p.amountMinor, p.currency, p.merchantTxnId),
    );
    await audit(req, 'payment.refund', { paymentId: id, refundId, reason });
    res.json({ ok: true, id, status: 'REFUNDED', refundId });
  }),
);

// ---------------- Featured listings ----------------
adminExtraRouter.get(
  '/featured',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.featuredListing.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { vendor: { select: { businessName: true } }, payment: { select: { status: true } } },
    });
    res.json({
      ok: true,
      featured: rows.map((f) => ({
        id: f.id,
        vendor: f.vendor.businessName,
        listingId: f.listingId,
        city: f.city ?? '—',
        category: f.category ?? '—',
        amount: rupees(f.priceMinor),
        status: f.status,
        paymentStatus: f.payment?.status ?? null,
        startsAt: f.startsAt,
        endsAt: f.endsAt,
      })),
    });
  }),
);

// Which businesses can be given a placement, and for how long. The picker
// needs this, because a placement only means something for a claimed listing —
// an unclaimed directory row has no owner to benefit from it.
adminExtraRouter.get(
  '/featured/candidates',
  asyncHandler(async (_req, res) => {
    const vendors = await prisma.vendor.findMany({
      where: { listingId: { not: null }, status: { in: ['ACTIVE', 'CLAIMED'] } },
      orderBy: { businessName: 'asc' },
      take: 500,
      select: { id: true, businessName: true, city: true, category: true, listingId: true },
    });
    const live = await prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: new Date() } },
      select: { vendorId: true, endsAt: true },
    });
    const liveBy = new Map(live.map((f) => [f.vendorId, f.endsAt]));
    res.json({
      ok: true,
      candidates: vendors.map((v) => ({
        id: v.id,
        name: v.businessName,
        city: v.city ?? '—',
        category: v.category ?? '—',
        liveUntil: liveBy.get(v.id) ?? null,
      })),
      options: getFeaturedOptions().map((o) => ({
        durationDays: o.durationDays,
        label: o.label,
        rupees: Math.round(o.priceMinor / 100),
      })),
    });
  }),
);

// Grant a placement without a payment. Used for a slot sold offline, a make-good
// after an outage, or a trial. It is recorded at zero so the revenue figures
// stay true, and the audit log says who granted it.
const FeaturedGrantBody = z.object({
  vendorId: z.string().min(1),
  durationDays: z.number().int().min(1).max(365),
  note: z.string().max(500).optional(),
});
adminExtraRouter.post(
  '/featured',
  asyncHandler(async (req, res) => {
    const body = FeaturedGrantBody.parse(req.body ?? {});
    const vendor = await prisma.vendor.findUnique({ where: { id: body.vendorId } });
    if (!vendor) throw new NotFoundError('Vendor not found');
    if (!vendor.listingId) throw new BadRequestError(`${vendor.businessName} has not claimed a listing yet.`);

    // Queue behind a live placement rather than overwrite it, the same rule the
    // paid path follows.
    const live = await prisma.featuredListing.findFirst({
      where: { vendorId: vendor.id, status: 'ACTIVE', endsAt: { gt: new Date() } },
      orderBy: { endsAt: 'desc' },
    });
    const startsAt = live?.endsAt ?? new Date();
    const endsAt = new Date(startsAt.getTime() + body.durationDays * 24 * 3600 * 1000);

    const listing = getListingById(vendor.listingId);
    // The slugs are what a city page filters on, so they cannot be left null
    // when the index has no row for this listing — the placement would be
    // invisible everywhere.
    const slugify = (v: string | null | undefined) =>
      v ? v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || null : null;
    const city = listing?.city ?? vendor.city ?? null;
    const category = listing?.category ?? vendor.category ?? null;

    // Placements are pinned to a city page. Without a city there is no page to
    // pin to, so the grant would take effect nowhere — say so instead.
    if (!city) {
      throw new BadRequestError(
        `${vendor.businessName} has no city on its record, so a placement has no page to appear on. Set the city first.`,
      );
    }

    const f = await prisma.featuredListing.create({
      data: {
        vendorId: vendor.id,
        listingId: vendor.listingId,
        city,
        citySlug: listing?.city_slug ?? slugify(city),
        category,
        categorySlug: listing?.category_slug ?? slugify(category),
        priceMinor: 0,
        currency: 'INR',
        durationDays: body.durationDays,
        status: 'ACTIVE',
        startsAt,
        endsAt,
      },
    });

    await audit(req, 'featured.grant', {
      featuredId: f.id, vendorId: vendor.id, durationDays: body.durationDays, note: body.note ?? null,
    });
    res.json({ ok: true, featured: { id: f.id, startsAt, endsAt }, vendor: vendor.businessName });
  }),
);

const FeaturedStatusBody = z.object({ status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED']) });
adminExtraRouter.post(
  '/featured/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = FeaturedStatusBody.parse(req.body);
    const existing = await prisma.featuredListing.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Featured listing not found');
    // Status and window must agree. Flipping a live slot to EXPIRED/CANCELLED
    // while endsAt stays in the future leaves a row that reads "expired" in the
    // vendor's history but still looks live to every date-based check.
    const now = new Date();
    const data: { status: typeof status; startsAt?: Date; endsAt?: Date } = { status };
    if (status === 'ACTIVE') {
      const startsAt = existing.startsAt ?? now;
      data.startsAt = startsAt;
      if (!existing.endsAt || existing.endsAt <= now) {
        data.endsAt = new Date(startsAt.getTime() + existing.durationDays * 24 * 3600 * 1000);
      }
    } else if (existing.endsAt && existing.endsAt > now) {
      data.endsAt = now;
    }
    const f = await prisma.featuredListing.update({ where: { id: existing.id }, data });
    if (status !== existing.status && status !== 'ACTIVE') {
      const vendor = await prisma.vendor
        .findUnique({ where: { id: f.vendorId }, select: { email: true, businessName: true } })
        .catch(() => null);
      notifyIf(vendor?.email, (to) => featuredEndedEmail(to, vendor!.businessName, status === 'CANCELLED'));
    }
    await audit(req, `featured.${status.toLowerCase()}`, { featuredId: f.id });
    res.json({ ok: true, id: f.id, status: f.status });
  }),
);

// ---------------- Service moderation ----------------
const ServiceStatusBody = z.object({ status: z.enum(['ACTIVE', 'HIDDEN']) });
adminExtraRouter.post(
  '/services/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = ServiceStatusBody.parse(req.body);
    const existing = await prisma.service.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Service not found');
    const s = await prisma.service.update({ where: { id: existing.id }, data: { status } });
    if (status !== existing.status) {
      const vendor = await prisma.vendor
        .findUnique({ where: { id: s.vendorId }, select: { email: true, businessName: true } })
        .catch(() => null);
      notifyIf(vendor?.email, (to) => serviceModeratedEmail(to, vendor!.businessName, s.name, status));
    }
    await audit(req, `service.${status.toLowerCase()}`, { serviceId: s.id });
    res.json({ ok: true, id: s.id, status: s.status });
  }),
);

// ---------------- Enquiry status ----------------
const EnquiryStatusBody = z.object({ status: z.enum(['NEW', 'RESPONDED', 'COMPLETED', 'ARCHIVED']) });
adminExtraRouter.post(
  '/enquiries/:id/status',
  asyncHandler(async (req, res) => {
    const { status } = EnquiryStatusBody.parse(req.body);
    const existing = await prisma.enquiry.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Enquiry not found');
    const e = await prisma.enquiry.update({
      where: { id: existing.id },
      data: { status, handledBy: req.auth!.sub, respondedAt: status === 'RESPONDED' ? new Date() : existing.respondedAt },
    });
    if (status !== existing.status) {
      notifyIf(e.email, (to) => enquiryStatusEmail(to, e.name, e.listingName, status));
    }
    res.json({ ok: true, id: e.id, status: e.status });
  }),
);

// ---------------- Manual vendor creation ----------------
const VendorCreateBody = z.object({
  phone: z.string().min(6),
  businessName: z.string().min(2).max(120),
  email: z.string().email().optional(),
  listingId: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
  category: z.string().max(80).optional(),
  status: z.enum(['PENDING', 'ACTIVE']).optional(),
});
adminExtraRouter.post(
  '/vendors',
  asyncHandler(async (req, res) => {
    const b = VendorCreateBody.parse(req.body);
    const phone = normalizePhone(b.phone, b.country ?? 'IN');
    const listing = b.listingId ? getListingById(b.listingId) : undefined;
    const vendor = await prisma.vendor.upsert({
      where: { phone },
      update: { businessName: b.businessName, email: b.email ?? null },
      create: {
        phone,
        businessName: b.businessName,
        email: b.email ?? null,
        listingId: b.listingId ?? null,
        city: b.city ?? listing?.city ?? null,
        country: b.country ?? (listing?.country as string) ?? 'IN',
        category: b.category ?? listing?.category ?? null,
        status: b.status ?? 'ACTIVE',
        claimedAt: b.listingId ? new Date() : null,
        approvedAt: (b.status ?? 'ACTIVE') === 'ACTIVE' ? new Date() : null,
      },
    });
    notifyIf(vendor.email, (to) =>
      vendorWelcomeEmail(to, vendor.businessName, listing?.name ?? vendor.businessName),
    );
    await audit(req, 'vendor.create', { vendorId: vendor.id });
    res.status(201).json({ ok: true, vendor });
  }),
);

// ---------------- Deals CRUD ----------------
const DealBody = z.object({
  vendorId: z.string().optional(),
  title: z.string().min(2).max(140),
  description: z.string().min(2).max(1000),
  offerLabel: z.string().min(1).max(60),
  category: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  citySlug: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
  listingId: z.string().max(120).optional(),
  code: z.string().max(40).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'EXPIRED', 'ARCHIVED']).optional(),
});

adminExtraRouter.get(
  '/deals',
  asyncHandler(async (_req, res) => {
    const deals = await prisma.deal.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { vendor: { select: { businessName: true } } } });
    res.json({ ok: true, deals });
  }),
);
adminExtraRouter.post(
  '/deals',
  asyncHandler(async (req, res) => {
    const b = DealBody.parse(req.body);
    const deal = await prisma.deal.create({
      data: {
        vendorId: b.vendorId ?? null,
        title: b.title, description: b.description, offerLabel: b.offerLabel,
        category: b.category ?? null, city: b.city ?? null,
        citySlug: b.citySlug ?? (b.city ? b.city.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null),
        country: b.country ?? null, listingId: b.listingId ?? null, code: b.code ?? null,
        startsAt: b.startsAt ? new Date(b.startsAt) : new Date(),
        endsAt: b.endsAt ? new Date(b.endsAt) : null,
        status: b.status ?? 'ACTIVE',
        createdBy: req.auth!.sub,
      },
    });
    await audit(req, 'deal.create', { dealId: deal.id });
    res.status(201).json({ ok: true, deal });
  }),
);
adminExtraRouter.patch(
  '/deals/:id',
  asyncHandler(async (req, res) => {
    const b = DealBody.partial().parse(req.body);
    const existing = await prisma.deal.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Deal not found');
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'offerLabel', 'category', 'city', 'citySlug', 'country', 'listingId', 'code', 'status', 'vendorId'] as const) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.startsAt) data.startsAt = new Date(b.startsAt);
    if (b.endsAt) data.endsAt = new Date(b.endsAt);
    const deal = await prisma.deal.update({ where: { id: existing.id }, data });
    await audit(req, 'deal.update', { dealId: deal.id });
    res.json({ ok: true, deal });
  }),
);
adminExtraRouter.delete(
  '/deals/:id',
  asyncHandler(async (req, res) => {
    await prisma.deal.delete({ where: { id: req.params.id ?? '' } }).catch(() => { throw new NotFoundError('Deal not found'); });
    await audit(req, 'deal.delete', { dealId: req.params.id });
    res.json({ ok: true });
  }),
);

// ---------------- Events CRUD ----------------
const EventBody = z.object({
  vendorId: z.string().optional(),
  title: z.string().min(2).max(140),
  description: z.string().min(2).max(2000),
  venue: z.string().max(160).optional(),
  city: z.string().max(80).optional(),
  citySlug: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  rsvpUrl: z.string().url().optional(),
  bannerUrl: z.string().url().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CANCELLED', 'PAST']).optional(),
});

adminExtraRouter.get(
  '/events',
  asyncHandler(async (_req, res) => {
    const events = await prisma.event.findMany({ orderBy: { startsAt: 'desc' }, take: 200, include: { vendor: { select: { businessName: true } } } });
    res.json({ ok: true, events });
  }),
);
adminExtraRouter.post(
  '/events',
  asyncHandler(async (req, res) => {
    const b = EventBody.parse(req.body);
    const event = await prisma.event.create({
      data: {
        vendorId: b.vendorId ?? null,
        title: b.title, description: b.description, venue: b.venue ?? null,
        city: b.city ?? null,
        citySlug: b.citySlug ?? (b.city ? b.city.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null),
        country: b.country ?? null,
        startsAt: new Date(b.startsAt),
        endsAt: b.endsAt ? new Date(b.endsAt) : null,
        rsvpUrl: b.rsvpUrl ?? null, bannerUrl: b.bannerUrl ?? null,
        status: b.status ?? 'PUBLISHED',
        createdBy: req.auth!.sub,
      },
    });
    await audit(req, 'event.create', { eventId: event.id });
    res.status(201).json({ ok: true, event });
  }),
);
adminExtraRouter.patch(
  '/events/:id',
  asyncHandler(async (req, res) => {
    const b = EventBody.partial().parse(req.body);
    const existing = await prisma.event.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Event not found');
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'venue', 'city', 'citySlug', 'country', 'rsvpUrl', 'bannerUrl', 'status', 'vendorId'] as const) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.startsAt) data.startsAt = new Date(b.startsAt);
    if (b.endsAt) data.endsAt = new Date(b.endsAt);
    const event = await prisma.event.update({ where: { id: existing.id }, data });
    await audit(req, 'event.update', { eventId: event.id });
    res.json({ ok: true, event });
  }),
);
adminExtraRouter.delete(
  '/events/:id',
  asyncHandler(async (req, res) => {
    await prisma.event.delete({ where: { id: req.params.id ?? '' } }).catch(() => { throw new NotFoundError('Event not found'); });
    await audit(req, 'event.delete', { eventId: req.params.id });
    res.json({ ok: true });
  }),
);

// ---------------- WhatsApp message log ----------------
adminExtraRouter.get(
  '/wa-messages',
  asyncHandler(async (req, res) => {
    const direction = String(req.query.direction ?? '');
    const where = ['INBOUND', 'OUTBOUND', 'STATUS'].includes(direction) ? { direction: direction as any } : {};
    const messages = await prisma.waMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json({ ok: true, messages });
  }),
);

// ---------------- Audit log ----------------
adminExtraRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const take = Math.min(500, Number(req.query.limit ?? 200) || 200);
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take });
    res.json({ ok: true, logs });
  }),
);

// ---------------- The signed-in admin's own account ----------------
// Email is the account identifier and the address every security notice goes
// to, so it can be set once and then only changed by another admin or in the
// database. The password has no such constraint: it should be changed often,
// and always after anyone leaves.
adminExtraRouter.get(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const admin = await prisma.admin.findUnique({
      where: { id: req.auth!.sub },
      select: { id: true, name: true, email: true, role: true, lastLoginAt: true, createdAt: true },
    });
    if (!admin) throw new NotFoundError('Admin not found');

    const emailLocked = await prisma.setting
      .findUnique({ where: { key: `admin_email_set:${admin.id}` } })
      .catch(() => null);

    res.json({ ok: true, admin: { ...admin, emailLocked: !!emailLocked } });
  }),
);

const AdminProfileBody = z
  .object({
    name: z.string().min(2).max(80).optional(),
    email: z.string().email().max(160).optional(),
    currentPassword: z.string().max(200).optional(),
    newPassword: z.string().min(10, 'Use at least 10 characters').max(200).optional(),
  })
  .refine((b) => b.name || b.email || b.newPassword, { message: 'Nothing to change' });

adminExtraRouter.patch(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const body = AdminProfileBody.parse(req.body ?? {});
    const admin = await prisma.admin.findUnique({ where: { id: req.auth!.sub } });
    if (!admin) throw new NotFoundError('Admin not found');

    const data: Record<string, unknown> = {};
    if (body.name) data.name = body.name.trim();

    // ----- email: once -----
    if (body.email) {
      const nextEmail = body.email.trim().toLowerCase();
      if (nextEmail !== admin.email) {
        const lockKey = `admin_email_set:${admin.id}`;
        const locked = await prisma.setting.findUnique({ where: { key: lockKey } }).catch(() => null);
        if (locked) {
          throw new BadRequestError(
            'The admin email can only be set once. Ask another admin to change it for you.',
          );
        }
        const taken = await prisma.admin.findUnique({ where: { email: nextEmail } });
        if (taken) throw new BadRequestError('Another admin already uses that address');

        data.email = nextEmail;
        await prisma.setting.create({
          data: { key: lockKey, value: { email: nextEmail, setAt: new Date().toISOString() }, updatedBy: admin.id },
        });
      }
    }

    // ----- password: as often as they like, current one required -----
    if (body.newPassword) {
      const ok = body.currentPassword ? await bcrypt.compare(body.currentPassword, admin.passwordHash) : false;
      if (!ok) throw new BadRequestError('Your current password is incorrect');
      if (await bcrypt.compare(body.newPassword, admin.passwordHash)) {
        throw new BadRequestError('The new password must be different from the current one');
      }
      data.passwordHash = await bcrypt.hash(body.newPassword, 12);
      // Every other session made with the old password stops working.
      data.sessionsRevokedAt = new Date();
    }

    const updated = await prisma.admin.update({
      where: { id: admin.id },
      data,
      select: { id: true, name: true, email: true, role: true },
    });

    // The revoke above would sign this admin out of the tab they are using.
    if (data.passwordHash) setAuthCookie(res, { sub: updated.id, role: 'admin' });

    await audit(req, 'admin.profile.update', {
      changed: Object.keys(data).filter((k) => k !== 'passwordHash' && k !== 'sessionsRevokedAt'),
      passwordChanged: !!data.passwordHash,
    });

    // Tell the address on file, so a change nobody made is noticed.
    notifyIf(admin.email, (to) =>
      adminProfileChangedEmail(to, updated.name, {
        emailChanged: !!data.email,
        passwordChanged: !!data.passwordHash,
        newEmail: (data.email as string) ?? null,
      }),
    );

    res.json({ ok: true, admin: updated });
  }),
);

// ---------------- Settings (KV) ----------------
adminExtraRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.setting.findMany();
    const settings: Record<string, unknown> = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ ok: true, settings });
  }),
);

const SettingsBody = z.record(z.string(), z.any());
adminExtraRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = SettingsBody.parse(req.body ?? {});
    const keys = Object.keys(body);
    await Promise.all(
      keys.map((key) =>
        prisma.setting.upsert({
          where: { key },
          update: { value: body[key] as any, updatedBy: req.auth!.sub },
          create: { key, value: body[key] as any, updatedBy: req.auth!.sub },
        }),
      ),
    );
    await audit(req, 'settings.update', { keys });
    res.json({ ok: true, updated: keys });
  }),
);
