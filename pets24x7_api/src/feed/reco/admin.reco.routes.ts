// Admin controls for recommendations and sponsored placement — mounted at
// /api/admin/reco.
//
//   GET  /config        current knobs + defaults
//   PUT  /config        validated partial update (audited 'reco.config.update')
//   POST /rebuild       fresh signals snapshot + insights, drops cached results
//   GET  /insights      action center: approvals, nudges, upsell, trends, featured, campaigns
//   POST /nudge         one-click promo mail to a vendor (audited 'reco.nudge')
//   GET  /performance   impressions / clicks / CTR from RecoStatDaily

import { Router, type Request } from 'express';
import { z } from 'zod';

import { prisma } from '../../db.js';
import { requireAuth } from '../../auth/middleware.js';
import { asyncHandler } from '../../shared/async-handler.js';
import { NotFoundError } from '../../shared/errors.js';
import { env } from '../../env.js';
import { getListingById, shownRating } from '../../listings/index.js';
import { notify } from '../../mail/notify.js';
import { isOptedOut } from '../../mail/optout.js';
import type { MailInput } from '../../mail/mailer.js';
import {
  vendorCollectReviewsEmail,
  vendorOpenEnquiriesEmail,
  vendorProfileGapsEmail,
  vendorVisibilityEmail,
  type VendorPromoContext,
} from '../../mail/promo-templates.js';
import { featuredExpiringEmail } from '../../mail/lifecycle-templates.js';
import { invalidateAllResults } from './cache.js';
import { getRecoConfigMeta, RECO_DEFAULTS, saveRecoConfig } from './config.js';
import { getAdminInsights, recomputeAdminInsights } from './admin-insights.js';
import { cityListings } from './city-index.js';
import { rebuildReco } from './service.js';
import { DAY_MS, dayDate, ymd } from './util.js';

export const adminRecoRouter = Router();
adminRecoRouter.use(requireAuth('admin'));

async function audit(req: Request, action: string, meta: object): Promise<void> {
  await prisma.auditLog
    .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action, meta, ipAddress: req.ip ?? null } })
    .catch(() => {});
}

// ---- Config ----
adminRecoRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const meta = await getRecoConfigMeta();
    res.json({
      ok: true,
      config: meta.config,
      defaults: RECO_DEFAULTS,
      updatedAt: meta.updatedAt ? meta.updatedAt.toISOString() : null,
      updatedBy: meta.updatedBy,
    });
  }),
);

adminRecoRouter.put(
  '/config',
  asyncHandler(async (req, res) => {
    // Body is a deep partial; saveRecoConfig merges it and validates the whole
    // result (ZodError → 400 validation_failed with issues[]).
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { version: _v, ...patch } = body as Record<string, unknown>;
    const config = await saveRecoConfig(patch, req.auth!.sub);
    invalidateAllResults();
    await audit(req, 'reco.config.update', { keys: Object.keys(patch) });
    res.json({ ok: true, config });
  }),
);

// ---- Rebuild ----
adminRecoRouter.post(
  '/rebuild',
  asyncHandler(async (req, res) => {
    const out = await rebuildReco();
    void recomputeAdminInsights().catch(() => {});
    await audit(req, 'reco.rebuild', { featuredLive: out.featuredLive });
    res.json({ ok: true, ...out });
  }),
);

// ---- Insights ----
const SECTIONS = ['all', 'approvals', 'nudges', 'upsell', 'trends', 'featured', 'campaigns'] as const;
const InsightsQuery = z.object({
  section: z.enum(SECTIONS).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(40).optional(),
});

adminRecoRouter.get(
  '/insights',
  asyncHandler(async (req, res) => {
    const q = InsightsQuery.parse(req.query);
    const section = q.section ?? 'all';
    const limit = q.limit ?? 20;
    const data = await getAdminInsights();
    const offset = (() => {
      if (!q.cursor) return 0;
      const n = Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      return Number.isInteger(n) && n >= 0 ? n : 0;
    })();

    const page = <T,>(list: T[], name: (typeof SECTIONS)[number]) => {
      if (section === 'all') return list.slice(0, limit);
      if (section !== name) return [];
      return list.slice(offset, offset + limit);
    };
    const listFor: Record<string, unknown[]> = {
      approvals: data.approvals,
      nudges: data.nudges,
      upsell: data.upsell,
      featured: data.featured,
      campaigns: data.campaigns,
    };
    const current = listFor[section];
    const nextCursor =
      section !== 'all' && current && offset + limit < current.length
        ? Buffer.from(String(offset + limit), 'utf8').toString('base64url')
        : null;

    res.json({
      ok: true,
      generatedAt: data.generatedAt,
      approvals: page(data.approvals, 'approvals'),
      nudges: page(data.nudges, 'nudges'),
      upsell: page(data.upsell, 'upsell'),
      trends:
        section === 'all' || section === 'trends'
          ? {
              windowDays: data.trends.windowDays,
              cities: data.trends.cities.slice(0, limit),
              categories: data.trends.categories.slice(0, limit),
              supplyGaps: data.trends.supplyGaps.slice(0, limit),
            }
          : { windowDays: 7, cities: [], categories: [], supplyGaps: [] },
      // The featured table joins every row by featuredId, so it is not paged in 'all'.
      featured: section === 'all' ? data.featured : page(data.featured, 'featured'),
      campaigns: page(data.campaigns, 'campaigns'),
      nextCursor,
    });
  }),
);

// ---- Nudge ----
const NudgeBody = z.object({
  vendorId: z.string().min(1).max(191),
  kind: z.enum(['open_enquiries', 'profile_gaps', 'collect_reviews', 'visibility', 'featured_renewal']),
});

const NUDGE_GAP_MS = 20 * 3600 * 1000;

adminRecoRouter.post(
  '/nudge',
  asyncHandler(async (req, res) => {
    const { vendorId, kind } = NudgeBody.parse(req.body);
    const v = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        id: true,
        businessName: true,
        email: true,
        emailVerified: true,
        city: true,
        listingId: true,
        imageUrl: true,
        about: true,
        servicesList: true,
        openingHours: true,
        lastMarketingAt: true,
      },
    });
    if (!v) throw new NotFoundError('Vendor not found');

    const reply = async (sent: boolean, reason?: 'no_email' | 'opted_out' | 'recently_mailed' | 'nothing_to_say') => {
      await audit(req, 'reco.nudge', { vendorId, kind, sent, reason: reason ?? null });
      res.json({ ok: true, sent, ...(reason ? { reason } : {}) });
    };

    // Marketing mail goes only to a confirmed address.
    if (!v.email || !v.emailVerified) return reply(false, 'no_email');
    if (await isOptedOut(v.email).catch(() => true)) return reply(false, 'opted_out');
    if (v.lastMarketingAt && Date.now() - v.lastMarketingAt.getTime() < NUDGE_GAP_MS) return reply(false, 'recently_mailed');

    const listing = v.listingId ? getListingById(v.listingId) : undefined;
    const site = env.PUBLIC_SITE_URL.replace(/\/+$/, '');
    const ctx: VendorPromoContext = {
      businessName: v.businessName,
      city: v.city ?? listing?.city ?? null,
      listingUrl: listing ? `${site}/${String(listing.country).toLowerCase()}/${listing.city_slug}/${listing.id}/` : null,
      rating: listing ? shownRating(listing) || null : null,
      reviewCount: listing?.review_count ?? null,
    };

    let mail: MailInput | null = null;
    if (kind === 'open_enquiries') {
      const open = await prisma.enquiry
        // Same scope as the vendor's own insights: its listing, or a name-only
        // enquiry with no listing. Matching the name alone also counted other
        // branches of a chain that happen to share it.
        .count({
          where: {
            status: 'NEW',
            OR: [
              { listingId: v.listingId ?? '__none__' },
              { listingId: null, listingName: v.businessName, OR: [{ source: null }, { NOT: { source: { startsWith: 'marketing' } } }] },
            ],
          },
        })
        .catch(() => 0);
      if (open > 0) mail = vendorOpenEnquiriesEmail(v.email, ctx, open);
    } else if (kind === 'profile_gaps') {
      const gaps: string[] = [];
      if (!v.imageUrl) gaps.push('A storefront photo — the first thing anyone sees');
      if (!v.about) gaps.push('A short description of what you do');
      if (!v.servicesList) gaps.push('The services you offer');
      if (!v.openingHours) gaps.push('Your opening hours');
      if (gaps.length) mail = vendorProfileGapsEmail(v.email, ctx, gaps);
    } else if (kind === 'collect_reviews') {
      mail = vendorCollectReviewsEmail(v.email, ctx);
    } else if (kind === 'visibility') {
      const n = ctx.city ? cityListings(ctx.city, String(listing?.country ?? '')).length : 0;
      // Same honesty rule as the sweep: no placement pitch without competition.
      if (n >= 10) mail = vendorVisibilityEmail(v.email, ctx, n);
    } else if (kind === 'featured_renewal') {
      const now = new Date();
      const active = await prisma.featuredListing
        .findFirst({
          where: { vendorId, status: 'ACTIVE', endsAt: { gt: now }, OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          orderBy: { endsAt: 'desc' },
          select: { endsAt: true },
        })
        .catch(() => null);
      if (active?.endsAt) {
        const days = Math.max(1, Math.ceil((active.endsAt.getTime() - now.getTime()) / DAY_MS));
        mail = { ...featuredExpiringEmail(v.email, v.businessName, active.endsAt, days), kind: 'marketing' };
      }
    }
    if (!mail) return reply(false, 'nothing_to_say');

    // Same conditional stamp as vendor-engagement.ts: only one of two racing
    // nudges (or a nudge racing the sweep) can claim the slot.
    const gapBefore = new Date(Date.now() - NUDGE_GAP_MS);
    const { count } = await prisma.vendor.updateMany({
      where: { id: vendorId, OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lt: gapBefore } }] },
      data: { lastMarketingAt: new Date(), lastPromoKind: kind === 'featured_renewal' ? 'featured_renewal' : kind },
    });
    if (count !== 1) return reply(false, 'recently_mailed');
    notify({ ...mail, kind: 'marketing' });
    return reply(true);
  }),
);

// ---- Performance ----
const PerfQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  surface: z.string().max(32).optional(),
  variant: z.enum(['A', 'B']).optional(),
});

type Sum = { _sum: { impressions: number | null; clicks: number | null } };
const ctr = (imp: number, clk: number) => (imp > 0 ? Math.round((clk / imp) * 10000) / 10000 : 0);

adminRecoRouter.get(
  '/performance',
  asyncHandler(async (req, res) => {
    const q = PerfQuery.parse(req.query);
    const days = q.days ?? 7;
    const toKey = ymd(new Date());
    const fromKey = ymd(new Date(Date.now() - (days - 1) * DAY_MS));
    const where = {
      day: { gte: dayDate(fromKey), lte: dayDate(toKey) },
      ...(q.surface ? { surface: q.surface } : {}),
      ...(q.variant ? { variant: q.variant } : {}),
    };
    const groupBy = prisma.recoStatDaily.groupBy as unknown as (a: unknown) => Promise<unknown>;
    const run = async <K extends string>(by: K[], extra: object = {}) => {
      try {
        return (await groupBy({ by, where, _sum: { impressions: true, clicks: true }, ...extra })) as Array<Record<K, any> & Sum>;
      } catch {
        return [] as Array<Record<K, any> & Sum>;
      }
    };
    const top = { orderBy: { _sum: { impressions: 'desc' } }, take: 20 };
    const [bySurface, byReason, bySponsored, byVariant, byListing, byFeatured] = await Promise.all([
      run(['surface']),
      run(['reason']),
      run(['sponsored']),
      run(['variant']),
      run(['listingId'], top),
      run(['featuredId', 'listingId'], { ...top, where: { ...where, sponsored: true, featuredId: { not: null } } }),
    ]);
    const shape = <T extends Sum>(rows: T[]) =>
      rows.map((r) => {
        const imp = r._sum.impressions ?? 0;
        const clk = r._sum.clicks ?? 0;
        const { _sum: _s, ...rest } = r as T & Record<string, unknown>;
        return { ...rest, impressions: imp, clicks: clk, ctr: ctr(imp, clk) };
      });
    const totals = bySurface.reduce(
      (a, r) => ({ impressions: a.impressions + (r._sum.impressions ?? 0), clicks: a.clicks + (r._sum.clicks ?? 0) }),
      { impressions: 0, clicks: 0 },
    );
    res.json({
      ok: true,
      from: fromKey,
      to: toKey,
      totals: { ...totals, ctr: ctr(totals.impressions, totals.clicks) },
      bySurface: shape(bySurface).sort((a, b) => b.impressions - a.impressions),
      byReason: shape(byReason).sort((a, b) => b.impressions - a.impressions),
      sponsoredVsOrganic: shape(bySponsored),
      byVariant: shape(byVariant),
      topListings: shape(byListing).map((r) => ({ ...r, name: getListingById(String(r.listingId))?.name ?? null })),
      featured: shape(byFeatured).map((r) => ({ ...r, name: getListingById(String(r.listingId))?.name ?? null })),
    });
  }),
);
