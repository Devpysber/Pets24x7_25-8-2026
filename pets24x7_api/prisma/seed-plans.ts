// Seed default membership plans. Idempotent — upserts by sku.
// Run: npm run seed:plans

import { prisma } from '../src/db.js';

import { DEFAULT_PLANS as PLANS } from '../src/payments/default-plans.js';

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
