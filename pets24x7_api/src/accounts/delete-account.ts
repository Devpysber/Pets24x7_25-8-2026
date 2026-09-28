// Deleting a pet parent or a business account — one implementation for the
// admin panel and for people deleting their own account (a Google Play
// requirement: in the app and on the web, /delete-account/).
//
// A full copy goes to Recently deleted first, so a mistaken delete can be
// restored by an admin within 180 days.
//
// Pet parent: pets, saved businesses, memberships and sign-in tokens go with
// the account. Enquiries, reviews and payments are business records and stay,
// with the link to the account cleared.
//
// Business: services, campaigns, Featured slots, reviews, review requests and
// claims go with it. Payments stay, unhooked from the campaign / Featured slot.

import { prisma } from '../db.js';
import { saveTrash, snapshotParent, snapshotVendor } from '../trash/trash.js';

type By = { role: string; id: string };

export async function deleteParentAccount(id: string, by: By) {
  const parent = await prisma.petParent.findUnique({ where: { id }, select: { id: true, name: true, email: true, phone: true } });
  if (!parent) return null;

  const snap = await snapshotParent(id);
  if (snap) await saveTrash('parent', id, [parent.name, parent.email ?? parent.phone].filter(Boolean).join(' · '), snap, by);

  const memberships = await prisma.membership.findMany({ where: { parentId: id }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    await tx.enquiry.updateMany({ where: { petParentId: id }, data: { petParentId: null } });
    if (memberships.length) {
      await tx.payment.updateMany({ where: { membershipId: { in: memberships.map((m) => m.id) } }, data: { membershipId: null } });
    }
    await tx.payment.updateMany({ where: { parentId: id }, data: { parentId: null } });
    await tx.petParent.delete({ where: { id } });
  });
  return parent;
}

export async function deleteVendorAccount(id: string, by: By) {
  const vendor = await prisma.vendor.findUnique({
    where: { id },
    select: { id: true, businessName: true, email: true, phone: true, listingId: true },
  });
  if (!vendor) return null;

  const snap = await snapshotVendor(id);
  if (snap) await saveTrash('vendor', id, vendor.businessName || id, snap, by);

  const [campaigns, featured] = await Promise.all([
    prisma.marketingCampaign.findMany({ where: { vendorId: id }, select: { id: true } }),
    prisma.featuredListing.findMany({ where: { vendorId: id }, select: { id: true } }),
  ]);
  await prisma.$transaction(async (tx) => {
    if (campaigns.length) {
      await tx.payment.updateMany({ where: { campaignId: { in: campaigns.map((c) => c.id) } }, data: { campaignId: null } });
    }
    if (featured.length) {
      await tx.payment.updateMany({ where: { featuredListingId: { in: featured.map((f) => f.id) } }, data: { featuredListingId: null } });
    }
    await tx.vendor.delete({ where: { id } });
  });
  return vendor;
}
