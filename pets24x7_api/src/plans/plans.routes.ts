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
import { contactQuota, unlockContact, type ContactQuota } from './entitlements.js';
import { getPlanLimits, savePlanLimits, UNLIMITED } from './limits.js';

export const accessRouter = Router();
export const adminPlanLimitsRouter = Router();

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
