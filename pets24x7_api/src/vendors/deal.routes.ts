// Vendor deals & offers CRUD. A deal is shown on the vendor's public listing
// and in the city "nearby deals" feed (GET /api/deals) while it is ACTIVE and
// inside its dates. City, category, country and listing are taken from the
// vendor's own profile, never from the request.
//   GET    /api/vendor/deals
//   POST   /api/vendor/deals            { title, offerLabel, description, code?, startsAt?, endsAt?, status? }
//   PATCH  /api/vendor/deals/:id
//   DELETE /api/vendor/deals/:id
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { saveTrash } from '../trash/trash.js';

export const vendorDealsRouter = Router();
vendorDealsRouter.use(requireAuth('vendor'));

const MAX_DEALS = 20;

const DealBody = z.object({
  title: z.string().trim().min(2).max(140),
  offerLabel: z.string().trim().min(1).max(60),
  description: z.string().trim().min(2).max(1000),
  code: z.string().trim().max(40).optional().nullable(),
  startsAt: z.string().optional().nullable(),
  endsAt: z.string().optional().nullable(),
  // DRAFT = saved but not shown ("paused" in the dashboard).
  status: z.enum(['ACTIVE', 'DRAFT']).optional(),
});

/** "2026-10-08" -> start of that day; a bad value is a 400. */
function parseDay(v: string | null | undefined, field: string, endOfDay = false): Date | null {
  if (!v) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${endOfDay ? '23:59:59' : '00:00:00'}` : v);
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${field} is not a valid date`);
  return d;
}

function citySlugOf(city: string | null | undefined): string | null {
  return city ? city.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || null : null;
}

/** The fields a deal copies from its vendor so it files under the right city and listing. */
async function vendorPlacement(vendorId: string) {
  const v = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { city: true, category: true, country: true, listingId: true },
  });
  if (!v) throw new NotFoundError('Vendor not found');
  return {
    city: v.city ?? null,
    citySlug: citySlugOf(v.city),
    category: v.category ?? null,
    country: v.country ?? null,
    listingId: v.listingId ?? null,
  };
}

async function ownDeal(req: { params: { id?: string }; auth?: { sub: string } }) {
  const deal = await prisma.deal.findUnique({ where: { id: req.params.id ?? '' } });
  if (!deal) throw new NotFoundError('Deal not found');
  if (deal.vendorId !== req.auth!.sub) throw new ForbiddenError();
  return deal;
}

vendorDealsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const deals = await prisma.deal.findMany({
      where: { vendorId: req.auth!.sub, status: { not: 'ARCHIVED' } },
      orderBy: [{ createdAt: 'desc' }],
    });
    res.json({ ok: true, deals });
  }),
);

vendorDealsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = DealBody.parse(req.body);
    const count = await prisma.deal.count({ where: { vendorId: req.auth!.sub, status: { not: 'ARCHIVED' } } });
    if (count >= MAX_DEALS) {
      throw new BadRequestError(`You can have up to ${MAX_DEALS} deals. Remove an old one to add another.`);
    }
    const startsAt = parseDay(body.startsAt, 'Start date') ?? new Date();
    const endsAt = parseDay(body.endsAt, 'End date', true);
    if (endsAt && endsAt <= startsAt) throw new BadRequestError('The end date must be after the start date.');
    const deal = await prisma.deal.create({
      data: {
        vendorId: req.auth!.sub,
        ...(await vendorPlacement(req.auth!.sub)),
        title: body.title,
        offerLabel: body.offerLabel,
        description: body.description,
        code: body.code ? body.code.toUpperCase() : null,
        startsAt,
        endsAt,
        status: body.status ?? 'ACTIVE',
      },
    });
    res.status(201).json({ ok: true, deal });
  }),
);

vendorDealsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = DealBody.partial().parse(req.body);
    const existing = await ownDeal(req);
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'offerLabel', 'description'] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    if (body.code !== undefined) data.code = body.code ? body.code.toUpperCase() : null;
    if (body.startsAt !== undefined) data.startsAt = parseDay(body.startsAt, 'Start date') ?? existing.startsAt;
    if (body.endsAt !== undefined) data.endsAt = parseDay(body.endsAt, 'End date', true);
    // Re-activating an expired deal needs a new end date, or it expires again
    // on the next sweep; the dashboard sends both together.
    if (body.status !== undefined) data.status = body.status;
    const startsAt = (data.startsAt as Date | undefined) ?? existing.startsAt;
    const endsAt = data.endsAt !== undefined ? (data.endsAt as Date | null) : existing.endsAt;
    if (endsAt && endsAt <= startsAt) throw new BadRequestError('The end date must be after the start date.');
    if (existing.status === 'EXPIRED' && body.status === undefined && data.endsAt !== undefined && (!endsAt || endsAt > new Date())) {
      data.status = 'ACTIVE';
    }
    // Keep the deal filed under the vendor's current city and listing.
    Object.assign(data, await vendorPlacement(req.auth!.sub));
    const deal = await prisma.deal.update({ where: { id: existing.id }, data });
    res.json({ ok: true, deal });
  }),
);

vendorDealsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await ownDeal(req);
    await saveTrash('deal', existing.id, existing.title, { row: existing }, { role: 'vendor', id: req.auth!.sub });
    await prisma.deal.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);
