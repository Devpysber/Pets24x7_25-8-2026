// Promotional sweep for businesses — the vendor counterpart to
// jobs/engagement.ts, and it follows the same two rules:
//
//   1. One promotional email per vendor per MIN_GAP_DAYS, whatever matched.
//      The sweep picks the single most useful thing to say and drops the rest.
//   2. Cadence lives in the database (Vendor.lastMarketingAt / lastPromoKind),
//      so a restart or a deploy cannot reset the clock and re-send. The row is
//      stamped BEFORE the mail is handed off, with a conditional update so two
//      overlapping sweeps cannot both claim it: a crash mid-send costs one
//      missed email rather than a duplicate storm.
//
// Repeats. lastPromoKind alone only stopped a message going out twice IN A
// ROW, so a vendor with a gap in their profile in a busy city got
// profile_gaps, visibility, profile_gaps, visibility... one a day, forever,
// each identical to the one two days before. Now:
//   • open_enquiries goes out only when an enquiry arrived since the last
//     promo (new information), or as a weekly reminder while they sit there;
//   • the evergreen advice mails (profile_gaps, collect_reviews, visibility)
//     share one slot of at most one per EVERGREEN_GAP_DAYS, and rotate through
//     the kinds starting after whichever went last, so consecutive advice
//     mails always differ.
// All of it reads lastMarketingAt + lastPromoKind, so it needs no new column.
//
// Scale: vendors are walked in id order in pages, with a cursor that carries
// over between sweeps. The old "oldest lastMarketingAt first, top 150" query
// starved everyone else once 150 vendors had nothing to be told — they are
// never stamped, so they sat at the front of every sweep. A city's listing
// count is computed once per sweep, not once per vendor. India and US
// businesses each get their own schedule in their own business hours.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { kv } from '../shared/kv.js';
import { startRandomDailyJob } from './random-schedule.js';
import { env } from '../env.js';
import { notify } from '../mail/notify.js';
import { normalizeEmail } from '../mail/optout.js';
import type { MailInput } from '../mail/mailer.js';
import { getListingById, listingsInCity, shownRating } from '../listings/index.js';
import {
  vendorCollectReviewsEmail,
  vendorListingLiveEmail,
  vendorOpenEnquiriesEmail,
  vendorProfileGapsEmail,
  vendorVisibilityEmail,
  type VendorPromoContext,
} from '../mail/promo-templates.js';
import { mailSite } from '../mail/components.js';

const DAY = 24 * 3600 * 1000;

/**
 * Hard floor between any two promotional emails to the same business: at most
 * one a day. 20 hours rather than 24 because the sweeps run at random times,
 * so a strict day would push someone mailed at 16:00 past every slot tomorrow.
 */
const MIN_GAP_DAYS = 20 / 24;
/** Ceiling on mails per sweep, so a first run on a large list cannot empty the quota. */
const MAX_PER_SWEEP = 150;
/** Ceiling on vendors evaluated per sweep; the cursor carries on next time. */
const MAX_CONSIDERED_PER_SWEEP = 1500;
/** Vendors loaded per page. */
const PAGE_SIZE = 100;
/** A brand-new vendor gets the "you are live" mail once, this soon after claiming. */
const WELCOME_WINDOW_DAYS = 30;
/** Evergreen advice (profile, reviews, visibility): at most one per this many days. */
const EVERGREEN_GAP_DAYS = 7;
/** The same evergreen advice twice in a row only this far apart. */
const EVERGREEN_SAME_KIND_DAYS = 28;
/** Unanswered enquiries with nothing new since the last promo: a reminder this often. */
const OPEN_ENQUIRY_REPEAT_DAYS = 7;

type PromoKind = 'listing_live' | 'open_enquiries' | 'profile_gaps' | 'collect_reviews' | 'visibility';
/** Advice that stays true until the vendor acts, so it must be paced and rotated. */
const EVERGREEN: PromoKind[] = ['profile_gaps', 'collect_reviews', 'visibility'];

type Audience = 'IN' | 'US';
/** Minutes offset from UTC for each audience's business hours. */
const AUDIENCE_TZ_MIN: Record<Audience, number> = {
  IN: 5 * 60 + 30,
  US: -5 * 60, // US Eastern standard time
};

interface VendorRow {
  id: string;
  businessName: string;
  email: string | null;
  city: string | null;
  country: string | null;
  status: string;
  listingId: string | null;
  imageUrl: string | null;
  about: string | null;
  openingHours: string | null;
  servicesList: string | null;
  claimedAt: Date | null;
  lastMarketingAt: Date | null;
  lastPromoKind: string | null;
}

function listingUrlFor(v: VendorRow): string | null {
  if (!v.listingId) return null;
  const listing = getListingById(v.listingId);
  const site = mailSite();
  if (!listing) return `${site}/dashboard/vendor/`;
  return `${site}/${String(listing.country).toLowerCase()}/${listing.city_slug}/${listing.id}/`;
}

function contextFor(v: VendorRow): VendorPromoContext & { country: string | null } {
  const listing = v.listingId ? getListingById(v.listingId) : undefined;
  return {
    businessName: v.businessName,
    city: v.city ?? listing?.city ?? null,
    country: v.country ?? (listing ? String(listing.country) : null),
    listingUrl: listingUrlFor(v),
    rating: listing ? shownRating(listing) || null : null,
    reviewCount: listing?.review_count ?? null,
  };
}

/** What is missing from the public page, in the order a vendor should fix it. */
function profileGaps(v: VendorRow): string[] {
  const gaps: string[] = [];
  if (!v.imageUrl) gaps.push('A storefront photo — the first thing anyone sees');
  if (!v.about) gaps.push('A short description of what you do');
  if (!v.servicesList) gaps.push('The services you offer');
  if (!v.openingHours) gaps.push('Your opening hours');
  return gaps;
}

/** Listings per city, counted once per sweep. listingsInCity walks the whole index. */
type CityCounter = (city: string, country: string | null) => number;

function cityCounter(): CityCounter {
  const cache = new Map<string, number>();
  return (city, country) => {
    const key = `${(country || '').toUpperCase()}|${city.toLowerCase().trim()}`;
    let n = cache.get(key);
    if (n === undefined) {
      n = listingsInCity(city, country ?? undefined).length;
      cache.set(key, n);
    }
    return n;
  };
}

/**
 * Picks the one thing worth saying to this vendor right now, most useful first.
 * Returns null when nothing is worth an email — silence is a valid outcome and
 * is what keeps this from becoming noise.
 */
async function pickMessage(
  v: VendorRow,
  now: Date,
  countCity: CityCounter,
): Promise<{ kind: PromoKind; mail: MailInput } | null> {
  const to = v.email!;
  const ctx = contextFor(v);
  const cityListings = ctx.city ? countCity(ctx.city, ctx.country) : 0;
  const sameAsLast = (kind: PromoKind) => v.lastPromoKind === kind;
  const daysSinceLast = v.lastMarketingAt ? (now.getTime() - v.lastMarketingAt.getTime()) / DAY : Infinity;

  // 1. Unanswered enquiries. Money on the table, so it outranks everything.
  //    Matched the same way the vendor dashboard lists them. Only when one is
  //    new since the last promo, or weekly while they wait — the same count
  //    mailed every other day told the vendor nothing new.
  if (v.listingId || v.businessName) {
    const mine = { status: 'NEW' as const, OR: [{ listingId: v.listingId ?? '__none__' }, { listingName: v.businessName }] };
    const openCount = await prisma.enquiry.count({ where: mine }).catch(() => 0);
    if (openCount > 0) {
      const arrivedSince = v.lastMarketingAt
        ? await prisma.enquiry.count({ where: { ...mine, createdAt: { gt: v.lastMarketingAt } } }).catch(() => 0)
        : openCount;
      if (arrivedSince > 0 || daysSinceLast >= OPEN_ENQUIRY_REPEAT_DAYS) {
        return { kind: 'open_enquiries', mail: vendorOpenEnquiriesEmail(to, ctx, openCount) };
      }
    }
  }

  // 2. A newly claimed listing: show them the live page once. "Once" means no
  //    promo has gone out since the claim — lastPromoKind alone let it come
  //    back every other day for the whole welcome window.
  const claimedRecently =
    v.claimedAt != null && now.getTime() - v.claimedAt.getTime() < WELCOME_WINDOW_DAYS * DAY;
  const mailedSinceClaim = v.claimedAt != null && v.lastMarketingAt != null && v.lastMarketingAt > v.claimedAt;
  if (claimedRecently && !mailedSinceClaim && !sameAsLast('listing_live')) {
    return { kind: 'listing_live', mail: vendorListingLiveEmail(to, ctx, cityListings) };
  }

  // 3-5. Evergreen advice: one slot a week, rotating. Each kind has its own
  //      precondition; the rotation starts after whichever went out last.
  if (daysSinceLast < EVERGREEN_GAP_DAYS) return null;
  const gaps = profileGaps(v);
  const eligible: Record<string, () => MailInput | null> = {
    // Gaps on the public page.
    profile_gaps: () => (gaps.length > 0 ? vendorProfileGapsEmail(to, ctx, gaps) : null),
    // Reviews — only worth asking of a vendor whose page is otherwise ready.
    collect_reviews: () => (gaps.length === 0 ? vendorCollectReviewsEmail(to, ctx) : null),
    // Visibility — only where there is real competition to stand out from;
    // selling placement in a city with three listings would be dishonest.
    visibility: () => (cityListings >= 10 ? vendorVisibilityEmail(to, ctx, cityListings) : null),
  };
  const lastIdx = EVERGREEN.indexOf(v.lastPromoKind as PromoKind);
  for (let i = 1; i <= EVERGREEN.length; i++) {
    const kind = EVERGREEN[(lastIdx + i + EVERGREEN.length) % EVERGREEN.length]!;
    // Never the same advice twice running unless it is the only one that fits
    // and a month has passed — then it is a reminder, not a repeat.
    if (sameAsLast(kind) && daysSinceLast < EVERGREEN_SAME_KIND_DAYS) continue;
    const mail = eligible[kind]!();
    if (mail) return { kind, mail };
  }

  return null;
}

/**
 * Where each audience's walk stopped last sweep. Kept in the shared kv (Redis
 * when configured, process memory otherwise) so whichever instance wins the
 * next slot carries on from there. Losing it only restarts the walk.
 */
const cursorKey = (audience: Audience) => `job:vendor-engagement:cursor:${audience}`;
const CURSOR_TTL_MS = 30 * DAY;

function audienceWhere(audience: Audience) {
  // A business with no country on file is treated as India, the app's default.
  return audience === 'US'
    ? { country: 'US' }
    : { OR: [{ country: null }, { country: { not: 'US' } }] };
}

export async function runVendorEngagementSweep(
  audience: Audience = 'IN',
): Promise<{ considered: number; sent: number }> {
  const now = new Date();
  const gapBefore = new Date(now.getTime() - MIN_GAP_DAYS * DAY);
  const outsideGap = { OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lt: gapBefore } }] };
  const countCity = cityCounter();

  let cursor = (await kv.get(cursorKey(audience))) || null;
  let wrapped = cursor === null;
  let considered = 0;
  let sent = 0;

  while (sent < MAX_PER_SWEEP && considered < MAX_CONSIDERED_PER_SWEEP) {
    // Only businesses we can actually mail, and only those outside the gap. An
    // unverified address is excluded: nobody at it has confirmed they want mail.
    const page = (await prisma.vendor.findMany({
      where: {
        email: { not: null },
        emailVerified: true,
        status: { in: ['ACTIVE', 'CLAIMED'] },
        // Real accounts only. Most vendor rows are scraped directory entries
        // that were loaded with status ACTIVE and never opted in to anything,
        // so status says nothing about consent. Either of two things does: the
        // business claimed its listing, or it holds a password because it
        // registered. Testing claimedAt alone also excluded a business that
        // signed up and verified its address through a path that never set it.
        //
        // An unclaimed directory row still gets exactly one message ever, the
        // claim invitation, sent by hand from scripts/claim-campaign.mjs.
        AND: [
          { OR: [{ claimedAt: { not: null } }, { passwordHash: { not: null } }] },
          outsideGap,
          audienceWhere(audience),
          ...(cursor ? [{ id: { gt: cursor } }] : []),
        ],
      },
      select: {
        id: true,
        businessName: true,
        email: true,
        city: true,
        country: true,
        status: true,
        listingId: true,
        imageUrl: true,
        about: true,
        openingHours: true,
        servicesList: true,
        claimedAt: true,
        lastMarketingAt: true,
        lastPromoKind: true,
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    })) as VendorRow[];

    if (page.length === 0) {
      cursor = null;
      if (wrapped) break;
      wrapped = true;
      continue;
    }

    // Suppression for the whole page in one query, before any counting work:
    // sendMail would catch it anyway, but not before we had built a message.
    const optedOut = new Set(
      (
        await prisma.emailOptOut.findMany({
          where: { email: { in: page.map((v) => normalizeEmail(v.email!)) } },
          select: { email: true },
        })
      ).map((r) => r.email),
    );

    for (const v of page) {
      cursor = v.id;
      considered++;
      try {
        if (optedOut.has(normalizeEmail(v.email!))) continue;

        const choice = await pickMessage(v, now, countCity);
        if (!choice) continue;

        // Stamp first, and only if nobody else has since. A crash between here
        // and the send loses one email; the other order loses the cap.
        const { count } = await prisma.vendor.updateMany({
          where: { id: v.id, ...outsideGap },
          data: { lastMarketingAt: now, lastPromoKind: choice.kind },
        });
        if (count !== 1) continue;

        notify(choice.mail);
        sent += 1;
      } catch (err) {
        logger.warn({ err, vendorId: v.id }, 'vendor engagement sweep: skipped one vendor');
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
  if (sent > 0) logger.info({ audience, considered, sent }, 'vendor engagement sweep sent');
  return { considered, sent };
}

/**
 * Three or four times a day, at times picked fresh each morning inside
 * business hours — each audience's own. A fixed four-hour interval from process
 * boot meant a deploy at 03:00 mailed businesses at 03:00, and gave every send
 * an identical rhythm.
 *
 * This does not change how often one business hears from us: that is one
 * promotional email per vendor per MIN_GAP_DAYS, enforced on the row itself.
 * More frequent sweeps only mean a vendor who becomes eligible at 10am is not
 * waiting until the evening.
 *
 * Nothing runs on boot, so a crash loop cannot become a mail loop.
 */
export function startVendorEngagementJob(): void {
  for (const audience of ['IN', 'US'] as const) {
    startRandomDailyJob(`vendor-engagement-${audience}`, () => runVendorEngagementSweep(audience), {
      minRuns: 3,
      maxRuns: 4,
      // Business hours for the people receiving it, not for the server.
      startHour: 10,
      endHour: 19,
      minGapMinutes: 90,
      timezoneOffsetMinutes: AUDIENCE_TZ_MIN[audience],
    });
  }
}
