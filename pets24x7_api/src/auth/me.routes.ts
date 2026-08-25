// GET /api/me     → returns whichever role is signed in (parent | vendor | admin)
// POST /api/me/logout — clears all auth cookies (idempotent)

import { Router } from 'express';
import { prisma } from '../db.js';
import { readAuthCookie, verifyToken, clearAuthCookie, type ActorRole } from './jwt.js';
import { asyncHandler } from '../shared/async-handler.js';

export const meRouter = Router();

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const cookies = (req.cookies ?? {}) as Record<string, string>;
    const roles: ActorRole[] = ['admin', 'vendor', 'pet_parent']; // priority order
    for (const role of roles) {
      const tok = readAuthCookie(cookies, role);
      if (!tok) continue;
      const payload = verifyToken(tok);
      if (!payload || payload.role !== role) continue;

      if (role === 'pet_parent') {
        let p: any = null;
        try {
          p = await prisma.petParent.findUnique({
            where: { id: payload.sub },
            select: { id: true, name: true, phone: true, email: true, city: true, country: true },
          });
        } catch {
          // DB connection offline
        }
        if (!p && process.env.NODE_ENV === 'development') {
          p = { id: payload.sub, name: 'Dev Pet Parent', phone: '+91 98765 43210', email: 'alex.parent@example.com', city: 'Mumbai', country: 'IN' };
        }
        if (p) return res.json({ ok: true, role, user: p });
      } else if (role === 'vendor') {
        let v: any = null;
        try {
          v = await prisma.vendor.findUnique({
            where: { id: payload.sub },
            select: { id: true, phone: true, businessName: true, status: true, listingId: true, city: true, category: true, profileCompletion: true },
          });
        } catch {
          // DB connection offline
        }
        if (!v && process.env.NODE_ENV === 'development') {
          v = { id: payload.sub, phone: '+91 99300 90487', businessName: 'Pawsome Pet Care & Clinic', status: 'ACTIVE', listingId: 'dev-listing-1', city: 'Mumbai', category: 'Veterinary Clinic', profileCompletion: 85 };
        }
        if (v) return res.json({ ok: true, role, user: v });
      } else {
        let a: any = null;
        try {
          a = await prisma.admin.findUnique({
            where: { id: payload.sub },
            select: { id: true, email: true, name: true, role: true },
          });
        } catch {
          // DB connection offline
        }
        if (!a && process.env.NODE_ENV === 'development') {
          a = { id: payload.sub, email: 'founder@pets24x7.com', name: 'Pets24x7 Founder', role: 'OWNER' };
        }
        if (a) return res.json({ ok: true, role, user: a });
      }
    }
    res.json({ ok: true, role: null, user: null });
  }),
);

meRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res, 'pet_parent');
  clearAuthCookie(res, 'vendor');
  clearAuthCookie(res, 'admin');
  res.json({ ok: true });
});
