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

adminAuthRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res, 'admin');
  res.json({ ok: true });
});
