// Razorpay verification endpoints.
//   POST /api/payments/razorpay/verify   (parent or vendor auth)
//        body { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//        → checks the checkout signature, then applies the payment result.
//   POST /api/payments/razorpay/webhook  (no auth; HMAC-verified)
//        Razorpay server-to-server. Uses req.rawBody + X-Razorpay-Signature.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAnyAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../shared/errors.js';
import { logger } from '../logger.js';
import { verifyPaymentSignature, verifyWebhookSignature, fetchPaymentStatus } from './razorpay.js';
import { alertAdminsAboutPayment, applyPaymentResult } from './membership.routes.js';
import { settleVendorSubscriptionOrder } from '../vendors/vendor.subscriptions.routes.js';
import { notifyIf } from '../mail/notify.js';
import { paymentRefundedEmail } from '../mail/action-templates.js';

export const razorpayRouter = Router();

const VerifyBody = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
});

async function ownsPayment(payment: any, authSub: string): Promise<boolean> {
  if (payment.parentId && payment.parentId === authSub) return true;
  if (payment.campaign && payment.campaign.vendorId === authSub) return true;
  if (payment.featuredListing && payment.featuredListing.vendorId === authSub) return true;
  return false;
}

razorpayRouter.post(
  '/verify',
  requireAnyAuth(['pet_parent', 'vendor']),
  asyncHandler(async (req, res) => {
    const body = VerifyBody.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { providerOrderId: body.razorpay_order_id },
      include: { campaign: true, featuredListing: true },
    });
    if (!payment) throw new NotFoundError('Payment not found');
    if (!(await ownsPayment(payment, req.auth!.sub))) throw new ForbiddenError();

    if (!verifyPaymentSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      // Signature mismatch — as a fallback, ask Razorpay directly.
      const live = await fetchPaymentStatus(body.razorpay_payment_id).catch(() => null);
      if (!live || live.order_id !== body.razorpay_order_id || live.status !== 'captured') {
        throw new BadRequestError('Payment could not be verified');
      }
      // Never credit an order for less than it cost, or in another currency.
      // Razorpay enforces this on its side too, but the fallback path trusts a
      // value we did not sign.
      const shortPaid = typeof live.amount === 'number' && live.amount < payment.amountMinor;
      const wrongCurrency = !!live.currency && live.currency !== payment.currency;
      if (shortPaid || wrongCurrency) {
        logger.warn(
          { paymentId: payment.id, paid: live.amount, currency: live.currency, expected: payment.amountMinor },
          'razorpay.verify: amount/currency mismatch',
        );
        alertAdminsAboutPayment({
          merchantTxnId: payment.merchantTxnId,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          reason: `Razorpay payment ${body.razorpay_payment_id} reports ${live.amount ?? '?'} ${live.currency ?? ''} against this order - not credited`,
          who: req.auth!.sub,
        });
        throw new BadRequestError('Payment amount does not match the order');
      }
    }

    await applyPaymentResult(payment.id, 'COMPLETED', { gatewayTxnId: body.razorpay_payment_id });

    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { membership: { include: { plan: true } }, campaign: true, featuredListing: true },
    });
    res.json({ ok: true, payment: fresh });
  }),
);

razorpayRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['x-razorpay-signature'];
    const raw = (req as any).rawBody as Buffer | undefined;
    if (typeof sig !== 'string' || !raw || !verifyWebhookSignature(raw.toString('utf8'), sig)) {
      logger.warn('razorpay.webhook: bad signature');
      return res.status(400).json({ ok: false, error: 'bad_signature' });
    }

    const event = req.body?.event as string | undefined;
    const entity = req.body?.payload?.payment?.entity;
    const refund = req.body?.payload?.refund?.entity;

    // A refund raised straight from the Razorpay dashboard never passes through
    // our admin route, so the webhook is the only place we learn about it. It
    // has to do what the admin refund route does: flipping only the payment row
    // left the membership / campaign / placement running on refunded money and
    // never told the payer.
    //
    // Only refund.processed moves money: refund.created is a request that can
    // still fail at the gateway, and acting on it ended purchases whose refund
    // never went through. The payment entity in the same payload carries the
    // running total (amount_refunded), so several partial refunds that add up
    // to the full price are recognised as a full refund.
    if (refund?.payment_id && event === 'refund.processed') {
      await applyGatewayRefund(refund, typeof entity?.amount_refunded === 'number' ? entity.amount_refunded : undefined);
      return res.json({ ok: true });
    }
    if (refund?.payment_id && (event === 'refund.created' || event === 'refund.failed')) {
      logger.info({ event, refundId: refund.id, paymentId: refund.payment_id }, 'razorpay.webhook: refund not yet settled');
      return res.json({ ok: true });
    }
    logger.info({ event, orderId: entity?.order_id, status: entity?.status }, 'razorpay.webhook');

    if (entity?.order_id && (event === 'payment.captured' || event === 'order.paid')) {
      const payment = await prisma.payment.findUnique({ where: { providerOrderId: entity.order_id } });
      if (payment) {
        // A signed webhook still carries a gateway-supplied amount. Credit the
        // purchase only when it covers what we charged, in the same currency.
        const amountOk = typeof entity.amount !== 'number' || entity.amount >= payment.amountMinor;
        const currencyOk = !entity.currency || entity.currency === payment.currency;
        if (!amountOk || !currencyOk) {
          logger.warn(
            { paymentId: payment.id, paid: entity.amount, currency: entity.currency, expected: payment.amountMinor },
            'razorpay.webhook: amount/currency mismatch — not crediting',
          );
          // Money did arrive — someone has to refund or credit it by hand.
          alertAdminsAboutPayment({
            merchantTxnId: payment.merchantTxnId,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            reason: `Captured ${entity.amount} ${entity.currency ?? ''} (payment ${entity.id}) does not cover the order - not credited`,
            who: payment.parentId ?? 'vendor',
          });
          return res.json({ ok: true, ignored: 'amount_mismatch' });
        }
        await applyPaymentResult(payment.id, 'COMPLETED', {
          gatewayTxnId: entity.id,
          callbackPayload: req.body,
        });
      } else {
        // Vendor subscription checkouts have no Payment row; they are keyed on
        // the order's notes. Anything else captured against an order we cannot
        // match is money nobody will credit unless an admin is told.
        const handled = await settleVendorSubscriptionOrder(entity.order_id, entity.id, entity.amount, entity.currency);
        if (!handled && event === 'payment.captured') {
          logger.warn({ orderId: entity.order_id, paymentId: entity.id }, 'razorpay.webhook: captured payment for unknown order');
          alertAdminsAboutPayment({
            merchantTxnId: entity.order_id,
            amountMinor: typeof entity.amount === 'number' ? entity.amount : 0,
            currency: entity.currency || 'INR',
            reason: `Razorpay captured payment ${entity.id} for order ${entity.order_id}, which matches no Pets24x7 checkout - not credited`,
            who: entity.email || entity.contact || 'unknown',
          });
        }
      }
    } else if (entity?.order_id && event === 'payment.failed') {
      // One failed ATTEMPT, not a failed order: the Razorpay modal stays open
      // and the payer usually retries with another card or UPI app on the same
      // order. Writing the payment off here mailed "your payment failed" and
      // cancelled the campaign / placement seconds before the retry succeeded.
      // Record why it failed and leave the order open; reconcilePayment (the
      // return-page poll and the expiry sweep) fails it — and sends the mail —
      // once no attempt is still in flight.
      const reason = String(entity.error_description || entity.error_code || 'payment attempt failed').slice(0, 500);
      await prisma.payment.updateMany({
        where: { providerOrderId: entity.order_id, status: { in: ['INITIATED', 'PENDING'] } },
        data: { errorMessage: reason },
      });
    }

    res.json({ ok: true });
  }),
);

/**
 * Mirror a refund made at the gateway. A full refund closes the payment and
 * ends whatever it paid for, exactly as the admin refund route does; a partial
 * one is recorded but leaves the purchase running.
 */
async function applyGatewayRefund(
  refund: { id?: string; payment_id: string; amount?: number },
  totalRefundedMinor?: number,
): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { gatewayTxnId: refund.payment_id },
    include: {
      parent: true,
      membership: { include: { plan: true, parent: true } },
      campaign: { include: { vendor: true } },
      featuredListing: { include: { vendor: true } },
    },
  });
  if (!payment || payment.status === 'REFUNDED') return;

  const thisRefund = typeof refund.amount === 'number' ? refund.amount : payment.amountMinor;
  const refundedMinor = Math.max(thisRefund, totalRefundedMinor ?? 0);
  if (refundedMinor < payment.amountMinor) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { errorMessage: `partial refund of ${refundedMinor} at gateway (refund ${refund.id})` },
    });
    logger.info({ paymentId: payment.id, refundId: refund.id, refundedMinor }, 'razorpay.webhook: partial refund recorded');
    return;
  }

  // Claim the transition so a refund.created + refund.processed pair (or the
  // admin route racing this webhook) ends the purchase and mails the payer once.
  const claimed = await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: 'REFUNDED' } },
    data: { status: 'REFUNDED', errorMessage: `refunded at gateway (refund ${refund.id})` },
  });
  if (claimed.count === 0) return;

  const refundedAt = new Date();
  await prisma.$transaction(async (tx) => {
    if (payment.membershipId && payment.membership?.status === 'ACTIVE') {
      await tx.membership.update({
        where: { id: payment.membershipId },
        data: { status: 'REFUNDED', cancelledAt: refundedAt, endsAt: refundedAt, autoRenew: false },
      });
    }
    if (payment.campaign && payment.campaign.status !== 'COMPLETED' && payment.campaign.status !== 'CANCELLED') {
      await tx.marketingCampaign.update({ where: { id: payment.campaign.id }, data: { status: 'CANCELLED' } });
    }
    if (payment.featuredListing && payment.featuredListing.status === 'ACTIVE') {
      await tx.featuredListing.update({
        where: { id: payment.featuredListing.id },
        data: { status: 'CANCELLED', endsAt: refundedAt },
      });
    }
  });
  logger.info({ paymentId: payment.id, refundId: refund.id }, 'razorpay.webhook: payment refunded');

  // Only a payment that had actually settled bought anything worth a notice.
  if (payment.status !== 'SUCCESS') return;
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
    paymentRefundedEmail(to, payerName, what, refundedMinor, payment.currency, payment.merchantTxnId),
  );
}
