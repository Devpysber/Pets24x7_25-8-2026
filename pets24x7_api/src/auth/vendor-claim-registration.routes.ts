// Business Registration + Listing Claim + Vendor Auth API Routes
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { randomInt } from 'node:crypto';

import { prisma } from '../db.js';
import { setAuthCookie } from './jwt.js';
import { addAndPersistImportedListing, findListingByPhone, getListingById, searchListings } from '../listings/index.js';
import { lastDigits, normalizePhone } from '../shared/phone.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { asyncHandler } from '../shared/async-handler.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  TooManyRequestsError,
} from '../shared/errors.js';
import { env } from '../env.js';
import { notify, notifyIf } from '../mail/notify.js';
import { adminNotifyEmails } from '../mail/admin-notify.js';
import { adminNewClaimEmail } from '../mail/lifecycle-templates.js';
import { businessRegisteredEmail, claimCredentialsEmail, vendorWelcomeEmail } from '../mail/action-templates.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
import { whatsappConfigured } from '../whatsapp/cloud-api.js';
import { normEmail } from './email-otp.js';
import { sendVendorVerificationEmail } from './vendor-email-verification.js';
import { logger } from '../logger.js';

export const vendorClaimRegistrationRouter = Router();

const limiter = makeLimiter('vendor-claim-registration', {
  windowMs: 60_000,
  max: env.NODE_ENV === 'development' ? 10_000 : 15,
  standardHeaders: true,
});

function maskPhone(raw?: string): string {
  if (!raw) return '••••••••••';
  const clean = raw.trim();
  if (clean.length <= 4) return '••••' + clean;
  const start = clean.slice(0, 3);
  const end = clean.slice(-2);
  const middle = '•'.repeat(Math.max(4, clean.length - 5));
  return `${start} ${middle} ${end}`;
}

// The temporary password is a real credential until it is replaced, so it
// comes from the CSPRNG, not Math.random().
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += chars.charAt(randomInt(chars.length));
  }
  return `P24x7#${rand}`;
}

/**
 * A listing is taken once any business account holds it, except one still
 * waiting for its owner's first login (credentials mailed, temp password not
 * yet replaced) — that claimant may need to run the flow again after a typo.
 * Claims made by phone OTP (/api/vendor/verify) have no ownerName, so the old
 * "ownerName is set" test reported them as unclaimed and let a second person
 * start a claim that could only fail at the last step.
 */
function holdsListing(v: { mustChangePassword: boolean } | null | undefined): boolean {
  return !!v && !v.mustChangePassword;
}

/** A claim session is only good for this long after the phone step. */
const CLAIM_SESSION_MS = 60 * 60_000;

/** ListingClaim.verificationCode markers for the WhatsApp possession check. */
const OTP_PENDING = 'wa_otp_pending';
const OTP_OK = 'wa_otp_ok';

/** Optional form fields arrive as '' when left blank; store them as absent. */
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

// ---------------------------------------------------------------------------
// PART A — Find My Listing (Search real database & static index)
// ---------------------------------------------------------------------------
vendorClaimRegistrationRouter.post(
  '/claim/search',
  limiter,
  asyncHandler(async (req, res) => {
    const { q, city } = z.object({ q: z.string().optional(), city: z.string().optional() }).parse(req.body);
    
    // Search in-memory static listing index
    const staticResults = searchListings({ q, city, limit: 60 });
    
    // `mode: 'insensitive'` is Postgres-only, and production runs MySQL, where
    // the generated types do not carry the field at all — passing it there is a
    // compile error, which is what broke the deploy build. MySQL's
    // utf8mb4_unicode_ci collation already compares case-insensitively.
    const ci = (process.env.DATABASE_URL ?? '').startsWith('postgres')
      ? ({ mode: 'insensitive' } as const)
      : {};

    // Search database custom vendors
    const dbVendors = await prisma.vendor.findMany({
      where: {
        ...(q ? { businessName: { contains: q, ...ci } } : {}),
        ...(city && city !== 'all' ? { city: { contains: city, ...ci } } : {}),
      },
      take: 60,
    });

    // Only the listings on this page of results can be flagged, so only those
    // are looked up. Loading every claimed vendor here made each keystroke of
    // the search box a full scan of the vendor table.
    const claimedListingIds = new Set<string>();
    const staticIds = staticResults.map((r) => r.id);
    const claimedVendors = staticIds.length
      ? await prisma.vendor.findMany({
          where: { listingId: { in: staticIds }, mustChangePassword: false },
          select: { listingId: true },
        })
      : [];
    claimedVendors.forEach((v) => {
      if (v.listingId) claimedListingIds.add(v.listingId);
    });

    const combinedMap = new Map<string, any>();

    // Add static items
    for (const item of staticResults) {
      const isClaimed = claimedListingIds.has(item.id);
      combinedMap.set(item.id, {
        id: item.id,
        name: item.name,
        category: item.category || 'Pet Service',
        city: item.city || 'India',
        address: '',  // public route: street address stays private (broker model)
        phoneMasked: maskPhone(item.phone),
        claimed: isClaimed,
      });
    }

    // Add DB vendors
    for (const v of dbVendors) {
      const lid = v.listingId || v.id;
      const isClaimed = holdsListing(v);
      combinedMap.set(lid, {
        id: lid,
        name: v.businessName,
        category: v.category || 'Pet Service',
        city: v.city || 'India',
        address: '',  // public route: street address stays private (broker model)
        phoneMasked: maskPhone(v.phone),
        claimed: isClaimed,
      });
    }

    res.json({
      ok: true,
      listings: Array.from(combinedMap.values()),
    });
  }),
);

// ---------------------------------------------------------------------------
// PART B — Claim Existing Listing (Phone Verification)
// ---------------------------------------------------------------------------
vendorClaimRegistrationRouter.post(
  '/claim/verify-phone',
  limiter,
  asyncHandler(async (req, res) => {
    const { listingId, phone: rawPhone } = z
      .object({
        listingId: z.string().min(1),
        phone: z.string().min(6),
      })
      .parse(req.body);

    const normSubmitted = normalizePhone(rawPhone);
    const submittedLast10 = lastDigits(rawPhone, 10);

    // Check if listing is already claimed in DB
    const dbVendor = await prisma.vendor.findFirst({
      where: { OR: [{ listingId }, { id: listingId }] },
    });
    if (holdsListing(dbVendor)) {
      throw new BadRequestError('This listing has already been claimed.');
    }

    const listing = getListingById(listingId);
    const storedPhone = dbVendor?.phone || listing?.phone || '';
    const storedListingName = dbVendor?.businessName || listing?.name || 'Listing';

    const storedLast10 = lastDigits(storedPhone, 10);

    // Compare normalized trailing digits
    const isMatch = storedLast10.length >= 7 && submittedLast10 === storedLast10;

    if (!isMatch) {
      await prisma.listingClaim.create({
        data: {
          listingId,
          listingName: storedListingName,
          phone: normSubmitted,
          status: 'VERIFICATION_FAILED',
          failureReason: 'Phone number mismatch',
        },
      });

      throw new BadRequestError(
        'Verification failed. The phone number does not match the number associated with this listing.',
      );
    }

    // The number on a listing is public, so typing it proves nothing about who
    // holds it. When WhatsApp is set up, a code goes to that number and the
    // credentials step refuses to run until the code comes back. The number we
    // text is the listing's own, in E.164 when the listing carries a country
    // code, otherwise as the owner typed it (the trailing digits already match).
    const otpPhone = storedPhone.trim().startsWith('+') ? normalizePhone(storedPhone) : normSubmitted;
    const needsOtp = whatsappConfigured();
    if (needsOtp) {
      try {
        await issueOtp(otpPhone, 'VENDOR_CLAIM', { ip: req.ip, ua: req.headers['user-agent'] as string | undefined });
      } catch (err) {
        // A code sent less than a minute ago is still valid — carry on with it.
        if (!(err instanceof TooManyRequestsError)) throw err;
      }
    }

    const claim = await prisma.listingClaim.create({
      data: {
        listingId,
        listingName: storedListingName,
        phone: otpPhone,
        status: 'PHONE_VERIFIED',
        verificationCode: needsOtp ? OTP_PENDING : null,
      },
    });

    res.json({
      ok: true,
      claimId: claim.id,
      listingId,
      verified: true,
      // The client must collect the 6-digit WhatsApp code and send it as
      // `code` with /claim/submit-email.
      otpRequired: needsOtp,
      maskedPhone: maskPhone(storedPhone || normSubmitted),
    });
  }),
);

// ---------------------------------------------------------------------------
// PART C — Owner Account Creation & Temp Password Email
// ---------------------------------------------------------------------------
vendorClaimRegistrationRouter.post(
  '/claim/submit-email',
  limiter,
  asyncHandler(async (req, res) => {
    const { listingId, claimId, email: rawEmail, code } = z
      .object({
        listingId: z.string().min(1),
        claimId: z.string().min(1),
        email: z.string().email(),
        code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
      })
      .parse(req.body);

    const email = normEmail(rawEmail);

    const claim = await prisma.listingClaim.findUnique({ where: { id: claimId } });
    if (!claim || claim.listingId !== listingId) {
      throw new BadRequestError('Invalid or expired claim session.');
    }

    if (claim.status !== 'PHONE_VERIFIED' && claim.status !== 'CREDENTIALS_SENT') {
      throw new BadRequestError('Phone verification required before submitting email.');
    }
    if (Date.now() - claim.createdAt.getTime() > CLAIM_SESSION_MS) {
      throw new BadRequestError('This claim session has expired. Please verify your phone again.');
    }
    if (!claim.phone) {
      throw new BadRequestError('Invalid or expired claim session.');
    }
    const phone = claim.phone;

    // Possession of the listing's phone, proven by the WhatsApp code.
    if (claim.verificationCode === OTP_PENDING) {
      if (!code) throw new BadRequestError('Enter the 6-digit code we sent to the listing\'s WhatsApp number.');
      const ok = await verifyOtp(phone, code, 'VENDOR_CLAIM');
      if (!ok) throw new UnauthorizedError('Incorrect code');
      await prisma.listingClaim.update({ where: { id: claim.id }, data: { verificationCode: OTP_OK } });
    }
    // Without WhatsApp there was no code: the caller only typed the listing's
    // public number, which proves nothing. Such a claim still gets its login,
    // but lands PENDING (no leads, no spending) until an admin approves it, and
    // it may never take over an account that already signed in.
    const phoneProven = claim.verificationCode === OTP_PENDING || claim.verificationCode === OTP_OK;

    // The listing must still be free — or held by this same claim, still
    // waiting for its first login (re-sending after a typo in the address).
    const existingClaimed = await prisma.vendor.findFirst({ where: { listingId } });
    if (existingClaimed && (holdsListing(existingClaimed) || existingClaimed.phone !== phone)) {
      throw new BadRequestError('This listing has already been claimed.');
    }
    // The proven phone may already run a business account. A suspended or
    // rejected one must not be revived by claiming, and a live one for another
    // listing must not be silently moved onto this one with a reset password.
    const existingByPhone = await prisma.vendor.findUnique({ where: { phone } });
    if (existingByPhone && (existingByPhone.status === 'SUSPENDED' || existingByPhone.status === 'REJECTED')) {
      throw new ForbiddenError('This business account is not active. Contact support@pets24x7.com.');
    }
    if (existingByPhone && existingByPhone.listingId && existingByPhone.listingId !== listingId && holdsListing(existingByPhone)) {
      throw new ConflictError('This phone number already manages another business. Sign in at /vendor-login/ instead.');
    }
    if (!phoneProven && holdsListing(existingByPhone)) {
      throw new ConflictError('A business account already uses this phone number. Sign in at /vendor-login/ or contact support@pets24x7.com.');
    }
    const claimStatus = phoneProven ? 'CLAIMED' : 'PENDING';

    const listing = getListingById(listingId);
    const businessName = listing?.name || claim.listingName || 'Your Pet Business';

    const tempPass = generateTempPassword();
    const hashedTempPass = await bcrypt.hash(tempPass, 12);

    // Create or update Vendor account
    const vendor = await prisma.vendor.upsert({
      where: { phone },
      update: {
        email,
        businessName,
        listingId,
        city: listing?.city || 'Mumbai',
        category: listing?.category || 'Pet Service',
        passwordHash: hashedTempPass,
        mustChangePassword: true,
        status: claimStatus,
        claimedAt: new Date(),
        // A different address has not been proven — drop any verified badge
        // that belonged to the one it replaces.
        ...(existingByPhone?.email !== email && { emailVerified: false, emailVerifiedAt: null }),
      },
      create: {
        phone,
        email,
        businessName,
        listingId,
        city: listing?.city || 'Mumbai',
        category: listing?.category || 'Pet Service',
        passwordHash: hashedTempPass,
        mustChangePassword: true,
        status: claimStatus,
        claimedAt: new Date(),
      },
    });

    // Update claim status to CREDENTIALS_SENT
    await prisma.listingClaim.update({
      where: { id: claimId },
      data: {
        ownerId: vendor.id,
        email,
        status: 'CREDENTIALS_SENT',
        tempPasswordHash: hashedTempPass,
      },
    });

    // Send temporary credentials email
    notifyIf(email, (to) => claimCredentialsEmail(to, businessName, tempPass));

    // Ops hear about every claim, as they already do for a registration.
    void adminNotifyEmails()
      .then((admins) => {
        for (const admin of admins) {
          notify(adminNewClaimEmail(admin, 'Admin', { businessName, phone, city: listing?.city ?? null, listingName: businessName }, 'claim', !phoneProven));
        }
      })
      .catch(() => {});

    res.json({
      ok: true,
      claimId: claim.id,
      email,
      businessName,
      status: 'CREDENTIALS_SENT',
      reviewRequired: !phoneProven,
      message: phoneProven
        ? `Temporary login credentials sent to ${email}`
        : `Temporary login credentials sent to ${email}. Our team will confirm the listing is yours before leads are shown.`,
    });
  }),
);

// ---------------------------------------------------------------------------
// PART D — First Login Forced Password Change
// ---------------------------------------------------------------------------
vendorClaimRegistrationRouter.post(
  '/claim/first-login-change-password',
  limiter,
  asyncHandler(async (req, res) => {
    const { email: rawEmail, loginKey, tempPassword, newPassword, confirmPassword } = z
      .object({
        email: z.string().email().optional(),
        // Email or phone, as typed at /login — lets an account without an
        // email address finish the forced change too.
        loginKey: z.string().min(1).optional(),
        tempPassword: z.string().min(1),
        newPassword: z.string().min(8, 'Password must be at least 8 characters'),
        confirmPassword: z.string().min(8),
      })
      .parse(req.body);

    if (newPassword !== confirmPassword) {
      throw new BadRequestError('Passwords do not match.');
    }

    const key = (rawEmail ?? loginKey ?? '').trim();
    if (!key) throw new BadRequestError('Enter your business email or phone number.');
    const last10 = lastDigits(key, 10);
    // Same matching as /login: exact email, or the phone by its last 10 digits.
    const where = key.includes('@')
      ? { email: normEmail(key) }
      : last10.length >= 10
        ? { phone: { endsWith: last10 } }
        : { phone: normalizePhone(key) };
    // Vendor.email is not unique: prefer the account that is actually waiting
    // for its first password, newest claim first.
    const vendor =
      (await prisma.vendor.findFirst({
        where: { ...where, mustChangePassword: true },
        orderBy: { claimedAt: 'desc' },
      })) ?? (await prisma.vendor.findFirst({ where, orderBy: { claimedAt: 'desc' } }));

    if (!vendor || !vendor.passwordHash) {
      throw new UnauthorizedError('Account not found or password not set.');
    }

    if (!vendor.mustChangePassword) {
      throw new BadRequestError('Password change is not required for this account.');
    }
    if (vendor.status === 'SUSPENDED' || vendor.status === 'REJECTED') {
      throw new ForbiddenError('This business account is not active. Contact support@pets24x7.com.');
    }

    // Verify temp password
    const isTempValid = await bcrypt.compare(tempPassword, vendor.passwordHash);
    if (!isTempValid) {
      throw new UnauthorizedError('Temporary password is invalid or expired.');
    }

    // Hash permanent password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Update vendor in DB
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        passwordHash: newPasswordHash,
        mustChangePassword: false,
        // A claim whose phone was never proven lands PENDING and stays there
        // until an admin approves it; setting a password is not an approval.
        // Only a proven (CLAIMED) claim goes live here.
        status: vendor.status === 'PENDING' ? 'PENDING' : 'ACTIVE',
        claimedAt: vendor.claimedAt ?? new Date(),
      },
    });

    // Update latest claim record
    const latestClaim = await prisma.listingClaim.findFirst({
      where: { ownerId: vendor.id },
      orderBy: { createdAt: 'desc' },
    });
    if (latestClaim) {
      await prisma.listingClaim.update({
        where: { id: latestClaim.id },
        data: { status: 'CLAIMED' },
      });
    }

    // The claim is complete only now: this is the "your listing is claimed"
    // moment, and the mailed temp password was merely the key to it.
    const listingName = (vendor.listingId && getListingById(vendor.listingId)?.name) || vendor.businessName;
    // A PENDING claim is not live yet: its "approved and live" mail comes from
    // the admin approve action instead.
    if (vendor.status !== 'PENDING') {
      notifyIf(vendor.email, (to) => vendorWelcomeEmail(to, vendor.businessName, listingName));
    }

    // Set active Vendor JWT auth cookie
    setAuthCookie(res, { sub: vendor.id, role: 'vendor' });

    res.json({
      ok: true,
      active: vendor.status !== 'PENDING',
      reviewRequired: vendor.status === 'PENDING',
      message:
        vendor.status === 'PENDING'
          ? 'Password created. Our team will confirm the listing is yours before leads are shown. Redirecting to Vendor Dashboard...'
          : 'Password created successfully. Redirecting to Vendor Dashboard...',
      redirect: '/dashboard/vendor/',
    });
  }),
);

// ---------------------------------------------------------------------------
// PART G & H — Register New Business (Business Registration System)
// ---------------------------------------------------------------------------
const BusinessRegistrationBody = z.object({
  businessName: z.string().min(2, 'Business Name is required').max(100),
  category: z.string().min(2, 'Category is required'),
  city: z.string().min(2, 'City is required'),
  // Decides the default dialling code for a bare 10-digit number and whether
  // the public page is filed under /in/ or /us/.
  country: z.enum(['IN', 'US']).optional().default('IN'),
  locality: z.string().optional(),
  address: z.string().min(5, 'Full Address is required'),
  pincode: z.string().optional(),
  phone: z.string().min(6, 'Valid Phone Number is required'),
  email: z.string().email('Valid Email Address is required'),
  website: z.string().optional(),
  whatsapp: z.string().optional(),
  about: z.string().optional(),
  openingHours: z.string().optional(),
  servicesList: z.string().optional(),
  imageUrl: z.string().optional(),
  ownerName: z.string().min(2, 'Owner Name is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string().min(8),
});

vendorClaimRegistrationRouter.post(
  '/register-business',
  limiter,
  asyncHandler(async (req, res) => {
    const body = BusinessRegistrationBody.parse(req.body);

    if (body.password !== body.confirmPassword) {
      throw new BadRequestError('Passwords do not match.');
    }

    const normPhone = normalizePhone(body.phone, body.country);
    const email = normEmail(body.email);

    // Check for existing vendor by phone or email
    const existingByPhone = await prisma.vendor.findUnique({ where: { phone: normPhone } });
    if (existingByPhone) {
      throw new BadRequestError('That phone number is already registered to another business account.');
    }
    // Vendor.phone is unique, so registering on a listed business's number
    // would lock its owner out of claiming that listing. The owner claims it
    // (which proves the number); anyone else needs their own number.
    if (findListingByPhone(normPhone).length) {
      throw new ConflictError(
        'A business with this phone number is already listed on Pets24x7. Claim it at /find-my-listing/ instead of registering a new one.',
      );
    }

    const existingByEmail = await prisma.vendor.findFirst({ where: { email } });
    if (existingByEmail) {
      throw new BadRequestError('That email address is already registered to another business account.');
    }

    // Generate custom listing ID
    const newListingId = `listing_new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const passwordHash = await bcrypt.hash(body.password, 12);

    // Create Vendor & Business Listing in DB
    const vendor = await prisma.vendor.create({
      data: {
        phone: normPhone,
        email,
        businessName: body.businessName,
        ownerName: body.ownerName,
        category: body.category,
        city: body.city,
        country: body.country,
        locality: opt(body.locality),
        address: body.address,
        pincode: opt(body.pincode),
        website: opt(body.website),
        whatsapp: opt(body.whatsapp) ? normalizePhone(body.whatsapp!, body.country) : undefined,
        about: opt(body.about),
        openingHours: opt(body.openingHours),
        servicesList: opt(body.servicesList),
        imageUrl: opt(body.imageUrl),
        listingId: newListingId,
        passwordHash,
        mustChangePassword: false,
        status: 'ACTIVE',
        profileCompletion: 85,
        claimedAt: new Date(),
        approvedAt: new Date(),
      },
    });

    // The registration page promises the business goes live immediately, and
    // until now it did not: a vendor record was created with a listingId that
    // existed nowhere else, so the account had a dashboard and the public site
    // had no page. Create the directory row and put it in the running index, so
    // the business is actually findable the moment it signs up.
    const slugify = (v: string | null | undefined, fallback: string) =>
      (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;
    const categorySlug = slugify(body.category, 'pet-service');
    const citySlug = slugify(body.city, 'unknown');

    try {
      await prisma.listing.create({
        data: {
          id: newListingId,
          name: body.businessName,
          category: body.category,
          categorySlug,
          city: body.city,
          citySlug,
          country: body.country,
          address: body.address ?? null,
          phone: normPhone,
          website: opt(body.website) ?? null,
          pincode: opt(body.pincode) ?? null,
          rating: 0,
          reviewCount: 0,
          claimStatus: 'CLAIMED',
          importedAt: new Date(),
        },
      });

      await addAndPersistImportedListing({
        id: newListingId,
        name: body.businessName,
        category: body.category,
        category_slug: categorySlug,
        city: body.city,
        city_slug: citySlug,
        country: body.country,
        address: body.address ?? undefined,
        phone: normPhone,
        website: opt(body.website),
        pincode: opt(body.pincode),
        rating: 0,
        review_count: 0,
        claimStatus: 'CLAIMED',
      });
    } catch (err) {
      // The account is already created and usable; a failure here means the
      // public page is missing, which the admin panel now flags as an orphaned
      // claim rather than hiding.
      logger.error({ err, listingId: newListingId }, 'could not create the directory row for a new registration');
    }

    // Create a record in ListingClaim as well
    await prisma.listingClaim.create({
      data: {
        listingId: newListingId,
        listingName: body.businessName,
        ownerId: vendor.id,
        phone: normPhone,
        email,
        status: 'CLAIMED',
      },
    });

    // Send Registration Confirmation Email
    notifyIf(email, (to) => businessRegisteredEmail(to, body.businessName, body.city));

    // The address was only typed, never proven, and email sign-in prefers a
    // verified row (vendorByEmail in vendor.routes.ts). Send the proof link
    // now; sign-in is not blocked, and the dashboard shows "Not verified" with
    // a resend button until it is clicked.
    void sendVendorVerificationEmail({ id: vendor.id, businessName: vendor.businessName, email }).catch((err) =>
      req.log.warn({ err, vendorId: vendor.id }, 'registration verification email failed'),
    );

    // A self-service registration goes live at once (status ACTIVE), so tell
    // the ops team about it rather than relying on anyone happening to open
    // the admin dashboard to review what was published.
    void adminNotifyEmails()
      .then((admins) => {
        for (const admin of admins) {
          notify(
            adminNewClaimEmail(admin, 'Admin', {
              businessName: body.businessName,
              phone: normPhone,
              city: body.city ?? null,
              listingName: body.businessName,
            }, 'registration'),
          );
        }
      })
      .catch(() => {});

    // Set auth cookie
    setAuthCookie(res, { sub: vendor.id, role: 'vendor' });

    res.json({
      ok: true,
      vendor: {
        id: vendor.id,
        businessName: vendor.businessName,
        listingId: vendor.listingId,
        email: vendor.email,
        emailVerified: false,
      },
      redirect: '/dashboard/vendor/',
    });
  }),
);

// ---------------------------------------------------------------------------
// Vendor Password Login (Password Authentication Endpoint)
// ---------------------------------------------------------------------------
vendorClaimRegistrationRouter.post(
  '/login',
  limiter,
  asyncHandler(async (req, res) => {
    const { loginKey, password } = z
      .object({
        loginKey: z.string().min(1, 'Email or Phone is required'),
        password: z.string().min(1, 'Password is required'),
      })
      .parse(req.body);

    const keyClean = loginKey.trim().toLowerCase();
    const isEmail = keyClean.includes('@');
    const normPhone = isEmail ? '' : normalizePhone(keyClean);

    // Vendor.email is not unique (two listings can share an owner's address),
    // so every account on that address is a candidate and the password picks
    // the one being signed into.
    let candidates = await prisma.vendor.findMany({
      where: isEmail
        ? { email: keyClean, passwordHash: { not: null } }
        : { phone: normPhone, passwordHash: { not: null } },
      orderBy: { claimedAt: 'desc' },
      take: 10,
    });

    if (!candidates.length && !isEmail) {
      const last10 = lastDigits(keyClean, 10);
      if (last10.length >= 10) {
        candidates = await prisma.vendor.findMany({
          where: { phone: { endsWith: last10 }, passwordHash: { not: null } },
          take: 10,
        });
      }
    }

    let vendor: (typeof candidates)[number] | null = null;
    for (const c of candidates) {
      if (c.passwordHash && (await bcrypt.compare(password, c.passwordHash))) {
        vendor = c;
        break;
      }
    }
    if (!vendor) {
      throw new UnauthorizedError('Invalid login email/phone or password.');
    }
    // Refuse up front with the reason, instead of handing out a cookie that
    // every vendor route will then reject.
    if (vendor.status === 'SUSPENDED' || vendor.status === 'REJECTED') {
      throw new ForbiddenError(
        vendor.status === 'SUSPENDED'
          ? 'This business account is suspended. Contact support@pets24x7.com.'
          : 'This listing claim was not approved. Contact support@pets24x7.com.',
      );
    }

    if (vendor.mustChangePassword) {
      return res.json({
        ok: true,
        mustChangePassword: true,
        email: vendor.email,
        message: 'First login detected — permanent password creation required.',
      });
    }

    setAuthCookie(res, { sub: vendor.id, role: 'vendor' });

    res.json({
      ok: true,
      mustChangePassword: false,
      vendor: {
        id: vendor.id,
        businessName: vendor.businessName,
        listingId: vendor.listingId,
        email: vendor.email,
      },
      redirect: '/dashboard/vendor/',
    });
  }),
);
