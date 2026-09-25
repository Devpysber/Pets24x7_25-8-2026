// Periodic lifecycle sweep — transitions time-bound rows to their terminal
// state once their window closes. Runs in-process on an interval (no external
// scheduler). Idempotent; safe to run as often as you like.
//
// Rows that earn their owner an email are selected in bounded batches and then
// flipped one at a time with a conditional update (`where: { id, status }`).
// Only the sweep whose update actually changed the row sends the mail, so two
// overlapping sweeps — a slow one and the next tick, or two API instances —
// cannot both announce the same expiry. A backlog larger than a batch simply
// drains over the next few ticks.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { withJobLock } from '../shared/job-lock.js';
import { reconcilePayment } from '../payments/membership.routes.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignCompletedEmail,
  featuredEndedEmail,
  membershipExpiredEmail,
} from '../mail/action-templates.js';

/** A checkout nobody finished within this window is treated as abandoned. */
const STALE_CHECKOUT_MS = 2 * 3600 * 1000;
/** Most rows of each kind expired (and mailed) per sweep. */
const EXPIRE_BATCH = 500;
/** Most stale checkouts asked about at the gateway per sweep. */
const RECONCILE_BATCH = 100;

export async function runExpirySweep(): Promise<{
  memberships: number; campaigns: number; featured: number; deals: number; events: number; abandoned: number;
}> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_CHECKOUT_MS);

  const [dueMemberships, dueCampaigns, dueFeatured] = await Promise.all([
    prisma.membership.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { plan: true, parent: { select: { email: true, name: true } } },
      orderBy: { endsAt: 'asc' },
      take: EXPIRE_BATCH,
    }),
    prisma.marketingCampaign.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { vendor: { select: { email: true, businessName: true } } },
      orderBy: { endsAt: 'asc' },
      take: EXPIRE_BATCH,
    }),
    prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { vendor: { select: { email: true, businessName: true } } },
      orderBy: { endsAt: 'asc' },
      take: EXPIRE_BATCH,
    }),
  ]);

  let memberships = 0;
  for (const m of dueMemberships) {
    const { count } = await prisma.membership.updateMany({
      where: { id: m.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    if (count !== 1) continue; // someone else already moved it
    memberships++;
    // A parent who already switched to, or renewed onto, another live plan has
    // not lost anything — telling them "your membership expired" would read as
    // a billing error.
    const stillActive = await prisma.membership.count({
      where: { parentId: m.parentId, status: 'ACTIVE', endsAt: { gt: now } },
    });
    if (stillActive > 0) continue;
    notifyIf(m.parent?.email, (to) => membershipExpiredEmail(to, m.parent?.name ?? 'there', m.plan.name));
  }

  let campaigns = 0;
  for (const c of dueCampaigns) {
    const { count } = await prisma.marketingCampaign.updateMany({
      where: { id: c.id, status: 'ACTIVE' },
      data: { status: 'COMPLETED' },
    });
    if (count !== 1) continue;
    campaigns++;
    notifyIf(c.vendor?.email, (to) => campaignCompletedEmail(to, c.vendor.businessName, String(c.goal)));
  }

  let featured = 0;
  for (const f of dueFeatured) {
    const { count } = await prisma.featuredListing.updateMany({
      where: { id: f.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    if (count !== 1) continue;
    featured++;
    notifyIf(f.vendor?.email, (to) => featuredEndedEmail(to, f.vendor.businessName));
  }

  // No mail for these, so a set-based update is enough.
  const [deals, events] = await Promise.all([
    prisma.deal.updateMany({
      where: { status: 'ACTIVE', endsAt: { not: null, lt: now } },
      data: { status: 'EXPIRED' },
    }),
    // A multi-day event is still on until its end; only a single-moment event
    // (no endsAt) is over once it has started.
    prisma.event.updateMany({
      where: {
        status: 'PUBLISHED',
        OR: [
          { endsAt: { not: null, lt: now } },
          { endsAt: null, startsAt: { lt: now } },
        ],
      },
      data: { status: 'PAST' },
    }),
  ]);

  // Ask the gateway about every stale checkout BEFORE writing any of them off.
  // A payer who completed payment but closed the tab before the client-side
  // verify call landed leaves the row INITIATED. Failing that row unseen would
  // take their money and cancel the membership it paid for, with nothing in the
  // DB to show they ever paid — so reconcile first, and only write off the rows
  // this sweep actually asked about. Oldest first, bounded, so a backlog drains
  // over a few ticks instead of hammering the gateway in one.
  const stale = await prisma.payment.findMany({
    where: { status: 'INITIATED', createdAt: { lt: staleBefore } },
    select: { id: true, status: true, gateway: true, merchantTxnId: true, providerOrderId: true, amountMinor: true },
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH,
  });
  let recovered = 0;
  const writeOff: string[] = [];
  for (const p of stale) {
    try {
      await reconcilePayment(p);
    } catch (err) {
      // Could not ask: leave it INITIATED for the next sweep rather than fail it blind.
      logger.warn({ err, paymentId: p.id }, 'expiry sweep: reconcile threw; will retry');
      continue;
    }
    const after = await prisma.payment.findUnique({ where: { id: p.id }, select: { status: true } });
    if (after?.status === 'SUCCESS') recovered++;
    else if (after?.status === 'INITIATED') writeOff.push(p.id);
  }
  if (recovered > 0) logger.warn({ recovered, checked: stale.length }, 'recovered paid-but-unverified checkouts');

  if (writeOff.length > 0) {
    await prisma.payment.updateMany({
      where: { id: { in: writeOff }, status: 'INITIATED' },
      data: { status: 'FAILED', errorMessage: 'abandoned checkout' },
    });
  }

  // The PENDING membership / PENDING_PAYMENT campaign and featured rows behind
  // abandoned checkouts would otherwise sit forever, confusing every report.
  // Only rows whose checkout is no longer INITIATED are cancelled: one still
  // waiting for reconciliation (beyond this sweep's batch) keeps its row.
  const [abandonedMemberships, abandonedCampaigns, abandonedFeatured] = await Promise.all([
    prisma.membership.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: staleBefore },
        payments: { none: { status: 'INITIATED' } },
      },
      data: { status: 'CANCELLED' },
    }),
    prisma.marketingCampaign.updateMany({
      where: {
        status: 'PENDING_PAYMENT',
        createdAt: { lt: staleBefore },
        NOT: { payment: { is: { status: 'INITIATED' } } },
      },
      data: { status: 'CANCELLED' },
    }),
    prisma.featuredListing.updateMany({
      where: {
        status: 'PENDING_PAYMENT',
        createdAt: { lt: staleBefore },
        NOT: { payment: { is: { status: 'INITIATED' } } },
      },
      data: { status: 'CANCELLED' },
    }),
  ]);

  const result = {
    abandoned: abandonedMemberships.count + abandonedCampaigns.count + abandonedFeatured.count,
    memberships,
    campaigns,
    featured,
    deals: deals.count,
    events: events.count,
  };
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info(result, 'expiry sweep applied');
  return result;
}

let timer: NodeJS.Timeout | null = null;
/** True while a sweep is running, so a slow one is never overlapped by the next tick. */
let running = false;

/** Cluster lease hold: one sweep per interval across all instances, whichever wakes first. */
let holdMs = 0;

function tick(): void {
  if (running) return;
  running = true;
  withJobLock('expiry-sweep', () => runExpirySweep(), { minHoldMs: holdMs })
    .catch((err) => logger.warn({ err }, 'expiry sweep failed'))
    .finally(() => { running = false; });
}

export function startExpiryJob(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;
  // A minute short of the interval, so this instance's own next tick is never
  // blocked by the lease its previous tick left behind.
  holdMs = Math.max(0, intervalMs - 60_000);
  // Kick once shortly after boot, then on the interval. Safe on restart: every
  // mail is gated on the row's own status transition, not on process memory.
  setTimeout(tick, 10_000).unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}
