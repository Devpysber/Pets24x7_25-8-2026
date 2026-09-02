// Admin auth — email + password.
// Admin rows are created via `npm run seed:admin` (one-time bootstrap) or by
// an OWNER from the admin panel later.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { z } from 'zod';

import { prisma } from '../db.js';
import { setAuthCookie, clearAuthCookie } from './jwt.js';
import { asyncHandler } from '../shared/async-handler.js';
import { UnauthorizedError } from '../shared/errors.js';
import { EMAIL_OTP_TTL_MIN, issueEmailOtp, normEmail, verifyEmailOtp } from './email-otp.js';

export const adminAuthRouter = Router();

const loginLimiter = rateLimit({ windowMs: 5 * 60_000, max: 10, standardHeaders: true });

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(8) });

adminAuthRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = LoginBody.parse(req.body);
    const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin) throw new UnauthorizedError('Invalid credentials');

    const ok = await bcrypt.compare(password, admin.passwordHash);
    if (!ok) throw new UnauthorizedError('Invalid credentials');

    await prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: admin.id, action: 'admin.login', ipAddress: req.ip },
    });

    setAuthCookie(res, { sub: admin.id, role: 'admin' });
    res.json({ ok: true, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  }),
);

// ---------------------------------------------------------------------------
// Email OTP sign-in (primary path). Admin rows are never created here — an
// address with no admin row gets the same 200 as one that has, so this cannot
// be used to enumerate staff accounts.
//   POST /api/admin/email/otp/request { email }
//   POST /api/admin/email/otp/verify  { email, code }
// ---------------------------------------------------------------------------

const otpLimiter = rateLimit({ windowMs: 5 * 60_000, max: 10, standardHeaders: true });

adminAuthRouter.post(
  '/email/otp/request',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { email: raw } = z.object({ email: z.string().email() }).parse(req.body);
    const email = normEmail(raw);

    const admin = await prisma.admin.findUnique({ where: { email } });
    let devCode: string | undefined;
    if (admin) {
      const issued = await issueEmailOtp(email, 'EMAIL_LOGIN_ADMIN', {
        name: admin.name,
        ip: req.ip,
        ua: req.headers['user-agent'] as string | undefined,
      });
      devCode = issued.devCode;
    }
    // Identical response either way — no account enumeration.
    res.json({ ok: true, email, expiresInMinutes: EMAIL_OTP_TTL_MIN, ...(devCode ? { devCode } : {}) });
  }),
);

adminAuthRouter.post(
  '/email/otp/verify',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') })
      .parse(req.body);
    const email = normEmail(body.email);

    const ok = await verifyEmailOtp(email, body.code, 'EMAIL_LOGIN_ADMIN');
    if (!ok) throw new UnauthorizedError('Incorrect code');

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin) throw new UnauthorizedError('Invalid credentials');

    await prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: admin.id, action: 'admin.login.otp', ipAddress: req.ip },
    });

    setAuthCookie(res, { sub: admin.id, role: 'admin' });
    res.json({ ok: true, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
  }),
);

adminAuthRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res, 'admin');
  res.json({ ok: true });
});
