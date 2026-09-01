// GET  /api/me             → returns whichever role is signed in (parent | vendor | admin)
// POST /api/me/logout       → clears all auth cookies in this browser (idempotent)
// POST /api/me/logout-all   → also revokes every token already issued for those accounts

import { Router } from 'express';
import { prisma } from '../db.js';
import { readAuthCookie, verifyToken, clearAuthCookie, type ActorRole } from './jwt.js';
import { asyncHandler } from '../shared/async-handler.js';
import { revokeSessions } from './actor.js';

export const meRouter = Router();

const ROLES: ActorRole[] = ['admin', 'vendor', 'pet_parent'];

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const cookies = (req.cookies ?? {}) as Record<string, string>;
    // Optional ?role= scopes the lookup to one actor. Without it a stale
    // higher-priority cookie (e.g. an old admin session) shadows the session
    // the caller actually just created, and role-guarded dashboards bounce
    // their freshly signed-in user straight back to the login page.
    const wanted = String(req.query.role ?? '') as ActorRole | '';
    const all: ActorRole[] = ['admin', 'vendor', 'pet_parent']; // priority order
    const roles: ActorRole[] = all.includes(wanted as ActorRole) ? [wanted as ActorRole] : all;
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
        if (v && (v.status === 'SUSPENDED' || v.status === 'REJECTED')) {
          // Signed in, but not allowed to act — say so instead of handing back
          // a session the rest of the API will refuse.
          clearAuthCookie(res, 'vendor');
          return res.json({ ok: true, role: null, user: null, disabled: v.status });
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

// Sign out of every device. Clearing a cookie only stops this browser; a token
// copied elsewhere stays valid for its full 30 days unless the account's
// sessionsRevokedAt moves past it.
meRouter.post(
  '/logout-all',
  asyncHandler(async (req, res) => {
    const revoked: ActorRole[] = [];
    for (const role of ROLES) {
      const token = readAuthCookie(req.cookies ?? {}, role);
      if (!token) continue;
      const payload = verifyToken(token);
      if (!payload || payload.role !== role) continue;
      await revokeSessions(role, payload.sub);
      revoked.push(role);
    }
    clearAuthCookie(res, 'pet_parent');
    clearAuthCookie(res, 'vendor');
    clearAuthCookie(res, 'admin');
    res.json({ ok: true, revoked });
  }),
);
