// Vendor dashboard — claimed listing + profile completion checklist.
// All routes require a vendor JWT.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { setAuthCookie } from '../auth/jwt.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { addAndPersistImportedListing, getListingById, type ListingRecord } from '../listings/index.js';
import bcrypt from 'bcrypt';
import { notifyIf } from '../mail/notify.js';
import {
  VENDOR_VERIFY_TTL_MIN,
  sendVendorVerificationEmail,
} from '../auth/vendor-email-verification.js';
import { enquiryStatusEmail, vendorProfileUpdatedEmail } from '../mail/action-templates.js';

export const vendorDashboardRouter = Router();

vendorDashboardRouter.use(requireAuth('vendor'));

function completionChecklist(vendor: {
  email: string | null;
  emailVerified?: boolean;
  listingId: string | null;
  status: string;
  hasReviews?: boolean;
  hasServices?: boolean;
}) {
  return [
    { key: 'claim_listing', label: 'Claim your listing',                done: !!vendor.listingId, weight: 25 },
    { key: 'verify_phone',  label: 'Verify your WhatsApp number',       done: true, weight: 15 }, // implicit on signup
    // An unverified address does not count: it is where receipts and enquiry
    // alerts go, so it has to be one we know reaches them.
    { key: 'add_email',     label: 'Add and verify a business email',   done: !!vendor.email && !!vendor.emailVerified, weight: 15 },
    { key: 'admin_approve', label: 'Approval from Pets24x7 admin',      done: vendor.status === 'ACTIVE', weight: 20 },
    { key: 'add_services',    label: 'List at least one service',         done: !!vendor.hasServices, weight: 10 },
    { key: 'collect_reviews', label: 'Collect your first review',         done: !!vendor.hasReviews, weight: 15 },
  ];
}

vendorDashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    let v: any = null;
    try {
      v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    } catch {
      // DB connection offline
    }

    if (!v) {
      v = {
        id: req.auth!.sub,
        businessName: 'Pawsome Pet Care & Clinic',
        phone: '+919930090487',
        email: 'contact@pawsome.example.com',
        status: 'ACTIVE',
        city: 'Mumbai',
        country: 'IN',
        category: 'Veterinary Clinic',
        listingId: 'in-mumbai-pawsome-clinic',
        claimedAt: new Date(),
        approvedAt: new Date(),
        profileCompletion: 85,
      };
    }

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
      const [total, pending, published, recent, sent, opened, completed, sentToday, camps, svc, avgAgg] =
        await Promise.all([
          prisma.review.count({ where: { vendorId: v.id } }),
          prisma.review.count({ where: { vendorId: v.id, status: 'PENDING' } }),
          prisma.review.count({ where: { vendorId: v.id, status: 'PUBLISHED' } }),
          prisma.review.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
          prisma.reviewRequest.count({ where: { vendorId: v.id } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, openedAt: { not: null } } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, reviewSubmittedAt: { not: null } } }),
          prisma.reviewRequest.count({ where: { vendorId: v.id, sentAt: { gte: startOfDay } } }),
          prisma.marketingCampaign.findMany({ where: { vendorId: v.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.service.count({ where: { vendorId: v.id } }),
          prisma.review.aggregate({ where: { vendorId: v.id, status: 'PUBLISHED' }, _avg: { rating: true } }),
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
      if (v.listingId || v.businessName) {
        const where = { OR: [{ listingId: v.listingId ?? '__none__' }, { listingName: v.businessName ?? '__none__' }] };
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

    const checklist = completionChecklist({
      email: v.email,
      emailVerified: v.emailVerified,
      listingId: v.listingId,
      status: v.status,
      hasReviews: hasCollectedReviews,
      hasServices: serviceCount > 0,
    });
    const completionPct = checklist.reduce((s, item) => s + (item.done ? item.weight : 0), 0);

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
      listing: listing ?? { id: v.listingId ?? 'unclaimed', name: v.businessName, city: v.city, category: v.category, rating: null, review_count: 0 },
      completion: { percent: completionPct, checklist },
      reviews: reviewAgg,
      enquiries: enquiryAgg,
      customerInvites: invites,
      campaigns,
      serviceCount,
    });
  }),
);

const ProfileBody = z.object({
  businessName: z.string().min(2).max(120).optional(),
  email: z.string().email().max(160).optional().or(z.literal('')),
  category: z.string().min(2).max(80).optional(),
  // Small resized data: URL (client downsizes first). '' clears it.
  imageUrl: z
    .string()
    .max(600_000)
    .regex(/^data:image\/(png|jpe?g|webp);base64,/, 'must be an image data URL')
    .optional()
    .or(z.literal('')),
});

vendorDashboardRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = ProfileBody.parse(req.body);
    const current = await prisma.vendor.findUnique({
      where: { id: req.auth!.sub },
      select: { email: true },
    });

    const data: Record<string, unknown> = {};
    if (body.businessName !== undefined) data.businessName = body.businessName;
    if (body.category !== undefined) data.category = body.category;
    if (body.imageUrl !== undefined) data.imageUrl = body.imageUrl || null;

    // A new address is unproven — drop the verified flag and mail a fresh link,
    // so the old address's proof never carries over to a different one.
    const nextEmail = body.email === undefined ? undefined : body.email || null;
    const emailChanged = nextEmail !== undefined && nextEmail !== (current?.email ?? null);
    if (nextEmail !== undefined) {
      data.email = nextEmail;
      if (emailChanged) {
        data.emailVerified = false;
        data.emailVerifiedAt = null;
      }
    }

    const v = await prisma.vendor.update({ where: { id: req.auth!.sub }, data });

    if (emailChanged && v.email) {
      void sendVendorVerificationEmail({ id: v.id, businessName: v.businessName, email: v.email }).catch((err) => {
        req.log.warn({ err }, 'vendor email verification send failed');
      });
    }
    const changed = Object.keys(data).filter((k) => k !== 'emailVerified' && k !== 'emailVerifiedAt');
    if (changed.length > 0) {
      notifyIf(v.email, (to) => vendorProfileUpdatedEmail(to, v.businessName, changed));
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
      select: { listingId: true, businessName: true },
    });
    if (!v?.listingId) return res.json({ ok: true, enquiries: [] });
    const enquiries = await prisma.enquiry.findMany({
      where: { OR: [{ listingId: v.listingId }, { listingName: v.businessName }] },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ ok: true, enquiries });
  }),
);

// Vendor marks an enquiry responded / completed.
const EnqStatusBody = z.object({ status: z.enum(['NEW', 'RESPONDED', 'COMPLETED', 'ARCHIVED']) });
vendorDashboardRouter.patch(
  '/enquiries/:id',
  asyncHandler(async (req, res) => {
    const { status } = EnqStatusBody.parse(req.body);
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub }, select: { listingId: true, businessName: true } });
    const enq = await prisma.enquiry.findUnique({ where: { id: req.params.id ?? '' } });
    if (!enq) throw new NotFoundError('Enquiry not found');
    const ownsIt = (v?.listingId && enq.listingId === v.listingId) || (v?.businessName && enq.listingName === v.businessName);
    if (!ownsIt) throw new ForbiddenError();
    const updated = await prisma.enquiry.update({
      where: { id: enq.id },
      data: { status, handledBy: req.auth!.sub, respondedAt: status === 'RESPONDED' && !enq.respondedAt ? new Date() : enq.respondedAt },
    });
    // Keep the parent in the loop when the vendor moves their enquiry along.
    if (status !== enq.status) {
      notifyIf(updated.email, (to) =>
        enquiryStatusEmail(to, updated.name, updated.listingName ?? v?.businessName ?? null, status),
      );
    }
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
const resendLimiter = rateLimit({
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
    const staticListing = v.listingId ? getListingById(v.listingId) : null;
    res.json({
      ok: true,
      business: {
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
      },
    });
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
  imageUrl: z.string().max(600_000).optional(),
  // Up to five extra photos for the public listing gallery. Each is either a
  // hosted URL or a small resized data URL produced by the dashboard.
  galleryImages: z
    .array(z.string().max(600_000))
    .max(5, 'You can keep at most 5 photos')
    .optional(),
});

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
    if (galleryImages !== undefined) data.galleryImages = JSON.stringify(galleryImages);

    const updated = await prisma.vendor.update({ where: { id: v.id }, data });

    // The public site reads the in-memory listing index, not the vendor table,
    // so an edit that never reached the index showed nowhere outside this
    // dashboard. Push it across (and persist it) on every save.
    await syncVendorToListingIndex(updated).catch((err) =>
      req.log.warn({ err }, 'listing index sync failed after vendor edit'),
    );

    res.json({
      ok: true,
      business: { ...updated, galleryImages: parseGallery(updated.galleryImages) },
    });
  }),
);

/** Mirrors a vendor row into the public listing index so the site shows it. */
async function syncVendorToListingIndex(v: {
  listingId: string | null;
  id: string;
  businessName: string;
  category: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  pincode: string | null;
}): Promise<void> {
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
      // should not keep a live cookie.
      data: { passwordHash, mustChangePassword: false, sessionsRevokedAt: new Date() },
    });
    // Revoking sessions would log this vendor out of the tab they are using, so
    // hand them a fresh cookie issued after the cut-off.
    setAuthCookie(res, { sub: v.id, role: 'vendor' });

    res.json({ ok: true, message: 'Password updated' });
  }),
);

