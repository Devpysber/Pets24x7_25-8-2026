// Load a cleaned JSON file of new listings into the listings table.
//
//   node scripts/load-listings-json.mjs <file.json>            # dry run: counts + what would be skipped
//   node scripts/load-listings-json.mjs <file.json> --apply    # write
//   add --backfill-vendors to also create the missing public listing row for
//   business accounts (vendors) whose listingId points at nothing
//
// Input: an array of { name, city, phone, address, category, email, website,
// pincode, rating, reviewCount, openingHours, googlePlaceId } (the output of
// the CSV clean-up). Every row is checked again against the whole database at
// load time, by phone (last 10 digits, listings and vendors) and by name within
// the city, so the script is safe to re-run: a second run inserts nothing.
//
// Rows land as ordinary unclaimed listings, so the admin panel can edit, hide
// or delete them like any other. Restart the API afterwards so its in-memory
// index picks them up, then publish the static pages.
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
const BACKFILL = process.argv.includes('--backfill-vendors');
if (!file || !fs.existsSync(file)) {
  console.error('usage: node scripts/load-listings-json.mjs <file.json> [--apply]');
  process.exit(1);
}

// Same names, slugs and icons the site's own data uses.
const CATEGORY_ICONS = {
  'Emergency Animal Hospital': '🚑',
  'Veterinary Clinics': '🩺',
  'Veterinary Labs & Diagnostics': '🔬',
  'Pet Grooming & Spa': '🛁',
  'Pet Boarding & Daycare': '🏠',
  'Pet Training (Obedience, Behavior)': '🎓',
  'Pet Sitting (In-home Care)': '🛏️',
  'Pet Walking': '🐕',
  'Pet Relocation Services': '✈️',
  'Pet Taxi & Transport': '🚕',
  'Pet Physiotherapy & Rehab': '🩹',
  'Pet Dental Care': '🦷',
  'Pet Adoption': '🐾',
  'Pet Store': '🛒',
};
const STATES = {
  delhi: 'Delhi', 'new-delhi': 'Delhi', gurgaon: 'Haryana', faridabad: 'Haryana', noida: 'Uttar Pradesh',
  ghaziabad: 'Uttar Pradesh', mumbai: 'Maharashtra', 'navi-mumbai': 'Maharashtra', thane: 'Maharashtra',
  bengaluru: 'Karnataka',
};

const guessCategory = (t) => {
  const s = String(t || '').toLowerCase();
  if (/emergency|24x7|24\/7/.test(s)) return 'Emergency Animal Hospital';
  if (/groom|spa|salon/.test(s)) return 'Pet Grooming & Spa';
  if (/board|kennel|daycare|day care|hostel|hotel/.test(s)) return 'Pet Boarding & Daycare';
  if (/train/.test(s)) return 'Pet Training (Obedience, Behavior)';
  if (/shop|store|mart|food|supply|supplies|aquarium/.test(s)) return 'Pet Store';
  return 'Veterinary Clinics';
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const last10 = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const normName = (n) =>
  String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|pvt|ltd|private|limited|llp)\b/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s ? String(s).slice(0, n) : null);

const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
const prisma = new PrismaClient();

try {
  const [listings, vendors] = await Promise.all([
    prisma.listing.findMany({ select: { phoneLast10: true, name: true, citySlug: true } }),
    prisma.vendor.findMany({
      select: {
        id: true, phone: true, listingId: true, businessName: true, city: true, country: true, category: true,
        address: true, pincode: true, website: true, whatsapp: true, email: true, about: true, openingHours: true,
        servicesList: true, locality: true, status: true, claimedAt: true,
      },
    }),
  ]);
  const listingPhones = new Set(listings.map((l) => l.phoneLast10).filter(Boolean));
  const vendorPhones = new Set(vendors.map((v) => last10(v.phone)).filter(Boolean));
  const phones = new Set([...listingPhones, ...vendorPhones]);
  // Business accounts whose public listing row is missing never show on the site.
  const listingIds = new Set((await prisma.listing.findMany({ select: { id: true } })).map((l) => l.id));
  const orphanVendors = vendors.filter((v) => !v.listingId || !listingIds.has(v.listingId));
  // Ratings from the cleaned file, keyed by phone, enrich rebuilt vendor listings.
  const fileByPhone = new Map(rows.map((r) => [last10(r.phone), r]).filter(([k]) => k));
  const names = new Set(listings.map((l) => `${l.citySlug}|${normName(l.name)}`));
  const ids = new Set();

  const toInsert = [];
  const skipped = [];
  for (const r of rows) {
    const p10 = last10(r.phone);
    const citySlug = slug(r.city);
    const nameKey = `${citySlug}|${normName(r.name)}`;
    if (!r.name || !r.city || !p10) { skipped.push([r.name, 'missing name/city/phone']); continue; }
    if (listingPhones.has(p10)) { skipped.push([r.name, 'phone already on a listing']); continue; }
    if (vendorPhones.has(p10)) { skipped.push([r.name, 'phone already on a business account (vendor)']); continue; }
    // `phones` also holds every row accepted above, so a number repeated in the
    // file (one business listed under two categories) is inserted once.
    if (phones.has(p10)) { skipped.push([r.name, 'phone repeated in this file']); continue; }
    if (names.has(nameKey)) { skipped.push([r.name, 'same name already in this city']); continue; }
    const category = CATEGORY_ICONS[r.category] ? r.category : 'Veterinary Clinics';
    let id = `${citySlug}-${slug(r.name).slice(0, 60)}-${p10.slice(-8)}`.replace(/-+/g, '-');
    while (ids.has(id)) id += 'x';
    ids.add(id);
    phones.add(p10);
    names.add(nameKey);
    const rating = Number(r.rating) > 0 && Number(r.rating) <= 5 && Number(r.reviewCount) > 0 ? Number(r.rating) : 0;
    toInsert.push({
      id,
      name: cut(r.name.trim(), 255),
      category,
      categorySlug: slug(category),
      categoryIcon: CATEGORY_ICONS[category],
      city: r.city,
      citySlug,
      state: STATES[citySlug] ?? null,
      country: 'IN',
      address: r.address || null,
      phone: `+91${p10}`,
      phoneLast10: p10,
      website: r.website || null,
      pincode: cut(r.pincode, 20),
      rating,
      reviewCount: rating ? Math.trunc(Number(r.reviewCount)) : 0,
      gmbLink: r.googlePlaceId ? `https://www.google.com/maps/place/?q=place_id:${r.googlePlaceId}` : null,
      email: cut(r.email, 191),
      openingHours: r.openingHours || null,
      claimStatus: 'UNCLAIMED',
      importedAt: new Date(),
    });
  }

  // Rebuild the public row for business accounts that lost theirs. Suspended or
  // rejected accounts and obvious test rows (a timestamp in the name) are left out.
  const backfill = [];
  let noCity = 0;
  const vendorLinks = [];
  for (const v of orphanVendors) {
    if (['SUSPENDED', 'REJECTED'].includes(v.status) || /\d{10,}/.test(v.businessName)) continue;
    const p10 = last10(v.phone);
    if (!p10 || listingPhones.has(p10)) continue;
    const f = fileByPhone.get(p10);
    // Accounts created by an admin import often have no city; the file knows it.
    const city = v.city || f?.city;
    if (!city) { noCity++; continue; }
    const category = CATEGORY_ICONS[v.category] ? v.category : CATEGORY_ICONS[f?.category] ? f.category : guessCategory(`${v.category || ''} ${v.businessName}`);
    const citySlug = slug(city);
    let id = v.listingId || `${citySlug}-${slug(v.businessName).slice(0, 60)}-${p10.slice(-8)}`;
    while (ids.has(id) || listingIds.has(id)) id += 'x';
    ids.add(id);
    const rating = f && Number(f.rating) > 0 && Number(f.rating) <= 5 && Number(f.reviewCount) > 0 ? Number(f.rating) : 0;
    backfill.push({
      id,
      name: cut(v.businessName.trim(), 255),
      category,
      categorySlug: slug(category),
      categoryIcon: CATEGORY_ICONS[category],
      city,
      citySlug,
      state: STATES[citySlug] ?? null,
      country: v.country === 'US' ? 'US' : 'IN',
      address: v.address || f?.address || null,
      phone: v.phone,
      phoneLast10: p10,
      website: v.website || f?.website || null,
      pincode: cut(v.pincode || f?.pincode, 20),
      rating,
      reviewCount: rating ? Math.trunc(Number(f.reviewCount)) : 0,
      gmbLink: f?.googlePlaceId ? `https://www.google.com/maps/place/?q=place_id:${f.googlePlaceId}` : null,
      email: cut(v.email || f?.email, 191),
      whatsapp: cut(v.whatsapp, 32),
      description: v.about || null,
      openingHours: v.openingHours || f?.openingHours || null,
      services: v.servicesList || null,
      locality: cut(v.locality, 160),
      claimStatus: v.claimedAt ? 'CLAIMED' : 'UNCLAIMED',
      importedAt: new Date(),
    });
    if (v.listingId !== id) vendorLinks.push({ vendorId: v.id, listingId: id });
  }

  const byCity = {};
  for (const r of toInsert) byCity[r.city] = (byCity[r.city] || 0) + 1;
  console.log(`input ${rows.length}, to insert ${toInsert.length}, skipped ${skipped.length}`);
  console.log('by city', byCity);
  const why = {};
  for (const [, w] of skipped) why[w] = (why[w] || 0) + 1;
  console.log('skipped by reason', why);
  for (const [n, w] of skipped.slice(0, 30)) console.log(`  skip: ${n} (${w})`);
  console.log(`business accounts with no public listing row: ${orphanVendors.length} of ${vendors.length}`);
  for (const v of orphanVendors.slice(0, 15)) console.log(`  vendor without listing: ${v.businessName} (listingId ${v.listingId ?? 'none'})`);

  console.log(`vendor accounts skipped for having no city anywhere: ${noCity}`);
  console.log(`vendor listings that can be rebuilt: ${backfill.length}${BACKFILL ? '' : ' (pass --backfill-vendors to include them)'}`);

  if (!APPLY) {
    console.log('Dry run. Nothing written. Re-run with --apply to insert.');
  } else {
    let done = 0;
    for (let i = 0; i < toInsert.length; i += 100) {
      const res = await prisma.listing.createMany({ data: toInsert.slice(i, i + 100), skipDuplicates: true });
      done += res.count;
    }
    console.log(`inserted ${done} new listings.`);
    if (BACKFILL && backfill.length) {
      let rebuilt = 0;
      for (let i = 0; i < backfill.length; i += 100) {
        const res = await prisma.listing.createMany({ data: backfill.slice(i, i + 100), skipDuplicates: true });
        rebuilt += res.count;
      }
      for (const l of vendorLinks) await prisma.vendor.update({ where: { id: l.vendorId }, data: { listingId: l.listingId } });
      console.log(`rebuilt ${rebuilt} vendor listings, relinked ${vendorLinks.length} vendors.`);
    }
    console.log('Restart the API, then publish the site.');
  }
} finally {
  await prisma.$disconnect();
}
