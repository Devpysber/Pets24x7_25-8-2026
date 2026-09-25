// Surface adapters — each recommendation surface is a thin shape over the one
// engine: forParent (dashboard, email digest), parentFeed (deals + events),
// forListing (listing page widgets), forCity (home, city/category pages,
// search sponsored card).
//
// Every response carries a rid. The full ranked list (max 60) is kept under it
// for 15 minutes so "Show more" slices a stable order instead of re-ranking,
// and so /api/reco/events can verify that a beacon names a listing this
// response really served.

import { prisma } from '../../db.js';
import type { ListingRecord } from '../../listings/index.js';
import { getListingById, indexStats, shownRating } from '../../listings/index.js';
import { genKey, invalidateAllResults, recoCache } from './cache.js';
import { getRecoConfig, weightsFor, type RecoConfig } from './config.js';
import { cityListings, findCity, indexVersion, isRecentlyAdded, neighbourCities, topCitiesForCountry } from './city-index.js';
import {
  blendSponsored,
  recordDelivery,
  recordExposure,
  sponsoredCandidates,
  variantFor,
  type BlendItem,
} from './blend.js';
import {
  buildIntent,
  categoryRanked,
  cityDerived,
  EMPTY_INTENT,
  explainBase,
  rank,
  spread,
  type Intent,
  type ParentHistory,
  type PetSignal,
  type ScoreEnv,
} from './engine.js';
import { lookupRid, registerRid, type RidItem, type Surface } from './events.js';
import { text, type Reason, type ReasonCode } from './reasons.js';
import { ensureSignals, refreshSignals, type Snapshot } from './signals.js';
import {
  DAY_MS,
  areaPrefix,
  decodeCursor,
  encodeCursor,
  randomRid,
  round1,
  sha1,
  siteBase,
  slugify,
  withBudget,
} from './util.js';

export const MAX_DEPTH = 60;
/**
 * Largest page any surface serves. A thin city is topped up to this many
 * regardless of the request's own limit: the ranked list is cached under a key
 * without the limit, so topping up to the first caller's limit left every later
 * caller asking for more with a short list until the cache expired.
 */
const MAX_PAGE = 24;

export type Fallback = null | 'no_history' | 'default_city' | 'expanded_state' | 'expanded_country' | 'rid_expired';

export interface RecoItem {
  id: string;
  name: string;
  category: string;
  category_slug: string;
  category_icon: string | null;
  city: string;
  city_slug: string;
  state: string | null;
  country: string;
  address: string | null;
  phone: string | null;
  rating: number;
  review_count: number;
  claimed: boolean;
  url: string;
  website: string | null;
  score: number;
  pos: number;
  sponsored: boolean;
  label: string | null;
  featuredId: string | null;
  reason: Reason;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// DTO helpers
// ---------------------------------------------------------------------------

function listingPath(l: ListingRecord): string {
  return `/${String(l.country || 'IN').toLowerCase()}/${l.city_slug}/${l.id}/`;
}

/** Outbound vendor site with UTM, so the vendor sees Pets24x7 in their own analytics. */
function websiteWithUtm(raw: string | undefined, surface: Surface): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.searchParams.has('utm_source')) {
    u.searchParams.set('utm_source', 'pets24x7');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', `reco_${surface}`);
  }
  return u.toString();
}

export function toItem(b: BlendItem, pos: number, surface: Surface, snap: Snapshot, label: string): RecoItem {
  const l = b.listing;
  return {
    id: l.id,
    name: l.name,
    category: l.category,
    category_slug: l.category_slug,
    category_icon: l.category_icon ?? null,
    city: l.city,
    city_slug: l.city_slug,
    state: l.state ?? null,
    country: String(l.country),
    address: l.address ?? null,
    phone: l.phone ?? null,
    rating: shownRating(l),
    review_count: Number(l.review_count) || 0,
    claimed: snap.approvedClaimed.has(l.id) || l.claimStatus === 'CLAIMED',
    url: `${listingPath(l)}?src=reco_${surface}`,
    website: websiteWithUtm(l.website, surface),
    score: round1(b.score),
    pos,
    sponsored: b.sponsored,
    label: b.sponsored ? label : null,
    featuredId: b.featuredId,
    reason: b.reason,
    reasons: b.reasons,
  };
}

function ridItems(items: RecoItem[], surface?: Surface): Record<string, RidItem> {
  const out: Record<string, RidItem> = {};
  for (const it of items) {
    out[it.id] = {
      pos: it.pos,
      reason: it.reason.code,
      sponsored: it.sponsored,
      featuredId: it.featuredId,
      ...(surface ? { surface } : {}),
    };
  }
  return out;
}

/** Counts sponsored exposure for the page actually returned (never for bots). */
function markServed(page: RecoItem[], viewerKey: string, track = true): void {
  if (!track) return;
  for (const it of page) {
    if (!it.sponsored || !it.featuredId) continue;
    recordExposure(viewerKey, it.featuredId);
    recordDelivery(it.featuredId);
  }
}

const BUCKET_MS = 300_000;
function publicRid(parts: Array<string | number | null | undefined>): string {
  return sha1(`${parts.join('|')}|${Math.floor(Date.now() / BUCKET_MS)}`).slice(0, 16);
}

function normCountry(v: string | null | undefined): 'IN' | 'US' {
  return String(v ?? '').toUpperCase() === 'US' ? 'US' : 'IN';
}

// ---------------------------------------------------------------------------
// City resolution + fallback chain
// ---------------------------------------------------------------------------

interface ResolvedCity {
  city: string;
  label: string;
  citySlug: string;
  state: string | null;
  fallback: Fallback;
}

function describeCity(city: string, country: string): ResolvedCity | null {
  const listings = cityListings(city, country);
  if (listings.length === 0) return null;
  const first = listings[0]!;
  const info = findCity(city, country);
  return { city, label: first.city, citySlug: first.city_slug, state: first.state ?? info?.state ?? null, fallback: null };
}

/** Query city → parent's city → configured fallback → the country's biggest city. */
export function resolveCity(candidates: Array<string | null | undefined>, country: string, config: RecoConfig): ResolvedCity {
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (!v) continue;
    const r = describeCity(v, country);
    if (r) return r;
  }
  const cc = normCountry(country);
  const fb = describeCity(config.fallbackCity[cc], cc);
  if (fb) return { ...fb, fallback: 'default_city' };
  const top = topCitiesForCountry(cc, 1)[0];
  if (top) {
    const r = describeCity(top.city, cc) ?? describeCity(top.citySlug, cc);
    if (r) return { ...r, fallback: 'default_city' };
  }
  const name = (candidates.find((c) => (c ?? '').trim()) ?? config.fallbackCity[cc]).trim();
  return { city: name, label: name, citySlug: slugify(name), state: null, fallback: 'default_city' };
}

/**
 * Tops a thin list up from the same state (NEAR_CITY), then from the country's
 * biggest cities. Returns the fallback that applied, if any.
 */
function topUp(
  list: BlendItem[],
  target: number,
  where: ResolvedCity,
  country: string,
  rankIn: (city: string, need: number) => BlendItem[],
): Fallback {
  if (list.length >= target) return null;
  const have = new Set(list.map((x) => x.listing.id));
  let fallback: Fallback = null;
  for (const n of neighbourCities(country, where.state, where.citySlug, 3)) {
    for (const it of rankIn(n.city, target - list.length)) {
      if (have.has(it.listing.id)) continue;
      have.add(it.listing.id);
      list.push({ ...it, reason: { code: 'NEAR_CITY', text: text.nearCity(where.label) }, reasons: [text.nearCity(where.label), ...it.reasons.slice(0, 1)] });
      fallback = 'expanded_state';
      if (list.length >= target) return fallback;
    }
  }
  for (const c of topCitiesForCountry(country, 4)) {
    if (c.citySlug === where.citySlug) continue;
    for (const it of rankIn(c.city, target - list.length)) {
      if (have.has(it.listing.id)) continue;
      have.add(it.listing.id);
      const t = text.cityFallback(it.listing.city);
      list.push({ ...it, reason: { code: 'CITY_FALLBACK', text: t }, reasons: [t, ...it.reasons.slice(0, 1)] });
      fallback = 'expanded_country';
      if (list.length >= target) return fallback;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Parent surface
// ---------------------------------------------------------------------------

export interface ParentRequest {
  parentId: string | null;
  petId?: string;
  city?: string;
  country?: string;
  category?: string;
  limit: number;
  cursor?: string;
  viewerKey: string;
  surface?: 'parent_home' | 'email_digest';
  /** Listings to leave out (the digest's recently mailed ids). */
  excludeIds?: string[];
  /** Overrides config.sponsored.maxPerList (the digest allows one). */
  maxSponsored?: number;
  /** False for crawlers: serve the list but count no sponsored exposure. */
  track?: boolean;
}

export interface ParentResponse {
  ok: true;
  surface: Surface;
  rid: string;
  variant: 'A' | 'B';
  generatedAt: string;
  city: string;
  country: string;
  personalised: boolean;
  fallback: Fallback;
  sponsoredCount: number;
  items: RecoItem[];
  nextCursor: string | null;
  basedOn: { pets: Array<{ id: string; name: string; species: string }>; enquiries: number; saved: number; viewed: number };
}

type ParentMeta = Omit<ParentResponse, 'items' | 'nextCursor' | 'sponsoredCount' | 'rid'>;

interface ParentOrganic {
  organic: BlendItem[];
  intent: Intent;
  meta: ParentMeta;
  resolved: ResolvedCity;
}

async function loadParent(parentId: string, petId?: string) {
  const [parent, pets, enquiries, saved, viewed] = await Promise.all([
    withBudget(
      prisma.petParent.findUnique({ where: { id: parentId }, select: { city: true, country: true } }),
      null,
    ),
    withBudget(
      prisma.pet.findMany({
        where: { ownerId: parentId, ...(petId ? { id: petId } : {}) },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true, name: true, species: true, breed: true, ageYears: true, vaccinated: true, lastVaccinatedAt: true },
      }),
      [],
    ),
    withBudget(
      prisma.enquiry.findMany({
        where: { petParentId: parentId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { listingId: true, category: true, createdAt: true },
      }),
      [],
    ),
    withBudget(
      prisma.savedListing.findMany({
        where: { parentId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { listingId: true, category: true, listingName: true, createdAt: true },
      }),
      [],
    ),
    withBudget(
      prisma.listingActivity.findMany({
        where: { parentId, kind: 'listing_view' },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: { listingId: true, category: true, createdAt: true },
      }),
      [],
    ),
  ]);
  return { parent, pets, enquiries, saved, viewed };
}

async function parentOrganic(req: ParentRequest, config: RecoConfig, snap: Snapshot, variant: 'A' | 'B'): Promise<ParentOrganic> {
  const surface: Surface = req.surface ?? 'parent_home';
  const loaded = req.parentId
    ? await loadParent(req.parentId, req.petId)
    : { parent: null, pets: [], enquiries: [], saved: [], viewed: [] };

  const country = normCountry(req.country || loaded.parent?.country);
  const resolved = resolveCity([req.city, loaded.parent?.city], country, config);

  const pets: PetSignal[] = loaded.pets.map((p) => ({
    species: String(p.species),
    breed: p.breed,
    ageYears: p.ageYears,
    vaccinated: p.vaccinated,
    name: p.name,
    lastVaccinatedAt: p.lastVaccinatedAt,
  }));
  const history: ParentHistory = {
    enquiries: loaded.enquiries,
    saved: loaded.saved,
    viewed: loaded.viewed,
  };
  const intent = req.parentId ? buildIntent(pets, history) : EMPTY_INTENT;
  const weights = weightsFor(config, variant);
  // The digest never mails a place the parent already enquired about or saved:
  // on the dashboard those are only demoted (seenPenalty), but in an email they
  // read as "we recommend what you already have".
  const excludeList = [...(req.excludeIds ?? []), ...(surface === 'email_digest' ? intent.known : [])];
  const exclude = excludeList.length ? new Set(excludeList) : undefined;
  // Signed-in parents get a per-day exploration seed so near-ties rotate
  // between visits (and between digests) instead of repeating verbatim.
  const jitterSeed = req.parentId ? `${req.parentId}|${Math.floor(Date.now() / DAY_MS)}` : undefined;

  const rankIn = (city: string, depth: number): BlendItem[] =>
    rank({ city, country, category: req.category, intent, weights, config, snap, depth, excludeIds: exclude, cityLabel: city, jitterSeed }).map((s) => ({
      listing: s.listing,
      score: s.score,
      reason: s.reason,
      reasons: s.reasons,
      sponsored: false,
      featuredId: null,
    }));

  const organic = rankIn(resolved.city, MAX_DEPTH).map((it) => ({ ...it }));
  // The fallback-city label reads better than a generic reason.
  if (resolved.fallback === 'default_city') {
    for (const it of organic) {
      if (it.reason.code === 'CITY_FALLBACK') it.reason = { code: 'CITY_FALLBACK', text: text.cityFallback(resolved.label) };
    }
  }
  let fallback: Fallback = resolved.fallback;
  const thin = topUp(organic, MAX_PAGE, resolved, country, rankIn);
  if (!fallback && thin) fallback = thin;
  if (!fallback && !intent.hasSignals) fallback = 'no_history';

  return {
    organic,
    intent,
    resolved,
    meta: {
      ok: true,
      surface,
      variant,
      generatedAt: new Date().toISOString(),
      city: resolved.label,
      country,
      personalised: Boolean(req.parentId && (loaded.pets.length || loaded.enquiries.length || loaded.saved.length || loaded.viewed.length)),
      fallback,
      basedOn: {
        pets: loaded.pets.map((p) => ({ id: p.id, name: p.name, species: String(p.species) })),
        enquiries: loaded.enquiries.length,
        saved: loaded.saved.length,
        viewed: loaded.viewed.length,
      },
    },
  };
}

export async function forParent(req: ParentRequest): Promise<ParentResponse> {
  const config = await getRecoConfig();
  const snap = await ensureSignals();
  const limit = Math.max(1, Math.min(24, req.limit));

  // "Show more": slice the list this rid already ranked.
  const cur = decodeCursor(req.cursor);
  if (cur) {
    const entry = await lookupRid<RecoItem, ParentMeta>(cur.rid);
    if (entry?.list && entry.meta) {
      const page = entry.list.slice(cur.offset, cur.offset + limit);
      markServed(page, req.viewerKey, req.track);
      const end = cur.offset + limit;
      return {
        ...entry.meta,
        rid: cur.rid,
        items: page,
        sponsoredCount: page.filter((i) => i.sponsored).length,
        nextCursor: end < entry.list.length ? encodeCursor(cur.rid, end) : null,
      };
    }
  }

  const variant = variantFor(req.viewerKey, config);
  const surface: Surface = req.surface ?? 'parent_home';
  const key = req.parentId
    ? `parent:${req.parentId}:${req.petId ?? '-'}:${(req.city ?? '').toLowerCase()}:${req.country ?? ''}:${req.category ?? '-'}:${variant}:${surface}:${Math.floor(Date.now() / DAY_MS)}`
    : `anon:${normCountry(req.country)}:${(req.city ?? '').toLowerCase()}:${req.category ?? '-'}:${variant}`;
  const ttl = req.parentId ? config.cacheTtlSec.parent : config.cacheTtlSec.public;
  const base = req.excludeIds?.length
    ? await parentOrganic(req, config, snap, variant)
    : await recoCache.wrap(
        await genKey(`${key}:${indexVersion()}:${snap.version}`, req.parentId ? [`parent:${req.parentId}`] : []),
        ttl,
        () => parentOrganic(req, config, snap, variant),
      );

  const rid = randomRid();
  const seed = `${req.viewerKey}|${Math.floor(Date.now() / BUCKET_MS)}`;
  const exclude = new Set<string>([...base.intent.known, ...(req.excludeIds ?? [])]);
  const picks = sponsoredCandidates(
    {
      citySlug: base.resolved.citySlug,
      categorySlug: req.category ?? null,
      relevant: base.intent.hasSignals ? base.intent.relevant : null,
      viewerKey: req.viewerKey,
      seed,
      exclude,
    },
    snap,
    config,
  );
  const blendConfig =
    req.maxSponsored != null
      ? { ...config, sponsored: { ...config.sponsored, maxPerList: Math.min(config.sponsored.maxPerList, req.maxSponsored) } }
      : config;
  const blended = blendSponsored(base.organic, picks, blendConfig, limit).slice(0, MAX_DEPTH);
  const items = blended.map((b, i) => toItem(b, i + 1, surface, snap, config.sponsored.label));
  // A cursor whose rid expired is re-ranked, but continues at its offset
  // rather than silently restarting at page one (which repeated every card
  // already on screen under "Show more").
  const meta: ParentMeta = {
    ...base.meta,
    surface,
    variant,
    generatedAt: new Date().toISOString(),
    ...(cur ? { fallback: 'rid_expired' as const } : {}),
  };

  registerRid(rid, { surface, variant, items: ridItems(items), list: items, meta });

  const start = cur ? Math.min(cur.offset, items.length) : 0;
  const page = items.slice(start, start + limit);
  if (surface !== 'email_digest') markServed(page, req.viewerKey, req.track);
  return {
    ...meta,
    rid,
    items: page,
    sponsoredCount: page.filter((i) => i.sponsored).length,
    nextCursor: items.length > start + limit ? encodeCursor(rid, start + limit) : null,
  };
}

// ---------------------------------------------------------------------------
// Parent feed: deals + events ranked for this parent.
// ---------------------------------------------------------------------------

export interface FeedDeal {
  id: string;
  title: string;
  description: string;
  offerLabel: string;
  category: string | null;
  city: string | null;
  code: string | null;
  endsAt: Date | null;
  vendor: string | null;
  listingId: string | null;
  url: string | null;
  reason: { code: 'PET_NEED' | 'SAVED_SIMILAR' | 'ENDING_SOON' | 'NEARBY'; text: string };
}

export interface FeedEvent {
  id: string;
  title: string;
  description: string;
  venue: string | null;
  city: string | null;
  startsAt: Date;
  endsAt: Date | null;
  rsvpUrl: string | null;
  bannerUrl: string | null;
  vendor: string | null;
  reason: { code: 'NEARBY' | 'THIS_WEEK'; text: string };
}

function ownSiteUtm(url: string | null, campaign: string): string | null {
  if (!url) return null;
  const base = siteBase();
  if (!(url === base || url.startsWith(`${base}/`) || url.startsWith('/'))) return url;
  if (/[?&]utm_source=/.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}utm_source=pets24x7&utm_medium=feed&utm_campaign=${encodeURIComponent(campaign)}`;
}

export async function parentFeed(opts: {
  parentId: string | null;
  city?: string;
  country?: string;
  limit: number;
}): Promise<{ ok: true; surface: 'parent_feed'; rid: string; city: string; deals: FeedDeal[]; events: FeedEvent[] }> {
  const config = await getRecoConfig();
  const loaded = opts.parentId
    ? await loadParent(opts.parentId)
    : { parent: null, pets: [], enquiries: [], saved: [], viewed: [] };
  const country = normCountry(opts.country || loaded.parent?.country);
  const resolved = resolveCity([opts.city, loaded.parent?.city], country, config);
  const citySlug = resolved.citySlug;
  const now = new Date();
  const limit = Math.max(1, Math.min(12, opts.limit));

  const intent = opts.parentId
    ? buildIntent(
        loaded.pets.map((p) => ({ species: String(p.species), ageYears: p.ageYears, vaccinated: p.vaccinated, name: p.name, lastVaccinatedAt: p.lastVaccinatedAt })),
        { enquiries: loaded.enquiries, saved: loaded.saved, viewed: loaded.viewed },
      )
    : EMPTY_INTENT;

  const [deals, events] = await Promise.all([
    withBudget(
      prisma.deal.findMany({
        where: {
          status: 'ACTIVE',
          citySlug,
          startsAt: { lte: now },
          OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        },
        orderBy: [{ endsAt: 'asc' }, { createdAt: 'desc' }],
        take: 50,
        include: { vendor: { select: { businessName: true, listingId: true } } },
      }),
      [],
      1500,
    ),
    withBudget(
      prisma.event.findMany({
        where: { status: 'PUBLISHED', citySlug, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        take: limit,
        include: { vendor: { select: { businessName: true } } },
      }),
      [],
      1500,
    ),
  ]);

  const matchIn = (map: Map<string, unknown>, category: string | null): boolean => {
    if (!category) return false;
    const s = slugify(category);
    if (!s) return false;
    for (const k of map.keys()) if (k === s || k.includes(s) || s.includes(k)) return true;
    return false;
  };

  const rankedDeals = deals
    .map((d) => {
      const listingId = d.listingId ?? d.vendor?.listingId ?? null;
      const l = listingId ? getListingById(listingId) : undefined;
      const cat = d.category ?? l?.category ?? null;
      let reason: FeedDeal['reason'];
      let w = 0;
      if (matchIn(intent.need, cat)) {
        const n = [...intent.need.entries()].find(([k]) => { const s = slugify(cat); return k === s || k.includes(s) || s.includes(k); })?.[1];
        reason = { code: 'PET_NEED', text: text.petNeed(n?.petName ?? null, n?.why ?? 'matches what your pet needs') };
        w = 3;
      } else if (matchIn(intent.saved, cat) || matchIn(intent.affinity, cat)) {
        reason = { code: 'SAVED_SIMILAR', text: `Matches ${String(cat).toLowerCase()} you looked at` };
        w = 2;
      } else if (d.endsAt && d.endsAt.getTime() - now.getTime() < 7 * DAY_MS) {
        reason = { code: 'ENDING_SOON', text: 'Ends this week' };
        w = 1;
      } else {
        reason = { code: 'NEARBY', text: `In ${resolved.label}` };
      }
      return {
        w,
        ends: d.endsAt ? d.endsAt.getTime() : Number.MAX_SAFE_INTEGER,
        deal: {
          id: d.id,
          title: d.title,
          description: d.description,
          offerLabel: d.offerLabel,
          category: d.category,
          city: d.city,
          code: d.code,
          endsAt: d.endsAt,
          vendor: d.vendor?.businessName ?? null,
          listingId,
          url: l ? `${listingPath(l)}?src=reco_parent_feed` : null,
          reason,
        } satisfies FeedDeal,
      };
    })
    .sort((a, b) => b.w - a.w || a.ends - b.ends)
    .slice(0, limit)
    .map((x) => x.deal);

  const weekAhead = now.getTime() + 7 * DAY_MS;
  const rankedEvents: FeedEvent[] = events.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    venue: e.venue,
    city: e.city,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    rsvpUrl: ownSiteUtm(e.rsvpUrl, 'reco_parent_feed'),
    bannerUrl: e.bannerUrl,
    vendor: e.vendor?.businessName ?? null,
    reason:
      e.startsAt.getTime() < weekAhead
        ? { code: 'THIS_WEEK', text: 'This week' }
        : { code: 'NEARBY', text: `In ${resolved.label}` },
  }));

  return { ok: true, surface: 'parent_feed', rid: randomRid(), city: resolved.label, deals: rankedDeals, events: rankedEvents };
}

// ---------------------------------------------------------------------------
// Listing page widgets
// ---------------------------------------------------------------------------

export interface ListingResponse {
  ok: true;
  rid: string;
  listingId: string;
  similar: RecoItem[];
  nearby: RecoItem[];
  sponsored: RecoItem | null;
}

function baseEnv(config: RecoConfig, snap: Snapshot, maxTaps: number): ScoreEnv {
  return { weights: config.weights, config, snap, maxTaps };
}

export async function forListing(id: string, limitIn: number, viewerKey: string, track = true): Promise<ListingResponse | null> {
  const l = getListingById(id);
  if (!l || l.hidden) return null;
  const config = await getRecoConfig();
  const snap = await ensureSignals();
  const limit = Math.max(1, Math.min(12, limitIn));
  const cc = String(l.country || 'IN').toUpperCase();

  const organic = await recoCache.wrap(
    await genKey(`listing:${id}:${limit}:${indexVersion()}:${snap.version}`),
    config.cacheTtlSec.public,
    async () => {
      const d = cityDerived(l.city_slug || l.city, cc, config.weights, config, snap);
      const env = baseEnv(config, snap, d.maxTaps);

      const similar: BlendItem[] = [];
      for (const c of categoryRanked(d, l.city_slug || l.city, cc, l.category_slug)) {
        if (c.id === l.id) continue;
        const ex = explainBase(c, env, { code: 'SAME_CATEGORY', text: text.sameCategory(l.category, l.city) });
        const keep = ex.reason.code === 'TOP_RATED' || ex.reason.code === 'POPULAR_NEARBY';
        const reason: Reason = keep ? ex.reason : { code: 'SAME_CATEGORY', text: text.sameCategory(l.category, l.city) };
        similar.push({ listing: c, score: d.base.get(c.id) ?? 0, reason, reasons: [reason.text, ...ex.reasons.filter((t) => t !== reason.text).slice(0, 2)], sponsored: false, featuredId: null });
        if (similar.length >= limit + 1) break; // one spare, in case the sponsored card displaces one
      }

      // "Also nearby": other categories, same PIN/ZIP first, then its area, then the city's best.
      const pin = (l.pincode ?? '').replace(/\s/g, '');
      const area = areaPrefix(pin);
      // Every tier is capped: only `limit` survive spread(), and explaining
      // every same-area listing of a big city made a cache miss needlessly slow.
      const cap = limit * 4;
      const tiers: ListingRecord[][] = [[], [], []];
      for (const c of d.ranked) {
        if (c.id === l.id || c.category_slug === l.category_slug) continue;
        const cp = (c.pincode ?? '').replace(/\s/g, '');
        const t = pin && cp === pin ? 0 : area && areaPrefix(cp) === area ? 1 : 2;
        if (tiers[t]!.length < cap) tiers[t]!.push(c);
        if (tiers[0]!.length >= cap) break; // enough of the best tier already
      }
      const nearbyAll: BlendItem[] = [];
      for (const [i, tier] of tiers.entries()) {
        for (const c of tier) {
          const t = i < 2 && c.pincode ? text.sameArea(c.pincode.replace(/\s/g, '')) : text.sameArea(c.city);
          const ex = explainBase(c, env, { code: 'SAME_AREA', text: t });
          nearbyAll.push({
            listing: c,
            score: d.base.get(c.id) ?? 0,
            reason: { code: 'SAME_AREA', text: t },
            reasons: [t, ...ex.reasons.filter((x) => x !== t).slice(0, 1)],
            sponsored: false,
            featuredId: null,
          });
        }
      }
      return { similar, nearby: spread(nearbyAll, 2, limit) };
    },
  );

  const rid = publicRid(['listing', id, limit]);
  const pick = sponsoredCandidates(
    { citySlug: l.city_slug, categorySlug: l.category_slug, relevant: null, viewerKey, seed: rid, exclude: new Set([l.id]) },
    snap,
    config,
  )[0];

  let sponsored: RecoItem | null = null;
  let similarBlend = organic.similar;
  if (pick) {
    const at = similarBlend.find((x) => x.listing.id === pick.listing.id);
    const reason: Reason = { code: 'SPONSORED', text: config.sponsored.label };
    sponsored = toItem(
      { listing: pick.listing, score: at?.score ?? 0, reason, reasons: [config.sponsored.label], sponsored: true, featuredId: pick.featured.featuredId },
      1,
      'listing_similar',
      snap,
      config.sponsored.label,
    );
    similarBlend = similarBlend.filter((x) => x.listing.id !== pick.listing.id);
  }
  const offset = sponsored ? 1 : 0;
  const similar = similarBlend.slice(0, limit).map((b, i) => toItem(b, i + 1 + offset, 'listing_similar', snap, config.sponsored.label));
  const nearby = organic.nearby.map((b, i) => toItem(b, i + 1, 'listing_nearby', snap, config.sponsored.label));

  registerRid(rid, {
    surface: 'listing_similar',
    variant: 'A',
    items: {
      ...ridItems(nearby, 'listing_nearby'),
      ...ridItems(similar, 'listing_similar'),
      ...(sponsored ? ridItems([sponsored], 'listing_similar') : {}),
    },
  });
  if (sponsored) markServed([sponsored], viewerKey, track);
  return { ok: true, rid, listingId: l.id, similar, nearby, sponsored };
}

// ---------------------------------------------------------------------------
// City / category / home surface
// ---------------------------------------------------------------------------

export interface CityRequest {
  city?: string;
  country?: string;
  category?: string;
  sort: 'top' | 'popular' | 'new';
  limit: number;
  cursor?: string;
  sponsored: boolean;
  surface: 'city_top' | 'home_top' | 'search_sponsored';
  viewerKey: string;
  /** False for crawlers: serve the list but count no sponsored exposure. */
  track?: boolean;
}

export interface CityResponse {
  ok: true;
  surface: Surface;
  rid: string;
  city: string;
  country: string;
  category: string | null;
  sort: 'top' | 'popular' | 'new';
  fallback: Fallback;
  sponsoredCount: number;
  items: RecoItem[];
  nextCursor: string | null;
}

type CityMeta = Omit<CityResponse, 'rid' | 'items' | 'nextCursor' | 'sponsoredCount'>;

export async function forCity(req: CityRequest): Promise<CityResponse> {
  const config = await getRecoConfig();
  const snap = await ensureSignals();
  const limit = Math.max(1, Math.min(24, req.limit));
  const surface: Surface = req.surface;

  const cur = decodeCursor(req.cursor);
  if (cur) {
    const entry = await lookupRid<RecoItem, CityMeta>(cur.rid);
    if (entry?.list && entry.meta) {
      const page = entry.list.slice(cur.offset, cur.offset + limit);
      markServed(page, req.viewerKey, req.track);
      const end = cur.offset + limit;
      return {
        ...entry.meta,
        rid: cur.rid,
        items: page,
        sponsoredCount: page.filter((i) => i.sponsored).length,
        nextCursor: end < entry.list.length ? encodeCursor(cur.rid, end) : null,
      };
    }
  }

  const country = normCountry(req.country);
  const resolved = resolveCity([req.city], country, config);
  const category = req.category ? slugify(req.category) || req.category.toLowerCase() : null;

  const organicRes = await recoCache.wrap(
    await genKey(`city:${country}:${resolved.city.toLowerCase()}:${category ?? '-'}:${req.sort}:${indexVersion()}:${snap.version}`),
    config.cacheTtlSec.public,
    async () => {
      const rankIn = (city: string, depth: number): BlendItem[] => {
        const d = cityDerived(city, country, config.weights, config, snap);
        const env = baseEnv(config, snap, d.maxTaps);
        let pool = category ? categoryRanked(d, city, country, category) : d.ranked;
        if (req.sort === 'popular') {
          pool = [...pool].sort(
            (a, b) => (snap.taps30d.get(b.id) ?? 0) - (snap.taps30d.get(a.id) ?? 0) || (d.base.get(b.id) ?? 0) - (d.base.get(a.id) ?? 0),
          );
        } else if (req.sort === 'new') {
          pool = [...pool].sort(
            (a, b) => Number(isRecentlyAdded(b.id)) - Number(isRecentlyAdded(a.id)) || (d.base.get(b.id) ?? 0) - (d.base.get(a.id) ?? 0),
          );
        }
        const head = pool.slice(0, depth * 3).map((c) => {
          const ex = explainBase(c, env, { code: 'CITY_FALLBACK', text: text.cityFallback(c.city) });
          return { listing: c, score: d.base.get(c.id) ?? 0, reason: ex.reason, reasons: ex.reasons, sponsored: false, featuredId: null } as BlendItem;
        });
        return category ? head.slice(0, depth) : spread(head, config.diversity.maxPerCategory, depth);
      };
      const organic = rankIn(resolved.city, MAX_DEPTH);
      const thin = topUp(organic, MAX_PAGE, resolved, country, rankIn);
      return { organic, thin };
    },
  );

  const fallback: Fallback = cur ? 'rid_expired' : resolved.fallback ?? organicRes.thin;
  const rid = publicRid([surface, country, resolved.city.toLowerCase(), category, req.sort, limit, req.sponsored ? 1 : 0]);
  const picks = req.sponsored
    ? sponsoredCandidates({ citySlug: resolved.citySlug, categorySlug: category, relevant: null, viewerKey: req.viewerKey, seed: rid }, snap, config)
    : [];
  const blended = blendSponsored(organicRes.organic, picks, config, limit).slice(0, MAX_DEPTH);
  const items = blended.map((b, i) => toItem(b, i + 1, surface, snap, config.sponsored.label));
  const meta: CityMeta = { ok: true, surface, city: resolved.label, country, category, sort: req.sort, fallback };
  registerRid(rid, { surface, variant: 'A', items: ridItems(items), list: items, meta });

  // An expired cursor continues at its offset over the fresh ranking.
  const start = cur ? Math.min(cur.offset, items.length) : 0;
  const page = items.slice(start, start + limit);
  markServed(page, req.viewerKey, req.track);
  return {
    ...meta,
    rid,
    items: page,
    sponsoredCount: page.filter((i) => i.sponsored).length,
    nextCursor: items.length > start + limit ? encodeCursor(rid, start + limit) : null,
  };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Rebuilds the snapshot and drops every cached result. */
export async function rebuildReco(): Promise<{ snapshotAt: string | null; listings: number; featuredLive: number; durationMs: number }> {
  const started = Date.now();
  const snap = await refreshSignals();
  invalidateAllResults();
  return {
    snapshotAt: snap.at ? snap.at.toISOString() : null,
    listings: indexStats().listings,
    featuredLive: snap.featuredLive.size,
    durationMs: Date.now() - started,
  };
}

export type { ReasonCode };
