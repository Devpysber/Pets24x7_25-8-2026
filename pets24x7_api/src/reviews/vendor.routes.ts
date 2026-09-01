// Vendor-side review APIs.
//   POST /api/vendor/reviews/requests/bulk { customers: [{phone, name?}, ...] }
//     - Sends WA review template to each (50/day cap per vendor)
//     - Creates ReviewRequest rows with unique short-link codes
//   GET  /api/vendor/reviews/requests           — paginated history + counts
//   GET  /api/vendor/reviews                    — Pets24x7-hosted reviews collected for this vendor

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, ForbiddenError, TooManyRequestsError } from '../shared/errors.js';
import { normalizePhone } from '../shared/phone.js';
import { sendReviewRequestTemplate, whatsappConfigured } from '../whatsapp/cloud-api.js';
import { getListingById } from '../listings/index.js';
import { logger } from '../logger.js';
import { notifyIf } from '../mail/notify.js';
import { reviewReplyPostedEmail, reviewRequestsSentEmail } from '../mail/action-templates.js';

export const vendorReviewsRouter = Router();
vendorReviewsRouter.use(requireAuth('vendor'));

const DAILY_CAP = 50;

// URL-safe 10-char code (base64url-ish, no ambiguous chars).
function newCode(): string {
  return randomBytes(8)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .replace(/[01OIl]/g, 'X') // strip ambiguous
    .slice(0, 10)
    .toUpperCase();
}

async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const existing = await prisma.reviewRequest.findUnique({ where: { code }, select: { id: true } });
    if (!existing) return code;
  }
  throw new Error('Could not allocate unique code');
}

// ----- POST /requests/bulk -----
const BulkBody = z.object({
  customers: z.array(z.object({
    phone: z.string().min(6),
    name:  z.string().min(1).max(60).optional(),
  })).min(1).max(DAILY_CAP),
});

// Stricter route limiter on top of global.
const bulkLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5, standardHeaders: true });

vendorReviewsRouter.post(
  '/requests/bulk',
  bulkLimiter,
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    const body = BulkBody.parse(req.body);

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new ForbiddenError();
    if (vendor.status !== 'ACTIVE') {
      throw new ForbiddenError('Your vendor account must be approved by admin before sending review requests');
    }

    // Day cap — count today's sends + incoming batch size.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sentToday = await prisma.reviewRequest.count({
      where: { vendorId, sentAt: { gte: startOfDay } },
    });
    const remaining = DAILY_CAP - sentToday;
    if (remaining <= 0) {
      throw new TooManyRequestsError(`Daily cap reached (${DAILY_CAP}/day). Try again tomorrow.`);
    }
    const toSend = body.customers.slice(0, remaining);

    // Listing name for the WA template — fallback to vendor.businessName.
    const listing = vendor.listingId ? getListingById(vendor.listingId) : null;
    const businessName = vendor.businessName || listing?.name || 'our pet business';

    // The review link is the product; the WhatsApp message is only one way to
    // deliver it. So the row (and its code) is created first and kept even when
    // the send fails — the vendor then gets a wa.me link to send by hand,
    // instead of losing the request entirely.
    const waReady = whatsappConfigured();
    if (!waReady) {
      logger.warn({ vendorId }, 'WhatsApp not configured — review requests will be link-only');
    }

    interface BulkResult {
      phone: string;
      status: 'sent' | 'link_only';
      code: string;
      /** Short link to give the customer. */
      url: string;
      /** Pre-filled wa.me link the vendor can open to send it themselves. */
      shareUrl: string;
      error?: string;
    }

    const results: BulkResult[] = [];
    for (const c of toSend) {
      const phone = normalizePhone(c.phone);
      const code = await uniqueCode();
      const url = `${env.PUBLIC_SHORTLINK_BASE}/r/${code}`;
      const text =
        `Hi ${c.name || 'there'}! Thanks for choosing ${businessName}. ` +
        `Could you leave us a quick review? ${url}`;
      const shareUrl = `https://wa.me/${phone.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`;

      let messageId: string | null = null;
      let error: string | undefined;
      if (waReady) {
        try {
          ({ messageId } = await sendReviewRequestTemplate(phone, c.name || 'there', businessName, url));
        } catch (err: any) {
          logger.warn({ err, phone }, 'review-request WhatsApp send failed — falling back to link');
          error = String(err?.message ?? 'send failed');
        }
      } else {
        error = 'WhatsApp is not connected yet — send the link yourself';
      }

      await prisma.reviewRequest.create({
        data: {
          vendorId,
          code,
          customerName: c.name ?? null,
          customerPhone: phone,
          waMessageId: messageId,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] || '').slice(0, 250) || null,
        },
      });

      results.push({
        phone,
        status: messageId ? 'sent' : 'link_only',
        code,
        url,
        shareUrl,
        ...(error ? { error } : {}),
      });
    }

    await prisma.auditLog.create({
      data: {
        actorType: 'VENDOR', actorId: vendorId, action: 'review_request.bulk',
        meta: {
          attempted: toSend.length,
          sent: results.filter((r) => r.status === 'sent').length,
          linkOnly: results.filter((r) => r.status === 'link_only').length,
        },
        ipAddress: req.ip ?? null,
      },
    });

    const sent = results.filter((r) => r.status === 'sent').length;
    // Not an error: the link exists and works, it just needs sending by hand.
    const linkOnly = results.filter((r) => r.status === 'link_only').length;
    const failed = linkOnly;
    const dailyRemaining = Math.max(0, remaining - toSend.length);
    if (sent > 0) {
      notifyIf(vendor.email, (to) =>
        reviewRequestsSentEmail(to, vendor.businessName, { sent, failed, remainingToday: dailyRemaining }),
      );
    }

    res.json({
      ok: true,
      sent,
      linkOnly,
      failed,
      whatsappConnected: waReady,
      dailyRemaining,
      results,
    });
  }),
);

// ----- GET /requests -----
vendorReviewsRouter.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    try {
      const [requests, totals] = await Promise.all([
        prisma.reviewRequest.findMany({
          where: { vendorId },
          orderBy: { sentAt: 'desc' },
          take: 100,
          include: { review: true },
        }),
        prisma.reviewRequest.aggregate({
          where: { vendorId },
          _count: true,
        }),
      ]);
      const opened    = requests.filter(r => r.openedAt).length;
      const completed = requests.filter(r => r.reviewSubmittedAt).length;

      res.json({
        ok: true,
        counts: { total: totals._count, opened, completed },
        requests,
      });
    } catch (err) {
      logger.warn({ err }, 'Prisma error in GET /vendor/reviews/requests, returning dev fallback');
      res.json({
        ok: true,
        counts: { total: 0, opened: 0, completed: 0 },
        requests: [],
      });
    }
  }),
);

// ----- GET / (collected reviews) -----
vendorReviewsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    try {
      const reviews = await prisma.review.findMany({
        where: { vendorId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      res.json({ ok: true, reviews });
    } catch (err) {
      logger.warn({ err }, 'Prisma error in GET /vendor/reviews, returning dev fallback');
      res.json({ ok: true, reviews: [] });
    }
  }),
);

// ----- PATCH /:id/reply — vendor's public reply to one of their reviews -----
const ReplyBody = z.object({ reply: z.string().min(1).max(1000) });
vendorReviewsRouter.patch(
  '/:id/reply',
  asyncHandler(async (req, res) => {
    const { reply } = ReplyBody.parse(req.body);
    const review = await prisma.review.findUnique({ where: { id: req.params.id ?? '' } });
    if (!review) throw new BadRequestError('Review not found');
    if (review.vendorId !== req.auth!.sub) throw new ForbiddenError();
    const updated = await prisma.review.update({
      where: { id: review.id },
      data: { vendorReply: reply, vendorReplyAt: new Date() },
    });
    const vendor = await prisma.vendor
      .findUnique({ where: { id: req.auth!.sub }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(vendor?.email, (to) => reviewReplyPostedEmail(to, vendor!.businessName, review.reviewerName));
    res.json({ ok: true, review: { id: updated.id, vendorReply: updated.vendorReply, vendorReplyAt: updated.vendorReplyAt } });
  }),
);
