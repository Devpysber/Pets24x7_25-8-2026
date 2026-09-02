// Vendor marketing campaigns — buy a promotion package via PhonePe.
//   GET  /api/vendor/campaigns                 list this vendor's campaigns + catalogue
//   POST /api/vendor/campaigns                 { goal, durationDays } → { redirectUrl }
//   GET  /api/vendor/campaigns/:id             one campaign
//   GET  /api/vendor/campaigns/payment/:txn    poll payment status (return page)
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../shared/errors.js';
import { newMerchantTxnId } from '../payments/phonepe.js';
import { startCheckout } from '../payments/checkout.js';
import { applyPaymentResult, reconcilePayment } from '../payments/membership.routes.js';
import { CAMPAIGN_OPTIONS, CAMPAIGN_GOALS, campaignOptionFor } from '../payments/pricing.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { campaignCreatedEmail } from '../mail/action-templates.js';

export const vendorCampaignsRouter = Router();
vendorCampaignsRouter.use(requireAuth('vendor'));

vendorCampaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const campaigns = await prisma.marketingCampaign.findMany({
      where: { vendorId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
      include: { payment: { select: { status: true, merchantTxnId: true } } },
    });
    res.json({
      ok: true,
      campaigns,
      catalogue: { options: CAMPAIGN_OPTIONS, goals: CAMPAIGN_GOALS },
    });
  }),
);

const CreateBody = z.object({
  goal: z.enum(['WHATSAPP_ENQUIRIES', 'WEBSITE_LEADS', 'PROFILE_VISITS']),
  durationDays: z.number().int(),
  notes: z.string().max(500).optional(),
});

vendorCampaignsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = CreateBody.parse(req.body);
    const vendorId = req.auth!.sub;

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new ForbiddenError();
    if (vendor.status !== 'ACTIVE') {
      throw new ForbiddenError('Your vendor account must be approved before buying a campaign');
    }

    const option = campaignOptionFor(body.durationDays);
    if (!option) throw new BadRequestError('Unknown campaign package');

    // One campaign at a time per vendor. Without this a vendor could stack
    // several running campaigns (the dashboard only ever renders one), and the
    // marketing team would silently be on the hook for all of them.
    const inFlight = await prisma.marketingCampaign.findFirst({
      where: {
        vendorId,
        OR: [
          { status: { in: ['PENDING_PAYMENT', 'PENDING_REVIEW'] } },
          { status: 'ACTIVE', endsAt: { gt: new Date() } },
        ],
      },
    });
    if (inFlight) {
      throw new ConflictError(
        inFlight.status === 'PENDING_PAYMENT'
          ? 'You already have a campaign awaiting payment — finish or cancel it first'
          : 'You already have a campaign running. It must finish before you start another.',
      );
    }

    const merchantTxnId = newMerchantTxnId();

    const campaign = await prisma.marketingCampaign.create({
      data: {
        vendorId,
        goal: body.goal,
        durationDays: option.durationDays,
        priceMinor: option.priceMinor,
        currency: 'INR',
        status: 'PENDING_PAYMENT',
        notes: body.notes ?? null,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        purpose: 'CAMPAIGN',
        campaignId: campaign.id,
        amountMinor: option.priceMinor,
        currency: 'INR',
        gateway: 'PHONEPE',
        merchantTxnId,
        status: 'INITIATED',
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] || '').slice(0, 250),
      },
    });

    notifyIf(vendor.email, (to) =>
      campaignCreatedEmail(
        to,
        vendor.businessName,
        { goal: String(campaign.goal), durationDays: option.durationDays, priceMinor: option.priceMinor, currency: 'INR' },
        merchantTxnId,
      ),
    );

    try {
      const checkout = await startCheckout({
        merchantTxnId,
        amountMinor: option.priceMinor,
        userId: vendorId,
        purpose: 'CAMPAIGN',
        mobileNumber: vendor.phone.replace(/^\+/, '').replace(/^91/, ''),
      });
      if (checkout.mode === 'razorpay') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { gateway: 'RAZORPAY', providerOrderId: checkout.orderId },
        });
        res.json({ ok: true, campaignId: campaign.id, merchantTxnId, checkout });
      } else {
        await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl: checkout.redirectUrl } });
        res.json({ ok: true, campaignId: campaign.id, merchantTxnId, redirectUrl: checkout.redirectUrl, checkout });
      }
    } catch (err: any) {
      logger.warn({ err }, 'campaign checkout: gateway error');
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', errorMessage: String(err?.message ?? 'gateway error') },
      });
      await prisma.marketingCampaign.update({ where: { id: campaign.id }, data: { status: 'CANCELLED' } });
      throw new BadRequestError('Could not start payment — please try again');
    }
  }),
);

vendorCampaignsRouter.get(
  '/payment/:txn',
  asyncHandler(async (req, res) => {
    const txn = req.params.txn ?? '';
    const payment = await prisma.payment.findUnique({
      where: { merchantTxnId: txn },
      include: { campaign: true },
    });
    if (!payment || !payment.campaign || payment.campaign.vendorId !== req.auth!.sub) {
      throw new NotFoundError('Payment not found');
    }
    await reconcilePayment(payment);
    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { campaign: true },
    });
    res.json({ ok: true, payment: fresh });
  }),
);

vendorCampaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.marketingCampaign.findUnique({
      where: { id: req.params.id ?? '' },
      include: { payment: { select: { status: true, merchantTxnId: true, amountMinor: true } } },
    });
    if (!campaign || campaign.vendorId !== req.auth!.sub) throw new NotFoundError('Campaign not found');
    res.json({ ok: true, campaign });
  }),
);
