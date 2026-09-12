// Public review routes — customer-facing, no auth.
//
//   GET  /r/:code                            tracker redirect (marks openedAt, sends to /review/:code on frontend)
//   GET  /api/reviews/:code                  fetch request context for customer landing page
//   POST /api/reviews/:code/choose           customer picks GOOGLE vs PETS24X7
//   POST /api/reviews/:code/submit           customer submits Pets24x7-hosted review (rating + text)
//   GET  /api/reviews/listing/:listingId     published reviews for any listing
//   POST /api/reviews/listing/:listingId     leave a review on any listing (moderated)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { getListingById } from '../listings/index.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { vendorNewReviewEmail } from '../mail/action-templates.js';

export const reviewShortLinkRouter = Router();
export const reviewPublicApiRouter = Router();

// Stricter than global — public, untrusted.
const publicLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true });

// ---- GET /r/:code  →  302 to /review/:code on frontend, after marking openedAt ----
reviewShortLinkRouter.get(
  '/:code',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const code = (req.params.code ?? '').toUpperCase().slice(0, 16);
    const rr = await prisma.reviewRequest.findUnique({ where: { code } });
    if (!rr) return res.redirect(302, env.PUBLIC_SITE_URL + '/review/expired/');
    if (!rr.openedAt) {
      await prisma.reviewRequest.update({
        where: { id: rr.id },
        data: { openedAt: new Date(), userAgent: (req.headers['user-agent'] || '').slice(0, 250) || null, ipAddress: req.ip ?? null },
      }).catch((err) => logger.warn({ err }, 'review open mark failed'));
    }
    res.redirect(302, env.PUBLIC_SITE_URL + '/review/' + encodeURIComponent(code) + '/');
  }),
);

// ---- GET /api/reviews/listing/:listingId  →  PUBLISHED Pets24x7 reviews for a listing ----
reviewPublicApiRouter.get(
  '/listing/:listingId',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const listingId = (req.params.listingId ?? '').slice(0, 120);
    const vendor = await prisma.vendor.findUnique({ where: { listingId }, select: { id: true } });

    // Reviews can be left on any listing, claimed or not, so match on either
    // side: the listing id itself, and the vendor when one has claimed it.
    const reviews = await prisma.review.findMany({
      where: {
        status: 'PUBLISHED',
        OR: [{ listingId }, ...(vendor ? [{ vendorId: vendor.id }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, reviewerName: true, rating: true, text: true, vendorReply: true, vendorReplyAt: true, createdAt: true },
    });
    const average = reviews.length
      ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10
      : null;
    res.json({ ok: true, count: reviews.length, average, reviews });
  }),
);

// ---- POST /api/reviews/listing/:listingId  →  leave a review on a listing ----
// Open to anyone, because the people with something to say about a vet visit
// are not necessarily account holders. Everything lands PENDING and is only
// visible after an admin publishes it, which is what keeps this from becoming
// a spam surface. A signed-in parent is recorded so their dashboard can show
// what they wrote and its moderation state.
const submitLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5, standardHeaders: true });

const ListingReviewBody = z.object({
  reviewerName: z.string().min(2, 'Tell us your name').max(60),
  rating: z.coerce.number().int().min(1).max(5),
  text: z.string().min(10, 'Please write at least a sentence').max(2000),
  phone: z.string().max(32).optional(),
});

reviewPublicApiRouter.post(
  '/listing/:listingId',
  submitLimiter,
  asyncHandler(async (req, res) => {
    const listingId = (req.params.listingId ?? '').slice(0, 120);
    const body = ListingReviewBody.parse(req.body);

    const listing = getListingById(listingId);
    if (!listing) throw new NotFoundError('Listing not found');

    const vendor = await prisma.vendor
      .findUnique({ where: { listingId }, select: { id: true, businessName: true, email: true } })
      .catch(() => null);

    // The auth cookie is optional here: it only decides attribution.
    const parentId = req.auth?.role === 'pet_parent' ? req.auth.sub : null;

    // One pending review per listing per person stops a double submit from the
    // same form creating two rows for a moderator to read.
    if (parentId) {
      const existing = await prisma.review.findFirst({
        where: { listingId, parentId, status: 'PENDING' },
        select: { id: true },
      });
      if (existing) {
        throw new BadRequestError('You already have a review waiting to be published for this business.');
      }
    }

    const review = await prisma.review.create({
      data: {
        vendorId: vendor?.id ?? null,
        listingId,
        listingName: listing.name,
        parentId,
        reviewerName: body.reviewerName.trim(),
        reviewerPhone: body.phone?.trim() || null,
        rating: body.rating,
        text: body.text.trim(),
        status: 'PENDING',
      },
    });

    // Tell the business someone reviewed them, when there is a business to tell.
    if (vendor?.email) {
      notifyIf(vendor.email, (to) =>
        vendorNewReviewEmail(to, vendor.businessName, {
          reviewerName: review.reviewerName,
          rating: review.rating,
          text: review.text,
        }),
      );
    }

    logger.info({ listingId, reviewId: review.id }, 'listing review submitted');
    res.status(201).json({
      ok: true,
      pending: true,
      message: 'Thanks — your review goes live once our team has checked it.',
    });
  }),
);

// ---- GET /api/reviews/:code  →  context for landing page ----
reviewPublicApiRouter.get(
  '/:code',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const code = (req.params.code ?? '').toUpperCase().slice(0, 16);
    const rr = await prisma.reviewRequest.findUnique({
      where: { code },
      include: { vendor: true, review: true },
    });
    if (!rr) throw new NotFoundError('Review link not found or expired');

    const listing = rr.vendor.listingId ? getListingById(rr.vendor.listingId) : null;
    const googleReviewUrl = rr.vendor.listingId && listing?.google_cid
      ? `https://search.google.com/local/writereview?placeid=&cid=${encodeURIComponent(listing.google_cid)}`
      : listing?.gmb_link ?? null;

    res.json({
      ok: true,
      code: rr.code,
      vendor: {
        businessName: rr.vendor.businessName,
        city: rr.vendor.city,
        category: rr.vendor.category,
        rating: listing?.rating ?? null,
        reviewCount: listing?.review_count ?? null,
      },
      customer: { name: rr.customerName },
      choice: rr.choice,
      alreadyReviewed: !!rr.reviewSubmittedAt,
      googleReviewUrl,
      // Frontend uses this to build the redirect to a friendlier Google form
      googleMapsLink: listing?.gmb_link ?? null,
    });
  }),
);

// ---- POST /api/reviews/:code/choose ----
const ChooseBody = z.object({ choice: z.enum(['GOOGLE', 'PETS24X7']) });

reviewPublicApiRouter.post(
  '/:code/choose',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const code = (req.params.code ?? '').toUpperCase().slice(0, 16);
    const { choice } = ChooseBody.parse(req.body);
    const rr = await prisma.reviewRequest.findUnique({
      where: { code },
      include: { vendor: true },
    });
    if (!rr) throw new NotFoundError('Review link not found');
    if (rr.reviewSubmittedAt) throw new BadRequestError('You\'ve already submitted a review');

    await prisma.reviewRequest.update({
      where: { id: rr.id },
      data: { choice, choiceMadeAt: new Date() },
    });

    let nextUrl: string;
    if (choice === 'GOOGLE') {
      const listing = rr.vendor.listingId ? getListingById(rr.vendor.listingId) : null;
      const googleUrl = listing?.google_cid
        ? `https://search.google.com/local/writereview?cid=${encodeURIComponent(listing.google_cid)}`
        : (listing?.gmb_link ?? `${env.PUBLIC_SITE_URL}/review/${code}/thanks/`);
      // Mark as completed when they head to Google (best-effort; we can't observe submission there)
      await prisma.reviewRequest.update({
        where: { id: rr.id },
        data: { reviewSubmittedAt: new Date() },
      });
      nextUrl = googleUrl;
    } else {
      nextUrl = `${env.PUBLIC_SITE_URL}/review/${encodeURIComponent(code)}/form/`;
    }
    res.json({ ok: true, nextUrl });
  }),
);

// ---- POST /api/reviews/:code/submit  (Pets24x7-hosted) ----
const SubmitBody = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().min(8).max(2000),
  reviewerName: z.string().min(1).max(60).optional(),
});

reviewPublicApiRouter.post(
  '/:code/submit',
  publicLimiter,
  asyncHandler(async (req, res) => {
    const code = (req.params.code ?? '').toUpperCase().slice(0, 16);
    const body = SubmitBody.parse(req.body);
    const rr = await prisma.reviewRequest.findUnique({ where: { code } });
    if (!rr) throw new NotFoundError('Review link not found');
    if (rr.reviewSubmittedAt) throw new BadRequestError('You\'ve already submitted a review');

    // Transactionally create Review (PENDING moderation) + link to ReviewRequest.
    const result = await prisma.$transaction(async (tx) => {
      const review = await tx.review.create({
        data: {
          vendorId: rr.vendorId,
          reviewerName: body.reviewerName ?? rr.customerName ?? 'Anonymous',
          reviewerPhone: rr.customerPhone,
          rating: body.rating,
          text: body.text,
          status: 'PENDING',
        },
      });
      await tx.reviewRequest.update({
        where: { id: rr.id },
        data: {
          choice: 'PETS24X7',
          choiceMadeAt: rr.choiceMadeAt ?? new Date(),
          reviewSubmittedAt: new Date(),
          reviewId: review.id,
        },
      });
      return review;
    });

    // Tell the vendor a review landed (it is still PENDING moderation).
    prisma.vendor
      .findUnique({ where: { id: rr.vendorId }, select: { email: true, businessName: true } })
      .then((v) => {
        if (!v) return;
        notifyIf(v.email, (to) =>
          vendorNewReviewEmail(to, v.businessName, {
            reviewerName: result.reviewerName,
            rating: result.rating,
            text: result.text,
          }),
        );
      })
      .catch(() => {});

    res.status(201).json({ ok: true, reviewId: result.id, status: result.status });
  }),
);
