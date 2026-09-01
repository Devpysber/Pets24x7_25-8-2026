// Featured Listings — paid top-of-page placement for a claimed listing.
//
//   Public:
//     GET  /api/featured?city=&category=       active featured listing ids (city pages read this)
//   Vendor (JWT):
//     GET  /api/vendor/featured                this vendor's featured slots + catalogue
//     POST /api/vendor/featured               { durationDays } → { redirectUrl }
//     GET  /api/vendor/featured/payment/:txn  poll payment status

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../shared/errors.js';
import { checkStatus, newMerchantTxnId } from '../payments/phonepe.js';
import { startCheckout } from '../payments/checkout.js';
import { applyPaymentResult } from '../payments/membership.routes.js';
import { FEATURED_OPTIONS, featuredOptionFor } from '../payments/pricing.js';
import { getListingById } from '../listings/index.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { featuredCreatedEmail } from '../mail/action-templates.js';

export const featuredPublicRouter = Router();
export const vendorFeaturedRouter = Router();

// ---- Public: which listings are currently boosted ----
const publicLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true });

featuredPublicRouter.get(
  '/',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const citySlug = String(req.query.city ?? '').toLowerCase().trim() || undefined;
    const categorySlug = String(req.query.category ?? '').toLowerCase().trim() || undefined;
    const now = new Date();

    let rows: any[] = [];
    try {
      rows = await prisma.featuredListing.findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { gt: now },
          // A queued slot is ACTIVE but has not started yet — it must not boost
          // the listing until its window opens.
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
          ...(citySlug ? { citySlug } : {}),
          ...(categorySlug ? { categorySlug } : {}),
        },
        select: { listingId: true, city: true, category: true, endsAt: true },
        take: 200,
      });
    } catch {
      // DB offline — no featured
    }
    res.json({ ok: true, featured: rows, listingIds: rows.map((r) => r.listingId) });
  }),
);

// ---- Vendor ----
vendorFeaturedRouter.use(requireAuth('vendor'));

vendorFeaturedRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const featured = await prisma.featuredListing.findMany({
      where: { vendorId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
      include: { payment: { select: { status: true, merchantTxnId: true } } },
    });
    res.json({ ok: true, featured, catalogue: { options: FEATURED_OPTIONS } });
  }),
);

const CreateBody = z.object({ durationDays: z.number().int() });

vendorFeaturedRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = CreateBody.parse(req.body);
    const vendorId = req.auth!.sub;

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new ForbiddenError();
    if (vendor.status !== 'ACTIVE') throw new ForbiddenError('Your vendor account must be approved first');
    if (!vendor.listingId) throw new BadRequestError('Claim your listing before buying Featured placement');

    const option = featuredOptionFor(body.durationDays);
    if (!option) throw new BadRequestError('Unknown Featured package');

    // A live placement no longer blocks the sale — the new slot is queued and
    // starts the moment the current one ends (see applyPaymentResult). Only an
    // unpaid slot blocks, so a vendor can't open two checkouts at once.
    const awaitingPayment = await prisma.featuredListing.findFirst({
      where: { vendorId, status: 'PENDING_PAYMENT' },
    });
    if (awaitingPayment) {
      throw new ConflictError('You already have a Featured placement awaiting payment — finish or cancel it first');
    }

    const listing = getListingById(vendor.listingId);
    const merchantTxnId = newMerchantTxnId();

    const featured = await prisma.featuredListing.create({
      data: {
        vendorId,
        listingId: vendor.listingId,
        city: listing?.city ?? vendor.city ?? null,
        citySlug: listing?.city_slug ?? null,
        category: listing?.category ?? vendor.category ?? null,
        categorySlug: listing?.category_slug ?? null,
        priceMinor: option.priceMinor,
        currency: 'INR',
        durationDays: option.durationDays,
        status: 'PENDING_PAYMENT',
      },
    });

    notifyIf(vendor.email, (to) =>
      featuredCreatedEmail(
        to,
        vendor.businessName,
        { priceMinor: option.priceMinor, currency: 'INR', durationDays: option.durationDays },
        merchantTxnId,
      ),
    );

    const payment = await prisma.payment.create({
      data: {
        purpose: 'FEATURED',
        featuredListingId: featured.id,
        amountMinor: option.priceMinor,
        currency: 'INR',
        gateway: 'PHONEPE',
        merchantTxnId,
        status: 'INITIATED',
        ipAddress: req.ip,
        userAgent: (req.headers['user-agent'] || '').slice(0, 250),
      },
    });

    try {
      const checkout = await startCheckout({
        merchantTxnId,
        amountMinor: option.priceMinor,
        userId: vendorId,
        purpose: 'FEATURED',
        mobileNumber: vendor.phone.replace(/^\+/, '').replace(/^91/, ''),
      });
      if (checkout.mode === 'razorpay') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { gateway: 'RAZORPAY', providerOrderId: checkout.orderId },
        });
        res.json({ ok: true, featuredId: featured.id, merchantTxnId, checkout });
      } else {
        await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl: checkout.redirectUrl } });
        res.json({ ok: true, featuredId: featured.id, merchantTxnId, redirectUrl: checkout.redirectUrl, checkout });
      }
    } catch (err: any) {
      logger.warn({ err }, 'featured checkout: gateway error');
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', errorMessage: String(err?.message ?? 'gateway error') },
      });
      await prisma.featuredListing.update({ where: { id: featured.id }, data: { status: 'CANCELLED' } });
      throw new BadRequestError('Could not start payment — please try again');
    }
  }),
);

vendorFeaturedRouter.get(
  '/payment/:txn',
  asyncHandler(async (req, res) => {
    const txn = req.params.txn ?? '';
    const payment = await prisma.payment.findUnique({
      where: { merchantTxnId: txn },
      include: { featuredListing: true },
    });
    if (!payment || !payment.featuredListing || payment.featuredListing.vendorId !== req.auth!.sub) {
      throw new NotFoundError('Payment not found');
    }
    if (payment.status === 'INITIATED' || payment.status === 'PENDING') {
      try {
        const live = await checkStatus(txn);
        await applyPaymentResult(payment.id, live.data?.state, {
          gatewayTxnId: live.data?.transactionId,
          callbackPayload: live as unknown as object,
        });
      } catch {
        // fall through
      }
    }
    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { featuredListing: true },
    });
    res.json({ ok: true, payment: fresh });
  }),
);
