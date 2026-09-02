// Periodic lifecycle sweep — transitions time-bound rows to their terminal
// state once their window closes. Runs in-process on an interval (no external
// scheduler). Idempotent; safe to run as often as you like.
//
// Rows are selected before they are updated so the owner can be emailed about
// the transition — updateMany alone only returns a count.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { reconcilePayment } from '../payments/membership.routes.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignCompletedEmail,
  featuredEndedEmail,
  membershipExpiredEmail,
} from '../mail/action-templates.js';

/** A checkout nobody finished within this window is treated as abandoned. */
const STALE_CHECKOUT_MS = 2 * 3600 * 1000;

export async function runExpirySweep(): Promise<{
  memberships: number; campaigns: number; featured: number; deals: number; events: number; abandoned: number;
}> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_CHECKOUT_MS);

  const [dueMemberships, dueCampaigns, dueFeatured] = await Promise.all([
    prisma.membership.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { plan: true, parent: true },
    }),
    prisma.marketingCampaign.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { vendor: true },
    }),
    prisma.featuredListing.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      include: { vendor: true },
    }),
  ]);

  const [memberships, campaigns, featured, deals, events] = await Promise.all([
    prisma.membership.updateMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      data: { status: 'EXPIRED' },
    }),
    prisma.marketingCampaign.updateMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      data: { status: 'COMPLETED' },
    }),
    prisma.featuredListing.updateMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      data: { status: 'EXPIRED' },
    }),
    prisma.deal.updateMany({
      where: { status: 'ACTIVE', endsAt: { not: null, lt: now } },
      data: { status: 'EXPIRED' },
    }),
    prisma.event.updateMany({
      where: { status: 'PUBLISHED', startsAt: { lt: now } },
      data: { status: 'PAST' },
    }),
  ]);

  for (const m of dueMemberships) {
    notifyIf(m.parent?.email, (to) => membershipExpiredEmail(to, m.parent?.name ?? 'there', m.plan.name));
  }
  for (const c of dueCampaigns) {
    notifyIf(c.vendor?.email, (to) => campaignCompletedEmail(to, c.vendor.businessName, String(c.goal)));
  }
  for (const f of dueFeatured) {
    notifyIf(f.vendor?.email, (to) => featuredEndedEmail(to, f.vendor.businessName));
  }

  // Ask the gateway about every stale checkout BEFORE writing any of them off.
  // A payer who completed payment but closed the tab before the client-side
  // verify call landed leaves the row INITIATED. Failing that row unseen would
  // take their money and cancel the membership it paid for, with nothing in the
  // DB to show they ever paid — so reconcile first, and only write off what the
  // gateway also says never settled.
  const stale = await prisma.payment.findMany({
    where: { status: 'INITIATED', createdAt: { lt: staleBefore } },
    select: { id: true, status: true, gateway: true, merchantTxnId: true, providerOrderId: true },
  });
  let recovered = 0;
  for (const p of stale) {
    await reconcilePayment(p);
    const after = await prisma.payment.findUnique({ where: { id: p.id }, select: { status: true } });
    if (after?.status === 'SUCCESS') recovered++;
  }
  if (recovered > 0) logger.warn({ recovered, checked: stale.length }, 'recovered paid-but-unverified checkouts');

  // Whatever is still INITIATED after that really was abandoned. The PENDING
  // membership / PENDING_PAYMENT campaign and featured rows behind them would
  // otherwise sit forever, confusing every report.
  const [abandonedMemberships, abandonedCampaigns, abandonedFeatured] = await Promise.all([
    prisma.membership.updateMany({
      where: { status: 'PENDING', createdAt: { lt: staleBefore } },
      data: { status: 'CANCELLED' },
    }),
    prisma.marketingCampaign.updateMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: staleBefore } },
      data: { status: 'CANCELLED' },
    }),
    prisma.featuredListing.updateMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: staleBefore } },
      data: { status: 'CANCELLED' },
    }),
    prisma.payment.updateMany({
      where: { status: 'INITIATED', createdAt: { lt: staleBefore } },
      data: { status: 'FAILED', errorMessage: 'abandoned checkout' },
    }),
  ]);

  const result = {
    abandoned: abandonedMemberships.count + abandonedCampaigns.count + abandonedFeatured.count,
    memberships: memberships.count,
    campaigns: campaigns.count,
    featured: featured.count,
    deals: deals.count,
    events: events.count,
  };
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) logger.info(result, 'expiry sweep applied');
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startExpiryJob(intervalMs = 15 * 60 * 1000): void {
  if (timer) return;
  // Kick once shortly after boot, then on the interval.
  setTimeout(() => { runExpirySweep().catch((err) => logger.warn({ err }, 'expiry sweep failed')); }, 10_000);
  timer = setInterval(() => {
    runExpirySweep().catch((err) => logger.warn({ err }, 'expiry sweep failed'));
  }, intervalMs);
  timer.unref?.();
}
