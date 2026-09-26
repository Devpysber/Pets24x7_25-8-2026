// City buckets over the in-memory listings index.
//
// listingsInCity() walks all ~35k listings on every call. The recommender used
// to call it on every request; here each city's bucket (and its per-category
// sub-map) is built once and reused until the index changes. The index has no
// version counter of its own, but indexStats() hands back the same cached
// object until a mutation clears it, so a new object identity means "the
// directory changed" — checked at most every CHECK_MS.
//
// A proper byCity bucket inside listings/index.ts would remove even the first
// walk per city; until then this keeps the steady-state cost at O(city).

import { prisma } from '../../db.js';
import { indexStats, listingsInCity, recentListings, type ListingRecord } from '../../listings/index.js';
import { slugify } from './util.js';

const CHECK_MS = 15_000;
const MAX_CITIES = 400;

let version = 0;
let lastStats: unknown = null;
let lastCheck = 0;

interface Bucket {
  listings: ListingRecord[];
  byCategory: Map<string, ListingRecord[]> | null;
}

const buckets = new Map<string, Bucket>();
let recentSet: { version: number; ids: Set<string> } | null = null;

/** Bumped whenever the listings index changed; part of every derived cache key. */
export function indexVersion(): number {
  const now = Date.now();
  if (now - lastCheck >= CHECK_MS) {
    lastCheck = now;
    const s = indexStats();
    if (s !== lastStats) {
      lastStats = s;
      version++;
      buckets.clear();
      recentSet = null;
    }
  }
  return version;
}

// The scraped directory files human businesses under pet categories: the
// Vaccination Centers category is mostly CVS MinuteClinics, VA clinics and
// maternity hospitals; Physiotherapy, Therapy, Dental and Labs are half human
// physio, counselling, dentistry and Quest/Labcorp; Pet Taxi carries city cab
// firms. scripts/hide-non-pet-listings.mjs hides the unmistakable ones from
// the site (keep its word lists in step with these). A recommendation is held
// to a higher bar: in the categories dominated by human businesses a pick
// needs a pet word in its name; elsewhere only obvious human medicine drops.
const PET_WORDS = /(pets?\b|vet(?!eran)|veterinar|animal|dogs?\b|doggie|doggy|cats?\b|kitty|kitten|canine|k-?9|feline|paws?|pup|bark|woof|wag|mutt|hound|kennel|groom|fetch|furr?y?\b|fur\b|whisker|purr|meow|tail|birds?\b|avian|parrot|aquari|fish|reptile|exotic|zoo|livestock|cattle|poultry|equine|horse|rescue|sanctuary|shelter|spca|humane|dvm|petco|petsmart|critter|bunny|rabbit)/i;
const HUMAN_MEDICINE = /\b(patholog\w*|sonograph\w*|maternity|gyna?ec\w*|obstetric\w*|ivf|infertility|nursing home|diabet\w*|health cent(?:re|er)|multi-?speciality|paediatric\w*|pediatric\w*|physician|urolog\w*|cardiolog\w*|orthopa?edic\w*|pregnancy|uphc|primary health|endocrinolog\w*|laparoscop\w*|dermatolog\w*|neurolog\w*|oncolog\w*|polyclinic|urgent care|minuteclinic|physiotherap\w*|physical therap\w*|chiropract\w*|labcorp|quest diagnostics|dentist\w*|dental clinic|orthodont\w*|cryo\w*|counsel\w*|psychiatr\w*|psycholog\w*|lpc|lcsw)\b/i;
const PET_WORD_REQUIRED = new Set([
  'vaccination-centers',
  'pet-physiotherapy-rehab',
  'pet-therapy-services',
  'pet-taxi-transport',
  'veterinary-labs-diagnostics',
  'pet-dental-care',
  'pet-relocation-services',
]);

export function isRecommendable(l: ListingRecord): boolean {
  const name = l.name || '';
  if (PET_WORDS.test(name)) return true;
  const cat = (l.category_slug || slugify(l.category)).toLowerCase();
  if (PET_WORD_REQUIRED.has(cat)) return false;
  return !HUMAN_MEDICINE.test(name);
}

function bucketFor(city: string, country: string): Bucket {
  indexVersion();
  const key = `${country.toUpperCase()}|${city.toLowerCase().trim()}`;
  let b = buckets.get(key);
  if (b) {
    buckets.delete(key);
    buckets.set(key, b);
    return b;
  }
  b = { listings: listingsInCity(city, country).filter(isRecommendable), byCategory: null };
  buckets.set(key, b);
  while (buckets.size > MAX_CITIES) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
  return b;
}

/** Every listing in a city (deduped by name), served from the bucket. */
export function cityListings(city: string, country: string): ListingRecord[] {
  if (!city) return [];
  return bucketFor(city, country).listings;
}

/** A city's listings in one category (matched on category_slug). */
export function cityCategoryListings(city: string, country: string, categorySlug: string): ListingRecord[] {
  if (!city || !categorySlug) return [];
  const b = bucketFor(city, country);
  if (!b.byCategory) {
    const m = new Map<string, ListingRecord[]>();
    for (const l of b.listings) {
      const k = (l.category_slug || slugify(l.category)).toLowerCase();
      const arr = m.get(k);
      if (arr) arr.push(l);
      else m.set(k, [l]);
    }
    b.byCategory = m;
  }
  return b.byCategory.get(categorySlug.toLowerCase()) ?? [];
}

/** Listings added or edited most recently (imports, vendor edits). */
export function isRecentlyAdded(id: string): boolean {
  const v = indexVersion();
  if (!recentSet || recentSet.version !== v) {
    recentSet = { version: v, ids: new Set(recentListings(500).map((l) => l.id)) };
  }
  return recentSet.ids.has(id);
}

// ---------------------------------------------------------------------------
// City catalogue: which cities exist per country, their state and size. Used
// for the "no city on file" fallback and the thin-city top-up from the same
// state. Refreshed with the signals snapshot; one small groupBy.
// ---------------------------------------------------------------------------

export interface CityInfo {
  city: string;
  citySlug: string;
  state: string | null;
  country: string;
  count: number;
}

let catalogue: CityInfo[] = [];

export async function refreshCityCatalogue(): Promise<void> {
  try {
    const groupBy = prisma.listing.groupBy as unknown as (args: unknown) => Promise<unknown>;
    const rows = (await groupBy({
      by: ['country', 'state', 'city', 'citySlug'],
      _count: { _all: true },
    })) as Array<{ country: string; state: string | null; city: string; citySlug: string; _count: { _all: number } }>;
    // One row per (country, citySlug): the same city can appear with two
    // spellings of its state, and those must not count as two cities.
    const merged = new Map<string, CityInfo>();
    for (const r of rows) {
      const key = `${String(r.country).toUpperCase()}|${r.citySlug}`;
      const cur = merged.get(key);
      if (cur) {
        cur.count += r._count._all;
        if (!cur.state && r.state) cur.state = r.state;
      } else {
        merged.set(key, {
          city: r.city,
          citySlug: r.citySlug,
          state: r.state,
          country: String(r.country).toUpperCase(),
          count: r._count._all,
        });
      }
    }
    if (merged.size > 0) catalogue = [...merged.values()].sort((a, b) => b.count - a.count);
  } catch {
    // Keep the last good catalogue.
  }
}

/** Largest cities in a country, biggest first. */
export function topCitiesForCountry(country: string, n = 1): CityInfo[] {
  const cc = country.toUpperCase();
  const fromDb = catalogue.filter((c) => c.country === cc).slice(0, n);
  if (fromDb.length) return fromDb;
  // No catalogue yet (DB offline at boot): fall back to the index's own top
  // cities, keeping only those that exist in this country.
  const out: CityInfo[] = [];
  for (const c of indexStats().topCities) {
    const listings = cityListings(c.name, cc);
    if (listings.length === 0) continue;
    const first = listings[0]!;
    out.push({ city: first.city, citySlug: first.city_slug, state: first.state ?? null, country: cc, count: listings.length });
    if (out.length >= n) break;
  }
  return out;
}

/** Other cities in the same state, biggest first. */
export function neighbourCities(country: string, state: string | null | undefined, exceptSlug: string, n = 3): CityInfo[] {
  if (!state) return [];
  const cc = country.toUpperCase();
  const st = state.toLowerCase().trim();
  return catalogue
    .filter((c) => c.country === cc && c.citySlug !== exceptSlug && (c.state ?? '').toLowerCase().trim() === st)
    .slice(0, n);
}

/** Resolves a display name or slug to the catalogue entry, when known. */
export function findCity(city: string, country: string): CityInfo | null {
  const cc = country.toUpperCase();
  const c = city.toLowerCase().trim();
  const slug = slugify(city);
  return catalogue.find((x) => x.country === cc && (x.citySlug === c || x.citySlug === slug || x.city.toLowerCase() === c)) ?? null;
}

/** Country of a city by name, for trend rows (null when ambiguous/unknown). */
export function countryOfCity(city: string): string | null {
  const c = city.toLowerCase().trim();
  const hits = catalogue.filter((x) => x.city.toLowerCase() === c);
  return hits.length === 1 ? hits[0]!.country : hits[0]?.country ?? null;
}
