// Recently deleted: snapshot before every delete, restore on request.
//
// Each delete path calls snapshot*() and saveTrash() before removing anything.
// The snapshot holds the record, every row that goes with it (cascade), and
// the links the delete unhooks (payments, enquiries, reviews), so restore()
// can put the whole thing back as it was. Nothing here deletes; the callers
// keep their own delete logic.

import { Prisma } from '@prisma/client';

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { addAndPersistImportedListing, getListingById } from '../listings/index.js';

export type TrashKind = 'parent' | 'vendor' | 'listing' | 'listing_photo' | 'deal' | 'event' | 'pet' | 'service';

export const TRASH_LABEL: Record<TrashKind, string> = {
  parent: 'Pet parent',
  vendor: 'Business account',
  listing: 'Directory listing',
  listing_photo: 'Listing photo',
  deal: 'Deal',
  event: 'Event',
  pet: 'Pet',
  service: 'Service',
};

type Row = Record<string, unknown>;

/** JSON round-trip: Dates become ISO strings, which Prisma accepts back. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

// Optional Json columns cannot be written back as a bare null.
const jsonFields = new Map<string, Set<string>>();
for (const m of Prisma.dmmf.datamodel.models) {
  jsonFields.set(m.name, new Set(m.fields.filter((f) => f.type === 'Json').map((f) => f.name)));
}
function prep(model: string, row: Row): Row {
  const out: Row = { ...row };
  for (const f of jsonFields.get(model) ?? []) if (out[f] === null) out[f] = Prisma.DbNull;
  return out;
}
const prepAll = (model: string, rows: Row[] | undefined) => (rows ?? []).map((r) => prep(model, r));

export async function saveTrash(
  kind: TrashKind,
  recordId: string,
  label: string,
  snapshot: unknown,
  by: { role: string; id: string } | null,
): Promise<string> {
  const row = await prisma.deletedRecord.create({
    data: {
      kind,
      recordId: recordId.slice(0, 191),
      label: (label || recordId).slice(0, 255),
      snapshot: plain(snapshot) as Prisma.InputJsonValue,
      deletedByRole: by?.role ?? null,
      deletedById: by?.id ?? null,
    },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function snapshotParent(id: string) {
  const parent = await prisma.petParent.findUnique({ where: { id } });
  if (!parent) return null;
  const memberships = await prisma.membership.findMany({ where: { parentId: id } });
  const [pets, saved, reviews, enquiries, payments] = await Promise.all([
    prisma.pet.findMany({ where: { ownerId: id } }),
    prisma.savedListing.findMany({ where: { parentId: id } }),
    prisma.review.findMany({ where: { parentId: id }, select: { id: true } }),
    prisma.enquiry.findMany({ where: { petParentId: id }, select: { id: true } }),
    prisma.payment.findMany({
      where: { OR: [{ parentId: id }, { membershipId: { in: memberships.map((m) => m.id) } }] },
      select: { id: true, parentId: true, membershipId: true },
    }),
  ]);
  return plain({
    parent, pets, saved, memberships,
    reviewIds: reviews.map((r) => r.id),
    enquiryIds: enquiries.map((e) => e.id),
    paymentLinks: payments,
  });
}

export async function snapshotVendor(id: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) return null;
  const [claims, reviewRequests, reviews, services, campaigns, featured, deals, events, sub] = await Promise.all([
    prisma.listingClaim.findMany({ where: { ownerId: id } }),
    prisma.reviewRequest.findMany({ where: { vendorId: id } }),
    prisma.review.findMany({ where: { vendorId: id } }),
    prisma.service.findMany({ where: { vendorId: id } }),
    prisma.marketingCampaign.findMany({ where: { vendorId: id } }),
    prisma.featuredListing.findMany({ where: { vendorId: id } }),
    prisma.deal.findMany({ where: { vendorId: id }, select: { id: true } }),
    prisma.event.findMany({ where: { vendorId: id }, select: { id: true } }),
    prisma.setting.findUnique({ where: { key: 'vendor_sub:' + id } }),
  ]);
  const payments = await prisma.payment.findMany({
    where: {
      OR: [
        { campaignId: { in: campaigns.map((c) => c.id) } },
        { featuredListingId: { in: featured.map((f) => f.id) } },
      ],
    },
    select: { id: true, campaignId: true, featuredListingId: true },
  });
  return plain({
    vendor, claims, reviewRequests, reviews, services, campaigns, featured,
    dealIds: deals.map((d) => d.id), eventIds: events.map((e) => e.id),
    subscription: sub?.value ?? null,
    paymentLinks: payments,
  });
}

const ACTIVITY_CAP = 20_000;

export async function snapshotListing(id: string) {
  const listing = await prisma.listing.findUnique({ where: { id } });
  if (!listing) return null;
  const [activity, reviews, vendor, featured] = await Promise.all([
    prisma.listingActivity.findMany({ where: { listingId: id }, take: ACTIVITY_CAP, orderBy: { createdAt: 'desc' } }),
    prisma.review.findMany({
      where: { listingId: id, vendorId: null, status: { in: ['PENDING', 'PUBLISHED'] } },
      select: { id: true, status: true, moderatedBy: true, moderatedAt: true, moderationReason: true },
    }),
    prisma.vendor.findUnique({ where: { listingId: id }, select: { id: true } }),
    prisma.featuredListing.findMany({
      where: { listingId: id, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
      select: { id: true, status: true },
    }),
  ]);
  return plain({ listing, record: getListingById(id) ?? null, activity, reviews, vendorId: vendor?.id ?? null, featured });
}

export async function snapshotPhotos(listingId: string, removedIndex: number) {
  const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { photos: true, name: true } });
  if (!l) return null;
  return plain({ listingId, photos: l.photos ?? null, removedIndex });
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export class RestoreConflict extends Error {}

function conflictMessage(err: unknown, what: string): never {
  const code = (err as { code?: string })?.code;
  if (code === 'P2002') {
    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    throw new RestoreConflict(`${what} cannot come back: another record now uses the same ${String(target ?? 'unique value')}. Remove or change that one first.`);
  }
  throw err;
}

async function restoreParent(s: any) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.petParent.create({ data: prep('PetParent', s.parent) as any });
      if (s.pets?.length) await tx.pet.createMany({ data: prepAll('Pet', s.pets) as any });
      if (s.saved?.length) await tx.savedListing.createMany({ data: prepAll('SavedListing', s.saved) as any, skipDuplicates: true });
      if (s.memberships?.length) await tx.membership.createMany({ data: prepAll('Membership', s.memberships) as any });
      const id = s.parent.id as string;
      if (s.reviewIds?.length) await tx.review.updateMany({ where: { id: { in: s.reviewIds }, parentId: null }, data: { parentId: id } });
      if (s.enquiryIds?.length) await tx.enquiry.updateMany({ where: { id: { in: s.enquiryIds }, petParentId: null }, data: { petParentId: id } });
      for (const p of s.paymentLinks ?? []) {
        await tx.payment.updateMany({ where: { id: p.id }, data: { parentId: p.parentId, membershipId: p.membershipId } });
      }
    });
  } catch (err) {
    conflictMessage(err, 'This pet parent');
  }
}

async function restoreVendor(s: any) {
  const v = { ...s.vendor };
  // Someone else may have claimed the listing since.
  if (v.listingId) {
    const taken = await prisma.vendor.findUnique({ where: { listingId: v.listingId }, select: { id: true } });
    if (taken) v.listingId = null;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.vendor.create({ data: prep('Vendor', v) as any });
      if (s.claims?.length) await tx.listingClaim.createMany({ data: prepAll('ListingClaim', s.claims) as any });
      if (s.services?.length) await tx.service.createMany({ data: prepAll('Service', s.services) as any });
      if (s.campaigns?.length) await tx.marketingCampaign.createMany({ data: prepAll('MarketingCampaign', s.campaigns) as any });
      if (s.featured?.length) await tx.featuredListing.createMany({ data: prepAll('FeaturedListing', s.featured) as any });
      if (s.reviewRequests?.length) await tx.reviewRequest.createMany({ data: prepAll('ReviewRequest', s.reviewRequests) as any });
      if (s.reviews?.length) await tx.review.createMany({ data: prepAll('Review', s.reviews) as any });
      const id = v.id as string;
      if (s.dealIds?.length) await tx.deal.updateMany({ where: { id: { in: s.dealIds }, vendorId: null }, data: { vendorId: id } });
      if (s.eventIds?.length) await tx.event.updateMany({ where: { id: { in: s.eventIds }, vendorId: null }, data: { vendorId: id } });
      for (const p of s.paymentLinks ?? []) {
        await tx.payment.updateMany({ where: { id: p.id }, data: { campaignId: p.campaignId, featuredListingId: p.featuredListingId } });
      }
      if (s.subscription) {
        await tx.setting.upsert({
          where: { key: 'vendor_sub:' + id },
          update: { value: s.subscription },
          create: { key: 'vendor_sub:' + id, value: s.subscription },
        });
      }
    });
  } catch (err) {
    conflictMessage(err, 'This business account');
  }
}

async function restoreListing(s: any) {
  const exists = await prisma.listing.findUnique({ where: { id: s.listing.id }, select: { id: true } });
  if (exists) throw new RestoreConflict('A listing with this id already exists.');
  if (s.record) await addAndPersistImportedListing(s.record);
  const { id, ...rest } = prep('Listing', s.listing);
  await prisma.listing.upsert({ where: { id: id as string }, update: rest as any, create: prep('Listing', s.listing) as any });
  const act = prepAll('ListingActivity', s.activity);
  for (let i = 0; i < act.length; i += 1000) {
    await prisma.listingActivity.createMany({ data: act.slice(i, i + 1000) as any, skipDuplicates: true });
  }
  // Reviews the delete took out of circulation go back to what they were.
  for (const r of s.reviews ?? []) {
    await prisma.review.updateMany({
      where: { id: r.id, moderationReason: 'The listing was deleted.' },
      data: { status: r.status, moderatedBy: r.moderatedBy, moderatedAt: r.moderatedAt, moderationReason: r.moderationReason },
    });
  }
  if (s.vendorId) {
    await prisma.vendor.updateMany({ where: { id: s.vendorId, listingId: null }, data: { listingId: id as string } });
  }
  for (const f of s.featured ?? []) {
    await prisma.featuredListing.updateMany({
      where: { id: f.id, status: 'CANCELLED', OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      data: { status: f.status },
    });
  }
}

async function restoreSimple(model: 'deal' | 'event' | 'pet' | 'service', row: Row) {
  const name = { deal: 'Deal', event: 'Event', pet: 'Pet', service: 'Service' }[model];
  try {
    await (prisma[model] as any).create({ data: prep(name, row) });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2003') throw new RestoreConflict(`The ${model === 'pet' ? 'pet parent' : 'business'} this ${model} belonged to no longer exists. Restore that first.`);
    conflictMessage(err, 'This ' + model);
  }
}

export async function restoreTrash(trashId: string, adminId: string): Promise<{ kind: string; recordId: string; label: string }> {
  const t = await prisma.deletedRecord.findUnique({ where: { id: trashId } });
  if (!t) throw new RestoreConflict('Nothing to restore: that entry was not found.');
  if (t.restoredAt) throw new RestoreConflict('This was already restored.');
  const s = t.snapshot as any;
  switch (t.kind as TrashKind) {
    case 'parent': await restoreParent(s); break;
    case 'vendor': await restoreVendor(s); break;
    case 'listing': await restoreListing(s); break;
    case 'listing_photo': {
      const l = await prisma.listing.findUnique({ where: { id: s.listingId }, select: { id: true } });
      if (!l) throw new RestoreConflict('The listing this photo belonged to no longer exists. Restore the listing first.');
      await prisma.listing.update({ where: { id: s.listingId }, data: { photos: s.photos ?? Prisma.DbNull } });
      break;
    }
    case 'deal': await restoreSimple('deal', s.row); break;
    case 'event': await restoreSimple('event', s.row); break;
    case 'pet': await restoreSimple('pet', s.row); break;
    case 'service': await restoreSimple('service', s.row); break;
    default: throw new RestoreConflict('Unknown record type.');
  }
  await prisma.deletedRecord.update({ where: { id: t.id }, data: { restoredAt: new Date(), restoredBy: adminId } });
  logger.info({ kind: t.kind, recordId: t.recordId }, 'deleted record restored');
  return { kind: t.kind, recordId: t.recordId, label: t.label };
}

/** Deleted entries older than this are purged daily. */
const RETAIN_DAYS = 180;
export function startTrashPrune(): void {
  const run = () =>
    prisma.deletedRecord
      .deleteMany({ where: { deletedAt: { lt: new Date(Date.now() - RETAIN_DAYS * 86_400_000) } } })
      .catch((err) => logger.warn({ err }, 'trash prune failed'));
  setTimeout(run, 90_000).unref?.();
  setInterval(run, 24 * 3_600_000).unref?.();
}
