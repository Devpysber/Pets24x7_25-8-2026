// GET /api/recommendations   (pet parent auth optional)
//
// Signed in  → personalised: the parent's pets, past enquiries, saved businesses
//              and city drive the ranking, and each result explains itself.
// Signed out → the same engine with no personal signals, which degrades to
//              "well-rated, contactable businesses in this city".
//
// Query: ?city=mumbai&country=IN&limit=12&petId=<id>

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { optionalAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { listingsInCity } from '../listings/index.js';
import { recommend, type PetSignal } from './recommend.js';

export const recommendRouter = Router();

const Query = z.object({
  city: z.string().max(80).optional(),
  country: z.string().max(2).optional(),
  limit: z.coerce.number().int().min(1).max(24).optional(),
  petId: z.string().max(40).optional(),
});

/** Same slugify the static data uses, so categories join cleanly. */
function slugify(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[(),]/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

recommendRouter.get(
  '/recommendations',
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const q = Query.parse(req.query);
    const parentId = req.auth?.sub ?? null;

    const parent = parentId
      ? await prisma.petParent.findUnique({ where: { id: parentId } }).catch(() => null)
      : null;

    const city = (q.city || parent?.city || 'Mumbai').trim();
    const country = (q.country || parent?.country || 'IN').toUpperCase();
    const limit = q.limit ?? 12;

    const [pets, enquiries, saved, featuredRows, claimedRows] = await Promise.all([
      parentId
        ? prisma.pet.findMany({
            where: { ownerId: parentId, ...(q.petId ? { id: q.petId } : {}) },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
      parentId
        ? prisma.enquiry.findMany({
            where: { petParentId: parentId },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: { listingId: true, category: true },
          })
        : Promise.resolve([]),
      parentId
        ? prisma.savedListing.findMany({
            where: { parentId },
            take: 50,
            select: { listingId: true, category: true },
          })
        : Promise.resolve([]),
      prisma.featuredListing.findMany({
        where: { status: 'ACTIVE', endsAt: { gt: new Date() } },
        select: { listingId: true },
      }),
      prisma.vendor.findMany({
        where: { status: 'ACTIVE', listingId: { not: null } },
        select: { listingId: true },
      }),
    ]);

    const petSignals: PetSignal[] = pets.map((p) => ({
      species: String(p.species),
      breed: p.breed,
      ageYears: p.ageYears,
      vaccinated: p.vaccinated,
    }));

    const results = recommend(
      listingsInCity(city, country),
      {
        pets: petSignals,
        enquiredCategories: enquiries.map((e) => slugify(e.category)).filter(Boolean),
        savedCategories: saved.map((s) => slugify(s.category)).filter(Boolean),
        knownListingIds: [
          ...enquiries.map((e) => e.listingId),
          ...saved.map((s) => s.listingId),
        ].filter((x): x is string => !!x),
        featuredListingIds: featuredRows.map((f) => f.listingId).filter(Boolean),
        claimedListingIds: claimedRows.map((v) => v.listingId!).filter(Boolean),
      },
      limit,
    );

    res.json({
      ok: true,
      city,
      country,
      personalised: Boolean(parentId && (pets.length || enquiries.length || saved.length)),
      basedOn: {
        pets: pets.map((p) => ({ id: p.id, name: p.name, species: String(p.species) })),
        enquiries: enquiries.length,
        saved: saved.length,
      },
      recommendations: results.map((r) => ({
        id: r.listing.id,
        name: r.listing.name,
        category: r.listing.category,
        category_slug: r.listing.category_slug,
        category_icon: r.listing.category_icon ?? null,
        city: r.listing.city,
        city_slug: r.listing.city_slug,
        country: r.listing.country,
        address: r.listing.address ?? null,
        phone: r.listing.phone ?? null,
        rating: r.listing.rating,
        review_count: r.listing.review_count,
        score: Math.round(r.score * 10) / 10,
        reasons: r.reasons,
      })),
    });
  }),
);
