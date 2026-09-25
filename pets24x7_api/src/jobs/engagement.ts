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
//      and re-send. The row is stamped BEFORE the mail is handed off — with a
//      conditional update, so two overlapping sweeps (or two API instances)
//      cannot both claim the same parent: a crash mid-send costs one missed
//      email rather than a duplicate storm.
//
// Scale: the audience is walked in id order in small pages with a cursor that
// persists between sweeps, so every eligible parent is reached in turn. The old
// "oldest lastMarketingAt first, top 200" query starved everyone else once more
// than 200 parents had nothing to be told (they are never stamped, so they sat
// at the front forever). Data every parent shares (featured and claimed ids,
// a city's listing pool) is loaded once per sweep, not once per parent.
//
// Each audience (India, USA) runs on its own schedule in its own timezone, so
// nobody is mailed in the middle of their night.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { kv } from '../shared/kv.js';
import { startRandomDailyJob } from './random-schedule.js';
import { notify } from '../mail/notify.js';
import { normalizeEmail } from '../mail/optout.js';
import type { MailInput } from '../mail/mailer.js';
import { env } from '../env.js';
import { getListingById, listingsInCity, shownRating, type ListingRecord } from '../listings/index.js';
import { recommend } from '../feed/recommend.js';
import { buildRecoDigest, digestDue } from '../feed/reco/digest.js';
import { getRecoConfig, type RecoConfig } from '../feed/reco/config.js';
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
// The recommendations digest is the baseline; everything else displaces it.
// Its cadence is the parent's own choice (PetParent.digestFrequency, set from
// the dashboard or the digest's "stop" link) or the admin default in the reco
// config — see feed/reco/digest.ts digestDue(). It used to be a fixed daily
// constant here, which mailed parents who had switched the digest OFF.
/** An event is worth mentioning this far ahead, and no further. */
const EVENT_HORIZON_DAYS = 3;
/** A lapsed member is worth one win-back inside this window, then left alone. */
const WINBACK_FROM_DAYS = 3;
const WINBACK_TO_DAYS = 30;
/** Silence this long earns a single nudge. */
const INACTIVE_DAYS = 30;
/** Ceiling on mails per sweep, so a first run on a large list cannot empty the quota. */
const MAX_PER_SWEEP = 200;
/** Ceiling on parents evaluated per sweep; the cursor carries on next time. */
const MAX_CONSIDERED_PER_SWEEP = 2000;
/** Parents loaded per page. */
const PAGE_SIZE = 100;

/** A booster is treated as annual. */
const VACCINE_INTERVAL_DAYS = 365;
/**
 * Days relative to the due date on which the booster reminder goes out: two
 * weeks ahead, one week ahead, on the day, and twice after if still not done.
 * Date-specific, like the birthday, so it cannot repeat every day: the old
 * "due within 14 days" test matched every day from two weeks out to forever
 * after, mailing the same reminder daily and crowding out everything else.
 */
const VACCINE_NUDGE_DAYS = [14, 7, 0, -14, -45];
/** A pet unseen by a vet for this long is worth a check-up nudge... */
const CHECKUP_AFTER_DAYS = 365;
/** ...repeated this often while it stays overdue, not daily. */
const CHECKUP_REPEAT_DAYS = 60;

type Audience = 'IN' | 'US';
/** Minutes offset from UTC for each audience's sending window. */
const AUDIENCE_TZ_MIN: Record<Audience, number> = {
  IN: 5 * 60 + 30,
  // US Eastern standard time; in daylight time the window shifts an hour
  // later, which still lands inside waking hours coast to coast.
  US: -5 * 60,
};

interface Parent {
  id: string;
  name: string;
  email: string | null;
  city: string | null;
  country: string | null;
  createdAt: Date;
  lastMarketingAt: Date | null;
  lastDigestAt: Date | null;
  digestFrequency: string | null;
  recentPromoIds: string | null;
}

interface Choice {
  mail: MailInput;
  /** True when this counts as the daily digest, which paces itself separately. */
  digest: boolean;
  /** New value for PetParent.recentPromoIds, written with the stamp. */
  recentPromoIds?: string;
  /** Runs once the send stamp is claimed (digest impression logging). */
  onSent?: () => void;
}

type PetRow = Awaited<ReturnType<typeof prisma.pet.findMany>>[number];

/** Shared, per-sweep state: loaded once, reused for every parent. */
class SweepContext {
  readonly today: number;
  private shared: Promise<{ featured: string[]; claimed: string[] }> | null = null;
  private pools = new Map<string, ListingRecord[]>();
  private reco: Promise<RecoConfig | null> | null = null;

  constructor(readonly now: Date, readonly tzMin: number) {
    // Local calendar day number in the audience's timezone.
    this.today = Math.floor((now.getTime() + tzMin * 60_000) / DAY);
  }

  /** The local date in the audience's timezone, read with getUTC* getters. */
  localDate(): Date {
    return new Date(this.now.getTime() + this.tzMin * 60_000);
  }

  sharedIds(): Promise<{ featured: string[]; claimed: string[] }> {
    if (!this.shared) {
      this.shared = Promise.all([
        prisma.featuredListing.findMany({
          where: { status: 'ACTIVE', endsAt: { gt: this.now } },
          select: { listingId: true },
        }),
        prisma.vendor.findMany({
          where: { status: { in: ['ACTIVE', 'CLAIMED'] }, listingId: { not: null }, claimedAt: { not: null } },
          select: { listingId: true },
        }),
      ]).then(([f, c]) => ({
        featured: f.map((r) => r.listingId).filter((id): id is string => !!id),
        claimed: c.map((r) => r.listingId).filter((id): id is string => !!id),
      }));
    }
    return this.shared;
  }

  /** Admin reco config (digest on/off, default cadence), read once per sweep. */
  recoConfig(): Promise<RecoConfig | null> {
    if (!this.reco) {
      this.reco = getRecoConfig().catch((err) => {
        logger.warn({ err }, 'engagement sweep: reco config unavailable');
        return null;
      });
    }
    return this.reco;
  }

  cityPool(city: string, country: string): ListingRecord[] {
    const key = `${country}|${city.toLowerCase().trim()}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = listingsInCity(city, country);
      this.pools.set(key, pool);
    }
    return pool;
  }
}

function daysSince(at: Date | null, now: Date): number {
  if (!at) return Number.POSITIVE_INFINITY;
  return (now.getTime() - at.getTime()) / DAY;
}

/** Day number of a date-only column (stored as UTC midnight). */
function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY);
}

/**
 * The frontend stores a display city; deals and events are keyed by slug.
 * Same rule the admin and feed routes use to write citySlug, so "St. Louis"
 * matches "st-louis" rather than "st.-louis".
 */
function slugify(city: string): string {
  return city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * The one thing worth saying to this parent right now, or null for silence.
 *
 * Ordered by how much the recipient is likely to care, not by what we would
 * rather sell: something they already paid for lapsing beats an event, which
 * beats a discount, which beats a generic digest.
 */
async function pickMessage(p: Parent, ctx: SweepContext): Promise<Choice | null> {
  const email = p.email!;
  const now = ctx.now;

  // Health first. These are about the animal rather than about us, and they are
  // the only messages here a parent would be annoyed to have NOT received.
  // Each fires only when the date it depends on has been filled in.
  const pets = await prisma.pet.findMany({ where: { ownerId: p.id } });

  // 1. A birthday, today (in the parent's timezone). Once a year and
  //    date-specific: if the gap below swallows it, it is gone until next
  //    year, which is the accepted cost of never sending two promos in one day.
  //    Dates of birth are stored as UTC midnight, so compare UTC parts.
  const local = ctx.localDate();
  for (const pet of pets) {
    if (!pet.dateOfBirth) continue;
    const dob = pet.dateOfBirth;
    if (dob.getUTCMonth() === local.getUTCMonth() && dob.getUTCDate() === local.getUTCDate()) {
      const age = local.getUTCFullYear() - dob.getUTCFullYear();
      return { mail: petBirthdayEmail(email, p.name, pet.name, age > 0 ? age : null), digest: false };
    }
  }

  // 2. A booster coming due, due today, or overdue — on set days only.
  for (const pet of pets) {
    if (!pet.lastVaccinatedAt) continue;
    const dueDay = dayNumber(pet.lastVaccinatedAt) + VACCINE_INTERVAL_DAYS;
    if (VACCINE_NUDGE_DAYS.includes(dueDay - ctx.today)) {
      const dueAt = new Date(pet.lastVaccinatedAt.getTime() + VACCINE_INTERVAL_DAYS * DAY);
      return { mail: vaccinationDueEmail(email, p.name, pet.name, 'Annual booster', dueAt), digest: false };
    }
  }

  // 3. No vet visit on record for a year: on the anniversary, then every
  //    CHECKUP_REPEAT_DAYS while it stays that way.
  for (const pet of pets) {
    if (!pet.lastCheckupAt) continue;
    const d = ctx.today - dayNumber(pet.lastCheckupAt);
    if (d >= CHECKUP_AFTER_DAYS && (d - CHECKUP_AFTER_DAYS) % CHECKUP_REPEAT_DAYS === 0) {
      return { mail: petCheckupEmail(email, p.name, pet.name, Math.floor(d / 30)), digest: false };
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
  // Win-back is "once inside the window": only while nothing has gone out since
  // the window opened, or it would repeat every day for four weeks.
  const winbackOpened = lapsed?.endsAt ? lapsed.endsAt.getTime() + WINBACK_FROM_DAYS * DAY : 0;
  if (lapsed && lapsed.endsAt && !(p.lastMarketingAt && p.lastMarketingAt.getTime() > winbackOpened)) {
    const stillActive = await prisma.membership.count({
      where: { parentId: p.id, status: 'ACTIVE', endsAt: { gt: now } },
    });
    if (stillActive === 0) {
      return { mail: winbackEmail(email, p.name, lapsed.plan.name), digest: false };
    }
  }

  // City-scoped content needs a city. Without one we cannot claim "near you".
  const citySlug = p.city ? slugify(p.city) || null : null;

  // 5. An event in their city, close enough to act on.
  if (citySlug) {
    const ev = await prisma.event.findFirst({
      where: {
        status: 'PUBLISHED',
        citySlug,
        // Inside the horizon, and it only entered the horizon after the last
        // mail — otherwise that mail (this one, or anything that outranked it)
        // already went out while it was on, and it would repeat for 3 days.
        startsAt: {
          gt: new Date(Math.max(now.getTime(), (p.lastMarketingAt?.getTime() ?? 0) + EVENT_HORIZON_DAYS * DAY)),
          lt: new Date(now.getTime() + EVENT_HORIZON_DAYS * DAY),
        },
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
          // The organiser's page when there is one, else the city page the
          // event is listed against — never a bare link to the home page.
          url: /^https:\/\//i.test(ev.rsvpUrl ?? '') ? ev.rsvpUrl! : cityPageUrl(ev.country ?? p.country, citySlug),
          timeZone: (ev.country ?? p.country) === 'US' ? US_DISPLAY_TZ : undefined,
        }),
        digest: false,
      };
    }
  }

  // 6. A live deal in their city they have not been told about yet. Keyed off
  //    the last mail we sent, so a deal that predates it is treated as old news.
  //    A deal scheduled to start later is not announced before it is live, and
  //    counts as new once it goes live.
  if (citySlug) {
    const since = p.lastMarketingAt ?? p.createdAt;
    const deal = await prisma.deal.findFirst({
      where: {
        status: 'ACTIVE',
        citySlug,
        startsAt: { lte: now },
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          { OR: [{ createdAt: { gt: since } }, { startsAt: { gt: since } }] },
        ],
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
          url: dealUrl(deal, p.country, citySlug),
        }),
        digest: false,
      };
    }
  }

  // 7. Businesses that joined in their city since the last mail. This is the
  //    only message here carrying genuinely new information rather than a
  //    re-ranking of what was already on the site, so it outranks the digest.
  if (p.city && citySlug) {
    const since = p.lastMarketingAt ?? p.createdAt;
    const added = await prisma.listing
      .findMany({
        where: { citySlug, importedAt: { gt: since } },
        orderBy: { importedAt: 'desc' },
        take: 5,
        select: { id: true, name: true, category: true, rating: true, reviewCount: true, citySlug: true, country: true },
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
            rating: shownRating({ rating: l.rating, review_count: l.reviewCount }),
            url: `${site}/${l.country.toLowerCase()}/${l.citySlug}/${l.id}/`,
          })),
        ),
        digest: false,
      };
    }
  }

  // 8. The recommendations digest, at the cadence the parent chose (or the
  //    admin default). Built by the reco engine, which excludes whatever the
  //    last digests showed; the legacy ranker is only a fallback for when the
  //    engine itself is unavailable, never a way round a null ("nothing worth
  //    sending") answer.
  const recoConfig = await ctx.recoConfig();
  const due = recoConfig
    ? digestDue(p, recoConfig, now)
    : String(p.digestFrequency ?? '').toUpperCase() !== 'OFF' && daysSince(p.lastDigestAt, now) >= LEGACY_DIGEST_GAP_DAYS;
  if (due) {
    let built: Awaited<ReturnType<typeof buildRecoDigest>> | undefined;
    if (recoConfig) {
      try {
        built = await buildRecoDigest(p);
      } catch (err) {
        logger.warn({ err, parentId: p.id }, 'engagement sweep: reco digest failed; using legacy ranker');
      }
    }
    if (built) return { mail: built.mail, digest: true, recentPromoIds: built.recentPromoIds, onSent: built.onSent };
    if (built === undefined) {
      const legacy = await recommendationsFor(p, pets, ctx);
      if (legacy) return { mail: legacy.mail, digest: true, recentPromoIds: legacy.recentPromoIds };
    }
  }

  // 9. Nothing specific to say, and they have gone quiet. One nudge per
  //    INACTIVE_DAYS, and only for parents with no city: with a city the
  //    digest already covers them, and two generic mails would be one too many.
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
async function recommendationsFor(
  p: Parent,
  pets: PetRow[],
  ctx: SweepContext,
): Promise<{ mail: MailInput; recentPromoIds: string } | null> {
  // Same rule as the first-pet mail: no city means we cannot honestly say
  // "near you", so we say nothing.
  if (!p.city) return null;
  const country = (p.country || 'IN').toUpperCase();

  const [enquiries, saved, shared] = await Promise.all([
    prisma.enquiry.findMany({
      where: { petParentId: p.id },
      select: { category: true, listingId: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.savedListing.findMany({
      where: { parentId: p.id },
      select: { category: true, listingId: true },
      take: 50,
    }),
    ctx.sharedIds(),
  ]);

  // Whatever the last digests showed is dropped from the pool before ranking.
  // Without this the same top-rated businesses win every day and the mail
  // reads as a duplicate, which is exactly how a digest earns an unsubscribe.
  const previous = parseRecentPromoIds(p.recentPromoIds);
  const pool = ctx.cityPool(p.city, country);
  // Once a small city runs out of never-shown names, forget the oldest memory
  // first rather than all of it: dropping the whole list put the same top five
  // back in every mail from then on. The last digest's picks are never reused
  // back to back while anything else is available.
  const lastBatch = new Set(previous.slice(0, DIGEST_ITEMS));
  let candidatePool = pool;
  for (let keep = previous.length; ; keep -= DIGEST_ITEMS) {
    const k = Math.max(keep, Math.min(DIGEST_ITEMS, previous.length));
    const shown = new Set(previous.slice(0, k));
    const fresh = pool.filter((l) => !shown.has(l.id));
    if (fresh.length >= DIGEST_ITEMS || k <= DIGEST_ITEMS) {
      // Never the whole pool: that put the last digest straight back.
      candidatePool = fresh.length >= 3 ? fresh : pool.filter((l) => !lastBatch.has(l.id));
      break;
    }
  }

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
      featuredListingIds: shared.featured,
      claimedListingIds: shared.claimed,
    },
    DIGEST_ITEMS,
  );
  // A thin list is not worth an email.
  if (picks.length < 3) return null;

  const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  return {
    // Remembered with the send stamp, so the next one differs.
    recentPromoIds: nextPromoIds(previous, picks.map((r) => r.listing.id)),
    mail: recommendationsEmail(
      p.email!,
      p.name,
      pets[0]?.name ?? null,
      picks.map((r) => ({
        name: r.listing.name,
        category: r.listing.category,
        city: r.listing.city,
        rating: shownRating(r.listing),
        reviewCount: r.listing.review_count,
        reasons: r.reasons,
        url: `${site}/${String(r.listing.country).toLowerCase()}/${r.listing.city_slug}/${r.listing.id}/`,
      })),
    ),
  };
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
/** Places per legacy digest. */
const DIGEST_ITEMS = 5;
/** Legacy fallback cadence when the reco config cannot be read: weekly, the admin default. */
const LEGACY_DIGEST_GAP_DAYS = 6.8;
/** Dates in a US parent's mail: Eastern, the same zone the US sweep runs in. */
const US_DISPLAY_TZ = 'America/New_York';

/** Public city page, as built by pets24x7_new/build_pages.py. */
function cityPageUrl(country: string | null | undefined, citySlug: string): string {
  const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  return `${site}/${(country || 'IN').toLowerCase() === 'us' ? 'us' : 'in'}/${citySlug}/`;
}

/** Where a deal mail should land: the business's own page, else the city page. */
function dealUrl(
  deal: { listingId: string | null; country: string | null },
  parentCountry: string | null,
  citySlug: string,
): string {
  const listing = deal.listingId ? getListingById(deal.listingId) : undefined;
  if (listing) {
    const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
    return `${site}/${String(listing.country).toLowerCase()}/${listing.city_slug}/${listing.id}/`;
  }
  return cityPageUrl(deal.country ?? parentCountry, citySlug);
}

function nextPromoIds(previous: string[], justSent: string[]): string {
  return JSON.stringify([...justSent, ...previous].slice(0, PROMO_MEMORY));
}

/**
 * Where each audience's walk stopped last sweep. Kept in the shared kv (Redis
 * when configured, process memory otherwise) so whichever instance wins the
 * next slot carries on from there. Losing it only restarts the walk.
 */
const cursorKey = (audience: Audience) => `job:parent-engagement:cursor:${audience}`;
const CURSOR_TTL_MS = 30 * DAY;

function audienceWhere(audience: Audience) {
  // A parent with no country on file is treated as India, the app's default.
  return audience === 'US'
    ? { country: 'US' }
    : { OR: [{ country: null }, { country: { not: 'US' } }] };
}

export async function runEngagementSweep(
  audience: Audience = 'IN',
): Promise<{ considered: number; sent: number }> {
  const now = new Date();
  const ctx = new SweepContext(now, AUDIENCE_TZ_MIN[audience]);
  const gapBefore = new Date(now.getTime() - MIN_GAP_DAYS * DAY);
  const outsideGap = { OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lt: gapBefore } }] };

  let cursor = (await kv.get(cursorKey(audience))) || null;
  // Starting from the top, reaching the end means everyone has been seen.
  let wrapped = cursor === null;
  let considered = 0;
  let sent = 0;

  while (sent < MAX_PER_SWEEP && considered < MAX_CONSIDERED_PER_SWEEP) {
    // Only parents who are actually mailable, and only those outside the gap,
    // filtered in the database. An unverified address is excluded: we have no
    // evidence anyone at that address asked to hear from us.
    const page = (await prisma.petParent.findMany({
      where: {
        email: { not: null },
        emailVerified: true,
        AND: [outsideGap, audienceWhere(audience), ...(cursor ? [{ id: { gt: cursor } }] : [])],
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
        digestFrequency: true,
        recentPromoIds: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    })) as Parent[];

    if (page.length === 0) {
      cursor = null;
      if (wrapped) break;
      wrapped = true;
      continue;
    }

    // Suppression for the whole page in one query. sendMail would catch it
    // anyway, but not before we had built an entire digest for nobody.
    const optedOut = new Set(
      (
        await prisma.emailOptOut.findMany({
          where: { email: { in: page.map((p) => normalizeEmail(p.email!)) } },
          select: { email: true },
        })
      ).map((r) => r.email),
    );

    for (const p of page) {
      cursor = p.id;
      considered++;
      try {
        if (optedOut.has(normalizeEmail(p.email!))) continue;

        const choice = await pickMessage(p, ctx);
        if (!choice) continue;

        // Stamp first, and only if nobody else has since. A crash between here
        // and the send loses one email; the other order loses the cap.
        const { count } = await prisma.petParent.updateMany({
          where: { id: p.id, ...outsideGap },
          data: {
            lastMarketingAt: now,
            ...(choice.digest ? { lastDigestAt: now } : {}),
            ...(choice.recentPromoIds ? { recentPromoIds: choice.recentPromoIds } : {}),
          },
        });
        if (count !== 1) continue;

        notify(choice.mail);
        try {
          choice.onSent?.();
        } catch (err) {
          logger.warn({ err, parentId: p.id }, 'engagement sweep: digest impression logging failed');
        }
        sent += 1;
      } catch (err) {
        logger.warn({ err, parentId: p.id }, 'engagement sweep: skipped one parent');
      }
      if (sent >= MAX_PER_SWEEP || considered >= MAX_CONSIDERED_PER_SWEEP) break;
    }

    if (page.length < PAGE_SIZE && sent < MAX_PER_SWEEP && considered < MAX_CONSIDERED_PER_SWEEP) {
      cursor = null;
      if (wrapped) break;
      wrapped = true;
    }
  }

  if (cursor) await kv.set(cursorKey(audience), cursor, CURSOR_TTL_MS);
  else await kv.del(cursorKey(audience));
  if (sent > 0) logger.info({ audience, considered, sent }, 'engagement sweep sent');
  return { considered, sent };
}

/**
 * Three or four times a day at unpredictable times, in the window pet parents
 * are actually awake and looking at their phone — in their own timezone, one
 * schedule per audience. See vendor-engagement for why this is not a fixed
 * interval, and note it does not change how often any one parent hears from
 * us — that stays one promotional email per MIN_GAP_DAYS, enforced per row.
 *
 * Offset later than the vendor window so the two sweeps do not compete for the
 * same SMTP minute.
 */
export function startEngagementJob(): void {
  for (const audience of ['IN', 'US'] as const) {
    startRandomDailyJob(`parent-engagement-${audience}`, () => runEngagementSweep(audience), {
      minRuns: 3,
      maxRuns: 4,
      startHour: 11,
      endHour: 21,
      minGapMinutes: 90,
      timezoneOffsetMinutes: AUDIENCE_TZ_MIN[audience],
    });
  }
}
