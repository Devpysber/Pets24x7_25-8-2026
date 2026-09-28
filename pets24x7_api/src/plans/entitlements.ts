// Entitlements — what a given person may do right now, under their plan.
//
// Pet parents: a number of "contacts" per calendar month (India time). A
// contact is revealing a phone number, opening WhatsApp or sending an
// enquiry; the same listing again in the same month is free. Free accounts
// get a few, Bronze/Silver more, Gold unlimited.
//
// Businesses: customer contact details on a number of leads per calendar
// month (the first N that month; the rest show that a lead came in, without
// the phone/email, until they upgrade), plus photo and review-request limits.
//
// Numbers come from limits.ts (admin-editable).

import type { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { resolveVendorSubscription } from '../vendors/vendor.subscriptions.routes.js';
import {
  getPlanLimits, monthKey, monthRange, normalizeParentTier, normalizeVendorTier, UNLIMITED,
  type ParentTier, type VendorLimits, type VendorTier,
} from './limits.js';

// ---------------------------------------------------------------------------
// Pet parents
// ---------------------------------------------------------------------------

/** Tier of the parent's live membership, or FREE. */
export async function parentTier(parentId: string): Promise<ParentTier> {
  const now = new Date();
  const m = await prisma.membership.findFirst({
    where: { parentId, status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    orderBy: { endsAt: 'desc' },
    select: { plan: { select: { tier: true } } },
  });
  return m ? normalizeParentTier(m.plan.tier) : 'FREE';
}

export interface ContactQuota {
  tier: ParentTier;
  month: string;
  limit: number; // -1 = unlimited
  used: number;
  remaining: number; // -1 = unlimited
  unlimited: boolean;
  /** Listing ids (and "site") already unlocked this month — free to contact again. */
  unlocked: string[];
}

export async function contactQuota(parentId: string): Promise<ContactQuota> {
  const [tier, limits] = await Promise.all([parentTier(parentId), getPlanLimits()]);
  const month = monthKey();
  const rows = await prisma.contactUnlock.findMany({ where: { parentId, month }, select: { target: true } });
  const limit = limits.parent[tier].contactsPerMonth;
  const unlimited = limit === UNLIMITED;
  return {
    tier, month, limit, used: rows.length, unlimited,
    remaining: unlimited ? UNLIMITED : Math.max(0, limit - rows.length),
    unlocked: rows.map((r) => r.target),
  };
}

export type UnlockResult =
  | { ok: true; alreadyUnlocked: boolean; quota: ContactQuota }
  | { ok: false; quota: ContactQuota };

/**
 * Spends one contact on `target` (a listing id, or "site"), unless it was
 * already unlocked this month. Refuses when the month's allowance is used up.
 */
export async function unlockContact(parentId: string, target: string, kind: string): Promise<UnlockResult> {
  const quota = await contactQuota(parentId);
  if (quota.unlocked.includes(target)) return { ok: true, alreadyUnlocked: true, quota };
  if (!quota.unlimited && quota.remaining <= 0) return { ok: false, quota };
  try {
    await prisma.contactUnlock.create({
      data: { parentId, target: target.slice(0, 191), month: quota.month, kind: kind.slice(0, 16), tier: quota.tier },
    });
  } catch (err: any) {
    // Two taps racing: the unique key already holds this month's row.
    if (err?.code !== 'P2002') throw err;
    return { ok: true, alreadyUnlocked: true, quota };
  }
  const used = quota.used + 1;
  return {
    ok: true,
    alreadyUnlocked: false,
    quota: {
      ...quota, used, unlocked: [...quota.unlocked, target],
      remaining: quota.unlimited ? UNLIMITED : Math.max(0, quota.limit - used),
    },
  };
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export async function vendorPlan(vendorId: string): Promise<{ tier: VendorTier; limits: VendorLimits; subscription: any }> {
  const [sub, limits] = await Promise.all([resolveVendorSubscription(vendorId), getPlanLimits()]);
  const live = sub && (sub.status === 'ACTIVE' || sub.status === 'PAID');
  const tier = live ? normalizeVendorTier(sub.tier) : 'BASIC';
  return { tier, limits: limits.vendor[tier], subscription: sub };
}

/**
 * Of these enquiries, the ids whose customer contact the vendor may see: the
 * first `leadsPerMonth` in each calendar month, counted over every lead in
 * `scope` (not just the page shown), oldest first — so a lead never flips
 * from visible to hidden as newer ones arrive.
 */
export async function visibleLeadIds(
  leadsPerMonth: number,
  scope: Prisma.EnquiryWhereInput,
  enquiries: Array<{ id: string; createdAt: Date }>,
): Promise<Set<string>> {
  if (leadsPerMonth === UNLIMITED) return new Set(enquiries.map((e) => e.id));
  const months = [...new Set(enquiries.map((e) => monthKey(e.createdAt)))];
  const visible = new Set<string>();
  if (leadsPerMonth <= 0) return visible;
  await Promise.all(
    months.map(async (m) => {
      const { start, end } = monthRange(m);
      const first = await prisma.enquiry.findMany({
        where: { AND: [scope, { createdAt: { gte: start, lt: end } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: leadsPerMonth,
        select: { id: true },
      });
      for (const r of first) visible.add(r.id);
    }),
  );
  return visible;
}

/** Leads received this calendar month, for the usage meter. */
export async function leadsThisMonth(scope: Prisma.EnquiryWhereInput): Promise<number> {
  const { start, end } = monthRange();
  return prisma.enquiry.count({ where: { AND: [scope, { createdAt: { gte: start, lt: end } }] } });
}

/** "+91 98••• •••12" — enough to show a real person enquired, not enough to call. */
export function maskPhone(phone: string | null | undefined): string {
  const s = String(phone ?? '');
  const digits = s.replace(/\D/g, '').length;
  if (digits < 7) return '••••••••••';
  let seen = 0;
  return s.replace(/\d/g, (d) => {
    seen++;
    return seen <= 4 || seen > digits - 2 ? d : '•';
  });
}
