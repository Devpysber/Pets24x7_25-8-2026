// PhonePe S2S callback. Configure this URL in env.PHONEPE_CALLBACK_URL.
//   POST /api/payments/phonepe/callback
//     headers: X-VERIFY
//     body:    { response: base64(json) }
//
// We respond 200 ASAP, then verify + persist. Failure to ack within 30s makes
// PhonePe retry up to 3x — idempotent state updates handle the retries.

import { Router } from 'express';
import express from 'express';

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../shared/async-handler.js';
import { verifyCallback } from './phonepe.js';
import { applyPaymentResult } from './membership.routes.js';

export const phonepeRouter = Router();

// Capture the raw JSON body verbatim (we need it for signature verification).
phonepeRouter.post(
  '/callback',
  express.text({ type: '*/*', limit: '64kb' }),
  asyncHandler(async (req, res) => {
    // Ack first — PhonePe is impatient.
    res.sendStatus(200);

    const rawBody = typeof req.body === 'string' ? req.body : '';
    const xVerify = String(req.headers['x-verify'] ?? '');

    const { ok, payload } = verifyCallback(xVerify, rawBody);
    if (!ok || !payload?.merchantTransactionId) {
      logger.warn({ xVerify, bodyLen: rawBody.length }, 'phonepe.callback: signature/payload invalid');
      return;
    }

    const payment = await prisma.payment.findUnique({ where: { merchantTxnId: payload.merchantTransactionId } });
    if (!payment) {
      logger.warn({ payload }, 'phonepe.callback: no matching payment');
      return;
    }

    await applyPaymentResult(payment.id, payload.state, {
      gatewayTxnId: payload.transactionId,
      callbackPayload: payload as unknown as object,
    });
    logger.info({ txn: payload.merchantTransactionId, state: payload.state }, 'phonepe.callback applied');
  }),
);
