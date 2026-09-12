// Pre-migration data dump.
//
//   node scripts/export-data.mjs [outDir]
//
// Writes two things into the output directory (default ./export):
//   listings.json  — every listing the website serves, merged from
//                    ../pets24x7_new/data/*.json and de-duplicated by id.
//   db-<table>.json — a row-for-row dump of each Postgres table, so nothing
//                    that only exists in the database is lost on the way to
//                    MySQL. Skipped (with a warning) when the database is down.
//
// Nothing is written back to either database: this only reads.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve(process.argv[2] ?? 'export');
const DATA_DIR = path.resolve(process.env.STATIC_DATA_DIR ?? '../pets24x7_new/data');

function log(msg) {
  process.stdout.write(msg + '\n');
}

async function exportListings() {
  let files;
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    throw new Error(`Listing data directory not found: ${DATA_DIR}`);
  }

  // Same rule the running API uses: last write for an id wins, so an imported
  // row replaces the scraped one rather than appearing twice.
  const byId = new Map();
  let readRows = 0;
  for (const file of files.sort()) {
    let rows;
    try {
      rows = JSON.parse(await readFile(path.join(DATA_DIR, file), 'utf8'));
    } catch (err) {
      log(`  ! skipped ${file}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || !row.id) continue;
      readRows++;
      byId.set(row.id, row);
    }
  }

  const listings = Array.from(byId.values());
  await writeFile(path.join(OUT_DIR, 'listings.json'), JSON.stringify(listings), 'utf8');

  const cities = new Set(listings.map((l) => `${l.country}|${l.city_slug}`).filter(Boolean));
  const categories = new Set(listings.map((l) => l.category).filter(Boolean));
  log(`  listings.json: ${listings.length} unique listings (${readRows} rows read from ${files.length} files)`);
  log(`                 ${cities.size} cities · ${categories.size} categories`);
  return listings.length;
}

async function exportDatabase() {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  // Every model in the schema, by its Prisma client accessor.
  const models = Object.keys(prisma).filter(
    (k) => !k.startsWith('$') && !k.startsWith('_') && typeof prisma[k]?.findMany === 'function',
  );

  const counts = {};
  try {
    for (const model of models) {
      const rows = await prisma[model].findMany();
      counts[model] = rows.length;
      await writeFile(
        path.join(OUT_DIR, `db-${model}.json`),
        // BigInt/Date round-trip as ISO strings, which is what the importer reads back.
        JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        'utf8',
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  for (const [model, n] of Object.entries(counts)) {
    if (n > 0) log(`  db-${model}.json: ${n} rows`);
  }
  log(`  database total: ${total} rows across ${models.length} tables`);
  return counts;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  log(`Exporting to ${OUT_DIR}`);

  log('Listings:');
  const listingCount = await exportListings();

  log('Database:');
  let dbCounts = null;
  try {
    dbCounts = await exportDatabase();
  } catch (err) {
    log(`  ! database not exported: ${err.message}`);
    log('  ! start the database and re-run if you need its rows.');
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(
      { exportedAt: new Date().toISOString(), source: DATA_DIR, listings: listingCount, database: dbCounts },
      null,
      2,
    ),
    'utf8',
  );
  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
