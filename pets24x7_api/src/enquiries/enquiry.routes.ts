// Enquiry capture — the lead pipeline behind every "enquiry" / "booking" form.
//
//   POST /api/enquiries            public (optional pet_parent auth) — create a lead
//   GET  /api/enquiries/mine       pet_parent auth — the signed-in parent's own leads
//
// The static site's listing.html / marketing.html forms POST here in addition
// to the legacy Google Apps Script sheet. The parent + vendor dashboards POST
// here too. Admin reads them via prisma in admin.api.routes.ts.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth, optionalAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { normalizePhone } from '../shared/phone.js';
import { getListingById } from '../listings/index.js';
import { notifyVendorById } from '../whatsapp/notify.js';
import { notifyIf } from '../mail/notify.js';
import { enquiryReceivedEmail, vendorNewEnquiryEmail } from '../mail/action-templates.js';
import { logger } from '../logger.js';
import { isVendorApproved } from '../shared/vendor-status.js';
import { invalidateParent } from '../feed/reco/cache.js';

export const enquiryRouter = Router();

/** Same number, same listing, inside this window = the same enquiry. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const createLimiter = makeLimiter('enquiry-create', {
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

    const phoneCountry: 'IN' | 'US' =
      (body.country ?? String(listing?.country ?? 'IN').toUpperCase()) === 'US' ? 'US' : 'IN';
    const phone = normalizePhone(body.phone, phoneCountry);
    const listingId = body.listingId ?? listing?.id ?? null;

    // A double-tap, a retry after a slow network, or the form being sent again
    // a minute later must not open a second lead — nor mail the parent and
    // WhatsApp/email the vendor the same enquiry twice. The same number asking
    // the same listing inside the window is answered with the lead that exists.
    // Uses the phone index; the window keeps the scan to a handful of rows.
    const duplicate = await prisma.enquiry.findFirst({
      where: {
        phone,
        listingId,
        ...(listingId ? {} : { listingName: listing?.name ?? body.listingName ?? null, source: body.source ?? 'api' }),
        createdAt: { gt: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (duplicate) {
      logger.info({ id: duplicate.id }, 'enquiry.duplicate — not re-notifying');
      return res.status(200).json({ ok: true, duplicate: true, enquiry: duplicate });
    }

    const enquiry = await prisma.enquiry.create({
      data: {
        petParentId,
        listingId,
        // The index is the authority on a known listing's name: vendor inboxes
        // fall back to matching on it, so a client-supplied name must not win.
        listingName: listing?.name ?? body.listingName ?? null,
        category: body.category ?? listing?.category ?? null,
        city: body.city ?? listing?.city ?? null,
        country: body.country ?? (listing?.country as string | undefined) ?? null,
        name: body.name,
        // A bare 10-digit number takes the listing's country code when the form
        // did not say — a US listing's leads were being stored as +91.
        phone,
        email: body.email || null,
        petType: body.petType ?? null,
        preferredDate,
        notes: body.notes ?? '',
        source: body.source ?? 'api',
      },
    });

    logger.info({ id: enquiry.id, source: enquiry.source }, 'enquiry.created');
    // An enquired listing drops out of this parent's recommendations.
    if (petParentId) invalidateParent(petParentId);

    // Acknowledge to the parent, when they left an address. A marketing-page
    // lead is a business asking Pets24x7 to promote it: its listingName is the
    // sender's own business, so "your enquiry reached <their own name>" was
    // wrong — it reached the Pets24x7 team.
    const isMarketingLead = (enquiry.source ?? '').startsWith('marketing');
    notifyIf(enquiry.email, (to) =>
      enquiryReceivedEmail(to, enquiry.name, isMarketingLead ? null : enquiry.listingName),
    );

    // Best-effort: nudge the claimed vendor for this listing, on WhatsApp and email.
    const targetListingId = enquiry.listingId;
    if (targetListingId) {
      prisma.vendor
        .findUnique({
          where: { listingId: targetListingId },
          select: { id: true, email: true, businessName: true, status: true, claimedAt: true },
        })
        .then((v) => {
          // A customer's phone number goes only to an approved business that
          // has actually completed its claim. A suspended or rejected claimant
          // keeps its listingId, and a PENDING one has not been verified as the
          // owner yet — neither has any business receiving it.
          if (!v || !v.claimedAt || !isVendorApproved(v.status)) return;
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
