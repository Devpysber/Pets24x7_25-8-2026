// Public listing lookup endpoints (used by the static frontend's JS).
//   GET /api/listings/:id          → one listing by id
//   GET /api/listings/search?q=    → name/city fuzzy (Phase 2)
//   GET /api/listings/by-phone?p=  → claim helper (rate-limited, no PII leakage)
//
// A listing an admin has hidden (listings.hidden) is absent from all of these:
// search/recent skip it, popular drops it, by-phone leaves it out and /:id 404s.

import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { NotFoundError } from '../shared/errors.js';
import { findPublicListingsByPhone, getPublicListingById, searchListingsPage, indexStats, recentListings, publicListing, publicName, shownRating } from './index.js';
import { parsePhotos } from './photos.js';
import { normalizePhone } from '../shared/phone.js';
import { prisma } from '../db.js';
import { isVendorApproved } from '../shared/vendor-status.js';

export const listingsRouter = Router();

const MAX_SEARCH_RESULTS = 100;

const phoneLookupLimiter = makeLimiter('listing-phone-lookup', { windowMs: 60_000, max: 10, standardHeaders: true });

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

// Every generated city/category page asks for this on load, and the answer
// only moves as taps accumulate over 30 days — so it is cached briefly per
// (city, category) instead of re-running the groupBy for every page view.
const POPULAR_CACHE_MS = 5 * 60 * 1000;
const POPULAR_CACHE_MAX = 2000;
const popularCache = new Map<string, { at: number; body: unknown }>();

/** Drops the cached leaderboards (after an admin hides a listing). */
export function clearPopularCache(): void {
  popularCache.clear();
}

listingsRouter.get(
  '/popular',
  asyncHandler(async (req, res) => {
    const city = (typeof req.query.city === 'string' ? req.query.city : '').trim().slice(0, 160);
    const category = (typeof req.query.category === 'string' ? req.query.category : '').trim().slice(0, 160);
    const cacheKey = `${city.toLowerCase()}|${category.toLowerCase()}`;
    const hit = popularCache.get(cacheKey);
    if (hit && Date.now() - hit.at < POPULAR_CACHE_MS) {
      res.json(hit.body);
      return;
    }
    const remember = (body: unknown) => {
      if (popularCache.size >= POPULAR_CACHE_MAX) {
        // Oldest first: a Map iterates in insertion order.
        const oldest = popularCache.keys().next().value;
        if (oldest !== undefined) popularCache.delete(oldest);
      }
      popularCache.set(cacheKey, { at: Date.now(), body });
      res.json(body);
    };
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
      remember({ ok: true, enough: false, cards: [], windowDays: POPULAR_WINDOW_DAYS });
      return;
    }

    const cards = strong
      .map((g) => {
        const l = getPublicListingById(g.listingId);
        if (!l) return null;
        return {
          id: l.id,
          name: publicName(l.name),
          category: l.category,
          categoryIcon: l.category_icon ?? null,
          city: l.city,
          state: l.state ?? null,
          address: null,
          phone: null,
          rating: shownRating(l),
          reviewCount: l.review_count,
          contacts: g._count._all,
          url: `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`,
        };
      })
      .filter(Boolean)
      .slice(0, 6);

    remember({ ok: true, enough: cards.length >= POPULAR_MIN_LISTINGS, cards, windowDays: POPULAR_WINDOW_DAYS });
  }),
);

// Query strings are untrusted: ?q[]=a&q[]=b arrives as an array and used to
// throw inside .toLowerCase() (a 500). Anything that is not a plain string is
// read as empty; lengths are capped so a 1 MB "q" cannot drive the scan.
const qs = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string().max(max).catch(''));
const SearchQuery = z.object({
  q: qs(200),
  category: qs(120),
  city: qs(120),
  citySlug: qs(160),
  country: qs(4),
  newest: qs(8),
  limit: qs(8),
  offset: qs(8),
});

listingsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const query = SearchQuery.parse(req.query);
    // Clamp hard: the index holds 34k rows, so an unbounded (or NaN, which
    // compares false against every ceiling) limit would serve ~15 MB per
    // request to an anonymous caller.
    const raw = Number(query.limit || NaN);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_SEARCH_RESULTS) : 60;
    // Paging: `offset` matches are skipped; `hasMore` says whether to ask again.
    const rawOffset = Number(query.offset || 0);
    const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), 5_000) : 0;
    // `newest=1` surfaces freshly imported or edited listings first, which a
    // capped walk over 34k scraped rows would otherwise never reach.
    const newestFirst = query.newest === '1' || query.newest === 'true';
    const { listings, hasMore } = searchListingsPage({
      q: query.q,
      category: query.category,
      city: query.city,
      citySlug: query.citySlug,
      country: query.country,
      limit,
      offset,
      newestFirst,
    });
    res.json({
      ok: true,
      count: listings.length,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + listings.length : null,
      listings: listings.map(publicListing),
    });
  }),
);

// Recently added listings (imports + vendor self-registrations), newest first.
listingsRouter.get(
  '/recent',
  asyncHandler(async (req, res) => {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 48) : 12;
    const listings = recentListings(limit);
    res.json({ ok: true, count: listings.length, listings: listings.map(publicListing) });
  }),
);

const ByPhoneQuery = z.object({ p: z.string().min(6) });

listingsRouter.get(
  '/by-phone',
  phoneLookupLimiter,
  asyncHandler(async (req, res) => {
    const { p } = ByPhoneQuery.parse(req.query);
    const phone = normalizePhone(p);
    const matches = findPublicListingsByPhone(phone);
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
        address: '',  // contact details stay with Pets24x7 (see publicListing)
        rating: shownRating(m),
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
    const r = getPublicListingById(req.params.id ?? '');
    if (!r) throw new NotFoundError('Listing not found');

    // Directory detail kept in the table only (admin form / import).
    let detail:
      | { description: string | null; openingHours: string | null; services: string | null; whatsapp: string | null; locality: string | null; photos: unknown; hidden: boolean }
      | null = null;
    try {
      detail = await prisma.listing.findUnique({
        where: { id: r.id },
        select: { description: true, openingHours: true, services: true, whatsapp: true, locality: true, photos: true, hidden: true },
      });
    } catch {
      // DB offline — the index record alone.
    }
    // Hidden by another instance since this one last synced.
    if (detail?.hidden) throw new NotFoundError('Listing not found');

    // Merge in the claimed vendor's uploaded image + verified state, if any.
    let claimed:
      | { imageUrl: string | null; status: string; businessName: string; galleryImages: string | null; about: string | null; openingHours: string | null; servicesList: string | null; website: string | null; whatsapp: string | null; phone: string }
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
          whatsapp: true,
          phone: true,
        },
      });
    } catch {
      // DB offline — serve the static record as-is.
    }
    // A suspended or rejected account (or a claim still awaiting approval) must
    // not keep its photos and copy on the public page.
    if (claimed && !isVendorApproved(claimed.status)) claimed = null;

    // Photos: the verified business's own, when it has any; otherwise the ones
    // an admin attached to the directory listing. Never a mix of the two.
    const vendorPhotos = claimed ? [claimed.imageUrl, ...parseGallery(claimed.galleryImages)].filter((x): x is string => !!x) : [];
    const listingPhotos = parsePhotos(detail?.photos);
    const photos = vendorPhotos.length ? vendorPhotos : listingPhotos;
    const photosFrom = vendorPhotos.length ? 'vendor' : listingPhotos.length ? 'listing' : null;

    res.json({
      ok: true,
      listing: {
        ...publicListing(r),
        // imageUrl + gallery keep their old meaning (cover, then the rest) so
        // existing pages show admin photos without a change.
        imageUrl: vendorPhotos.length ? claimed?.imageUrl ?? null : photos[0] ?? null,
        gallery: vendorPhotos.length ? parseGallery(claimed?.galleryImages) : photos.slice(1),
        photos,
        photosFrom,
        // A verified business's own copy wins; the directory's fills the gap.
        about: claimed?.about || detail?.description || null,
        openingHours: claimed?.openingHours || detail?.openingHours || null,
        servicesList: claimed?.servicesList || detail?.services || null,
        locality: detail?.locality ?? null,
        // Contact details stay with the platform (see publicListing): every
        // enquiry, claimed listing or not, goes through Pets24x7.
        website: null,
        whatsapp: null,
        claimed: !!claimed,
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

