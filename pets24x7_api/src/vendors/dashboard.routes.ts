// Vendor dashboard — claimed listing + profile completion checklist.
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { setAuthCookie } from '../auth/jwt.js';
import { revocationCutoff } from '../auth/actor.js';
import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { addAndPersistImportedListing, findListingByPhone, getListingById, ownerListing, type ListingRecord } from '../listings/index.js';
import bcrypt from 'bcrypt';
import { notifyIf } from '../mail/notify.js';
import {
  VENDOR_VERIFY_TTL_MIN,
  sendVendorVerificationEmail,
} from '../auth/vendor-email-verification.js';
import { enquiryStatusEmail, vendorProfileUpdatedEmail } from '../mail/action-templates.js';
import { vendorPhotosUpdatedEmail } from '../mail/lifecycle-templates.js';
import { isVendorApproved } from '../shared/vendor-status.js';
import { invalidateVendorInsights } from '../feed/reco/vendor-insights.js';
import { normalizePhone } from '../shared/phone.js';
import { vendorReviewScope } from '../reviews/vendor.routes.js';
import { profileCompletion } from './profile-completion.js';
import type { Prisma, Vendor } from '@prisma/client';

// The forms send '' for an empty field while the database holds null; treat
// both as "no value" so a first save does not report untouched fields.
const orNull = (x: unknown) => (x === '' || x === undefined ? null : x);

export const vendorDashboardRouter = Router();

vendorDashboardRouter.use(requireAuth('vendor'));

/**
 * Which enquiries a vendor may see and act on. Always its claimed listing id.
 * The business-name fallback (for enquiries sent from the parent dashboard
 * without an id) is narrowed to rows with no listingId at all, and never a
 * marketing-page lead — whose listingName is the sender's own business. Before,
 * any vendor whose name matched another listing's (dozens of "Government
 * Veterinary Hospital"s), or who renamed itself to match, read and updated
 * that listing's leads, customer phone numbers included.
 */
function enquiryScope(v: { listingId: string | null; businessName: string | null } | null): Prisma.EnquiryWhereInput | null {
  if (!v?.listingId) return null;
  const or: Prisma.EnquiryWhereInput[] = [{ listingId: v.listingId }];
  if (v.businessName) {
    or.push({
      listingId: null,
      listingName: v.businessName,
      OR: [{ source: null }, { NOT: { source: { startsWith: 'marketing' } } }],
    });
  }
  return { OR: or };
}

/**
 * Images reach public pages and other dashboards as <img src>, and some of
 * those still build markup by string. Accept only a hosted http(s) URL with no
 * markup characters, or a complete base64 image data URL — a prefix check alone
 * let anything follow the comma.
 */
const IMAGE_SRC =
  /^(?:https?:\/\/[^\s"'<>`]+|data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+)$/;
const imageSrc = z.string().max(600_000).regex(IMAGE_SRC, 'must be an image URL or image data URL');

vendorDashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    // No invented fallback: a DB failure is an error (500 with a request id),
    // and a missing row is a 404 — never another business's name and phone.
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    if (!v) throw new NotFoundError('Vendor account not found');

    const listing = v.listingId ? getListingById(v.listingId) : null;

    // Live rollups — reviews, review-request invites, campaigns, services.
    let reviewAgg = { total: 0, pending: 0, published: 0, average: null as number | null, recent: [] as any[] };
    let invites = { sent: 0, opened: 0, completed: 0, remaining: 50 };
    let campaigns: any[] = [];
    let serviceCount = 0;
    let hasCollectedReviews = false;

    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      // Includes reviews left on the listing before it was claimed.
      const reviewWhere = await vendorReviewScope(v.id);
      const [total, pending, published, recent, sent, opened, completed, sentToday, camps, svc, avgAgg] =
        await Promise.all([
          prisma.review.count({ where: reviewWhere }),
          prisma.review.count({ where: { AND: [reviewWhere, { status: 'PENDING' }] } }),
          prisma.review.count({ where: { AND: [reviewWhere, { status: 'PUBLISHED' }] } }),
          // The dashboard's Reviews tab renders this list and nothing else, so
          // five meant a vendor could never see or reply to their sixth review.
          prisma.review.findMany({ where: reviewWhere, orderBy: { createdAt: 'desc' }, take: 100 }),
          prisma.reviewRequest.count({ where: { vendorId: v.id } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, openedAt: { not: null } } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, reviewSubmittedAt: { not: null } } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, sentAt: { gte: startOfDay } } }),
          prisma.marketingCampaign.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.service.count({ where: { vendorId: v.id } }),
          prisma.review.aggregate({ where: { AND: [reviewWhere, { status: 'PUBLISHED' }] }, _avg: { rating: true } }),
        ]);
      const avg = avgAgg._avg.rating;
      reviewAgg = { total, pending, published, average: avg != null ? Math.round(avg * 10) / 10 : null, recent };
      invites = { sent, opened, completed, remaining: Math.max(0, 50 - sentToday) };
      campaigns = camps;
      serviceCount = svc;
      hasCollectedReviews = total > 0;
    } catch {
      // DB offline — leave zeros
    }

    // Enquiry rollup for this vendor's claimed listing.
    let enquiryAgg = { total: 0, new: 0, responded: 0, completed: 0, archived: 0 };
    try {
      const where = enquiryScope(v);
      if (where) {
        const [t, n, r, c, a] = await Promise.all([
          prisma.enquiry.count({ where }),
          prisma.enquiry.count({ where: { AND: [where, { status: 'NEW' }] } }),
          prisma.enquiry.count({ where: { AND: [where, { status: 'RESPONDED' }] } }),
          prisma.enquiry.count({ where: { AND: [where, { status: 'COMPLETED' }] } }),
          prisma.enquiry.count({ where: { AND: [where, { status: 'ARCHIVED' }] } }),
        ]);
        enquiryAgg = { total: t, new: n, responded: r, completed: c, archived: a };
      }
    } catch {
      // DB offline
    }

    // Same function /api/reco/vendor uses, so both screens quote one number.
    const completion = profileCompletion({
      ...v,
      listingWebsite: listing?.website ?? null,
      serviceCount,
      hasReviews: hasCollectedReviews,
    });
    // The stored column (served by /api/me) is only a cache of this figure.
    if (v.profileCompletion !== completion.percent) {
      void prisma.vendor
        .update({ where: { id: v.id }, data: { profileCompletion: completion.percent } })
        .catch(() => {});
    }

    res.json({
      ok: true,
      vendor: {
        id: v.id,
        businessName: v.businessName,
        phone: v.phone,
        email: v.email,
        emailVerified: v.emailVerified,
        emailVerifiedAt: v.emailVerifiedAt,
        status: v.status,
        city: v.city,
        country: v.country,
        category: v.category,
        imageUrl: v.imageUrl ?? null,
        claimedAt: v.claimedAt,
        approvedAt: v.approvedAt,
      },
      listing: listing ? ownerListing(listing) : { id: v.listingId ?? 'unclaimed', name: v.businessName, city: v.city, category: v.category, rating: null, review_count: 0 },
      completion: { percent: completion.percent, checklist: completion.checklist },
      reviews: reviewAgg,
      enquiries: enquiryAgg,
      customerInvites: invites,
      campaigns,
      serviceCount,
    });
  }),
);

// `email` may only be *added* here, by an account that has none yet. Changing
// or removing an existing address is support-only (same policy as
// /my-business): it identifies the account and receives the sign-in codes, so
// a stolen session must not be able to move the account to another inbox.
const ProfileBody = z.object({
  businessName: z.string().min(2).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(160).optional().or(z.literal('')),
  category: z.string().min(2).max(80).optional(),
  // Small resized data: URL (client downsizes first). '' clears it.
  imageUrl: imageSrc.optional().or(z.literal('')),
});

vendorDashboardRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = ProfileBody.parse(req.body);
    const current = await prisma.vendor.findUnique({
      where: { id: req.auth!.sub },
      select: { email: true, businessName: true, category: true, imageUrl: true },
    });

    const data: Record<string, unknown> = {};
    if (body.businessName !== undefined) data.businessName = body.businessName;
    if (body.category !== undefined) data.category = body.category;
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl || null;

    // A new address is unproven — drop the verified flag and mail a fresh link,
    // so the old address's proof never carries over to a different one.
    const nextEmail = body.email === undefined ? undefined : body.email || null;
    const emailChanged = nextEmail !== undefined && nextEmail !== (current?.email ?? null);
    if (emailChanged && current?.email) {
      throw new ForbiddenError('To change your business email, contact support@pets24x7.com from the current address.');
    }
    if (nextEmail !== undefined) {
      data.email = nextEmail;
      if (emailChanged) {
        data.emailVerified = false;
        data.emailVerifiedAt = null;
      }
    }

    const v = await prisma.vendor.update({ where: { id: req.auth!.sub }, data });
    invalidateVendorInsights(v.id);

    if (emailChanged && v.email) {
      void sendVendorVerificationEmail({ id: v.id, businessName: v.businessName, email: v.email }).catch((err) => {
        req.log.warn({ err }, 'vendor email verification send failed');
      });
    }
    // Only fields whose value really moved — re-saving the same form used to
    // mail "your profile was updated" listing every field on it.
    const before = (current ?? {}) as Record<string, unknown>;
    const changed = Object.keys(data).filter(
      (k) => k !== 'emailVerified' && k !== 'emailVerifiedAt' && orNull(before[k]) !== orNull(data[k]),
    );
    if (changed.length > 0) {
      notifyIf(v.email, (to) => vendorProfileUpdatedEmail(to, v.businessName, changed, !isVendorApproved(v.status)));
    }
    // Name and category are shown on the public listing, which reads the
    // listing index — /my-business already pushed there, this route did not.
    if (changed.includes('businessName') || changed.includes('category')) {
      await syncVendorToListingIndex(v).catch((err) =>
        req.log.warn({ err }, 'listing index sync failed after vendor profile edit'),
      );
    }
    res.json({
      ok: true,
      vendor: {
        id: v.id,
        businessName: v.businessName,
        email: v.email,
        emailVerified: v.emailVerified,
        category: v.category,
        imageUrl: v.imageUrl,
      },
      verificationSent: emailChanged && Boolean(v.email),
    });
  }),
);

// Enquiries received for this vendor's claimed listing.
vendorDashboardRouter.get(
  '/enquiries',
  asyncHandler(async (req, res) => {
    const v = await prisma.vendor.findUnique({
      where: { id: req.auth!.sub },
      select: { listingId: true, businessName: true, status: true },
    });
    const where = enquiryScope(v);
    if (!where) return res.json({ ok: true, enquiries: [] });
    const enquiries = await prisma.enquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // Same gate as the new-enquiry notification: a pending or suspended account
    // sees that leads exist, not the customer's phone and email.
    if (!isVendorApproved(v?.status)) {
      return res.json({
        ok: true,
        contactHidden: true,
        enquiries: enquiries.map((e) => ({ ...e, phone: '', email: null })),
      });
    }
    res.json({ ok: true, enquiries });
  }),
);

// Vendor marks an enquiry responded / completed.
const EnqStatusBody = z.object({ status: z.enum(['NEW', 'RESPONDED', 'COMPLETED', 'ARCHIVED']) });
vendorDashboardRouter.patch(
  '/enquiries/:id',
  asyncHandler(async (req, res) => {
    const { status } = EnqStatusBody.parse(req.body);
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub }, select: { listingId: true, businessName: true, status: true } });
    const enq = await prisma.enquiry.findUnique({ where: { id: req.params.id ?? '' } });
    if (!enq) throw new NotFoundError('Enquiry not found');
    // Same gate as the list above: a pending account sees that leads exist but
    // cannot act on them — a status change mails the parent that the business
    // answered.
    if (!isVendorApproved(v?.status)) {
      throw new ForbiddenError('Your vendor account must be approved before you can manage enquiries');
    }
    // Same rule as the list above (see enquiryScope).
    const ownsIt =
      !!v?.listingId &&
      (enq.listingId === v.listingId ||
        (enq.listingId === null &&
          !!v.businessName &&
          enq.listingName === v.businessName &&
          !(enq.source ?? '').startsWith('marketing')));
    if (!ownsIt) throw new ForbiddenError();
    const updated = await prisma.enquiry.update({
      where: { id: enq.id },
      data: {
        status,
        handledBy: req.auth!.sub,
        respondedAt: status === 'RESPONDED' && !enq.respondedAt ? new Date() : enq.respondedAt,
        ...(status === 'COMPLETED' && !enq.closedAt ? { closedAt: new Date() } : {}),
      },
    });
    // Keep the parent in the loop when the vendor moves their enquiry along —
    // forward moves only, once each. Toggling NEW <-> RESPONDED mailed the
    // parent the same "your enquiry was answered" on every click.
    const firstResponse = status === 'RESPONDED' && !enq.respondedAt;
    const completedNow = status === 'COMPLETED' && !enq.closedAt && enq.status !== 'COMPLETED' && enq.status !== 'ARCHIVED';
    if (firstResponse || completedNow) {
      notifyIf(updated.email, (to) =>
        enquiryStatusEmail(to, updated.name, updated.listingName ?? v?.businessName ?? null, status),
      );
    }
    if (status !== enq.status) invalidateVendorInsights(req.auth!.sub);
    res.json({ ok: true, enquiry: { id: updated.id, status: updated.status } });
  }),
);

// Read-only view of vendor's own listing data (proxies the in-memory static index).
vendorDashboardRouter.get(
  '/listing',
  asyncHandler(async (req, res) => {
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub }, select: { listingId: true } });
    if (!v?.listingId) throw new NotFoundError('No listing claimed');
    const listing = getListingById(v.listingId);
    if (!listing) throw new NotFoundError('Listing not found in static index');
    res.json({ ok: true, listing });
  }),
);

// ----- Resend the verification link -----
// Rate-limited on its own: it is the one vendor endpoint that causes outbound
// mail to an address the caller chose.
const resendLimiter = makeLimiter('vendor-dashboard-email-resend', {
  windowMs: 60 * 60_000,
  max: env.NODE_ENV === 'development' ? 10_000 : 5,
  standardHeaders: true,
});

vendorDashboardRouter.post(
  '/email/resend',
  resendLimiter,
  asyncHandler(async (req, res) => {
    const v = await prisma.vendor.findUnique({
      where: { id: req.auth!.sub },
      select: { id: true, businessName: true, email: true, emailVerified: true },
    });
    if (!v) throw new ForbiddenError();
    if (!v.email) throw new BadRequestError('Add a business email first');
    if (v.emailVerified) {
      res.json({ ok: true, alreadyVerified: true, sent: false });
      return;
    }

    await sendVendorVerificationEmail({ id: v.id, businessName: v.businessName, email: v.email });
    res.json({ ok: true, sent: true, email: v.email, expiresInMinutes: VENDOR_VERIFY_TTL_MIN });
  }),
);

// GET /my-business (returns vendor's full DB record and listing details)
vendorDashboardRouter.get(
  '/my-business',
  asyncHandler(async (req, res) => {
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    if (!v) throw new NotFoundError('Vendor account not found');
    res.json({ ok: true, business: toBusinessDto(v) });
  }),
);

// PATCH /my-business (update vendor business info)
// Every field here was unbounded, which meant a paste of arbitrary length went
// straight at the column. Bounds are generous but real: the longest address in
// the listing data is 246 characters and the longest website 2171, so these are
// sized above what the corpus actually contains rather than guessed.
// `email` is not here on purpose: it identifies the account, receives the
// sign-in codes and carries the receipts. Support changes it after confirming
// who is asking, which a self-service field cannot do.
const UpdateBusinessBody = z.object({
  businessName: z.string().min(2).max(160).optional(),
  category: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  country: z.enum(['IN', 'US']).optional(),
  locality: z.string().max(160).optional(),
  address: z.string().max(500).optional(),
  pincode: z.string().max(20).optional(),
  phone: z.string().max(32).optional(),
  website: z.string().max(3000).optional(),
  whatsapp: z.string().max(32).optional(),
  about: z.string().max(5000).optional(),
  openingHours: z.string().max(1000).optional(),
  servicesList: z.string().max(2000).optional(),
  // Free text from the Edit Business form before; now the same image rule as
  // /profile. '' clears it.
  imageUrl: imageSrc.optional().or(z.literal('')),
  // Up to five extra photos for the public listing gallery. Each is either a
  // hosted URL or a small resized data URL produced by the dashboard.
  galleryImages: z
    .array(imageSrc)
    .max(5, 'You can keep at most 5 photos')
    .optional(),
});

/**
 * The one shape the Edit Business form reads, for GET and PATCH alike. An
 * explicit allow-list: spreading the row leaked internal columns (password
 * hash, session revocation, must-change-password) to the browser.
 */
function toBusinessDto(v: Vendor) {
  const staticListing = v.listingId ? getListingById(v.listingId) : null;
  return {
    id: v.id,
    listingId: v.listingId || v.id,
    businessName: v.businessName,
    category: v.category || staticListing?.category || 'Pet Service',
    city: v.city || staticListing?.city || 'Mumbai',
    country: v.country || staticListing?.country || 'IN',
    locality: v.locality || '',
    address: v.address || staticListing?.address || '',
    pincode: v.pincode || staticListing?.pincode || '',
    phone: v.phone || staticListing?.phone || '',
    email: v.email || '',
    website: v.website || staticListing?.website || '',
    whatsapp: v.whatsapp || '',
    about: v.about || '',
    openingHours: v.openingHours || '',
    servicesList: v.servicesList || '',
    imageUrl: v.imageUrl || '',
    galleryImages: parseGallery(v.galleryImages),
    hasPassword: !!v.passwordHash,
    status: v.status,
    claimedAt: v.claimedAt,
  };
}

/** Gallery column is stored as JSON text; never let a bad row break the page. */
function parseGallery(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

const slugify = (v: string, fallback: string) =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;

vendorDashboardRouter.patch(
  '/my-business',
  asyncHandler(async (req, res) => {
    const body = UpdateBusinessBody.parse(req.body);
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    if (!v) throw new ForbiddenError();

    const { galleryImages, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (rest.imageUrl !== undefined) data.imageUrl = rest.imageUrl || null;
    if (galleryImages !== undefined) data.galleryImages = JSON.stringify(galleryImages);
    // Every other phone write path normalizes before persisting (register,
    // claim, login match) — without it here, a self-edited number can drift
    // from the exact-string form /login's lookup expects and silently stop
    // matching.
    const country = (rest.country || v.country || 'IN') as 'IN' | 'US';
    // The phone is the account's unique sign-in key, so a blank field means
    // "leave it", never "store ''": the empty string wiped the login and the
    // second vendor to do it hit the unique constraint.
    if (rest.phone !== undefined) {
      if (rest.phone.trim()) data.phone = normalizePhone(rest.phone, country);
      else delete data.phone;
    }
    // The phone is also what a WhatsApp claim matches on. Moving an account
    // onto the number of another business's listing would block (or capture)
    // that owner's claim, and nothing here proves the number is theirs, so
    // such a change goes through support instead.
    if (typeof data.phone === 'string' && data.phone !== v.phone) {
      const others = findListingByPhone(data.phone).filter((l) => l.id !== v.listingId);
      if (others.length) {
        throw new BadRequestError(
          'That number belongs to another business listed on Pets24x7. Contact support@pets24x7.com to change it.',
        );
      }
    }
    if (rest.whatsapp !== undefined) data.whatsapp = rest.whatsapp.trim() ? normalizePhone(rest.whatsapp, country) : null;

    const updated = await prisma.vendor.update({ where: { id: v.id }, data });
    invalidateVendorInsights(v.id);

    // The public site reads the in-memory listing index, not the vendor table,
    // so an edit that never reached the index showed nowhere outside this
    // dashboard. Push it across (and persist it) on every save.
    await syncVendorToListingIndex(updated).catch((err) =>
      req.log.warn({ err }, 'listing index sync failed after vendor edit'),
    );

    // Action mails. Photos get their own template (it was never sent by
    // anything); other fields get the profile-updated one, listing only the
    // fields whose value actually moved.
    const before = v as unknown as Record<string, unknown>;
    if (galleryImages !== undefined) {
      const prevCount = parseGallery(v.galleryImages).length;
      if (galleryImages.length > prevCount) {
        notifyIf(updated.email, (to) => vendorPhotosUpdatedEmail(to, updated.businessName, galleryImages.length));
      }
    }
    const changed = Object.keys(data).filter(
      (k) => k !== 'galleryImages' && orNull(before[k]) !== orNull(data[k]),
    );
    if (changed.length > 0) {
      notifyIf(updated.email, (to) => vendorProfileUpdatedEmail(to, updated.businessName, changed, !isVendorApproved(updated.status)));
    }

    res.json({
      ok: true,
      // Spreading the whole row returned the bcrypt password hash to the browser.
      business: toBusinessDto(updated),
    });
  }),
);

/**
 * Mirrors a vendor row into the public listing index so the site shows it.
 * Also called by the admin approval route, so edits made while PENDING go live
 * as soon as the account is approved.
 */
export async function syncVendorToListingIndex(v: {
  listingId: string | null;
  id: string;
  status: string;
  businessName: string;
  category: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  pincode: string | null;
}): Promise<void> {
  // A PENDING claim has only typed the listing's public number (no WhatsApp
  // code), so it may keep editing its own account but must not rewrite the
  // public listing: it could put its own phone on another business's page.
  // Its edits reach the listing when an admin approves it (admin.api.routes.ts).
  if (!isVendorApproved(v.status)) return;
  const listingId = v.listingId || v.id;
  const existing = getListingById(listingId);
  const category = v.category || existing?.category || 'Pet Service';
  const city = v.city || existing?.city || 'Mumbai';
  const record: ListingRecord = {
    ...(existing ?? {}),
    id: listingId,
    name: v.businessName,
    category,
    category_slug: slugify(category, 'pet-service'),
    city,
    city_slug: slugify(city, 'mumbai'),
    country: (v.country || existing?.country || 'IN') as ListingRecord['country'],
    address: v.address || existing?.address,
    phone: v.phone || existing?.phone,
    website: v.website || existing?.website,
    pincode: v.pincode || existing?.pincode,
    rating: existing?.rating ?? 0,
    review_count: existing?.review_count ?? 0,
    claimStatus: 'CLAIMED',
  };
  await addAndPersistImportedListing(record);
}

// ----- Change password -----
// A vendor who signed in with an emailed code may have no password yet, so the
// current one is only required when there is something to check against.
const ChangePasswordBody = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

vendorDashboardRouter.post(
  '/change-password',
  asyncHandler(async (req, res) => {
    const body = ChangePasswordBody.parse(req.body);
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    if (!v) throw new ForbiddenError();

    if (v.passwordHash) {
      const ok = body.currentPassword
        ? await bcrypt.compare(body.currentPassword, v.passwordHash)
        : false;
      if (!ok) throw new BadRequestError('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await prisma.vendor.update({
      where: { id: v.id },
      // Changing the password ends other sessions: whoever knew the old one
      // should not keep a live cookie. Backdated so the cookie issued below
      // (same second) survives — see revocationCutoff.
      data: { passwordHash, mustChangePassword: false, sessionsRevokedAt: revocationCutoff() },
    });
    // Revoking sessions would log this vendor out of the tab they are using, so
    // hand them a fresh cookie issued after the cut-off.
    setAuthCookie(res, { sub: v.id, role: 'vendor' });

    res.json({ ok: true, message: 'Password updated' });
  }),
);

