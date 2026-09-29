// Plan limits — what each paid plan actually unlocks, in one place.
//
// Before this, every perk was copy: a free pet parent and a Gold member could
// do exactly the same, and a free business saw every customer's number just
// like a Diamond one. These numbers are now enforced (see entitlements.ts) and
// the plan cards are written from them (decorate*Plan), so what is sold and
// what is delivered cannot drift apart.
//
// Admins edit the numbers in Settings → Plan limits (settings row
// "plans:limits"); the defaults below apply until they do. -1 means unlimited.

import { prisma } from '../db.js';
import { logger } from '../logger.js';

export const UNLIMITED = -1;

export type ParentTier = 'FREE' | 'BRONZE' | 'SILVER' | 'GOLD';
export type VendorTier = 'BASIC' | 'SILVER' | 'GOLD' | 'DIAMOND';

export interface ParentLimits {
  contactsPerMonth: number;
  /**
   * Businesses whose own number (the listing's phone in the directory) the
   * parent may reveal and call directly each month. Counted apart from
   * contacts: WhatsApp enquiries still go through Pets24x7's own number.
   */
  callsPerMonth: number;
}
export interface VendorLimits {
  leadsPerMonth: number;
  photos: number;
  reviewRequestsPerDay: number;
  /**
   * Complimentary Featured placements for the whole paid term. The first goes
   * on the business's own city + category automatically; the business places
   * the rest itself (any city, city page or a category page).
   */
  featuredSlots: number;
}
export interface PlanLimits {
  parent: Record<ParentTier, ParentLimits>;
  vendor: Record<VendorTier, VendorLimits>;
}

export const PARENT_TIERS: ParentTier[] = ['FREE', 'BRONZE', 'SILVER', 'GOLD'];
export const VENDOR_TIERS: VendorTier[] = ['BASIC', 'SILVER', 'GOLD', 'DIAMOND'];

export const DEFAULT_LIMITS: PlanLimits = {
  parent: {
    FREE: { contactsPerMonth: 3, callsPerMonth: 3 },
    BRONZE: { contactsPerMonth: 30, callsPerMonth: 25 },
    SILVER: { contactsPerMonth: 100, callsPerMonth: 75 },
    GOLD: { contactsPerMonth: UNLIMITED, callsPerMonth: UNLIMITED },
  },
  vendor: {
    BASIC: { leadsPerMonth: 5, photos: 2, reviewRequestsPerDay: 5, featuredSlots: 0 },
    SILVER: { leadsPerMonth: 50, photos: 5, reviewRequestsPerDay: 50, featuredSlots: 0 },
    GOLD: { leadsPerMonth: UNLIMITED, photos: 10, reviewRequestsPerDay: 200, featuredSlots: 1 },
    DIAMOND: { leadsPerMonth: UNLIMITED, photos: 20, reviewRequestsPerDay: 200, featuredSlots: 3 },
  },
};

/** Hard ceilings, whatever an admin types: the gallery column and the send pipeline have limits of their own. */
const MAX_PHOTOS = 20;
const MAX_REVIEW_REQUESTS = 500;
const MAX_FEATURED_SLOTS = 10;

const KEY = 'plans:limits';
const CACHE_MS = 30_000;
let cache: { value: PlanLimits; at: number } | null = null;

function num(v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return UNLIMITED;
  return Math.min(n, max);
}

/** Merges a saved or submitted object over the defaults, field by field, so a partial or stale row is still complete. */
export function sanitizeLimits(input: unknown): PlanLimits {
  const src = (input ?? {}) as { parent?: Record<string, any>; vendor?: Record<string, any> };
  const out: PlanLimits = JSON.parse(JSON.stringify(DEFAULT_LIMITS));
  for (const t of PARENT_TIERS) {
    const p = src.parent?.[t];
    if (!p) continue;
    out.parent[t].contactsPerMonth = num(p.contactsPerMonth, out.parent[t].contactsPerMonth);
    out.parent[t].callsPerMonth = num(p.callsPerMonth, out.parent[t].callsPerMonth);
  }
  for (const t of VENDOR_TIERS) {
    const v = src.vendor?.[t];
    if (!v) continue;
    const d = out.vendor[t];
    d.leadsPerMonth = num(v.leadsPerMonth, d.leadsPerMonth);
    const photos = num(v.photos, d.photos, MAX_PHOTOS);
    d.photos = photos === UNLIMITED ? MAX_PHOTOS : photos;
    const rr = num(v.reviewRequestsPerDay, d.reviewRequestsPerDay, MAX_REVIEW_REQUESTS);
    d.reviewRequestsPerDay = rr === UNLIMITED ? MAX_REVIEW_REQUESTS : rr;
    // featuredSlot (true/false) is the setting's earlier shape.
    if (v.featuredSlots !== undefined) {
      const n = num(v.featuredSlots, d.featuredSlots, MAX_FEATURED_SLOTS);
      d.featuredSlots = n === UNLIMITED ? MAX_FEATURED_SLOTS : n;
    } else if (typeof v.featuredSlot === 'boolean') d.featuredSlots = v.featuredSlot ? Math.max(1, d.featuredSlots) : 0;
  }
  return out;
}

export async function getPlanLimits(): Promise<PlanLimits> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    cache = { value: sanitizeLimits(row?.value), at: Date.now() };
  } catch (err) {
    logger.warn({ err }, 'plan limits: could not read settings; using the last known or default limits');
    cache = { value: cache?.value ?? sanitizeLimits(null), at: Date.now() };
  }
  return cache.value;
}

export async function savePlanLimits(input: unknown, actorId: string): Promise<PlanLimits> {
  const value = sanitizeLimits(input);
  await prisma.setting.upsert({
    where: { key: KEY },
    update: { value: value as any, updatedBy: actorId },
    create: { key: KEY, value: value as any, updatedBy: actorId },
  });
  cache = { value, at: Date.now() };
  return value;
}

export function normalizeVendorTier(tier: unknown): VendorTier {
  const t = String(tier ?? '').toUpperCase();
  if (t === 'BASIC' || t === 'FREE' || t === 'STANDARD' || !t) return 'BASIC';
  if (t === 'SILVER') return 'SILVER';
  if (t === 'DIAMOND' || t === 'PLATINUM') return 'DIAMOND';
  return 'GOLD';
}

export function normalizeParentTier(tier: unknown): ParentTier {
  const t = String(tier ?? '').toUpperCase();
  return (PARENT_TIERS as string[]).includes(t) ? (t as ParentTier) : 'FREE';
}

// ---------------------------------------------------------------------------
// Months are counted in India time: "this month" for a Mumbai user must not
// roll over at 05:30 on the 1st.
// ---------------------------------------------------------------------------
const IST_MS = 330 * 60_000;

export function monthKey(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + IST_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** [start, end) of an IST calendar month, as UTC instants. */
export function monthRange(key: string = monthKey()): { start: Date; end: Date } {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1) - IST_MS);
  const end = new Date(Date.UTC(y, m, 1) - IST_MS);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Plan-card copy, generated from the limits.
// ---------------------------------------------------------------------------
export function contactsLine(n: number): string {
  if (n === UNLIMITED) return 'Unlimited business contacts (WhatsApp & enquiries)';
  return `${n} business contacts a month (WhatsApp & enquiries)`;
}

export function callsLine(n: number): string {
  if (n === UNLIMITED) return 'Unlimited direct calls: see and call any business’s own number';
  return `${n} direct call${n === 1 ? '' : 's'} a month: see and call the business’s own number`;
}

export function leadsLine(n: number): string {
  if (n === UNLIMITED) return 'UNLIMITED customer leads with full contact details';
  return `${n} customer leads a month with full contact details`;
}

const PARENT_CONTACT_LINE = /business contacts|direct calls?/i;

export function decorateParentPlan<T extends { tier?: unknown; perks?: unknown }>(plan: T, limits: PlanLimits): T {
  const tier = normalizeParentTier(plan.tier);
  const perks = Array.isArray(plan.perks) ? (plan.perks as unknown[]).map(String) : [];
  // "Cancel anytime" contradicted how plans work: they don't renew, so there
  // is nothing to cancel. Said plainly instead.
  const rest = perks
    .filter((p) => !PARENT_CONTACT_LINE.test(p))
    .map((p) => (/^cancel any ?time$/i.test(p.trim()) ? 'No auto-renewal: renew only if you want to' : p));
  const l = limits.parent[tier];
  return { ...plan, perks: [contactsLine(l.contactsPerMonth), callsLine(l.callsPerMonth), ...rest] };
}

// Lines the vendor catalogue used to carry that the limits now write instead.
const VENDOR_GENERATED = [/unlimited .*(enquir|lead)/i, /customer leads/i, /featured .*(slot|spot)/i, /photos? on your listing/i, /review requests/i];

export function decorateVendorPlan<T extends { tier?: unknown; perks?: unknown; leadLimit?: unknown }>(plan: T, limits: PlanLimits): T {
  const tier = normalizeVendorTier(plan.tier);
  const l = limits.vendor[tier];
  const perks = Array.isArray(plan.perks) ? (plan.perks as unknown[]).map(String) : [];
  const rest = perks.filter((p) => !VENDOR_GENERATED.some((re) => re.test(p)));
  const lines = [
    leadsLine(l.leadsPerMonth),
    `${l.photos} photos on your listing`,
    `${l.reviewRequestsPerDay} review requests a day`,
    ...(l.featuredSlots === 1 ? ['Featured placement on your city & category pages for the whole plan'] : []),
    ...(l.featuredSlots > 1 ? [`${l.featuredSlots} Featured placements for the whole plan: yours, plus ${l.featuredSlots - 1} on any city or category page you choose`] : []),
  ];
  // Taglines were written when every plan had unlimited leads ("Verified Pro
  // Badge + Unlimited Leads" on Silver); they follow the limit too.
  const t = (plan as { tagline?: unknown }).tagline;
  const tagline =
    typeof t === 'string' && l.leadsPerMonth !== UNLIMITED ? t.replace(/unlimited leads/i, `${l.leadsPerMonth} Leads a Month`) : t;
  return {
    ...plan,
    ...(tagline !== undefined ? { tagline } : {}),
    perks: [...lines, ...rest],
    leadLimit: l.leadsPerMonth === UNLIMITED ? 9999 : l.leadsPerMonth,
  };
}
