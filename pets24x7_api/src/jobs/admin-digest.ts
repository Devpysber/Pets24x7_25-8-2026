// One daily briefing to the admins, instead of a mail per event.
//
// Per-event admin mail does not survive contact with a busy marketplace: fifty
// notices a day get filtered, and then the one that mattered is filtered too.
// This is a single message, sent once a day, that answers "what happened
// yesterday and what is waiting for me".
//
// It only sends when something actually happened, and it always leads with the
// queue — the things that stay broken until a human acts.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { env } from '../env.js';
import { notify } from '../mail/notify.js';
import { adminNotifyEmails } from '../mail/admin-notify.js';
import { adminDailyDigestEmail } from '../mail/lifecycle-templates.js';

const DAY = 24 * 3600 * 1000;

export interface AdminDigest {
  since: Date;
  /** Waiting on a human. */
  pendingVendors: number;
  pendingReviews: number;
  newEnquiries: number;
  unansweredEnquiries: number;
  pendingCampaigns: number;
  /** What moved. */
  newParents: number;
  newVendors: number;
  newListings: number;
  paymentsCount: number;
  paymentsRupees: number;
  phoneTaps: number;
  whatsappTaps: number;
  listingViews: number;
  reviewsSubmitted: number;
}

export async function collectAdminDigest(now = new Date()): Promise<AdminDigest> {
  const since = new Date(now.getTime() - DAY);
  const window = { gte: since };

  const [
    pendingVendors, pendingReviews, newEnquiries, unansweredEnquiries, pendingCampaigns,
    newParents, newVendors, newListings, payments, activity, reviewsSubmitted,
  ] = await Promise.all([
    prisma.vendor.count({ where: { status: 'PENDING' } }),
    prisma.review.count({ where: { status: 'PENDING' } }),
    prisma.enquiry.count({ where: { createdAt: window } }),
    prisma.enquiry.count({ where: { status: 'NEW' } }),
    prisma.marketingCampaign.count({ where: { status: 'PENDING_REVIEW' } }),
    prisma.petParent.count({ where: { createdAt: window } }),
    prisma.vendor.count({ where: { createdAt: window } }),
    prisma.listing.count({ where: { importedAt: window } }),
    prisma.payment.aggregate({
      where: { status: 'SUCCESS', createdAt: window },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    prisma.listingActivity.groupBy({ by: ['kind'], where: { createdAt: window }, _count: { _all: true } }).catch(() => []),
    prisma.review.count({ where: { createdAt: window } }),
  ]);

  const byKind = new Map(
    (activity as Array<{ kind: string; _count: { _all: number } }>).map((a) => [a.kind, a._count._all]),
  );

  return {
    since,
    pendingVendors,
    pendingReviews,
    newEnquiries,
    unansweredEnquiries,
    pendingCampaigns,
    newParents,
    newVendors,
    newListings,
    paymentsCount: payments._count._all,
    paymentsRupees: Math.round((payments._sum.amountMinor ?? 0) / 100),
    phoneTaps: byKind.get('phone_click') ?? 0,
    whatsappTaps: byKind.get('whatsapp_click') ?? 0,
    listingViews: byKind.get('listing_view') ?? 0,
    reviewsSubmitted,
  };
}

/** True when there is anything at all worth an email. */
function worthSending(d: AdminDigest): boolean {
  return (
    d.pendingVendors + d.pendingReviews + d.pendingCampaigns + d.unansweredEnquiries > 0 ||
    d.newEnquiries + d.newParents + d.newVendors + d.paymentsCount + d.reviewsSubmitted > 0 ||
    d.phoneTaps + d.whatsappTaps > 0
  );
}

export async function runAdminDigest(): Promise<{ sent: number }> {
  const digest = await collectAdminDigest();
  if (!worthSending(digest)) {
    logger.info('admin digest: quiet day, nothing sent');
    return { sent: 0 };
  }

  const admins = await adminNotifyEmails();
  if (admins.length === 0) {
    logger.warn('admin digest: no admin addresses on record');
    return { sent: 0 };
  }

  for (const to of admins) notify(adminDailyDigestEmail(to, digest, env.PUBLIC_SITE_URL));
  logger.info({ admins: admins.length }, 'admin digest sent');
  return { sent: admins.length };
}

let timer: NodeJS.Timeout | null = null;

export function startAdminDigestJob(intervalMs = DAY): void {
  if (timer) return;
  // Late enough after boot that a restart loop cannot turn into a mail loop.
  setTimeout(() => {
    runAdminDigest().catch((err) => logger.warn({ err }, 'admin digest failed'));
  }, 10 * 60_000);
  timer = setInterval(() => {
    runAdminDigest().catch((err) => logger.warn({ err }, 'admin digest failed'));
  }, intervalMs);
}
