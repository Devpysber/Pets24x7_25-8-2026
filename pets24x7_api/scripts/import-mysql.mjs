// Loads an export produced by scripts/export-data.mjs into the database the
// current DATABASE_URL points at (MySQL, after `prisma db push`).
//
//   node scripts/import-mysql.mjs [exportDir]
//
// Safe to re-run: every write is an upsert keyed on the row's own id, so a
// partial run can simply be repeated. Parent tables are written before the
// tables that reference them, so foreign keys always resolve.
//
// Listings come from listings.json (34k rows) and are written in batches with
// createMany + skipDuplicates, which is an order of magnitude faster than
// per-row upserts and is what makes a full load finish in minutes, not hours.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const EXPORT_DIR = path.resolve(process.argv[2] ?? 'export');
const BATCH = 1000;
const prisma = new PrismaClient();

// Parents first: each entry may only reference tables above it.
const MODEL_ORDER = [
  'admin',
  'petParent',
  'pet',
  'listing',
  'vendor',
  'membershipPlan',
  'membership',
  'payment',
  'listingClaim',
  'emailVerificationToken',
  'passwordResetToken',
  'vendorEmailToken',
  'otpCode',
  'emailOtpCode',
  'savedListing',
  'enquiry',
  'service',
  'reviewRequest',
  'review',
  'marketingCampaign',
  'featuredListing',
  'deal',
  'event',
  'waMessage',
  'importJob',
  'auditLog',
  'setting',
];

const log = (msg) => process.stdout.write(msg + '\n');

const lastDigits = (value, n) => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits.length <= n ? digits : digits.slice(-n);
};

/** ISO strings in the dump become Dates again; everything else passes through. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function revive(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && ISO.test(v) ? new Date(v) : v;
  }
  return out;
}

async function importListings() {
  let raw;
  try {
    raw = await readFile(path.join(EXPORT_DIR, 'listings.json'), 'utf8');
  } catch {
    log('  listings.json not found — skipping directory import.');
    return 0;
  }

  const rows = JSON.parse(raw);
  const slug = (v, fallback) =>
    String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || fallback;

  const mapped = rows
    .filter((r) => r && r.id && r.name)
    .map((r) => ({
      id: String(r.id).slice(0, 191),
      name: String(r.name).slice(0, 255),
      category: String(r.category ?? 'Pet Service').slice(0, 160),
      categorySlug: slug(r.category_slug ?? r.category, 'pet-service').slice(0, 160),
      categoryIcon: r.category_icon ? String(r.category_icon).slice(0, 16) : null,
      city: String(r.city ?? 'Unknown').slice(0, 160),
      citySlug: slug(r.city_slug ?? r.city, 'unknown').slice(0, 160),
      state: r.state ? String(r.state).slice(0, 120) : null,
      country: String(r.country ?? 'IN').toUpperCase().slice(0, 8),
      address: r.address ?? null,
      phone: r.phone ? String(r.phone).slice(0, 32) : null,
      phoneLast10: r.phone ? lastDigits(r.phone, 10) || null : null,
      website: r.website ?? null,
      pincode: r.pincode ? String(r.pincode).slice(0, 20) : null,
      rating: Number(r.rating) || 0,
      reviewCount: Number(r.review_count) || 0,
      googleCid: r.google_cid ? String(r.google_cid).slice(0, 64) : null,
      gmbLink: r.gmb_link ?? null,
      claimStatus: r.claimStatus === 'CLAIMED' ? 'CLAIMED' : 'UNCLAIMED',
    }));

  let written = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    const res = await prisma.listing.createMany({ data: chunk, skipDuplicates: true });
    written += res.count;
    process.stdout.write(`\r  listings: ${Math.min(i + BATCH, mapped.length)}/${mapped.length}`);
  }
  process.stdout.write('\n');
  log(`  listings: ${written} inserted (${mapped.length - written} already present)`);
  return written;
}

async function importTable(model, rows) {
  let ok = 0;
  let failed = 0;
  for (const raw of rows) {
    const row = revive(raw);
    try {
      // Upsert on the primary key so a re-run updates rather than duplicates.
      await prisma[model].upsert({ where: { id: row.id }, update: row, create: row });
      ok++;
    } catch (err) {
      failed++;
      if (failed <= 3) log(`    ! ${model} ${row.id}: ${err.message.split('\n')[0]}`);
    }
  }
  log(`  ${model}: ${ok} rows` + (failed ? ` · ${failed} failed` : ''));
  return { ok, failed };
}

async function main() {
  log(`Importing from ${EXPORT_DIR}`);
  log(`Target: ${(process.env.DATABASE_URL ?? '').replace(/:[^:@/]+@/, ':***@')}`);

  log('Directory:');
  await importListings();

  const files = (await readdir(EXPORT_DIR)).filter((f) => f.startsWith('db-') && f.endsWith('.json'));
  const present = new Map(files.map((f) => [f.slice(3, -5), f]));

  log('Database rows:');
  let totalFailed = 0;
  for (const model of MODEL_ORDER) {
    const file = present.get(model);
    if (!file) continue;
    present.delete(model);
    const rows = JSON.parse(await readFile(path.join(EXPORT_DIR, file), 'utf8'));
    if (!rows.length) continue;
    if (typeof prisma[model]?.upsert !== 'function') {
      log(`  ${model}: no such model in the current schema — skipped`);
      continue;
    }
    const res = await importTable(model, rows);
    totalFailed += res.failed;
  }
  for (const [model] of present) {
    log(`  ${model}: not in the import order — skipped, add it if it matters`);
  }

  log(totalFailed ? `Done with ${totalFailed} failed rows.` : 'Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
