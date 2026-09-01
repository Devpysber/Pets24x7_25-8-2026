// Public "nearby feed" — deals + events shown on the site and the pet-parent
// dashboard. No auth.
//
//   GET /api/deals?city=&category=&limit=
//   GET /api/events?city=&limit=          (upcoming only, soonest first)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { prisma } from '../db.js';
import { asyncHandler } from '../shared/async-handler.js';

export const feedRouter = Router();

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

feedRouter.get(
  '/deals',
  limiter,
  asyncHandler(async (req, res) => {
    const city = String(req.query.city ?? '').trim();
    const category = String(req.query.category ?? '').trim().toLowerCase();
    const limit = Math.min(60, Number(req.query.limit ?? 30) || 30);
    const now = new Date();

    let deals: any[] = [];
    try {
      deals = await prisma.deal.findMany({
        where: {
          status: 'ACTIVE',
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          ...(city ? { citySlug: slugify(city) } : {}),
          ...(category ? { category: { contains: category, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ endsAt: 'asc' }, { createdAt: 'desc' }],
        take: limit,
        include: { vendor: { select: { businessName: true, listingId: true } } },
      });
    } catch {
      // DB offline
    }
    res.json({
      ok: true,
      deals: deals.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        offerLabel: d.offerLabel,
        category: d.category,
        city: d.city,
        code: d.code,
        endsAt: d.endsAt,
        vendor: d.vendor?.businessName ?? null,
        listingId: d.listingId ?? d.vendor?.listingId ?? null,
      })),
    });
  }),
);

feedRouter.get(
  '/events',
  limiter,
  asyncHandler(async (req, res) => {
    const city = String(req.query.city ?? '').trim();
    const limit = Math.min(60, Number(req.query.limit ?? 30) || 30);
    const now = new Date();

    let events: any[] = [];
    try {
      events = await prisma.event.findMany({
        where: {
          status: 'PUBLISHED',
          startsAt: { gt: now },
          ...(city ? { citySlug: slugify(city) } : {}),
        },
        orderBy: { startsAt: 'asc' },
        take: limit,
        include: { vendor: { select: { businessName: true } } },
      });
    } catch {
      // DB offline
    }
    res.json({
      ok: true,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        venue: e.venue,
        city: e.city,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        rsvpUrl: e.rsvpUrl,
        bannerUrl: e.bannerUrl,
        vendor: e.vendor?.businessName ?? null,
      })),
    });
  }),
);
