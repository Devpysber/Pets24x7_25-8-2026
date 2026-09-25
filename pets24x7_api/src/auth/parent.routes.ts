// Pet Parent auth — WA-OTP signup & login.
//   POST /api/parent/request-otp { phone, name?, email? }
//   POST /api/parent/verify     { phone, code, country?, name?, city? }   → JWT cookie
//
// Nothing about an EXISTING account is changed before the code is verified:
// request-otp is unauthenticated, so letting it rewrite a row's name or email
// would let anyone who knows a phone number repoint that account's email and
// then take it over through the email sign-in and password-reset paths.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
import { setAuthCookie } from './jwt.js';
import { normalizePhone } from '../shared/phone.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, UnauthorizedError } from '../shared/errors.js';
import { env } from '../env.js';
import { notifyIf } from '../mail/notify.js';

export const parentAuthRouter = Router();

const otpLimiter = makeLimiter('parent-otp-request', {
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 4,
  standardHeaders: true,
});

// Verification gets its own budget: sharing the request limiter meant a
// customer who asked for a code twice had one attempt left to type it, and
// leaving it unlimited let one IP cycle guesses across many phones (the
// per-code attempt cap only bounds a single phone).
const verifyLimiter = makeLimiter('parent-otp-verify', {
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 10,
  standardHeaders: true,
});

// ----- Request OTP -----
const RequestOtpBody = z.object({
  phone: z.string().min(6),
  name: z.string().min(2).max(80).optional(),
  email: z.string().email().optional(),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
});

parentAuthRouter.post(
  '/request-otp',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = RequestOtpBody.parse(req.body);
    const phone = normalizePhone(body.phone, body.country ?? 'IN');

    try {
      // A first-time number gets its row now (verify looks it up by phone).
      // `email` is accepted for backward compatibility but never stored here:
      // an address typed next to an unproven phone is not evidence of anything,
      // and the email flows would otherwise merge a stranger into this row.
      const existing = await prisma.petParent.findUnique({ where: { phone }, select: { id: true } });
      if (!existing) {
        await prisma.petParent.create({
          data: {
            phone,
            name: body.name ?? 'Pet Parent',
            ...(body.city && { city: body.city }),
            ...(body.country && { country: body.country }),
          },
        });
      }
      await issueOtp(phone, 'PARENT_SIGNUP', { ip: req.ip, ua: req.headers['user-agent'] });
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        req.log?.warn({ phone }, 'Bypassing DB/WA for parent request-otp in dev mode');
      } else {
        throw err;
      }
    }

    res.json({ ok: true, phone, devMode: process.env.NODE_ENV === 'development' });
  }),
);

// ----- Verify OTP -----
const VerifyBody = z.object({
  phone: z.string().min(6),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  // Must match what request-otp was given, or a 10-digit US number normalises
  // to +91 here and never finds its code.
  country: z.enum(['IN', 'US']).optional(),
  // Profile details applied only once the phone is proven.
  name: z.string().min(2).max(80).optional(),
  city: z.string().max(80).optional(),
});

parentAuthRouter.post(
  '/verify',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    const body = VerifyBody.parse(req.body);
    const { code } = body;
    const normPhone = normalizePhone(body.phone, body.country ?? 'IN');
    const isDev = env.NODE_ENV === 'development';

    let verified = false;
    try {
      verified = await verifyOtp(normPhone, code, 'PARENT_SIGNUP');
    } catch (err) {
      if (!isDev) throw err;
    }

    // Outside dev, a failed/invalid OTP is a hard stop — no fall-through login.
    if (!verified && !isDev) throw new UnauthorizedError('Invalid or expired code');

    let parent = await prisma.petParent
      .findUnique({ where: { phone: normPhone } })
      .catch(() => null);

    if (parent && verified && (body.name || body.city || body.country)) {
      parent = await prisma.petParent
        .update({
          where: { id: parent.id },
          data: {
            ...(body.name && { name: body.name }),
            ...(body.city && { city: body.city }),
            ...(body.country && { country: body.country }),
          },
        })
        .catch(() => parent);
    }

    if (!parent) {
      if (isDev) {
        parent = {
          id: 'dev-parent-id',
          name: 'Dev Pet Parent',
          phone: normPhone,
          email: 'alex.parent@example.com',
        } as any;
      } else {
        throw new UnauthorizedError('Account not found');
      }
    }

    setAuthCookie(res, { sub: parent!.id, role: 'pet_parent' });
    res.json({ ok: true, parent: { id: parent!.id, name: parent!.name, phone: normPhone, email: parent!.email ?? null } });
  }),
);
