// Membership endpoints — public plan list + parent-only checkout + status read.
//
//   GET  /api/memberships/plans                      → public
//   POST /api/memberships/checkout  (parent auth)    → returns { redirectUrl }
//   GET  /api/memberships/me        (parent auth)    → current membership + history
//   GET  /api/memberships/payment/:txn   (parent auth) → poll status (return page uses this)

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError, ConflictError } from '../shared/errors.js';
import { checkStatus, newMerchantTxnId } from './phonepe.js';
import { startCheckout } from './checkout.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import {
  campaignSubmittedEmail,
  featuredLiveEmail,
  membershipActivatedEmail,
  membershipCancelledEmail,
  membershipResumedEmail,
  paymentFailedEmail,
} from '../mail/action-templates.js';
import type { MembershipStatus } from '@prisma/client';

export const membershipRouter = Router();

// ---- Public: list plans ----
membershipRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.membershipPlan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
    });
    res.json({ ok: true, plans });
  }),
);

// ---- Parent: current membership ----
membershipRouter.get(
  '/me',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const parentId = req.auth!.sub;
    // PENDING rows are abandoned or in-flight checkouts, not history — showing
    // them made the dashboard list plans the parent never actually bought.
    const memberships = await prisma.membership.findMany({
      where: { parentId, status: { not: 'PENDING' } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
      take: 10,
    });
    const active = memberships.find((m) => m.status === 'ACTIVE' && (!m.endsAt || m.endsAt > new Date()));
    res.json({ ok: true, active, history: memberships });
  }),
);

// ---- Parent: start checkout ----
const CheckoutBody = z.object({ planId: z.string().min(3) });

membershipRouter.post(
  '/checkout',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const { planId } = CheckoutBody.parse(req.body);
    const parentId = req.auth!.sub;

    const [parent, plan, existingActive] = await Promise.all([
      prisma.petParent.findUnique({ where: { id: parentId } }),
      prisma.membershipPlan.findUnique({ where: { id: planId } }),
      prisma.membership.findFirst({
        where: { parentId, status: 'ACTIVE', endsAt: { gt: new Date() } },
      }),
    ]);
    if (!parent) throw new BadRequestError('Parent account missing');
    if (!plan || !plan.active) throw new BadRequestError('Plan not available');
    // A parent may switch plans while active (paying again supersedes the old
    // membership on success — see applyPaymentResult). Only block re-buying the
    // exact same plan.
    if (existingActive && existingActive.planId === plan.id) {
      throw new ConflictError('You are already on this plan');
    }

    const merchantTxnId = newMerchantTxnId();
    const payment = await prisma.payment.create({
      data: {
        parentId,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        gateway: 'PHONEPE',
        merchantTxnId,
        status: 'INITIATED',
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] || '').slice(0, 250),
      },
    });

    // Create a PENDING membership row so admin sees the attempt;
    // it'll only transition to ACTIVE after callback succeeds.
    const membership = await prisma.membership.create({
      data: {
        parentId,
        planId: plan.id,
        status: 'PENDING',
        pricePaidMinor: plan.priceMinor,
        currency: plan.currency,
      },
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { membershipId: membership.id } });

    try {
      const checkout = await startCheckout({
        merchantTxnId,
        amountMinor: plan.priceMinor,
        userId: parent.id,
        purpose: 'MEMBERSHIP',
        currency: plan.currency,
        mobileNumber: parent.phone?.replace(/^\+/, '').replace(/^91/, ''),
      });
      if (checkout.mode === 'razorpay') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { gateway: 'RAZORPAY', providerOrderId: checkout.orderId },
        });
        res.json({ ok: true, merchantTxnId, checkout });
      } else {
        await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl: checkout.redirectUrl } });
        res.json({ ok: true, merchantTxnId, redirectUrl: checkout.redirectUrl, checkout });
      }
    } catch (err: any) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', errorMessage: String(err?.message ?? 'gateway error') },
      });
      // Cancel rather than delete — deleting nulls payment.membershipId and the
      // failed attempt loses its trail.
      await prisma.membership
        .update({ where: { id: membership.id }, data: { status: 'CANCELLED' } })
        .catch(() => {});
      throw new BadRequestError('Could not start payment — please try again');
    }
  }),
);

// ---- Parent: cancel current membership (stays active until endsAt) ----
membershipRouter.post(
  '/cancel',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const parentId = req.auth!.sub;
    const active = await prisma.membership.findFirst({
      where: { parentId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, parent: true },
    });
    if (!active) throw new NotFoundError('No active membership to cancel');
    if (active.cancelledAt) {
      // Already cancelled — report the state, don't send a second email.
      return res.json({
        ok: true,
        alreadyCancelled: true,
        membership: { id: active.id, status: active.status, endsAt: active.endsAt, cancelledAt: active.cancelledAt, autoRenew: active.autoRenew },
      });
    }
    const updated = await prisma.membership.update({
      where: { id: active.id },
      data: { autoRenew: false, cancelledAt: new Date() },
    });
    notifyIf(active.parent?.email, (to) =>
      membershipCancelledEmail(to, active.parent?.name ?? 'there', active.plan.name, updated.endsAt),
    );
    res.json({
      ok: true,
      membership: { id: updated.id, status: updated.status, endsAt: updated.endsAt, cancelledAt: updated.cancelledAt, autoRenew: updated.autoRenew },
    });
  }),
);

// ---- Parent: resume a cancelled (but not yet expired) membership ----
membershipRouter.post(
  '/resume',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const parentId = req.auth!.sub;
    const membership = await prisma.membership.findFirst({
      where: { parentId, status: 'ACTIVE', endsAt: { gt: new Date() }, cancelledAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, parent: true },
    });
    if (!membership) throw new NotFoundError('No cancelled membership to resume');
    const updated = await prisma.membership.update({
      where: { id: membership.id },
      data: { autoRenew: true, cancelledAt: null },
    });
    notifyIf(membership.parent?.email, (to) =>
      membershipResumedEmail(to, membership.parent?.name ?? 'there', membership.plan.name, updated.endsAt),
    );
    res.json({
      ok: true,
      membership: { id: updated.id, status: updated.status, endsAt: updated.endsAt, cancelledAt: updated.cancelledAt, autoRenew: updated.autoRenew },
    });
  }),
);

// ---- Parent: poll payment status (used by return page) ----
membershipRouter.get(
  '/payment/:txn',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const txn = req.params.txn ?? '';
    const payment = await prisma.payment.findUnique({
      where: { merchantTxnId: txn },
      include: { membership: { include: { plan: true } } },
    });
    if (!payment || payment.parentId !== req.auth!.sub) throw new NotFoundError('Payment not found');

    // If still pending in DB, ask PhonePe.
    if (payment.status === 'INITIATED' || payment.status === 'PENDING') {
      try {
        const live = await checkStatus(txn);
        await applyPaymentResult(payment.id, live.data?.state, {
          gatewayTxnId: live.data?.transactionId,
          callbackPayload: live as unknown as object,
        });
      } catch (err: any) {
        // swallow — we'll still return the current DB row
      }
    }
    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { membership: { include: { plan: true } } },
    });
    res.json({ ok: true, payment: fresh });
  }),
);

// ---- Shared: apply terminal state to Payment + whatever it funds ----
// Handles all three purposes: MEMBERSHIP, CAMPAIGN, FEATURED. Idempotent —
// safe to call from both the S2S callback and the return-page status poll.
export async function applyPaymentResult(
  paymentId: string,
  gatewayState: 'COMPLETED' | 'FAILED' | 'PENDING' | undefined,
  extras: { gatewayTxnId?: string | undefined; callbackPayload?: object | undefined } = {},
): Promise<void> {
  let payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      parent: true,
      membership: { include: { plan: true, parent: true } },
      campaign: { include: { vendor: true } },
      featuredListing: { include: { vendor: true } },
    },
  });
  if (!payment) return;

  // Self-heal a broken link: a membership payment whose membershipId is null
  // (older rows, or a crash between the two writes in /checkout) would silently
  // activate nothing and send no receipt. Re-attach the parent's pending row.
  if (!payment.membership && payment.purpose === 'MEMBERSHIP' && payment.parentId) {
    const orphan = await prisma.membership.findFirst({
      where: { parentId: payment.parentId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (orphan) {
      await prisma.payment.update({ where: { id: payment.id }, data: { membershipId: orphan.id } });
      payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          parent: true,
          membership: { include: { plan: true, parent: true } },
          campaign: { include: { vendor: true } },
          featuredListing: { include: { vendor: true } },
        },
      });
      if (!payment) return;
      logger.info({ paymentId, membershipId: orphan.id }, 'payment relinked to pending membership');
    }
  }
  const DAY = 24 * 3600 * 1000;

  if (gatewayState === 'COMPLETED' && payment.status !== 'SUCCESS') {
    const now = new Date();

    // The gateway's server-to-server callback and the return page's status poll
    // routinely land at the same moment. A read-then-write guard lets both pass
    // and apply the result twice — double-activating a membership and
    // double-counting a pro-rated credit. Claim the payment atomically instead:
    // whoever flips PENDING → SUCCESS owns the side effects, the loser returns.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { not: 'SUCCESS' } },
      data: {
        status: 'SUCCESS',
        gatewayTxnId: extras.gatewayTxnId ?? payment.gatewayTxnId,
        callbackPayload: extras.callbackPayload as any,
      },
    });
    if (claimed.count === 0) {
      logger.info({ paymentId: payment.id }, 'payment already applied — skipping duplicate');
      return;
    }

    await prisma.$transaction(async (tx) => {

      if (payment.membership && payment.membership.status !== 'ACTIVE') {
        const newPlan = payment.membership.plan;

        // Plan switch (upgrade / downgrade): supersede any other currently-active
        // membership for this parent so the "one ACTIVE row per parent" invariant
        // holds. The unused value on the old plan is converted to equivalent time
        // on the NEW plan and added on top of a fresh full term (pro-rated credit,
        // no cash refund).
        const prior = await tx.membership.findFirst({
          where: { parentId: payment.membership.parentId, status: 'ACTIVE', id: { not: payment.membership.id } },
          include: { plan: true },
        });

        let creditMs = 0;
        if (prior) {
          if (prior.endsAt && prior.endsAt.getTime() > now.getTime() && prior.plan && prior.plan.priceMinor > 0) {
            const remainingMs = prior.endsAt.getTime() - now.getTime();
            const priorTermMs = Math.max(1, prior.plan.durationDays * DAY);
            const remainingValueMinor = prior.plan.priceMinor * (remainingMs / priorTermMs);
            creditMs = (remainingValueMinor / newPlan.priceMinor) * newPlan.durationDays * DAY;
            // Safety clamp: never credit more than one extra year.
            creditMs = Math.max(0, Math.min(creditMs, 365 * DAY));
          }
          await tx.membership.update({
            where: { id: prior.id },
            data: { status: 'EXPIRED', endsAt: now, cancelledAt: now },
          });
        }

        await tx.membership.update({
          where: { id: payment.membership.id },
          data: {
            status: 'ACTIVE',
            startsAt: now,
            endsAt: new Date(now.getTime() + newPlan.durationDays * DAY + creditMs),
            activatingPaymentId: payment.id,
          },
        });
      }

      if (payment.campaign && payment.campaign.status === 'PENDING_PAYMENT') {
        // Payment cleared — hand the campaign to the Pets24x7 admin team for
        // review. It only goes ACTIVE (and the clock only starts) once an
        // admin approves it via /api/admin/marketing/:id/status.
        await tx.marketingCampaign.update({
          where: { id: payment.campaign.id },
          data: { status: 'PENDING_REVIEW' },
        });
      }

      if (payment.featuredListing && payment.featuredListing.status === 'PENDING_PAYMENT') {
        // Queue behind any placement still running for this vendor: the paid
        // days must be days of actual placement, not days overlapping a slot
        // the vendor already owns.
        const running = await tx.featuredListing.findFirst({
          where: {
            vendorId: payment.featuredListing.vendorId,
            status: 'ACTIVE',
            endsAt: { gt: now },
            id: { not: payment.featuredListing.id },
          },
          orderBy: { endsAt: 'desc' },
        });
        const startsAt = running?.endsAt && running.endsAt > now ? running.endsAt : now;
        await tx.featuredListing.update({
          where: { id: payment.featuredListing.id },
          data: {
            status: 'ACTIVE',
            startsAt,
            endsAt: new Date(startsAt.getTime() + payment.featuredListing.durationDays * DAY),
          },
        });
      }
    });

    // Receipts / confirmations. Best-effort, sent after the state is committed.
    if (payment.membership) {
      const fresh = await prisma.membership.findUnique({ where: { id: payment.membership.id } });
      const parent = payment.membership.parent ?? payment.parent;
      const plan = payment.membership.plan;
      notifyIf(parent?.email, (to) =>
        membershipActivatedEmail(
          to,
          parent?.name ?? 'there',
          {
            name: plan.name,
            priceMinor: payment.amountMinor,
            currency: payment.currency,
            discountPercent: plan.discountPercent,
          },
          fresh?.endsAt ?? null,
          payment.merchantTxnId,
        ),
      );
    }
    if (payment.campaign) {
      const campaign = payment.campaign;
      notifyIf(campaign.vendor?.email, (to) =>
        campaignSubmittedEmail(
          to,
          campaign.vendor.businessName,
          {
            goal: String(campaign.goal),
            durationDays: campaign.durationDays,
            priceMinor: payment.amountMinor,
            currency: payment.currency,
          },
          payment.merchantTxnId,
        ),
      );
    }
    if (payment.featuredListing) {
      const featured = payment.featuredListing;
      const fresh = await prisma.featuredListing.findUnique({ where: { id: featured.id } });
      notifyIf(featured.vendor?.email, (to) =>
        featuredLiveEmail(
          to,
          featured.vendor.businessName,
          { priceMinor: payment.amountMinor, currency: payment.currency, durationDays: featured.durationDays },
          fresh?.endsAt ?? null,
          payment.merchantTxnId,
          fresh?.startsAt ?? null,
        ),
      );
    }
    return;
  }

  if (gatewayState === 'FAILED' && payment.status !== 'FAILED') {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', callbackPayload: extras.callbackPayload as any },
      });
      if (payment.membership && payment.membership.status === 'PENDING') {
        // Cancel, never delete: deleting the row nulls payment.membershipId and
        // the failed attempt loses its audit trail.
        await tx.membership.update({ where: { id: payment.membership.id }, data: { status: 'CANCELLED' } });
      }
      if (payment.campaign && payment.campaign.status === 'PENDING_PAYMENT') {
        await tx.marketingCampaign.update({ where: { id: payment.campaign.id }, data: { status: 'CANCELLED' } });
      }
      if (payment.featuredListing && payment.featuredListing.status === 'PENDING_PAYMENT') {
        await tx.featuredListing.update({ where: { id: payment.featuredListing.id }, data: { status: 'CANCELLED' } });
      }
    });

    // Tell the payer nothing was activated, so they don't pay twice.
    const what = payment.membership
      ? `your ${payment.membership.plan.name} membership`
      : payment.campaign
        ? 'your marketing campaign'
        : payment.featuredListing
          ? 'your featured placement'
          : 'your Pets24x7 purchase';
    const payerEmail =
      payment.membership?.parent?.email ??
      payment.parent?.email ??
      payment.campaign?.vendor?.email ??
      payment.featuredListing?.vendor?.email ??
      null;
    const payerName =
      payment.membership?.parent?.name ??
      payment.parent?.name ??
      payment.campaign?.vendor?.businessName ??
      payment.featuredListing?.vendor?.businessName ??
      'there';
    notifyIf(payerEmail, (to) =>
      paymentFailedEmail(to, payerName, what, payment.amountMinor, payment.currency, payment.merchantTxnId),
    );
    return;
  }

  if (gatewayState === 'PENDING' && payment.status === 'INITIATED') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', callbackPayload: extras.callbackPayload as any } });
  }
}
