// Vendor marketing campaigns — buy a promotion package via PhonePe.
//   GET  /api/vendor/campaigns                 list this vendor's campaigns + catalogue
//   POST /api/vendor/campaigns                 { goal, durationDays } → { redirectUrl }
//   GET  /api/vendor/campaigns/:id             one campaign
//   POST /api/vendor/campaigns/:id/cancel      drop an unpaid (PENDING_PAYMENT) campaign
//   GET  /api/vendor/campaigns/payment/:txn    poll payment status (return page)
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../shared/errors.js';
import { newMerchantTxnId } from '../payments/checkout.js';
import { startCheckout } from '../payments/checkout.js';
import { closeUnpaidCheckout, reconcilePayment } from '../payments/membership.routes.js';
import { getCampaignOptions, CAMPAIGN_GOALS, campaignOptionFor } from '../payments/pricing.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { campaignCreatedEmail } from '../mail/action-templates.js';

import { getActiveGrowPlans } from '../admin/admin.api.routes.js';
import { isVendorApproved } from '../shared/vendor-status.js';

export const vendorCampaignsRouter = Router();
vendorCampaignsRouter.use(requireAuth('vendor'));

vendorCampaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const campaigns = await prisma.marketingCampaign.findMany({
      where: { vendorId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
      include: { payment: { select: { status: true, merchantTxnId: true } } },
      take: 200,
    });
    const activePlans = getActiveGrowPlans().filter((p) => p.type === 'CAMPAIGN');
    res.json({
      ok: true,
      campaigns,
      catalogue: { options: getCampaignOptions(), goals: CAMPAIGN_GOALS, plans: activePlans },
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
    if (!isVendorApproved(vendor.status)) {
      throw new ForbiddenError('Your vendor account must be approved before buying a campaign');
    }

    // Priced per goal: admins can price one duration differently per goal and
    // the dashboard shows the goal's price, so the charge must match it.
    const option = campaignOptionFor(body.durationDays, body.goal);
    if (!option) throw new BadRequestError('Unknown campaign package');

    // One campaign at a time per vendor. Without this a vendor could stack
    // several running campaigns (the dashboard only ever renders one), and the
    // marketing team would silently be on the hook for all of them.
    const inFlightWhere = {
      vendorId,
      OR: [
        { status: { in: ['PENDING_PAYMENT' as const, 'PENDING_REVIEW' as const] } },
        { status: 'ACTIVE' as const, endsAt: { gt: new Date() } },
      ],
    };
    let inFlight = await prisma.marketingCampaign.findFirst({
      where: inFlightWhere,
      include: { payment: true },
    });

    // An unpaid checkout (Razorpay modal closed, tab lost) used to block every
    // new purchase until the expiry sweep, with an error telling the vendor to
    // "cancel it first" — and no way to cancel. Ask the gateway once: if it was
    // actually paid it is honoured, otherwise it is superseded by this attempt.
    //
    // An attempt the gateway is still processing is never superseded: the
    // money would land on a cancelled campaign while a second one is created.
    if (inFlight?.status === 'PENDING_PAYMENT') {
      const outcome = await closeUnpaidCheckout(inFlight.payment, 'superseded by a new checkout');
      if (outcome === 'busy') {
        throw new ConflictError('Your previous campaign payment is still being processed. Please wait a minute and try again.');
      }
      if (outcome === 'cleared') {
        // Conditional, so a campaign a webhook has just funded stays funded.
        const { count } = await prisma.marketingCampaign.updateMany({
          where: { id: inFlight.id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED' },
        });
        if (count) logger.info({ vendorId, campaignId: inFlight.id }, 'campaign checkout superseded');
      }
      inFlight = await prisma.marketingCampaign.findFirst({ where: inFlightWhere, include: { payment: true } });
    }
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
        gateway: 'RAZORPAY',
        merchantTxnId,
        status: 'INITIATED',
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] || '').slice(0, 250),
      },
    });

    // Sent only once the gateway has actually opened a checkout: mailing
    // "finish paying" first meant a gateway error (campaign cancelled below)
    // still left the vendor a pay-now mail for a campaign that no longer exists.
    const sendCreatedMail = () =>
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
        sendCreatedMail();
        res.json({ ok: true, campaignId: campaign.id, merchantTxnId, checkout });
      } else {
        await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl: checkout.redirectUrl } });
        sendCreatedMail();
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

// Explicit way out of an abandoned checkout. Asks the gateway first so a
// payment that did go through is honoured rather than cancelled.
vendorCampaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const campaign = await prisma.marketingCampaign.findUnique({
      where: { id: req.params.id ?? '' },
      include: { payment: true },
    });
    if (!campaign || campaign.vendorId !== req.auth!.sub) throw new NotFoundError('Campaign not found');
    if (campaign.status !== 'PENDING_PAYMENT') {
      throw new ConflictError('Only a campaign that is still awaiting payment can be cancelled');
    }
    const outcome = await closeUnpaidCheckout(campaign.payment, 'cancelled by vendor');
    if (outcome === 'busy') {
      throw new ConflictError('This payment is still being processed. Please wait a minute before cancelling.');
    }
    const { count } =
      outcome === 'cleared'
        ? await prisma.marketingCampaign.updateMany({
            where: { id: campaign.id, status: 'PENDING_PAYMENT' },
            data: { status: 'CANCELLED' },
          })
        : { count: 0 };
    if (count === 0) {
      throw new ConflictError('This campaign has already been paid for, so it cannot be cancelled here');
    }
    res.json({ ok: true });
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
