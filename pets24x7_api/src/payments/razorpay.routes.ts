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
import { applyPaymentResult } from './membership.routes.js';

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
      if (!live || live.order_id !== body.razorpay_order_id || (live.status !== 'captured' && live.status !== 'authorized')) {
        throw new BadRequestError('Payment could not be verified');
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
    logger.info({ event, orderId: entity?.order_id, status: entity?.status }, 'razorpay.webhook');

    if (entity?.order_id && (event === 'payment.captured' || event === 'order.paid')) {
      const payment = await prisma.payment.findUnique({ where: { providerOrderId: entity.order_id } });
      if (payment) {
        await applyPaymentResult(payment.id, 'COMPLETED', {
          gatewayTxnId: entity.id,
          callbackPayload: req.body,
        });
      }
    } else if (entity?.order_id && event === 'payment.failed') {
      const payment = await prisma.payment.findUnique({ where: { providerOrderId: entity.order_id } });
      if (payment) await applyPaymentResult(payment.id, 'FAILED', { callbackPayload: req.body });
    }

    res.json({ ok: true });
  }),
);
