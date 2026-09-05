import type { CampaignGoal } from '@prisma/client';
import { getActiveGrowPlans } from '../admin/admin.api.routes.js';

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
        if (!optionsMap.has(p.durationDays)) {
          optionsMap.set(p.durationDays, {
            durationDays: p.durationDays,
            priceMinor: p.priceRupees * 100,
            label: p.durationDays === 90 ? '3 Months' : `${p.durationDays} Days`,
            recommended: Boolean(p.recommended),
          });
        }
      }
      return Array.from(optionsMap.values()).sort((a, b) => a.durationDays - b.durationDays);
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

export function campaignOptionFor(durationDays: number): CampaignOption | undefined {
  return getCampaignOptions().find((o) => o.durationDays === durationDays);
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
        if (!optionsMap.has(p.durationDays)) {
          optionsMap.set(p.durationDays, {
            durationDays: p.durationDays,
            priceMinor: p.priceRupees * 100,
            label: p.durationDays === 90 ? '90 Days' : `${p.durationDays} Days`,
            recommended: Boolean(p.recommended),
          });
        }
      }
      return Array.from(optionsMap.values()).sort((a, b) => a.durationDays - b.durationDays);
    }
  } catch {
    // fallback if uninitialized
  }
  return FEATURED_OPTIONS;
}

export function featuredOptionFor(durationDays: number): FeaturedOption | undefined {
  return getFeaturedOptions().find((o) => o.durationDays === durationDays);
}
