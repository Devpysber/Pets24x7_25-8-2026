// Listings index — the directory lives in the `listings` table and is read into
// memory at boot, which keeps the hot paths (phone match, search, city pages)
// allocation-free while leaving one writable copy of the data in MySQL.
//
// The JSON files under ../pets24x7_new/data are now only a fallback for a fresh
// database: if the table is empty at boot they are loaded and then written to
// MySQL, so a new environment comes up with the full directory.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { lastDigits } from '../shared/phone.js';

export interface ListingRecord {
  id: string;
  name: string;
  category: string;
  category_slug: string;
  category_icon?: string;
  city: string;
  city_slug: string;
  state?: string;
  country: 'IN' | 'US' | string;
  address?: string;
  phone?: string;
  website?: string;
  pincode?: string;
  rating: number;
  review_count: number;
  google_cid?: string;
  gmb_link?: string;
  claimStatus?: 'UNCLAIMED' | 'CLAIMED';
  /** Left out of every public API; still visible to admins and its owner. */
  hidden?: boolean;
  // Directory detail (admin form or import). Written to MySQL but NOT kept in
  // the in-memory index (see indexRecord) — they are read from the table when a
  // single listing is served. Absent means "leave the stored value alone".
  description?: string | null;
  opening_hours?: string | null;
  services?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  locality?: string | null;
}

/** The detail fields above: persisted, never held in memory. */
const DETAIL_KEYS = ['description', 'opening_hours', 'services', 'email', 'whatsapp', 'locality'] as const;

/**
 * The rating to show or rank by: a score with at least one review behind it,
 * else 0 (unknown). The same rule as has_rating() in build_pages.py. Many rows
 * keep a source score with review_count 0, which must not be presented as a
 * Google rating. The stored value is left alone; only what is shown changes.
 */
export function shownRating(l: { rating?: number | string | null; review_count?: number | string | null }): number {
  const rating = Number(l.rating) || 0;
  return rating > 0 && (Number(l.review_count) || 0) >= 1 ? rating : 0;
}

/** A listing with shownRating applied, contact details intact (owner / internal use). */
export function ownerListing<T extends ListingRecord>(l: T): T {
  const { hidden: _hidden, ...rest } = l;
  return { ...rest, rating: shownRating(l) } as T;
}

/**
 * A listing as the public API serves it. Pets24x7 works as the broker between
 * pet parents and businesses: enquiries go through the platform, so a
 * business's phone, website, street address and Google Maps ids are never
 * served to the public (they would let a visitor bypass the platform). City,
 * PIN, category, name and rating stay. Claim, admin and matching code read the
 * in-memory record directly and keep every field.
 */
export function publicListing<T extends ListingRecord>(l: T): T {
  return { ...ownerListing(l), name: publicName(l.name), address: '', phone: '', website: '', google_cid: '', gmb_link: '' } as T;
}

/** A listing name with any phone number in it removed ("… groomer) 99233 91199"). */
export function publicName(name: string): string {
  const out = String(name || '').replace(/(?:\+?\d[\s().-]?){8,}\d/g, '').replace(/[\s,|:-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  return out || String(name || '');
}

const PHONE_IN_ID = /(^|[^0-9])(?:[6-9][0-9]{4}-?[0-9]{5}|[0-9]{3}-[0-9]{3}-[0-9]{4})([^0-9]|$)/;

/** Columns the in-memory index is built from: never photos or the long text. */
const INDEX_SELECT = {
  id: true, name: true, category: true, categorySlug: true, categoryIcon: true,
  city: true, citySlug: true, state: true, country: true, address: true,
  phone: true, website: true, pincode: true, rating: true, reviewCount: true,
  googleCid: true, gmbLink: true, claimStatus: true, hidden: true,
  importedAt: true, updatedAt: true,
} as const;

// In-memory shape: map last-10-digits → list of listings (collisions exist
// because same scrape phone can be re-listed under multiple categories).
const phoneIndex = new Map<string, ListingRecord[]>();
const byId = new Map<string, ListingRecord>();
// Ids added after boot (admin imports, vendor edits). A Map iterates in
// insertion order, so anything added late sits behind 34k scraped rows and
// never reaches a capped search — these are walked first instead.
const recentIds: string[] = [];

let booted = false;
// Set when the index came from the listings table (not the JSON fallback);
// only then can startListingsSync() trust the table as the full set.
let loadedFromDb = false;
// Newest listings.updatedAt this process has seen. Prisma stamps updatedAt on
// the writing instance's clock, so the sync reads a little behind it.
let syncCursor = new Date(0);

const slugify = (value: string | undefined, fallback: string) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;

/** The city/category slug rule every writer uses (import, admin form, vendor edit). */
export const listingSlug = slugify;

// A spreadsheet round-trip turned ~580 Google CIDs into "6.60859E+18": as a
// Maps link that opens nothing. Such a CID (and a link built from it) is
// dropped on the way in and on the way out, so no page or email serves it.
const cleanCid = (cid: string | null | undefined): string | undefined => {
  const v = (cid ?? '').trim();
  return /^\d+$/.test(v) ? v : undefined;
};
const cleanGmbLink = (link: string | null | undefined): string | undefined => {
  const v = (link ?? '').trim();
  if (!v) return undefined;
  const m = /[?&]cid=([^&#]*)/.exec(v);
  return m && !/^\d+$/.test(m[1] ?? '') ? undefined : v;
};

/** listings row -> the shape every caller already expects. */
export function listingRecordFromRow(row: Parameters<typeof fromRow>[0]): ListingRecord {
  return fromRow(row);
}

function fromRow(row: {
  id: string; name: string; category: string; categorySlug: string; categoryIcon: string | null;
  city: string; citySlug: string; state: string | null; country: string; address: string | null;
  phone: string | null; website: string | null; pincode: string | null; rating: number;
  reviewCount: number; googleCid: string | null; gmbLink: string | null; claimStatus: string;
  hidden?: boolean | null;
}): ListingRecord {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    category_slug: row.categorySlug,
    ...(row.categoryIcon ? { category_icon: row.categoryIcon } : {}),
    city: row.city,
    city_slug: row.citySlug,
    ...(row.state ? { state: row.state } : {}),
    country: row.country,
    ...(row.address ? { address: row.address } : {}),
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.website ? { website: row.website } : {}),
    ...(row.pincode ? { pincode: row.pincode } : {}),
    rating: row.rating,
    review_count: row.reviewCount,
    ...(cleanCid(row.googleCid) ? { google_cid: cleanCid(row.googleCid) } : {}),
    ...(cleanGmbLink(row.gmbLink) ? { gmb_link: cleanGmbLink(row.gmbLink) } : {}),
    claimStatus: row.claimStatus === 'CLAIMED' ? 'CLAIMED' : 'UNCLAIMED',
    // An id carrying the business's phone ("…-groomer-99233-91199-…") would
    // publish the number in its URL; it is kept out of every public route.
    ...(row.hidden || PHONE_IN_ID.test(String(row.id)) ? { hidden: true } : {}),
  };
}

const optText = (v: string | null | undefined, max?: number): string | null | undefined => {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  if (!t) return null;
  return max ? t.slice(0, max) : t;
};

/** The inverse, for writing an imported or edited listing back to MySQL. */
function toRow(record: ListingRecord) {
  return {
    id: record.id.slice(0, 191),
    name: record.name.slice(0, 255),
    category: (record.category || 'Pet Service').slice(0, 160),
    categorySlug: slugify(record.category_slug || record.category, 'pet-service').slice(0, 160),
    categoryIcon: record.category_icon ? record.category_icon.slice(0, 16) : null,
    city: (record.city || 'Unknown').slice(0, 160),
    citySlug: slugify(record.city_slug || record.city, 'unknown').slice(0, 160),
    state: record.state ? record.state.slice(0, 120) : null,
    country: String(record.country || 'IN').toUpperCase().slice(0, 8),
    address: record.address ?? null,
    phone: record.phone ? record.phone.slice(0, 32) : null,
    phoneLast10: record.phone ? lastDigits(record.phone, 10) || null : null,
    website: record.website ?? null,
    pincode: record.pincode ? record.pincode.slice(0, 20) : null,
    rating: Number(record.rating) || 0,
    reviewCount: Number(record.review_count) || 0,
    googleCid: cleanCid(record.google_cid)?.slice(0, 64) ?? null,
    gmbLink: cleanGmbLink(record.gmb_link) ?? null,
    claimStatus: record.claimStatus === 'CLAIMED' ? 'CLAIMED' : 'UNCLAIMED',
    importedAt: new Date(),
    // Only what the caller set: an edit that re-writes a record from the index
    // (which holds none of these) must not wipe them.
    ...(record.hidden !== undefined ? { hidden: !!record.hidden } : {}),
    ...(record.description !== undefined ? { description: optText(record.description) } : {}),
    ...(record.opening_hours !== undefined ? { openingHours: optText(record.opening_hours) } : {}),
    ...(record.services !== undefined ? { services: optText(record.services) } : {}),
    ...(record.email !== undefined ? { email: optText(record.email, 191) } : {}),
    ...(record.whatsapp !== undefined ? { whatsapp: optText(record.whatsapp, 32) } : {}),
    ...(record.locality !== undefined ? { locality: optText(record.locality, 160) } : {}),
  };
}

// indexStats() walks the whole index; the home page and admin overview call it
// on every load. Cached until the index changes.
let statsCache: ReturnType<typeof computeIndexStats> | null = null;

function indexRecord(input: ListingRecord, recent = false): void {
  statsCache = null;
  // Detail text lives in MySQL only; 34k copies of it would sit in every
  // search walk for nothing.
  let record = input;
  if (DETAIL_KEYS.some((k) => k in input)) {
    record = { ...input };
    for (const k of DETAIL_KEYS) delete record[k];
  }
  if (!record.hidden) delete record.hidden;
  // Every way in (table, JSON fallback, import, vendor edit) passes here.
  if (record.google_cid !== undefined && !cleanCid(record.google_cid)) delete record.google_cid;
  if (record.gmb_link !== undefined && !cleanGmbLink(record.gmb_link)) delete record.gmb_link;
  // Re-indexing an id (every vendor save, every re-import) must replace the old
  // entry, not sit beside it: the stale copy stayed in its phone bucket, so a
  // claim-by-phone kept offering the old name, or the old number's owner.
  const existed = byId.has(record.id);
  if (existed) removeListingFromIndex(record.id);
  byId.set(record.id, record);
  if (recent) {
    // Only a re-index can have left an older entry behind; skip the scan at boot.
    const at = existed ? recentIds.indexOf(record.id) : -1;
    if (at >= 0) recentIds.splice(at, 1);
    recentIds.push(record.id);
  }
  if (!record.phone) return;
  const key = lastDigits(record.phone, 10);
  if (!key || key.length < 10) return;
  const bucket = phoneIndex.get(key);
  if (bucket) bucket.push(record);
  else phoneIndex.set(key, [record]);
}

export async function initListingsIndex(): Promise<void> {
  try {
    const rows = await prisma.listing.findMany({ select: INDEX_SELECT, orderBy: [{ importedAt: 'asc' }, { createdAt: 'asc' }] });
    if (rows.length > 0) {
      for (const row of rows) {
        indexRecord(fromRow(row), row.importedAt !== null);
        if (row.updatedAt > syncCursor) syncCursor = row.updatedAt;
      }
      booted = true;
      loadedFromDb = true;
      logger.info(`listings index loaded from MySQL: ${byId.size} listings · ${phoneIndex.size} distinct phones`);
      return;
    }
    logger.warn('listings table is empty — seeding it from the bundled JSON files');
  } catch (err) {
    logger.warn({ err }, 'listings table unreadable — falling back to the bundled JSON files');
  }

  await loadFromJsonFiles();
  // A fresh database gets the directory written into it, so the next boot (and
  // every other process) reads one copy from MySQL rather than these files.
  void seedTableFromIndex().catch((err) => logger.warn({ err }, 'listings table seed failed'));
}

/** Bulk-writes whatever is in memory into an empty listings table. */
async function seedTableFromIndex(): Promise<void> {
  const all = Array.from(byId.values());
  if (all.length === 0) return;
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH).map((record) => ({ ...toRow(record), importedAt: null }));
    const res = await prisma.listing.createMany({ data: chunk, skipDuplicates: true });
    written += res.count;
  }
  logger.info(`listings table seeded with ${written} rows`);
}

async function loadFromJsonFiles(): Promise<void> {
  const dir = path.resolve(env.STATIC_DATA_DIR);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    logger.warn({ err, dir }, 'listings index: data dir not found, vendor claim by phone will return empty matches');
    booted = true;
    return;
  }

  let total = 0;
  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), 'utf8');
      const arr = JSON.parse(raw) as ListingRecord[];
      // Rows written by a previous import keep their "recently added" standing
      // across restarts, so they stay visible in capped searches.
      const isImportFile = f === 'imported_listings.json';
      for (const r of arr) {
        if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') continue;
        // indexRecord replaces an id seen in an earlier file instead of
        // leaving a second copy in its phone bucket.
        indexRecord(r, isImportFile);
        if (r.phone && lastDigits(r.phone, 10).length >= 10) total++;
      }
    } catch (err) {
      logger.warn({ err, file: f }, 'listings index: skip unparseable file');
    }
  }
  booted = true;
  logger.info(`listings index loaded: ${byId.size} unique listings · ${phoneIndex.size} distinct phones · ${total} phone refs`);
}

export function findListingByPhone(phone: string): ListingRecord[] {
  if (!booted) return [];
  const k = lastDigits(phone, 10);
  if (k.length < 10) return [];
  return phoneIndex.get(k) ?? [];
}

/** Any listing, hidden or not: for admin, owner and internal lookups. */
export function getListingById(id: string): ListingRecord | undefined {
  return byId.get(id);
}

/** A listing the public may see: undefined for an unknown or hidden id. */
export function getPublicListingById(id: string): ListingRecord | undefined {
  const r = byId.get(id);
  return r && !r.hidden ? r : undefined;
}

/**
 * Listings with this name in this city, compared the way the importer's
 * duplicate check does (letters and digits only, any case). Hidden included.
 */
export function findListingsByNameCity(name: string, city: string, limit = 5): ListingRecord[] {
  const norm = (v: string) => (v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  const c = (city || '').toLowerCase().trim();
  if (!n || !c) return [];
  const out: ListingRecord[] = [];
  for (const item of byId.values()) {
    if (item.city.toLowerCase().trim() !== c) continue;
    if (norm(item.name) !== n) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Phone matches the public may see (the claim preview): hidden ones left out. */
export function findPublicListingsByPhone(phone: string): ListingRecord[] {
  return findListingByPhone(phone).filter((r) => !r.hidden);
}

/**
 * Hides or shows a listing in the running index. The caller has already
 * written listings.hidden; this only brings memory in step (and invalidates
 * the stats object, which the reco city caches key on).
 */
export function setListingHiddenInIndex(id: string, hidden: boolean): void {
  const r = byId.get(id);
  if (!r) return;
  statsCache = null;
  if (hidden) r.hidden = true;
  else delete r.hidden;
}

/**
 * Recently added/edited listings first, then the boot-time index. A generator,
 * so a search that fills its page early stops early: this used to copy all 34k
 * records into a fresh array on every newest-first request.
 */
function* iterateListings(newestFirst?: boolean): Iterable<ListingRecord> {
  if (!newestFirst || recentIds.length === 0) {
    yield* byId.values();
    return;
  }
  const seen = new Set<string>();
  for (let i = recentIds.length - 1; i >= 0; i--) {
    const id = recentIds[i]!;
    if (seen.has(id)) continue;
    const rec = byId.get(id);
    if (!rec) continue;
    seen.add(id);
    yield rec;
  }
  for (const rec of byId.values()) {
    if (!seen.has(rec.id)) yield rec;
  }
}

/** Newest-first listings, for "what was just added" views. Hidden ones left out. */
export function recentListings(limit = 24, opts: { includeHidden?: boolean } = {}): ListingRecord[] {
  const out: ListingRecord[] = [];
  const seen = new Set<string>();
  for (let i = recentIds.length - 1; i >= 0 && out.length < limit; i--) {
    const id = recentIds[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = byId.get(id);
    if (rec && (opts.includeHidden || !rec.hidden)) out.push(rec);
  }
  return out;
}

export function searchListings(opts: {
  q?: string;
  category?: string;
  city?: string;
  /** Exact city slug ("navi-mumbai"): unlike `city`, never matches a neighbouring town. */
  citySlug?: string;
  /** "IN" | "US" */
  country?: string;
  limit?: number;
  /** Matches to skip, for paging. */
  offset?: number;
  newestFirst?: boolean;
  /**
   * Hidden listings are skipped unless this is set (admin views only).
   * 'only' returns nothing but hidden ones.
   */
  includeHidden?: boolean | 'only';
}): ListingRecord[] {
  return searchListingsPage(opts).listings;
}

/** searchListings plus whether another page exists. */
export function searchListingsPage(opts: Parameters<typeof searchListings>[0]): { listings: ListingRecord[]; hasMore: boolean } {
  const q = (opts.q || '').toLowerCase().trim();
  const qDigits = /^[\d\s+()-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  const cat = (opts.category || '').toLowerCase().trim();
  const city = (opts.city || '').toLowerCase().trim();
  const citySlug = (opts.citySlug || '').toLowerCase().trim();
  const country = (opts.country || '').toUpperCase().trim();
  // Defence in depth: a caller that forgets to clamp must not be able to walk
  // the whole 34k index in one response.
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 60;
  const rawOffset = Number(opts.offset);
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), 10_000) : 0;

  // Every word must match somewhere (name, category, city or address), so
  // "grooming mumbai" or "vet bandra" works; before, the whole query had to
  // appear as one substring of a single field and those returned nothing.
  const tokens = q.split(/\s+/).filter(Boolean);

  // Duplicates are collapsed per city, not across the whole index: a name-only
  // key hid every other branch of a chain once one city had shown it.
  const seenNames = new Set<string>();
  const results: ListingRecord[] = [];
  let skipped = 0;
  let hasMore = false;
  const hiddenMode = opts.includeHidden ?? false;
  for (const item of iterateListings(opts.newestFirst)) {
    if (hiddenMode === 'only' ? !item.hidden : !hiddenMode && item.hidden) continue;
    const normName = item.name.toLowerCase().trim() + '|' + item.city.toLowerCase().trim();
    if (seenNames.has(normName)) continue;
    if (country && String(item.country || '').toUpperCase() !== country) continue;
    if (citySlug && (item.city_slug || '').toLowerCase() !== citySlug) continue;

    if (cat && cat !== 'all' && !item.category.toLowerCase().includes(cat) && !(item.category_slug || '').toLowerCase().includes(cat)) {
      continue;
    }
    // city.html passes the URL slug ("navi-mumbai"), other callers the display
    // name ("Navi Mumbai"); a name-only match dropped every multi-word city.
    if (city && city !== 'all' && !item.city.toLowerCase().includes(city) && (item.city_slug || '').toLowerCase() !== city) {
      continue;
    }
    if (q) {
      // A pasted phone number, with or without spaces or +91.
      const phoneHit = qDigits.length >= 5 && !!item.phone && String(item.phone).replace(/\D/g, '').includes(qDigits);
      if (!phoneHit) {
        const hay = `${item.name} ${item.category} ${item.city} ${item.city_slug || ''} ${item.address || ''}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) continue;
      }
    }
    seenNames.add(normName);
    if (skipped < offset) { skipped++; continue; }
    // One match past the page proves there is a next one.
    if (results.length >= limit) { hasMore = true; break; }
    results.push(item);
  }
  return { listings: results, hasMore };
}

/**
 * Type-ahead suggestions for the admin directory search. Cities and categories
 * come back as distinct values with how many listings each has, prefix matches
 * first; names come back as listings. Bounded: one pass over the index, and at
 * most `limit` rows out.
 */
export function suggestListings(
  field: 'name' | 'city' | 'category',
  term: string,
  opts: { city?: string; category?: string; limit?: number } = {},
): Array<{ value: string; count?: number; id?: string; sub?: string }> {
  const t = term.toLowerCase().trim();
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
  const cityF = (opts.city || '').toLowerCase().trim();
  const catF = (opts.category || '').toLowerCase().trim();
  const inScope = (item: ListingRecord) =>
    (!cityF || item.city.toLowerCase().includes(cityF)) &&
    (!catF || item.category.toLowerCase().includes(catF) || (item.category_slug || '').toLowerCase().includes(catF));

  if (field === 'name') {
    if (!t) return [];
    const digits = /^[\d\s+()-]+$/.test(t) ? t.replace(/\D/g, '') : '';
    const prefix: ListingRecord[] = [];
    const inner: ListingRecord[] = [];
    const seen = new Set<string>();
    for (const item of byId.values()) {
      if (!inScope(item)) continue;
      const n = item.name.toLowerCase();
      const key = n.trim() + '|' + item.city.toLowerCase();
      if (seen.has(key)) continue;
      const phoneHit = digits.length >= 5 && !!item.phone && String(item.phone).replace(/\D/g, '').includes(digits);
      if (n.startsWith(t)) { prefix.push(item); seen.add(key); }
      else if (n.includes(t) || phoneHit) { if (inner.length < limit) inner.push(item); seen.add(key); }
      if (prefix.length >= limit) break;
    }
    return [...prefix, ...inner].slice(0, limit).map((l) => ({
      value: l.name, id: l.id, sub: `${l.category} · ${l.city}`,
    }));
  }

  const counts = new Map<string, { value: string; count: number }>();
  for (const item of byId.values()) {
    if (field === 'city' ? !(!catF || item.category.toLowerCase().includes(catF)) : !(!cityF || item.city.toLowerCase().includes(cityF))) continue;
    const v = field === 'city' ? item.city : item.category;
    if (!v) continue;
    const k = v.toLowerCase();
    if (t && !k.includes(t)) continue;
    const cur = counts.get(k);
    if (cur) cur.count += 1; else counts.set(k, { value: v, count: 1 });
  }
  return [...counts.values()]
    .sort((a, b) => {
      const ap = a.value.toLowerCase().startsWith(t) ? 0 : 1;
      const bp = b.value.toLowerCase().startsWith(t) ? 0 : 1;
      return ap - bp || b.count - a.count;
    })
    .slice(0, limit);
}

/**
 * Every listing in a city, de-duplicated by name. The recommender scores these
 * itself, so unlike searchListings() this applies no ranking and no limit.
 * Hidden listings are left out: every caller (recommendations, city mails)
 * shows the result to the public.
 */
export function listingsInCity(city: string, country?: string): ListingRecord[] {
  const c = (city || '').toLowerCase().trim();
  if (!c) return [];
  const cc = (country || '').toUpperCase().trim();
  const seen = new Set<string>();
  const out: ListingRecord[] = [];
  for (const item of byId.values()) {
    if (item.hidden) continue;
    if (cc && String(item.country).toUpperCase() !== cc) continue;
    if (item.city.toLowerCase() !== c && (item.city_slug || '').toLowerCase() !== c) continue;
    // One Google business once, whether the scrape repeated it under the same
    // name or under a second category with a CID in common.
    const key = item.name.toLowerCase().trim();
    const cidKey = item.google_cid ? `cid:${item.google_cid}` : '';
    if (seen.has(key) || (cidKey && seen.has(cidKey))) continue;
    seen.add(key);
    if (cidKey) seen.add(cidKey);
    out.push(item);
  }
  return out;
}

/**
 * Public directory counters (GET /api/listings/_stats, the home and marketing
 * pages). Hidden listings are left out, like from every other public API: a
 * hidden row must not count, or put its city or category on the site. Admin
 * totals that include them use indexSize().
 */
export function indexStats() {
  if (!statsCache) statsCache = computeIndexStats();
  return statsCache;
}

/** Every listing in the index, hidden included: for admin figures. */
export function indexSize(): number {
  return byId.size;
}

function computeIndexStats() {
  const cities = new Map<string, number>();
  const categories = new Map<string, number>();
  const phones = new Set<string>();
  let listings = 0;
  for (const item of byId.values()) {
    if (item.hidden) continue;
    listings++;
    if (item.phone) {
      const key = lastDigits(item.phone, 10);
      if (key.length >= 10) phones.add(key);
    }
    if (item.city) {
      const c = item.city.trim();
      cities.set(c, (cities.get(c) || 0) + 1);
    }
    if (item.category) {
      const cat = item.category.trim();
      categories.set(cat, (categories.get(cat) || 0) + 1);
    }
  }
  const topCities = Array.from(cities.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, count]) => ({ name, count }));

  const topCategories = Array.from(categories.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count }));

  return {
    booted,
    listings,
    phones: phones.size,
    cities: cities.size || 570,
    categories: categories.size || 42,
    topCities,
    topCategories,
  };
}

/** Drops a listing from the in-memory index, for an admin deletion. */
export function removeListingFromIndex(id: string): void {
  const record = byId.get(id);
  if (!record) return;
  statsCache = null;
  byId.delete(id);
  const at = recentIds.lastIndexOf(id);
  if (at >= 0) recentIds.splice(at, 1);
  if (record.phone) {
    const key = lastDigits(record.phone, 10);
    const bucket = phoneIndex.get(key);
    if (bucket) {
      const rest = bucket.filter((r) => r.id !== id);
      if (rest.length) phoneIndex.set(key, rest);
      else phoneIndex.delete(key);
    }
  }
}

export async function addAndPersistImportedListing(record: ListingRecord): Promise<void> {
  await addAndPersistImportedListings([record]);
}

// Read-modify-write of the JSON mirror is serialised: two saves landing
// together (two vendors editing, an import during an edit) each read the old
// file and the second write dropped the first one's row.
let mirrorQueue: Promise<void> = Promise.resolve();

// Ids indexed here whose MySQL write has not finished yet (a count, since two
// imports can carry the same id). The sync's deletion pass would otherwise
// see them missing from the table mid-import and drop them from the index.
const persistInFlight = new Map<string, number>();

function markPersisting(ids: string[], delta: 1 | -1): void {
  for (const id of ids) {
    const n = (persistInFlight.get(id) ?? 0) + delta;
    if (n > 0) persistInFlight.set(id, n);
    else persistInFlight.delete(id);
  }
}

/**
 * Bulk form for imports. Indexes every record, writes MySQL in chunked
 * transactions, and rewrites the JSON mirror once — the single-row version
 * re-read and re-wrote the whole (growing) file per row, so a 10k-row import
 * did 10k full rewrites and timed the request out.
 */
export async function addAndPersistImportedListings(records: ListingRecord[]): Promise<void> {
  if (records.length === 0) return;
  markPersisting(records.map((r) => r.id), 1);
  for (const record of records) indexRecord(record, true);

  // MySQL is the system of record now.
  const CHUNK = 200;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((record) => {
          const row = toRow(record);
          const { id: _id, ...rest } = row;
          return prisma.listing.upsert({ where: { id: row.id }, update: rest, create: row });
        }),
      );
    } catch (err) {
      logger.warn({ err, from: i, count: chunk.length }, 'failed to persist listings to MySQL');
    } finally {
      markPersisting(chunk.map((r) => r.id), -1);
    }
  }

  // The JSON mirror is kept so a database-less environment still boots with
  // whatever was imported.
  await updateJsonMirror((current) => {
    const pos = new Map<string, number>();
    current.forEach((x, i) => pos.set(x.id, i));
    for (const record of records) {
      const idx = pos.get(record.id);
      if (idx !== undefined) current[idx] = record;
      else { pos.set(record.id, current.length); current.push(record); }
    }
    return current;
  });
}

/**
 * The mirror row for a record: what the index holds, nothing more. The detail
 * fields are never read back from the file (indexRecord drops them), so
 * writing them only left business email addresses, WhatsApp numbers and
 * descriptions in a file that lives in the site's data directory.
 */
function mirrorRow(record: ListingRecord): ListingRecord {
  const row = { ...record };
  for (const k of DETAIL_KEYS) delete row[k];
  if (!row.hidden) delete row.hidden;
  return row;
}

/**
 * Read-modify-write of STATIC_DATA_DIR/imported_listings.json, serialised on
 * mirrorQueue. `mutate` gets the current rows and returns the new list, or
 * null when nothing changed (then the file is left alone, and a missing file
 * is not created). Failures are logged, never thrown: MySQL is the record.
 */
async function updateJsonMirror(mutate: (rows: ListingRecord[]) => ListingRecord[] | null): Promise<void> {
  const run = mirrorQueue.then(async () => {
    try {
      const targetFile = path.join(path.resolve(env.STATIC_DATA_DIR), 'imported_listings.json');
      let current: ListingRecord[] = [];
      try {
        const parsed = JSON.parse(await readFile(targetFile, 'utf8'));
        current = Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.id === 'string') : [];
      } catch {
        current = [];
      }
      const next = mutate(current);
      if (!next) return;
      await writeFile(targetFile, JSON.stringify(next.map(mirrorRow), null, 2), 'utf8');
    } catch (err) {
      logger.warn({ err }, 'failed to persist imported listings to JSON file');
    }
  });
  mirrorQueue = run;
  await run;
}

/** Drops a deleted listing from the JSON mirror (a DB-less boot reads it). */
export async function removeListingFromJsonMirror(id: string): Promise<void> {
  await updateJsonMirror((rows) => {
    const rest = rows.filter((r) => r.id !== id);
    return rest.length === rows.length ? null : rest;
  });
}

/** Brings a hide/unhide into the JSON mirror, for a listing it holds. */
export async function setListingHiddenInJsonMirror(id: string, hidden: boolean): Promise<void> {
  await updateJsonMirror((rows) => {
    const row = rows.find((r) => r.id === id);
    if (!row || !!row.hidden === hidden) return null;
    if (hidden) row.hidden = true;
    else delete row.hidden;
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Cross-instance freshness
// ---------------------------------------------------------------------------
// Every write above updates this process's index and MySQL. With several API
// instances the others only learn about it here: each tick pulls rows whose
// updatedAt moved and re-indexes the ones that actually changed, and when the
// table holds fewer rows than the index it drops ids that are gone (an admin
// deletion). On one server there is nothing to learn, so it stays off unless
// REDIS_URL or LISTINGS_SYNC_MS says otherwise.

// updatedAt comes from the writing instance's clock and a slow transaction can
// commit after a newer one, so each tick re-reads this far behind the cursor.
// Rows in that window that match the index are skipped, so re-reading them
// does not touch the index (or bump indexVersion() for the reco caches).
const SYNC_OVERLAP_MS = 5 * 60_000;
const SYNC_PAGE_ROWS = 2_000;

const sameRecord = (a: ListingRecord, b: ListingRecord): boolean =>
  a.name === b.name && a.category === b.category && a.category_slug === b.category_slug &&
  (a.category_icon ?? '') === (b.category_icon ?? '') && a.city === b.city && a.city_slug === b.city_slug &&
  (a.state ?? '') === (b.state ?? '') && a.country === b.country && (a.address ?? '') === (b.address ?? '') &&
  (a.phone ?? '') === (b.phone ?? '') && (a.website ?? '') === (b.website ?? '') &&
  (a.pincode ?? '') === (b.pincode ?? '') && Number(a.rating) === Number(b.rating) &&
  Number(a.review_count) === Number(b.review_count) && (a.google_cid ?? '') === (b.google_cid ?? '') &&
  (a.gmb_link ?? '') === (b.gmb_link ?? '') && (a.claimStatus ?? 'UNCLAIMED') === (b.claimStatus ?? 'UNCLAIMED') &&
  !!a.hidden === !!b.hidden;

let syncRunning = false;

/** One pass of the cross-instance sync. Exported for tests. */
export async function syncListingsFromDb(): Promise<{ updated: number; removed: number }> {
  if (!loadedFromDb || syncRunning) return { updated: 0, removed: 0 };
  syncRunning = true;
  try {
    let updated = 0;
    const since = new Date(syncCursor.getTime() - SYNC_OVERLAP_MS);
    // Paged, so a large import (thousands of rows stamped within seconds) is
    // read in full rather than the same first page every tick.
    let after: string | undefined;
    for (;;) {
      const rows = await prisma.listing.findMany({
        select: INDEX_SELECT,
        where: { updatedAt: { gt: since } },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: SYNC_PAGE_ROWS,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      });
      for (const row of rows) {
        if (row.updatedAt > syncCursor) syncCursor = row.updatedAt;
        const next = fromRow(row);
        const current = byId.get(row.id);
        if (current && sameRecord(current, next)) continue;
        indexRecord(next, row.importedAt !== null);
        updated++;
      }
      if (rows.length < SYNC_PAGE_ROWS) break;
      after = rows[rows.length - 1]!.id;
    }

    let removed = 0;
    const total = await prisma.listing.count();
    if (total < byId.size) {
      // Taken before the read: an id whose chunk commits after the read but
      // before this loop is missing from `ids` and already out of the map.
      const writing = new Set(persistInFlight.keys());
      const ids = new Set((await prisma.listing.findMany({ select: { id: true } })).map((r) => r.id));
      for (const id of Array.from(byId.keys())) {
        // Still being written by an import on this instance: not a deletion.
        if (!ids.has(id) && !writing.has(id) && !persistInFlight.has(id)) {
          removeListingFromIndex(id);
          removed++;
        }
      }
    }
    if (updated || removed) logger.info({ updated, removed }, 'listings index synced from MySQL');
    return { updated, removed };
  } finally {
    syncRunning = false;
  }
}

let syncTimer: NodeJS.Timeout | null = null;

/**
 * Starts the periodic pull (see above). `intervalMs` defaults to
 * LISTINGS_SYNC_MS, else 60s with REDIS_URL, else off. Returns whether it runs.
 */
export function startListingsSync(intervalMs = env.LISTINGS_SYNC_MS ?? (env.REDIS_URL ? 60_000 : 0)): boolean {
  if (syncTimer || intervalMs <= 0) return false;
  if (!loadedFromDb) {
    logger.warn('listings sync not started: the index was loaded from the JSON files, not MySQL');
    return false;
  }
  syncTimer = setInterval(() => {
    void syncListingsFromDb().catch((err) => logger.warn({ err }, 'listings index sync failed'));
  }, Math.max(5_000, intervalMs));
  syncTimer.unref?.();
  logger.info(`listings index sync every ${Math.round(Math.max(5_000, intervalMs) / 1000)}s`);
  return true;
}
