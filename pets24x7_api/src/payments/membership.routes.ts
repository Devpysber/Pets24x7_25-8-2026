// Membership endpoints — public plan list + parent-only checkout + status read.
//
//   GET  /api/memberships/plans                      → public
//   POST /api/memberships/checkout  (parent auth)    → returns { redirectUrl }
//   GET  /api/memberships/me        (parent auth)    → current membership + history
//   GET  /api/memberships/payment/:txn   (parent auth) → poll status (return page uses this)

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { optionalAuth, requireAuth } from '../auth/middleware.js';
import { env } from '../env.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError, ConflictError } from '../shared/errors.js';
import { isDevGatewayBypass, newMerchantTxnId } from './checkout.js';
import { fetchOrderPayments, hasRazorpayKeys } from './razorpay.js';
import { startCheckout } from './checkout.js';
import { invoiceUrl, renderInvoice } from './invoice.js';
import { campaignGoalLabel } from './pricing.js';
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
import { adminPaymentAlertEmail, membershipUpgradedEmail, paymentPendingEmail } from '../mail/lifecycle-templates.js';
import { adminNotifyEmails } from '../mail/admin-notify.js';
import { invalidateVendorInsights } from '../feed/reco/vendor-insights.js';
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
    // History means memberships that actually existed. A checkout that was never
    // paid for leaves a row behind — PENDING while it is in flight, then
    // CANCELLED once the sweep writes it off — and neither ever had a start
    // date. Listing those showed the parent three "Silver · Monthly ·
    // Cancelled" entries for plans they never bought and were never charged
    // for. Keying off startsAt rather than status catches both shapes: a real
    // cancellation was active first, so it has one.
    const memberships = await prisma.membership.findMany({
      where: { parentId, status: { not: 'PENDING' }, startsAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      // activatingPayment carries the reference the invoice is addressed by, so
      // the dashboard can link to it without a second round trip per row.
      include: { plan: true, activatingPayment: { select: { merchantTxnId: true, status: true } } },
      take: 10,
    });
    // Attach the invoice URL to every row that was actually paid for. Built
    // here rather than in the page so the API stays the single source of the
    // route's shape.
    const withInvoice = memberships.map((m) => ({
      ...m,
      invoiceUrl:
        m.activatingPayment?.status === 'SUCCESS' ? invoiceUrl(m.activatingPayment.merchantTxnId) : null,
    }));
    const active = withInvoice.find((m) => m.status === 'ACTIVE' && (!m.endsAt || m.endsAt > new Date()));
    res.json({ ok: true, active, history: withInvoice });
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

    const [parent, plan, existingActive, existingPending] = await Promise.all([
      prisma.petParent.findUnique({ where: { id: parentId } }),
      prisma.membershipPlan.findUnique({ where: { id: planId } }),
      prisma.membership.findFirst({
        where: { parentId, status: 'ACTIVE', endsAt: { gt: new Date() } },
      }),
      prisma.payment.findFirst({
        where: { parentId, status: 'INITIATED', purpose: 'MEMBERSHIP' },
        orderBy: { createdAt: 'desc' },
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
    // A double-click / retry before the button disables must not spawn a second
    // orphaned PENDING payment+membership pair. It must not lock the parent out
    // either: closing the Razorpay modal leaves the payment INITIATED, and a
    // hard 409 here blocked every retry until the expiry sweep wrote it off
    // two hours later.
    if (existingPending) {
      const pendingMembership = existingPending.membershipId
        ? await prisma.membership.findUnique({ where: { id: existingPending.membershipId }, select: { planId: true } })
        : null;
      // Same plan, same price: hand back the order already open at the gateway.
      // Razorpay accepts another attempt on it, so nothing new is created.
      if (
        pendingMembership?.planId === plan.id &&
        existingPending.amountMinor === plan.priceMinor &&
        existingPending.currency === plan.currency
      ) {
        if (existingPending.providerOrderId && hasRazorpayKeys()) {
          return res.json({
            ok: true,
            merchantTxnId: existingPending.merchantTxnId,
            resumed: true,
            checkout: {
              mode: 'razorpay',
              keyId: env.RAZORPAY_KEY_ID!,
              orderId: existingPending.providerOrderId,
              amountMinor: existingPending.amountMinor,
              currency: existingPending.currency,
              dev: false,
            },
          });
        }
        if (existingPending.redirectUrl) {
          return res.json({
            ok: true,
            merchantTxnId: existingPending.merchantTxnId,
            resumed: true,
            redirectUrl: existingPending.redirectUrl,
            checkout: { mode: 'redirect', redirectUrl: existingPending.redirectUrl, dev: isDevGatewayBypass() },
          });
        }
      }
      // A different plan (or a checkout that never reached the gateway): ask
      // the gateway first. Money that did arrive is honoured; an attempt still
      // being processed (a UPI collect, say) blocks; anything else is closed
      // quietly so this checkout can go ahead.
      const verdict = await reconcilePayment(existingPending);
      if (verdict === 'settled') {
        throw new ConflictError('Your previous payment just went through. Refresh the page to see your membership.');
      }
      if (verdict === 'in_flight' || verdict === 'error') {
        throw new ConflictError('Your previous payment is still being processed. Please wait a minute and try again.');
      }
      if (verdict === 'abandoned') {
        // Conditional: a webhook that settled it a moment ago must win.
        const closed = await prisma.payment.updateMany({
          where: { id: existingPending.id, status: 'INITIATED' },
          data: { status: 'CANCELLED', errorMessage: 'superseded by a new checkout' },
        });
        if (closed.count === 0) {
          throw new ConflictError('Your previous payment just changed state. Refresh the page and try again.');
        }
        if (existingPending.membershipId) {
          await prisma.membership.updateMany({
            where: { id: existingPending.membershipId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
        }
        logger.info({ paymentId: existingPending.id, parentId }, 'membership checkout superseded');
      }
      // 'failed' has already cancelled the old pair; 'skipped' means it is no
      // longer INITIATED. Either way nothing is in flight any more.
    }

    const merchantTxnId = newMerchantTxnId();
    const payment = await prisma.payment.create({
      data: {
        parentId,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        gateway: 'RAZORPAY',
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
      logger.warn({ err }, 'membership checkout: gateway error');
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

    // If still pending in DB, ask whichever gateway actually holds the order.
    await reconcilePayment(payment);
    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { membership: { include: { plan: true } } },
    });
    res.json({ ok: true, payment: fresh });
  }),
);

// ---- Parent: printable invoice for a settled payment ----
// Returns HTML, not JSON: the link goes straight into the confirmation mail and
// has to open as a page. Only the payer (or an admin) may fetch it.
//
// Auth is resolved here rather than with requireAuth: the link is opened from
// an inbox, often in a browser with no session, and a bare JSON 401 is a dead
// end. Without a session the reader is sent to sign in instead; an admin
// session (the old comment promised this, the code never allowed it) may open
// any invoice.
membershipRouter.get(
  '/invoice/:txn',
  optionalAuth('pet_parent'),
  // A vendor's campaign / featured purchase is invoiced from the same route.
  (req, res, next) => (req.auth ? next() : optionalAuth('vendor')(req, res, next)),
  (req, res, next) => (req.auth ? next() : optionalAuth('admin')(req, res, next)),
  asyncHandler(async (req, res) => {
    const txn = req.params.txn ?? '';
    const payment = await prisma.payment.findUnique({
      where: { merchantTxnId: txn },
      include: {
        parent: true,
        membership: { include: { plan: true } },
        campaign: { include: { vendor: true } },
        featuredListing: { include: { vendor: true } },
      },
    });
    const vendor = payment?.campaign?.vendor ?? payment?.featuredListing?.vendor ?? null;
    if (!req.auth) {
      // Send the reader to the sign-in page for whoever the invoice belongs to.
      const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
      const login = vendor ? 'vendor-login' : 'parent-login';
      return res.redirect(`${site}/${login}/?next=${encodeURIComponent(invoiceUrl(txn))}`);
    }
    const isAdmin = req.auth.role === 'admin';
    const owns =
      !!payment &&
      ((req.auth.role === 'pet_parent' && payment.parentId === req.auth.sub) ||
        (req.auth.role === 'vendor' && !!vendor && vendor.id === req.auth.sub));
    if (!payment || (!isAdmin && !owns)) throw new NotFoundError('Invoice not found');
    if (payment.status !== 'SUCCESS') {
      throw new BadRequestError('An invoice is only available once the payment has settled');
    }

    const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    let description: string;
    let footnote: string | undefined;
    let issuedAt: Date;
    let billTo: { name: string; email: string | null; phone: string | null; city: string | null };
    if (payment.campaign) {
      description = `${campaignGoalLabel(String(payment.campaign.goal))} marketing campaign (${payment.campaign.durationDays} days)`;
      issuedAt = payment.updatedAt ?? payment.createdAt;
    } else if (payment.featuredListing) {
      const f = payment.featuredListing;
      description = `Featured listing placement (${f.durationDays} days)`;
      footnote = f.startsAt && f.endsAt ? `Placement runs ${fmt(f.startsAt)} to ${fmt(f.endsAt)}.` : undefined;
      issuedAt = payment.updatedAt ?? payment.createdAt;
    } else {
      const plan = payment.membership?.plan;
      const endsAt = payment.membership?.endsAt ?? null;
      description = plan ? `${plan.name} membership (${plan.durationDays} days)` : 'Pets24x7 membership';
      footnote = endsAt ? `Membership active until ${fmt(endsAt)}.` : undefined;
      // The activation moment, not updatedAt: any later write to the payment
      // row (an admin note, say) would otherwise re-date the invoice.
      issuedAt = payment.membership?.startsAt ?? payment.updatedAt ?? payment.createdAt;
    }
    if (vendor) {
      billTo = { name: vendor.businessName, email: vendor.email ?? null, phone: vendor.phone ?? null, city: vendor.city ?? null };
    } else {
      billTo = {
        name: payment.parent?.name ?? 'Pets24x7 member',
        email: payment.parent?.email ?? null,
        phone: payment.parent?.phone ?? null,
        city: payment.parent?.city ?? null,
      };
    }

    const html = renderInvoice({
      merchantTxnId: payment.merchantTxnId,
      issuedAt,
      gatewayTxnId: payment.gatewayTxnId,
      currency: payment.currency,
      billTo,
      lines: [{ description, amountMinor: payment.amountMinor }],
      totalMinor: payment.amountMinor,
      footnote,
    });
    // Personal data on a page opened from an inbox: never cache it on a shared proxy.
    res.set('Cache-Control', 'private, no-store');
    res.type('html').send(html);
  }),
);

// ---- Shared: re-ask the gateway about a payment we never saw settle ----
// The client-side verify call is the happy path; this is the backstop for a
// payer who closed the tab mid-checkout. It must ask the gateway that actually
// holds the order — polling PhonePe about a Razorpay order silently reports
// nothing, leaving the payment INITIATED and the membership never activated.
//
// Idempotent and best-effort: any gateway error leaves the DB row untouched.
//
// The verdict tells a caller (the expiry sweep) WHY a row is still unsettled,
// so it writes off only a checkout that was truly abandoned — never one whose
// gateway was unreachable or whose attempt is still being processed.
export type ReconcileVerdict =
  | 'settled' // money captured; the purchase is now applied
  | 'failed' // every attempt failed; recorded and the payer told
  | 'abandoned' // no attempt was ever made against the order
  | 'in_flight' // an attempt is still created / authorized — do not write off
  | 'error' // could not ask the gateway — try again later
  | 'skipped'; // not reconcilable here (already settled, or a retired gateway)

export async function reconcilePayment(payment: {
  id: string;
  status: string;
  gateway: string;
  merchantTxnId: string;
  providerOrderId: string | null;
  amountMinor?: number;
}): Promise<ReconcileVerdict> {
  if (payment.status !== 'INITIATED' && payment.status !== 'PENDING') return 'skipped';
  // A short-paid attempt must not activate the purchase.
  const expectedAmountMinor = payment.amountMinor ?? 0;

  try {
    // Razorpay is the only live gateway. Rows written by the retired PhonePe
    // integration can no longer be reconciled — leave them for an admin.
    if (payment.gateway !== 'RAZORPAY') {
      logger.warn({ paymentId: payment.id, gateway: payment.gateway }, 'reconcile skipped: retired gateway');
      return 'skipped';
    }
    {
      // No gateway order was ever created, so nothing can have been paid.
      if (!payment.providerOrderId) return 'abandoned';
      const attempts = await fetchOrderPayments(payment.providerOrderId);
      // 'captured' is the only state that means the money is actually ours.
      const captured = attempts.find((a) => a.status === 'captured' && a.amount >= expectedAmountMinor);
      if (captured) {
        await applyPaymentResult(payment.id, 'COMPLETED', {
          gatewayTxnId: captured.id,
          callbackPayload: { source: 'reconcile', attempts } as object,
        });
        return 'settled';
      }
      // Every attempt failed and none is still in flight — record the failure so
      // the payer is told, rather than leaving the row pending forever.
      const inFlight = attempts.some((a) => a.status === 'created' || a.status === 'authorized');
      if (inFlight) return 'in_flight';
      if (attempts.length > 0) {
        await applyPaymentResult(payment.id, 'FAILED', {
          callbackPayload: { source: 'reconcile', attempts } as object,
        });
        return 'failed';
      }
      return 'abandoned';
    }
  } catch (err) {
    // Best-effort: the caller still returns the current DB row.
    logger.warn({ err, paymentId: payment.id, gateway: payment.gateway }, 'payment reconcile failed');
    return 'error';
  }
}

// ---- Shared: close an unpaid checkout so a new one (or a cancel) can go ahead ----
// Asks the gateway first. 'paid' — the money arrived and the purchase is now
// applied; 'busy' — an attempt is still being processed (or the gateway could
// not be asked), so nothing may be written off yet; 'cleared' — the payment is
// closed and the caller may cancel whatever it was funding.
//
// The write-off is conditional on the row still being unsettled: a webhook
// that lands between the gateway check and the write must win, or a paid
// campaign / placement would be cancelled under the payer.
export async function closeUnpaidCheckout(
  payment: Parameters<typeof reconcilePayment>[0] | null,
  reason: string,
): Promise<'paid' | 'busy' | 'cleared'> {
  if (!payment) return 'cleared';
  const verdict = await reconcilePayment(payment);
  if (verdict === 'settled') return 'paid';
  if (verdict === 'in_flight' || verdict === 'error') return 'busy';
  await prisma.payment.updateMany({
    where: { id: payment.id, status: { in: ['INITIATED', 'PENDING'] } },
    data: { status: 'FAILED', errorMessage: reason },
  });
  const after = await prisma.payment.findUnique({ where: { id: payment.id }, select: { status: true } });
  return after?.status === 'SUCCESS' ? 'paid' : 'cleared';
}

// ---- Shared: tell the admins about a payment a human has to settle ----
// Money that arrived but could not be credited (short-paid, wrong currency, an
// order we cannot match) otherwise lives only in a log line nobody reads.
// Fire-and-forget, like every other action mail.
export function alertAdminsAboutPayment(detail: {
  merchantTxnId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  who: string;
}): void {
  void adminNotifyEmails()
    .then((emails) => {
      for (const to of emails) notifyIf(to, (addr) => adminPaymentAlertEmail(addr, 'Admin', detail));
    })
    .catch((err) => logger.warn({ err, merchantTxnId: detail.merchantTxnId }, 'payment alert: admin lookup failed'));
}

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

  // A refunded payment is closed for good. Razorpay retries webhooks and does
  // not order them, so a late payment.captured / order.paid for a payment an
  // admin has since refunded used to flip it back to SUCCESS — re-activating
  // the refunded membership and re-sending its receipt.
  if (payment.status === 'REFUNDED') {
    if (gatewayState === 'COMPLETED' || gatewayState === 'FAILED') {
      logger.info({ paymentId: payment.id, gatewayState }, 'payment already refunded — ignoring gateway update');
    }
    return;
  }

  if (gatewayState === 'COMPLETED' && payment.status !== 'SUCCESS') {
    const now = new Date();
    // This payment was written off earlier (a failed attempt, or the sweep
    // closing an abandoned checkout) and the money has now arrived anyway —
    // the payer retried inside the same Razorpay order. Whatever it funds was
    // cancelled along with it and must come back, or the vendor pays for a
    // campaign / placement that never runs.
    const wasWrittenOff = payment.status === 'FAILED' || payment.status === 'CANCELLED';
    const fundable = (s: string) => s === 'PENDING_PAYMENT' || (wasWrittenOff && s === 'CANCELLED');

    // The gateway's server-to-server callback and the return page's status poll
    // routinely land at the same moment. A read-then-write guard lets both pass
    // and apply the result twice — double-activating a membership and
    // double-counting a pro-rated credit. Claim the payment atomically instead:
    // whoever flips PENDING → SUCCESS owns the side effects, the loser returns.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { notIn: ['SUCCESS', 'REFUNDED'] } },
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

    // Set inside the transaction when this purchase replaced another active
    // plan, so the payer is told about the switch and any credit carried over.
    let switched: { fromPlan: string; creditMinor: number } | null = null;

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
          if (
            prior.endsAt &&
            prior.endsAt.getTime() > now.getTime() &&
            prior.plan &&
            prior.plan.priceMinor > 0 &&
            // A zero-priced target plan would divide by zero and hand out the
            // full one-year clamp as "credit".
            newPlan.priceMinor > 0
          ) {
            const remainingMs = prior.endsAt.getTime() - now.getTime();
            const priorTermMs = Math.max(1, prior.plan.durationDays * DAY);
            const remainingValueMinor = prior.plan.priceMinor * (remainingMs / priorTermMs);
            creditMs = (remainingValueMinor / newPlan.priceMinor) * newPlan.durationDays * DAY;
            // Safety clamp: never credit more than one extra year.
            creditMs = Math.max(0, Math.min(creditMs, 365 * DAY));
            switched = {
              fromPlan: prior.plan.name,
              creditMinor: Math.round((creditMs / Math.max(1, newPlan.durationDays * DAY)) * newPlan.priceMinor),
            };
          } else {
            switched = { fromPlan: prior.plan?.name ?? 'your previous plan', creditMinor: 0 };
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

      if (payment.campaign && fundable(payment.campaign.status)) {
        // Payment cleared — hand the campaign to the Pets24x7 admin team for
        // review. It only goes ACTIVE (and the clock only starts) once an
        // admin approves it via /api/admin/marketing/:id/status.
        await tx.marketingCampaign.update({
          where: { id: payment.campaign.id },
          data: { status: 'PENDING_REVIEW' },
        });
      }

      if (payment.featuredListing && fundable(payment.featuredListing.status)) {
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
          invoiceUrl(payment.merchantTxnId),
        ),
      );
      // A plan switch also gets the change spelled out: which plan it replaced
      // and how much unused time was carried over.
      const sw = switched as { fromPlan: string; creditMinor: number } | null;
      if (sw && sw.fromPlan !== plan.name) {
        notifyIf(parent?.email, (to) =>
          membershipUpgradedEmail(
            to,
            parent?.name ?? 'there',
            sw.fromPlan,
            plan.name,
            sw.creditMinor,
            payment.currency,
            fresh?.endsAt ?? null,
          ),
        );
      }
    }
    if (payment.campaign) {
      const campaign = payment.campaign;
      invalidateVendorInsights(campaign.vendorId);
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
          invoiceUrl(payment.merchantTxnId),
        ),
      );
    }
    if (payment.featuredListing) {
      const featured = payment.featuredListing;
      invalidateVendorInsights(featured.vendorId);
      const fresh = await prisma.featuredListing.findUnique({ where: { id: featured.id } });
      notifyIf(featured.vendor?.email, (to) =>
        featuredLiveEmail(
          to,
          featured.vendor.businessName,
          { priceMinor: payment.amountMinor, currency: payment.currency, durationDays: featured.durationDays },
          fresh?.endsAt ?? null,
          payment.merchantTxnId,
          fresh?.startsAt ?? null,
          invoiceUrl(payment.merchantTxnId),
        ),
      );
    }
    return;
  }

  // Only an unsettled payment can fail. Webhooks arrive out of order: a
  // payment.failed for an earlier attempt landing after the retry succeeded
  // used to overwrite SUCCESS with FAILED — hiding the invoice and mailing a
  // "payment failed" notice to someone who had paid. The conditional update
  // also stops two concurrent failure reports from both sending that mail.
  if (gatewayState === 'FAILED' && (payment.status === 'INITIATED' || payment.status === 'PENDING')) {
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { in: ['INITIATED', 'PENDING'] } },
      data: { status: 'FAILED', callbackPayload: extras.callbackPayload as any },
    });
    if (claimed.count === 0) return;
    await prisma.$transaction(async (tx) => {
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
    // Conditional, so two concurrent PENDING reports send the notice once.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: 'INITIATED' },
      data: { status: 'PENDING', callbackPayload: extras.callbackPayload as any },
    });
    if (claimed.count === 0) return;
    // Tell the payer the money is on its way, so they do not pay a second time.
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
    notifyIf(payerEmail, (to) => paymentPendingEmail(to, payerName, what, payment.merchantTxnId));
  }
}
