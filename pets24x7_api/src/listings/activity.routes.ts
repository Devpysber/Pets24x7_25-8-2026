// Listing activity — the taps that never became an enquiry.
//
//   POST /api/activity            { listingId, kind, source? }   public, no auth
//   GET  /api/admin/activity      admin feed, newest first
//
// A pet owner who taps the phone number and calls is the most valuable thing
// that happens on a listing page, and it used to leave no trace: the enquiry
// table only ever saw the people who filled in a form. Recording the taps is
// what lets an admin answer "who contacted whom, and when", and lets a vendor
// be shown something real about their listing.
//
// Deliberately cheap and deliberately not identifying: the caller's IP is
// stored as a short salted hash, used only to collapse a double-tap, and never
// as an identity. A signed-in parent is attributed by id because they already
// have an account with us.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { asyncHandler } from '../shared/async-handler.js';
import { requireAuth } from '../auth/middleware.js';
import { getListingById } from './index.js';

export const activityRouter = Router();
export const adminActivityRouter = Router();

const KINDS = ['phone_click', 'whatsapp_click', 'website_click', 'listing_view'] as const;

const Body = z.object({
  listingId: z.string().min(1).max(191),
  kind: z.enum(KINDS),
  source: z.string().max(40).optional(),
});

/** Short, salted, truncated — enough to spot a repeat, useless as an identity. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${env.JWT_SECRET}:${ip}`).digest('hex').slice(0, 32);
}

// Generous: a page can legitimately report a view and then a tap.
const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });

activityRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = Body.parse(req.body);
    const listing = getListingById(body.listingId);
    // Unknown listing ids are dropped rather than stored: this endpoint is open,
    // and a table of arbitrary strings is not worth having.
    if (!listing) return res.status(202).json({ ok: true, recorded: false });

    const vendor = await prisma.vendor
      .findUnique({ where: { listingId: body.listingId }, select: { id: true } })
      .catch(() => null);

    const ipHash = hashIp(req.ip);
    const since = new Date(Date.now() - 60_000);

    // Collapse a double-tap into one row, so a customer with a shaky hand does
    // not read as two people calling.
    if (ipHash) {
      const recent = await prisma.listingActivity.findFirst({
        where: { listingId: body.listingId, kind: body.kind, ipHash, createdAt: { gt: since } },
        select: { id: true },
      });
      if (recent) return res.json({ ok: true, recorded: false, deduped: true });
    }

    await prisma.listingActivity.create({
      data: {
        listingId: body.listingId,
        listingName: listing.name,
        vendorId: vendor?.id ?? null,
        kind: body.kind,
        parentId: req.auth?.role === 'pet_parent' ? req.auth.sub : null,
        city: listing.city ?? null,
        category: listing.category ?? null,
        source: body.source ?? null,
        ipHash,
        userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 400) ?? null,
      },
    });

    res.json({ ok: true, recorded: true });
  }),
);

// ---------------------------------------------------------------------------
// Admin feed: enquiries and taps interleaved, so "who contacted whom" reads as
// one story rather than two tables that have to be compared by eye.
// ---------------------------------------------------------------------------
adminActivityRouter.use(requireAuth('admin'));

adminActivityRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const take = Math.min(300, Number(req.query.limit ?? 150) || 150);
    const kind = typeof req.query.kind === 'string' ? req.query.kind : '';

    const [taps, enquiries, totals] = await Promise.all([
      prisma.listingActivity.findMany({
        where: kind && kind !== 'enquiry' ? { kind } : {},
        orderBy: { createdAt: 'desc' },
        take,
      }),
      kind && kind !== 'enquiry' && kind !== 'all'
        ? Promise.resolve([])
        : prisma.enquiry.findMany({
            orderBy: { createdAt: 'desc' },
            take,
            select: {
              id: true, name: true, phone: true, email: true, listingId: true,
              listingName: true, category: true, city: true, status: true,
              createdAt: true, petParentId: true,
            },
          }),
      prisma.listingActivity.groupBy({ by: ['kind'], _count: { _all: true } }).catch(() => []),
    ]);

    // Parent names, in one query rather than one per row.
    const parentIds = [
      ...new Set([
        ...taps.map((t) => t.parentId).filter((x): x is string => !!x),
        ...enquiries.map((e) => e.petParentId).filter((x): x is string => !!x),
      ]),
    ];
    const parents = parentIds.length
      ? await prisma.petParent.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true, email: true } })
      : [];
    const parentById = new Map(parents.map((p) => [p.id, p]));

    const KIND_LABEL: Record<string, string> = {
      phone_click: 'Tapped the phone number',
      whatsapp_click: 'Tapped WhatsApp',
      website_click: 'Opened the website',
      listing_view: 'Viewed the listing',
    };

    const rows = [
      ...enquiries.map((e) => ({
        id: e.id,
        at: e.createdAt,
        kind: 'enquiry',
        action: 'Sent an enquiry',
        who: e.name || parentById.get(e.petParentId ?? '')?.name || 'Visitor',
        whoContact: e.phone || e.email || '—',
        signedIn: !!e.petParentId,
        listingId: e.listingId,
        business: e.listingName || '—',
        city: e.city,
        category: e.category,
        status: e.status,
      })),
      ...taps.map((t) => ({
        id: t.id,
        at: t.createdAt,
        kind: t.kind,
        action: KIND_LABEL[t.kind] ?? t.kind,
        who: parentById.get(t.parentId ?? '')?.name || 'Visitor',
        whoContact: parentById.get(t.parentId ?? '')?.email || '—',
        signedIn: !!t.parentId,
        listingId: t.listingId,
        business: t.listingName || '—',
        city: t.city,
        category: t.category,
        status: null,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, take);

    const counts: Record<string, number> = { enquiry: enquiries.length };
    for (const t of totals as Array<{ kind: string; _count: { _all: number } }>) counts[t.kind] = t._count._all;

    res.json({ ok: true, rows, counts });
  }),
);
