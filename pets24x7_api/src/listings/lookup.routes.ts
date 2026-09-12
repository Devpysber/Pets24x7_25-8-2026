// Public listing lookup endpoints (used by the static frontend's JS).
//   GET /api/listings/:id          → one listing by id
//   GET /api/listings/search?q=    → name/city fuzzy (Phase 2)
//   GET /api/listings/by-phone?p=  → claim helper (rate-limited, no PII leakage)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError } from '../shared/errors.js';
import { findListingByPhone, getListingById, searchListings, indexStats, recentListings } from './index.js';
import { normalizePhone } from '../shared/phone.js';
import { prisma } from '../db.js';

export const listingsRouter = Router();

const MAX_SEARCH_RESULTS = 100;

const phoneLookupLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });

// Public directory counters. Used by the home and marketing pages, so the
// figures they print are the real ones rather than numbers typed into markup.
listingsRouter.get(
  '/_stats',
  asyncHandler(async (_req, res) => {
    const stats = indexStats();
    const [claimedListings, activeVendors] = await Promise.all([
      prisma.vendor.count({ where: { listingId: { not: null }, claimedAt: { not: null } } }).catch(() => 0),
      prisma.vendor.count({ where: { status: { in: ['ACTIVE', 'CLAIMED'] } } }).catch(() => 0),
    ]);
    res.json({ ...stats, claimedListings, activeVendors });
  }),
);

// Ranked by what people actually did, not by what we think they should like.
//
//   GET /api/listings/popular?city=&category=
//
// Counts the contact taps of the last 30 days — phone, WhatsApp, website — and
// returns the listings at the top. Views are deliberately excluded: a view is
// where the reader already was, a tap is a decision.
//
// It returns nothing until the data can carry the claim. Ranking a city on
// three taps would print a leaderboard that says more about which page a
// developer opened than about which vet people call, and once a wrong name
// sits under "most contacted" nobody trusts the next one either.
const POPULAR_WINDOW_DAYS = 30;
const POPULAR_MIN_TAPS_PER_LISTING = 3;
const POPULAR_MIN_LISTINGS = 3;
const CONTACT_KINDS = ['phone_click', 'whatsapp_click', 'website_click'];

listingsRouter.get(
  '/popular',
  asyncHandler(async (req, res) => {
    const city = String(req.query.city ?? '').trim();
    const category = String(req.query.category ?? '').trim();
    const since = new Date(Date.now() - POPULAR_WINDOW_DAYS * 24 * 3600 * 1000);

    let grouped: Array<{ listingId: string; _count: { _all: number } }> = [];
    try {
      // Prisma's groupBy overload does not narrow with a spread `where`, so the
      // call is cast and the result shape asserted below.
      const groupBy = prisma.listingActivity.groupBy as unknown as (args: unknown) => Promise<unknown>;
      grouped = (await groupBy({
        by: ['listingId'],
        where: {
          kind: { in: CONTACT_KINDS },
          createdAt: { gte: since },
          ...(city ? { city } : {}),
          ...(category ? { category } : {}),
        },
        _count: { _all: true },
        orderBy: { _count: { listingId: 'desc' } },
        take: 24,
      })) as Array<{ listingId: string; _count: { _all: number } }>;
    } catch {
      // Activity table unavailable — say nothing rather than guess.
      res.json({ ok: true, enough: false, cards: [] });
      return;
    }

    const strong = grouped.filter((g) => g._count._all >= POPULAR_MIN_TAPS_PER_LISTING);
    if (strong.length < POPULAR_MIN_LISTINGS) {
      res.json({ ok: true, enough: false, cards: [], windowDays: POPULAR_WINDOW_DAYS });
      return;
    }

    const cards = strong
      .map((g) => {
        const l = getListingById(g.listingId);
        if (!l) return null;
        return {
          id: l.id,
          name: l.name,
          category: l.category,
          categoryIcon: l.category_icon ?? null,
          city: l.city,
          state: l.state ?? null,
          address: l.address ?? null,
          phone: l.phone ?? null,
          rating: l.rating,
          reviewCount: l.review_count,
          contacts: g._count._all,
          url: `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`,
        };
      })
      .filter(Boolean)
      .slice(0, 6);

    res.json({ ok: true, enough: cards.length >= POPULAR_MIN_LISTINGS, cards, windowDays: POPULAR_WINDOW_DAYS });
  }),
);

listingsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || '';
    const category = (req.query.category as string) || '';
    const city = (req.query.city as string) || '';
    // Clamp hard: the index holds 34k rows, so an unbounded (or NaN, which
    // compares false against every ceiling) limit would serve ~15 MB per
    // request to an anonymous caller.
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_SEARCH_RESULTS) : 60;
    // `newest=1` surfaces freshly imported or edited listings first, which a
    // capped walk over 34k scraped rows would otherwise never reach.
    const newestFirst = req.query.newest === '1' || req.query.newest === 'true';
    const results = searchListings({ q, category, city, limit, newestFirst });
    res.json({ ok: true, count: results.length, listings: results });
  }),
);

// Recently added listings (imports + vendor self-registrations), newest first.
listingsRouter.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 48) : 12;
    const listings = recentListings(limit);
    res.json({ ok: true, count: listings.length, listings });
  }),
);

const ByPhoneQuery = z.object({ p: z.string().min(6) });

listingsRouter.get(
  '/by-phone',
  phoneLookupLimiter,
  asyncHandler(async (req, res) => {
    const { p } = ByPhoneQuery.parse(req.query);
    const phone = normalizePhone(p);
    const matches = findListingByPhone(phone);
    // Return only the fields needed for the claim preview — keep response slim.
    res.json({
      ok: true,
      count: matches.length,
      matches: matches.slice(0, 5).map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        city: m.city,
        state: m.state ?? '',
        country: m.country,
        address: m.address ?? '',
        rating: m.rating,
        review_count: m.review_count,
        url: `/${(m.country || 'in').toLowerCase()}/${m.city_slug}/${m.id}/`,
      })),
    });
  }),
);

// Kept last: '/:id' matches anything, so every literal path must precede it.
listingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const r = getListingById(req.params.id ?? '');
    if (!r) throw new NotFoundError('Listing not found');

    // Merge in the claimed vendor's uploaded image + verified state, if any.
    let claimed:
      | { imageUrl: string | null; status: string; businessName: string; galleryImages: string | null; about: string | null; openingHours: string | null; servicesList: string | null; website: string | null }
      | null = null;
    try {
      claimed = await prisma.vendor.findFirst({
        where: { listingId: r.id, claimedAt: { not: null } },
        select: {
          imageUrl: true,
          status: true,
          businessName: true,
          galleryImages: true,
          about: true,
          openingHours: true,
          servicesList: true,
          website: true,
        },
      });
    } catch {
      // DB offline — serve the static record as-is.
    }

    res.json({
      ok: true,
      listing: {
        ...r,
        imageUrl: claimed?.imageUrl ?? null,
        gallery: parseGallery(claimed?.galleryImages),
        about: claimed?.about ?? null,
        openingHours: claimed?.openingHours ?? null,
        servicesList: claimed?.servicesList ?? null,
        website: claimed?.website ?? r.website ?? null,
        claimed: !!claimed && (claimed.status === 'ACTIVE' || claimed.status === 'CLAIMED'),
      },
    });
  }),
);

function parseGallery(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

