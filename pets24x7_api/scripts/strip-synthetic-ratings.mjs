// One-off clean-up of the invented ratings in the listings table.
//
//   node scripts/strip-synthetic-ratings.mjs            # dry run: counts only
//   node scripts/strip-synthetic-ratings.mjs --apply    # write the fixes
//   node scripts/strip-synthetic-ratings.mjs --export path/to/listings.json
//
// Older builds of pets24x7_new/build_data.py filled gaps in the scraped CSVs
// with made-up numbers, and import-mysql.mjs loaded them into this table:
//   - reviewCount = 18 + (digitsum(googleCid) * 7919) % 462 when the CSV had no
//     count (a digit sum of 0 counts as 31)
//   - rating 4.4 when the CSV had no "Rated X out of 5"
// The formula is deterministic, so a baked count is recognised exactly; it
// becomes 0 (no count known), and a 4.4 on such a row becomes 0 (rating is a
// non-null Float, 0 means unknown). A rating other than 4.4 came from the source
// and is kept; with no count behind it the API and the pages hide it
// (shownRating / build_pages.has_rating). The same rule as
// pets24x7_new/scripts/strip_synthetic_ratings.py for the JSON files.
//
// clean-listing-cids.mjs blanks spreadsheet-mangled CIDs ("6.60859E+18"). The
// old build had summed the digits of those too, so once the CID is gone the
// row can only be recognised through its original CID in export/listings.json
// (the file import-mysql.mjs loaded). Pass --export to point elsewhere; without
// the file those rows are reported and left alone.
//
// A vendor- or admin-edited row with a real count matches only by coincidence
// of the exact formula. Safe to re-run: the second run finds nothing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const exportArg = process.argv.indexOf('--export');
const EXPORT_FILE =
  exportArg > 0 && process.argv[exportArg + 1]
    ? path.resolve(process.argv[exportArg + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../export/listings.json');
const DEFAULT_RATING = 4.4;
const BATCH = 500;
const prisma = new PrismaClient();

const syntheticCount = (cid) => {
  let seed = 0;
  for (const ch of String(cid)) if (ch >= '0' && ch <= '9') seed += Number(ch);
  return 18 + ((seed || 31) * 7919) % 462;
};

// digitsum(googleCid) in SQL: each digit times the number of times it occurs.
const DIGITSUM = Array.from({ length: 9 }, (_, i) => i + 1)
  .map((d) => `${d}*(CHAR_LENGTH(googleCid)-CHAR_LENGTH(REPLACE(googleCid,'${d}','')))`)
  .join(' + ');
const MATCH = `googleCid IS NOT NULL AND googleCid <> '' AND reviewCount = 18 + MOD(IF((${DIGITSUM}) = 0, 31, (${DIGITSUM})) * 7919, 462)`;

async function main() {
  const target = (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${target}`);

  // 1. Rows that still carry their CID: one statement, matched in SQL.
  const [byCid] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n, COALESCE(SUM(rating = ${DEFAULT_RATING}), 0) AS r FROM listings WHERE ${MATCH}`,
  );
  console.log(`invented counts on rows with a CID: ${Number(byCid.n)} (${Number(byCid.r)} also rated ${DEFAULT_RATING})`);

  // 2. Rows whose CID was blanked later: recognised through the export's CID.
  let original = null;
  try {
    const rows = JSON.parse(await readFile(EXPORT_FILE, 'utf8'));
    original = new Map(rows.map((r) => [r.id, String(r.google_cid ?? r.googleCid ?? '')]));
  } catch {
    console.log(`no export at ${EXPORT_FILE}: rows without a CID cannot be checked`);
  }
  const blank = await prisma.listing.findMany({
    where: { OR: [{ googleCid: null }, { googleCid: '' }], reviewCount: { gt: 0 } },
    select: { id: true, reviewCount: true, rating: true },
  });
  const viaExport = original
    ? blank.filter((r) => original.get(r.id) && r.reviewCount === syntheticCount(original.get(r.id)))
    : [];
  console.log(
    `rows without a CID that have a count: ${blank.length}; invented per the export: ${viaExport.length}` +
      ` (${viaExport.filter((r) => r.rating === DEFAULT_RATING).length} also rated ${DEFAULT_RATING})`,
  );

  if (!APPLY) {
    console.log('Nothing written. Re-run with --apply to clear them.');
    return;
  }

  const n1 = await prisma.$executeRawUnsafe(
    `UPDATE listings SET rating = IF(rating = ${DEFAULT_RATING}, 0, rating), reviewCount = 0, updatedAt = NOW(3) WHERE ${MATCH}`,
  );
  let n2 = 0;
  for (const rated of [true, false]) {
    const ids = viaExport.filter((r) => (r.rating === DEFAULT_RATING) === rated).map((r) => r.id);
    for (let i = 0; i < ids.length; i += BATCH) {
      const res = await prisma.listing.updateMany({
        where: { id: { in: ids.slice(i, i + BATCH) } },
        data: rated ? { reviewCount: 0, rating: 0 } : { reviewCount: 0 },
      });
      n2 += res.count;
    }
  }
  console.log(`cleared: ${n1} rows by CID, ${n2} rows via the export. Restart the API to reload the index (instances running the listings sync pick it up on their own).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
