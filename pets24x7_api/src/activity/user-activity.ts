// User activity log — "who did what", for the admin panel's User Activity tab.
//
// Three sources feed one table (user_activity):
//
//  1. userActivityMiddleware, mounted on /api. After each response it records
//     sign-ins (spotted from the auth cookie the response sets, so every login
//     route — OTP, email, Google, vendor, admin — is covered without touching
//     them), sign-outs, and every successful change a signed-in person makes
//     (POST/PUT/PATCH/DELETE). Reads (GET) are not logged here.
//  2. POST /api/activity/track, called by /nav-auth.js on the public site:
//     page views by signed-in people, contact taps, and "contact_locked" — a
//     signed-out visitor tapping a phone number or WhatsApp button.
//  3. recordUserActivity(), for anything else that wants a row.
//
// Writes are fire-and-forget: a logging failure never fails the request.

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { verifyToken, readAuthCookie, type ActorRole } from '../auth/jwt.js';

export interface ActivityEntry {
  actorRole?: ActorRole | null;
  actorId?: string | null;
  action: string;
  label?: string | null;
  method?: string | null;
  path?: string | null;
  listingId?: string | null;
  status?: number | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Short, salted, truncated — enough to group one visitor's rows, useless as an identity. */
export function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${env.JWT_SECRET}:${ip}`).digest('hex').slice(0, 32);
}

const ROLES: ActorRole[] = ['pet_parent', 'vendor', 'admin'];
const COOKIE_ROLE: Record<string, ActorRole> = { p24_parent: 'pet_parent', p24_vendor: 'vendor', p24_admin: 'admin' };

/**
 * Who is calling. Uses req.auth when a route guard already resolved it;
 * otherwise the first valid auth cookie (signature + expiry checked, no
 * database round trip — this is for attribution in a log, not access control).
 */
export function identifyCaller(req: Request): { role: ActorRole; id: string } | null {
  if (req.auth) return { role: req.auth.role, id: req.auth.sub };
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const p = verifyToken(header.slice(7));
    if (p) return { role: p.role, id: p.sub };
  }
  for (const role of ROLES) {
    const tok = readAuthCookie(req.cookies ?? {}, role);
    if (!tok) continue;
    const p = verifyToken(tok);
    if (p && p.role === role) return { role, id: p.sub };
  }
  return null;
}

export function recordUserActivity(e: ActivityEntry): void {
  prisma.userActivity
    .create({
      data: {
        actorRole: e.actorRole ?? null,
        actorId: e.actorId ?? null,
        action: e.action.slice(0, 32),
        label: e.label ? e.label.slice(0, 255) : null,
        method: e.method ?? null,
        path: e.path ? e.path.slice(0, 512) : null,
        listingId: e.listingId ? e.listingId.slice(0, 191) : null,
        status: e.status ?? null,
        meta: (e.meta ?? undefined) as any,
        ipHash: hashIp(e.ip),
        userAgent: e.userAgent ? e.userAgent.slice(0, 400) : null,
      },
    })
    .catch((err) => logger.warn({ err, action: e.action }, 'user activity write failed'));
}

// ---------------------------------------------------------------------------
// Readable labels for API changes. First match wins; anything unlisted is
// logged as "METHOD /path" so nothing is silently dropped.
// ---------------------------------------------------------------------------
const LABELS: Array<[string, RegExp, string]> = [
  ['POST', /^\/api\/enquiries\/?$/, 'Sent an enquiry'],
  ['POST', /^\/api\/parent\/pets\/?$/, 'Added a pet'],
  ['PATCH', /^\/api\/parent\/pets\/[^/]+$/, 'Updated a pet'],
  ['DELETE', /^\/api\/parent\/pets\/[^/]+$/, 'Removed a pet'],
  ['POST', /^\/api\/parent\/saved\/?$/, 'Saved a listing'],
  ['DELETE', /^\/api\/parent\/saved\/[^/]+$/, 'Removed a saved listing'],
  ['PATCH', /^\/api\/parent\/profile\/?$/, 'Updated their profile'],
  ['POST', /^\/api\/parent\/profile\/phone-otp$/, 'Requested a phone verification code'],
  ['POST', /\/request-otp$|\/otp\/request$/, 'Requested a sign-in code'],
  ['POST', /\/email\/forgot$/, 'Asked for a password reset'],
  ['POST', /\/email\/reset$/, 'Reset their password'],
  ['POST', /\/change-password$|\/first-login-change-password$/, 'Changed their password'],
  ['POST', /^\/api\/memberships\/checkout$/, 'Started membership checkout'],
  ['POST', /^\/api\/memberships\/cancel$/, 'Cancelled membership'],
  ['POST', /^\/api\/memberships\/resume$/, 'Resumed membership'],
  ['POST', /^\/api\/reviews\/listing\/[^/]+$/, 'Wrote a review'],
  ['POST', /^\/api\/reviews\/[^/]+\/submit$/, 'Submitted a review'],
  ['PATCH', /^\/api\/vendor\/profile\/?$/, 'Edited business profile'],
  ['PATCH', /^\/api\/vendor\/my-business\/?$/, 'Edited business listing'],
  ['PATCH', /^\/api\/vendor\/enquiries\/[^/]+$/, 'Updated an enquiry'],
  ['POST', /^\/api\/vendor\/services\/?$/, 'Added a service'],
  ['PATCH', /^\/api\/vendor\/services\/[^/]+$/, 'Updated a service'],
  ['DELETE', /^\/api\/vendor\/services\/[^/]+$/, 'Removed a service'],
  ['POST', /^\/api\/vendor\/campaigns\/?$/, 'Created a campaign'],
  ['POST', /^\/api\/vendor\/featured\/?$/, 'Bought a featured slot'],
  ['POST', /^\/api\/vendor\/subscriptions\/checkout$/, 'Started plan checkout'],
  ['POST', /^\/api\/vendor\/reviews\/requests\/bulk$/, 'Sent review requests'],
  ['PATCH', /^\/api\/vendor\/reviews\/[^/]+\/reply$/, 'Replied to a review'],
  ['POST', /^\/api\/vendor\/register-business$/, 'Registered a business'],
  ['POST', /^\/api\/vendor\/claim\/submit-email$/, 'Submitted a listing claim'],
  ['DELETE', /^\/api\/vendor\/plan-featured\/[^/]+$/, 'Moved a Featured placement'],
  ['POST', /^\/api\/vendor\/plan-featured\/?$/, 'Placed a Featured placement'],
  // Admin panel
  ['DELETE', /^\/api\/admin\/parents\/[^/]+$/, 'Deleted a pet parent'],
  ['DELETE', /^\/api\/admin\/vendors\/[^/]+$/, 'Deleted a business account'],
  ['DELETE', /^\/api\/admin\/listings\/[^/]+\/photos\/[^/]+$/, 'Deleted a listing photo'],
  ['DELETE', /^\/api\/admin\/listings\/[^/]+$/, 'Deleted a directory listing'],
  ['DELETE', /^\/api\/admin\/deals\/[^/]+$/, 'Deleted a deal'],
  ['DELETE', /^\/api\/admin\/events\/[^/]+$/, 'Deleted an event'],
  ['POST', /^\/api\/admin\/trash\/[^/]+\/restore$/, 'Restored a deleted record'],
  ['DELETE', /^\/api\/admin\/trash\/[^/]+$/, 'Permanently removed a deleted record'],
  ['POST', /^\/api\/admin\/vendors\/[^/]+\/status$/, 'Changed a business status'],
  ['POST', /^\/api\/admin\/subscriptions\/vendor-subscribers\/[^/]+\/status$/, 'Changed a business plan status'],
  ['PUT', /^\/api\/admin\/plan-limits$/, 'Changed plan limits'],
  ['POST', /^\/api\/admin\/plan-limits\/notice$/, 'Emailed Basic businesses'],
  ['POST', /^\/api\/admin\/publish/, 'Published the website'],
];

// Anything else in the admin panel: "Updated reviews", "Created featured", …
function adminLabel(method: string, path: string): string | null {
  const m = /^\/api\/admin\/([a-z-]+)/.exec(path);
  if (!m) return null;
  const what = (m[1] ?? '').replace(/-/g, ' ');
  const verb = method === 'DELETE' ? 'Deleted' : method === 'POST' ? 'Created / ran' : 'Updated';
  return `${verb} ${what} (admin)`;
}

export function labelFor(method: string, path: string): string {
  for (const [m, re, label] of LABELS) if (m === method && re.test(path)) return label;
  return adminLabel(method, path) ?? `${method} ${path}`;
}

// Machine traffic and the tracking endpoints themselves (they write their own rows).
const SKIP = /^\/api\/(activity|reco\/events|payments\/razorpay\/webhook|whatsapp)(\/|$)/;
const SIGN_OUT = /^\/api\/(me\/logout(-all)?|admin\/logout)$/;
// Signed-out requests worth a row: enquiries are the one change visitors make.
const ANON_OK = /^\/api\/enquiries\/?$/;

/** Auth cookies this response sets (a login), as { role, id }. */
function signedInBy(res: Response): { role: ActorRole; id: string } | null {
  const raw = res.getHeader('set-cookie');
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of list) {
    const m = /^(p24_parent|p24_vendor|p24_admin)=([^;]+)/.exec(c);
    const name = m?.[1], value = m?.[2];
    if (!name || !value) continue;
    const p = verifyToken(decodeURIComponent(value));
    if (p && p.role === COOKIE_ROLE[name]) return { role: p.role, id: p.sub };
  }
  return null;
}

export function userActivityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = (req.originalUrl || req.url).split('?')[0] ?? '';
  if (SKIP.test(path)) return next();

  // Taken now: a sign-out clears the cookie before the response finishes.
  const before = identifyCaller(req);

  res.on('finish', () => {
    try {
      const base = {
        method,
        path,
        status: res.statusCode,
        ip: req.ip,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      };

      // A password change re-issues the cookie too; that is not a sign-in.
      const login = res.statusCode < 400 && !/password|reset/.test(path) ? signedInBy(res) : null;
      if (login) {
        const isNew = /register|signup|claim\/submit/.test(path);
        recordUserActivity({
          ...base, actorRole: login.role, actorId: login.id, action: 'sign_in',
          label: isNew ? 'Signed up' : 'Signed in',
        });
        return;
      }

      if (SIGN_OUT.test(path)) {
        if (before) recordUserActivity({ ...base, actorRole: before.role, actorId: before.id, action: 'sign_out', label: 'Signed out' });
        return;
      }

      if (res.statusCode >= 400) return;
      const who = req.auth ? { role: req.auth.role, id: req.auth.sub } : before;
      if (!who && !ANON_OK.test(path)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const listingId = typeof body.listingId === 'string' ? body.listingId : null;
      recordUserActivity({
        ...base,
        actorRole: who?.role ?? null,
        actorId: who?.id ?? null,
        action: 'action',
        label: labelFor(method, path),
        listingId,
        meta: listingId && typeof body.listingName === 'string' ? { listingName: body.listingName } : null,
      });
    } catch (err) {
      logger.warn({ err }, 'user activity middleware failed');
    }
  });
  next();
}

// ---------------------------------------------------------------------------
// Retention: rows older than RETAIN_DAYS are deleted once a day. Idempotent,
// so several API instances running it at once is harmless.
// ---------------------------------------------------------------------------
const RETAIN_DAYS = 180;

export function startUserActivityPrune(): void {
  const run = () => {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000);
    prisma.userActivity
      .deleteMany({ where: { createdAt: { lt: cutoff } } })
      .then((r) => { if (r.count) logger.info({ deleted: r.count }, 'pruned old user activity'); })
      .catch((err) => logger.warn({ err }, 'user activity prune failed'));
  };
  setTimeout(run, 60_000).unref?.();
  setInterval(run, 24 * 3_600_000).unref?.();
}
