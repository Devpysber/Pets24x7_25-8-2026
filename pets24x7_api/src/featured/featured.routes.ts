// Featured Listings — paid top-of-page placement for a claimed listing.
//
//   Public:
//     GET  /api/featured?city=&category=&limit=   live featured slots, fair-rotated (city pages read this)
//   Vendor (JWT):
//     GET  /api/vendor/featured                this vendor's featured slots + catalogue
//     POST /api/vendor/featured               { durationDays } → { redirectUrl }
//     GET  /api/vendor/featured/payment/:txn  poll payment status

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../shared/errors.js';
import { newMerchantTxnId } from '../payments/checkout.js';
import { startCheckout } from '../payments/checkout.js';
import { closeUnpaidCheckout, reconcilePayment } from '../payments/membership.routes.js';
import { getFeaturedOptions, featuredOptionFor } from '../payments/pricing.js';
import { getListingById, shownRating } from '../listings/index.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { featuredCreatedEmail } from '../mail/action-templates.js';
import { isVendorApproved } from '../shared/vendor-status.js';
import { getRecoConfig } from '../feed/reco/config.js';
import { recordDelivery, rotateFeatured } from '../feed/reco/blend.js';
import { registerRid } from '../feed/reco/events.js';
import { sha1 } from '../feed/reco/util.js';

export const featuredPublicRouter = Router();

/** Same slug rule the directory uses ("Navi Mumbai" -> "navi-mumbai"). */
function slugOf(value: string | null | undefined): string | null {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return s || null;
}
export const vendorFeaturedRouter = Router();

// ---- Public: which listings are currently boosted ----
const publicLimiter = makeLimiter('featured-public', { windowMs: 60_000, max: 120, standardHeaders: true });

featuredPublicRouter.get(
  '/',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const citySlug = String(req.query.city ?? '').toLowerCase().trim().slice(0, 160) || undefined;
    const categorySlug = String(req.query.category ?? '').toLowerCase().trim().slice(0, 160) || undefined;
    // Optional cap (1..10); without it every eligible slot is returned, in
    // rotation order, and the generated pages take the first three as before.
    const rawLimit = Number(req.query.limit);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 10) : null;
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
        select: { id: true, listingId: true, city: true, citySlug: true, category: true, categorySlug: true, endsAt: true },
        take: 200,
      });
    } catch {
      // DB offline — no featured
    }

    // Fair rotation: DB order used to be arbitrary but stable, so the same
    // three paid slots won the strip on every page view. Order is now a
    // shuffle seeded per 5-minute bucket and weighted toward the slots with
    // the fewest deliveries in the last 24h, so every sponsor gets a
    // comparable share of voice (and a CDN copy stays consistent).
    const bucket = Math.floor(Date.now() / 300_000);
    const rid = sha1(`featured_strip|${citySlug ?? ''}|${categorySlug ?? ''}|${limit ?? ''}|${bucket}`).slice(0, 16);
    // An admin-hidden listing is off every public surface, paid slot or not.
    rows = rows.filter((r) => !getListingById(r.listingId)?.hidden);
    rows = rotateFeatured(rows, rid);
    if (limit) rows = rows.slice(0, limit);

    // A city page is static HTML: it knows nothing about a listing it does not
    // already print, so an id alone cannot be rendered. Send enough of the
    // record to draw a card for a boosted business on page 3 of the results.
    // A claimed listing can be missing from the directory index — an imported
    // row that never made it in, or one deleted since. The business still paid,
    // so the card is built from its own account rather than dropped.
    const missing = rows.filter((r) => !getListingById(r.listingId)).map((r) => r.listingId);
    let vendorFallback = new Map<string, { businessName: string; city: string | null; category: string | null; phone: string | null }>();
    if (missing.length) {
      try {
        const vendors = await prisma.vendor.findMany({
          where: { listingId: { in: missing } },
          select: { listingId: true, businessName: true, city: true, category: true, phone: true },
        });
        vendorFallback = new Map(
          vendors
            .filter((v) => v.listingId)
            .map((v) => [v.listingId as string, {
              businessName: v.businessName, city: v.city, category: v.category, phone: v.phone,
            }]),
        );
      } catch {
        // No fallback available; those rows are skipped below.
      }
    }

    const label = (await getRecoConfig()).sponsored.label;
    const cards = rows
      .map((r) => {
        const l = getListingById(r.listingId);
        if (!l) {
          const v = vendorFallback.get(r.listingId);
          if (!v) return null;
          return {
            id: r.listingId,
            name: v.businessName,
            category: r.category ?? v.category ?? 'Pet Service',
            categoryIcon: null,
            city: r.city ?? v.city ?? '',
            state: null,
            address: null,
            phone: v.phone,
            rating: 0,
            reviewCount: 0,
            googleCid: null,
            // /find-my-listing/ searches by name and city; an ?id= it cannot read
            // opened an empty search.
            url: `/find-my-listing/?q=${encodeURIComponent(v.businessName)}${
              (r.city ?? v.city) ? `&city=${encodeURIComponent(String(r.city ?? v.city))}` : ''
            }`,
            endsAt: r.endsAt,
            featuredId: r.id as string,
            sponsored: true as const,
            label,
          };
        }
        return {
          id: l.id,
          name: l.name,
          category: l.category,
          categoryIcon: l.category_icon ?? null,
          city: l.city,
          state: l.state ?? null,
          address: l.address ?? null,
          phone: l.phone ?? null,
          rating: shownRating(l),
          reviewCount: l.review_count,
          googleCid: l.google_cid ?? null,
          url: `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`,
          endsAt: r.endsAt,
          featuredId: r.id as string,
          sponsored: true as const,
          label,
        };
      })
      .filter((c): c is NonNullable<typeof c> => !!c);

    // The strip reports impressions and clicks against this rid (surface
    // featured_strip); only listings it really served validate.
    registerRid(rid, {
      surface: 'featured_strip',
      variant: 'A',
      items: Object.fromEntries(
        cards.map((c, i) => [c.id, { pos: i + 1, reason: 'SPONSORED' as const, sponsored: true, featuredId: c.featuredId }]),
      ),
    });
    // Pages show the first three; count those as delivered for the rotation.
    for (const c of cards.slice(0, limit ?? 3)) recordDelivery(c.featuredId);

    res.json({ ok: true, featured: rows, listingIds: rows.map((r) => r.listingId), rid, cards });
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
    res.json({ ok: true, featured, catalogue: { options: getFeaturedOptions() } });
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
    if (!isVendorApproved(vendor.status)) throw new ForbiddenError('Your vendor account must be approved first');
    if (!vendor.listingId) throw new BadRequestError('Claim your listing before buying Featured placement');

    const option = featuredOptionFor(body.durationDays);
    if (!option) throw new BadRequestError('Unknown Featured package');

    // A live placement no longer blocks the sale — the new slot is queued and
    // starts the moment the current one ends (see applyPaymentResult). Only an
    // unpaid slot blocks, so a vendor can't open two checkouts at once.
    //
    // An abandoned checkout (Razorpay modal closed, tab lost) used to block
    // every new purchase until the expiry sweep, with no way to cancel it —
    // same failure the campaign checkout was patched to fix. Ask the gateway
    // once: if it was actually paid it is honoured, otherwise it is superseded.
    let awaitingPayment = await prisma.featuredListing.findFirst({
      where: { vendorId, status: 'PENDING_PAYMENT' },
      include: { payment: true },
    });
    // An attempt still being processed is never superseded (see campaigns).
    if (awaitingPayment?.status === 'PENDING_PAYMENT') {
      const outcome = await closeUnpaidCheckout(awaitingPayment.payment, 'superseded by a new checkout');
      if (outcome === 'busy') {
        throw new ConflictError('Your previous Featured payment is still being processed. Please wait a minute and try again.');
      }
      if (outcome === 'cleared') {
        const { count } = await prisma.featuredListing.updateMany({
          where: { id: awaitingPayment.id, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED' },
        });
        if (count) logger.info({ vendorId, featuredId: awaitingPayment.id }, 'featured checkout superseded');
      }
      awaitingPayment = await prisma.featuredListing.findFirst({
        where: { vendorId, status: 'PENDING_PAYMENT' },
        include: { payment: true },
      });
    }
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
        // The public strip filters on citySlug, so a listing missing from the
        // index must still get one: null made a paid slot invisible everywhere.
        citySlug: listing?.city_slug ?? slugOf(listing?.city ?? vendor.city),
        category: listing?.category ?? vendor.category ?? null,
        categorySlug: listing?.category_slug ?? slugOf(listing?.category ?? vendor.category),
        priceMinor: option.priceMinor,
        currency: 'INR',
        durationDays: option.durationDays,
        status: 'PENDING_PAYMENT',
      },
    });

    // Sent only once the gateway has actually opened a checkout, as for
    // campaigns: a gateway error cancels the slot below, and a "finish paying"
    // mail for a slot that no longer exists is worse than none.
    const sendCreatedMail = () =>
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
        gateway: 'RAZORPAY',
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
        sendCreatedMail();
        res.json({ ok: true, featuredId: featured.id, merchantTxnId, checkout });
      } else {
        await prisma.payment.update({ where: { id: payment.id }, data: { redirectUrl: checkout.redirectUrl } });
        sendCreatedMail();
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

vendorFeaturedRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const featured = await prisma.featuredListing.findUnique({
      where: { id: req.params.id ?? '' },
      include: { payment: true },
    });
    if (!featured || featured.vendorId !== req.auth!.sub) throw new NotFoundError('Featured placement not found');
    if (featured.status !== 'PENDING_PAYMENT') {
      throw new ConflictError('Only a Featured placement that is still awaiting payment can be cancelled');
    }
    const outcome = await closeUnpaidCheckout(featured.payment, 'cancelled by vendor');
    if (outcome === 'busy') {
      throw new ConflictError('This payment is still being processed. Please wait a minute before cancelling.');
    }
    const { count } =
      outcome === 'cleared'
        ? await prisma.featuredListing.updateMany({
            where: { id: featured.id, status: 'PENDING_PAYMENT' },
            data: { status: 'CANCELLED' },
          })
        : { count: 0 };
    if (count === 0) {
      throw new ConflictError('This Featured placement has already been paid for, so it cannot be cancelled here');
    }
    res.json({ ok: true });
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
    await reconcilePayment(payment);
    const fresh = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: { featuredListing: true },
    });
    res.json({ ok: true, payment: fresh });
  }),
);
