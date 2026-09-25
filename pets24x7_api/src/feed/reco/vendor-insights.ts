// Vendor growth insights — GET /api/reco/vendor.
//
// What a business should do next, in priority order, each backed by a number
// from its own account and a benchmark from public data only (Google ratings
// and review counts, anonymised medians, and the top three competitors that
// already appear on the public city page). Boost is offered only where it is
// honest: an approved, claimed, reasonably complete listing in a city+category
// with real competition — the same rule vendor-engagement.ts uses.

import type { Prisma } from '@prisma/client';

import { prisma } from '../../db.js';
import { profileCompletion, type LegacyMissing } from '../../vendors/profile-completion.js';
import { getListingById, shownRating, type ListingRecord } from '../../listings/index.js';
import { getFeaturedOptions } from '../../payments/pricing.js';
import { isVendorApproved } from '../../shared/vendor-status.js';
import { genKey, invalidateVendor, recoCache } from './cache.js';
import { getRecoConfig, type RecoConfig } from './config.js';
import { indexVersion } from './city-index.js';
import { categoryRanked, cityDerived } from './engine.js';
import { ensureSignals, type Snapshot } from './signals.js';
import { CONTACT_KINDS, DAY_MS, median, ymd } from './util.js';

export type VendorActionId =
  | 'claim_listing'
  | 'respond_enquiries'
  | 'verify_email'
  | 'complete_profile'
  | 'add_photos'
  | 'add_services'
  | 'request_reviews'
  | 'reply_reviews'
  | 'renew_featured'
  | 'boost_featured'
  | 'start_campaign';

export interface VendorAction {
  id: VendorActionId;
  priority: number;
  severity: 'urgent' | 'recommended' | 'opportunity';
  title: string;
  body: string;
  metric?: { label: string; value: number | string; benchmark?: number | string };
  suggestions?: string[];
  cta: { label: string; view?: string; href?: string };
}

type Missing = LegacyMissing;

/** Service names typical for a category, offered as one-click chips. */
const TYPICAL_SERVICES: Record<string, string[]> = {
  'pet-grooming-spa': ['Full grooming', 'Bath & blow-dry', 'Nail trimming', 'Ear cleaning', 'De-shedding treatment'],
  'veterinary-clinics': ['General consultation', 'Vaccination', 'Deworming', 'Annual health check-up', 'Microchipping'],
  'pet-boarding-daycare': ['Overnight boarding', 'Day care', 'Pick-up & drop', 'Weekend stay'],
  'pet-training-obedience-behavior': ['Puppy training', 'Obedience training', 'Behaviour correction', 'Leash training'],
  'pet-walking': ['30-minute walk', '60-minute walk', 'Group walk', 'Monthly walk plan'],
  'pet-sitting-in-home-care': ['In-home visit', 'Overnight sitting', 'Feeding visit', 'Medication visit'],
  'vaccination-centers': ['Rabies vaccine', 'Core vaccine (DHPPi)', 'Booster shot', 'Vaccination certificate'],
  'emergency-animal-hospital': ['24x7 emergency care', 'Surgery', 'ICU care', 'X-ray & diagnostics'],
  'pet-dental-care': ['Dental cleaning', 'Scaling & polishing', 'Tooth extraction'],
  'pet-physiotherapy-rehab': ['Physiotherapy session', 'Hydrotherapy', 'Post-surgery rehab'],
  'specialty-vets-exotics-avian-reptiles': ['Exotic pet consultation', 'Avian check-up', 'Reptile care'],
};
const DEFAULT_SERVICES = ['Consultation', 'Home visit', 'Package deal'];

function listingPath(l: ListingRecord): string {
  return `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`;
}

// ---------------------------------------------------------------------------
// City + category benchmark (public data), cached 30 min.
// ---------------------------------------------------------------------------

export interface Benchmark {
  city: string;
  category: string;
  categorySlug: string;
  ids: string[];
  base: Record<string, number>;
  medians: { rating: number | null; reviews: number; views: number; taps: number; conversion: number | null };
}

export async function cityCategoryBenchmark(
  l: ListingRecord,
  config: RecoConfig,
  snap: Snapshot,
): Promise<Benchmark> {
  const cc = String(l.country || 'IN').toUpperCase();
  const city = l.city_slug || l.city;
  return recoCache.wrap(await genKey(`bench:${cc}:${city}:${l.category_slug}:${indexVersion()}:${snap.version}`), 1800, async () => {
    const d = cityDerived(city, cc, config.weights, config, snap);
    const list = categoryRanked(d, city, cc, l.category_slug);
    const conv: number[] = [];
    for (const x of list) {
      const v = snap.views30d.get(x.id) ?? 0;
      if (v >= 10) conv.push((snap.taps30d.get(x.id) ?? 0) / v);
    }
    const base: Record<string, number> = {};
    for (const x of list) base[x.id] = d.base.get(x.id) ?? 0;
    return {
      city: l.city,
      category: l.category,
      categorySlug: l.category_slug,
      ids: list.map((x) => x.id),
      base,
      medians: {
        rating: median(list.map((x) => shownRating(x)).filter((r) => r > 0)),
        reviews: median(list.map((x) => Number(x.review_count) || 0)) ?? 0,
        views: median(list.map((x) => snap.views30d.get(x.id) ?? 0)) ?? 0,
        taps: median(list.map((x) => snap.taps30d.get(x.id) ?? 0)) ?? 0,
        conversion: median(conv),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

function enquiryScope(v: { listingId: string | null; businessName: string }): Prisma.EnquiryWhereInput | null {
  if (!v.listingId) return null;
  const or: Prisma.EnquiryWhereInput[] = [{ listingId: v.listingId }];
  if (v.businessName) {
    or.push({
      listingId: null,
      listingName: v.businessName,
      OR: [{ source: null }, { NOT: { source: { startsWith: 'marketing' } } }],
    });
  }
  return { OR: or };
}

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

export async function vendorInsights(vendorId: string): Promise<Record<string, unknown>> {
  const config = await getRecoConfig();
  const key = await genKey(`vendor:${vendorId}`, [`vendor:${vendorId}`]);
  const res = await recoCache.wrap(key, config.cacheTtlSec.vendor, () => compute(vendorId, config));
  // An unclaimed vendor is not cached: the moment they claim, they should see it.
  if (!res.performance) recoCache.del(key);
  return res;
}

/** Drops a vendor's cached insights (after a profile edit, a reply, a purchase). */
export function invalidateVendorInsights(vendorId: string): void {
  invalidateVendor(vendorId);
}

async function compute(vendorId: string, config: RecoConfig): Promise<Record<string, unknown>> {
  const v = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      businessName: true,
      email: true,
      emailVerified: true,
      status: true,
      listingId: true,
      city: true,
      category: true,
      imageUrl: true,
      galleryImages: true,
      about: true,
      servicesList: true,
      openingHours: true,
      website: true,
      whatsapp: true,
      claimedAt: true,
    },
  });
  const generatedAt = new Date().toISOString();
  if (!v || !v.listingId) {
    return {
      ok: true,
      generatedAt,
      completeness: null,
      actions: [
        {
          id: 'claim_listing',
          priority: 100,
          severity: 'urgent',
          title: 'Claim your listing',
          body: 'Claim your business page to receive enquiries, see how many pet owners view it, and compare with others in your city.',
          cta: { label: 'Find my listing', href: '/find-my-listing/' },
        } satisfies VendorAction,
      ],
      performance: null,
      benchmark: null,
      featured: null,
    };
  }

  const snap = await ensureSignals();
  const listing = getListingById(v.listingId) ?? null;
  const now = new Date();
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const scope = enquiryScope({ listingId: v.listingId, businessName: v.businessName });
  const reviewScope: Prisma.ReviewWhereInput = { OR: [{ vendorId }, { listingId: v.listingId, vendorId: null }] };

  const [activity, enquiries, openEnquiries, recoStats, serviceCount, unreplied, featuredRows, liveCampaigns, reviewCount] = await Promise.all([
    prisma.listingActivity
      .findMany({
        where: { listingId: v.listingId, createdAt: { gte: since } },
        select: { kind: true, createdAt: true },
        take: 20000,
      })
      .catch(() => [] as Array<{ kind: string; createdAt: Date }>),
    scope
      ? prisma.enquiry
          .findMany({ where: { AND: [scope, { createdAt: { gte: since } }] }, select: { createdAt: true }, take: 5000 })
          .catch(() => [] as Array<{ createdAt: Date }>)
      : Promise.resolve([] as Array<{ createdAt: Date }>),
    scope ? prisma.enquiry.count({ where: { AND: [scope, { status: 'NEW' }] } }).catch(() => 0) : Promise.resolve(0),
    (async () => {
      try {
        const groupBy = prisma.recoStatDaily.groupBy as unknown as (a: unknown) => Promise<unknown>;
        return (await groupBy({
          by: ['sponsored'],
          where: { listingId: v.listingId, day: { gte: new Date(`${ymd(since)}T00:00:00.000Z`) } },
          _sum: { impressions: true, clicks: true },
        })) as Array<{ sponsored: boolean; _sum: { impressions: number | null; clicks: number | null } }>;
      } catch {
        return [];
      }
    })(),
    prisma.service.count({ where: { vendorId } }).catch(() => 0),
    prisma.review
      .count({ where: { AND: [reviewScope, { status: 'PUBLISHED', vendorReply: null }] } })
      .catch(() => 0),
    prisma.featuredListing
      .findMany({
        where: { vendorId, status: 'ACTIVE', endsAt: { gt: now } },
        select: { id: true, startsAt: true, endsAt: true },
        orderBy: { endsAt: 'asc' },
        take: 10,
      })
      .catch(() => [] as Array<{ id: string; startsAt: Date | null; endsAt: Date | null }>),
    prisma.marketingCampaign
      .count({ where: { vendorId, status: { in: ['ACTIVE', 'PENDING_REVIEW'] } } })
      .catch(() => 0),
    prisma.review.count({ where: reviewScope }).catch(() => 0),
  ]);

  // ---- Completeness ----
  // Shared with /api/vendor/dashboard (vendors/profile-completion.ts): the two
  // screens used to disagree (70% vs 25%) for the same vendor.
  const completion = profileCompletion({
    ...v,
    listingWebsite: listing?.website ?? null,
    serviceCount,
    hasReviews: reviewCount > 0,
  });
  const percent = completion.percent;
  const missing: Missing[] = completion.missing;

  // ---- Performance ----
  const taps = { phone: 0, whatsapp: 0, website: 0, total: 0 };
  let views = 0;
  const daily = new Map<string, { day: string; views: number; taps: number; enquiries: number }>();
  for (let i = 29; i >= 0; i--) {
    const k = ymd(new Date(now.getTime() - i * DAY_MS));
    daily.set(k, { day: k, views: 0, taps: 0, enquiries: 0 });
  }
  for (const a of activity) {
    const cell = daily.get(ymd(a.createdAt));
    if (a.kind === 'listing_view') {
      views++;
      if (cell) cell.views++;
    } else if (CONTACT_KINDS.includes(a.kind)) {
      if (a.kind === 'phone_click') taps.phone++;
      else if (a.kind === 'whatsapp_click') taps.whatsapp++;
      else taps.website++;
      taps.total++;
      if (cell) cell.taps++;
    }
  }
  for (const e of enquiries) {
    const cell = daily.get(ymd(e.createdAt));
    if (cell) cell.enquiries++;
  }
  const organicStats = recoStats.find((r) => !r.sponsored)?._sum;
  const sponsoredStats = recoStats.find((r) => r.sponsored)?._sum;
  const performance = {
    windowDays: 30,
    views,
    taps,
    enquiries: enquiries.length,
    recoImpressions: (organicStats?.impressions ?? 0) + (sponsoredStats?.impressions ?? 0),
    recoClicks: (organicStats?.clicks ?? 0) + (sponsoredStats?.clicks ?? 0),
    sponsoredImpressions: sponsoredStats?.impressions ?? 0,
    sponsoredClicks: sponsoredStats?.clicks ?? 0,
    daily: [...daily.values()],
  };

  // ---- Benchmark ----
  let benchmark: Record<string, unknown> | null = null;
  let bench: Benchmark | null = null;
  if (listing) {
    bench = await cityCategoryBenchmark(listing, config, snap);
    const at = bench.ids.indexOf(listing.id);
    const tenth = bench.ids[9];
    const competitors = bench.ids
      .filter((id) => id !== listing.id)
      .slice(0, 3)
      .map((id) => getListingById(id))
      .filter((x): x is ListingRecord => !!x)
      .map((c) => ({
        name: c.name,
        rating: shownRating(c),
        review_count: Number(c.review_count) || 0,
        url: listingPath(c),
        featured: snap.featuredLive.has(c.id),
      }));
    benchmark = {
      city: listing.city,
      category: listing.category,
      listings: bench.ids.length,
      yourRank: at >= 0 ? at + 1 : null,
      top10Threshold: tenth ? round(bench.base[tenth] ?? 0) : null,
      rating: { you: shownRating(listing) || null, median: bench.medians.rating != null ? round(bench.medians.rating) : null },
      reviews: { you: Number(listing.review_count) || 0, median: Math.round(bench.medians.reviews) },
      views30d: { you: views, median: Math.round(bench.medians.views) },
      taps30d: { you: taps.total, median: Math.round(bench.medians.taps) },
      conversion: {
        you: views > 0 ? round(taps.total / views, 3) : null,
        median: bench.medians.conversion != null ? round(bench.medians.conversion, 3) : null,
      },
      topCompetitors: competitors,
    };
  }

  // ---- Featured ----
  const active = featuredRows.find((f) => !f.startsAt || f.startsAt <= now) ?? null;
  const queued = featuredRows.some((f) => f.startsAt && f.startsAt > now);
  let slotsLive = 0;
  if (listing) {
    for (const f of snap.featuredLive.values()) {
      if ((f.citySlug ?? '') === listing.city_slug && (f.categorySlug ?? '') === listing.category_slug) slotsLive++;
    }
  }
  const featured = {
    active: !!active,
    endsAt: active?.endsAt ? active.endsAt.toISOString() : null,
    queued,
    slotsLive,
    slotsCap: config.sponsored.maxSlotsPerCityCategory,
    options: getFeaturedOptions().map((o) => ({ durationDays: o.durationDays, label: o.label, rupees: Math.round(o.priceMinor / 100) })),
  };

  // ---- Actions ----
  const actions: VendorAction[] = [];
  const where = listing ? `${listing.city} ${listing.category.toLowerCase()}` : 'your city';
  if (openEnquiries > 0) {
    actions.push({
      id: 'respond_enquiries',
      priority: 95,
      severity: 'urgent',
      title: `${openEnquiries} customer${openEnquiries === 1 ? ' is' : 's are'} waiting for a reply`,
      body: 'Pet owners usually book whoever answers first. Reply today to turn these enquiries into customers.',
      metric: { label: 'Unanswered enquiries', value: openEnquiries },
      cta: { label: 'Reply now', view: 'enquiries' },
    });
  }
  if (!v.email || !v.emailVerified) {
    actions.push({
      id: 'verify_email',
      priority: 85,
      severity: 'urgent',
      title: v.email ? 'Verify your business email' : 'Add a business email',
      body: 'Enquiry alerts, receipts and review notifications go to this address. Until it is verified they may not reach you.',
      cta: { label: v.email ? 'Verify email' : 'Add email', view: 'settings' },
    });
  }
  const active30 = featured.active && active?.endsAt ? active.endsAt.getTime() - now.getTime() : null;
  if (active30 != null && active30 < config.vendor.renewWithinDays * DAY_MS && !queued) {
    const days = Math.max(0, Math.ceil(active30 / DAY_MS));
    actions.push({
      id: 'renew_featured',
      priority: 80,
      severity: 'recommended',
      title: `Your featured placement ends in ${days} day${days === 1 ? '' : 's'}`,
      body: 'Renew now and the new period starts the moment this one ends, so you never drop out of the top spots.',
      metric: { label: 'Sponsored clicks this month', value: performance.sponsoredClicks },
      cta: { label: 'Renew placement', view: 'grow' },
    });
  }
  if (percent < 70) {
    actions.push({
      id: 'complete_profile',
      priority: 75,
      severity: 'recommended',
      title: `Your profile is ${percent}% complete`,
      body: 'Complete listings are opened and contacted far more often. Fill in what is missing to stand out.',
      metric: { label: 'Profile completeness', value: `${percent}%`, benchmark: '70%+' },
      cta: { label: 'Complete profile', view: 'listing' },
    });
  }
  if (missing.includes('photo') || missing.includes('gallery')) {
    actions.push({
      id: 'add_photos',
      priority: 65,
      severity: 'recommended',
      title: missing.includes('photo') ? 'Add a storefront photo' : 'Add a few more photos',
      body: 'A photo is the first thing a pet owner sees. Listings with photos get noticed before the ones without.',
      cta: { label: 'Add photos', view: 'listing' },
    });
  }
  if (missing.includes('services')) {
    actions.push({
      id: 'add_services',
      priority: 60,
      severity: 'recommended',
      title: 'List the services you offer',
      body: 'Pet owners compare services and prices before they call. Add what you offer so they can pick you.',
      suggestions: (listing && TYPICAL_SERVICES[listing.category_slug]) || DEFAULT_SERVICES,
      cta: { label: 'Add services', view: 'services' },
    });
  }
  if (unreplied > 0) {
    actions.push({
      id: 'reply_reviews',
      priority: 58,
      severity: 'recommended',
      title: `Reply to ${unreplied} review${unreplied === 1 ? '' : 's'}`,
      body: 'A public reply shows future customers that you care. It takes a minute.',
      metric: { label: 'Reviews without a reply', value: unreplied },
      cta: { label: 'Reply to reviews', view: 'reviews' },
    });
  }
  if (listing && bench && (Number(listing.review_count) || 0) < bench.medians.reviews) {
    actions.push({
      id: 'request_reviews',
      priority: 55,
      severity: 'recommended',
      title: 'Collect more reviews',
      body: `Businesses with more reviews rank higher. Send WhatsApp review requests to recent customers.`,
      metric: { label: `Reviews · median in ${where}`, value: Number(listing.review_count) || 0, benchmark: Math.round(bench.medians.reviews) },
      cta: { label: 'Request reviews', view: 'reviews' },
    });
  }
  const competitors = bench ? bench.ids.length - 1 : 0;
  if (
    !featured.active &&
    !queued &&
    isVendorApproved(v.status) &&
    v.claimedAt &&
    percent >= config.vendor.minCompletenessForBoost &&
    competitors >= config.vendor.minCompetitorsForBoost &&
    (config.sponsored.maxSlotsPerCityCategory == null || slotsLive < config.sponsored.maxSlotsPerCityCategory)
  ) {
    actions.push({
      id: 'boost_featured',
      priority: 40,
      severity: 'opportunity',
      title: `Get seen first among ${competitors + 1} businesses in ${where}`,
      body: 'A featured placement puts you in the labelled sponsored spots on city pages and recommendations, rotated fairly with other sponsors.',
      metric: bench ? { label: 'Your views vs median (30d)', value: views, benchmark: Math.round(bench.medians.views) } : undefined,
      cta: { label: 'See placement options', view: 'grow-plans' },
    });
  }
  if (isVendorApproved(v.status) && liveCampaigns === 0 && views > 0) {
    actions.push({
      id: 'start_campaign',
      priority: 25,
      severity: 'opportunity',
      title: 'Reach more pet owners with a campaign',
      body: `${views} pet owner${views === 1 ? '' : 's'} viewed your page this month. A campaign brings you in front of many more.`,
      cta: { label: 'Start a campaign', view: 'grow' },
    });
  }
  actions.sort((a, b) => b.priority - a.priority);

  return {
    ok: true,
    generatedAt,
    completeness: { percent, missing, checklist: completion.checklist },
    actions: actions.slice(0, 6),
    performance,
    benchmark,
    featured,
  };
}

/** Top actions + one benchmark line, for the weekly growth digest mail. */
export async function vendorDigestContent(vendorId: string): Promise<{
  actions: VendorAction[];
  benchmarkLine: string | null;
} | null> {
  const r = (await vendorInsights(vendorId)) as { actions?: VendorAction[]; benchmark?: Record<string, any> | null; performance?: unknown };
  if (!r.performance || !r.actions?.length) return null;
  const b = r.benchmark;
  const line = b
    ? `You rank #${b.yourRank ?? '—'} of ${b.listings} ${String(b.category).toLowerCase()} businesses in ${b.city} · ${b.views30d.you} views vs a median of ${b.views30d.median}`
    : null;
  return { actions: r.actions.slice(0, 3), benchmarkLine: line };
}
