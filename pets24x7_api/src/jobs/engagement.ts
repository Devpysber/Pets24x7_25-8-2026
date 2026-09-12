// Marketing sweep — the mail nobody asked for, so it has to earn its place.
//
// Distinct from the other two jobs:
//   • jobs/expiry.ts    transitions that already happened
//   • jobs/reminders.ts things about to happen, transactional in spirit
//   • this file         promotional mail, suppressible and rate-limited
//
// Every message here is kind:'marketing', so sendMail suppresses it for
// opted-out addresses and attaches unsubscribe headers. Nothing here is a
// consequence of a user action, so all of it is best-effort.
//
// Two rules keep it from becoming spam, and they are the whole design:
//
//   1. One promotional email per parent per MIN_GAP_DAYS, whatever the reason.
//      The sweep picks the single most relevant thing to say and drops the
//      rest, rather than sending four mails because four rules matched.
//   2. Cadence lives in the database (PetParent.lastMarketingAt / lastDigestAt),
//      not in process memory, so a restart or a deploy cannot reset the clock
//      and re-send. The row is stamped BEFORE the mail is handed off: a crash
//      mid-send costs one missed email rather than a duplicate storm.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startRandomDailyJob } from './random-schedule.js';
import { notify } from '../mail/notify.js';
import { isOptedOut } from '../mail/optout.js';
import type { MailInput } from '../mail/mailer.js';
import { env } from '../env.js';
import { listingsInCity } from '../listings/index.js';
import { recommend } from '../feed/recommend.js';
import { recommendationsEmail } from '../mail/action-templates.js';
import { parentNewNearbyEmail } from '../mail/promo-templates.js';
import {
  dealNearbyEmail,
  eventReminderEmail,
  inactivityNudgeEmail,
  petBirthdayEmail,
  petCheckupEmail,
  vaccinationDueEmail,
  winbackEmail,
} from '../mail/lifecycle-templates.js';

const DAY = 24 * 3600 * 1000;

/**
 * Hard floor between any two promotional emails to the same person: at most
 * one a day. 20 hours rather than 24 because the sweeps run at random times,
 * so a strict day would push someone mailed at 16:00 past every slot tomorrow.
 */
const MIN_GAP_DAYS = 20 / 24;
/** The recommendations digest is the baseline; everything else displaces it. */
const DIGEST_EVERY_DAYS = 20 / 24; // daily; recentPromoIds keeps each one different
/** An event is worth mentioning this far ahead, and no further. */
const EVENT_HORIZON_DAYS = 3;
/** A lapsed member is worth one win-back inside this window, then left alone. */
const WINBACK_FROM_DAYS = 3;
const WINBACK_TO_DAYS = 30;
/** Silence this long earns a single nudge. */
const INACTIVE_DAYS = 30;
/** Ceiling per sweep, so a first run on a large list cannot empty the quota. */
const MAX_PER_SWEEP = 200;

/** A booster is treated as annual; the nudge starts this far before it is due. */
const VACCINE_INTERVAL_DAYS = 365;
const VACCINE_LEAD_DAYS = 14;
/** A pet unseen by a vet for this long is worth one check-up nudge. */
const CHECKUP_AFTER_MONTHS = 12;

interface Parent {
  id: string;
  name: string;
  email: string | null;
  city: string | null;
  country: string | null;
  createdAt: Date;
  lastMarketingAt: Date | null;
  lastDigestAt: Date | null;
  recentPromoIds: string | null;
}

interface Choice {
  mail: MailInput;
  /** True when this counts as the weekly digest, which paces itself separately. */
  digest: boolean;
}

function daysSince(at: Date | null, now: Date): number {
  if (!at) return Number.POSITIVE_INFINITY;
  return (now.getTime() - at.getTime()) / DAY;
}

/** The frontend stores a display city; deals and events are keyed by slug. */
function slugify(city: string): string {
  return city.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * The one thing worth saying to this parent right now, or null for silence.
 *
 * Ordered by how much the recipient is likely to care, not by what we would
 * rather sell: something they already paid for lapsing beats an event, which
 * beats a discount, which beats a generic digest.
 */
async function pickMessage(p: Parent, now: Date): Promise<Choice | null> {
  const email = p.email!;

  // Health first. These are about the animal rather than about us, and they are
  // the only messages here a parent would be annoyed to have NOT received.
  // Each fires only when the date it depends on has been filled in.
  const pets = await prisma.pet.findMany({ where: { ownerId: p.id } });

  // 1. A birthday, today. Once a year and date-specific: if the gap below
  //    swallows it, it is gone until next year, which is the accepted cost of
  //    never sending two promos in one day.
  for (const pet of pets) {
    if (!pet.dateOfBirth) continue;
    const dob = pet.dateOfBirth;
    if (dob.getMonth() === now.getMonth() && dob.getDate() === now.getDate()) {
      const age = now.getFullYear() - dob.getFullYear();
      return { mail: petBirthdayEmail(email, p.name, pet.name, age > 0 ? age : null), digest: false };
    }
  }

  // 2. A booster coming due, or already overdue.
  for (const pet of pets) {
    if (!pet.lastVaccinatedAt) continue;
    const dueAt = new Date(pet.lastVaccinatedAt.getTime() + VACCINE_INTERVAL_DAYS * DAY);
    const daysToDue = (dueAt.getTime() - now.getTime()) / DAY;
    if (daysToDue <= VACCINE_LEAD_DAYS) {
      return { mail: vaccinationDueEmail(email, p.name, pet.name, 'Annual booster', dueAt), digest: false };
    }
  }

  // 3. No vet visit on record for a year.
  for (const pet of pets) {
    if (!pet.lastCheckupAt) continue;
    const monthsSince = Math.floor(daysSince(pet.lastCheckupAt, now) / 30);
    if (monthsSince >= CHECKUP_AFTER_MONTHS) {
      return { mail: petCheckupEmail(email, p.name, pet.name, monthsSince), digest: false };
    }
  }

  // 4. Lapsed member, inside the win-back window, who has not since resubscribed.
  const lapsed = await prisma.membership.findFirst({
    where: {
      parentId: p.id,
      status: 'EXPIRED',
      endsAt: {
        lt: new Date(now.getTime() - WINBACK_FROM_DAYS * DAY),
        gt: new Date(now.getTime() - WINBACK_TO_DAYS * DAY),
      },
    },
    orderBy: { endsAt: 'desc' },
    include: { plan: true },
  });
  if (lapsed) {
    const stillActive = await prisma.membership.count({
      where: { parentId: p.id, status: 'ACTIVE', endsAt: { gt: now } },
    });
    if (stillActive === 0) {
      return { mail: winbackEmail(email, p.name, lapsed.plan.name), digest: false };
    }
  }

  // City-scoped content needs a city. Without one we cannot claim "near you".
  const citySlug = p.city ? slugify(p.city) : null;

  // 5. An event in their city, close enough to act on.
  if (citySlug) {
    const ev = await prisma.event.findFirst({
      where: {
        status: 'PUBLISHED',
        citySlug,
        startsAt: { gt: now, lt: new Date(now.getTime() + EVENT_HORIZON_DAYS * DAY) },
      },
      orderBy: { startsAt: 'asc' },
    });
    if (ev) {
      return {
        mail: eventReminderEmail(email, p.name, {
          title: ev.title,
          startsAt: ev.startsAt,
          venue: ev.venue,
          city: ev.city,
        }),
        digest: false,
      };
    }
  }

  // 6. A live deal in their city they have not been told about yet. Keyed off
  //    the last mail we sent, so a deal that predates it is treated as old news.
  if (citySlug) {
    const deal = await prisma.deal.findFirst({
      where: {
        status: 'ACTIVE',
        citySlug,
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        createdAt: { gt: p.lastMarketingAt ?? p.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      include: { vendor: { select: { businessName: true } } },
    });
    if (deal) {
      return {
        mail: dealNearbyEmail(email, p.name, {
          title: deal.title,
          businessName: deal.vendor?.businessName ?? 'a Pets24x7 partner',
          city: deal.city,
          endsAt: deal.endsAt,
        }),
        digest: false,
      };
    }
  }

  // 7. Businesses that joined in their city since the last mail. This is the
  //    only message here carrying genuinely new information rather than a
  //    re-ranking of what was already on the site, so it outranks the digest.
  if (p.city) {
    const since = p.lastMarketingAt ?? p.createdAt;
    const added = await prisma.listing
      .findMany({
        where: { city: p.city, importedAt: { gt: since } },
        orderBy: { importedAt: 'desc' },
        take: 5,
        select: { id: true, name: true, category: true, rating: true, citySlug: true, country: true },
      })
      .catch(() => []);
    if (added.length >= 2) {
      const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
      return {
        mail: parentNewNearbyEmail(
          email,
          p.name,
          p.city,
          added.map((l) => ({
            name: l.name,
            category: l.category,
            rating: l.rating,
            url: `${site}/${l.country.toLowerCase()}/${l.citySlug}/${l.id}/`,
          })),
        ),
        digest: false,
      };
    }
  }

  // 8. The weekly digest, personalised from their pets and past enquiries.
  if (daysSince(p.lastDigestAt, now) >= DIGEST_EVERY_DAYS) {
    const digest = await recommendationsFor(p, now);
    if (digest) return { mail: digest, digest: true };
  }

  // 8. Nothing specific to say, and they have gone quiet. One nudge, and only
  //    for parents with no city: with a city the digest already covers them,
  //    and two generic mails would be one too many.
  if (
    !citySlug &&
    daysSince(p.lastMarketingAt, now) >= INACTIVE_DAYS &&
    daysSince(p.createdAt, now) >= INACTIVE_DAYS
  ) {
    return { mail: inactivityNudgeEmail(email, p.name, p.city), digest: false };
  }

  return null;
}

/** The recommendations digest, or null when nothing worth sending can be ranked. */
async function recommendationsFor(p: Parent, now: Date): Promise<MailInput | null> {
  // Same rule as the first-pet mail: no city means we cannot honestly say
  // "near you", so we say nothing.
  if (!p.city) return null;
  const country = (p.country || 'IN').toUpperCase();

  const [pets, enquiries, saved, featuredRows, claimedRows] = await Promise.all([
    prisma.pet.findMany({ where: { ownerId: p.id } }),
    prisma.enquiry.findMany({
      where: { petParentId: p.id },
      select: { category: true, listingId: true },
      take: 50,
    }),
    prisma.savedListing.findMany({
      where: { parentId: p.id },
      select: { category: true, listingId: true },
      take: 50,
    }),
    prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: now } },
      select: { listingId: true },
    }),
    prisma.vendor.findMany({
      where: { status: 'ACTIVE', listingId: { not: null }, claimedAt: { not: null } },
      select: { listingId: true },
    }),
  ]);

  // Whatever the last digests showed is dropped from the pool before ranking.
  // Without this the same top-rated businesses win every week and the mail
  // reads as a duplicate, which is exactly how a digest earns an unsubscribe.
  const alreadyShown = new Set(parseRecentPromoIds(p.recentPromoIds));
  const pool = listingsInCity(p.city, country);
  const fresh = pool.filter((l) => !alreadyShown.has(l.id));
  // Fall back to the full pool once a small city is exhausted — a repeat beats
  // no mail at all, and by then enough weeks have passed for it to read as new.
  const candidatePool = fresh.length >= 5 ? fresh : pool;

  const picks = recommend(
    candidatePool,
    {
      pets: pets.map((pet) => ({
        species: String(pet.species),
        breed: pet.breed,
        ageYears: pet.ageYears,
        vaccinated: pet.vaccinated,
      })),
      enquiredCategories: enquiries.map((e) => e.category).filter((c): c is string => !!c),
      savedCategories: saved.map((sv) => sv.category).filter((c): c is string => !!c),
      knownListingIds: [
        ...enquiries.map((e) => e.listingId),
        ...saved.map((sv) => sv.listingId),
      ].filter((id): id is string => !!id),
      featuredListingIds: featuredRows.map((f) => f.listingId).filter((id): id is string => !!id),
      claimedListingIds: claimedRows.map((v) => v.listingId!).filter(Boolean),
    },
    5,
  );
  // A thin list is not worth an email.
  if (picks.length < 3) return null;

  const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  // Remember what went out, so the next one differs.
  await prisma.petParent
    .update({
      where: { id: p.id },
      data: { recentPromoIds: nextPromoIds(parseRecentPromoIds(p.recentPromoIds), picks.map((r) => r.listing.id)) },
    })
    .catch(() => {});

  return recommendationsEmail(
    p.email!,
    p.name,
    pets[0]?.name ?? null,
    picks.map((r) => ({
      name: r.listing.name,
      category: r.listing.category,
      city: r.listing.city,
      rating: r.listing.rating,
      reviewCount: r.listing.review_count,
      reasons: r.reasons,
      url: `${site}/${String(r.listing.country).toLowerCase()}/${r.listing.city_slug}/${r.listing.id}/`,
    })),
  );
}

/** Ids featured in recent digests, newest first. Text column, so be defensive. */
function parseRecentPromoIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** About a week of daily digests, so a listing is not repeated within the week. */
const PROMO_MEMORY = 30;

function nextPromoIds(previous: string[], justSent: string[]): string {
  return JSON.stringify([...justSent, ...previous].slice(0, PROMO_MEMORY));
}

export async function runEngagementSweep(): Promise<{ considered: number; sent: number }> {
  const now = new Date();
  const gapBefore = new Date(now.getTime() - MIN_GAP_DAYS * DAY);

  // Only parents who are actually mailable, and only those outside the gap.
  // Filtered in the database so a large list is not walked in memory every
  // few hours. An unverified address is excluded: we have no evidence anyone
  // at that address asked to hear from us.
  const candidates = (await prisma.petParent.findMany({
    where: {
      email: { not: null },
      emailVerified: true,
      OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lt: gapBefore } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      city: true,
      country: true,
      createdAt: true,
      lastMarketingAt: true,
      lastDigestAt: true,
      recentPromoIds: true,
    },
    orderBy: { lastMarketingAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_PER_SWEEP,
  })) as Parent[];

  let sent = 0;
  for (const p of candidates) {
    try {
      // Check suppression before doing any ranking work. sendMail would catch
      // it anyway, but not before we had built an entire digest for nobody.
      if (await isOptedOut(p.email!)) continue;

      const choice = await pickMessage(p, now);
      if (!choice) continue;

      // Stamp first. A crash between here and the send loses one email; the
      // other order loses the cap and mails the same person on every sweep.
      await prisma.petParent.update({
        where: { id: p.id },
        data: { lastMarketingAt: now, ...(choice.digest ? { lastDigestAt: now } : {}) },
      });

      notify(choice.mail);
      sent += 1;
    } catch (err) {
      logger.warn({ err, parentId: p.id }, 'engagement sweep: skipped one parent');
    }
  }

  if (sent > 0) logger.info({ considered: candidates.length, sent }, 'engagement sweep sent');
  return { considered: candidates.length, sent };
}

/**
 * Three or four times a day at unpredictable times, in the window pet parents
 * are actually awake and looking at their phone. See vendor-engagement for why
 * this is not a fixed interval, and note it does not change how often any one
 * parent hears from us — that stays one promotional email per MIN_GAP_DAYS,
 * enforced per row.
 *
 * Offset later than the vendor window so the two sweeps do not compete for the
 * same SMTP minute.
 */
export function startEngagementJob(): void {
  startRandomDailyJob('parent-engagement', runEngagementSweep, {
    minRuns: 3,
    maxRuns: 4,
    startHour: 11,
    endHour: 21,
    minGapMinutes: 90,
  });
}

