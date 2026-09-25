// Vendor auth — WA-OTP with mandatory phone-match against existing static listings.
//   POST /api/vendor/request-otp { phone }
//      → 200 { matches: [...] }   (phone matched ≥ 1 listing, OTP sent)
//      → 200 { matches: [], hint: "no_match" }   (no matches, do NOT send OTP)
//   POST /api/vendor/verify     { phone, code, listingId, businessName?, email?, country? }
//      → JWT cookie + Vendor row created/updated (status ACTIVE). The listing
//        must be one whose phone matched in step 1 (or the one this phone
//        already manages) — proving your own phone never lets you claim a
//        business that is listed under a different number.
//   GET  /api/vendor/email/verify?token=...
//      → burns an email-verification token, redirects back to the dashboard

import { Router } from 'express';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';

import { prisma } from '../db.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
import { setAuthCookie } from './jwt.js';
import { findListingByPhone, findPublicListingsByPhone, getListingById, shownRating } from '../listings/index.js';
import { normalizePhone } from '../shared/phone.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError, UnauthorizedError } from '../shared/errors.js';
import { env } from '../env.js';
import { notifyIf } from '../mail/notify.js';
import { vendorWelcomeEmail } from '../mail/action-templates.js';
import { vendorEmailVerifiedEmail } from '../mail/lifecycle-templates.js';
import {
  type VendorConsumeResult,
  consumeVendorVerificationToken,
  sendVendorVerificationEmail,
} from './vendor-email-verification.js';
import { EMAIL_OTP_TTL_MIN, issueEmailOtp, normEmail, verifyEmailOtp } from './email-otp.js';

export const vendorAuthRouter = Router();

const otpLimiter = makeLimiter('vendor-otp-request', {
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 4,
  standardHeaders: true,
});

// Code checks have their own budget (see the parent twin in parent.routes.ts):
// the per-code attempt cap bounds one phone, not one caller cycling phones.
const verifyLimiter = makeLimiter('vendor-otp-verify', {
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 10,
  standardHeaders: true,
});

/**
 * Vendor.email is not unique, so a sign-in by address has to pick one row. A
 * row whose owner proved the address wins over one that only typed it —
 * otherwise anyone could register a business under someone else's address and
 * have that person's email sign-in land in the newcomer's account. Among
 * equals the newest claim wins; unclaimed rows (claimedAt null) sort last,
 * where Postgres would otherwise put NULLs first on a descending sort.
 */
function vendorByEmail(email: string) {
  return prisma.vendor.findFirst({
    where: { email },
    orderBy: [{ emailVerified: 'desc' }, { claimedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
}

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

const emailOtpLimiter = makeLimiter('vendor-email-otp', {
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
    // listings) — see vendorByEmail for which row wins.
    const vendor = await vendorByEmail(email);
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

    const vendor = await vendorByEmail(email);
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

    // A temp/admin-issued password still needs to be rotated before a full
    // session is handed out — the same gate the password-login route enforces.
    if (updated.mustChangePassword) {
      res.json({ ok: true, mustChangePassword: true, email: updated.email });
      return;
    }

    setAuthCookie(res, { sub: updated.id, role: 'vendor' });
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

// ---------------------------------------------------------------------------
// Google Sign-In for an ALREADY-CLAIMED business.
//   POST /api/vendor/google { credential }
//
// Sign-in only, never sign-up: a business account exists after a claim or a
// registration, both of which prove something Google cannot (control of the
// listing's phone number). An address Google vouches for but that owns no
// vendor row is told to claim or register instead of being handed an account.
// ---------------------------------------------------------------------------
const vendorGoogleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

vendorAuthRouter.post(
  '/google',
  emailOtpLimiter,
  asyncHandler(async (req, res) => {
    const { credential } = z.object({ credential: z.string().min(10) }).parse(req.body);
    if (!vendorGoogleClient) throw new BadRequestError('Google Sign-In is not configured');

    let payload;
    try {
      const ticket = await vendorGoogleClient.verifyIdToken({
        idToken: credential,
        audience: env.GOOGLE_CLIENT_ID!,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('Invalid Google credential');
    }

    // Google has to vouch for the address itself: an unverified Google email is
    // no better than a typed-in string.
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new UnauthorizedError('That Google account has no verified email');
    }

    const email = normEmail(payload.email);
    const vendor = await vendorByEmail(email);
    if (!vendor) {
      throw new UnauthorizedError(
        'No business account uses that Google address yet. Claim your listing or register your business first.',
      );
    }
    if (vendor.status === 'SUSPENDED' || vendor.status === 'REJECTED') {
      throw new UnauthorizedError('This business account is not active. Contact support.');
    }

    // Google proved the address, so a self-declared claim-time email is now
    // verified — the same conclusion the emailed code reaches.
    const updated = await prisma.vendor.update({
      where: { id: vendor.id },
      data: { emailVerified: true, emailVerifiedAt: vendor.emailVerifiedAt ?? new Date() },
    });
    await prisma.vendorEmailToken
      .updateMany({ where: { vendorId: vendor.id, usedAt: null }, data: { usedAt: new Date() } })
      .catch(() => {});

    // Same gate as email-OTP: a temp/admin-issued password must be rotated
    // before Google Sign-In can hand out a full session.
    if (updated.mustChangePassword) {
      res.json({ ok: true, mustChangePassword: true, email: updated.email });
      return;
    }

    setAuthCookie(res, { sub: updated.id, role: 'vendor' });
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
    // Nothing is verified yet — anyone can type any number — so the preview
    // (name, category, city, address, rating) only ever shows listings the
    // public may see; a hidden one is not revealed to whoever knows its phone.
    // Same rule as GET /api/listings/by-phone. /verify still accepts any
    // listing under the number, hidden included, once the code is proven.
    let matches = findPublicListingsByPhone(phone);

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
        rating: shownRating(m),
        review_count: m.review_count,
        url: `/${(m.country || 'in').toLowerCase()}/${m.city_slug || 'mumbai'}/${m.id}/`,
      })),
    });
  }),
);

// ----- Step 2: verify + claim a specific listing -----
const VerifyBody = z.object({
  phone: z.string().min(6),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  listingId: z.string().min(3),
  businessName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  // Must match what request-otp was given, or a 10-digit US number normalises
  // to +91 here and never finds its code.
  country: z.enum(['IN', 'US']).optional(),
});

vendorAuthRouter.post(
  '/verify',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    const body = VerifyBody.parse(req.body);
    const phone = normalizePhone(body.phone, body.country ?? 'IN');
    const email = body.email ? normEmail(body.email) : undefined;

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

    // The code proves the caller holds THIS phone. It says nothing about any
    // other business, so the listing must be one listed under this number, or
    // the one this phone already manages (a re-login).
    const priorClaim = await prisma.vendor
      .findUnique({ where: { phone }, select: { id: true, claimedAt: true, email: true, status: true, listingId: true } })
      .catch(() => null);
    if (!isDev) {
      const ownsListing =
        priorClaim?.listingId === body.listingId ||
        findListingByPhone(phone).some((m) => m.id === body.listingId);
      if (!ownsListing) {
        throw new UnauthorizedError('That listing is not registered to this phone number.');
      }
      if (!getListingById(body.listingId) && priorClaim?.listingId !== body.listingId) {
        throw new BadRequestError('Listing not found.');
      }
    }
    // A suspended or rejected business cannot re-activate itself by signing in
    // again — the upsert below would otherwise flip it straight back to ACTIVE.
    if (priorClaim && (priorClaim.status === 'SUSPENDED' || priorClaim.status === 'REJECTED')) {
      throw new UnauthorizedError('This business account is not active. Contact support@pets24x7.com.');
    }
    // One listing, one owner: someone else already manages it.
    const holder = await prisma.vendor
      .findUnique({ where: { listingId: listing.id }, select: { id: true } })
      .catch(() => null);
    if (holder && holder.id !== priorClaim?.id) {
      throw new ConflictError('This listing has already been claimed. Contact support@pets24x7.com if it is yours.');
    }

    try {
      const now = new Date();
      // An address typed into the claim form is self-declared. If it differs
      // from the one already on file, the proof that came with the old address
      // no longer applies — clear it, or a vendor could swap in someone else's
      // address and inherit a verified badge. A re-login that sends no address
      // keeps the one on file rather than wiping it.
      const emailChanged = email !== undefined && email !== (priorClaim?.email ?? null);
      const vendor = await prisma.vendor.upsert({
        where: { phone },
        update: {
          listingId: listing.id,
          businessName: body.businessName ?? listing.name,
          ...(email !== undefined && { email }),
          city: listing.city,
          country: listing.country,
          category: listing.category,
          // An account that has claimed before keeps its status and claim date;
          // only a first claim sets them (a re-login must not reset either).
          ...(priorClaim?.claimedAt ? {} : { status: 'ACTIVE' as const, claimedAt: now }),
          ...(emailChanged ? { emailVerified: false, emailVerifiedAt: null } : {}),
        },
        create: {
          phone,
          listingId: listing.id,
          businessName: body.businessName ?? listing.name,
          email: email ?? null,
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

    // A newly typed address is self-declared: send the proof link. An address
    // already on file (verified or not) is not re-mailed on every sign-in.
    if (email && email !== (priorClaim?.email ?? null) && vendorId !== 'dev-vendor-id') {
      void sendVendorVerificationEmail({
        id: vendorId,
        businessName: body.businessName ?? listing.name,
        email,
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
          rating: shownRating(listing),
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
  makeLimiter('vendor-email-verify', { windowMs: 60_000, max: env.NODE_ENV === 'development' ? 10_000 : 20, standardHeaders: true }),
  asyncHandler(async (req, res) => {
    const back = (state: string) => `${SITE}/dashboard/vendor/?view=account&emailVerified=${state}`;
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.redirect(back('invalid'));

    // Opened from a mail client: a failure must land on a page, never on JSON.
    const result = await consumeVendorVerificationToken(token).catch((err): VendorConsumeResult => {
      req.log.warn({ err }, 'vendor email verification consume failed');
      return { ok: false, reason: 'invalid' };
    });
    if (!result.ok) return res.redirect(back(result.reason));

    req.log.info({ vendorId: result.vendorId }, 'vendor email verified');
    // Confirm to the address that was just proven, so a vendor who verified a
    // typo'd address sees nothing arrive and knows to fix it.
    const verified = await prisma.vendor
      .findUnique({ where: { id: result.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(verified?.email, (to) => vendorEmailVerifiedEmail(to, verified?.businessName ?? 'there'));
    res.redirect(back('ok'));
  }),
);
