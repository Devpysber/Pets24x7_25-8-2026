// Business Registration + Listing Claim + Vendor Auth API Routes
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import randomBytes from 'node:crypto';

import { prisma } from '../db.js';
import { setAuthCookie } from './jwt.js';
import { getListingById, searchListings } from '../listings/index.js';
import { lastDigits, normalizePhone } from '../shared/phone.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError, UnauthorizedError, NotFoundError } from '../shared/errors.js';
import { env } from '../env.js';
import { notify, notifyIf } from '../mail/notify.js';
import { adminNotifyEmails } from '../mail/admin-notify.js';
import { adminNewClaimEmail } from '../mail/lifecycle-templates.js';
import { businessRegisteredEmail, claimCredentialsEmail } from '../mail/action-templates.js';
import { normEmail } from './email-otp.js';

export const vendorClaimRegistrationRouter = Router();

const limiter = rateLimit({
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

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `P24x7#${rand}`;
}

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

    const claimedListingIds = new Set<string>();
    const claimedVendors = await prisma.vendor.findMany({
      where: { listingId: { not: null }, mustChangePassword: false, ownerName: { not: null } },
      select: { listingId: true },
    });
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
        address: item.address || '',
        phoneMasked: maskPhone(item.phone),
        claimed: isClaimed,
      });
    }

    // Add DB vendors
    for (const v of dbVendors) {
      const lid = v.listingId || v.id;
      const isClaimed = !v.mustChangePassword && !!v.ownerName;
      combinedMap.set(lid, {
        id: lid,
        name: v.businessName,
        category: v.category || 'Pet Service',
        city: v.city || 'India',
        address: v.address || '',
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
    if (dbVendor && !dbVendor.mustChangePassword && !!dbVendor.ownerName) {
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

    // Phone matches! Create claim record with status PHONE_VERIFIED
    const claim = await prisma.listingClaim.create({
      data: {
        listingId,
        listingName: listing?.name || 'Listing',
        phone: normSubmitted,
        status: 'PHONE_VERIFIED',
      },
    });

    res.json({
      ok: true,
      claimId: claim.id,
      listingId,
      verified: true,
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
    const { listingId, claimId, email: rawEmail } = z
      .object({
        listingId: z.string().min(1),
        claimId: z.string().min(1),
        email: z.string().email(),
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

    // Double-check listing is not claimed
    const existingClaimed = await prisma.vendor.findFirst({
      where: { listingId },
    });
    if (existingClaimed) {
      throw new BadRequestError('This listing has already been claimed.');
    }

    const listing = getListingById(listingId);
    const businessName = listing?.name || claim.listingName || 'Your Pet Business';

    // Generate secure 10-char temporary password
    const tempPass = generateTempPassword();
    const hashedTempPass = await bcrypt.hash(tempPass, 12);

    const phone = claim.phone || normalizePhone('9930090487');

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
        status: 'CLAIMED',
        claimedAt: new Date(),
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
        status: 'CLAIMED',
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

    res.json({
      ok: true,
      claimId: claim.id,
      email,
      businessName,
      status: 'CREDENTIALS_SENT',
      message: `Temporary login credentials sent to ${email}`,
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
    const { email: rawEmail, tempPassword, newPassword, confirmPassword } = z
      .object({
        email: z.string().email(),
        tempPassword: z.string().min(1),
        newPassword: z.string().min(8, 'Password must be at least 8 characters'),
        confirmPassword: z.string().min(8),
      })
      .parse(req.body);

    if (newPassword !== confirmPassword) {
      throw new BadRequestError('Passwords do not match.');
    }

    const email = normEmail(rawEmail);
    const vendor = await prisma.vendor.findFirst({
      where: { email },
    });

    if (!vendor || !vendor.passwordHash) {
      throw new UnauthorizedError('Account not found or password not set.');
    }

    if (!vendor.mustChangePassword) {
      throw new BadRequestError('Password change is not required for this account.');
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
        status: 'ACTIVE',
        claimedAt: new Date(),
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

    // Set active Vendor JWT auth cookie
    setAuthCookie(res, { sub: vendor.id, role: 'vendor' });

    res.json({
      ok: true,
      active: true,
      message: 'Password created successfully. Redirecting to Vendor Dashboard...',
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

    const normPhone = normalizePhone(body.phone);
    const email = normEmail(body.email);

    // Check for existing vendor by phone or email
    const existingByPhone = await prisma.vendor.findUnique({ where: { phone: normPhone } });
    if (existingByPhone) {
      throw new BadRequestError('That phone number is already registered to another business account.');
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
        locality: body.locality,
        address: body.address,
        pincode: body.pincode,
        website: body.website,
        whatsapp: body.whatsapp ? normalizePhone(body.whatsapp) : undefined,
        about: body.about,
        openingHours: body.openingHours,
        servicesList: body.servicesList,
        imageUrl: body.imageUrl,
        listingId: newListingId,
        passwordHash,
        mustChangePassword: false,
        status: 'ACTIVE',
        profileCompletion: 85,
        claimedAt: new Date(),
        approvedAt: new Date(),
      },
    });

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

    // A self-service registration lands as PENDING and sits there until someone
    // approves it, so tell the ops team it is waiting rather than relying on
    // anyone happening to open the admin dashboard.
    void adminNotifyEmails()
      .then((admins) => {
        for (const admin of admins) {
          notify(
            adminNewClaimEmail(admin, 'Admin', {
              businessName: body.businessName,
              phone: normPhone,
              city: body.city ?? null,
              listingName: body.businessName,
            }),
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

    let vendor = await prisma.vendor.findFirst({
      where: isEmail
        ? { email: keyClean }
        : { phone: normPhone },
    });

    if (!vendor && !isEmail) {
      const last10 = lastDigits(keyClean, 10);
      if (last10.length >= 10) {
        vendor = await prisma.vendor.findFirst({
          where: { phone: { endsWith: last10 } },
        });
      }
    }

    if (!vendor || !vendor.passwordHash) {
      throw new UnauthorizedError('Invalid login email/phone or password.');
    }

    const isMatch = await bcrypt.compare(password, vendor.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedError('Invalid login email/phone or password.');
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
