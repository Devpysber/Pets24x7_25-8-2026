// Small helpers shared by every layer of the recommendation engine.

import { createHash, randomBytes } from 'node:crypto';

import { env } from '../../env.js';

export const DAY_MS = 24 * 3600 * 1000;

/** Contact taps: a decision, as opposed to a view. Same list /api/listings/popular uses. */
export const CONTACT_KINDS = ['phone_click', 'whatsapp_click', 'website_click'];

/**
 * Same slugify the static data and build_pages.py use for categories, so an
 * enquiry that stored "Pet Grooming & Spa" joins the listing's
 * "pet-grooming-spa".
 */
export function slugify(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[(),]/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Looser variant (keeps "&" as a separator); some rows were written with it. */
export function slugifyLoose(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Every key a category can be matched on. */
export function categoryKeys(slug: string | null | undefined, name?: string | null): string[] {
  const out = new Set<string>();
  for (const v of [slug, name]) {
    if (!v) continue;
    const a = slugify(v);
    const b = slugifyLoose(v);
    if (a) out.add(a);
    if (b) out.add(b);
  }
  return [...out];
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** 32-bit unsigned FNV-1a, for deterministic bucketing (A/B, rotation). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform (0,1) from a string, deterministic. */
export function unitHash(s: string): number {
  return (hash32(s) + 0.5) / 4294967296;
}

export function randomRid(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Anonymous viewer identity for frequency caps and de-duplication: a salted,
 * truncated hash of IP + user agent. Never stored against a person.
 */
export function viewerKeyFor(parentId: string | null | undefined, ip?: string, ua?: string): string {
  if (parentId) return `p:${parentId}`;
  return `a:${createHash('sha256').update(`${env.JWT_SECRET}:reco:${ip ?? ''}|${ua ?? ''}`).digest('hex').slice(0, 24)}`;
}

/**
 * Runs a DB read under a time budget. A slow or offline database degrades the
 * request to "no personal signals" instead of hanging it.
 */
export async function withBudget<T>(p: Promise<T>, fallback: T, ms = 800): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight of a day, the value a @db.Date column stores. */
export function dayDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** ISO week label, e.g. "2026-W39", for the digest's utm_campaign. */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** First 3 characters of a 6-digit PIN or 5-digit ZIP: the local area. */
export function areaPrefix(pincode: string | null | undefined): string | null {
  const d = String(pincode ?? '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 3) : null;
}

export function siteBase(): string {
  return env.PUBLIC_SITE_URL.replace(/\/+$/, '');
}

export function encodeCursor(rid: string, offset: number): string {
  return Buffer.from(JSON.stringify({ rid, offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): { rid: string; offset: number } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof v?.rid === 'string' && /^[a-f0-9]{16}$/.test(v.rid) && Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= 60) {
      return { rid: v.rid, offset: v.offset };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Crawlers, link unfurlers, uptime checks and headless tooling. Their requests
 * are still served (search engines should see the rails), but they must not
 * count as impressions, clicks or sponsored exposure: a crawl of every city
 * page would otherwise burn paid slots' daily caps and skew CTR.
 */
const BOT_UA =
  /bot\b|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|httpclient|go-http-client|axios\/|node-fetch|java\//i;

export function isBotUA(ua: string | null | undefined): boolean {
  const s = String(ua ?? '');
  return s.length === 0 || BOT_UA.test(s);
}
