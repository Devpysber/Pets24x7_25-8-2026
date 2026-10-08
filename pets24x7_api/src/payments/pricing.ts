import type { CampaignGoal } from '@prisma/client';
import { getActiveGrowPlans } from '../admin/admin.api.routes.js';

/**
 * Admin-edited plans store rupees as a float (parseFloat of a form field). The
 * gateway and Payment.amountMinor both need a whole number of paise, and a
 * blank/garbage price must not become a ₹0 or NaN checkout.
 */
function toMinor(priceRupees: unknown): number | null {
  const n = Number(priceRupees);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// ---- Currency ----
// India pays in rupees, the US in dollars (Razorpay International). A
// business's currency follows its country; a pet parent's follows the site
// they are on. Everything below is in minor units (paise / cents).
export type Currency = 'INR' | 'USD';
export function currencyForCountry(country: string | null | undefined): Currency {
  return String(country ?? '').toUpperCase() === 'US' ? 'USD' : 'INR';
}
/** Only for carrying credit across currencies (a plan switch); never for charging. */
export const INR_PER_USD = 84;
export function convertMinor(amountMinor: number, from: string, to: string): number {
  if (from === to) return amountMinor;
  return from === 'INR' ? Math.round(amountMinor / INR_PER_USD) : Math.round(amountMinor * INR_PER_USD);
}

// US list prices (cents), by package length. Admins can override per plan with
// priceUsd; a length with neither falls back to the rupee price converted.
const CAMPAIGN_USD_MINOR: Record<number, number> = { 10: 7900, 20: 12900, 30: 17900, 90: 44900 };
const FEATURED_USD_MINOR: Record<number, number> = { 30: 3900, 90: 9900 };

function usdMinorFor(p: { priceUsd?: unknown }, rupeesMinor: number, table: Record<number, number>, days: number): number {
  const own = toMinor(p.priceUsd);
  if (own != null) return own;
  if (table[days]) return table[days]!;
  // Whole dollars ending in 9, never below $9.
  return Math.max(900, Math.round(rupeesMinor / INR_PER_USD / 1000) * 1000 - 100);
}

function validDays(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d > 0;
}

export interface CampaignOption {
  durationDays: number;
  priceMinor: number;
  currency: Currency;
  label: string;
  recommended?: boolean;
}

// Marketing campaign packages (fallback defaults).
export const CAMPAIGN_OPTIONS: CampaignOption[] = [
  { durationDays: 10, priceMinor: 499900, currency: 'INR', label: '10 Days' },
  { durationDays: 20, priceMinor: 899900, currency: 'INR', label: '20 Days', recommended: true },
  { durationDays: 30, priceMinor: 1399900, currency: 'INR', label: '30 Days' },
  { durationDays: 90, priceMinor: 3499900, currency: 'INR', label: '3 Months' },
];

/** The packages in the buyer's currency. */
export function getCampaignOptions(goal?: string, currency: Currency = 'INR'): CampaignOption[] {
  const inr = getCampaignOptionsInr(goal);
  if (currency === 'INR') return inr;
  let plans: Array<{ durationDays?: number; priceUsd?: unknown; goal?: string }> = [];
  try { plans = getActiveGrowPlans().filter((p) => p.type === 'CAMPAIGN' && (!goal || p.goal === goal)); } catch { /* defaults */ }
  return inr.map((o) => {
    const plan = plans.find((p) => p.durationDays === o.durationDays) ?? {};
    return { ...o, currency: 'USD' as const, priceMinor: usdMinorFor(plan, o.priceMinor, CAMPAIGN_USD_MINOR, o.durationDays) };
  });
}

function getCampaignOptionsInr(goal?: string): CampaignOption[] {
  try {
    let activePlans = getActiveGrowPlans().filter((p) => p.type === 'CAMPAIGN');
    if (goal) {
      const goalMatched = activePlans.filter((p) => p.goal === goal);
      if (goalMatched.length > 0) activePlans = goalMatched;
    }
    if (activePlans.length > 0) {
      const optionsMap = new Map<number, CampaignOption>();
      for (const p of activePlans) {
        const priceMinor = toMinor(p.priceRupees);
        if (priceMinor == null || !validDays(p.durationDays)) continue;
        if (!optionsMap.has(p.durationDays)) {
          optionsMap.set(p.durationDays, {
            durationDays: p.durationDays,
            priceMinor,
            currency: 'INR',
            label: p.durationDays === 90 ? '3 Months' : `${p.durationDays} Days`,
            recommended: Boolean(p.recommended),
          });
        }
      }
      if (optionsMap.size > 0) {
        return Array.from(optionsMap.values()).sort((a, b) => a.durationDays - b.durationDays);
      }
    }
  } catch {
    // fallback if uninitialized
  }
  return CAMPAIGN_OPTIONS;
}

export const CAMPAIGN_GOALS: { value: CampaignGoal; label: string }[] = [
  { value: 'WHATSAPP_ENQUIRIES', label: 'Get WhatsApp Enquiries' },
  { value: 'WEBSITE_LEADS', label: 'Get Website Leads' },
  { value: 'PROFILE_VISITS', label: 'Get Profile Visits' },
];

/** Human label for a CampaignGoal enum value — never show the raw enum. */
export function campaignGoalLabel(goal: string): string {
  return CAMPAIGN_GOALS.find((g) => g.value === goal)?.label ?? goal;
}

/**
 * The package a vendor is charged for. Pass the campaign goal: admins can price
 * the same duration differently per goal, and the dashboard shows the goal's
 * price — resolving without it charged the first goal's price instead.
 */
export function campaignOptionFor(durationDays: number, goal?: string, currency: Currency = 'INR'): CampaignOption | undefined {
  return getCampaignOptions(goal, currency).find((o) => o.durationDays === durationDays);
}

// Featured Listing packages — boosts one claimed listing to the top of its
// city + category pages.
export interface FeaturedOption {
  durationDays: number;
  priceMinor: number;
  currency: Currency;
  label: string;
  recommended?: boolean;
}

export const FEATURED_OPTIONS: FeaturedOption[] = [
  { durationDays: 30, priceMinor: 249900, currency: 'INR', label: '30 Days', recommended: true },
  { durationDays: 90, priceMinor: 599900, currency: 'INR', label: '90 Days' },
];

/** The Featured packages in the buyer's currency. */
export function getFeaturedOptions(currency: Currency = 'INR'): FeaturedOption[] {
  const inr = getFeaturedOptionsInr();
  if (currency === 'INR') return inr;
  let plans: Array<{ durationDays?: number; priceUsd?: unknown }> = [];
  try { plans = getActiveGrowPlans().filter((p) => p.type === 'FEATURED'); } catch { /* defaults */ }
  return inr.map((o) => {
    const plan = plans.find((p) => p.durationDays === o.durationDays) ?? {};
    return { ...o, currency: 'USD' as const, priceMinor: usdMinorFor(plan, o.priceMinor, FEATURED_USD_MINOR, o.durationDays) };
  });
}

function getFeaturedOptionsInr(): FeaturedOption[] {
  try {
    const activePlans = getActiveGrowPlans().filter((p) => p.type === 'FEATURED');
    if (activePlans.length > 0) {
      const optionsMap = new Map<number, FeaturedOption>();
      for (const p of activePlans) {
        const priceMinor = toMinor(p.priceRupees);
        if (priceMinor == null || !validDays(p.durationDays)) continue;
        if (!optionsMap.has(p.durationDays)) {
          optionsMap.set(p.durationDays, {
            durationDays: p.durationDays,
            priceMinor,
            currency: 'INR',
            label: `${p.durationDays} Days`,
            recommended: Boolean(p.recommended),
          });
        }
      }
      if (optionsMap.size > 0) {
        return Array.from(optionsMap.values()).sort((a, b) => a.durationDays - b.durationDays);
      }
    }
  } catch {
    // fallback if uninitialized
  }
  return FEATURED_OPTIONS;
}

export function featuredOptionFor(durationDays: number, currency: Currency = 'INR'): FeaturedOption | undefined {
  return getFeaturedOptions(currency).find((o) => o.durationDays === durationDays);
}

/** A grow plan as the dashboard shows it: its price in the buyer's currency. */
export function growPlanPriceUsd(p: { type?: string; durationDays?: number; priceRupees?: unknown; priceUsd?: unknown }): number {
  const rupeesMinor = toMinor(p.priceRupees) ?? 0;
  const table = p.type === 'FEATURED' ? FEATURED_USD_MINOR : CAMPAIGN_USD_MINOR;
  return usdMinorFor(p, rupeesMinor, table, Number(p.durationDays) || 0) / 100;
}

// Business plan list prices in dollars, by tier (monthly tiers; Diamond is
// sold yearly). An admin-set priceUsd on the plan wins.
const VENDOR_PLAN_USD: Record<string, number> = { SILVER: 39, GOLD: 79, DIAMOND: 399 };

/** A business plan's US price in whole dollars (0 for the free tier). */
export function vendorPlanPriceUsd(p: { tier?: unknown; priceRupees?: unknown; priceUsd?: unknown }): number {
  const own = Number(p.priceUsd);
  if (p.priceUsd != null && p.priceUsd !== '' && Number.isFinite(own) && own >= 0) return own;
  const rupees = Number(p.priceRupees) || 0;
  if (rupees <= 0) return 0;
  const byTier = VENDOR_PLAN_USD[String(p.tier ?? '').toUpperCase()];
  if (byTier) return byTier;
  return Math.max(9, Math.round(rupees / INR_PER_USD / 10) * 10 - 1);
}
