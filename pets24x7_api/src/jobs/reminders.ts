// Reminder sweep — mail about things that are ABOUT to happen, as opposed to
// src/jobs/expiry.ts, which mails about transitions that already happened.
//
// Covers:
//   • memberships lapsing in 7 / 3 / 1 days
//   • featured placements and marketing campaigns ending in 3 / 1 days
//   • enquiries a vendor has left unanswered for more than two days
//
// Dedupe: there is no per-row "reminded at" column, so a process-local set
// remembers what has already gone out, keyed by row id and bucket. A restart
// can therefore repeat at most one reminder per row per bucket, which is a far
// smaller problem than a schema migration on every deploy. Nothing here is a
// direct consequence of a user action, so each mail is best-effort.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignEndingEmail,
  featuredExpiringEmail,
  membershipExpiringEmail,
  vendorEnquiryUnansweredEmail,
} from '../mail/lifecycle-templates.js';

const DAY = 24 * 3600 * 1000;

/** Days before expiry at which each kind of reminder goes out. */
const MEMBERSHIP_BUCKETS = [7, 3, 1];
const PLACEMENT_BUCKETS = [3, 1];
/** An enquiry with no reply after this long earns the vendor a nudge. */
const UNANSWERED_AFTER_DAYS = 2;

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

/** Whole days from now until `at`, rounded up: 0.5 days left counts as 1. */
function daysUntil(at: Date, now: Date): number {
  return Math.ceil((at.getTime() - now.getTime()) / DAY);
}

/** The bucket a row falls in right now, or null if it is not due a reminder. */
function bucketFor(at: Date, now: Date, buckets: number[]): number | null {
  const left = daysUntil(at, now);
  return buckets.includes(left) ? left : null;
}

export async function runReminderSweep(): Promise<{
  memberships: number;
  featured: number;
  campaigns: number;
  enquiries: number;
}> {
  const now = new Date();
  const horizon = new Date(now.getTime() + (Math.max(...MEMBERSHIP_BUCKETS) + 1) * DAY);
  const out = { memberships: 0, featured: 0, campaigns: 0, enquiries: 0 };

  // ---- Memberships about to lapse ----
  // Only ones that will not renew themselves: an auto-renewing membership gets
  // the renewal notice instead, and telling both is how people cancel by mistake.
  const memberships = await prisma.membership.findMany({
    where: { status: 'ACTIVE', endsAt: { gt: now, lt: horizon }, autoRenew: false },
    include: { plan: true, parent: true },
  });
  for (const m of memberships) {
    if (!m.endsAt) continue;
    const bucket = bucketFor(m.endsAt, now, MEMBERSHIP_BUCKETS);
    if (bucket === null || !claim(`membership:${m.id}:${bucket}`)) continue;
    notifyIf(m.parent?.email, (to) =>
      membershipExpiringEmail(to, m.parent?.name ?? 'there', m.plan.name, m.endsAt!, bucket),
    );
    out.memberships++;
  }

  // ---- Featured placements ending ----
  const featured = await prisma.featuredListing.findMany({
    where: { status: 'ACTIVE', endsAt: { gt: now, lt: new Date(now.getTime() + 4 * DAY) } },
    include: { vendor: true },
  });
  for (const f of featured) {
    if (!f.endsAt) continue;
    const bucket = bucketFor(f.endsAt, now, PLACEMENT_BUCKETS);
    if (bucket === null || !claim(`featured:${f.id}:${bucket}`)) continue;
    notifyIf(f.vendor?.email, (to) => featuredExpiringEmail(to, f.vendor.businessName, f.endsAt!, bucket));
    out.featured++;
  }

  // ---- Campaigns ending ----
  const campaigns = await prisma.marketingCampaign.findMany({
    where: { status: 'ACTIVE', endsAt: { gt: now, lt: new Date(now.getTime() + 4 * DAY) } },
    include: { vendor: true },
  });
  for (const c of campaigns) {
    if (!c.endsAt) continue;
    const bucket = bucketFor(c.endsAt, now, PLACEMENT_BUCKETS);
    if (bucket === null || !claim(`campaign:${c.id}:${bucket}`)) continue;
    notifyIf(c.vendor?.email, (to) =>
      campaignEndingEmail(to, c.vendor.businessName, String(c.goal), c.endsAt!, bucket),
    );
    out.campaigns++;
  }

  // ---- Enquiries nobody has answered ----
  // Grouped per vendor so a busy listing gets one nudge, not one per enquiry.
  const staleBefore = new Date(now.getTime() - UNANSWERED_AFTER_DAYS * DAY);
  const stale = await prisma.enquiry.findMany({
    where: { status: 'NEW', createdAt: { lt: staleBefore }, listingId: { not: null } },
    select: { id: true, listingId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  if (stale.length > 0) {
    const byListing = new Map<string, { count: number; oldest: Date }>();
    for (const e of stale) {
      const key = e.listingId!;
      const seen = byListing.get(key);
      if (seen) seen.count++;
      else byListing.set(key, { count: 1, oldest: e.createdAt });
    }
    const vendors = await prisma.vendor.findMany({
      where: { status: 'ACTIVE', listingId: { in: [...byListing.keys()] }, email: { not: null } },
      select: { id: true, email: true, businessName: true, listingId: true },
    });
    for (const v of vendors) {
      const agg = v.listingId ? byListing.get(v.listingId) : undefined;
      if (!agg) continue;
      // One nudge per vendor per day, however many enquiries are waiting.
      const dayKey = Math.floor(now.getTime() / DAY);
      if (!claim(`enquiries:${v.id}:${dayKey}`)) continue;
      notifyIf(v.email, (to) => vendorEnquiryUnansweredEmail(to, v.businessName, agg.count, agg.oldest));
      out.enquiries++;
    }
  }

  const total = out.memberships + out.featured + out.campaigns + out.enquiries;
  if (total > 0) logger.info(out, 'reminder sweep sent');
  return out;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Hourly is often enough: every bucket is a whole day wide, and a reminder that
 * lands an hour late reads exactly the same to the recipient.
 */
export function startReminderJob(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  setTimeout(() => {
    runReminderSweep().catch((err) => logger.warn({ err }, 'reminder sweep failed'));
  }, 60_000);
  timer = setInterval(() => {
    runReminderSweep().catch((err) => logger.warn({ err }, 'reminder sweep failed'));
  }, intervalMs);
  timer.unref?.();
}
