// User activity endpoints.
//
//   POST /api/activity/track        public; the site's contact lock and page-view beacon
//   GET  /api/admin/user-activity   admin feed: who did what, newest first
//
// See user-activity.ts for what gets recorded and why.

import express, { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../db.js';
import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { requireAuth } from '../auth/middleware.js';
import { getPublicListingById } from '../listings/index.js';
import { identifyCaller, labelFor, recordUserActivity } from './user-activity.js';

export const userActivityTrackRouter = Router();
export const adminUserActivityRouter = Router();

const TRACK_ACTIONS = ['page_view', 'contact_locked', 'phone_click', 'whatsapp_click', 'gate_sign_in', 'plan_limit'] as const;

const TRACK_LABEL: Record<(typeof TRACK_ACTIONS)[number], string> = {
  page_view: 'Opened a page',
  contact_locked: 'Tried to see contact details while signed out',
  phone_click: 'Tapped a phone number',
  whatsapp_click: 'Tapped WhatsApp',
  gate_sign_in: 'Went to sign in from the contact lock',
  plan_limit: 'Hit the monthly contact limit of their plan',
};

// Actions a signed-out visitor may report. Anonymous page views are not kept.
const ANON_ACTIONS = new Set(['contact_locked', 'gate_sign_in']);

const TrackBody = z.object({
  action: z.enum(TRACK_ACTIONS),
  path: z.string().max(512).optional(),
  title: z.string().max(200).optional(),
  listingId: z.string().max(191).optional(),
  // What was tapped: "phone" | "whatsapp" | "form"
  target: z.string().max(20).optional(),
});

const trackLimiter = makeLimiter('user-activity-track', { windowMs: 60_000, max: 60, standardHeaders: true });

userActivityTrackRouter.post(
  '/track',
  trackLimiter,
  express.text({ type: 'text/plain', limit: '4kb' }),
  asyncHandler(async (req, res) => {
    // sendBeacon posts text/plain, which express.json() leaves as a string.
    const raw = typeof req.body === 'string' ? safeJson(req.body) : req.body;
    const parsed = TrackBody.safeParse(raw);
    if (!parsed.success) return res.status(400).json({ ok: false, error: 'bad_event' });
    const body = parsed.data;

    const who = identifyCaller(req);
    if (!who && !ANON_ACTIONS.has(body.action)) return res.status(202).json({ ok: true, recorded: false });

    const listing = body.listingId ? getPublicListingById(body.listingId) : undefined;
    const path = body.path ? body.path.split('#')[0] : null;

    // A reload or back-and-forth should not read as two visits.
    if (body.action === 'page_view' && who) {
      const recent = await prisma.userActivity.findFirst({
        where: {
          actorRole: who.role, actorId: who.id, action: 'page_view', path,
          createdAt: { gt: new Date(Date.now() - 30_000) },
        },
        select: { id: true },
      });
      if (recent) return res.json({ ok: true, recorded: false, deduped: true });
    }

    recordUserActivity({
      actorRole: who?.role ?? null,
      actorId: who?.id ?? null,
      action: body.action,
      label: TRACK_LABEL[body.action],
      path,
      listingId: listing ? listing.id : null,
      meta: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.target ? { target: body.target } : {}),
        ...(listing ? { listingName: listing.name, city: listing.city ?? null } : {}),
      },
      ip: req.ip,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    res.json({ ok: true, recorded: true });
  }),
);

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Admin feed
// ---------------------------------------------------------------------------
adminUserActivityRouter.use('/user-activity', requireAuth('admin'));

type ActorKey = `${string}:${string}`;

async function actorDetails(keys: Array<{ role: string | null; id: string | null }>) {
  const ids = (role: string) => [...new Set(keys.filter((k) => k.role === role && k.id).map((k) => k.id as string))];
  const [parents, vendors, admins] = await Promise.all([
    ids('pet_parent').length
      ? prisma.petParent.findMany({ where: { id: { in: ids('pet_parent') } }, select: { id: true, name: true, email: true, phone: true } })
      : [],
    ids('vendor').length
      ? prisma.vendor.findMany({ where: { id: { in: ids('vendor') } }, select: { id: true, businessName: true, email: true, phone: true } })
      : [],
    ids('admin').length
      ? prisma.admin.findMany({ where: { id: { in: ids('admin') } }, select: { id: true, name: true, email: true } })
      : [],
  ]);
  const map = new Map<ActorKey, { name: string; email: string | null; phone: string | null }>();
  for (const p of parents) map.set(`pet_parent:${p.id}`, { name: p.name, email: p.email, phone: p.phone });
  for (const v of vendors) map.set(`vendor:${v.id}`, { name: v.businessName, email: v.email, phone: v.phone });
  for (const a of admins) map.set(`admin:${a.id}`, { name: a.name, email: a.email, phone: null });
  return map;
}

/** "Chrome on Android" from a user agent — enough to tell devices apart. */
function device(ua: string | null): string {
  if (!ua) return '—';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

const ROLE_FILTER = ['pet_parent', 'vendor', 'admin', 'visitor'] as const;

adminUserActivityRouter.get(
  '/user-activity',
  asyncHandler(async (req, res) => {
    const take = Math.max(1, Math.min(500, Math.trunc(Number(req.query.limit ?? 200)) || 200));
    const role = String(req.query.role ?? '');
    const action = String(req.query.action ?? '').slice(0, 32);
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const actorId = String(req.query.actorId ?? '').slice(0, 191);
    const beforeRaw = String(req.query.before ?? '');
    const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;

    const where: Prisma.UserActivityWhereInput = {};
    if ((ROLE_FILTER as readonly string[]).includes(role)) where.actorRole = role === 'visitor' ? null : role;
    if (action) where.action = action;
    if (actorId) where.actorId = actorId;
    if (before) where.createdAt = { lt: before };

    // Free-text search over the people behind the rows (name, email, phone).
    if (q) {
      const [p, v, a] = await Promise.all([
        prisma.petParent.findMany({
          where: { OR: [{ name: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] },
          select: { id: true }, take: 200,
        }),
        prisma.vendor.findMany({
          where: { OR: [{ businessName: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] },
          select: { id: true }, take: 200,
        }),
        prisma.admin.findMany({
          where: { OR: [{ name: { contains: q } }, { email: { contains: q } }] },
          select: { id: true }, take: 50,
        }),
      ]);
      where.OR = [
        { actorRole: 'pet_parent', actorId: { in: p.map((x) => x.id) } },
        { actorRole: 'vendor', actorId: { in: v.map((x) => x.id) } },
        { actorRole: 'admin', actorId: { in: a.map((x) => x.id) } },
        { label: { contains: q } },
        { path: { contains: q } },
      ];
    }

    const dayAgo = new Date(Date.now() - 86_400_000);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);

    const [rows, byAction, activeToday, top] = await Promise.all([
      prisma.userActivity.findMany({ where, orderBy: { createdAt: 'desc' }, take }),
      prisma.userActivity.groupBy({ by: ['action'], where: { createdAt: { gt: dayAgo } }, _count: { _all: true } }).catch(() => []),
      prisma.userActivity
        .groupBy({ by: ['actorRole', 'actorId'], where: { createdAt: { gt: dayAgo }, actorId: { not: null } } })
        .then((g) => g.length)
        .catch(() => 0),
      prisma.userActivity
        .groupBy({
          by: ['actorRole', 'actorId'],
          where: { createdAt: { gt: weekAgo }, actorId: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { actorId: 'desc' } },
          take: 10,
        })
        .catch(() => []),
    ]);

    const people = await actorDetails([
      ...rows.map((r) => ({ role: r.actorRole, id: r.actorId })),
      ...(top as Array<{ actorRole: string | null; actorId: string | null }>).map((t) => ({ role: t.actorRole, id: t.actorId })),
    ]);

    const out = rows.map((r) => {
      const person = r.actorRole && r.actorId ? people.get(`${r.actorRole}:${r.actorId}`) : undefined;
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const listing = r.listingId ? getPublicListingById(r.listingId) : undefined;
      return {
        id: r.id,
        at: r.createdAt,
        role: r.actorRole ?? 'visitor',
        actorId: r.actorId,
        who: person?.name ?? (r.actorRole ? '(deleted account)' : `Visitor ${r.ipHash ? r.ipHash.slice(0, 6) : ''}`.trim()),
        email: person?.email ?? null,
        phone: person?.phone ?? null,
        action: r.action,
        // Rows stored before a route had a readable label ("DELETE /api/…")
        // are put into words with today's labels.
        label: r.label && /^(POST|PUT|PATCH|DELETE) \//.test(r.label) && r.method && r.path ? labelFor(r.method, r.path) : r.label ?? r.action,
        path: r.path,
        method: r.method,
        status: r.status,
        listingId: r.listingId,
        listingName: listing?.name ?? (typeof meta.listingName === 'string' ? meta.listingName : null),
        title: typeof meta.title === 'string' ? meta.title : null,
        target: typeof meta.target === 'string' ? meta.target : null,
        device: device(r.userAgent),
      };
    });

    const counts: Record<string, number> = {};
    for (const g of byAction as Array<{ action: string; _count: { _all: number } }>) counts[g.action] = g._count._all;

    const topUsers = (top as Array<{ actorRole: string | null; actorId: string | null; _count: { _all: number } }>).map((t) => {
      const person = people.get(`${t.actorRole}:${t.actorId}` as ActorKey);
      return {
        role: t.actorRole, actorId: t.actorId, events: t._count._all,
        who: person?.name ?? '(deleted account)', email: person?.email ?? null, phone: person?.phone ?? null,
      };
    });

    res.json({
      ok: true,
      rows: out,
      counts24h: counts,
      activePeople24h: activeToday,
      topUsers7d: topUsers,
      nextBefore: out.length === take ? out[out.length - 1]!.at : null,
    });
  }),
);
