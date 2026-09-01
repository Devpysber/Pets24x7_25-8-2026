// Pet Parent auth by email — manual signup/login plus Google Sign-In.
//   POST /api/parent/email/signup  { name, email, password, phone?, city?, country? }
//   POST /api/parent/email/login   { email, password }
//   POST /api/parent/email/resend  { email }
//   GET  /api/parent/email/verify?token=...       → redirects back to the site
//   POST /api/parent/google        { credential }   (Google ID token)
//
// Manual signups start unverified and cannot log in until they click the mailed
// link. Google sign-ins are verified on arrival, since Google already proved
// ownership of the address.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { setAuthCookie } from './jwt.js';
import { normalizePhone } from '../shared/phone.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, UnauthorizedError } from '../shared/errors.js';
import {
  VERIFY_TTL_MIN,
  consumeVerificationToken,
  sendVerificationEmail,
  sendWelcomeEmailOnce,
} from './email-verification.js';
import { notifyIf } from '../mail/notify.js';
import { loginAlertEmail } from '../mail/action-templates.js';

export const parentEmailAuthRouter = Router();

const isDev = env.NODE_ENV === 'development';
const limiter = (max: number) =>
  rateLimit({ windowMs: 60_000, max: isDev ? 10_000 : max, standardHeaders: true });

const SITE = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
const normEmail = (e: string) => e.trim().toLowerCase();

function publicParent(p: { id: string; name: string; email: string | null; phone: string | null; emailVerified: boolean }) {
  return { id: p.id, name: p.name, email: p.email, phone: p.phone, emailVerified: p.emailVerified };
}

// ----- Manual signup -----
const SignupBody = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  phone: z.string().min(6).optional(),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
});

parentEmailAuthRouter.post(
  '/email/signup',
  limiter(5),
  asyncHandler(async (req, res) => {
    const body = SignupBody.parse(req.body);
    const email = normEmail(body.email);
    const phone = body.phone ? normalizePhone(body.phone, body.country ?? 'IN') : null;

    const existing = await prisma.petParent.findUnique({ where: { email } });
    if (existing?.emailVerified) {
      throw new BadRequestError('An account with this email already exists. Please log in.');
    }

    const passwordHash = await bcrypt.hash(body.password, 12);

    // Re-signing up on an unverified account just refreshes it — no duplicate row.
    const parent = existing
      ? await prisma.petParent.update({
          where: { id: existing.id },
          data: {
            name: body.name,
            passwordHash,
            ...(phone && { phone }),
            ...(body.city && { city: body.city }),
            ...(body.country && { country: body.country }),
          },
        })
      : await prisma.petParent.create({
          data: {
            email,
            name: body.name,
            passwordHash,
            phone,
            city: body.city ?? null,
            country: body.country ?? null,
          },
        });

    await sendVerificationEmail({ id: parent.id, name: parent.name, email });

    res.status(201).json({
      ok: true,
      needsVerification: true,
      expiresInMinutes: VERIFY_TTL_MIN,
      parent: publicParent(parent),
    });
  }),
);

// ----- Manual login -----
const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

parentEmailAuthRouter.post(
  '/email/login',
  limiter(10),
  asyncHandler(async (req, res) => {
    const body = LoginBody.parse(req.body);
    const email = normEmail(body.email);

    const parent = await prisma.petParent.findUnique({ where: { email } });
    const ok = parent?.passwordHash ? await bcrypt.compare(body.password, parent.passwordHash) : false;
    // One message for both cases — never reveal whether an address is registered.
    if (!parent || !ok) throw new UnauthorizedError('Invalid email or password');

    if (!parent.emailVerified) {
      await sendVerificationEmail({ id: parent.id, name: parent.name, email });
      res.status(403).json({
        ok: false,
        needsVerification: true,
        expiresInMinutes: VERIFY_TTL_MIN,
        error: 'Please verify your email. We just sent you a fresh link.',
      });
      return;
    }

    const firstTime = await sendWelcomeEmailOnce(parent);
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    // Welcome mail already covers a first sign-in; don't send both at once.
    if (!firstTime) {
      notifyIf(parent.email, (to) =>
        loginAlertEmail(
          to,
          parent.name ?? 'there',
          new Date(),
          req.ip ?? null,
          (req.headers['user-agent'] as string | undefined) ?? null,
        ),
      );
    }
    res.json({ ok: true, parent: publicParent(parent) });
  }),
);

// ----- Resend verification -----
parentEmailAuthRouter.post(
  '/email/resend',
  limiter(3),
  asyncHandler(async (req, res) => {
    const { email: raw } = z.object({ email: z.string().email() }).parse(req.body);
    const email = normEmail(raw);

    const parent = await prisma.petParent.findUnique({ where: { email } });
    if (parent && !parent.emailVerified) {
      await sendVerificationEmail({ id: parent.id, name: parent.name, email });
    }
    // Same response either way, so this cannot be used to enumerate accounts.
    res.json({ ok: true, expiresInMinutes: VERIFY_TTL_MIN });
  }),
);

// ----- Verify link target -----
parentEmailAuthRouter.get(
  '/email/verify',
  limiter(20),
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.redirect(`${SITE}/login/?verified=invalid`);

    const result = await consumeVerificationToken(token);
    if (!result.ok) return res.redirect(`${SITE}/login/?verified=${result.reason}`);

    const parent = await prisma.petParent.findUnique({ where: { id: result.parentId } });
    if (!parent) return res.redirect(`${SITE}/login/?verified=invalid`);

    await sendWelcomeEmailOnce(parent);
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.redirect(`${SITE}/dashboard/parent/?verified=1`);
  }),
);

// ----- Google Sign-In -----
const googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

parentEmailAuthRouter.post(
  '/google',
  limiter(20),
  asyncHandler(async (req, res) => {
    const { credential } = z.object({ credential: z.string().min(10) }).parse(req.body);
    if (!googleClient) throw new BadRequestError('Google Sign-In is not configured');

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID! });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('Invalid Google credential');
    }

    // Google must vouch for the address itself. An unverified Google email is
    // no better than a typed-in string and must not skip our own verification.
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new UnauthorizedError('Google account has no verified email');
    }

    const email = normEmail(payload.email);
    const name = payload.name?.trim() || email.split('@')[0] || 'Pet Parent';
    const now = new Date();

    const existing =
      (await prisma.petParent.findUnique({ where: { googleId: payload.sub } })) ??
      (await prisma.petParent.findUnique({ where: { email } }));

    const parent = existing
      ? await prisma.petParent.update({
          where: { id: existing.id },
          data: {
            googleId: payload.sub,
            email,
            emailVerified: true,
            emailVerifiedAt: existing.emailVerifiedAt ?? now,
          },
        })
      : await prisma.petParent.create({
          data: { email, name, googleId: payload.sub, emailVerified: true, emailVerifiedAt: now },
        });

    // Any pending link verification is moot now.
    await prisma.emailVerificationToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: now },
    });

    const firstGoogleSignIn = await sendWelcomeEmailOnce(parent);
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    // Same rule as the password path: welcome covers a first sign-in, every
    // later one gets the security alert instead.
    if (!firstGoogleSignIn) {
      notifyIf(parent.email, (to) =>
        loginAlertEmail(
          to,
          parent.name ?? 'there',
          new Date(),
          req.ip ?? null,
          (req.headers['user-agent'] as string | undefined) ?? null,
        ),
      );
    }
    res.json({ ok: true, parent: publicParent(parent) });
  }),
);
