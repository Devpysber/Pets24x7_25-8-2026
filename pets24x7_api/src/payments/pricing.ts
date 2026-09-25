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

function validDays(d: unknown): d is number {
  return typeof d === 'number' && Number.isInteger(d) && d > 0;
}

export interface CampaignOption {
  durationDays: number;
  priceMinor: number;
  label: string;
  recommended?: boolean;
}

// Marketing campaign packages (fallback defaults).
export const CAMPAIGN_OPTIONS: CampaignOption[] = [
  { durationDays: 10, priceMinor: 499900, label: '10 Days' },
  { durationDays: 20, priceMinor: 899900, label: '20 Days', recommended: true },
  { durationDays: 30, priceMinor: 1399900, label: '30 Days' },
  { durationDays: 90, priceMinor: 3499900, label: '3 Months' },
];

export function getCampaignOptions(goal?: string): CampaignOption[] {
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
export function campaignOptionFor(durationDays: number, goal?: string): CampaignOption | undefined {
  return getCampaignOptions(goal).find((o) => o.durationDays === durationDays);
}

// Featured Listing packages — boosts one claimed listing to the top of its
// city + category pages.
export interface FeaturedOption {
  durationDays: number;
  priceMinor: number;
  label: string;
  recommended?: boolean;
}

export const FEATURED_OPTIONS: FeaturedOption[] = [
  { durationDays: 30, priceMinor: 249900, label: '30 Days', recommended: true },
  { durationDays: 90, priceMinor: 599900, label: '90 Days' },
];

export function getFeaturedOptions(): FeaturedOption[] {
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

export function featuredOptionFor(durationDays: number): FeaturedOption | undefined {
  return getFeaturedOptions().find((o) => o.durationDays === durationDays);
}
