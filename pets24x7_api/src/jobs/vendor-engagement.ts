// Promotional sweep for businesses — the vendor counterpart to
// jobs/engagement.ts, and it follows the same two rules:
//
//   1. One promotional email per vendor per MIN_GAP_DAYS, whatever matched.
//      The sweep picks the single most useful thing to say and drops the rest.
//   2. Cadence lives in the database (Vendor.lastMarketingAt / lastPromoKind),
//      so a restart or a deploy cannot reset the clock and re-send. The row is
//      stamped BEFORE the mail is handed off: a crash mid-send costs one missed
//      email rather than a duplicate storm.
//
// lastPromoKind also stops the same message repeating: whatever went out last
// time is skipped this time even if it still matches, so a vendor who never
// fixes their missing photo does not receive that mail forever.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startRandomDailyJob } from './random-schedule.js';
import { env } from '../env.js';
import { notify } from '../mail/notify.js';
import { isOptedOut } from '../mail/optout.js';
import type { MailInput } from '../mail/mailer.js';
import { getListingById, listingsInCity } from '../listings/index.js';
import {
  vendorCollectReviewsEmail,
  vendorListingLiveEmail,
  vendorOpenEnquiriesEmail,
  vendorProfileGapsEmail,
  vendorVisibilityEmail,
  type VendorPromoContext,
} from '../mail/promo-templates.js';

const DAY = 24 * 3600 * 1000;

/** Hard floor between any two promotional emails to the same business. */
const MIN_GAP_DAYS = 3;
/** Ceiling per sweep, so a first run on a large list cannot empty the quota. */
const MAX_PER_SWEEP = 150;
/** A brand-new vendor gets the "you are live" mail once, this soon after claiming. */
const WELCOME_WINDOW_DAYS = 30;

type PromoKind = 'listing_live' | 'open_enquiries' | 'profile_gaps' | 'collect_reviews' | 'visibility';

interface VendorRow {
  id: string;
  businessName: string;
  email: string | null;
  city: string | null;
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
  const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
  if (!listing) return `${site}/dashboard/vendor/`;
  return `${site}/${String(listing.country).toLowerCase()}/${listing.city_slug}/${listing.id}/`;
}

function contextFor(v: VendorRow): VendorPromoContext {
  const listing = v.listingId ? getListingById(v.listingId) : undefined;
  return {
    businessName: v.businessName,
    city: v.city ?? listing?.city ?? null,
    listingUrl: listingUrlFor(v),
    rating: listing ? Number(listing.rating) || null : null,
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

/**
 * Picks the one thing worth saying to this vendor right now, most useful first.
 * Returns null when nothing is worth an email — silence is a valid outcome and
 * is what keeps this from becoming noise.
 */
async function pickMessage(v: VendorRow, now: Date): Promise<{ kind: PromoKind; mail: MailInput } | null> {
  const to = v.email!;
  const ctx = contextFor(v);
  const cityListings = ctx.city ? listingsInCity(ctx.city).length : 0;
  const sameAsLast = (kind: PromoKind) => v.lastPromoKind === kind;

  // 1. Unanswered enquiries. Money on the table, so it outranks everything.
  if (v.listingId || v.businessName) {
    const openCount = await prisma.enquiry
      .count({
        where: {
          status: 'NEW',
          OR: [{ listingId: v.listingId ?? '__none__' }, { listingName: v.businessName }],
        },
      })
      .catch(() => 0);
    if (openCount > 0 && !sameAsLast('open_enquiries')) {
      return { kind: 'open_enquiries', mail: vendorOpenEnquiriesEmail(to, ctx, openCount) };
    }
  }

  // 2. A newly claimed listing: show them the live page once.
  const claimedRecently =
    v.claimedAt != null && now.getTime() - v.claimedAt.getTime() < WELCOME_WINDOW_DAYS * DAY;
  if (claimedRecently && !sameAsLast('listing_live')) {
    return { kind: 'listing_live', mail: vendorListingLiveEmail(to, ctx, cityListings) };
  }

  // 3. Gaps on the public page.
  const gaps = profileGaps(v);
  if (gaps.length > 0 && !sameAsLast('profile_gaps')) {
    return { kind: 'profile_gaps', mail: vendorProfileGapsEmail(to, ctx, gaps) };
  }

  // 4. Reviews — only worth asking of a vendor whose page is otherwise ready.
  if (gaps.length === 0 && !sameAsLast('collect_reviews')) {
    return { kind: 'collect_reviews', mail: vendorCollectReviewsEmail(to, ctx) };
  }

  // 5. Visibility. Last, and only where there is real competition to stand out
  // from — selling placement in a city with three listings would be dishonest.
  if (cityListings >= 10 && !sameAsLast('visibility')) {
    return { kind: 'visibility', mail: vendorVisibilityEmail(to, ctx, cityListings) };
  }

  return null;
}

export async function runVendorEngagementSweep(): Promise<{ considered: number; sent: number }> {
  const now = new Date();
  const gapBefore = new Date(now.getTime() - MIN_GAP_DAYS * DAY);

  // Only businesses we can actually mail, and only those outside the gap. An
  // unverified address is excluded: nobody at it has confirmed they want mail.
  const candidates = (await prisma.vendor.findMany({
    where: {
      email: { not: null },
      emailVerified: true,
      status: { in: ['ACTIVE', 'CLAIMED'] },
      // Real accounts only. 137 of the 139 vendor rows are scraped directory
      // entries that were loaded with status ACTIVE and never opted in to
      // anything, so status says nothing about consent. Either of two things
      // does: the business claimed its listing, or it holds a password because
      // it registered. Testing claimedAt alone also excluded a business that
      // signed up and verified its address through a path that never set it.
      //
      // An unclaimed directory row still gets exactly one message ever, the
      // claim invitation, sent by hand from scripts/claim-campaign.mjs.
      AND: [
        { OR: [{ claimedAt: { not: null } }, { passwordHash: { not: null } }] },
        { OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lt: gapBefore } }] },
      ],
    },
    select: {
      id: true,
      businessName: true,
      email: true,
      city: true,
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
    orderBy: { lastMarketingAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_PER_SWEEP,
  })) as VendorRow[];

  let sent = 0;
  for (const v of candidates) {
    try {
      // Check suppression before doing the counting work: sendMail would catch
      // it anyway, but not before we had built a message for nobody.
      if (await isOptedOut(v.email!)) continue;

      const choice = await pickMessage(v, now);
      if (!choice) continue;

      // Stamp first. A crash between here and the send loses one email; the
      // other order loses the cap and mails the same business every sweep.
      await prisma.vendor.update({
        where: { id: v.id },
        data: { lastMarketingAt: now, lastPromoKind: choice.kind },
      });

      notify(choice.mail);
      sent += 1;
    } catch (err) {
      logger.warn({ err, vendorId: v.id }, 'vendor engagement sweep: skipped one vendor');
    }
  }

  if (sent > 0) logger.info({ considered: candidates.length, sent }, 'vendor engagement sweep sent');
  return { considered: candidates.length, sent };
}

/**
  * Three or four times a day, at times picked fresh each morning inside
  * business hours. A fixed four-hour interval from process boot meant a deploy
  * at 03:00 mailed businesses at 03:00, and gave every send an identical
  * rhythm.
  *
  * This does not change how often one business hears from us: that is one
  * promotional email per vendor per MIN_GAP_DAYS, enforced on the row itself.
  * More frequent sweeps only mean a vendor who becomes eligible at 10am is not
  * waiting until the evening.
  *
  * Nothing runs on boot, so a crash loop cannot become a mail loop.
  */
export function startVendorEngagementJob(): void {
  startRandomDailyJob('vendor-engagement', runVendorEngagementSweep, {
    minRuns: 3,
    maxRuns: 4,
    // Business hours for the people receiving it, not for the server.
    startHour: 10,
    endHour: 19,
    minGapMinutes: 90,
  });
}
