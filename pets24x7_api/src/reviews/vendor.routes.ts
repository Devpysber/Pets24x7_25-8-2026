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
import { sendReviewRequestTemplate } from '../whatsapp/cloud-api.js';
import { getListingById } from '../listings/index.js';
import { logger } from '../logger.js';

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

    const results: { phone: string; status: 'sent' | 'failed'; error?: string; code?: string }[] = [];
    for (const c of toSend) {
      const phone = normalizePhone(c.phone);
      const code = await uniqueCode();
      try {
        const url = `${env.PUBLIC_SHORTLINK_BASE}/r/${code}`;
        const { messageId } = await sendReviewRequestTemplate(phone, c.name || 'there', businessName, url);
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
        results.push({ phone, status: 'sent', code });
      } catch (err: any) {
        logger.warn({ err, phone }, 'review-request send failed');
        results.push({ phone, status: 'failed', error: String(err?.message ?? 'send failed') });
      }
    }

    await prisma.auditLog.create({
      data: {
        actorType: 'VENDOR', actorId: vendorId, action: 'review_request.bulk',
        meta: { attempted: toSend.length, sent: results.filter(r => r.status === 'sent').length },
        ipAddress: req.ip ?? null,
      },
    });

    res.json({
      ok: true,
      sent:    results.filter(r => r.status === 'sent').length,
      failed:  results.filter(r => r.status === 'failed').length,
      dailyRemaining: Math.max(0, remaining - toSend.length),
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
