// Enquiry capture — the lead pipeline behind every "enquiry" / "booking" form.
//
//   POST /api/enquiries            public (optional pet_parent auth) — create a lead
//   GET  /api/enquiries/mine       pet_parent auth — the signed-in parent's own leads
//
// The static site's listing.html / marketing.html forms POST here in addition
// to the legacy Google Apps Script sheet. The parent + vendor dashboards POST
// here too. Admin reads them via prisma in admin.api.routes.ts.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { normalizePhone } from '../shared/phone.js';
import { getListingById } from '../listings/index.js';
import { notifyVendorById } from '../whatsapp/notify.js';
import { notifyIf } from '../mail/notify.js';
import { enquiryReceivedEmail, vendorNewEnquiryEmail } from '../mail/action-templates.js';
import { logger } from '../logger.js';

export const enquiryRouter = Router();

const createLimiter = rateLimit({
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 10,
  standardHeaders: true,
});

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().min(6).max(24),
  email: z.string().email().max(160).optional().or(z.literal('')),
  listingId: z.string().max(120).optional(),
  listingName: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  country: z.enum(['IN', 'US']).optional(),
  petType: z.string().max(60).optional(),
  preferredDate: z.string().max(40).optional(),
  notes: z.string().max(2000).optional().default(''),
  source: z.string().max(60).optional(),
});

enquiryRouter.post(
  '/',
  createLimiter,
  optionalAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const body = CreateBody.parse(req.body);

    // Enrich from the in-memory static index when a listingId is supplied.
    const listing = body.listingId ? getListingById(body.listingId) : undefined;

    let petParentId: string | null = null;
    if (req.auth?.sub) {
      const p = await prisma.petParent
        .findUnique({ where: { id: req.auth.sub }, select: { id: true } })
        .catch(() => null);
      petParentId = p?.id ?? null;
    }

    let preferredDate: Date | null = null;
    if (body.preferredDate) {
      const d = new Date(body.preferredDate);
      if (!Number.isNaN(d.getTime())) preferredDate = d;
    }

    const enquiry = await prisma.enquiry.create({
      data: {
        petParentId,
        listingId: body.listingId ?? listing?.id ?? null,
        listingName: body.listingName ?? listing?.name ?? null,
        category: body.category ?? listing?.category ?? null,
        city: body.city ?? listing?.city ?? null,
        country: body.country ?? (listing?.country as string | undefined) ?? null,
        name: body.name,
        phone: normalizePhone(body.phone, body.country ?? 'IN'),
        email: body.email || null,
        petType: body.petType ?? null,
        preferredDate,
        notes: body.notes ?? '',
        source: body.source ?? 'api',
      },
    });

    logger.info({ id: enquiry.id, source: enquiry.source }, 'enquiry.created');

    // Acknowledge to the parent, when they left an address.
    notifyIf(enquiry.email, (to) => enquiryReceivedEmail(to, enquiry.name, enquiry.listingName));

    // Best-effort: nudge the claimed vendor for this listing, on WhatsApp and email.
    const targetListingId = enquiry.listingId;
    if (targetListingId) {
      prisma.vendor
        .findUnique({
          where: { listingId: targetListingId },
          select: { id: true, email: true, businessName: true },
        })
        .then((v) => {
          if (!v) return;
          notifyIf(v.email, (to) =>
            vendorNewEnquiryEmail(to, v.businessName, {
              name: enquiry.name,
              phone: enquiry.phone,
              petType: enquiry.petType,
              preferredDate: enquiry.preferredDate,
              notes: enquiry.notes,
              city: enquiry.city,
            }),
          );
          return notifyVendorById(
            v.id,
            `New Pets24x7 enquiry from ${enquiry.name} (${enquiry.phone}): ${enquiry.notes || 'no message'}`,
          );
        })
        .catch(() => {});
    }

    res.status(201).json({ ok: true, enquiry: { id: enquiry.id, createdAt: enquiry.createdAt } });
  }),
);

enquiryRouter.get(
  '/mine',
  requireAuth('pet_parent'),
  asyncHandler(async (req, res) => {
    const enquiries = await prisma.enquiry.findMany({
      where: { petParentId: req.auth!.sub },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ ok: true, enquiries });
  }),
);
