// Vendor service catalogue CRUD.
//   GET    /api/vendor/services
//   POST   /api/vendor/services            { name, priceMinor, durationLabel?, description? }
//   PATCH  /api/vendor/services/:id
//   DELETE /api/vendor/services/:id
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError } from '../shared/errors.js';
import { notifyIf } from '../mail/notify.js';
import { serviceAddedEmail, serviceRemovedEmail, serviceUpdatedEmail } from '../mail/action-templates.js';

export const vendorServicesRouter = Router();

/** Address + business name for the action mails below; null when unknown. */
function vendorContact(vendorId: string) {
  return prisma.vendor
    .findUnique({ where: { id: vendorId }, select: { email: true, businessName: true } })
    .catch(() => null);
}
vendorServicesRouter.use(requireAuth('vendor'));

const ServiceBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  priceMinor: z.number().int().min(0).max(100_000_00),
  currency: z.string().length(3).optional(),
  durationLabel: z.string().min(1).max(40).optional(),
  status: z.enum(['ACTIVE', 'HIDDEN']).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

vendorServicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const services = await prisma.service.findMany({
      where: { vendorId: req.auth!.sub },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ ok: true, services });
  }),
);

vendorServicesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = ServiceBody.parse(req.body);
    const service = await prisma.service.create({
      data: {
        vendorId: req.auth!.sub,
        name: body.name,
        description: body.description ?? null,
        priceMinor: body.priceMinor,
        currency: body.currency ?? 'INR',
        durationLabel: body.durationLabel ?? '30 mins',
        status: body.status ?? 'ACTIVE',
        sortOrder: body.sortOrder ?? 0,
      },
    });
    const vendor = await vendorContact(req.auth!.sub);
    notifyIf(vendor?.email, (to) =>
      serviceAddedEmail(to, vendor!.businessName, {
        name: service.name,
        priceMinor: service.priceMinor,
        currency: service.currency,
        durationLabel: service.durationLabel,
      }),
    );
    res.status(201).json({ ok: true, service });
  }),
);

vendorServicesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = ServiceBody.partial().parse(req.body);
    const existing = await prisma.service.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Service not found');
    if (existing.vendorId !== req.auth!.sub) throw new ForbiddenError();

    const data: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'priceMinor', 'currency', 'durationLabel', 'status', 'sortOrder'] as const) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    const service = await prisma.service.update({ where: { id: existing.id }, data });
    const vendor = await vendorContact(req.auth!.sub);
    notifyIf(vendor?.email, (to) => serviceUpdatedEmail(to, vendor!.businessName, service.name));
    res.json({ ok: true, service });
  }),
);

vendorServicesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.service.findUnique({ where: { id: req.params.id ?? '' } });
    if (!existing) throw new NotFoundError('Service not found');
    if (existing.vendorId !== req.auth!.sub) throw new ForbiddenError();
    await prisma.service.delete({ where: { id: existing.id } });
    const vendor = await vendorContact(req.auth!.sub);
    notifyIf(vendor?.email, (to) => serviceRemovedEmail(to, vendor!.businessName, existing.name));
    res.json({ ok: true });
  }),
);
