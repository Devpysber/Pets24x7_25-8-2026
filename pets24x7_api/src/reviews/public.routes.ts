// Public review routes — customer-facing, no auth.
//
//   GET  /r/:code                            tracker redirect (marks openedAt, sends to /review/:code on frontend)
//   GET  /api/reviews/:code                  fetch request context for customer landing page
//   POST /api/reviews/:code/choose           customer picks GOOGLE vs PETS24X7
//   POST /api/reviews/:code/submit           customer submits Pets24x7-hosted review (rating + text)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { getListingById } from '../listings/index.js';
import { logger } from '../logger.js';

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

    res.status(201).json({ ok: true, reviewId: result.id, status: result.status });
  }),
);
