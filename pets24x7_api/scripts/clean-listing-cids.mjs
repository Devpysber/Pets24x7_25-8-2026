// One-off clean-up of Google CIDs in the listings table.
//
//   node scripts/clean-listing-cids.mjs            # dry run: counts only
//   node scripts/clean-listing-cids.mjs --apply    # write the fixes
//
// A spreadsheet round-trip stored ~580 CIDs as "6.60859E+18". The digits are
// gone, so the value cannot be repaired, only blanked (with any gmbLink built
// from it): a Maps link that opens nothing is worse than none. The API already
// drops such values when it reads them (src/listings/index.ts cleanCid); this
// removes them at the source so exports and other readers stop seeing them.
//
// Rows that share a CID are reported, never deleted. Most are one business
// listed under two categories, and listing ids are referenced by vendors,
// enquiries, reviews and saved lists without foreign keys, so a delete here
// would orphan those silently. The recommender already collapses them.
//
// Safe to re-run: the second run finds nothing to change.

import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
const prisma = new PrismaClient();

const isCid = (v) => /^\d+$/.test(String(v ?? '').trim());
/** Same rule as src/listings/index.ts cleanGmbLink: a ?cid= that is not digits. */
const badLink = (v) => {
  const m = /[?&]cid=([^&#]*)/.exec(String(v ?? ''));
  return !!m && !isCid(m[1]);
};

async function main() {
  const target = (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${target}`);

  // Keyset pagination keeps memory flat on the full 34k-row table.
  const bad = [];
  const byCid = new Map();
  let cursor;
  for (;;) {
    const rows = await prisma.listing.findMany({
      where: { googleCid: { not: null } },
      select: { id: true, googleCid: true, gmbLink: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    for (const r of rows) {
      const cid = (r.googleCid ?? '').trim();
      if (!cid) continue;
      if (!isCid(cid)) bad.push({ id: r.id, dropLink: badLink(r.gmbLink) });
      else byCid.set(cid, (byCid.get(cid) ?? 0) + 1);
    }
    cursor = rows[rows.length - 1].id;
  }

  let groups = 0;
  let extra = 0;
  for (const n of byCid.values()) {
    if (n > 1) {
      groups += 1;
      extra += n - 1;
    }
  }
  console.log(`unusable CIDs: ${bad.length}`);
  console.log(`CIDs shared by more than one row: ${groups} (${extra} extra rows; reported only)`);

  if (!APPLY) {
    console.log('Nothing written. Re-run with --apply to blank the unusable CIDs.');
    return;
  }
  let done = 0;
  for (let i = 0; i < bad.length; i += BATCH) {
    const chunk = bad.slice(i, i + BATCH);
    for (const dropLink of [true, false]) {
      const ids = chunk.filter((b) => b.dropLink === dropLink).map((b) => b.id);
      if (!ids.length) continue;
      const res = await prisma.listing.updateMany({
        where: { id: { in: ids } },
        data: dropLink ? { googleCid: null, gmbLink: null } : { googleCid: null },
      });
      done += res.count;
    }
  }
  console.log(`blanked ${done} CIDs (and any Maps link built from one).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
