// Admin JSON API — part 2. Membership plans, payments/refunds, featured
// listings, deals, events, WhatsApp log, audit log, settings, manual vendor
// creation, enquiry + service moderation. All DB-backed, admin-authenticated.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { normalizePhone } from '../shared/phone.js';
import { getListingById } from '../listings/index.js';
import { notifyIf } from '../mail/notify.js';
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

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id }, data: { status: 'REFUNDED', errorMessage: String(req.body?.reason ?? 'admin refund') } });
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
    await audit(req, 'payment.refund', { paymentId: id });
    res.json({ ok: true, id, status: 'REFUNDED' });
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
