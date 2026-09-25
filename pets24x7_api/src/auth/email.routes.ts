// Pet Parent auth by email — manual signup/login plus Google Sign-In.
//   POST /api/parent/email/signup  { name, email, password, phone?, city?, country? }
//   POST /api/parent/email/login   { email, password }
//   POST /api/parent/email/resend  { email }
//   POST /api/parent/email/forgot  { email }               → mails a reset link
//   POST /api/parent/email/reset   { token, password }     → sets the new password
//   GET  /api/parent/email/verify?token=...       → redirects back to the site
//   POST /api/parent/google        { credential }   (Google ID token)
//
// Manual signups start unverified and cannot log in until they click the mailed
// link. Google sign-ins are verified on arrival, since Google already proved
// ownership of the address.

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { setAuthCookie } from './jwt.js';
import { normalizePhone } from '../shared/phone.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, UnauthorizedError } from '../shared/errors.js';
import {
  VERIFY_TTL_MIN,
  type ConsumeResult,
  consumeVerificationToken,
  sendVerificationEmail,
  sendWelcomeEmailOnce,
} from './email-verification.js';
import { notifyIf } from '../mail/notify.js';
import { EMAIL_OTP_TTL_MIN, issueEmailOtp, verifyEmailOtp } from './email-otp.js';
import { RESET_TTL_MIN, consumeResetToken, sendPasswordResetEmail } from './password-reset.js';
import { passwordChangedEmail, emailVerifiedEmail } from '../mail/lifecycle-templates.js';

export const parentEmailAuthRouter = Router();

const isDev = env.NODE_ENV === 'development';
// One limiter per route, each with its own name (and so its own shared counter).
const limiter = (name: string, max: number) =>
  makeLimiter(`parent-email-${name}`, { windowMs: 60_000, max: isDev ? 10_000 : max, standardHeaders: true });

const SITE = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
const normEmail = (e: string) => e.trim().toLowerCase();

/**
 * Finds the account an address belongs to, for a caller who has just PROVEN
 * that address (email code, Google). An address on a row that never verified
 * it is only a claim someone typed, so the prover must not inherit whatever
 * else that row carries:
 *  - a row that also signs in some other way (phone, Google) keeps its
 *    credentials but loses the unproven address, and the prover gets a fresh
 *    account — otherwise whoever owns that phone would be signed into the
 *    prover's account from then on;
 *  - a bare unverified signup keeps its row, but its password is dropped by
 *    the caller, since nobody has shown the password belongs to the address
 *    owner (the classic pre-registration takeover).
 */
async function accountForProvenEmail(email: string) {
  const row = await prisma.petParent.findUnique({ where: { email } });
  if (!row || row.emailVerified) return row;
  if (row.phone || row.googleId) {
    const now = new Date();
    await prisma.$transaction([
      prisma.petParent.update({ where: { id: row.id }, data: { email: null } }),
      prisma.emailVerificationToken.updateMany({ where: { parentId: row.id, usedAt: null }, data: { usedAt: now } }),
      prisma.passwordResetToken.updateMany({ where: { parentId: row.id, usedAt: null }, data: { usedAt: now } }),
    ]);
    return null;
  }
  return row;
}

/** A unique-constraint clash on a user-supplied field, as a readable 400. */
function uniqueClash(err: unknown): never {
  if ((err as { code?: string })?.code === 'P2002') {
    const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? '');
    throw new BadRequestError(
      target.includes('phone')
        ? 'That phone number is already registered to another account.'
        : 'That email address is already registered to another account.',
    );
  }
  throw err;
}

function publicParent(p: { id: string; name: string; email: string | null; phone: string | null; emailVerified: boolean }) {
  return { id: p.id, name: p.name, email: p.email, phone: p.phone, emailVerified: p.emailVerified };
}

// ---------------------------------------------------------------------------
// Email OTP sign-in (primary path)
//   POST /api/parent/email/otp/request { email }        → mails a 6-digit code
//   POST /api/parent/email/otp/verify  { email, code }  → cookie + parent row
//
// Passwordless: a first-time address is signed up on successful verification.
// The code itself proves the address, so the account lands verified and skips
// the mailed-link step entirely.
// ---------------------------------------------------------------------------

parentEmailAuthRouter.post(
  '/email/otp/request',
  limiter('otp-request', 5),
  asyncHandler(async (req, res) => {
    const { email: raw } = z.object({ email: z.string().email() }).parse(req.body);
    const email = normEmail(raw);

    const parent = await prisma.petParent.findUnique({ where: { email } });
    const issued = await issueEmailOtp(email, 'EMAIL_LOGIN_PARENT', {
      name: parent?.name ?? null,
      ip: req.ip,
      ua: req.headers['user-agent'] as string | undefined,
    });

    res.json({
      ok: true,
      email,
      // A new address is signed up on verify; the UI uses this to ask for a name.
      // An unproven address on a phone/Google account also gets a fresh account
      // on verify (see accountForProvenEmail), so it counts as new too.
      isNewAccount: !parent || (!parent.emailVerified && Boolean(parent.phone || parent.googleId)),
      expiresInMinutes: EMAIL_OTP_TTL_MIN,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    });
  }),
);

const OtpVerifyBody = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  name: z.string().min(2).max(80).optional(),
  phone: z.string().min(6).optional(),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
});

parentEmailAuthRouter.post(
  '/email/otp/verify',
  limiter('otp-verify', 10),
  asyncHandler(async (req, res) => {
    const body = OtpVerifyBody.parse(req.body);
    const email = normEmail(body.email);

    const ok = await verifyEmailOtp(email, body.code, 'EMAIL_LOGIN_PARENT');
    if (!ok) throw new UnauthorizedError('Incorrect code');

    const now = new Date();
    const existing = await accountForProvenEmail(email);
    const phone = body.phone ? normalizePhone(body.phone, body.country ?? 'IN') : null;

    const parent = await (existing
      ? prisma.petParent.update({
          where: { id: existing.id },
          data: {
            // The code proved the address — settle verification either way.
            emailVerified: true,
            emailVerifiedAt: existing.emailVerifiedAt ?? now,
            // A password set before the address was proven may not be the
            // owner's — see accountForProvenEmail.
            ...(!existing.emailVerified && { passwordHash: null }),
            ...(body.name && { name: body.name }),
            ...(phone && { phone }),
            ...(body.city && { city: body.city }),
            ...(body.country && { country: body.country }),
          },
        })
      : prisma.petParent.create({
          data: {
            email,
            name: body.name?.trim() || email.split('@')[0] || 'Pet Parent',
            phone,
            city: body.city ?? null,
            country: body.country ?? null,
            emailVerified: true,
            emailVerifiedAt: now,
          },
        })
    ).catch(uniqueClash);

    // Any pending verification link is moot now that the address is proven.
    await prisma.emailVerificationToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: now },
    });

    // First verified sign-in gets the welcome mail; later ones get nothing.
    // Not awaited: the SMTP round trip (seconds on a slow relay) sat between
    // a correct code or password and the session cookie.
    void sendWelcomeEmailOnce(parent).catch((err) => req.log.warn({ err }, 'welcome mail failed'));
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.json({ ok: true, isNewAccount: !existing, parent: publicParent(parent) });
  }),
);

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
  limiter('signup', 5),
  asyncHandler(async (req, res) => {
    const body = SignupBody.parse(req.body);
    const email = normEmail(body.email);
    const phone = body.phone ? normalizePhone(body.phone, body.country ?? 'IN') : null;

    let existing = await prisma.petParent.findUnique({ where: { email } });
    if (existing?.emailVerified) {
      throw new BadRequestError('An account with this email already exists. Please log in.');
    }
    // An unverified address sitting on an account that signs in by phone or
    // Google is not this signup's to take over: detach it and start fresh.
    if (existing && (existing.phone || existing.googleId)) existing = await accountForProvenEmail(email);

    const passwordHash = await bcrypt.hash(body.password, 12);

    // Re-signing up on an unverified account just refreshes it — no duplicate row.
    const parent = await (existing
      ? prisma.petParent.update({
          where: { id: existing.id },
          data: {
            name: body.name,
            passwordHash,
            ...(phone && { phone }),
            ...(body.city && { city: body.city }),
            ...(body.country && { country: body.country }),
          },
        })
      : prisma.petParent.create({
          data: {
            email,
            name: body.name,
            passwordHash,
            phone,
            city: body.city ?? null,
            country: body.country ?? null,
          },
        })
    ).catch(uniqueClash);

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
  limiter('login', 10),
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

    // Not awaited: the SMTP round trip (seconds on a slow relay) sat between
    // a correct code or password and the session cookie.
    void sendWelcomeEmailOnce(parent).catch((err) => req.log.warn({ err }, 'welcome mail failed'));
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.json({ ok: true, parent: publicParent(parent) });
  }),
);

// ----- Resend verification -----
parentEmailAuthRouter.post(
  '/email/resend',
  limiter('resend', 3),
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

// ----- Forgot password -----
// Answers the same way whether or not the address exists, so the endpoint
// cannot be used to find out who has an account.
parentEmailAuthRouter.post(
  '/email/forgot',
  limiter('forgot', 3),
  asyncHandler(async (req, res) => {
    const { email: raw } = z.object({ email: z.string().email() }).parse(req.body);
    const email = normEmail(raw);

    const parent = await prisma.petParent.findUnique({ where: { email } });
    // Only an account that actually has a password can reset one. A passwordless
    // account signs in with a code instead, and mailing it a reset link would
    // just confuse the owner.
    if (parent?.passwordHash) {
      await sendPasswordResetEmail({ id: parent.id, name: parent.name, email }).catch((err) =>
        req.log.warn({ err }, 'password reset send failed'),
      );
    }
    res.json({ ok: true, expiresInMinutes: RESET_TTL_MIN });
  }),
);

// ----- Set a new password from a reset link -----
const ResetBody = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(200),
});

parentEmailAuthRouter.post(
  '/email/reset',
  limiter('reset', 10),
  asyncHandler(async (req, res) => {
    const body = ResetBody.parse(req.body);

    const result = await consumeResetToken(body.token);
    if (!result.ok) {
      throw new BadRequestError(
        result.reason === 'expired'
          ? 'That reset link has expired. Please request a new one.'
          : 'That reset link is no longer valid. Please request a new one.',
      );
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    const parent = await prisma.petParent.update({
      where: { id: result.parentId },
      // Reaching the mailed link proves the address, so an account that was
      // still unverified becomes verified here.
      data: {
        passwordHash,
        emailVerified: true,
        emailVerifiedAt: new Date(),
        // A reset is what someone does when they think the account is exposed:
        // end every existing session. Backdated to just before this second,
        // because token issue times are whole seconds and the cookie set below
        // must survive (see tokenRevoked in actor.ts).
        sessionsRevokedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 1),
      },
    });

    notifyIf(parent.email, (to) => passwordChangedEmail(to, parent.name, new Date(), req.ip ?? null));

    // Signing them in immediately is the whole point of the flow: they have
    // just proved both the address and a fresh password.
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.json({ ok: true, parent: publicParent(parent) });
  }),
);

// ----- Verify link target -----
parentEmailAuthRouter.get(
  '/email/verify',
  limiter('verify', 20),
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) return res.redirect(`${SITE}/login/?verified=invalid`);

    // Opened from a mail client: a failure must land on a page, never on JSON.
    const result = await consumeVerificationToken(token).catch((err): ConsumeResult => {
      req.log.warn({ err }, 'email verification consume failed');
      return { ok: false, reason: 'invalid' };
    });
    if (!result.ok) return res.redirect(`${SITE}/login/?verified=${result.reason}`);

    const parent = await prisma.petParent.findUnique({ where: { id: result.parentId } });
    if (!parent) return res.redirect(`${SITE}/login/?verified=invalid`);

    // A first-time parent gets the welcome mail instead — two mails for one
    // click is noise.
    const welcomed = await sendWelcomeEmailOnce(parent);
    if (!welcomed) {
      notifyIf(parent.email, (to) => emailVerifiedEmail(to, parent.name ?? 'there'));
    }
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.redirect(`${SITE}/dashboard/parent/?verified=1`);
  }),
);

// ----- Google Sign-In -----
const googleClient = env.GOOGLE_CLIENT_ID ? new OAuth2Client(env.GOOGLE_CLIENT_ID) : null;

parentEmailAuthRouter.post(
  '/google',
  limiter('google', 20),
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

    const byGoogle = await prisma.petParent.findUnique({ where: { googleId: payload.sub } });
    const existing = byGoogle ?? (await accountForProvenEmail(email));

    const parent = await (existing
      ? prisma.petParent.update({
          where: { id: existing.id },
          data: {
            googleId: payload.sub,
            email,
            emailVerified: true,
            emailVerifiedAt: existing.emailVerifiedAt ?? now,
            // Linking by address to a row that never proved it: the password on
            // it was set by whoever typed the address, not necessarily its owner.
            ...(!byGoogle && !existing.emailVerified && { passwordHash: null }),
          },
        })
      : prisma.petParent.create({
          data: { email, name, googleId: payload.sub, emailVerified: true, emailVerifiedAt: now },
        })
    ).catch(uniqueClash);

    // Any pending link verification is moot now.
    await prisma.emailVerificationToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: now },
    });

    // Not awaited: the SMTP round trip (seconds on a slow relay) sat between
    // a correct code or password and the session cookie.
    void sendWelcomeEmailOnce(parent).catch((err) => req.log.warn({ err }, 'welcome mail failed'));
    setAuthCookie(res, { sub: parent.id, role: 'pet_parent' });
    res.json({ ok: true, isNewAccount: !existing, parent: publicParent(parent) });
  }),
);
