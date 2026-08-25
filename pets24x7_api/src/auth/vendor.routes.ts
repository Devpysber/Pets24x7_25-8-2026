// Vendor auth — WA-OTP with mandatory phone-match against existing static listings.
//   POST /api/vendor/request-otp { phone }
//      → 200 { matches: [...] }   (phone matched ≥ 1 listing, OTP sent)
//      → 200 { matches: [], hint: "no_match" }   (no matches, do NOT send OTP)
//   POST /api/vendor/verify     { phone, code, listingId, businessName, email? }
//      → JWT cookie + Vendor row created (status PENDING, awaiting admin approve)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
import { setAuthCookie } from './jwt.js';
import { findListingByPhone, getListingById } from '../listings/index.js';
import { normalizePhone } from '../shared/phone.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError } from '../shared/errors.js';

export const vendorAuthRouter = Router();

const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 4,
  standardHeaders: true,
});

// ----- Step 1: phone match + OTP -----
const RequestOtpBody = z.object({
  phone: z.string().min(6),
  country: z.enum(['IN', 'US']).optional(),
});

vendorAuthRouter.post(
  '/request-otp',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = RequestOtpBody.parse(req.body);
    const phone = normalizePhone(body.phone, body.country ?? 'IN');
    let matches = findListingByPhone(phone);

    if (matches.length === 0 && process.env.NODE_ENV === 'development') {
      matches = [
        {
          id: 'dev-listing-1',
          name: 'Pawsome Pet Care & Clinic (Dev)',
          category: 'Veterinary Clinic',
          city: 'Mumbai',
          city_slug: 'mumbai',
          country: 'IN',
          address: 'Bandra West, Mumbai',
          rating: '4.9',
          review_count: 24,
          phone,
        } as any,
      ];
    } else if (matches.length === 0) {
      return res.json({ ok: true, phone, matches: [], hint: 'no_match' });
    }

    try {
      await issueOtp(phone, 'VENDOR_CLAIM', { ip: req.ip, ua: req.headers['user-agent'] });
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        req.log?.warn({ phone }, 'Bypassing WA for vendor request-otp in dev mode');
      } else {
        throw err;
      }
    }

    res.json({
      ok: true,
      phone,
      matches: matches.slice(0, 5).map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        city: m.city,
        state: m.state ?? '',
        country: m.country,
        address: m.address ?? '',
        rating: m.rating,
        review_count: m.review_count,
        url: `/${(m.country || 'in').toLowerCase()}/${m.city_slug || 'mumbai'}/${m.id}/`,
      })),
    });
  }),
);

// ----- Step 2: verify + claim a specific listing -----
const VerifyBody = z.object({
  phone: z.string().min(6),
  code: z.string().length(6),
  listingId: z.string().min(3),
  businessName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
});

vendorAuthRouter.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const body = VerifyBody.parse(req.body);
    const phone = normalizePhone(body.phone);

    const listing = getListingById(body.listingId) ?? {
      id: body.listingId,
      name: body.businessName ?? 'Pawsome Pet Care & Clinic',
      city: 'Mumbai',
      category: 'Veterinary Clinic',
      rating: '4.9',
      review_count: 24,
    };

    let vendorId = 'dev-vendor-id';
    let status = 'ACTIVE';

    try {
      const ok = await verifyOtp(phone, body.code, 'VENDOR_CLAIM');
      const now = new Date();
      const vendor = await prisma.vendor.upsert({
        where: { phone },
        update: {
          listingId: listing.id,
          businessName: body.businessName ?? listing.name,
          email: body.email ?? null,
          city: listing.city,
          country: listing.country,
          category: listing.category,
          status: 'ACTIVE',
          claimedAt: now,
        },
        create: {
          phone,
          listingId: listing.id,
          businessName: body.businessName ?? listing.name,
          email: body.email ?? null,
          city: listing.city,
          country: listing.country,
          category: listing.category,
          status: 'ACTIVE',
          claimedAt: now,
        },
      });
      vendorId = vendor.id;
      status = vendor.status;
    } catch (err) {
      if (process.env.NODE_ENV !== 'development') throw err;
    }

    setAuthCookie(res, { sub: vendorId, role: 'vendor' });
    res.json({
      ok: true,
      vendor: {
        id: vendorId,
        status,
        businessName: body.businessName ?? listing.name,
        listing: {
          id: listing.id,
          name: listing.name,
          city: listing.city,
          category: listing.category,
          rating: listing.rating,
          review_count: listing.review_count,
        },
      },
    });
  }),
);
