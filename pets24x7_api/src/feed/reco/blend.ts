// Sponsored blending — the only way paid placement reaches a recommendation.
//
// Organic ranking never includes a paid boost. A live Featured slot enters a
// list only through reserved, labelled positions (config.sponsored.positions),
// and only when:
//   • it is in the surface's city (and category, on a category surface);
//   • it is relevant — for a parent with signals, its category is one they
//     need, enquired about, saved or viewed (config.sponsored.requireRelevance);
//   • this viewer has not already seen it perViewerDailyCap times today.
// When more paid slots qualify than there are positions, a deterministic
// weighted shuffle favours the slot with the fewest deliveries in the last
// 24h, so every vendor who paid gets a comparable share of voice.

import type { ListingRecord } from '../../listings/index.js';
import { getListingById } from '../../listings/index.js';
import type { RecoConfig } from './config.js';
import type { Reason } from './reasons.js';
import type { FeaturedLive, Snapshot } from './signals.js';
import { categoryKeys, hash32, unitHash } from './util.js';

// ---------------------------------------------------------------------------
// Delivery counters (per process): 24h rolling per featured slot, and the
// per-viewer daily cap. Both are bounded.
// ---------------------------------------------------------------------------

const HOUR = 3600 * 1000;
/** featuredId → hourly buckets [hourIndex, count][] (last 24h). */
const delivered = new Map<string, Array<[number, number]>>();

export function recordDelivery(featuredId: string, n = 1): void {
  const h = Math.floor(Date.now() / HOUR);
  const arr = delivered.get(featuredId) ?? [];
  const last = arr[arr.length - 1];
  if (last && last[0] === h) last[1] += n;
  else arr.push([h, n]);
  while (arr.length && arr[0]![0] <= h - 24) arr.shift();
  delivered.set(featuredId, arr);
  if (delivered.size > 10000) {
    const oldest = delivered.keys().next().value;
    if (oldest !== undefined) delivered.delete(oldest);
  }
}

export function deliveries24h(featuredId: string): number {
  const h = Math.floor(Date.now() / HOUR);
  let n = 0;
  for (const [hr, c] of delivered.get(featuredId) ?? []) if (hr > h - 24) n += c;
  return n;
}

const VIEWER_MAX = 50000;
/** viewerKey → { day, counts: featuredId → exposures }. */
const viewerCaps = new Map<string, { day: number; counts: Map<string, number> }>();

function today(): number {
  return Math.floor(Date.now() / (24 * HOUR));
}

export function viewerExposures(viewerKey: string, featuredId: string): number {
  const v = viewerCaps.get(viewerKey);
  if (!v || v.day !== today()) return 0;
  return v.counts.get(featuredId) ?? 0;
}

export function recordExposure(viewerKey: string, featuredId: string): void {
  const d = today();
  let v = viewerCaps.get(viewerKey);
  if (!v || v.day !== d) {
    v = { day: d, counts: new Map() };
  } else {
    viewerCaps.delete(viewerKey); // refresh LRU position
  }
  v.counts.set(featuredId, (v.counts.get(featuredId) ?? 0) + 1);
  viewerCaps.set(viewerKey, v);
  while (viewerCaps.size > VIEWER_MAX) {
    const oldest = viewerCaps.keys().next().value;
    if (oldest === undefined) break;
    viewerCaps.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Eligibility + rotation
// ---------------------------------------------------------------------------

export interface SponsoredPick {
  listing: ListingRecord;
  featured: FeaturedLive;
}

export interface SponsoredQuery {
  citySlug: string;
  categorySlug?: string | null;
  /** Category keys a signed-in parent cares about; null = no relevance floor. */
  relevant?: Set<string> | null;
  viewerKey: string;
  /** Seed for the rotation (the rid bucket), so one response is stable. */
  seed: string;
  exclude?: Set<string>;
}

/** Live paid slots that may be shown to this viewer, fair-rotated. */
export function sponsoredCandidates(q: SponsoredQuery, snap: Snapshot, config: RecoConfig): SponsoredPick[] {
  if (!config.sponsored.enabled) return [];
  const out: Array<SponsoredPick & { key: number }> = [];
  const city = q.citySlug.toLowerCase();
  const cat = q.categorySlug?.toLowerCase() ?? null;
  for (const f of snap.featuredLive.values()) {
    if (q.exclude?.has(f.listingId)) continue;
    const l = getListingById(f.listingId);
    if (!l || l.hidden) continue;
    const fCity = (f.citySlug ?? l.city_slug ?? '').toLowerCase();
    if (fCity !== city) continue;
    const fCat = (f.categorySlug ?? l.category_slug ?? '').toLowerCase();
    if (cat && fCat !== cat) continue;
    if (config.sponsored.requireRelevance && q.relevant && q.relevant.size > 0) {
      if (!categoryKeys(l.category_slug, l.category).some((k) => q.relevant!.has(k))) continue;
    }
    if (viewerExposures(q.viewerKey, f.featuredId) >= config.sponsored.perViewerDailyCap) continue;
    // Weighted random order (Efraimidis–Spirakis): key = u^(1/w), with the
    // weight falling as a slot's 24h deliveries rise.
    const w = 1 / (1 + deliveries24h(f.featuredId));
    const u = unitHash(`${q.seed}|${f.listingId}`);
    out.push({ listing: l, featured: f, key: Math.pow(u, 1 / w) });
  }
  return out.sort((a, b) => b.key - a.key).map(({ listing, featured }) => ({ listing, featured }));
}

/** Orders featured rows (for /api/featured cards) by the same fair rotation. */
export function rotateFeatured<T extends { id: string; listingId: string }>(rows: T[], seed: string): T[] {
  return rows
    .map((r) => {
      const w = 1 / (1 + deliveries24h(r.id));
      const u = unitHash(`${seed}|${r.listingId}`);
      return { r, key: Math.pow(u, 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// Blend into a ranked list
// ---------------------------------------------------------------------------

export interface BlendItem {
  listing: ListingRecord;
  score: number;
  reason: Reason;
  reasons: string[];
  sponsored: boolean;
  featuredId: string | null;
}

/**
 * Inserts sponsored picks at the configured positions. A pick that already sits
 * organically at or above its slot is flagged in place; one lower down is moved
 * up. Never duplicates a listing.
 *
 * `pageLimit` guarantees a slot on the first page: when every configured
 * position is past the page (a one-card sponsored request), the slot moves to
 * the last position of the page.
 */
export function blendSponsored(
  organic: BlendItem[],
  picks: SponsoredPick[],
  config: RecoConfig,
  pageLimit: number,
): BlendItem[] {
  if (!config.sponsored.enabled || picks.length === 0 || config.sponsored.maxPerList <= 0) return organic;
  let positions = [...config.sponsored.positions].sort((a, b) => a - b);
  if (positions.length === 0) return organic;
  if (!positions.some((p) => p <= pageLimit)) positions = [pageLimit, ...positions];

  const total = Math.max(organic.length, pageLimit);
  const shareCap = Math.max(1, Math.floor(config.sponsored.maxShare * total));
  const maxSlots = Math.min(config.sponsored.maxPerList, shareCap, positions.length, picks.length);

  const list = [...organic];
  const label = config.sponsored.label;
  let used = 0;
  for (const pick of picks) {
    if (used >= maxSlots) break;
    const pos = positions[used]!;
    const idx0 = Math.min(pos - 1, list.length); // 0-based target
    const reason: Reason = { code: 'SPONSORED', text: label };
    const at = list.findIndex((x) => x.listing.id === pick.listing.id);
    const item: BlendItem = {
      listing: pick.listing,
      score: at >= 0 ? list[at]!.score : 0,
      reason,
      reasons: [label],
      sponsored: true,
      featuredId: pick.featured.featuredId,
    };
    if (at >= 0 && at <= idx0) {
      list[at] = item; // already there organically: flag in place
    } else {
      if (at >= 0) list.splice(at, 1);
      list.splice(Math.min(idx0, list.length), 0, item);
    }
    used++;
  }
  return list;
}

/** Deterministic A/B arm for a viewer. */
export function variantFor(viewerKey: string, config: RecoConfig): 'A' | 'B' {
  if (!config.experiment.enabled) return 'A';
  return hash32(`exp|${viewerKey}`) % 100 < config.experiment.splitPct ? 'B' : 'A';
}
