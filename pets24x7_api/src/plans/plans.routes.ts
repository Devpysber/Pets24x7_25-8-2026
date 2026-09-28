// Plan-limit endpoints.
//
//   GET  /api/access/contact          signed-in caller's contact allowance this month
//   POST /api/access/contact          spend one contact { target?, kind }
//   GET  /api/admin/plan-limits       the limits in force
//   PUT  /api/admin/plan-limits       change them
//
// Businesses and admins are never limited here: the lock exists to sell pet
// parents a membership, and a business contacting Pets24x7 is a sales lead.

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { requireAuth } from '../auth/middleware.js';
import { identifyCaller, recordUserActivity } from '../activity/user-activity.js';
import { getPublicListingById } from '../listings/index.js';
import { contactQuota, unlockContact, vendorPlan, type ContactQuota } from './entitlements.js';
import { getPlanLimits, savePlanLimits, UNLIMITED } from './limits.js';
import { placementOptions } from '../listings/index.js';
import { planSlotsActive, placePlanSlot, removePlanSlot } from './featured-grant.js';
import { prisma } from '../db.js';
import { isVendorApproved } from '../shared/vendor-status.js';
import { notifyIf } from '../mail/notify.js';
import { vendorPlanLimitsNoticeEmail } from '../mail/action-templates.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../shared/errors.js';
import { currentVendorSubscription, loadVendorSubscriptions } from '../vendors/vendor.subscriptions.routes.js';

export const accessRouter = Router();
export const adminPlanLimitsRouter = Router();
export const vendorPlanSlotsRouter = Router();

const unlimitedQuota = (tier: string): Omit<ContactQuota, 'tier'> & { tier: string } => ({
  tier, month: '', limit: UNLIMITED, used: 0, remaining: UNLIMITED, unlimited: true, unlocked: [],
});

accessRouter.get(
  '/contact',
  asyncHandler(async (req, res) => {
    const who = identifyCaller(req);
    if (!who) return res.json({ ok: true, signedIn: false });
    if (who.role !== 'pet_parent') return res.json({ ok: true, signedIn: true, role: who.role, quota: unlimitedQuota(who.role.toUpperCase()) });
    res.json({ ok: true, signedIn: true, role: who.role, quota: await contactQuota(who.id) });
  }),
);

const UnlockBody = z.object({
  target: z.string().max(191).optional(),
  kind: z.enum(['phone', 'whatsapp', 'enquiry']),
  path: z.string().max(512).optional(),
});

const unlockLimiter = makeLimiter('contact-unlock', { windowMs: 60_000, max: 30, standardHeaders: true });

accessRouter.post(
  '/contact',
  unlockLimiter,
  asyncHandler(async (req, res) => {
    const body = UnlockBody.parse(req.body);
    const who = identifyCaller(req);
    if (!who) return res.status(401).json({ ok: false, error: 'sign_in_required', message: 'Sign in to contact businesses.' });
    if (who.role !== 'pet_parent') return res.json({ ok: true, quota: unlimitedQuota(who.role.toUpperCase()) });

    // Only a real, public listing is a target of its own; anything else
    // (home page, footer, concierge box) is Pets24x7's own line.
    const target = body.target && getPublicListingById(body.target) ? body.target : 'site';
    const result = await unlockContact(who.id, target, body.kind);
    if (!result.ok) {
      recordUserActivity({
        actorRole: 'pet_parent', actorId: who.id, action: 'plan_limit',
        label: `Hit the monthly contact limit (${result.quota.tier}, ${result.quota.limit}/month)`,
        path: body.path ?? null, listingId: target === 'site' ? null : target, ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
      return res.status(402).json({
        ok: false, error: 'plan_limit',
        message: `You have used all ${result.quota.limit} contacts included this month. Upgrade your membership to keep contacting businesses.`,
        quota: result.quota,
      });
    }
    res.json({ ok: true, alreadyUnlocked: result.alreadyUnlocked, quota: result.quota });
  }),
);

adminPlanLimitsRouter.use('/plan-limits', requireAuth('admin'));

adminPlanLimitsRouter.get(
  '/plan-limits',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, limits: await getPlanLimits(), unlimited: UNLIMITED });
  }),
);

adminPlanLimitsRouter.put(
  '/plan-limits',
  asyncHandler(async (req, res) => {
    const limits = await savePlanLimits(req.body?.limits ?? req.body, req.auth!.sub);
    res.json({ ok: true, limits });
  }),
);

// ---------------------------------------------------------------------------
// Business: placing the plan's Featured slots (Gold 1, Diamond 3)
//
//   GET    /api/vendor/plan-featured        allowance, placed slots, choices
//   POST   /api/vendor/plan-featured        { citySlug, categorySlug|null }
//   DELETE /api/vendor/plan-featured/:id    free a slot to place it elsewhere
// ---------------------------------------------------------------------------
vendorPlanSlotsRouter.use(requireAuth('vendor'));

async function slotState(vendorId: string) {
  const plan = await vendorPlan(vendorId);
  const slots = await planSlotsActive(vendorId);
  const endsAt = plan.subscription?.endsAt ? new Date(plan.subscription.endsAt) : null;
  const live = plan.tier !== 'BASIC' && !!endsAt && endsAt > new Date();
  return { plan, slots, endsAt, allowed: live ? plan.limits.featuredSlots : 0 };
}

vendorPlanSlotsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const st = await slotState(req.auth!.sub);
    res.json({
      ok: true,
      tier: st.plan.tier,
      allowed: st.allowed,
      used: st.slots.length,
      endsAt: st.endsAt,
      slots: st.slots,
      options: st.allowed > 0 ? placementOptions() : { cities: [], categories: [] },
    });
  }),
);

const PlaceBody = z.object({
  citySlug: z.string().min(1).max(160),
  categorySlug: z.string().max(160).nullable().optional(),
});

vendorPlanSlotsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = PlaceBody.parse(req.body);
    const vendorId = req.auth!.sub;
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { listingId: true, status: true } });
    if (!vendor) throw new ForbiddenError();
    if (!isVendorApproved(vendor.status)) throw new ForbiddenError('Your business must be approved first');
    if (!vendor.listingId) throw new BadRequestError('Claim your listing first');

    const st = await slotState(vendorId);
    if (st.allowed <= 0 || !st.endsAt) throw new ForbiddenError('Your plan does not include Featured placements. Upgrade to Gold or Diamond.');
    if (st.slots.length >= st.allowed) {
      throw new ConflictError('All ' + st.allowed + ' Featured placements on your plan are in use. Remove one to place it somewhere else.');
    }
    const opts = placementOptions();
    const city = opts.cities.find((c) => c.slug === body.citySlug);
    if (!city) throw new BadRequestError('Pick a city from the list');
    const category = body.categorySlug ? opts.categories.find((c) => c.slug === body.categorySlug) : null;
    if (body.categorySlug && !category) throw new BadRequestError('Pick a page from the list');
    if (st.slots.some((x) => x.citySlug === city.slug && (x.categorySlug ?? null) === (category?.slug ?? null))) {
      throw new ConflictError('You are already featured there');
    }
    await placePlanSlot({ vendorId, listingId: vendor.listingId, city, category: category ?? null, endsAt: st.endsAt });
    res.json({ ok: true, slots: await planSlotsActive(vendorId) });
  }),
);

vendorPlanSlotsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await removePlanSlot(req.auth!.sub, req.params.id ?? '');
    if (!ok) throw new NotFoundError('That placement was not found');
    res.json({ ok: true, slots: await planSlotsActive(req.auth!.sub) });
  }),
);

// ---------------------------------------------------------------------------
// Admin: tell Basic businesses what the free plan includes (once each).
//
//   GET  /api/admin/plan-limits/notice   how many would get it / already have
//   POST /api/admin/plan-limits/notice   send it
// ---------------------------------------------------------------------------
const NOTICE_KEY = 'notice:basic_plan_limits';

async function basicRecipients() {
  await loadVendorSubscriptions();
  const vendors = await prisma.vendor.findMany({
    where: { status: 'ACTIVE', email: { not: null }, claimedAt: { not: null } },
    select: { id: true, email: true, businessName: true },
  });
  const row = await prisma.setting.findUnique({ where: { key: NOTICE_KEY } });
  const prev = (row?.value ?? {}) as { vendorIds?: unknown };
  const already = new Set<string>(Array.isArray(prev.vendorIds) ? (prev.vendorIds as string[]) : []);
  const basic = vendors.filter((v) => {
    const sub = currentVendorSubscription(v.id);
    const live = sub.status === 'ACTIVE' || sub.status === 'PAID';
    return !live || String(sub.tier).toUpperCase() === 'BASIC';
  });
  return { basic, already };
}

adminPlanLimitsRouter.get(
  '/plan-limits/notice',
  asyncHandler(async (_req, res) => {
    const { basic, already } = await basicRecipients();
    const toSend = basic.filter((v) => !already.has(v.id)).length;
    res.json({ ok: true, basicBusinesses: basic.length, alreadySent: basic.length - toSend, toSend });
  }),
);

adminPlanLimitsRouter.post(
  '/plan-limits/notice',
  asyncHandler(async (req, res) => {
    const { basic, already } = await basicRecipients();
    const limits = (await getPlanLimits()).vendor.BASIC;
    const todo = basic.filter((v) => !already.has(v.id));
    for (const v of todo) notifyIf(v.email, (to) => vendorPlanLimitsNoticeEmail(to, v.businessName, limits));
    const value = { vendorIds: [...already, ...todo.map((v) => v.id)], lastSentAt: new Date().toISOString() };
    await prisma.setting.upsert({
      where: { key: NOTICE_KEY },
      update: { value: value as any, updatedBy: req.auth!.sub },
      create: { key: NOTICE_KEY, value: value as any, updatedBy: req.auth!.sub },
    });
    await prisma.auditLog
      .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'plan_limits.notice_sent', meta: { sent: todo.length }, ipAddress: req.ip ?? null } })
      .catch(() => {});
    res.json({ ok: true, sent: todo.length, skippedAlreadySent: basic.length - todo.length });
  }),
);
