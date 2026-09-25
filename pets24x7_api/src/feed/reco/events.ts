// Impression + click tracking for every recommendation and sponsored surface.
//
//   register(rid, …)   what one response actually served (the rid registry)
//   ingest(events)     beacons from /reco-track.js, validated against it
//   flush()            every 60s: counters → RecoStatDaily upsert-increments
//
// The server trusts only the registry: an event for a listing its rid never
// served, or with a sponsored flag the registry disagrees with, is rejected. A
// forged beacon therefore cannot inflate a paid slot's numbers. Counters live in
// memory between flushes and are written as atomic increments, so several API
// instances can share the same rows.

import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import { longRidStore, ridStore } from './cache.js';
import type { ReasonCode } from './reasons.js';
import { REASON_CODES } from './reasons.js';
import { recordDelivery } from './blend.js';
import { dayDate, ymd } from './util.js';

export const SURFACES = [
  'parent_home',
  'parent_feed',
  'listing_similar',
  'listing_nearby',
  'city_top',
  'home_top',
  'search_sponsored',
  'featured_strip',
  'email_digest',
] as const;
export type Surface = (typeof SURFACES)[number];

export interface RidItem {
  pos: number;
  reason: ReasonCode;
  sponsored: boolean;
  featuredId: string | null;
  /** Surface override for multi-surface responses (listing similar/nearby). */
  surface?: Surface;
}

export interface RidEntry<TList = unknown, TMeta = unknown> {
  surface: Surface;
  variant: 'A' | 'B';
  items: Record<string, RidItem>;
  /** Full ranked list, for cursor pagination without a re-rank. */
  list?: TList[];
  meta?: TMeta;
}

const RID_TTL_SEC = 15 * 60;
export const EMAIL_RID_TTL_SEC = 7 * 24 * 3600;

export function registerRid<TList, TMeta>(rid: string, entry: RidEntry<TList, TMeta>, ttlSec = RID_TTL_SEC): void {
  if (ttlSec > RID_TTL_SEC) {
    // Long-lived (email): only what event validation needs, no page list.
    longRidStore.set(`rid:${rid}`, { surface: entry.surface, variant: entry.variant, items: entry.items }, ttlSec);
    return;
  }
  // Public rids are deterministic per 5-minute bucket and shared by every
  // viewer, whose sponsored rotation can differ: merge what each one served
  // (and, with a shared store, what other instances served).
  const mergeInto = (prev: RidEntry<TList, TMeta>): RidEntry<TList, TMeta> => ({
    ...entry,
    items: { ...prev.items, ...entry.items },
  });
  const prev = ridStore.peek<RidEntry<TList, TMeta>>(`rid:${rid}`);
  ridStore.set(`rid:${rid}`, prev ? mergeInto(prev) : entry, ttlSec, mergeInto);
}

/** The entry a rid was registered with, from this instance or the shared store. */
export async function lookupRid<TList = unknown, TMeta = unknown>(rid: string): Promise<RidEntry<TList, TMeta> | undefined> {
  return (
    (await ridStore.get<RidEntry<TList, TMeta>>(`rid:${rid}`)) ??
    (await longRidStore.get<RidEntry<TList, TMeta>>(`rid:${rid}`))
  );
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface Cell {
  day: string;
  surface: string;
  variant: string;
  listingId: string;
  reason: string;
  sponsored: boolean;
  featuredId: string | null;
  imp: number;
  clk: number;
}

let counters = new Map<string, Cell>();
const MAX_CELLS = 50000;

function bump(c: Omit<Cell, 'imp' | 'clk'>, imp: number, clk: number): void {
  const key = `${c.day}|${c.surface}|${c.variant}|${c.listingId}|${c.reason}|${c.sponsored ? 1 : 0}`;
  const cur = counters.get(key);
  if (cur) {
    cur.imp += imp;
    cur.clk += clk;
    return;
  }
  if (counters.size >= MAX_CELLS) return; // a flush is overdue; drop rather than grow unbounded
  counters.set(key, { ...c, imp, clk });
}

// De-duplication: one impression and one click per viewer, rid and listing.
const DEDUPE_TTL_MS = 30 * 60_000;
const DEDUPE_MAX = 200000;
const seen = new Map<string, number>();

function firstTime(key: string): boolean {
  const now = Date.now();
  const at = seen.get(key);
  if (at && now - at < DEDUPE_TTL_MS) return false;
  seen.delete(key);
  seen.set(key, now);
  while (seen.size > DEDUPE_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

export interface IncomingEvent {
  rid: string;
  type: 'impression' | 'click';
  listingId: string;
  pos?: number;
  reason?: string;
  sponsored?: boolean;
  surface?: string;
}

/** Validates and counts a batch. Returns how many were accepted. */
export async function ingestEvents(
  events: IncomingEvent[],
  viewerKey: string,
): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  const day = ymd(new Date());
  // A batch almost always names one or two rids: resolve each once.
  const entries = new Map<string, Promise<RidEntry | undefined>>();
  for (const e of events) {
    let pending = entries.get(e.rid);
    if (!pending) entries.set(e.rid, (pending = lookupRid(e.rid)));
    const entry = await pending;
    const item = entry?.items[e.listingId];
    if (!entry || !item) {
      rejected++;
      continue;
    }
    // Client values are hints; a sponsored flag that disagrees is a forgery.
    if (typeof e.sponsored === 'boolean' && e.sponsored !== item.sponsored) {
      rejected++;
      continue;
    }
    if (!firstTime(`${viewerKey}|${e.rid}|${e.listingId}|${e.type}`)) {
      // A duplicate is not an error; it just does not count twice.
      accepted++;
      continue;
    }
    bump(
      {
        day,
        surface: item.surface ?? entry.surface,
        variant: entry.variant,
        listingId: e.listingId,
        reason: item.reason,
        sponsored: item.sponsored,
        featuredId: item.featuredId,
      },
      e.type === 'impression' ? 1 : 0,
      e.type === 'click' ? 1 : 0,
    );
    accepted++;
  }
  return { accepted, rejected };
}

/** Server-side impressions (the email digest counts at send time). */
export function recordServerImpressions(
  surface: Surface,
  variant: 'A' | 'B',
  items: Array<{ listingId: string; reason: ReasonCode; sponsored: boolean; featuredId: string | null }>,
): void {
  const day = ymd(new Date());
  for (const it of items) {
    bump({ day, surface, variant, listingId: it.listingId, reason: it.reason, sponsored: it.sponsored, featuredId: it.featuredId }, 1, 0);
    if (it.sponsored && it.featuredId) recordDelivery(it.featuredId);
  }
}

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

const CHUNK = 50;
let flushing: Promise<number> | null = null;

async function doFlush(): Promise<number> {
  if (counters.size === 0) return 0;
  const batch = [...counters.values()];
  counters = new Map();
  let written = 0;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((c) =>
          prisma.recoStatDaily.upsert({
            where: {
              day_surface_variant_listingId_reason_sponsored: {
                day: dayDate(c.day),
                surface: c.surface,
                variant: c.variant,
                listingId: c.listingId,
                reason: c.reason,
                sponsored: c.sponsored,
              },
            },
            update: {
              impressions: { increment: c.imp },
              clicks: { increment: c.clk },
              ...(c.featuredId ? { featuredId: c.featuredId } : {}),
            },
            create: {
              day: dayDate(c.day),
              surface: c.surface,
              variant: c.variant,
              listingId: c.listingId,
              reason: c.reason,
              sponsored: c.sponsored,
              featuredId: c.featuredId,
              impressions: c.imp,
              clicks: c.clk,
            },
          }),
        ),
      );
      written += chunk.length;
    } catch (err) {
      // Put the chunk back so the next flush retries it (bounded by MAX_CELLS).
      for (const c of chunk) bump(c, c.imp, c.clk);
      logger.warn({ err, cells: chunk.length }, 'reco stats flush failed — will retry');
      break;
    }
  }
  if (written < batch.length) {
    // Anything after a failed chunk was never attempted; keep it too.
    for (const c of batch.slice(written + CHUNK)) bump(c, c.imp, c.clk);
  }
  return written;
}

/** Writes pending counters now (single-flight). Never throws. */
export function flushRecoStats(): Promise<number> {
  if (!flushing) {
    flushing = doFlush()
      .catch((err) => {
        logger.warn({ err }, 'reco stats flush crashed');
        return 0;
      })
      .finally(() => (flushing = null));
  }
  return flushing;
}

let timer: NodeJS.Timeout | null = null;

export function startRecoStatsFlush(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => void flushRecoStats(), intervalMs);
  timer.unref?.();
}
