// Seed default membership plans. Idempotent — upserts by sku.
// Run: npm run seed:plans

import { prisma } from '../src/db.js';

const PLANS = [
  // ---- BRONZE ----
  {
    sku: 'bronze_monthly',
    tier: 'BRONZE' as const,
    billingPeriod: 'MONTHLY' as const,
    name: 'Bronze · Monthly',
    tagline: 'Member-only deals + priority WhatsApp support',
    perks: [
      'Up to 10% off at 500+ verified vendors',
      'Priority WhatsApp support within 1 hour',
      'Save up to 5 pet profiles',
      'Cancel anytime',
    ],
    priceMinor: 9900,       // ₹99
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
      '₹198 saved vs monthly (2 free months)',
      'First-look on new vendor partner deals',
    ],
    priceMinor: 99000,      // ₹990
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
    tagline: '1 free vet consult + 20% off treatments',
    perks: [
      'Everything in Bronze',
      'Up to 20% off vet treatments',
      '1 free virtual vet consult per month',
      'Free pet vaccination reminder via WhatsApp',
      'Member-only event entry',
    ],
    priceMinor: 24900,      // ₹249
    currency: 'INR',
    durationDays: 30,
    sortOrder: 30,
  },
  {
    sku: 'silver_annual',
    tier: 'SILVER' as const,
    billingPeriod: 'ANNUAL' as const,
    name: 'Silver · Annual',
    tagline: 'Most popular · 2 months free',
    perks: [
      'Everything in Silver Monthly',
      '12 free virtual vet consults / year',
      'Free Pets24x7 swag pack',
    ],
    priceMinor: 249000,     // ₹2,490
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
    tagline: 'Emergency pet care + concierge support',
    perks: [
      'Everything in Silver',
      'Up to 30% off vet treatments',
      'Unlimited virtual vet consults',
      '24x7 emergency vet helpline',
      'Free home pet pickup-and-drop for vet visits (1/mo)',
    ],
    priceMinor: 49900,      // ₹499
    currency: 'INR',
    durationDays: 30,
    sortOrder: 50,
  },
  {
    sku: 'gold_annual',
    tier: 'GOLD' as const,
    billingPeriod: 'ANNUAL' as const,
    name: 'Gold · Annual',
    tagline: 'Premium · best value · 2 months free',
    perks: [
      'Everything in Gold Monthly',
      '12 free pet taxi rides / year',
      'Dedicated WhatsApp pet-care advisor',
      'Free annual vet check-up',
    ],
    priceMinor: 499000,     // ₹4,990
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
