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
import { createOrder, checkStatus, newMerchantTxnId } from './phonepe.js';
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
    const memberships = await prisma.membership.findMany({
      where: { parentId },
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
    if (existingActive) throw new ConflictError('You already have an active membership');

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
      const { redirectUrl } = await createOrder({
        merchantTxnId,
        amountMinor: plan.priceMinor,
        parentId: parent.id,
        mobileNumber: parent.phone.replace(/^\+/, '').replace(/^91/, ''),
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl } });
      res.json({ ok: true, merchantTxnId, redirectUrl });
    } catch (err: any) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', errorMessage: String(err?.message ?? 'gateway error') },
      });
      await prisma.membership.delete({ where: { id: membership.id } }).catch(() => {});
      throw new BadRequestError('Could not start payment — please try again');
    }
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

// ---- Shared: apply terminal state to Payment + Membership ----
export async function applyPaymentResult(
  paymentId: string,
  gatewayState: 'COMPLETED' | 'FAILED' | 'PENDING' | undefined,
  extras: { gatewayTxnId?: string | undefined; callbackPayload?: object | undefined } = {},
): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { membership: { include: { plan: true } } } });
  if (!payment) return;

  if (gatewayState === 'COMPLETED' && payment.status !== 'SUCCESS') {
    // Mark payment + activate membership transactionally.
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
          gatewayTxnId: extras.gatewayTxnId ?? payment.gatewayTxnId,
          callbackPayload: extras.callbackPayload as any,
        },
      });
      if (payment.membership && payment.membership.status !== 'ACTIVE') {
        const endsAt = new Date(now.getTime() + payment.membership.plan.durationDays * 24 * 3600 * 1000);
        await tx.membership.update({
          where: { id: payment.membership.id },
          data: {
            status: 'ACTIVE',
            startsAt: now,
            endsAt,
            activatingPaymentId: payment.id,
          },
        });
      }
    });
    return;
  }
  if (gatewayState === 'FAILED' && payment.status !== 'FAILED') {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', callbackPayload: extras.callbackPayload as any },
      });
      if (payment.membership && payment.membership.status === 'PENDING') {
        await tx.membership.delete({ where: { id: payment.membership.id } }).catch(() => {});
      }
    });
    return;
  }
  // PENDING — bump our status if still INITIATED, leave membership alone
  if (gatewayState === 'PENDING' && payment.status === 'INITIATED') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'PENDING', callbackPayload: extras.callbackPayload as any } });
  }
}
