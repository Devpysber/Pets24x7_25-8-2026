// Writes the static site's listing data from the `listings` table, so the
// pages build_pages.py renders are what the admin panel shows — not whatever
// data/*.json happened to be committed last.
//
//   node scripts/export-listings-static.mjs [--out DIR] [--index FILE]
//        [--media-dir DIR] [--media-url PREFIX] [--dry-run] [--allow-empty]
//
//   --out DIR        per-city files: DIR/<cc>-<city-slug>.json
//                    (default: ../pets24x7_new/data, the site's data dir)
//   --index FILE     the city index + featured strip, window.PETS_INDEX /
//                    window.PETS_FEATURED (default: DIR/../pets-data.js)
//   --media-dir DIR  photos stored in the DB as data URLs are written here as
//                    content-hashed files (default: DIR/../media/listings)
//   --media-url P    public URL prefix of --media-dir (default /media/listings/)
//   --dry-run        read everything, write nothing; print what would change
//   --allow-empty    permit an export with zero listings (otherwise refused:
//                    it would delete every city file)
//   --trust-counts   publish review counts as stored, even ones matching the
//                    invented-count formula of old builds (see below)
//
// Output is exactly the shape build_data.py writes and build_pages.py,
// city.html and listing.html read, plus optional detail keys (locality,
// description, opening_hours, services, whatsapp (claimed only), photos, claimed) that
// are only present when they hold something — a row without them is
// byte-identical to what build_data.py produced.
//
// Deterministic: rows, cities and keys are sorted with total orders, and a file
// is only rewritten when its bytes change, so an unchanged table leaves every
// file (and its mtime) alone.
//
// Hidden listings are left out. A city whose last listing is hidden or deleted
// loses its <cc>-<slug>.json. Other files in the data dir
// (imported_listings.json) are never touched.
//
// Reads DATABASE_URL like every other script here. Prisma falls back to
// pets24x7_api/.env when the variable is unset, so the target host is printed
// before anything is read.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Arguments -------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, allowEmpty: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--out') opts.out = val();
    else if (a === '--index') opts.index = val();
    else if (a === '--media-dir') opts.mediaDir = val();
    else if (a === '--media-url') opts.mediaUrl = val();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--allow-empty') opts.allowEmpty = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--trust-counts') opts.trustCounts = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  opts.out = path.resolve(opts.out ?? path.join(__dirname, '..', '..', 'pets24x7_new', 'data'));
  opts.index = path.resolve(opts.index ?? path.join(opts.out, '..', 'pets-data.js'));
  opts.mediaDir = path.resolve(opts.mediaDir ?? path.join(opts.out, '..', 'media', 'listings'));
  opts.mediaUrl = opts.mediaUrl ?? '/media/listings/';
  if (!opts.mediaUrl.endsWith('/')) opts.mediaUrl += '/';
  return opts;
}

// ---- Constants mirrored from build_data.py / build_pages.py ----------------

const BATCH = 2000;          // listings per keyset page
const DETAIL_BATCH = 20;     // rows per fetch of the heavy columns (photos, images)
const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_SERVICES = 30;
const THIN_CITY_MAX = 5;     // build_data.py: cities under this are noindex
const FEATURED_MAX = 24;
const APPROVED_VENDOR = new Set(['ACTIVE', 'CLAIMED']); // src/shared/vendor-status.ts

// Icons by category slug, from build_data.py CATEGORY_RULES, for rows whose
// categoryIcon column is empty (admin imports, self-registrations).
const CATEGORY_ICON = {
  'emergency-animal-hospital': '🚑',
  'veterinary-labs-diagnostics': '🔬',
  'vaccination-centers': '💉',
  'mobile-vet-services': '🚐',
  'pet-dental-care': '🦷',
  'pet-physiotherapy-rehab': '🩹',
  'specialty-vets-exotics-avian-reptiles': '🦜',
  'veterinary-clinics': '🩺',
  'pet-boarding-daycare': '🏠',
  'pet-grooming-spa': '🛁',
  'pet-walking': '🐕',
  'pet-sitting-in-home-care': '🛏️',
  'pet-training-obedience-behavior': '🎓',
  'pet-relocation-services': '✈️',
  'pet-taxi-transport': '🚕',
  'pet-therapy-services': '💖',
};

// Keys every row carries, in build_data.py's order. Optional detail keys follow.
const BASE_KEYS = ['id', 'name', 'category', 'category_icon', 'category_slug', 'city', 'city_slug', 'state',
  'country', 'address', 'phone', 'website', 'pincode', 'rating', 'review_count', 'google_cid', 'gmb_link', 'active'];

const IMAGE_TYPES = {
  'image/jpeg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/jpg': { ext: 'jpg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', ok: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: 'webp', ok: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  'image/gif': { ext: 'gif', ok: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
};
const MEDIA_FILE = /^[0-9a-f]{20}\.(jpg|png|webp|gif)$/;
const CITY_FILE = /^(in|us)-[a-z0-9-]+\.json$/;

// ---- Small helpers ---------------------------------------------------------

const str = (v) => (v == null ? '' : String(v)).trim();
const slugify = (v) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const truthy = (v) => v === true || v === 1 || v === 1n || v === '1' || (Buffer.isBuffer(v) && v[0] === 1);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function cleanCid(v) {
  const s = str(v);
  return /^\d+$/.test(s) ? s : '';
}
function cleanGmbLink(v, cid) {
  const s = str(v);
  if (s) {
    const m = /[?&]cid=([^&#]*)/.exec(s);
    if (!m || /^\d+$/.test(m[1] ?? '')) return s;
  }
  return cid ? `https://www.google.com/maps?cid=${cid}` : '';
}

/** JSON column or JSON-in-text: whatever the driver hands back. */
function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (s[0] === '[' || s[0] === '{' || s[0] === '"') {
      try { return JSON.parse(s); } catch { return s; }
    }
    return s;
  }
  return v;
}

function cleanText(v, max) {
  const s = str(v).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/** services: JSON array, or free text split on lines / commas / semicolons / bullets. */
function parseServices(v) {
  const j = parseJsonish(v);
  let parts = [];
  if (Array.isArray(j)) parts = j.map((x) => (typeof x === 'object' && x ? (x.name ?? x.title ?? '') : x));
  else if (typeof j === 'string') parts = j.split(/[\n,;•|]+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const s = str(p).replace(/^[-*·\s]+/, '').replace(/\s+/g, ' ').slice(0, 80).trim();
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

/** opening hours: free text, or a {day: hours} / [{day, hours}] structure. */
function parseHours(v) {
  const j = parseJsonish(v);
  if (j == null) return '';
  if (typeof j === 'string') return cleanText(j, 1000);
  const lines = [];
  if (Array.isArray(j)) {
    for (const x of j) {
      if (typeof x === 'string') lines.push(x);
      else if (x && typeof x === 'object') {
        const day = str(x.day ?? x.days ?? x.label);
        const hrs = str(x.hours ?? x.time ?? (x.open && x.close ? `${x.open}–${x.close}` : x.closed ? 'Closed' : ''));
        if (day || hrs) lines.push(day && hrs ? `${day}: ${hrs}` : day || hrs);
      }
    }
  } else if (typeof j === 'object') {
    for (const [day, hrs] of Object.entries(j)) lines.push(`${day}: ${str(typeof hrs === 'object' ? JSON.stringify(hrs) : hrs)}`);
  }
  return cleanText(lines.map(str).filter(Boolean).join('\n'), 1000);
}

function cleanWhatsapp(v) {
  const d = str(v).replace(/[^0-9]/g, '');
  return d.length >= 10 && d.length <= 15 ? d : '';
}
function cleanUrlish(v) {
  const s = str(v);
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^\/(?!\/)[^\s"'<>]*$/.test(s)) return s; // site-relative, never protocol-relative
  return '';
}

/** Photo list from a JSON column / JSON text / single string. */
function photoSources(v) {
  const j = parseJsonish(v);
  if (j == null) return [];
  const arr = Array.isArray(j) ? j : [j];
  return arr
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? (x.url ?? x.src ?? '') : ''))
    .map(str)
    .filter(Boolean);
}

// ---- Media: data URLs become content-hashed files -------------------------

// Handled a batch at a time (resolveAllPhotos): each batch's photos are
// decoded, new files written, and the buffers dropped before the next batch
// is read. Only URL strings and the set of referenced names live for the whole
// run. Holding every decoded photo until the end (plus the data URLs they came
// from) grew to ~1.75x the photo bytes of the whole table, which a directory
// with a few thousand photographed listings does not fit in.
class Media {
  constructor(dir, urlPrefix, dryRun) {
    this.dir = dir;
    this.urlPrefix = urlPrefix;
    this.dryRun = dryRun;
    this.referenced = new Set();
    this.pending = new Map(); // filename -> Buffer, until the next writePending()
    this.onDisk = null;       // content-hashed names present before this run
    this.res = { written: 0, removed: 0, kept: 0 };
    this.rejected = 0;
  }
  async init() {
    let existing = [];
    try { existing = (await readdir(this.dir)).filter((f) => MEDIA_FILE.test(f)); } catch { /* none yet */ }
    this.onDisk = new Set(existing);
  }
  /** A public URL for this photo source, or '' when it cannot be published. */
  resolve(src) {
    if (!src) return '';
    if (!src.startsWith('data:')) return cleanUrlish(src);
    const m = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(src);
    const type = m && IMAGE_TYPES[m[1].toLowerCase()];
    if (!type) { this.rejected++; return ''; }
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length < 16 || buf.length > MAX_PHOTO_BYTES || !type.ok(buf)) { this.rejected++; return ''; }
    const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 20)}.${type.ext}`;
    if (!this.referenced.has(name)) {
      this.referenced.add(name);
      this.pending.set(name, buf);
    }
    return this.urlPrefix + name;
  }
  /** Writes the photos first seen since the last call, then lets go of them. */
  async writePending() {
    if (!this.onDisk) await this.init();
    for (const [name, buf] of this.pending) {
      if (this.onDisk.has(name)) { this.res.kept++; continue; } // content-hashed: same name, same bytes
      this.res.written++;
      if (!this.dryRun) {
        await mkdir(this.dir, { recursive: true });
        await atomicWrite(path.join(this.dir, name), buf);
      }
    }
    this.pending.clear();
  }
  /** Last step: removes files no record references any more. */
  async flush() {
    await this.writePending();
    for (const name of this.onDisk) {
      if (this.referenced.has(name)) continue;
      this.res.removed++;
      if (!this.dryRun) await unlink(path.join(this.dir, name)).catch(() => {});
    }
    return { ...this.res };
  }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// ---- Database --------------------------------------------------------------

function describeTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return '(DATABASE_URL unset — Prisma will read pets24x7_api/.env)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function columnsOf(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    table,
  );
  return new Set(rows.map((r) => String(r.c)));
}

const q = (c) => '`' + c.replace(/`/g, '') + '`';

async function readListings(prisma, log) {
  const cols = await columnsOf(prisma, 'listings');
  if (!cols.has('id')) throw new Error('table `listings` not found in this database');
  const want = ['id', 'name', 'category', 'categorySlug', 'categoryIcon', 'city', 'citySlug', 'state', 'country',
    'address', 'phone', 'website', 'pincode', 'rating', 'reviewCount', 'googleCid', 'gmbLink', 'claimStatus',
    'description', 'openingHours', 'services', 'whatsapp', 'locality'];
  const select = want.filter((c) => cols.has(c)).map(q);
  // photos can hold data URLs (hundreds of KB each): only a flag here, the
  // column itself is read a few rows at a time below.
  if (cols.has('photos')) select.push('(`photos` IS NOT NULL) AS `_hasPhotos`');
  const visible = cols.has('hidden') ? ' AND `hidden` = 0' : '';

  let hidden = 0;
  if (cols.has('hidden')) {
    const [{ n }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `listings` WHERE `hidden` <> 0');
    hidden = Number(n);
  }

  const rows = [];
  const withPhotos = new Set();
  let cursor = '';
  for (;;) {
    const page = await prisma.$queryRawUnsafe(
      `SELECT ${select.join(', ')} FROM \`listings\` WHERE \`id\` > ?${visible} ORDER BY \`id\` LIMIT ${BATCH}`,
      cursor,
    );
    for (const r of page) {
      if (truthy(r._hasPhotos)) withPhotos.add(r.id);
      delete r._hasPhotos;
      rows.push(r);
    }
    if (page.length < BATCH) break;
    cursor = page[page.length - 1].id;
    if (!log.quiet) process.stderr.write(`\r[export] read ${rows.length} listings…`);
  }
  if (!log.quiet) process.stderr.write(`\r[export] read ${rows.length} listings    \n`);
  // The photos themselves are read later, a few rows at a time (resolveAllPhotos).
  return { rows, withPhotos, hidden };
}

/** Approved, claimed vendors by listing id, with their public profile fields. */
async function readVendors(prisma, listingIds) {
  const cols = await columnsOf(prisma, 'vendors');
  const out = new Map();
  if (!cols.has('listingId') || !cols.has('claimedAt')) return out;
  const want = ['id', 'listingId', 'status', 'about', 'openingHours', 'servicesList', 'website', 'whatsapp', 'locality'];
  const select = want.filter((c) => cols.has(c)).map(q);
  if (cols.has('imageUrl')) select.push('(`imageUrl` IS NOT NULL AND `imageUrl` <> \'\') AS `_hasImage`');
  if (cols.has('galleryImages')) select.push('(`galleryImages` IS NOT NULL AND `galleryImages` <> \'\') AS `_hasGallery`');

  let cursor = '';
  for (;;) {
    const page = await prisma.$queryRawUnsafe(
      `SELECT ${select.join(', ')} FROM \`vendors\` WHERE \`id\` > ? AND \`listingId\` IS NOT NULL AND \`claimedAt\` IS NOT NULL ORDER BY \`id\` LIMIT ${BATCH}`,
      cursor,
    );
    for (const v of page) {
      // A suspended, rejected or not-yet-approved account does not get its
      // copy onto the public page (same rule as GET /api/listings/:id).
      if (!APPROVED_VENDOR.has(str(v.status)) || !listingIds.has(v.listingId)) continue;
      // Two approved vendors on one listing should not happen (listingId is
      // unique); if it ever does, the lowest id wins so the output is stable.
      if (out.has(v.listingId)) continue;
      // The images themselves are read later, a few vendors at a time.
      const hasImages = truthy(v._hasImage) || truthy(v._hasGallery);
      delete v._hasImage;
      delete v._hasGallery;
      out.set(v.listingId, { ...v, hasImages });
    }
    if (page.length < BATCH) break;
    cursor = page[page.length - 1].id;
  }
  const imageCols = (cols.has('imageUrl') ? ['imageUrl'] : []).concat(cols.has('galleryImages') ? ['galleryImages'] : []);
  return { vendors: out, imageCols };
}

// ---- Photos ------------------------------------------------------------------

/**
 * Public photo URLs per listing id, for the listings that will be published
 * and have any. Read, decoded and written DETAIL_BATCH listings at a time, so
 * only one batch of photos is ever in memory (see Media).
 *
 * Per listing: the approved vendor's own images first (cover, then up to 5 of
 * the gallery, as the API's parseGallery keeps), then the listing's; duplicates
 * dropped; at most MAX_PHOTOS. A source past the cap is never decoded.
 */
async function resolveAllPhotos(prisma, ids, withPhotos, vendors, imageCols, media) {
  const out = new Map();
  const todo = ids.filter((id) => withPhotos.has(id) || (vendors.get(id)?.hasImages && imageCols.length));
  const ph = (list) => list.map(() => '?').join(',');
  for (let i = 0; i < todo.length; i += DETAIL_BATCH) {
    const batch = todo.slice(i, i + DETAIL_BATCH);

    const listingIds = batch.filter((id) => withPhotos.has(id));
    const listingPhotos = new Map();
    if (listingIds.length) {
      const got = await prisma.$queryRawUnsafe(
        `SELECT \`id\`, \`photos\` FROM \`listings\` WHERE \`id\` IN (${ph(listingIds)})`,
        ...listingIds,
      );
      for (const r of got) listingPhotos.set(r.id, photoSources(r.photos));
    }

    const vendorIds = batch.map((id) => vendors.get(id)).filter((v) => v?.hasImages && imageCols.length).map((v) => v.id);
    const vendorImages = new Map();
    if (vendorIds.length) {
      const got = await prisma.$queryRawUnsafe(
        `SELECT ${['id', ...imageCols].map(q).join(', ')} FROM \`vendors\` WHERE \`id\` IN (${ph(vendorIds)})`,
        ...vendorIds,
      );
      for (const r of got) {
        vendorImages.set(r.id, [str(r.imageUrl), ...photoSources(r.galleryImages).slice(0, 5)].filter(Boolean));
      }
    }

    for (const id of batch) {
      const v = vendors.get(id);
      const urls = [];
      const seen = new Set();
      for (const src of [...((v && vendorImages.get(v.id)) || []), ...(listingPhotos.get(id) || [])]) {
        const url = media.resolve(src);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= MAX_PHOTOS) break;
      }
      if (urls.length) out.set(id, urls);
    }
    await media.writePending();
  }
  return out;
}

// ---- Shaping ---------------------------------------------------------------

/** Why a row cannot be published, or '' when it can. */
function skipReason(row) {
  const id = str(row.id);
  const name = str(row.name);
  const country = str(row.country).toUpperCase();
  const city = str(row.city).replace(/\s+/g, ' ');
  const citySlug = slugify(row.citySlug || row.city);
  if (!id || !name) return 'no id or name';
  // A page is written at /<cc>/<city>/<id>/: an id that is not one path
  // segment would land somewhere else (or outside the tree).
  if (!/^[^\s/\\?#%<>"'`]+$/.test(id) || id === '.' || id === '..') return 'id not URL-safe';
  if (country !== 'IN' && country !== 'US') return `country ${country || '(empty)'}`;
  // build_data.py drops these: a pincode that leaked into the city column
  // would give the site a "/in/400069/" city.
  if (!city || /^[\d\s]+$/.test(city) || !citySlug) return 'no usable city';
  return '';
}

/**
 * Free text written by a business (about, services) often carries its own
 * phone number, website or email. Those are removed before the text is
 * published, for the same reason the contact columns are not.
 */
const PHONE_IN_TEXT = /(?:\+?\d[\s().-]?){8,}\d/g;

function scrubContacts(text) {
  if (!text) return text;
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[\w-]+\.(?:com|in|net|org|co|io|biz|info|app|pet|vet)(?:\/\S*)?\b/gi, '')
    .replace(/(?:\+?\d[\s().-]?){8,}\d/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * One DB row (+ claimed vendor, + its resolved photo URLs) -> the static
 * record, or a skip reason.
 */
function toRecord(row, vendor, photos, stats, trustCounts) {
  const skip = skipReason(row);
  if (skip) return { skip };
  const id = str(row.id);
  // An id built from a scraped name can carry the business's phone
  // ("…-groomer-99233-91199-40275669"); publishing it would publish the number.
  if (/(^|[^0-9])(?:[6-9][0-9]{4}-?[0-9]{5}|[0-9]{3}-[0-9]{3}-[0-9]{4})([^0-9]|$)/.test(id)) return { skip: 'phone_in_id' };
  // Some scraped names carry the business's phone number ("… groomer) 99233 91199").
  const name = str(row.name).replace(PHONE_IN_TEXT, '').replace(/[\s,|:-]+$/, '').replace(/\s{2,}/g, ' ').trim() || str(row.name);
  const country = str(row.country).toUpperCase();
  const city = str(row.city).replace(/\s+/g, ' ');
  const citySlug = slugify(row.citySlug || row.city);

  const categorySlug = slugify(row.categorySlug || row.category) || 'pet-services';
  const cid = cleanCid(row.googleCid);
  let rating = Math.round((Number(row.rating) || 0) * 10) / 10;
  let reviewCount = Math.max(0, Math.trunc(Number(row.reviewCount) || 0));
  // Old builds baked an invented count (and a 4.4 default) into the data, and
  // a table loaded from them still carries it until
  // scripts/strip-synthetic-ratings.mjs --apply has run. The formula is exact,
  // so such a row is published as unrated rather than as "447 Google reviews".
  if (!trustCounts && reviewCount > 0 && str(row.googleCid) && reviewCount === syntheticCount(row.googleCid)) {
    reviewCount = 0;
    if (rating === SYNTHETIC_RATING) rating = 0;
    stats.syntheticCounts++;
  }

  const rec = {
    id,
    name,
    category: str(row.category) || 'Pet Services',
    category_icon: str(row.categoryIcon) || CATEGORY_ICON[categorySlug] || '📍',
    category_slug: categorySlug,
    city,
    city_slug: citySlug,
    state: str(row.state),
    country,
    // Contact details are not published: data/*.json and pets-data.js are
    // public files, and Pets24x7 brokers every enquiry (see the API's
    // publicListing). The keys stay, empty, so the record shape is unchanged.
    address: '',
    phone: '',
    website: '',
    pincode: str(row.pincode),
    // build_data.py writes unknown as null; the table stores it as 0.
    rating: rating > 0 ? rating : null,
    review_count: reviewCount,
    google_cid: '',
    gmb_link: '',
    active: 'yes',
  };

  // Claimed + approved vendor's own profile wins where it says something
  // (GET /api/listings/:id and listing.html merge the same way); the listing's
  // columns are the directory's copy underneath.
  const v = vendor || {};
  const locality = cleanText(v.locality || row.locality, 160);
  const description = scrubContacts(cleanText(v.about || row.description, 5000));
  const hours = parseHours(str(v.openingHours) ? v.openingHours : row.openingHours);
  const vServices = parseServices(v.servicesList);
  const services = vServices.length ? vServices : parseServices(row.services);
  // Listing.email is deliberately not published: the public API does not
  // serve it either (it is the directory's contact for the business, not a
  // public address). The templates render one only if the data carries it.
  // WhatsApp likewise only for a claimed listing: the pages route an
  // unclaimed listing's enquiries to the platform's own number and never
  // read it, and GET /api/listings/:id does not serve it, so a number an
  // admin entered on an unclaimed row was published for nothing.
  const whatsapp = '';

  if (locality) rec.locality = locality;
  if (description) rec.description = description;
  if (hours) rec.opening_hours = hours;
  if (services.length) rec.services = services.map(scrubContacts).filter(Boolean);
  if (whatsapp) rec.whatsapp = whatsapp;
  if (photos && photos.length) rec.photos = photos;
  if (vendor) rec.claimed = true;
  return { rec };
}

// The invented review count of old builds (scripts/strip-synthetic-ratings.mjs).
const SYNTHETIC_RATING = 4.4;
function syntheticCount(cid) {
  let seed = 0;
  for (const ch of String(cid)) if (ch >= '0' && ch <= '9') seed += Number(ch);
  return 18 + ((seed || 31) * 7919) % 462;
}

// Within a city: rating desc, review count desc, name (build_data.py), then id
// so equal rows cannot swap places between runs.
const byRank = (a, b) =>
  (b.rating || 0) - (a.rating || 0) || b.review_count - a.review_count || cmp(a.name, b.name) || cmp(a.id, b.id);

function buildOutput(records) {
  const byCity = new Map();
  for (const r of records) {
    const key = `${r.country.toLowerCase()}-${r.city_slug}`;
    let bucket = byCity.get(key);
    if (!bucket) byCity.set(key, (bucket = []));
    bucket.push(r);
  }

  const files = new Map(); // filename -> { items, text }
  const index = [];
  for (const [key, items] of byCity) {
    items.sort(byRank);
    // Variants of one city name ("Delhi" / "DELHI") share a slug: the most
    // common spelling labels the city, ties to the first in rank order.
    const names = new Map();
    items.forEach((it) => names.set(it.city, (names.get(it.city) || 0) + 1));
    let cityName = items[0].city;
    for (const [n, c] of names) if (c > names.get(cityName)) cityName = n;

    const cats = new Map();
    items.forEach((it) => cats.set(it.category_slug, (cats.get(it.category_slug) || 0) + 1));
    const topCats = [...cats.entries()]
      .map(([slug, count], order) => ({ slug, count, order }))
      .sort((a, b) => b.count - a.count || a.order - b.order)
      .slice(0, 4)
      .map((c) => c.slug);

    files.set(`${key}.json`, { items, text: JSON.stringify(items) });
    index.push({
      country: items[0].country,
      city: cityName,
      city_slug: items[0].city_slug,
      count: items.length,
      top_categories: topCats,
      top_rating: items.reduce((m, it) => Math.max(m, it.rating || 0), 0),
      thin: items.length < THIN_CITY_MAX,
    });
  }
  index.sort((a, b) => cmp(a.country, b.country) || b.count - a.count || cmp(a.city_slug, b.city_slug));

  // Featured strip on the home page: best-rated first, with 25+ reviews ahead
  // of the rest (build_data.py). Base keys only: the home page reads nothing
  // else, and pets-data.js is loaded on every page.
  const featured = records
    .filter((r) => r.rating)
    .sort((a, b) =>
      (a.review_count < 25) - (b.review_count < 25) ||
      (b.rating || 0) - (a.rating || 0) ||
      b.review_count - a.review_count ||
      cmp(a.name, b.name) ||
      cmp(a.id, b.id))
    .slice(0, FEATURED_MAX)
    .map((r) => Object.fromEntries(BASE_KEYS.map((k) => [k, r[k]])));

  const indexText =
    'window.PETS_INDEX = ' + JSON.stringify(index) + ';\n' +
    'window.PETS_FEATURED = ' + JSON.stringify(featured) + ';\n';
  return { files, index, indexText };
}

// ---- Diff + write ----------------------------------------------------------

async function readMaybe(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

function rowDiff(oldText, newItems) {
  let old = [];
  try { old = JSON.parse(oldText); } catch { /* unreadable: every row counts as new */ }
  const oldById = new Map((Array.isArray(old) ? old : []).map((r) => [r && r.id, JSON.stringify(r)]));
  let added = 0, changed = 0;
  const seen = new Set();
  for (const r of newItems) {
    seen.add(r.id);
    const prev = oldById.get(r.id);
    if (prev === undefined) added++;
    else if (prev !== JSON.stringify(r)) changed++;
  }
  let removed = 0;
  for (const id of oldById.keys()) if (!seen.has(id)) removed++;
  return { added, changed, removed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(readFileSyncHeader());
    return;
  }
  const say = (m) => { if (!opts.quiet) process.stdout.write(m + '\n'); };

  say(`[export] database: ${describeTarget()}`);
  say(`[export] data dir: ${opts.out}${opts.dryRun ? '  (dry run: nothing is written)' : ''}`);

  const prisma = new PrismaClient();
  const media = new Media(opts.mediaDir, opts.mediaUrl, opts.dryRun);
  let rows, photos, hidden, vendors;
  try {
    let withPhotos, imageCols;
    ({ rows, withPhotos, hidden } = await readListings(prisma, opts));
    ({ vendors, imageCols } = await readVendors(prisma, new Set(rows.map((r) => r.id))));
    // Refused before any photo is decoded or written.
    const publishable = rows.filter((r) => !skipReason(r)).map((r) => r.id);
    if (!publishable.length && !opts.allowEmpty) {
      throw new Error('0 publishable listings — refusing to replace the site data with nothing (pass --allow-empty to force)');
    }
    await media.init();
    photos = await resolveAllPhotos(prisma, publishable, withPhotos, vendors, imageCols, media);
  } finally {
    await prisma.$disconnect();
  }

  const skipped = {};
  const stats = { syntheticCounts: 0 };
  const records = [];
  for (const row of rows) {
    const { rec, skip } = toRecord(row, vendors.get(row.id), photos.get(row.id), stats, opts.trustCounts);
    if (rec) records.push(rec);
    else skipped[skip] = (skipped[skip] || 0) + 1;
  }

  const { files, index, indexText } = buildOutput(records);

  // Compare against what is on disk.
  let existing = [];
  try { existing = (await readdir(opts.out)).filter((f) => CITY_FILE.test(f)); } catch { /* new dir */ }
  const plan = { add: [], change: [], remove: [], same: 0 };
  const rowsDelta = { added: 0, changed: 0, removed: 0 };
  for (const [name, { items, text }] of files) {
    const old = await readMaybe(path.join(opts.out, name));
    if (old === null) { plan.add.push(name); rowsDelta.added += items.length; continue; }
    if (old === text) { plan.same++; continue; }
    plan.change.push(name);
    const d = rowDiff(old, items);
    rowsDelta.added += d.added; rowsDelta.changed += d.changed; rowsDelta.removed += d.removed;
  }
  for (const name of existing) {
    if (files.has(name)) continue;
    plan.remove.push(name);
    const old = await readMaybe(path.join(opts.out, name));
    try { rowsDelta.removed += JSON.parse(old).length; } catch { /* ignore */ }
  }
  const oldIndex = await readMaybe(opts.index);
  const indexChanged = oldIndex !== indexText;

  if (!opts.dryRun) {
    await mkdir(opts.out, { recursive: true });
    for (const name of [...plan.add, ...plan.change]) await atomicWrite(path.join(opts.out, name), files.get(name).text);
    for (const name of plan.remove) await unlink(path.join(opts.out, name));
    if (indexChanged) {
      await mkdir(path.dirname(opts.index), { recursive: true });
      await atomicWrite(opts.index, indexText);
    }
  }
  const mediaRes = await media.flush();

  const summary = {
    listings: records.length,
    cities: index.length,
    hidden,
    syntheticCounts: stats.syntheticCounts,
    claimedMerged: records.filter((r) => r.claimed).length,
    withDetail: records.filter((r) => r.description || r.opening_hours || r.services || r.photos || r.locality).length,
    skipped,
    files: { added: plan.add.length, changed: plan.change.length, removed: plan.remove.length, unchanged: plan.same },
    rows: rowsDelta,
    indexChanged,
    media: { ...mediaRes, rejected: media.rejected },
    dryRun: opts.dryRun,
  };

  say(`[export] ${records.length} listings in ${index.length} cities (${hidden} hidden, ${Object.values(skipped).reduce((a, b) => a + b, 0)} skipped)`);
  if (Object.keys(skipped).length) say(`[export] skipped: ${JSON.stringify(skipped)}`);
  if (stats.syntheticCounts) {
    say(`[export] WARNING: ${stats.syntheticCounts} rows carry the invented review count of old builds; published as unrated.`);
    say('[export]          Fix the table once: node scripts/strip-synthetic-ratings.mjs --apply');
  }
  say(`[export] city files: +${plan.add.length} ~${plan.change.length} -${plan.remove.length} (=${plan.same})` +
      `  rows: +${rowsDelta.added} ~${rowsDelta.changed} -${rowsDelta.removed}` +
      `  index: ${indexChanged ? 'changed' : 'unchanged'}` +
      `  media: +${mediaRes.written} -${mediaRes.removed}${media.rejected ? ` (${media.rejected} unusable)` : ''}`);
  const show = (label, list) => {
    if (!list.length) return;
    say(`[export]   ${label}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ` … (+${list.length - 12})` : ''}`);
  };
  show('new', plan.add);
  show('changed', plan.change);
  show('removed', plan.remove);
  // One machine-readable line for ops/pets24x7-publish.sh.
  process.stdout.write('EXPORT_SUMMARY ' + JSON.stringify(summary) + '\n');
}

function readFileSyncHeader() {
  return [
    'usage: node scripts/export-listings-static.mjs [--out DIR] [--index FILE] [--media-dir DIR]',
    '                                               [--media-url PREFIX] [--dry-run] [--allow-empty]',
    '                                               [--trust-counts] [--quiet]',
    '  --out DIR     per-city <cc>-<slug>.json files (default ../pets24x7_new/data)',
    '  --index FILE  pets-data.js (default DIR/../pets-data.js)',
    '  --dry-run     print what would change, write nothing',
    '',
  ].join('\n');
}

main().catch((err) => {
  process.stderr.write(`[export] FAILED: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
