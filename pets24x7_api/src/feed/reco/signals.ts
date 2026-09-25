// Shared signals snapshot — everything the ranking needs that is the same for
// every viewer, loaded once per process every few minutes instead of once per
// request.
//
// The old per-request path did an unbounded findMany of every live featured
// row and every claimed vendor on each call. Here each input is one bounded,
// indexed query per refresh; a failed refresh keeps the last good snapshot, and
// a process that never managed to load one ranks on the listings index alone.

import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { getListingById } from '../../listings/index.js';
import { APPROVED_VENDOR_STATUSES } from '../../shared/vendor-status.js';
import { getRecoConfig } from './config.js';
import { refreshCityCatalogue } from './city-index.js';
import { CONTACT_KINDS, DAY_MS } from './util.js';

export interface FeaturedLive {
  featuredId: string;
  vendorId: string;
  listingId: string;
  citySlug: string | null;
  categorySlug: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface Snapshot {
  version: number;
  at: Date | null;
  durationMs: number;
  featuredLive: Map<string, FeaturedLive>;
  approvedClaimed: Set<string>;
  taps30d: Map<string, number>;
  views30d: Map<string, number>;
  saves: Map<string, number>;
  p24Reviews: Map<string, { avg: number; n: number }>;
}

const EMPTY: Snapshot = {
  version: 0,
  at: null,
  durationMs: 0,
  featuredLive: new Map(),
  approvedClaimed: new Set(),
  taps30d: new Map(),
  views30d: new Map(),
  saves: new Map(),
  p24Reviews: new Map(),
};

let snap: Snapshot = EMPTY;
let running: Promise<Snapshot> | null = null;

export function signals(): Snapshot {
  return snap;
}

type GroupByFn = (args: unknown) => Promise<unknown>;

async function countBy(kinds: string[], since: Date): Promise<Map<string, number> | null> {
  try {
    const groupBy = prisma.listingActivity.groupBy as unknown as GroupByFn;
    const rows = (await groupBy({
      by: ['listingId'],
      where: { kind: { in: kinds }, createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { listingId: 'desc' } },
      take: 20000,
    })) as Array<{ listingId: string; _count: { _all: number } }>;
    return new Map(rows.map((r) => [r.listingId, r._count._all]));
  } catch {
    return null;
  }
}

async function load(): Promise<Snapshot> {
  const started = Date.now();
  const config = await getRecoConfig();
  const now = new Date();
  const since = new Date(now.getTime() - config.popularity.windowDays * DAY_MS);

  const [featuredRows, claimedRows, taps, views, saves, reviews] = await Promise.all([
    prisma.featuredListing
      .findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { gt: now },
          // A queued slot is paid for but not started: it must not deliver yet.
          OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        },
        select: { id: true, vendorId: true, listingId: true, citySlug: true, categorySlug: true, startsAt: true, endsAt: true },
        take: 5000,
      })
      .catch(() => null),
    prisma.vendor
      .findMany({
        // CLAIMED is an approved state too (see shared/vendor-status.ts); the
        // old ACTIVE-only filter never boosted a vendor who came in by claim.
        where: { status: { in: [...APPROVED_VENDOR_STATUSES] }, listingId: { not: null }, claimedAt: { not: null } },
        select: { listingId: true },
        take: 100000,
      })
      .catch(() => null),
    countBy(CONTACT_KINDS, since),
    countBy(['listing_view'], since),
    (async () => {
      try {
        const groupBy = prisma.savedListing.groupBy as unknown as GroupByFn;
        const rows = (await groupBy({
          by: ['listingId'],
          _count: { _all: true },
          orderBy: { _count: { listingId: 'desc' } },
          take: 20000,
        })) as Array<{ listingId: string; _count: { _all: number } }>;
        return new Map(rows.map((r) => [r.listingId, r._count._all]));
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        const groupBy = prisma.review.groupBy as unknown as GroupByFn;
        const rows = (await groupBy({
          by: ['listingId'],
          where: { status: 'PUBLISHED', listingId: { not: null } },
          _avg: { rating: true },
          _count: { _all: true },
          orderBy: { _count: { listingId: 'desc' } },
          take: 20000,
        })) as Array<{ listingId: string | null; _avg: { rating: number | null }; _count: { _all: number } }>;
        const m = new Map<string, { avg: number; n: number }>();
        for (const r of rows) if (r.listingId && r._avg.rating != null) m.set(r.listingId, { avg: r._avg.rating, n: r._count._all });
        return m;
      } catch {
        return null;
      }
    })(),
    refreshCityCatalogue(),
  ]);

  const featuredLive = featuredRows
    ? new Map(
        featuredRows.map((f) => {
          // Rows written before citySlug was captured fall back to the listing's own.
          const l = getListingById(f.listingId);
          return [
            f.listingId,
            {
              featuredId: f.id,
              vendorId: f.vendorId,
              listingId: f.listingId,
              citySlug: f.citySlug ?? l?.city_slug ?? null,
              categorySlug: f.categorySlug ?? l?.category_slug ?? null,
              startsAt: f.startsAt,
              endsAt: f.endsAt,
            } satisfies FeaturedLive,
          ];
        }),
      )
    : snap.featuredLive;

  const next: Snapshot = {
    version: snap.version + 1,
    at: now,
    durationMs: Date.now() - started,
    featuredLive,
    approvedClaimed: claimedRows
      ? new Set(claimedRows.map((v) => v.listingId).filter((x): x is string => !!x))
      : snap.approvedClaimed,
    taps30d: taps ?? snap.taps30d,
    views30d: views ?? snap.views30d,
    saves: saves ?? snap.saves,
    p24Reviews: reviews ?? snap.p24Reviews,
  };
  snap = next;
  return next;
}

/** Rebuilds the snapshot now (single-flight). Never throws. */
export function refreshSignals(): Promise<Snapshot> {
  if (!running) {
    running = load()
      .catch((err) => {
        logger.warn({ err }, 'reco signals refresh failed — keeping the last snapshot');
        return snap;
      })
      .finally(() => (running = null));
  }
  return running;
}

/** The snapshot, loading it first if this process never has. */
export async function ensureSignals(): Promise<Snapshot> {
  if (snap.version === 0) {
    // Bounded wait: the first request after boot must not hang on a slow DB.
    await Promise.race([refreshSignals(), new Promise((r) => setTimeout(r, 1500))]);
  }
  return snap;
}

let timer: NodeJS.Timeout | null = null;

export function startSignalsRefresh(intervalMs = 5 * 60_000): void {
  if (timer) return;
  void refreshSignals();
  timer = setInterval(() => void refreshSignals(), intervalMs);
  timer.unref?.();
}
