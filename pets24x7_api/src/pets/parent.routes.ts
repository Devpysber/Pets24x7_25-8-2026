// Pet Parent dashboard + Pet CRUD.
// All routes require an active pet_parent JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { sendVerificationEmail } from '../auth/email-verification.js';
import { notifyIf } from '../mail/notify.js';
import { listingsInCity } from '../listings/index.js';
import { recommend } from '../feed/recommend.js';
import {
  listingSavedEmail,
  listingUnsavedEmail,
  petAddedEmail,
  petPhotoUpdatedEmail,
  recommendationsEmail,
  petRemovedEmail,
  petUpdatedEmail,
  profileUpdatedEmail,
} from '../mail/action-templates.js';

export const parentDashboardRouter = Router();

/**
 * Ranked picks for a parent who just added their first pet. Best-effort and
 * fire-and-forget: the pet was already saved, so a failure here must not
 * surface to the caller.
 */
async function sendFirstPetRecommendations(
  parentId: string,
  email: string,
  name: string,
  pet: { name: string; species: unknown; breed: string | null; ageYears: number | null; vaccinated: boolean },
): Promise<void> {
  const parent = await prisma.petParent.findUnique({ where: { id: parentId } });
  const city = parent?.city || 'Mumbai';
  const country = (parent?.country || 'IN').toUpperCase();

  const [featuredRows, claimedRows] = await Promise.all([
    prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: new Date() } },
      select: { listingId: true },
    }),
    prisma.vendor.findMany({ where: { status: 'ACTIVE', listingId: { not: null } }, select: { listingId: true } }),
  ]);

  const picks = recommend(
    listingsInCity(city, country),
    {
      pets: [{
        species: String(pet.species),
        breed: pet.breed,
        ageYears: pet.ageYears,
        vaccinated: pet.vaccinated,
      }],
      enquiredCategories: [],
      savedCategories: [],
      knownListingIds: [],
      featuredListingIds: featuredRows.map((f) => f.listingId).filter(Boolean),
      claimedListingIds: claimedRows.map((v) => v.listingId!).filter(Boolean),
    },
    5,
  );
  if (!picks.length) return;

  notifyIf(email, (to) =>
    recommendationsEmail(
      to,
      name,
      pet.name,
      picks.map((p) => ({
        name: p.listing.name,
        category: p.listing.category,
        city: p.listing.city,
        rating: p.listing.rating,
        reviewCount: p.listing.review_count,
        reasons: p.reasons,
        url: `${env.PUBLIC_SITE_URL}/${String(p.listing.country).toLowerCase()}/${p.listing.city_slug}/${p.listing.id}/`,
      })),
    ),
  );
}

/** Address + display name for the action mails below; null when unknown. */
function ownerContact(parentId: string) {
  return prisma.petParent
    .findUnique({ where: { id: parentId }, select: { email: true, name: true } })
    .catch(() => null);
}

parentDashboardRouter.use(requireAuth('pet_parent'));

// ----- Dashboard summary -----
parentDashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const parentId = req.auth!.sub;
    let parent: any = null;
    let pets: any[] = [];
    let enquiries: any[] = [];

    let membershipRow: any = null;
    let saved: any[] = [];
    try {
      const [p, pt, e, m, sv] = await Promise.all([
        prisma.petParent.findUnique({
          where: { id: parentId },
          select: { id: true, name: true, phone: true, email: true, city: true, country: true },
        }),
        prisma.pet.findMany({ where: { ownerId: parentId }, orderBy: { createdAt: 'desc' } }),
        prisma.enquiry.findMany({
          where: { petParentId: parentId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        prisma.membership.findFirst({
          where: { parentId, status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        }),
        prisma.savedListing.findMany({ where: { parentId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      ]);
      parent = p; pets = pt; enquiries = e; membershipRow = m; saved = sv;
    } catch {
      // DB connection offline
    }

    if (!parent) {
      if (process.env.NODE_ENV === 'development') {
        parent = {
          id: parentId,
          name: 'Dev Pet Parent',
          phone: '+91 9876543210',
          email: 'alex.parent@example.com',
          city: 'Mumbai',
          country: 'IN',
        };
        pets = [
          {
            id: 'pet-dev-1',
            name: 'Buddy',
            species: 'DOG',
            breed: 'Golden Retriever',
            ageYears: 3,
            vaccinated: true,
            notes: 'Friendly and vaccinated',
          },
        ];
      } else {
        throw new NotFoundError('Parent record missing');
      }
    }

    // Nearby feed — deals + events for the parent's city (best-effort).
    let nearbyDeals: any[] = [];
    let upcomingEvents: any[] = [];
    try {
      const citySlug = parent?.city ? String(parent.city).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null;
      const now = new Date();
      const [deals, events] = await Promise.all([
        prisma.deal.findMany({
          where: {
            status: 'ACTIVE',
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
            ...(citySlug ? { citySlug } : {}),
          },
          orderBy: [{ endsAt: 'asc' }, { createdAt: 'desc' }],
          take: 10,
        }),
        prisma.event.findMany({
          where: { status: 'PUBLISHED', startsAt: { gt: now }, ...(citySlug ? { citySlug } : {}) },
          orderBy: { startsAt: 'asc' },
          take: 10,
        }),
      ]);
      nearbyDeals = deals.map((d) => ({ id: d.id, title: d.title, offerLabel: d.offerLabel, description: d.description, code: d.code, endsAt: d.endsAt, city: d.city }));
      upcomingEvents = events.map((e) => ({ id: e.id, title: e.title, venue: e.venue, city: e.city, startsAt: e.startsAt, rsvpUrl: e.rsvpUrl }));
    } catch {
      // DB offline
    }

    const membership = membershipRow
      ? {
          active: true,
          plan: membershipRow.plan?.name ?? 'Membership',
          tier: membershipRow.plan?.tier ?? null,
          renewsAt: membershipRow.endsAt ?? null,
          autoRenew: membershipRow.autoRenew ?? false,
          cancelledAt: membershipRow.cancelledAt ?? null,
        }
      : { active: false, plan: null, tier: null, renewsAt: null, autoRenew: false, cancelledAt: null };

    res.json({
      ok: true,
      parent,
      pets,
      enquiries,
      saved,
      nearbyDeals,
      upcomingEvents,
      membership,
    });
  }),
);

// ----- Update profile -----
const ProfileBody = z.object({
  name: z.string().min(1).max(80).optional(),
  email: z.string().email().max(160).optional().or(z.literal('')),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
});

parentDashboardRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = ProfileBody.parse(req.body);
    const current = await prisma.petParent.findUnique({
      where: { id: req.auth!.sub },
      select: { email: true },
    });

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.city !== undefined) data.city = body.city;
    if (body.country !== undefined) data.country = body.country;

    // A new address is unproven: drop the verified flag so nothing downstream
    // treats the old proof as covering it, and send a fresh link.
    const nextEmail = body.email === undefined ? undefined : body.email || null;
    const emailChanged = nextEmail !== undefined && nextEmail !== (current?.email ?? null);
    if (nextEmail !== undefined) {
      data.email = nextEmail;
      if (emailChanged) {
        data.emailVerified = false;
        data.emailVerifiedAt = null;
      }
    }

    let parent;
    try {
      parent = await prisma.petParent.update({
        where: { id: req.auth!.sub },
        data,
        select: { id: true, name: true, phone: true, email: true, city: true, country: true, emailVerified: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestError('That email address is already used by another Pets24x7 account');
      }
      throw err;
    }

    if (emailChanged && parent.email) {
      void sendVerificationEmail({ id: parent.id, name: parent.name, email: parent.email }).catch((err) => {
        req.log.warn({ err }, 'profile email verification send failed');
      });
    }
    notifyIf(parent.email, (to) => profileUpdatedEmail(to, parent.name ?? 'there', Object.keys(data)));
    res.json({ ok: true, parent, verificationSent: emailChanged && Boolean(parent.email) });
  }),
);

// ----- Pet CRUD -----
const PetBody = z.object({
  name: z.string().min(1).max(40),
  species: z.enum(['DOG','CAT','BIRD','RABBIT','REPTILE','SMALL_MAMMAL','OTHER']),
  breed: z.string().max(60).optional(),
  ageYears: z.number().int().min(0).max(50).optional(),
  gender: z.enum(['Male', 'Female', 'Unspecified']).optional(),
  vaccinated: z.boolean().optional(),
  notes: z.string().max(500).optional(),
  // Either a hosted URL or a small resized data: URL (the dashboard downsizes
  // the file before upload). '' clears the photo.
  avatarUrl: z
    .string()
    .max(600_000)
    .refine(
      (v) => v === '' || /^data:image\/(png|jpe?g|webp);base64,/.test(v) || /^https?:\/\//.test(v),
      'must be an image URL or image data URL',
    )
    .optional(),
});

parentDashboardRouter.get(
  '/pets',
  asyncHandler(async (req, res) => {
    const list = await prisma.pet.findMany({
      where: { ownerId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ ok: true, pets: list });
  }),
);

parentDashboardRouter.post(
  '/pets',
  asyncHandler(async (req, res) => {
    const body = PetBody.parse(req.body);
    const pet = await prisma.pet.create({
      data: { ...body, avatarUrl: body.avatarUrl || null, ownerId: req.auth!.sub },
    });
    const owner = await ownerContact(req.auth!.sub);
    notifyIf(owner?.email, (to) =>
      petAddedEmail(to, owner!.name ?? 'there', {
        name: pet.name,
        species: String(pet.species),
        breed: pet.breed,
        ageYears: pet.ageYears,
      }),
    );

    // First pet on the account: we finally know enough to recommend something,
    // so send the picks straight away. Later pets don't re-trigger it.
    const petCount = await prisma.pet.count({ where: { ownerId: req.auth!.sub } });
    if (petCount === 1 && owner?.email) {
      void sendFirstPetRecommendations(req.auth!.sub, owner.email, owner.name ?? 'there', pet).catch(() => {});
    }

    res.status(201).json({ ok: true, pet });
  }),
);

parentDashboardRouter.patch(
  '/pets/:id',
  asyncHandler(async (req, res) => {
    const body = PetBody.partial().parse(req.body);
    const existing = await prisma.pet.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Pet not found');
    if (existing.ownerId !== req.auth!.sub) throw new ForbiddenError();
    const pet = await prisma.pet.update({
      where: { id: existing.id },
      data: { ...body, ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl || null } : {}) },
    });
    const owner = await ownerContact(req.auth!.sub);
    const photoChanged = body.avatarUrl !== undefined && body.avatarUrl !== (existing.avatarUrl ?? '');
    const onlyPhoto = photoChanged && Object.keys(body).length === 1;
    notifyIf(owner?.email, (to) =>
      onlyPhoto
        ? petPhotoUpdatedEmail(to, owner!.name ?? 'there', pet.name, !body.avatarUrl)
        : petUpdatedEmail(to, owner!.name ?? 'there', pet.name),
    );
    res.json({ ok: true, pet });
  }),
);

parentDashboardRouter.delete(
  '/pets/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.pet.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Pet not found');
    if (existing.ownerId !== req.auth!.sub) throw new ForbiddenError();
    await prisma.pet.delete({ where: { id: existing.id } });
    const owner = await ownerContact(req.auth!.sub);
    notifyIf(owner?.email, (to) => petRemovedEmail(to, owner!.name ?? 'there', existing.name));
    res.json({ ok: true });
  }),
);

// ----- Saved businesses (bookmarks) -----
const SaveBody = z.object({
  listingId: z.string().min(1).max(160),
  listingName: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  country: z.enum(['IN', 'US']).optional(),
});

parentDashboardRouter.get(
  '/saved',
  asyncHandler(async (req, res) => {
    const saved = await prisma.savedListing.findMany({
      where: { parentId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ ok: true, saved });
  }),
);

parentDashboardRouter.post(
  '/saved',
  asyncHandler(async (req, res) => {
    const body = SaveBody.parse(req.body);
    const saved = await prisma.savedListing.upsert({
      where: { parentId_listingId: { parentId: req.auth!.sub, listingId: body.listingId } },
      update: {
        listingName: body.listingName ?? null,
        category: body.category ?? null,
        city: body.city ?? null,
        country: body.country ?? null,
      },
      create: {
        parentId: req.auth!.sub,
        listingId: body.listingId,
        listingName: body.listingName ?? null,
        category: body.category ?? null,
        city: body.city ?? null,
        country: body.country ?? null,
      },
    });
    const owner = await ownerContact(req.auth!.sub);
    notifyIf(owner?.email, (to) => listingSavedEmail(to, owner!.name ?? 'there', saved.listingName));
    res.status(201).json({ ok: true, saved });
  }),
);

parentDashboardRouter.delete(
  '/saved/:listingId',
  asyncHandler(async (req, res) => {
    const removed = await prisma.savedListing
      .delete({
        where: { parentId_listingId: { parentId: req.auth!.sub, listingId: req.params.listingId ?? '' } },
      })
      .catch(() => null); // idempotent — no-op if it wasn't saved
    if (removed) {
      const owner = await ownerContact(req.auth!.sub);
      notifyIf(owner?.email, (to) => listingUnsavedEmail(to, owner!.name ?? 'there', removed.listingName));
    }
    res.json({ ok: true });
  }),
);
