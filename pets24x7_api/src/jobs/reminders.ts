// Reminder sweep — mail about things that are ABOUT to happen, as opposed to
// src/jobs/expiry.ts, which mails about transitions that already happened.
//
// Covers:
//   • memberships lapsing in 7 / 3 / 1 days
//   • featured placements and marketing campaigns ending in 3 / 1 days
//   • enquiries a vendor has left unanswered for more than two days
//
// Dedupe without a "reminded at" column: every sweep owns exactly one clock
// hour, the one that has just finished, and only mails rows whose reminder
// moment (endsAt minus the bucket) fell inside that hour. Each row crosses
// each bucket in exactly one hour, so only the sweep for that hour mails it.
// A restart does not re-send: the new process picks up at the next hour
// boundary instead of re-walking a whole day-wide bucket, which is what the
// old process-local set allowed on every deploy. The query is also bounded by
// construction — it only loads the rows crossing a threshold this hour.
//
// The unanswered-enquiry nudge is evaluated daily, in one fixed hour per
// audience (mid-morning local time), for the same reason. It only goes out on
// a day with something new to say — an enquiry crossed the two-day line since
// yesterday — or once a week while the backlog sits there. It used to repeat
// the identical "3 enquiries are still waiting" every single morning.
//
// The in-process set below is a second guard, for a sweep that somehow runs
// twice for the same hour inside one process. Nothing here is a direct
// consequence of a user action, so each mail is best-effort.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { withJobLock } from '../shared/job-lock.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignEndingEmail,
  featuredExpiringEmail,
  membershipExpiringEmail,
  vendorEnquiryUnansweredEmail,
} from '../mail/lifecycle-templates.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Days before expiry at which each kind of reminder goes out. */
const MEMBERSHIP_BUCKETS = [7, 3, 1];
const PLACEMENT_BUCKETS = [3, 1];
/** An enquiry with no reply after this long earns the vendor a nudge. */
const UNANSWERED_AFTER_DAYS = 2;
/** With nothing newly overdue, the same backlog is re-nudged this often. */
const UNANSWERED_REPEAT_DAYS = 7;

type Audience = 'IN' | 'US';
/**
 * The UTC hour boundary whose sweep sends the daily unanswered-enquiry nudge,
 * per audience: 05:00 UTC is ~10:30 IST, 15:00 UTC is ~10-11am US Eastern.
 */
const ENQUIRY_NUDGE_UTC_HOUR: Record<Audience, number> = { IN: 5, US: 15 };
/** Minutes after the hour a sweep runs, so rows written on the boundary are in. */
const RUN_OFFSET_MS = 2 * 60 * 1000;
/** Vendor lookups are chunked so a large `in` list stays a sane query. */
const VENDOR_CHUNK = 500;

/**
 * Already-sent markers, `${kind}:${id}:${bucket}`. Bounded by trimming the
 * oldest entries once it grows past a few thousand, so a long-running process
 * cannot leak memory.
 */
const sent = new Set<string>();
const SENT_MAX = 5000;

function claim(key: string): boolean {
  if (sent.has(key)) return false;
  if (sent.size >= SENT_MAX) {
    // Drop the oldest half. Insertion order is preserved by Set.
    let n = Math.floor(SENT_MAX / 2);
    for (const k of sent) {
      sent.delete(k);
      if (--n <= 0) break;
    }
  }
  sent.add(key);
  return true;
}

interface HourWindow { start: number; end: number }

/** The clock hour that has just finished, [start, end), in epoch ms. */
function finishedHour(now: Date): HourWindow {
  const end = Math.floor(now.getTime() / HOUR) * HOUR;
  return { start: end - HOUR, end };
}

/** Prisma filter: `endsAt` minus one of the buckets falls inside the window. */
function crossingFilter(win: HourWindow, buckets: number[]) {
  return buckets.map((b) => ({
    endsAt: { gte: new Date(win.start + b * DAY), lt: new Date(win.end + b * DAY) },
  }));
}

/** Which bucket this row crossed in the window, or null. */
function crossedBucket(endsAt: Date, win: HourWindow, buckets: number[]): number | null {
  for (const b of buckets) {
    const t = endsAt.getTime() - b * DAY;
    if (t >= win.start && t < win.end) return b;
  }
  return null;
}

export async function runReminderSweep(now = new Date()): Promise<{
  memberships: number;
  featured: number;
  campaigns: number;
  enquiries: number;
}> {
  const win = finishedHour(now);
  const out = { memberships: 0, featured: 0, campaigns: 0, enquiries: 0 };

  // ---- Memberships about to lapse ----
  // Every active membership, including autoRenew=true ones: there is no
  // recurring charge or renewal notice yet, so an "auto-renewing" membership
  // still lapses at endsAt and its owner must be warned like anyone else.
  // Once real recurring billing exists, route autoRenew rows to
  // membershipRenewingEmail instead of this reminder.
  const memberships = await prisma.membership.findMany({
    where: { status: 'ACTIVE', OR: crossingFilter(win, MEMBERSHIP_BUCKETS) },
    include: { plan: true, parent: { select: { email: true, name: true } } },
  });
  for (const m of memberships) {
    if (!m.endsAt) continue;
    const bucket = crossedBucket(m.endsAt, win, MEMBERSHIP_BUCKETS);
    if (bucket === null || !claim(`membership:${m.id}:${bucket}`)) continue;
    notifyIf(m.parent?.email, (to) =>
      membershipExpiringEmail(to, m.parent?.name ?? 'there', m.plan.name, m.endsAt!, bucket),
    );
    out.memberships++;
  }

  // ---- Featured placements ending ----
  const featured = await prisma.featuredListing.findMany({
    where: { status: 'ACTIVE', OR: crossingFilter(win, PLACEMENT_BUCKETS) },
    include: { vendor: { select: { email: true, businessName: true } } },
  });
  for (const f of featured) {
    if (!f.endsAt) continue;
    const bucket = crossedBucket(f.endsAt, win, PLACEMENT_BUCKETS);
    if (bucket === null || !claim(`featured:${f.id}:${bucket}`)) continue;
    notifyIf(f.vendor?.email, (to) => featuredExpiringEmail(to, f.vendor.businessName, f.endsAt!, bucket));
    out.featured++;
  }

  // ---- Campaigns ending ----
  const campaigns = await prisma.marketingCampaign.findMany({
    where: { status: 'ACTIVE', OR: crossingFilter(win, PLACEMENT_BUCKETS) },
    include: { vendor: { select: { email: true, businessName: true } } },
  });
  for (const c of campaigns) {
    if (!c.endsAt) continue;
    const bucket = crossedBucket(c.endsAt, win, PLACEMENT_BUCKETS);
    if (bucket === null || !claim(`campaign:${c.id}:${bucket}`)) continue;
    notifyIf(c.vendor?.email, (to) =>
      campaignEndingEmail(to, c.vendor.businessName, String(c.goal), c.endsAt!, bucket),
    );
    out.campaigns++;
  }

  // ---- Enquiries nobody has answered ----
  // Once a day per audience, in that audience's morning.
  const endHourUtc = new Date(win.end).getUTCHours();
  const due = (Object.keys(ENQUIRY_NUDGE_UTC_HOUR) as Audience[]).filter(
    (a) => ENQUIRY_NUDGE_UTC_HOUR[a] === endHourUtc,
  );
  if (due.length > 0) out.enquiries = await nudgeUnansweredEnquiries(now, due, win);

  const total = out.memberships + out.featured + out.campaigns + out.enquiries;
  if (total > 0) logger.info(out, 'reminder sweep sent');
  return out;
}

/**
 * Aggregated in the database per listing, so a busy listing gets one nudge
 * rather than one per enquiry, and no listing is starved by a fixed "oldest
 * 500 enquiries" window the way the in-memory grouping was.
 */
async function nudgeUnansweredEnquiries(now: Date, audiences: Audience[], win: HourWindow): Promise<number> {
  const staleBefore = new Date(now.getTime() - UNANSWERED_AFTER_DAYS * DAY);
  const grouped = await prisma.enquiry.groupBy({
    by: ['listingId'],
    where: { status: 'NEW', createdAt: { lt: staleBefore }, listingId: { not: null } },
    _count: { _all: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
  });
  if (grouped.length === 0) return 0;

  // Worth a mail today: an enquiry went overdue in the last day, or the oldest
  // has now been overdue for a whole number of weeks.
  const newlyStaleAfter = staleBefore.getTime() - DAY;
  const byListing = new Map<string, { count: number; oldest: Date }>();
  for (const g of grouped) {
    if (!g.listingId || !g._min?.createdAt) continue;
    const fresh = (g._max?.createdAt?.getTime() ?? 0) >= newlyStaleAfter;
    const overdueDays = Math.floor((staleBefore.getTime() - g._min.createdAt.getTime()) / DAY);
    const weekly = overdueDays > 0 && overdueDays % UNANSWERED_REPEAT_DAYS === 0;
    if (!fresh && !weekly) continue;
    byListing.set(g.listingId, { count: g._count?._all ?? 0, oldest: g._min.createdAt });
  }
  if (byListing.size === 0) return 0;

  // A vendor with no country on file is treated as India, the app's default.
  const audienceFilter =
    audiences.length > 1
      ? {}
      : audiences[0] === 'US'
        ? { country: 'US' }
        : { OR: [{ country: null }, { country: { not: 'US' } }] };

  const listingIds = [...byListing.keys()];
  const dayKey = Math.floor(win.end / DAY);
  let count = 0;
  for (let i = 0; i < listingIds.length; i += VENDOR_CHUNK) {
    const vendors = await prisma.vendor.findMany({
      where: {
        // CLAIMED is the status the claim flow leaves a live business in.
        status: { in: ['ACTIVE', 'CLAIMED'] },
        listingId: { in: listingIds.slice(i, i + VENDOR_CHUNK) },
        email: { not: null },
        ...audienceFilter,
      },
      select: { id: true, email: true, businessName: true, listingId: true },
    });
    for (const v of vendors) {
      const agg = v.listingId ? byListing.get(v.listingId) : undefined;
      if (!agg || agg.count === 0) continue;
      // One nudge per vendor per day, however many enquiries are waiting.
      if (!claim(`enquiries:${v.id}:${dayKey}`)) continue;
      notifyIf(v.email, (to) => vendorEnquiryUnansweredEmail(to, v.businessName, agg.count, agg.oldest));
      count++;
    }
  }
  return count;
}

let timer: NodeJS.Timeout | null = null;

/** Milliseconds until the next hour boundary plus the run offset. */
function msToNextRun(nowMs: number): number {
  let next = Math.floor(nowMs / HOUR) * HOUR + RUN_OFFSET_MS;
  if (next <= nowMs) next += HOUR;
  return next - nowMs;
}

/**
 * Hourly, aligned to the wall clock (a couple of minutes past each hour) so
 * that each sweep owns one distinct clock hour. Nothing runs on boot: the first
 * sweep is at the next boundary, which is what keeps a restart from re-sending.
 * Every bucket is a whole day wide, so a reminder landing within the hour reads
 * exactly the same to the recipient.
 */
export function startReminderJob(): void {
  if (timer) return;
  const schedule = () => {
    timer = setTimeout(() => {
      // Every instance wakes at the same wall-clock minute; the lease (held
      // half an hour) lets exactly one of them sweep this hour.
      withJobLock('reminder-sweep', () => runReminderSweep(), { minHoldMs: 30 * 60_000 })
        .catch((err) => logger.warn({ err }, 'reminder sweep failed'))
        .finally(schedule);
    }, msToNextRun(Date.now()));
    timer.unref?.();
  };
  schedule();
}
