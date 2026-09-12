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
}

// In-memory shape: map last-10-digits → list of listings (collisions exist
// because same scrape phone can be re-listed under multiple categories).
const phoneIndex = new Map<string, ListingRecord[]>();
const byId = new Map<string, ListingRecord>();
// Ids added after boot (admin imports, vendor edits). A Map iterates in
// insertion order, so anything added late sits behind 34k scraped rows and
// never reaches a capped search — these are walked first instead.
const recentIds: string[] = [];

let booted = false;

const slugify = (value: string | undefined, fallback: string) =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;

/** listings row -> the shape every caller already expects. */
function fromRow(row: {
  id: string; name: string; category: string; categorySlug: string; categoryIcon: string | null;
  city: string; citySlug: string; state: string | null; country: string; address: string | null;
  phone: string | null; website: string | null; pincode: string | null; rating: number;
  reviewCount: number; googleCid: string | null; gmbLink: string | null; claimStatus: string;
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
    ...(row.googleCid ? { google_cid: row.googleCid } : {}),
    ...(row.gmbLink ? { gmb_link: row.gmbLink } : {}),
    claimStatus: row.claimStatus === 'CLAIMED' ? 'CLAIMED' : 'UNCLAIMED',
  };
}

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
    googleCid: record.google_cid ? record.google_cid.slice(0, 64) : null,
    gmbLink: record.gmb_link ?? null,
    claimStatus: record.claimStatus === 'CLAIMED' ? 'CLAIMED' : 'UNCLAIMED',
    importedAt: new Date(),
  };
}

function indexRecord(record: ListingRecord, recent = false): void {
  byId.set(record.id, record);
  if (recent) recentIds.push(record.id);
  if (!record.phone) return;
  const key = lastDigits(record.phone, 10);
  if (!key || key.length < 10) return;
  const bucket = phoneIndex.get(key);
  if (bucket) bucket.push(record);
  else phoneIndex.set(key, [record]);
}

export async function initListingsIndex(): Promise<void> {
  try {
    const rows = await prisma.listing.findMany({ orderBy: [{ importedAt: 'asc' }, { createdAt: 'asc' }] });
    if (rows.length > 0) {
      for (const row of rows) indexRecord(fromRow(row), row.importedAt !== null);
      booted = true;
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
        byId.set(r.id, r);
        if (isImportFile) recentIds.push(r.id);
        if (!r.phone) continue;
        const k = lastDigits(r.phone, 10);
        if (!k || k.length < 10) continue;
        const bucket = phoneIndex.get(k);
        if (bucket) bucket.push(r);
        else phoneIndex.set(k, [r]);
        total++;
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

export function getListingById(id: string): ListingRecord | undefined {
  return byId.get(id);
}

/** Recently added/edited listings first, then the boot-time index. */
function iterateListings(newestFirst?: boolean): Iterable<ListingRecord> {
  if (!newestFirst || recentIds.length === 0) return byId.values();
  const seen = new Set<string>();
  const out: ListingRecord[] = [];
  for (let i = recentIds.length - 1; i >= 0; i--) {
    const id = recentIds[i]!;
    if (seen.has(id)) continue;
    const rec = byId.get(id);
    if (!rec) continue;
    seen.add(id);
    out.push(rec);
  }
  for (const rec of byId.values()) {
    if (seen.has(rec.id)) continue;
    out.push(rec);
  }
  return out;
}

/** Newest-first listings, for "what was just added" views. */
export function recentListings(limit = 24): ListingRecord[] {
  const out: ListingRecord[] = [];
  const seen = new Set<string>();
  for (let i = recentIds.length - 1; i >= 0 && out.length < limit; i--) {
    const id = recentIds[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = byId.get(id);
    if (rec) out.push(rec);
  }
  return out;
}

export function searchListings(opts: { q?: string; category?: string; city?: string; limit?: number; newestFirst?: boolean }): ListingRecord[] {
  const q = (opts.q || '').toLowerCase().trim();
  const qDigits = /^[\d\s+()-]+$/.test(q) ? q.replace(/\D/g, '') : '';
  const cat = (opts.category || '').toLowerCase().trim();
  const city = (opts.city || '').toLowerCase().trim();
  // Defence in depth: a caller that forgets to clamp must not be able to walk
  // the whole 34k index in one response.
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 60;

  const seenNames = new Set<string>();
  const results: ListingRecord[] = [];
  for (const item of iterateListings(opts.newestFirst)) {
    const normName = item.name.toLowerCase().trim();
    if (seenNames.has(normName)) continue;

    if (cat && cat !== 'all' && !item.category.toLowerCase().includes(cat) && !(item.category_slug || '').toLowerCase().includes(cat)) {
      continue;
    }
    if (city && city !== 'all' && !item.city.toLowerCase().includes(city)) {
      continue;
    }
    if (q) {
      const match = item.name.toLowerCase().includes(q) ||
                    item.category.toLowerCase().includes(q) ||
                    item.city.toLowerCase().includes(q) ||
                    (item.address && item.address.toLowerCase().includes(q)) ||
                    // A pasted phone number, with or without spaces or +91.
                    (qDigits.length >= 5 && !!item.phone && String(item.phone).replace(/\D/g, '').includes(qDigits));
      if (!match) continue;
    }
    seenNames.add(normName);
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
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
 */
export function listingsInCity(city: string, country?: string): ListingRecord[] {
  const c = (city || '').toLowerCase().trim();
  if (!c) return [];
  const cc = (country || '').toUpperCase().trim();
  const seen = new Set<string>();
  const out: ListingRecord[] = [];
  for (const item of byId.values()) {
    if (cc && String(item.country).toUpperCase() !== cc) continue;
    if (item.city.toLowerCase() !== c && (item.city_slug || '').toLowerCase() !== c) continue;
    const key = item.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function indexStats() {
  const cities = new Map<string, number>();
  const categories = new Map<string, number>();
  for (const item of byId.values()) {
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
    listings: byId.size,
    phones: phoneIndex.size,
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
  byId.delete(id);
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
  indexRecord(record, true);

  // MySQL is the system of record now.
  try {
    const row = toRow(record);
    const { id: _id, ...rest } = row;
    await prisma.listing.upsert({ where: { id: row.id }, update: rest, create: row });
  } catch (err) {
    logger.warn({ err, id: record.id }, 'failed to persist listing to MySQL');
  }

  // The JSON mirror is kept so a database-less environment still boots with
  // whatever was imported.
  try {
    const dir = path.resolve(env.STATIC_DATA_DIR);
    const targetFile = path.join(dir, 'imported_listings.json');
    let current: ListingRecord[] = [];
    try {
      const raw = await readFile(targetFile, 'utf8');
      current = JSON.parse(raw);
    } catch {
      current = [];
    }
    const idx = current.findIndex((x) => x.id === record.id);
    if (idx >= 0) {
      current[idx] = record;
    } else {
      current.push(record);
    }
    await writeFile(targetFile, JSON.stringify(current, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err }, 'failed to persist imported listing to JSON file');
  }
}

