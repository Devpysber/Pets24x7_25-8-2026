// Listings index — loaded into memory at boot from ../pets24x7_new/data/*.json
// Powers the vendor-claim phone-match flow without putting 34k rows in Postgres.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
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
}

// In-memory shape: map last-10-digits → list of listings (collisions exist
// because same scrape phone can be re-listed under multiple categories).
const phoneIndex = new Map<string, ListingRecord[]>();
const byId = new Map<string, ListingRecord>();

let booted = false;

export async function initListingsIndex(): Promise<void> {
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
      for (const r of arr) {
        byId.set(r.id, r);
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

export function searchListings(opts: { q?: string; category?: string; city?: string; limit?: number }): ListingRecord[] {
  const q = (opts.q || '').toLowerCase().trim();
  const cat = (opts.category || '').toLowerCase().trim();
  const city = (opts.city || '').toLowerCase().trim();
  // Defence in depth: a caller that forgets to clamp must not be able to walk
  // the whole 34k index in one response.
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 60;

  const seenNames = new Set<string>();
  const results: ListingRecord[] = [];
  for (const item of byId.values()) {
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
                    (item.address && item.address.toLowerCase().includes(q));
      if (!match) continue;
    }
    seenNames.add(normName);
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
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
  return { booted, listings: byId.size, phones: phoneIndex.size };
}
