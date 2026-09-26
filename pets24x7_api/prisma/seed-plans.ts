// Seed default membership plans. Idempotent — upserts by sku.
// Run: npm run seed:plans

import { prisma } from '../src/db.js';

// Every perk is something the Pets24x7 team delivers itself. The old list
// promised partner discounts ("up to 30% off at 500+ vendors"), free vet
// consults and a 24x7 vet helpline, none of which existed; discountPercent
// stays 0 until real partner deals are signed.
const PLANS = [
  // ---- BRONZE ----
  {
    sku: 'bronze_monthly',
    tier: 'BRONZE' as const,
    billingPeriod: 'MONTHLY' as const,
    name: 'Bronze · Monthly',
    tagline: 'Priority help finding the right pet service',
    perks: [
      'Tell us what you need on WhatsApp; we shortlist providers near you',
      'Your enquiries handled ahead of non-members',
      'Pet profiles and vaccination dates in your dashboard',
      'Cancel anytime',
    ],
    priceMinor: 9900,       // ₹99
    discountPercent: 0,
    currency: 'INR',
    durationDays: 30,
    sortOrder: 10,
  },
  {
    sku: 'bronze_annual',
    tier: 'BRONZE' as const,
    billingPeriod: 'ANNUAL' as const,
    name: 'Bronze · Annual',
    tagline: '2 months free vs monthly',
    perks: [
      'Everything in Bronze Monthly',
      '₹198 saved vs paying monthly',
    ],
    priceMinor: 99000,      // ₹990
    discountPercent: 0,
    currency: 'INR',
    durationDays: 365,
    sortOrder: 20,
  },

  // ---- SILVER ----
  {
    sku: 'silver_monthly',
    tier: 'SILVER' as const,
    billingPeriod: 'MONTHLY' as const,
    name: 'Silver · Monthly',
    tagline: 'A pet-care concierge on WhatsApp',
    perks: [
      'Everything in Bronze',
      'We check availability and prices for you',
      'We book the appointment and confirm it with you',
      'Follow-up after the visit if anything goes wrong',
    ],
    priceMinor: 24900,      // ₹249
    discountPercent: 0,
    currency: 'INR',
    durationDays: 30,
    sortOrder: 30,
  },
  {
    sku: 'silver_annual',
    tier: 'SILVER' as const,
    billingPeriod: 'ANNUAL' as const,
    name: 'Silver · Annual',
    tagline: '2 months free vs monthly',
    perks: [
      'Everything in Silver Monthly',
      '₹498 saved vs paying monthly',
    ],
    priceMinor: 249000,     // ₹2,490
    discountPercent: 0,
    currency: 'INR',
    durationDays: 365,
    sortOrder: 40,
  },

  // ---- GOLD ----
  {
    sku: 'gold_monthly',
    tier: 'GOLD' as const,
    billingPeriod: 'MONTHLY' as const,
    name: 'Gold · Monthly',
    tagline: 'Priority concierge for busy pet parents',
    perks: [
      'Everything in Silver',
      'Same-day priority for urgent requests',
      'We coordinate vet, grooming and boarding visits end to end',
      'One named Pets24x7 contact for all your requests',
    ],
    priceMinor: 49900,      // ₹499
    discountPercent: 0,
    currency: 'INR',
    durationDays: 30,
    sortOrder: 50,
  },
  {
    sku: 'gold_annual',
    tier: 'GOLD' as const,
    billingPeriod: 'ANNUAL' as const,
    name: 'Gold · Annual',
    tagline: '2 months free vs monthly',
    perks: [
      'Everything in Gold Monthly',
      '₹998 saved vs paying monthly',
    ],
    priceMinor: 499000,     // ₹4,990
    discountPercent: 0,
    currency: 'INR',
    durationDays: 365,
    sortOrder: 60,
  },
];

async function main() {
  for (const p of PLANS) {
    const plan = await prisma.membershipPlan.upsert({
      where: { sku: p.sku },
      update: { ...p, perks: p.perks as any, active: true },
      create: { ...p, perks: p.perks as any, active: true },
    });
    console.log(`[seed-plans] ${plan.sku.padEnd(18)} · ₹${(plan.priceMinor / 100).toFixed(0).padStart(5)}  (${plan.durationDays}d)  ${plan.active ? '✓' : '✗'}`);
  }
  console.log(`[seed-plans] done · ${PLANS.length} plans upserted`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
