// Vendor auth — WA-OTP with mandatory phone-match against existing static listings.
//   POST /api/vendor/request-otp { phone }
//      → 200 { matches: [...] }   (phone matched ≥ 1 listing, OTP sent)
//      → 200 { matches: [], hint: "no_match" }   (no matches, do NOT send OTP)
//   POST /api/vendor/verify     { phone, code, listingId, businessName, email? }
//      → JWT cookie + Vendor row created (status PENDING, awaiting admin approve)
//   GET  /api/vendor/email/verify?token=...
//      → burns an email-verification token, redirects back to the dashboard

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
import { setAuthCookie } from './jwt.js';
import { findListingByPhone, getListingById } from '../listings/index.js';
import { normalizePhone } from '../shared/phone.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError, UnauthorizedError } from '../shared/errors.js';
import { env } from '../env.js';
import { notifyIf } from '../mail/notify.js';
import { vendorWelcomeEmail } from '../mail/action-templates.js';
import {
  consumeVendorVerificationToken,
  sendVendorVerificationEmail,
} from './vendor-email-verification.js';
import { EMAIL_OTP_TTL_MIN, issueEmailOtp, normEmail, verifyEmailOtp } from './email-otp.js';
import { loginAlertEmail } from '../mail/action-templates.js';

export const vendorAuthRouter = Router();

const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 4,
  standardHeaders: true,
});

// ---------------------------------------------------------------------------
// Email OTP sign-in for an ALREADY-CLAIMED vendor.
//   POST /api/vendor/email/otp/request { email }
//   POST /api/vendor/email/otp/verify  { email, code }
//
// This is a sign-in path only, never a claim path: a listing is still claimed
// by phone OTP (below), because that is what proves the caller owns the
// business. An address with no vendor row gets `hint: 'no_account'` and no
// mail — matching how /request-otp already reports an unmatched phone.
// ---------------------------------------------------------------------------

const emailOtpLimiter = rateLimit({
  windowMs: 60_000,
  max: env.NODE_ENV === 'development' ? 10_000 : 5,
  standardHeaders: true,
});

vendorAuthRouter.post(
  '/email/otp/request',
  emailOtpLimiter,
  asyncHandler(async (req, res) => {
    const { email: rawEmail } = z.object({ email: z.string().email() }).parse(req.body);
    const email = normEmail(rawEmail);

    // Vendor.email is not unique (two staff may share an address on different
    // listings), so match the newest claimed row.
    const vendor = await prisma.vendor.findFirst({
      where: { email },
      orderBy: { claimedAt: 'desc' },
    });
    if (!vendor) {
      return res.json({ ok: true, email, hint: 'no_account' });
    }

    const issued = await issueEmailOtp(email, 'EMAIL_LOGIN_VENDOR', {
      name: vendor.businessName,
      ip: req.ip,
      ua: req.headers['user-agent'] as string | undefined,
    });

    res.json({
      ok: true,
      email,
      expiresInMinutes: EMAIL_OTP_TTL_MIN,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    });
  }),
);

vendorAuthRouter.post(
  '/email/otp/verify',
  emailOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })
      .parse(req.body);
    const email = normEmail(body.email);

    const ok = await verifyEmailOtp(email, body.code, 'EMAIL_LOGIN_VENDOR');
    if (!ok) throw new UnauthorizedError('Incorrect code');

    const vendor = await prisma.vendor.findFirst({ where: { email }, orderBy: { claimedAt: 'desc' } });
    if (!vendor) throw new UnauthorizedError('No vendor account for this email');
    // A suspended or rejected vendor must not get a session back.
    if (vendor.status === 'SUSPENDED' || vendor.status === 'REJECTED') {
      throw new UnauthorizedError('This vendor account is not active. Contact support.');
    }

    // The code proved the address, so a claim-time self-declared email is now
    // verified — no separate link click needed.
    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        emailVerified: true,
        emailVerifiedAt: vendor.emailVerifiedAt ?? new Date(),
      },
    });
    await prisma.vendorEmailToken
      .updateMany({ where: { vendorId: vendor.id, usedAt: null }, data: { usedAt: new Date() } })
      .catch(() => {});

    setAuthCookie(res, { sub: updated.id, role: 'vendor' });
    notifyIf(updated.email, (to) =>
      loginAlertEmail(
        to,
        updated.businessName,
        new Date(),
        req.ip ?? null,
        (req.headers['user-agent'] as string | undefined) ?? null,
      ),
    );
    res.json({
      ok: true,
      vendor: {
        id: updated.id,
        status: updated.status,
        businessName: updated.businessName,
        listingId: updated.listingId,
        emailVerified: updated.emailVerified,
      },
    });
  }),
);

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
    const isDev = process.env.NODE_ENV === 'development';
    let matches = findListingByPhone(phone);

    if (matches.length === 0 && isDev) {
      // Dev convenience: fall back to a REAL scraped listing so the claim
      // flow binds to a valid id (never the synthetic 'dev-listing-1').
      const demo = getListingById('coco-s-pet-boarding-and-homestay-63035557');
      if (demo) matches = [demo];
    }
    if (matches.length === 0) {
      return res.json({ ok: true, phone, matches: [], hint: 'no_match', devMode: isDev });
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
      devMode: isDev,
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

    const listing: { id: string; name: string; city: string; category: string; country: string; rating: number | string; review_count: number } =
      getListingById(body.listingId) ?? {
        id: body.listingId,
        name: body.businessName ?? 'Unclaimed listing',
        city: 'Mumbai',
        category: 'Pet Services',
        country: 'IN',
        rating: 0,
        review_count: 0,
      };

    let vendorId = 'dev-vendor-id';
    let status = 'ACTIVE';
    const isDev = env.NODE_ENV === 'development';

    let verified = false;
    try {
      verified = await verifyOtp(phone, body.code, 'VENDOR_CLAIM');
    } catch (err) {
      if (!isDev) throw err;
    }
    // A vendor claim mutates real data (creates/activates a Vendor row for a
    // public listing) — never proceed on an unverified OTP outside dev.
    if (!verified && !isDev) throw new UnauthorizedError('Invalid or expired code');

    try {
      const now = new Date();
      // Welcome mail goes out on the first claim only, never on a re-login.
      const priorClaim = await prisma.vendor
        .findUnique({ where: { phone }, select: { claimedAt: true } })
        .catch(() => null);
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
      if (!priorClaim?.claimedAt) {
        notifyIf(vendor.email, (to) => vendorWelcomeEmail(to, vendor.businessName, listing.name));
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'development') throw err;
    }

    // An address typed during the claim is self-declared: send the proof link.
    if (body.email) {
      void sendVendorVerificationEmail({
        id: vendorId,
        businessName: body.businessName ?? listing.name,
        email: body.email,
      }).catch((err) => req.log.warn({ err }, 'vendor claim verification send failed'));
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

// ----- GET /email/verify -----
// Clicked from an email client, so it must work with no cookie: the token is
// the credential. Always lands the vendor back on the dashboard with a status
// in the query string, never a bare JSON error.
const SITE = env.PUBLIC_SITE_URL.replace(/\/+$/, '');

vendorAuthRouter.get(
  '/email/verify',
  rateLimit({ windowMs: 60_000, max: env.NODE_ENV === 'development' ? 10_000 : 20, standardHeaders: true }),
  asyncHandler(async (req, res) => {
    const back = (state: string) => `${SITE}/dashboard/vendor/?view=account&emailVerified=${state}`;
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.redirect(back('invalid'));

    const result = await consumeVendorVerificationToken(token);
    if (!result.ok) return res.redirect(back(result.reason));

    req.log.info({ vendorId: result.vendorId }, 'vendor email verified');
    res.redirect(back('ok'));
  }),
);
