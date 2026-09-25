// Scoring — one engine behind every recommendation surface.
//
//   score(l) = baseScore(l)            same for every viewer in the city
//            + personal(l, intent)     this parent's pets, enquiries, saves, views
//
// baseScore is cached per city (and per index/snapshot/weights version), so a
// request only re-scores a bounded candidate set: the city's top 400 plus the
// top few of each category the parent cares about, capped at 800. Every item
// explains itself through reason codes (reasons.ts).

import type { ListingRecord } from '../../listings/index.js';
import { getListingById, shownRating } from '../../listings/index.js';
import type { RecoConfig, RecoWeights } from './config.js';
import { cityCategoryListings, cityListings, indexVersion, isRecentlyAdded } from './city-index.js';
import { pickReasons, text, type Component, type Reason } from './reasons.js';
import type { Snapshot } from './signals.js';
import { areaPrefix, categoryKeys, clamp01, DAY_MS, slugify, unitHash } from './util.js';

// ---------------------------------------------------------------------------
// Pet needs
// ---------------------------------------------------------------------------

export interface PetSignal {
  species: string;
  breed?: string | null;
  ageYears?: number | null;
  vaccinated?: boolean;
  /** Used in reason text ("For Bruno: …"). */
  name?: string | null;
  lastVaccinatedAt?: Date | string | null;
}

export interface Need {
  slug: string;
  reason: string;
  weight: number;
}

const VACCINE_INTERVAL_DAYS = 365;

/**
 * Category needs implied by a pet. Keyed by category_slug so this survives
 * display-name copy edits.
 */
export function needsForPet(pet: PetSignal, now = Date.now()): Need[] {
  const out: Need[] = [];
  const species = String(pet.species || '').toUpperCase();
  const age = typeof pet.ageYears === 'number' ? pet.ageYears : null;
  const name = pet.name?.trim() || 'your pet';

  if (pet.vaccinated === false) {
    out.push({ slug: 'vaccination-centers', reason: `${name} is not marked vaccinated`, weight: 1 });
  } else if (pet.lastVaccinatedAt) {
    // A booster is annual: a pet vaccinated more than a year ago is due again,
    // whatever the at-a-glance flag says.
    const at = new Date(pet.lastVaccinatedAt).getTime();
    if (Number.isFinite(at) && now - at > VACCINE_INTERVAL_DAYS * DAY_MS) {
      out.push({ slug: 'vaccination-centers', reason: 'the annual booster is due', weight: 0.95 });
    }
  }

  if (species === 'DOG') {
    out.push(
      { slug: 'pet-walking', reason: 'dogs need regular walks', weight: 0.8 },
      { slug: 'pet-training-obedience-behavior', reason: 'training for dogs', weight: 0.6 },
      { slug: 'pet-grooming-spa', reason: 'grooming for dogs', weight: 0.7 },
      { slug: 'pet-boarding-daycare', reason: 'boarding when you travel', weight: 0.6 },
    );
  } else if (species === 'CAT') {
    out.push(
      { slug: 'pet-sitting-in-home-care', reason: 'cats do better sitting at home', weight: 0.9 },
      { slug: 'pet-grooming-spa', reason: 'grooming for cats', weight: 0.6 },
      { slug: 'veterinary-clinics', reason: 'routine cat check-ups', weight: 0.6 },
    );
  } else if (species === 'BIRD' || species === 'REPTILE' || species === 'SMALL_MAMMAL') {
    out.push(
      { slug: 'specialty-vets-exotics-avian-reptiles', reason: `specialist vets treat ${species.toLowerCase().replace('_', ' ')}s`, weight: 1 },
      { slug: 'pet-sitting-in-home-care', reason: 'in-home care suits exotics', weight: 0.5 },
    );
  } else {
    out.push({ slug: 'veterinary-clinics', reason: 'general vet care', weight: 0.5 });
  }

  if (age != null && age >= 8) {
    out.push(
      { slug: 'pet-physiotherapy-rehab', reason: 'senior pets benefit from physio', weight: 0.8 },
      { slug: 'pet-dental-care', reason: 'dental care matters more with age', weight: 0.7 },
    );
  }
  if (age != null && age <= 1) {
    out.push(
      { slug: 'vaccination-centers', reason: 'puppies and kittens need their shot course', weight: 0.9 },
      { slug: 'pet-training-obedience-behavior', reason: 'early training sticks best', weight: 0.7 },
    );
  }

  // Everyone should know where the nearest emergency hospital is.
  out.push({ slug: 'emergency-animal-hospital', reason: 'good to have an emergency vet saved', weight: 0.35 });
  return out;
}

// ---------------------------------------------------------------------------
// Parent intent: every personal signal, normalised to category keys once.
// ---------------------------------------------------------------------------

export interface ParentHistory {
  /** Newest first. */
  enquiries: Array<{ listingId: string | null; category: string | null; createdAt?: Date }>;
  /** Newest first. */
  saved: Array<{ listingId: string; category: string | null; listingName?: string | null; createdAt?: Date }>;
  /** Newest first. */
  viewed: Array<{ listingId: string; category: string | null; createdAt?: Date }>;
}

export interface Intent {
  need: Map<string, { weight: number; why: string; petName: string | null }>;
  affinity: Map<string, { weight: number; label: string }>;
  saved: Map<string, { listingId: string; name: string }>;
  viewed: Map<string, { weight: number; listingId: string; name: string }>;
  known: Set<string>;
  pincodes: Set<string>;
  areas: Set<string>;
  hasSignals: boolean;
  /** Category keys the parent has shown any interest in (sponsored relevance floor). */
  relevant: Set<string>;
  /** Canonical category slugs for candidate generation. */
  categories: { need: string[]; affinity: string[]; saved: string[]; viewed: string[] };
}

export function buildIntent(pets: PetSignal[], history: ParentHistory, now = Date.now()): Intent {
  const need = new Map<string, { weight: number; why: string; petName: string | null }>();
  for (const pet of pets) {
    for (const n of needsForPet(pet, now)) {
      const cur = need.get(n.slug);
      if (!cur || n.weight > cur.weight) need.set(n.slug, { weight: n.weight, why: n.reason, petName: pet.name?.trim() || null });
    }
  }

  const affinity = new Map<string, { weight: number; label: string }>();
  const affinityCats: string[] = [];
  history.enquiries.forEach((e, i) => {
    const l = e.listingId ? getListingById(e.listingId) : undefined;
    const raw = e.category || l?.category || '';
    if (!raw) return;
    // Recency-weighted: the most recent enquiry counts most.
    const w = 1 / (1 + i * 0.5);
    const label = l?.category || raw;
    const canon = l?.category_slug || slugify(raw);
    if (canon && !affinityCats.includes(canon)) affinityCats.push(canon);
    for (const k of categoryKeys(l?.category_slug, raw)) {
      const cur = affinity.get(k);
      if (!cur || w > cur.weight) affinity.set(k, { weight: w, label });
    }
  });

  const saved = new Map<string, { listingId: string; name: string }>();
  const savedCats: string[] = [];
  for (const s of history.saved) {
    const l = getListingById(s.listingId);
    const raw = s.category || l?.category || '';
    if (!raw) continue;
    const canon = l?.category_slug || slugify(raw);
    if (canon && !savedCats.includes(canon)) savedCats.push(canon);
    const name = l?.name || s.listingName || 'a business';
    // Newest first, so the first one seen per category is the most recent.
    for (const k of categoryKeys(l?.category_slug, raw)) if (!saved.has(k)) saved.set(k, { listingId: s.listingId, name });
  }

  const viewed = new Map<string, { weight: number; listingId: string; name: string }>();
  const viewedCats: string[] = [];
  history.viewed.forEach((v, i) => {
    const l = getListingById(v.listingId);
    const raw = v.category || l?.category || '';
    if (!raw) return;
    const canon = l?.category_slug || slugify(raw);
    if (canon && !viewedCats.includes(canon)) viewedCats.push(canon);
    const w = 1 / (1 + i * 0.3);
    for (const k of categoryKeys(l?.category_slug, raw)) {
      const cur = viewed.get(k);
      if (!cur || w > cur.weight) viewed.set(k, { weight: w, listingId: v.listingId, name: l?.name || 'a business' });
    }
  });

  const known = new Set<string>();
  const pincodes = new Set<string>();
  const areas = new Set<string>();
  for (const id of [...history.enquiries.map((e) => e.listingId), ...history.saved.map((s) => s.listingId)]) {
    if (!id) continue;
    known.add(id);
    const pin = getListingById(id)?.pincode;
    if (pin) {
      pincodes.add(pin.replace(/\s/g, ''));
      const a = areaPrefix(pin);
      if (a) areas.add(a);
    }
  }

  const relevant = new Set<string>([...need.keys(), ...affinity.keys(), ...saved.keys(), ...viewed.keys()]);
  return {
    need,
    affinity,
    saved,
    viewed,
    known,
    pincodes,
    areas,
    hasSignals: need.size > 0 || affinity.size > 0 || saved.size > 0 || viewed.size > 0,
    relevant,
    categories: { need: [...need.keys()], affinity: affinityCats, saved: savedCats, viewed: viewedCats },
  };
}

export const EMPTY_INTENT: Intent = buildIntent([], { enquiries: [], saved: [], viewed: [] });

// ---------------------------------------------------------------------------
// Base score
// ---------------------------------------------------------------------------

export interface ScoreEnv {
  weights: RecoWeights;
  config: RecoConfig;
  snap: Snapshot;
  /** Highest 30-day tap count in the city, for normalising popularity. */
  maxTaps: number;
  /** Extra claimed / featured ids a legacy caller passed in. */
  extraClaimed?: Set<string>;
  featuredIds?: Set<string>;
}

const LOG201 = Math.log10(201);
const LOG51 = Math.log(51);

export function baseScore(l: ListingRecord, env: ScoreEnv, explain?: Component[]): number {
  const w = env.weights;
  const s = env.snap;
  let score = 0;

  // A score with no review behind it is not a rating (shownRating), so it
  // neither ranks a listing nor appears as a reason.
  const rating = shownRating(l);
  const rc = Number(l.review_count) || 0;
  if (rating > 0) {
    const v = w.rating * clamp01((rating - 3) / 2); // 3.0 → 0, 5.0 → 1
    score += v;
    explain?.push({ code: 'TOP_RATED', value: v, text: text.topRated(rating), sayable: rating >= 4.5 && rc >= 5 });
  }
  if (rc > 0) {
    const v = w.reviews * Math.min(1, Math.log10(rc + 1) / LOG201);
    score += v;
    explain?.push({ code: 'HIGHLY_REVIEWED', value: v, text: text.highlyReviewed(rc), sayable: rc >= 100 });
  }
  const taps = s.taps30d.get(l.id) ?? 0;
  if (taps > 0 && env.maxTaps > 0) {
    const v = w.popularity * (Math.log(1 + taps) / Math.log(1 + env.maxTaps));
    score += v;
    explain?.push({
      code: 'POPULAR_NEARBY',
      value: v,
      text: text.popular(taps, env.config.popularity.windowDays),
      // Nothing is claimed until the data can carry it.
      sayable: taps >= env.config.popularity.minTaps,
    });
  }
  const saves = s.saves.get(l.id) ?? 0;
  if (saves > 0) score += w.saves * Math.min(1, Math.log(1 + saves) / LOG51);
  if (s.approvedClaimed.has(l.id) || env.extraClaimed?.has(l.id)) {
    score += w.claimed;
    explain?.push({ code: 'OWNER_MANAGED', value: w.claimed, text: text.ownerManaged(), sayable: true });
  }
  if (l.phone) score += w.contactable;
  if (isRecentlyAdded(l.id)) {
    score += w.fresh;
    explain?.push({ code: 'NEW_IN_CITY', value: w.fresh, text: text.newInCity(l.city), sayable: true });
  }
  const p24 = s.p24Reviews.get(l.id);
  if (p24 && p24.n >= 3) {
    const v = w.p24Reviews * ((p24.avg - 3) / 2);
    score += v;
    explain?.push({
      code: 'TOP_RATED',
      value: v,
      text: `${p24.avg.toFixed(1)}★ from ${p24.n} Pets24x7 reviews`,
      sayable: p24.avg >= 4.3,
    });
  }
  if (w.featuredOrganic && (env.featuredIds ?? s.featuredLive).has(l.id)) score += w.featuredOrganic;
  return score;
}

// ---------------------------------------------------------------------------
// Per-city derived data, cached by index + snapshot + weights version.
// ---------------------------------------------------------------------------

export interface CityDerived {
  key: string;
  listings: ListingRecord[];
  base: Map<string, number>;
  ranked: ListingRecord[];
  maxTaps: number;
  catRanked: Map<string, ListingRecord[]>;
}

const derivedCache = new Map<string, CityDerived>();
const MAX_DERIVED = 200;

function weightsSig(w: RecoWeights): string {
  return Object.values(w).join(',');
}

export function cityDerived(city: string, country: string, weights: RecoWeights, config: RecoConfig, snap: Snapshot): CityDerived {
  const key = `${country.toUpperCase()}|${city.toLowerCase().trim()}|${indexVersion()}|${snap.version}|${weightsSig(weights)}|${config.popularity.minTaps}|${config.popularity.windowDays}`;
  const hit = derivedCache.get(key);
  if (hit) return hit;

  const listings = cityListings(city, country);
  let maxTaps = 0;
  for (const l of listings) maxTaps = Math.max(maxTaps, snap.taps30d.get(l.id) ?? 0);
  const env: ScoreEnv = { weights, config, snap, maxTaps };
  const base = new Map<string, number>();
  for (const l of listings) base.set(l.id, baseScore(l, env));
  const ranked = [...listings].sort((a, b) => (base.get(b.id) ?? 0) - (base.get(a.id) ?? 0));
  const d: CityDerived = { key, listings, base, ranked, maxTaps, catRanked: new Map() };

  derivedCache.set(key, d);
  while (derivedCache.size > MAX_DERIVED) {
    const oldest = derivedCache.keys().next().value;
    if (oldest === undefined) break;
    derivedCache.delete(oldest);
  }
  return d;
}

/** A city's listings in one category, best base score first. */
export function categoryRanked(d: CityDerived, city: string, country: string, categorySlug: string): ListingRecord[] {
  const k = categorySlug.toLowerCase();
  let r = d.catRanked.get(k);
  if (!r) {
    r = [...cityCategoryListings(city, country, k)].sort((a, b) => (d.base.get(b.id) ?? 0) - (d.base.get(a.id) ?? 0));
    d.catRanked.set(k, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Personal score + ranking
// ---------------------------------------------------------------------------

export interface Scored {
  listing: ListingRecord;
  score: number;
  base: number;
  reason: Reason;
  reasons: string[];
  /** True when at least one personal signal matched. */
  matched: boolean;
}

function maxOver<T>(m: Map<string, T>, keys: string[], pick: (v: T) => number): T | undefined {
  let best: T | undefined;
  let bestV = -Infinity;
  for (const k of keys) {
    const v = m.get(k);
    if (v !== undefined && pick(v) > bestV) {
      best = v;
      bestV = pick(v);
    }
  }
  return best;
}

function personal(l: ListingRecord, intent: Intent, w: RecoWeights, explain: Component[]): { score: number; matched: boolean } {
  if (!intent.hasSignals && intent.known.size === 0) return { score: 0, matched: false };
  const keys = categoryKeys(l.category_slug, l.category);
  let score = 0;
  let matched = false;

  const n = maxOver(intent.need, keys, (v) => v.weight);
  if (n) {
    const v = w.petNeed * n.weight;
    score += v;
    matched = true;
    explain.push({ code: 'PET_NEED', value: v, text: text.petNeed(n.petName, n.why), sayable: true });
  }
  const a = maxOver(intent.affinity, keys, (v) => v.weight);
  if (a) {
    const v = w.affinity * a.weight;
    score += v;
    matched = true;
    explain.push({ code: 'ENQUIRED_SIMILAR', value: v, text: text.enquiredSimilar(a.label), sayable: true });
  }
  const s = maxOver(intent.saved, keys, () => 1);
  if (s && s.listingId !== l.id) {
    score += w.savedSimilar;
    matched = true;
    explain.push({
      code: 'SAVED_SIMILAR',
      value: w.savedSimilar,
      text: text.savedSimilar(s.name),
      refListingId: s.listingId,
      refName: s.name,
      sayable: true,
    });
  }
  const vw = maxOver(intent.viewed, keys, (v) => v.weight);
  if (vw && vw.listingId !== l.id) {
    const v = w.viewedSimilar * vw.weight;
    score += v;
    matched = true;
    explain.push({
      code: 'VIEWED_SIMILAR',
      value: v,
      text: text.viewedSimilar(vw.name),
      refListingId: vw.listingId,
      refName: vw.name,
      sayable: true,
    });
  }
  if (l.pincode && (intent.pincodes.size || intent.areas.size)) {
    const pin = l.pincode.replace(/\s/g, '');
    const full = intent.pincodes.has(pin);
    const area = areaPrefix(pin);
    const part = !full && area ? intent.areas.has(area) : false;
    if (full || part) {
      const v = w.sameArea * (full ? 1 : 0.5);
      score += v;
      explain.push({ code: 'SAME_AREA', value: v, text: text.sameArea(pin), sayable: true });
    }
  }
  if (intent.known.has(l.id)) score += w.seenPenalty;
  return { score, matched };
}

export interface RankOptions {
  city: string;
  country: string;
  /** Scopes the whole ranking to one category slug. */
  category?: string | null;
  intent: Intent;
  weights: RecoWeights;
  config: RecoConfig;
  snap: Snapshot;
  excludeIds?: Set<string>;
  depth: number;
  /** Explicit candidate pool (legacy wrapper); otherwise the city bucket. */
  pool?: ListingRecord[];
  extraClaimed?: Set<string>;
  featuredIds?: Set<string>;
  /** Display city for fallback reason text. */
  cityLabel?: string;
  /**
   * Exploration seed (viewer + day) for personalised surfaces. Adds a small,
   * deterministic per-listing nudge of up to config.diversity.exploration
   * points to the ORDER only, so near-ties rotate from day to day instead of
   * the same list coming back every visit. Omitted on public surfaces, whose
   * order must be shared by every viewer.
   */
  jitterSeed?: string;
}

const TOP_K = 400;
const PER_NEED = 60;
const PER_HISTORY = 40;
const MAX_CANDIDATES = 800;

/** Diversity: at most `max` per category before every other has had a turn. */
export function spread<T extends { listing: ListingRecord }>(items: T[], max: number, limit: number): T[] {
  const perCategory = new Map<string, number>();
  const out: T[] = [];
  const overflow: T[] = [];
  for (const r of items) {
    const slug = r.listing.category_slug || 'other';
    const used = perCategory.get(slug) ?? 0;
    if (used < max) {
      perCategory.set(slug, used + 1);
      out.push(r);
    } else {
      overflow.push(r);
    }
    if (out.length >= limit) break;
  }
  return [...out, ...overflow].slice(0, limit);
}

export function rank(opts: RankOptions): Scored[] {
  const { intent, weights, config, snap } = opts;
  const cityLabel = opts.cityLabel || opts.city;
  let candidates: ListingRecord[];
  let base: (l: ListingRecord) => number;
  let maxTaps: number;

  if (opts.pool) {
    maxTaps = 0;
    for (const l of opts.pool) maxTaps = Math.max(maxTaps, snap.taps30d.get(l.id) ?? 0);
    const env: ScoreEnv = { weights, config, snap, maxTaps, extraClaimed: opts.extraClaimed, featuredIds: opts.featuredIds };
    const memo = new Map<string, number>();
    base = (l) => {
      let v = memo.get(l.id);
      if (v === undefined) {
        v = baseScore(l, env);
        memo.set(l.id, v);
      }
      return v;
    };
    candidates = opts.category
      ? opts.pool.filter((l) => (l.category_slug || '').toLowerCase() === opts.category!.toLowerCase())
      : opts.pool;
  } else {
    const d = cityDerived(opts.city, opts.country, weights, config, snap);
    maxTaps = d.maxTaps;
    base = (l) => d.base.get(l.id) ?? 0;
    if (opts.category) {
      candidates = categoryRanked(d, opts.city, opts.country, opts.category);
    } else {
      // Bounded candidate generation: the city's best, plus the best of every
      // category this parent cares about (which may sit below the top 400).
      const seen = new Set<string>();
      candidates = [];
      const add = (list: ListingRecord[], n: number) => {
        let taken = 0;
        for (const l of list) {
          if (candidates.length >= MAX_CANDIDATES || taken >= n) break;
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          candidates.push(l);
          taken++;
        }
      };
      add(d.ranked, TOP_K);
      for (const c of [...intent.categories.need, ...intent.categories.affinity]) add(categoryRanked(d, opts.city, opts.country, c), PER_NEED);
      for (const c of [...intent.categories.saved, ...intent.categories.viewed]) add(categoryRanked(d, opts.city, opts.country, c), PER_HISTORY);
    }
  }

  const env: ScoreEnv = { weights, config, snap, maxTaps, extraClaimed: opts.extraClaimed, featuredIds: opts.featuredIds };
  const explore = opts.jitterSeed ? Math.max(0, config.diversity.exploration ?? 0) : 0;
  const scored: Array<{ listing: ListingRecord; score: number; base: number; matched: boolean; key: number }> = [];
  for (const l of candidates) {
    if (opts.excludeIds?.has(l.id)) continue;
    const b = base(l);
    const p = personal(l, intent, weights, []);
    const score = b + p.score;
    const key = explore > 0 ? score + explore * unitHash(`${opts.jitterSeed}|${l.id}`) : score;
    scored.push({ listing: l, score, base: b, matched: p.matched, key });
  }

  // Relevance first: with personal signals, listings that matched none of them
  // only top up a short list, so a stale signal never empties it.
  let ordered: typeof scored;
  if (intent.hasSignals && !opts.category) {
    const hits = scored.filter((s) => s.matched).sort((a, b) => b.key - a.key);
    const filler = scored.filter((s) => !s.matched).sort((a, b) => b.key - a.key);
    ordered = [...hits, ...filler];
  } else {
    ordered = scored.sort((a, b) => b.key - a.key);
  }

  const picked = opts.category ? ordered.slice(0, opts.depth) : spread(ordered, config.diversity.maxPerCategory, opts.depth);

  // Explanations only for what is actually returned.
  return picked.map((s) => {
    const components: Component[] = [];
    baseScore(s.listing, env, components);
    personal(s.listing, intent, weights, components);
    const { reason, reasons } = pickReasons(components, { code: 'CITY_FALLBACK', text: text.cityFallback(cityLabel) });
    return { listing: s.listing, score: s.score, base: s.base, reason, reasons, matched: s.matched };
  });
}

/** Explains a listing on base signals alone (public surfaces). */
export function explainBase(l: ListingRecord, env: ScoreEnv, fallback: Reason): { reason: Reason; reasons: string[] } {
  const components: Component[] = [];
  baseScore(l, env, components);
  return pickReasons(components, fallback);
}
