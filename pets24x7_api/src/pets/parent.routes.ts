// Pet Parent dashboard + Pet CRUD.
// All routes require an active pet_parent JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { NotFoundError, ForbiddenError, BadRequestError, HttpError } from '../shared/errors.js';
import { sendVerificationEmail } from '../auth/email-verification.js';
import { notifyIf } from '../mail/notify.js';
import { getListingById, listingsInCity, shownRating } from '../listings/index.js';
import { normalizePhone } from '../shared/phone.js';
import { recommend } from '../feed/recommend.js';
import { invalidateParent } from '../feed/reco/cache.js';
import { whatsappConfigured } from '../whatsapp/cloud-api.js';
import { issueOtp, verifyOtp } from '../whatsapp/otp.js';
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
  pet: { name: string; species: unknown; breed: string | null; ageYears: number | null; ageMonths?: number | null; vaccinated: boolean },
): Promise<void> {
  const parent = await prisma.petParent.findUnique({ where: { id: parentId } });
  // No city, no mail. Substituting a default sends someone in Bhopal five
  // "best-rated places near you" that are all in Mumbai, which is worse than
  // sending nothing — the recommendation goes out again as soon as they set
  // a city on their profile.
  const city = parent?.city?.trim();
  if (!city) return;
  const country = (parent?.country || 'IN').toUpperCase();

  // Only this city's listings can be picked, so only their featured/claimed
  // flags are looked up — not every featured slot and claimed vendor on file.
  const candidates = listingsInCity(city, country);
  if (!candidates.length) return;
  const candidateIds = candidates.map((l) => l.id);
  const [featuredRows, claimedRows] = await Promise.all([
    prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: new Date() }, listingId: { in: candidateIds } },
      select: { listingId: true },
    }),
    prisma.vendor.findMany({
      where: { status: 'ACTIVE', listingId: { in: candidateIds }, claimedAt: { not: null } },
      select: { listingId: true },
    }),
  ]);

  const picks = recommend(
    candidates,
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
        rating: shownRating(p.listing),
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
          select: { id: true, name: true, phone: true, email: true, city: true, country: true, emailVerified: true, emailVerifiedAt: true },
        }),
        prisma.pet.findMany({ where: { ownerId: parentId }, orderBy: { createdAt: 'desc' } }),
        prisma.enquiry.findMany({
          where: { petParentId: parentId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        // Same rule as /api/memberships/me: an ACTIVE row past endsAt (the
        // expiry sweep has not run yet) is not a membership.
        prisma.membership.findFirst({
          where: { parentId, status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        }),
        prisma.savedListing.findMany({ where: { parentId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      ]);
      parent = p; pets = pt; enquiries = e; membershipRow = m; saved = sv;
    } catch {
      // DB connection offline
    }

    // No invented fallback data: a fake parent with a fake pet id hid real
    // DB/missing-record failures and broke every pet edit made against it.
    if (!parent) throw new NotFoundError('Parent record missing');

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
          planId: membershipRow.plan?.id ?? null,
          plan: membershipRow.plan?.name ?? 'Membership',
          discountPercent: membershipRow.plan?.discountPercent ?? 0,
          tier: membershipRow.plan?.tier ?? null,
          renewsAt: membershipRow.endsAt ?? null,
          autoRenew: membershipRow.autoRenew ?? false,
          cancelledAt: membershipRow.cancelledAt ?? null,
        }
      : { active: false, planId: null, plan: null, discountPercent: 0, tier: null, renewsAt: null, autoRenew: false, cancelledAt: null };

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
// The address is the account identifier, the sign-in code destination and the
// receipt address all at once, so it is not self-service: a typo locks someone
// out of their own account, and an attacker who gets a session could quietly
// move the account to an address they own. Support changes it after checking
// who is asking.
const ProfileBody = z.object({
  name: z.string().min(1).max(80).optional(),
  phone: z.string().max(30).optional().or(z.literal('')),
  // WhatsApp code proving the new phone (see POST /profile/phone-otp).
  phoneCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
  city: z.string().max(80).optional(),
  country: z.enum(['IN', 'US']).optional(),
  digestFrequency: z.enum(['DAILY', 'WEEKLY', 'OFF']).optional(),
});

// The phone is a sign-in identifier (WhatsApp OTP login finds the account by
// it), so attaching a number nobody proved would let its real owner later sign
// straight into this parent's account. When WhatsApp OTP is live, a new number
// must be verified first. When it is not configured, phone sign-in is off too
// and there is nothing to hijack, so the number is saved as before.
const PhoneOtpBody = z.object({
  phone: z.string().min(6).max(30),
  country: z.enum(['IN', 'US']).optional(),
});

// Each call sends a WhatsApp message to a number the caller chose; the per-phone
// cool-down in issueOtp does not stop one session cycling through numbers.
const phoneOtpLimiter = makeLimiter('parent-profile-phone-otp', {
  windowMs: 60 * 60_000,
  max: env.NODE_ENV === 'development' ? 10_000 : 6,
  standardHeaders: true,
});

parentDashboardRouter.post(
  '/profile/phone-otp',
  phoneOtpLimiter,
  asyncHandler(async (req, res) => {
    const body = PhoneOtpBody.parse(req.body);
    const current = await prisma.petParent.findUnique({ where: { id: req.auth!.sub }, select: { country: true } });
    const phone = normalizePhone(body.phone, (body.country || current?.country || 'IN') as 'IN' | 'US');
    const taken = await prisma.petParent.findFirst({ where: { phone, NOT: { id: req.auth!.sub } }, select: { id: true } });
    if (taken) throw new BadRequestError('That phone number is already registered to another account');
    await issueOtp(phone, 'PARENT_SIGNUP', { ip: req.ip, ua: req.headers['user-agent'] });
    res.json({ ok: true, phone });
  }),
);

parentDashboardRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = ProfileBody.parse(req.body);
    const current = await prisma.petParent.findUnique({
      where: { id: req.auth!.sub },
      select: { email: true, phone: true, country: true, city: true, name: true },
    });

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.city !== undefined) data.city = body.city;
    if (body.country !== undefined) data.country = body.country;
    if (body.digestFrequency !== undefined) data.digestFrequency = body.digestFrequency;

    if (body.phone !== undefined) {
      const rawPhone = body.phone.trim();
      if (rawPhone) {
        const country = (body.country || current?.country || 'IN') as 'IN' | 'US';
        data.phone = normalizePhone(rawPhone, country);
        if (data.phone !== (current?.phone ?? null) && whatsappConfigured()) {
          if (!body.phoneCode) {
            throw new HttpError(400, 'Verify the new phone number with the WhatsApp code we send to it.', 'phone_otp_required');
          }
          const ok = await verifyOtp(data.phone as string, body.phoneCode, 'PARENT_SIGNUP');
          if (!ok) throw new BadRequestError('That code is not right. Check WhatsApp and try again.');
        }
      } else {
        data.phone = null;
      }
    }

    // Email is deliberately absent from this endpoint — see ProfileBody above.
    const emailChanged = false;

    let parent;
    try {
      parent = await prisma.petParent.update({
        where: { id: req.auth!.sub },
        data,
        select: { id: true, name: true, phone: true, email: true, city: true, country: true, emailVerified: true, digestFrequency: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const target = (err as { meta?: { target?: string[] } }).meta?.target;
        if (target && target.includes('phone')) {
          throw new BadRequestError('That phone number is already registered to another account');
        }
        throw new BadRequestError('That email address or phone number is already used by another Pets24x7 account');
      }
      throw err;
    }

    if (emailChanged && parent.email) {
      void sendVerificationEmail({ id: parent.id, name: parent.name, email: parent.email }).catch((err) => {
        req.log.warn({ err }, 'profile email verification send failed');
      });
    }
    // `data` also carries the emailVerified reset, which is bookkeeping rather
    // than something the parent edited — listing it reads as an unexplained
    // change in the mail.
    // Only fields whose value really moved: the dashboard re-sends the whole
    // form, which mailed "name, phone, city, country changed" on every save.
    const before = (current ?? {}) as Record<string, unknown>;
    const changed = Object.keys(data).filter(
      (k) => k !== 'emailVerified' && k !== 'emailVerifiedAt' && (before[k] ?? null) !== (data[k] ?? null),
    );
    if (changed.length > 0) {
      notifyIf(parent.email, (to) => profileUpdatedEmail(to, parent.name ?? 'there', changed));
    }
    // A dashboard request without ?city= ranks for the city on the profile,
    // under a key that does not name it: drop what was ranked for the old one.
    if (changed.includes('city') || changed.includes('country')) invalidateParent(parent.id);

    // sendFirstPetRecommendations skips a parent with no city and promises the
    // picks "as soon as they set a city" — nothing kept that promise. Setting a
    // city for the first time, with a pet already on the account, is that moment.
    const hadCity = !!current?.city?.trim();
    if (!hadCity && parent.city?.trim() && parent.email) {
      const firstPet = await prisma.pet.findFirst({ where: { ownerId: parent.id }, orderBy: { createdAt: 'asc' } });
      if (firstPet) {
        void sendFirstPetRecommendations(parent.id, parent.email, parent.name ?? 'there', firstPet).catch(() => {});
      }
    }
    res.json({ ok: true, parent, verificationSent: emailChanged && Boolean(parent.email) });
  }),
);

// ----- Pet CRUD -----

/**
 * Normalises the three optional health dates for Prisma. The form submits ''
 * to clear a date, which Prisma rejects on a DateTime column, and omits the
 * key entirely when it is not being changed — so '' becomes null and an absent
 * key stays absent.
 */
function dateFields(body: {
  dateOfBirth?: Date | '';
  lastVaccinatedAt?: Date | '';
  lastCheckupAt?: Date | '';
}): Record<string, Date | null> {
  const out: Record<string, Date | null> = {};
  for (const k of ['dateOfBirth', 'lastVaccinatedAt', 'lastCheckupAt'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    out[k] = v === '' ? null : v;
  }
  return out;
}

/**
 * A pet photo is rendered as <img src> on the dashboard, and a prefix-only
 * check let anything (quotes, markup) follow "base64,". Accept a hosted http(s)
 * URL without markup characters, or a complete base64 image data URL.
 */
const IMAGE_SRC =
  /^(?:https?:\/\/[^\s"'<>`]+|data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+)$/;

const PetBody = z.object({
  name: z.string().min(1).max(40),
  species: z.enum(['DOG','CAT','BIRD','RABBIT','REPTILE','SMALL_MAMMAL','OTHER']),
  breed: z.string().max(60).optional(),
  // null clears a previously set age (undefined means "unchanged").
  ageYears: z.number().int().min(0).max(50).nullable().optional(),
  // Under-a-year pets need months, not a rounded-down 0 years.
  ageMonths: z.number().int().min(0).max(11).nullable().optional(),
  gender: z.enum(['Male', 'Female', 'Unspecified']).optional(),
  vaccinated: z.boolean().optional(),
  // Health dates the reminder mails key off. '' clears one; an ISO date sets it.
  // Coerced here rather than in the handler so a bad value is a 400 with a
  // field name on it, not a Prisma error surfacing as internal_error.
  dateOfBirth: z.union([z.literal(''), z.coerce.date()]).optional(),
  lastVaccinatedAt: z.union([z.literal(''), z.coerce.date()]).optional(),
  lastCheckupAt: z.union([z.literal(''), z.coerce.date()]).optional(),
  notes: z.string().max(500).optional(),
  // Extra photos beyond the avatar, at most four. The dashboard resizes each
  // one before upload, same as the avatar.
  photos: z
    .array(
      z.string().max(600_000).refine((v) => IMAGE_SRC.test(v), 'must be an image URL or image data URL'),
    )
    .max(4, 'You can keep at most 5 photos in total')
    .optional(),
  // Either a hosted URL or a small resized data: URL (the dashboard downsizes
  // the file before upload). '' clears the photo.
  avatarUrl: z
    .string()
    .max(600_000)
    .refine((v) => v === '' || IMAGE_SRC.test(v), 'must be an image URL or image data URL')
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
    const { photos, ...rest } = body;
    const pet = await prisma.pet.create({
      data: {
        ...rest,
        ...dateFields(body),
        avatarUrl: body.avatarUrl || null,
        // Stored as JSON text; the column is one blob because the photos are
        // only ever read together with the pet.
        ...(photos !== undefined ? { photos: JSON.stringify(photos) } : {}),
        ownerId: req.auth!.sub,
      },
    });
    // Recommendations are cached per parent; a new pet changes what fits.
    invalidateParent(req.auth!.sub);
    const owner = await ownerContact(req.auth!.sub);
    notifyIf(owner?.email, (to) =>
      petAddedEmail(to, owner!.name ?? 'there', {
        name: pet.name,
        species: String(pet.species),
        breed: pet.breed,
        ageYears: pet.ageYears,
        ageMonths: pet.ageMonths,
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
    const { photos: nextPhotos, ...restBody } = body;
    const pet = await prisma.pet.update({
      where: { id: existing.id },
      data: {
        ...restBody,
        ...dateFields(body),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl || null } : {}),
        ...(nextPhotos !== undefined ? { photos: JSON.stringify(nextPhotos) } : {}),
      },
    });
    invalidateParent(req.auth!.sub);
    const photoChanged = body.avatarUrl !== undefined && body.avatarUrl !== (existing.avatarUrl ?? '');
    // The edit form re-sends every field, so "a PATCH arrived" is not "the pet
    // changed": saving an untouched form mailed "your pet was updated" each
    // time. Compare what was stored before and after instead.
    const comparable = (p: typeof existing) =>
      JSON.stringify([
        p.name, p.species, p.breed, p.ageYears, p.ageMonths, p.gender, p.vaccinated, p.notes, p.photos,
        p.dateOfBirth?.getTime() ?? null, p.lastVaccinatedAt?.getTime() ?? null, p.lastCheckupAt?.getTime() ?? null,
      ]);
    const otherChanged = comparable(existing) !== comparable(pet);
    if (photoChanged || otherChanged) {
      const owner = await ownerContact(req.auth!.sub);
      notifyIf(owner?.email, (to) =>
        photoChanged && !otherChanged
          ? petPhotoUpdatedEmail(to, owner!.name ?? 'there', pet.name, !body.avatarUrl)
          : petUpdatedEmail(to, owner!.name ?? 'there', pet.name),
      );
    }
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
    invalidateParent(req.auth!.sub);
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
    const key = { parentId_listingId: { parentId: req.auth!.sub, listingId: body.listingId } };
    const existing = await prisma.savedListing.findUnique({ where: key, select: { id: true } });
    // The index knows the listing better than a client that may have sent only
    // the id (the recommender and the saved grid both read these columns).
    const listing = getListingById(body.listingId);
    const country = body.country ?? (String(listing?.country ?? '').toUpperCase() === 'US' ? 'US' : listing ? 'IN' : null);
    const fields = {
      listingName: body.listingName ?? listing?.name ?? null,
      category: body.category ?? listing?.category ?? null,
      city: body.city ?? listing?.city ?? null,
      country,
    };
    const saved = await prisma.savedListing.upsert({
      where: key,
      update: fields,
      create: { parentId: req.auth!.sub, listingId: body.listingId, ...fields },
    });
    invalidateParent(req.auth!.sub);
    // Mail on the first save only; re-saving (double tap, a second tab) is a
    // no-op for the parent and must not mail "saved" again.
    if (!existing) {
      const owner = await ownerContact(req.auth!.sub);
      notifyIf(owner?.email, (to) => listingSavedEmail(to, owner!.name ?? 'there', saved.listingName));
    }
    res.status(existing ? 200 : 201).json({ ok: true, saved });
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
      invalidateParent(req.auth!.sub);
      const owner = await ownerContact(req.auth!.sub);
      notifyIf(owner?.email, (to) => listingUnsavedEmail(to, owner!.name ?? 'there', removed.listingName));
    }
    res.json({ ok: true });
  }),
);
