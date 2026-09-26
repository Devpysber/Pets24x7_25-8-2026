// One-off directory clean-up: hide listings that are not pet businesses, and
// hide exact duplicates. Hiding (listings.hidden = 1) is the admin panel's own
// switch: the row stays in the admin directory, every public API and the next
// site publish leave it out, and an admin can unhide it from the panel.
//
//   node scripts/hide-non-pet-listings.mjs                  # dry run: report only
//   node scripts/hide-non-pet-listings.mjs --apply          # hide, write a manifest
//   node scripts/hide-non-pet-listings.mjs --undo <file>    # unhide what a run hid
//
// Two rules:
//
// 1. Not a pet business. The scrape filed human businesses under pet
//    categories: Vaccination Centers is mostly CVS MinuteClinics, VA clinics
//    and maternity hospitals; Physiotherapy, Therapy, Dental and Labs carry
//    human physio, counselling, dentistry and Quest/Labcorp; Pet Taxi carries
//    city cab firms. Word lists shared with src/feed/reco/city-index.ts (keep
//    the two in step). A name with a pet word is always kept; Vaccination
//    Centers otherwise goes; Pet Taxi loses plain cab firms; every other
//    category only loses names that are unmistakably human medicine.
//
// 2. Duplicates. Rows sharing a Google CID, a category *and* a city are the
//    same business scraped twice. One is kept (claimed/referenced first, then the
//    one with a rating, then the most complete). Same CID in a different
//    category is one business offering two services, and the same CID in
//    another city is a service-area business listed where it works; both stay.
//
// Never hidden, by either rule: claimed listings, and any listing referenced
// by a vendor, claim, enquiry, review, saved list, featured slot or deal —
// those ids carry history a hidden row would take off the public site.
//
// Restart the API afterwards (it holds the listing index in memory) and let
// the publish run, or trigger it from the admin panel.

import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const undoAt = process.argv.indexOf('--undo');
const UNDO = undoAt > -1 ? process.argv[undoAt + 1] : null;
const BATCH = 500;
const prisma = new PrismaClient();

const PET_WORDS = /(pets?\b|vet(?!eran)|veterinar|animal|dogs?\b|doggie|doggy|cats?\b|kitty|kitten|canine|k-?9|feline|paws?|pup|bark|woof|wag|mutt|hound|kennel|groom|fetch|furr?y?\b|fur\b|whisker|purr|meow|tail|birds?\b|avian|parrot|aquari|fish|reptile|exotic|zoo|livestock|cattle|poultry|equine|horse|rescue|sanctuary|shelter|spca|humane|dvm|petco|petsmart|critter|bunny|rabbit)/i;
const HUMAN_MEDICINE = /\b(patholog\w*|sonograph\w*|maternity|gyna?ec\w*|obstetric\w*|ivf|infertility|nursing home|diabet\w*|health cent(?:re|er)|multi-?speciality|paediatric\w*|pediatric\w*|physician|urolog\w*|cardiolog\w*|orthopa?edic\w*|pregnancy|uphc|primary health|endocrinolog\w*|laparoscop\w*|dermatolog\w*|neurolog\w*|oncolog\w*|polyclinic|urgent care|minuteclinic|physiotherap\w*|physical therap\w*|chiropract\w*|labcorp|quest diagnostics|dentist\w*|dental clinic|orthodont\w*|cryo\w*|counsel\w*|psychiatr\w*|psycholog\w*|lpc|lcsw)\b/i;
const CAB_FIRM = /\b(taxi|cabs?|car rentals?|limo\w*|black car|chauffeur\w*|trucker|airport)\b/i;

function isNotPetBusiness(name, categorySlug) {
  if (PET_WORDS.test(name)) return false;
  if (categorySlug === 'vaccination-centers') return true;
  if (categorySlug === 'pet-taxi-transport' && CAB_FIRM.test(name)) return true;
  return HUMAN_MEDICINE.test(name);
}

const filled = (r) =>
  [r.phone, r.website, r.address, r.description, r.openingHours, r.gmbLink].filter((v) => v && String(v).trim()).length;

async function referencedIds() {
  const ids = new Set();
  const add = (rows) => rows.forEach((r) => r.listingId && ids.add(r.listingId));
  const pick = { select: { listingId: true }, distinct: ['listingId'] };
  add(await prisma.vendor.findMany({ where: { listingId: { not: null } }, ...pick }));
  add(await prisma.listingClaim.findMany(pick));
  add(await prisma.enquiry.findMany({ where: { listingId: { not: null } }, ...pick }));
  add(await prisma.review.findMany({ where: { listingId: { not: null } }, ...pick }));
  add(await prisma.savedListing.findMany(pick));
  add(await prisma.featuredListing.findMany(pick));
  add(await prisma.deal.findMany({ where: { listingId: { not: null } }, ...pick }));
  return ids;
}

async function undo(file) {
  const { ids } = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await prisma.listing.updateMany({ where: { id: { in: ids.slice(i, i + BATCH) } }, data: { hidden: false } });
    n += res.count;
  }
  console.log(`unhid ${n} of ${ids.length} listings from ${file}`);
}

async function main() {
  const target = (process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@');
  if (UNDO) {
    console.log(`UNDO against ${target}`);
    return undo(UNDO);
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} against ${target}`);

  const refs = await referencedIds();
  const protectedRow = (r) => r.claimStatus !== 'UNCLAIMED' || refs.has(r.id);

  const human = [];
  const groups = new Map();
  let cursor;
  let seen = 0;
  for (;;) {
    const rows = await prisma.listing.findMany({
      where: { hidden: false },
      select: {
        id: true, name: true, categorySlug: true, citySlug: true, country: true, googleCid: true, claimStatus: true, rating: true,
        reviewCount: true, phone: true, website: true, address: true, description: true, openingHours: true, gmbLink: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    seen += rows.length;
    for (const r of rows) {
      if (isNotPetBusiness(r.name ?? '', (r.categorySlug ?? '').toLowerCase())) {
        human.push(r);
        continue;
      }
      const cid = (r.googleCid ?? '').trim();
      if (!/^\d+$/.test(cid)) continue;
      const key = `${cid}|${(r.categorySlug ?? '').toLowerCase()}|${r.country}|${(r.citySlug ?? '').toLowerCase()}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
    cursor = rows[rows.length - 1].id;
  }

  const hideHuman = human.filter((r) => !protectedRow(r));
  const hideDup = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort(
      (a, b) =>
        Number(protectedRow(b)) - Number(protectedRow(a)) ||
        Number(b.reviewCount > 0) - Number(a.reviewCount > 0) ||
        filled(b) - filled(a) ||
        (a.id < b.id ? -1 : 1),
    );
    for (const r of g.slice(1)) if (!protectedRow(r)) hideDup.push(r);
  }

  const byCat = {};
  for (const r of hideHuman) byCat[r.categorySlug] = (byCat[r.categorySlug] ?? 0) + 1;
  console.log(`visible listings scanned: ${seen}`);
  console.log(`not a pet business: ${human.length} found, ${hideHuman.length} to hide (${human.length - hideHuman.length} kept: claimed or referenced)`);
  console.log('  by category:', byCat);
  console.log('  sample:', hideHuman.slice(0, 8).map((r) => r.name).join(' | '));
  console.log(`same-CID, same-category, same-city duplicates: ${hideDup.length} to hide`);

  const ids = [...hideHuman, ...hideDup].map((r) => r.id);
  if (!APPLY) {
    console.log('Nothing written. Re-run with --apply to hide them.');
    return;
  }
  const manifest = `hidden-listings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), human: hideHuman.map((r) => r.id), duplicates: hideDup.map((r) => r.id), ids }, null, 1));
  let n = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await prisma.listing.updateMany({ where: { id: { in: ids.slice(i, i + BATCH) }, hidden: false }, data: { hidden: true } });
    n += res.count;
  }
  console.log(`hid ${n} listings. Manifest: ${manifest} (undo: --undo ${manifest})`);
  console.log('Restart the API and publish the site for the change to show.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
