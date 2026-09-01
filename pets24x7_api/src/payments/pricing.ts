// Central price book for non-membership vendor purchases.
// Prices are in the smallest currency unit (paise). INR only for now.

import type { CampaignGoal } from '@prisma/client';

export interface CampaignOption {
  durationDays: number;
  priceMinor: number;
  label: string;
}

// Marketing campaign packages (mirrors the pricing shown on marketing.html).
export const CAMPAIGN_OPTIONS: CampaignOption[] = [
  { durationDays: 10, priceMinor: 499900, label: '10 Days' },
  { durationDays: 20, priceMinor: 899900, label: '20 Days' },
  { durationDays: 30, priceMinor: 1399900, label: '30 Days' },
  { durationDays: 90, priceMinor: 3499900, label: '3 Months' },
];

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
  return CAMPAIGN_OPTIONS.find((o) => o.durationDays === durationDays);
}

// Featured Listing packages — boosts one claimed listing to the top of its
// city + category pages.
export interface FeaturedOption {
  durationDays: number;
  priceMinor: number;
  label: string;
}

export const FEATURED_OPTIONS: FeaturedOption[] = [
  { durationDays: 30, priceMinor: 249900, label: '30 Days' },
  { durationDays: 90, priceMinor: 599900, label: '90 Days' },
];

export function featuredOptionFor(durationDays: number): FeaturedOption | undefined {
  return FEATURED_OPTIONS.find((o) => o.durationDays === durationDays);
}
