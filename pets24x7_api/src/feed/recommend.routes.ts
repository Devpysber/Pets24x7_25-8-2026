// GET /api/recommendations   (pet parent auth optional) — legacy endpoint.
//
// Signed in  → personalised: the parent's pets, past enquiries, saved and viewed
//              businesses and city drive the ranking, and each result explains
//              itself.
// Signed out → the same engine with no personal signals, which degrades to
//              "well-rated, contactable businesses in this city".
//
// Query: ?city=mumbai&country=IN&limit=12&petId=<id>&cursor=<nextCursor>
//
// Delegates to the shared engine (feed/reco/service.ts forParent). Every field
// this endpoint always returned is unchanged; rid, nextCursor, fallback,
// variant and the RecoItem fields (reason, url, sponsored, …) are additive.
// A parent with no city no longer falls back to Mumbai whatever their country:
// the fallback is per country (config.fallbackCity), then the country's
// largest city.

import { Router } from 'express';
import { z } from 'zod';

import { optionalAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { forParent } from './reco/service.js';
import { isBotUA, viewerKeyFor } from './reco/util.js';

export const recommendRouter = Router();

const Query = z.object({
  city: z.string().max(80).optional(),
  country: z
    .string()
    .max(2)
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined)),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  petId: z.string().max(40).optional(),
  cursor: z.string().max(200).optional(),
});

recommendRouter.get(
  '/recommendations',
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const q = Query.parse(req.query);
    const parentId = req.auth?.role === 'pet_parent' ? req.auth.sub : null;
    const ua = String(req.headers['user-agent'] ?? '');

    const out = await forParent({
      parentId,
      petId: q.petId,
      city: q.city?.trim() || undefined,
      country: q.country === 'US' || q.country === 'IN' ? q.country : undefined,
      limit: q.limit ?? 12,
      cursor: q.cursor,
      viewerKey: viewerKeyFor(parentId, req.ip, ua.slice(0, 200)),
      track: !isBotUA(ua),
    });

    res.set('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      city: out.city,
      country: out.country,
      personalised: out.personalised,
      basedOn: out.basedOn,
      recommendations: out.items,
      rid: out.rid,
      nextCursor: out.nextCursor,
      fallback: out.fallback,
      variant: out.variant,
      sponsoredCount: out.sponsoredCount,
    });
  }),
);
