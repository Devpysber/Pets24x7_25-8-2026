// The Featured placement that Gold and Diamond plans include.
//
// activatePaidPlan used to record the plan and stop there, so the "free
// Featured slot" on the plan card was never delivered. This creates (or
// extends) one complimentary ACTIVE FeaturedListing (priceMinor 0) that runs
// to the end of the paid term; the expiry sweep ends it like any other slot.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getListingById } from '../listings/index.js';

function slugOf(value: string | null | undefined): string | null {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return s || null;
}

export async function grantPlanFeatured(vendorId: string, endsAt: Date): Promise<'created' | 'extended' | 'skipped'> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { listingId: true, city: true, category: true },
  });
  if (!vendor?.listingId) return 'skipped';

  // An earlier complimentary slot still running is stretched, not doubled.
  const existing = await prisma.featuredListing.findFirst({
    where: { vendorId, status: 'ACTIVE', priceMinor: 0 },
    orderBy: { endsAt: 'desc' },
  });
  if (existing) {
    if (!existing.endsAt || existing.endsAt < endsAt) {
      await prisma.featuredListing.update({ where: { id: existing.id }, data: { endsAt } });
      return 'extended';
    }
    return 'skipped';
  }

  const listing = getListingById(vendor.listingId);
  const now = new Date();
  await prisma.featuredListing.create({
    data: {
      vendorId,
      listingId: vendor.listingId,
      city: listing?.city ?? vendor.city ?? null,
      citySlug: listing?.city_slug ?? slugOf(listing?.city ?? vendor.city),
      category: listing?.category ?? vendor.category ?? null,
      categorySlug: listing?.category_slug ?? slugOf(listing?.category ?? vendor.category),
      priceMinor: 0,
      currency: 'INR',
      durationDays: Math.max(1, Math.round((endsAt.getTime() - now.getTime()) / 86_400_000)),
      status: 'ACTIVE',
      startsAt: now,
      endsAt,
    },
  });
  logger.info({ vendorId, endsAt }, 'plan featured slot granted');
  return 'created';
}

/** Ends the complimentary placement when the plan behind it is expired or cancelled early. */
export async function endPlanFeatured(vendorId: string): Promise<number> {
  const { count } = await prisma.featuredListing.updateMany({
    where: { vendorId, status: 'ACTIVE', priceMinor: 0 },
    data: { status: 'EXPIRED', endsAt: new Date() },
  });
  if (count) logger.info({ vendorId, count }, 'plan featured slot ended with the plan');
  return count;
}
