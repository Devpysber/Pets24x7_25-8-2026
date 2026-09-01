// Public listing lookup endpoints (used by the static frontend's JS).
//   GET /api/listings/:id          → one listing by id
//   GET /api/listings/search?q=    → name/city fuzzy (Phase 2)
//   GET /api/listings/by-phone?p=  → claim helper (rate-limited, no PII leakage)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError } from '../shared/errors.js';
import { findListingByPhone, getListingById, searchListings, indexStats } from './index.js';
import { normalizePhone } from '../shared/phone.js';
import { prisma } from '../db.js';

export const listingsRouter = Router();

const MAX_SEARCH_RESULTS = 100;

const phoneLookupLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });

listingsRouter.get('/_stats', (_req, res) => res.json(indexStats()));

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
    const results = searchListings({ q, category, city, limit });
    res.json({ ok: true, count: results.length, listings: results });
  }),
);

listingsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const r = getListingById(req.params.id ?? '');
    if (!r) throw new NotFoundError('Listing not found');

    // Merge in the claimed vendor's uploaded image + verified state, if any.
    let claimed: { imageUrl: string | null; status: string; businessName: string } | null = null;
    try {
      claimed = await prisma.vendor.findUnique({
        where: { listingId: r.id },
        select: { imageUrl: true, status: true, businessName: true },
      });
    } catch {
      // DB offline — serve the static record as-is.
    }

    res.json({
      ok: true,
      listing: {
        ...r,
        imageUrl: claimed?.imageUrl ?? null,
        claimed: !!claimed && claimed.status === 'ACTIVE',
      },
    });
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
