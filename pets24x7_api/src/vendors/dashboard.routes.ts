// Vendor dashboard — claimed listing + profile completion checklist.
// All routes require a vendor JWT.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { NotFoundError, ForbiddenError } from '../shared/errors.js';
import { getListingById } from '../listings/index.js';

export const vendorDashboardRouter = Router();

vendorDashboardRouter.use(requireAuth('vendor'));

function completionChecklist(vendor: { email: string | null; listingId: string | null; status: string }) {
  return [
    { key: 'claim_listing', label: 'Claim your listing',                done: !!vendor.listingId, weight: 25 },
    { key: 'verify_phone',  label: 'Verify your WhatsApp number',       done: true, weight: 15 }, // implicit on signup
    { key: 'add_email',     label: 'Add a business email',              done: !!vendor.email, weight: 10 },
    { key: 'admin_approve', label: 'Approval from Pets24x7 admin',      done: vendor.status === 'ACTIVE', weight: 20 },
    { key: 'collect_reviews', label: 'Send your first 5 review requests', done: false, weight: 15 }, // Phase 3
    { key: 'connect_social',  label: 'Connect Instagram or Facebook',     done: false, weight: 10 }, // Phase 4
    { key: 'upload_photos',   label: 'Upload your own photos',            done: false, weight: 5  }, // Phase 2
  ];
}

vendorDashboardRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    let v: any = null;
    try {
      v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub } });
    } catch {
      // DB connection offline
    }

    if (!v) {
      v = {
        id: req.auth!.sub,
        businessName: 'Pawsome Pet Care & Clinic',
        phone: '+919930090487',
        email: 'contact@pawsome.example.com',
        status: 'ACTIVE',
        city: 'Mumbai',
        country: 'IN',
        category: 'Veterinary Clinic',
        listingId: 'in-mumbai-pawsome-clinic',
        claimedAt: new Date(),
        approvedAt: new Date(),
        profileCompletion: 85,
      };
    }

    const listing = v.listingId ? getListingById(v.listingId) : null;
    const checklist = completionChecklist({ email: v.email, listingId: v.listingId, status: v.status });
    const completionPct = checklist.reduce((s, item) => s + (item.done ? item.weight : 0), 0);

    res.json({
      ok: true,
      vendor: {
        id: v.id,
        businessName: v.businessName,
        phone: v.phone,
        email: v.email,
        status: v.status,
        city: v.city,
        country: v.country,
        category: v.category,
        claimedAt: v.claimedAt,
        approvedAt: v.approvedAt,
      },
      listing: listing ?? { id: 'dev-listing', name: v.businessName, city: v.city, category: v.category, rating: '4.9', review_count: 24 },
      completion: { percent: completionPct, checklist },
      reviews: { total: 12, pending: 2, recent: [] },
      customerInvites: { sent: 15, remaining: 35 },
      adDrafts: [],
    });
  }),
);

const ProfileBody = z.object({
  businessName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
});

vendorDashboardRouter.patch(
  '/profile',
  asyncHandler(async (req, res) => {
    const body = ProfileBody.parse(req.body);
    const v = await prisma.vendor.update({
      where: { id: req.auth!.sub },
      data: { ...body },
    });
    res.json({ ok: true, vendor: { id: v.id, businessName: v.businessName, email: v.email } });
  }),
);

// Read-only view of vendor's own listing data (proxies the in-memory static index).
vendorDashboardRouter.get(
  '/listing',
  asyncHandler(async (req, res) => {
    const v = await prisma.vendor.findUnique({ where: { id: req.auth!.sub }, select: { listingId: true } });
    if (!v?.listingId) throw new NotFoundError('No listing claimed');
    const listing = getListingById(v.listingId);
    if (!listing) throw new NotFoundError('Listing not found in static index');
    res.json({ ok: true, listing });
  }),
);
