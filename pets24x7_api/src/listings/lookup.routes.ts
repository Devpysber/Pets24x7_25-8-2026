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

