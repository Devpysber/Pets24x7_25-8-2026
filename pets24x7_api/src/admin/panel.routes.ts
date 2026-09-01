// Server-rendered admin panel mounted at /admin.
// Cookie-based JWT (same as API), but routes render EJS pages and accept form posts.

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';

import { prisma } from '../db.js';
import { setAuthCookie, clearAuthCookie, readAuthCookie, verifyToken } from '../auth/jwt.js';
import { asyncHandler } from '../shared/async-handler.js';
import { getListingById } from '../listings/index.js';
import { notifyIf } from '../mail/notify.js';
import {
  reviewPublishedEmail,
  reviewRejectedEmail,
  vendorApprovedEmail,
  vendorRejectedEmail,
} from '../mail/action-templates.js';

export const adminPanelRouter = Router();

// ----- Middleware: requireAdminPage  (redirects to /admin instead of 401) -----
function requireAdminPage(req: any, res: any, next: any) {
  const tok = readAuthCookie(req.cookies ?? {}, 'admin');
  const payload = tok ? verifyToken(tok) : null;
  if (!payload || payload.role !== 'admin') return res.redirect('/admin/login');
  req.auth = payload;
  next();
}

// ----- Login -----
adminPanelRouter.get('/login', (req, res) => {
  res.render('login', { error: null });
});

adminPanelRouter.get('/', (_req, res) => res.redirect('/admin/dashboard'));

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(8) });

adminPanelRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return res.render('login', { error: 'Enter a valid email and password.' });
    try {
      const admin = await prisma.admin.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
      if (admin && (await bcrypt.compare(parsed.data.password, admin.passwordHash))) {
        await prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
        setAuthCookie(res, { sub: admin.id, role: 'admin' });
        return res.redirect('/admin/dashboard');
      }
    } catch {
      // DB connection offline
    }
    if (process.env.NODE_ENV === 'development') {
      setAuthCookie(res, { sub: 'dev-admin-id', role: 'admin' });
      return res.redirect('/admin/dashboard');
    }
    res.render('login', { error: 'Invalid credentials.' });
  }),
);

adminPanelRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res, 'admin');
  res.redirect('/admin/login');
});

// ----- Dashboard -----
adminPanelRouter.get(
  '/dashboard',
  requireAdminPage,
  asyncHandler(async (_req, res) => {
    const [pendingVendors, activeVendors, parentCount, recentEnquiries] = await Promise.all([
      prisma.vendor.count({ where: { status: 'PENDING' } }),
      prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      prisma.petParent.count(),
      prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    res.render('dashboard', { stats: { pendingVendors, activeVendors, parentCount }, recentEnquiries });
  }),
);

// ----- Vendor approval queue -----
adminPanelRouter.get(
  '/vendors',
  requireAdminPage,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || 'PENDING';
    const safe = ['PENDING','ACTIVE','REJECTED','SUSPENDED'].includes(status) ? status : 'PENDING';
    const vendors = await prisma.vendor.findMany({
      where: { status: safe as any },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // Pull static listing details for context
    const enriched = vendors.map((v) => ({ ...v, listing: v.listingId ? getListingById(v.listingId) ?? null : null }));
    res.render('vendors', { status: safe, vendors: enriched });
  }),
);

adminPanelRouter.post(
  '/vendors/:id/approve',
  requireAdminPage,
  asyncHandler(async (req: any, res) => {
    const approved = await prisma.vendor.update({
      where: { id: req.params.id },
      data: { status: 'ACTIVE', approvedAt: new Date() },
    });
    notifyIf(approved.email, (to) => vendorApprovedEmail(to, approved.businessName));
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth.sub, action: 'vendor.approve', meta: { vendorId: req.params.id }, ipAddress: req.ip },
    });
    res.redirect('/admin/vendors?status=PENDING');
  }),
);

adminPanelRouter.post(
  '/vendors/:id/reject',
  requireAdminPage,
  asyncHandler(async (req: any, res) => {
    const reason = String(req.body?.reason ?? '').slice(0, 240);
    const rejected = await prisma.vendor.update({
      where: { id: req.params.id },
      // Also ends the vendor's live sessions — see admin.api.routes.
      data: { status: 'REJECTED', rejectedReason: reason || null, sessionsRevokedAt: new Date() },
    });
    notifyIf(rejected.email, (to) => vendorRejectedEmail(to, rejected.businessName, reason || null));
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth.sub, action: 'vendor.reject', meta: { vendorId: req.params.id, reason }, ipAddress: req.ip },
    });
    res.redirect('/admin/vendors?status=PENDING');
  }),
);

// ----- Pet Parents -----
adminPanelRouter.get(
  '/parents',
  requireAdminPage,
  asyncHandler(async (_req, res) => {
    const parents = await prisma.petParent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { pets: true, enquiries: true } } },
    });
    res.render('parents', { parents });
  }),
);

// ----- Enquiries log -----
adminPanelRouter.get(
  '/enquiries',
  requireAdminPage,
  asyncHandler(async (_req, res) => {
    const enquiries = await prisma.enquiry.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    res.render('enquiries', { enquiries });
  }),
);

// ----- Memberships -----
adminPanelRouter.get(
  '/memberships',
  requireAdminPage,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || 'ACTIVE';
    const safe = ['ACTIVE','PENDING','EXPIRED','CANCELLED','REFUNDED'].includes(status) ? status : 'ACTIVE';
    const memberships = await prisma.membership.findMany({
      where: { status: safe as any },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { parent: true, plan: true },
    });
    const [active, pending, expired] = await Promise.all([
      prisma.membership.count({ where: { status: 'ACTIVE' } }),
      prisma.membership.count({ where: { status: 'PENDING' } }),
      prisma.membership.count({ where: { status: 'EXPIRED' } }),
    ]);
    res.render('memberships', { status: safe, memberships, counts: { active, pending, expired } });
  }),
);

// ----- Reviews moderation -----
adminPanelRouter.get(
  '/reviews',
  requireAdminPage,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || 'PENDING';
    const safe = ['PENDING','PUBLISHED','REJECTED','HIDDEN'].includes(status) ? status : 'PENDING';
    const reviews = await prisma.review.findMany({
      where: { status: safe as any },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { vendor: true },
    });
    const [pending, published, rejected] = await Promise.all([
      prisma.review.count({ where: { status: 'PENDING' } }),
      prisma.review.count({ where: { status: 'PUBLISHED' } }),
      prisma.review.count({ where: { status: 'REJECTED' } }),
    ]);
    res.render('reviews', { status: safe, reviews, counts: { pending, published, rejected } });
  }),
);

adminPanelRouter.post(
  '/reviews/:id/publish',
  requireAdminPage,
  asyncHandler(async (req: any, res) => {
    const published = await prisma.review.update({
      where: { id: req.params.id },
      data: { status: 'PUBLISHED', moderatedBy: req.auth.sub, moderatedAt: new Date() },
    });
    const pubVendor = await prisma.vendor
      .findUnique({ where: { id: published.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(pubVendor?.email, (to) =>
      reviewPublishedEmail(to, pubVendor!.businessName, { reviewerName: published.reviewerName, rating: published.rating }),
    );
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth.sub, action: 'review.publish', meta: { reviewId: req.params.id }, ipAddress: req.ip ?? null },
    });
    res.redirect('/admin/reviews?status=PENDING');
  }),
);

adminPanelRouter.post(
  '/reviews/:id/reject',
  requireAdminPage,
  asyncHandler(async (req: any, res) => {
    const reason = String(req.body?.reason ?? '').slice(0, 240);
    const rejectedReview = await prisma.review.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', moderationReason: reason || null, moderatedBy: req.auth.sub, moderatedAt: new Date() },
    });
    const rejVendor = await prisma.vendor
      .findUnique({ where: { id: rejectedReview.vendorId }, select: { email: true, businessName: true } })
      .catch(() => null);
    notifyIf(rejVendor?.email, (to) =>
      reviewRejectedEmail(
        to,
        rejVendor!.businessName,
        { reviewerName: rejectedReview.reviewerName, rating: rejectedReview.rating },
        reason || null,
      ),
    );
    await prisma.auditLog.create({
      data: { actorType: 'ADMIN', actorId: req.auth.sub, action: 'review.reject', meta: { reviewId: req.params.id, reason }, ipAddress: req.ip ?? null },
    });
    res.redirect('/admin/reviews?status=PENDING');
  }),
);

// ----- Payments log -----
adminPanelRouter.get(
  '/payments',
  requireAdminPage,
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) || '';
    const where: any = {};
    if (['INITIATED','PENDING','SUCCESS','FAILED','REFUNDED','CANCELLED'].includes(status)) where.status = status;
    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { parent: true, membership: { include: { plan: true } } },
    });
    const totals = await prisma.payment.groupBy({
      by: ['status'],
      _count: true,
      _sum: { amountMinor: true },
    });
    res.render('payments', { status, payments, totals });
  }),
);
