// Recommendation API — mounted at /api/reco.
//
//   GET  /parent           personalised list for a pet parent (anonymous → base ranking)
//   GET  /parent/feed      deals + events ranked for this parent
//   GET  /listing/:id      "similar", "also nearby" and one sponsored card for a listing page
//   GET  /city             home / city / category rails, and the search page's sponsored card
//   POST /events           impression + click beacons (JSON or text/plain for sendBeacon)
//   GET  /vendor           growth actions, performance and benchmark for the signed-in vendor
//
// Personalised responses are private, no-store. Public ones are cacheable for
// five minutes: their rid is derived from the parameters and the 5-minute
// bucket, so a CDN copy still reports impressions against a valid rid.

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { optionalAuth, requireAuth } from '../../auth/middleware.js';
import { asyncHandler } from '../../shared/async-handler.js';
import { makeLimiter } from '../../shared/rate-limit.js';
import { forCity, forListing, forParent, parentFeed } from './service.js';
import { ingestEvents, isReasonCode } from './events.js';
import { isBotUA, viewerKeyFor } from './util.js';
import { vendorInsights } from './vendor-insights.js';

export const recoRouter = Router();

const publicLimiter = makeLimiter('reco-public', { windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

function viewer(req: Request): string {
  const parentId = req.auth?.role === 'pet_parent' ? req.auth.sub : null;
  return viewerKeyFor(parentId, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 200));
}

function isBot(req: Request): boolean {
  return isBotUA(String(req.headers['user-agent'] ?? ''));
}

function privateNoStore(res: Response): void {
  res.set('Cache-Control', 'private, no-store');
}

function publicCache(res: Response): void {
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
}

const country = z
  .string()
  .max(2)
  .optional()
  .transform((v) => (v ? v.toUpperCase() : undefined))
  .refine((v) => v === undefined || v === 'IN' || v === 'US', { message: "country must be 'IN' or 'US'" });

const slug = z.string().trim().max(160).optional();

// ---- Parent ----
const ParentQuery = z.object({
  petId: z.string().max(40).optional(),
  city: z.string().trim().max(80).optional(),
  country,
  category: slug,
  limit: z.coerce.number().int().min(1).max(24).optional(),
  cursor: z.string().max(200).optional(),
});

recoRouter.get(
  '/parent',
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const q = ParentQuery.parse(req.query);
    const parentId = req.auth?.role === 'pet_parent' ? req.auth.sub : null;
    const out = await forParent({
      parentId,
      petId: q.petId,
      city: q.city,
      country: q.country,
      category: q.category || undefined,
      limit: q.limit ?? 12,
      cursor: q.cursor,
      viewerKey: viewer(req),
      track: !isBot(req),
    });
    privateNoStore(res);
    const { basedOn: _basedOn, ...rest } = out;
    res.json(rest);
  }),
);

const FeedQuery = z.object({
  city: z.string().trim().max(80).optional(),
  country,
  limit: z.coerce.number().int().min(1).max(12).optional(),
});

recoRouter.get(
  '/parent/feed',
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const q = FeedQuery.parse(req.query);
    const parentId = req.auth?.role === 'pet_parent' ? req.auth.sub : null;
    const out = await parentFeed({ parentId, city: q.city, country: q.country, limit: q.limit ?? 6 });
    privateNoStore(res);
    res.json(out);
  }),
);

// ---- Listing page ----
const ListingQuery = z.object({ limit: z.coerce.number().int().min(1).max(12).optional() });

recoRouter.get(
  '/listing/:id',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const q = ListingQuery.parse(req.query);
    const id = String(req.params.id ?? '').slice(0, 191);
    const out = await forListing(id, q.limit ?? 6, viewer(req), !isBot(req));
    if (!out) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    publicCache(res);
    res.json(out);
  }),
);

// ---- City / home / search ----
const CityQuery = z.object({
  city: z.string().trim().max(80).optional(),
  country,
  category: slug,
  sort: z.enum(['top', 'popular', 'new']).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  cursor: z.string().max(200).optional(),
  sponsored: z.enum(['0', '1']).optional(),
  surface: z.enum(['home', 'city', 'search']).optional(),
});

recoRouter.get(
  '/city',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const q = CityQuery.parse(req.query);
    const header = String(req.headers['x-reco-surface'] ?? '').toLowerCase();
    const surface = q.surface === 'home' || header === 'home'
      ? 'home_top'
      : q.surface === 'search' || header === 'search'
        ? 'search_sponsored'
        : 'city_top';
    const out = await forCity({
      city: q.city,
      country: q.country,
      category: q.category || undefined,
      sort: q.sort ?? 'top',
      limit: q.limit ?? 8,
      cursor: q.cursor,
      sponsored: q.sponsored !== '0',
      surface,
      viewerKey: viewer(req),
      track: !isBot(req),
    });
    publicCache(res);
    res.json(out);
  }),
);

// ---- Tracking ----
const EventSchema = z.object({
  rid: z.string().regex(/^[a-f0-9]{16}$/),
  type: z.enum(['impression', 'click']),
  listingId: z.string().min(1).max(191),
  pos: z.number().int().min(0).max(100).optional(),
  reason: z.string().max(32).optional(),
  sponsored: z.boolean().optional(),
  surface: z.string().max(32).optional(),
});
const EventsBody = z.object({ events: z.array(z.unknown()).max(50) });

recoRouter.post(
  '/events',
  publicLimiter,
  // navigator.sendBeacon posts text/plain; express.json (global) handles JSON.
  express.text({ type: 'text/plain', limit: '16kb' }),
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ ok: false, error: 'bad_json', message: 'The request body is not valid JSON.' });
        return;
      }
    }
    const parsed = EventsBody.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'validation_failed', message: 'events must be an array of at most 50 items' });
      return;
    }
    // Crawlers are acknowledged but never counted (see isBotUA).
    if (isBot(req)) {
      res.status(202).json({ ok: true, accepted: 0, rejected: 0 });
      return;
    }
    const valid = [];
    let malformed = 0;
    for (const raw of parsed.data.events) {
      const e = EventSchema.safeParse(raw);
      if (!e.success) {
        malformed++;
        continue;
      }
      valid.push({ ...e.data, reason: isReasonCode(e.data.reason) ? e.data.reason : undefined });
    }
    const { accepted, rejected } = await ingestEvents(valid, viewer(req));
    res.status(202).json({ ok: true, accepted, rejected: rejected + malformed });
  }),
);

// ---- Vendor ----
recoRouter.get(
  '/vendor',
  requireAuth('vendor'),
  asyncHandler(async (req, res) => {
    const out = await vendorInsights(req.auth!.sub);
    privateNoStore(res);
    res.json(out);
  }),
);
