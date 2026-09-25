// Admin bulk import — CSV / JSON / Excel (.xlsx) in, mapped rows into the DB, stats back out.
// Implements complete validation, duplicate detection, city & category exclusion,
// matching signals, row action overrides, Google Sheets sync & audit history.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import { normalizePhone } from '../shared/phone.js';
import { logger } from '../logger.js';
import { parseUpload, suggestMapping } from './import.parse.js';
import { notifyIf } from '../mail/notify.js';
import { importFinishedEmail } from '../mail/action-templates.js';
import { syncListingsToGoogleSheets } from '../shared/google-sheets.js';
import { addAndPersistImportedListing, getListingById, ListingRecord } from '../listings/index.js';

export const adminImportRouter = Router();
adminImportRouter.use(requireAuth('admin'));

const MAX_CHARS = 10 * 1024 * 1024; // 10MB of text
const MAX_ROWS = 10000;
const MAX_ERRORS_KEPT = 100;

export const CANONICAL_CATEGORIES = [
  'Veterinary Hospital',
  'Pet Clinic',
  'Pet Grooming',
  'Pet Boarding',
  'Pet Training',
  'Pet Store',
  'Pet Resort',
  'Pet Cafe',
  'Pet Bakery',
  'Pet Ambulance',
  'Pet Adoption',
  'Pet Swimming Pool',
  'Pet Service',
];

interface FieldSpec {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
  hint?: string;
}

interface TargetSpec {
  key: string;
  label: string;
  description: string;
  dedupeOn: string;
  fields: FieldSpec[];
}

const TARGETS: TargetSpec[] = [
  {
    key: 'vendors',
    label: 'Pet Businesses / Listings',
    description: 'Pet clinics, groomers, resorts, stores, and services. Matched on phone & name.',
    dedupeOn: 'phone',
    fields: [
      { key: 'businessName', label: 'Business Name', required: true, aliases: ['name', 'business', 'company', 'title', 'listing_name', 'clinic_name'] },
      { key: 'city', label: 'City', aliases: ['town', 'location', 'city_name'] },
      { key: 'state', label: 'State', aliases: ['province', 'region', 'state_name'] },
      { key: 'phone', label: 'Phone', required: true, aliases: ['mobile', 'whatsapp', 'contact', 'phone_number', 'telephone'] },
      { key: 'address', label: 'Address', aliases: ['street', 'location_address', 'full_address'] },
      { key: 'category', label: 'Category', aliases: ['type', 'service', 'segment', 'business_type'] },
      { key: 'email', label: 'Email', aliases: ['mail', 'email_address'] },
      { key: 'website', label: 'Website', aliases: ['web', 'site_url', 'url'] },
      { key: 'whatsapp', label: 'WhatsApp', aliases: ['wa_phone', 'whatsapp_number'] },
      { key: 'locality', label: 'Locality / Area', aliases: ['area', 'neighborhood', 'suburb'] },
      { key: 'pincode', label: 'Pincode', aliases: ['zip', 'zipcode', 'postal_code'] },
      { key: 'about', label: 'Description', aliases: ['description', 'about_business', 'about', 'notes', 'bio'] },
      { key: 'openingHours', label: 'Opening Hours', aliases: ['hours', 'timing', 'timings', 'schedule', 'opening_hours'] },
      { key: 'servicesList', label: 'Services Offered', aliases: ['services', 'services_offered', 'amenities'] },
      { key: 'country', label: 'Country', aliases: ['cc'], hint: 'IN or US' },
      { key: 'listingId', label: 'Listing ID', aliases: ['listing', 'gmb_id', 'place_id'] },
    ],
  },
  {
    key: 'parents',
    label: 'Pet Parents',
    description: 'Customer accounts. Matched on email when present, otherwise phone.',
    dedupeOn: 'email',
    fields: [
      { key: 'name', label: 'Name', required: true, aliases: ['full_name', 'customer', 'contact_name'] },
      { key: 'email', label: 'Email', aliases: ['mail', 'email_address'] },
      { key: 'phone', label: 'Phone', aliases: ['mobile', 'whatsapp', 'contact'] },
      { key: 'city', label: 'City', aliases: ['town', 'location'] },
      { key: 'country', label: 'Country', aliases: ['cc'], hint: 'IN or US' },
    ],
  },
];

function targetSpec(key: string): TargetSpec {
  const t = TARGETS.find((x) => x.key === key);
  if (!t) throw new BadRequestError('Unknown import target');
  return t;
}

function val(row: Record<string, string>, mapping: Record<string, string>, key: string): string {
  const col = mapping[key];
  if (!col) return '';
  return (row[col] ?? '').trim();
}

function normCountry(v: string): 'IN' | 'US' {
  const s = v.trim().toUpperCase();
  if (['US', 'USA', 'UNITED STATES'].includes(s)) return 'US';
  return 'IN';
}

function normalizeStr(v: string): string {
  return (v || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function normalizeCity(v: string): string {
  return (v || '').toLowerCase().trim();
}

/** Last 10 digits: the comparable form of a phone however it was typed. */
function phoneKey(v: string | null | undefined): string {
  const d = (v || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : '';
}

/** Row-level override from the panel. It sends 'Import' / 'Skip'; accept any case. */
function overrideFor(rowActions: Record<string, string>, rowNo: number): 'IMPORT' | 'SKIP' | null {
  const v = String(rowActions[String(rowNo)] ?? '').toUpperCase();
  return v === 'IMPORT' || v === 'SKIP' ? v : null;
}

interface ExistingMatch {
  id: string;
  businessName: string;
  city: string | null;
  phone: string | null;
  category: string | null;
  source: 'LISTING' | 'VENDOR' | 'PARENT';
}

/**
 * Everything an imported row could collide with, keyed by
 *   p:<last-10 phone>, nc:<name>_<city>, e:<email>.
 * A vendor import creates directory listings, so the directory itself has to
 * be in here — matching only against vendor accounts let the same CSV be
 * imported twice and every row came back as a brand-new duplicate listing.
 */
async function loadExistingIndex(target: string): Promise<Map<string, ExistingMatch>> {
  const idx = new Map<string, ExistingMatch>();
  const add = (m: ExistingMatch, email?: string | null) => {
    const pk = phoneKey(m.phone);
    if (pk && !idx.has(`p:${pk}`)) idx.set(`p:${pk}`, m);
    if (m.businessName && m.city) {
      const k = `nc:${normalizeStr(m.businessName)}_${normalizeCity(m.city)}`;
      if (!idx.has(k)) idx.set(k, m);
    }
    if (email) idx.set(`e:${email.toLowerCase()}`, m);
  };

  if (target === 'parents') {
    const parents = await prisma.petParent.findMany({ select: { id: true, name: true, email: true, phone: true, city: true } });
    for (const p of parents) {
      add({ id: p.id, businessName: p.name, city: null, phone: p.phone, category: null, source: 'PARENT' }, p.email);
    }
    return idx;
  }

  const [vendors, listings] = await Promise.all([
    prisma.vendor.findMany({ select: { id: true, phone: true, businessName: true, city: true, category: true } }),
    prisma.listing.findMany({ select: { id: true, name: true, city: true, phone: true, category: true } }),
  ]);
  for (const v of vendors) add({ id: v.id, businessName: v.businessName, city: v.city, phone: v.phone, category: v.category, source: 'VENDOR' });
  for (const l of listings) add({ id: l.id, businessName: l.name, city: l.city, phone: l.phone, category: l.category, source: 'LISTING' });
  return idx;
}

/** The lookup keys one CSV row produces (same scheme as loadExistingIndex). */
function rowKeys(target: string, r: { name: string; city: string; phone: string; email: string }): string[] {
  const keys: string[] = [];
  const pk = phoneKey(r.phone);
  if (pk) keys.push(`p:${pk}`);
  if (target === 'parents') {
    if (r.email) keys.push(`e:${r.email.toLowerCase()}`);
  } else if (r.name && r.city) {
    keys.push(`nc:${normalizeStr(r.name)}_${normalizeCity(r.city)}`);
  }
  return keys;
}

/** Required-field check per target; returns the reason, or null when the row is usable. */
function invalidReason(target: string, r: { name: string; city: string; phone: string; email: string }): string | null {
  if (target === 'parents') {
    if (!r.name) return 'Missing required Name';
    if (!r.email && !r.phone) return 'Needs an Email or a Phone';
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return `Email "${r.email}" is not valid`;
    return null;
  }
  if (!r.name) return 'Missing required Business Name';
  if (!r.phone) return 'Missing required Phone Number';
  if (!phoneKey(r.phone)) return `Phone "${r.phone}" is not a valid number`;
  // A listing lives on a city page. Without a city it used to be filed under
  // Mumbai, which put businesses on the wrong page for the wrong customers.
  if (!r.city) return 'Missing City — a listing needs a city page';
  return null;
}

function calcSimilarity(a: string, b: string): number {
  const s1 = normalizeStr(a);
  const s2 = normalizeStr(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 100;
  if (s1.includes(s2) || s2.includes(s1)) return 85;
  let matches = 0;
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return Math.round((matches / Math.max(s1.length, s2.length)) * 100);
}

// ---------- Metadata, Categories & CSV Template ----------
adminImportRouter.get(
  '/import/targets',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, maxRows: MAX_ROWS, targets: TARGETS });
  }),
);

adminImportRouter.get(
  '/import/categories',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, categories: CANONICAL_CATEGORIES });
  }),
);

adminImportRouter.get(
  '/import/template',
  asyncHandler(async (_req, res) => {
    // Every column here is stored: Description, Opening Hours, Services
    // Offered, Email, WhatsApp and Locality used to be read and then dropped.
    // An .xlsx with the same header row imports the same way.
    const csvHeader = 'Business Name,City,State,Country,Phone,Address,Category,Email,Website,WhatsApp,Locality,Pincode,Description,Opening Hours,Services Offered\n';
    const sampleRow1 = 'Paws & Claws Veterinary Clinic,Mumbai,Maharashtra,IN,9876543210,123 MG Road Bandra,Pet Clinic,paws@example.com,https://pawsclinic.com,9876543210,Bandra West,400050,Full service vet clinic and surgeries,Mon-Sat 9AM-8PM,Vaccination; Surgery; Dental\n';
    const sampleRow2 = 'Happy Tails Grooming Spa,Delhi,Delhi,IN,9876543211,45 Connaught Place,Pet Grooming,grooming@example.com,,9876543211,CP,110001,Professional grooming and bath services,Mon-Sun 10AM-7PM,Bath; Haircut; Nail Trimming\n';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pets24x7_import_template.csv"');
    res.send(csvHeader + sampleRow1 + sampleRow2);
  }),
);

adminImportRouter.get(
  '/import/stats',
  asyncHandler(async (_req, res) => {
    // Cumulative totals come from the import_jobs ledger, not from live row
    // counts: vendors can be deleted or created outside an import, so
    // vendor.count() is not "how much we imported since day one".
    // Dry runs are never persisted today, but filter them anyway.
    const realJobs = { dryRun: false };

    const [vendors, activeVendors, parents, enquiries, imports, totals] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      prisma.petParent.count(),
      prisma.enquiry.count(),
      prisma.importJob.count({ where: realJobs }),
      prisma.importJob.aggregate({
        where: realJobs,
        _sum: {
          totalRows: true,
          created: true,
          updated: true,
          skipped: true,
          googleSheetsSyncedCount: true,
          googleSheetsFailedCount: true,
        },
      }),
    ]);

    const sum = totals._sum;
    const totalImported = (sum.created ?? 0) + (sum.updated ?? 0);

    res.json({
      ok: true,
      stats: {
        vendors,
        activeVendors,
        parents,
        enquiries,
        imports,
        // Lifetime import ledger.
        totalImported,
        totalCreated: sum.created ?? 0,
        totalUpdated: sum.updated ?? 0,
        totalRowsProcessed: sum.totalRows ?? 0,
        totalSkipped: sum.skipped ?? 0,
        sheetsSynced: sum.googleSheetsSyncedCount ?? 0,
        sheetsFailed: sum.googleSheetsFailedCount ?? 0,
      },
    });
  }),
);

adminImportRouter.get(
  '/import/history',
  asyncHandler(async (_req, res) => {
    const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ ok: true, jobs });
  }),
);

adminImportRouter.get(
  '/import/history/:id',
  asyncHandler(async (req, res) => {
    const job = await prisma.importJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new NotFoundError('Import job not found');
    res.json({ ok: true, job });
  }),
);

// Retry failed Google Sheets rows for a past import job
adminImportRouter.post(
  '/import/retry-sheets/:id',
  asyncHandler(async (req, res) => {
    const job = await prisma.importJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new NotFoundError('Import job not found');

    const details: any[] = (job.reportDetails as any[]) || [];
    const importedRows = details.filter((d) => d.status === 'IMPORTED' || d.status === 'UPDATED');

    if (!importedRows.length) {
      return res.json({ ok: true, synced: 0, failed: 0, message: 'No imported listings to retry' });
    }

    if (job.target !== 'vendors') {
      return res.json({ ok: true, synced: 0, failed: 0, message: 'Only listing imports are synced to Google Sheets' });
    }

    // An import writes directory listings, not vendor accounts — looking the
    // rows up in the vendor table found nothing, so a retry always synced 0.
    // Newer jobs record each row's listing id; older ones fall back to name+city.
    const ids = importedRows.map((r) => r.listingId).filter((x): x is string => typeof x === 'string' && !!x);
    const legacy = importedRows.filter((r) => !r.listingId && r.businessName);
    const listings = await prisma.listing.findMany({
      where: {
        OR: [
          ...(ids.length ? [{ id: { in: ids } }] : []),
          ...legacy.slice(0, 500).map((r) => ({ name: String(r.businessName), ...(r.city ? { city: String(r.city) } : {}) })),
        ],
      },
      select: { id: true, name: true, category: true, city: true, phone: true, website: true, address: true, pincode: true, claimStatus: true },
      take: 1000,
    });

    const sheetsResult = await syncListingsToGoogleSheets(
      listings.map((l) => ({
        listingId: l.id,
        businessName: l.name,
        category: l.category,
        city: l.city,
        phone: l.phone,
        website: l.website,
        whatsapp: l.phone,
        address: l.address,
        pincode: l.pincode,
        claimStatus: l.claimStatus,
      })),
    );

    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        googleSheetsSyncedCount: sheetsResult.synced,
        googleSheetsFailedCount: sheetsResult.failed,
      },
    });

    res.json({ ok: true, synced: sheetsResult.synced, failed: sheetsResult.failed });
  }),
);

// ---------- Parse & Preview ----------
// `content` is the file's text (CSV/JSON), or base64 for an .xlsx workbook
// with `encoding: 'base64'` (a .xlsx fileName or zip bytes are detected too).
const EncodingField = z.enum(['text', 'base64']).optional();

const PreviewBody = z.object({
  fileName: z.string().max(200).optional(),
  content: z.string().min(1).max(MAX_CHARS),
  encoding: EncodingField,
  target: z.string().max(40).optional(),
});

adminImportRouter.post(
  '/import/preview',
  asyncHandler(async (req, res) => {
    const body = PreviewBody.parse(req.body);
    let table;
    try {
      table = await parseUpload(body.content, body.fileName, body.encoding);
    } catch (err: any) {
      throw new BadRequestError(`Could not read the file: ${String(err?.message ?? err)}`);
    }
    if (!table.columns.length) throw new BadRequestError('No columns found in the header row.');

    const suggestions: Record<string, Record<string, string>> = {};
    for (const t of TARGETS) suggestions[t.key] = suggestMapping(table.columns, t.fields);

    const best = Object.entries(suggestions).sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];

    const detectedCitiesSet = new Set<string>();
    const detectedCategoriesSet = new Set<string>();

    const cityCols = table.columns.filter((c) => /city|location|town/i.test(c));
    const catCols = table.columns.filter((c) => /cat|type|service|segment/i.test(c));

    table.rows.forEach((r) => {
      cityCols.forEach((col) => {
        const v = (r[col] ?? '').trim();
        if (v && v.length < 50) detectedCitiesSet.add(v);
      });
      catCols.forEach((col) => {
        const v = (r[col] ?? '').trim();
        if (v && v.length < 60) detectedCategoriesSet.add(v);
      });
    });

    const detectedCategories = Array.from(detectedCategoriesSet).slice(0, 50);
    const recognizedCategories: string[] = [];
    const unrecognizedCategories: string[] = [];

    const normCanonicalSet = new Set(CANONICAL_CATEGORIES.map((c) => normalizeStr(c)));

    detectedCategories.forEach((cat) => {
      if (normCanonicalSet.has(normalizeStr(cat))) {
        recognizedCategories.push(cat);
      } else {
        unrecognizedCategories.push(cat);
      }
    });

    res.json({
      ok: true,
      fileName: body.fileName ?? null,
      columns: table.columns,
      totalRows: table.rows.length,
      sample: table.rows.slice(0, 10),
      suggestedTarget: body.target ?? best?.[0] ?? 'vendors',
      suggestedMapping: suggestions,
      detectedCities: Array.from(detectedCitiesSet).slice(0, 50),
      detectedCategories,
      recognizedCategories,
      unrecognizedCategories,
      canonicalCategories: CANONICAL_CATEGORIES,
    });
  }),
);

// ---------- Full Data Analysis & Detailed Preview ----------
const AnalyzeBody = z.object({
  target: z.string().default('vendors'),
  fileName: z.string().optional(),
  content: z.string().min(1).max(MAX_CHARS),
  encoding: EncodingField,
  mapping: z.record(z.string()),
  categoryMapping: z.record(z.string()).optional().default({}),
  excludedCities: z.array(z.string()).optional().default([]),
  excludedCategories: z.array(z.string()).optional().default([]),
  skipDuplicates: z.boolean().optional().default(true),
  skipExisting: z.boolean().optional().default(true),
  skipInvalid: z.boolean().optional().default(true),
  applyCityExclusions: z.boolean().optional().default(true),
  applyCategoryExclusions: z.boolean().optional().default(true),
  rowActions: z.record(z.string()).optional().default({}),
});

adminImportRouter.post(
  '/import/analyze',
  asyncHandler(async (req, res) => {
    const body = AnalyzeBody.parse(req.body);
    const spec = targetSpec(body.target);

    let rows: Record<string, string>[];
    try {
      rows = (await parseUpload(body.content, body.fileName, body.encoding)).rows;
    } catch (err: any) {
      throw new BadRequestError(`Could not read the file: ${String(err?.message ?? err)}`);
    }

    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);

    // Normalize excluded cities list
    const excludedCitySet = new Set<string>();
    if (body.applyCityExclusions && body.excludedCities?.length) {
      body.excludedCities.forEach((c) => {
        if (c && c.trim()) excludedCitySet.add(normalizeCity(c));
      });
    }

    // Normalize excluded categories list
    const excludedCategorySet = new Set<string>();
    if (body.applyCategoryExclusions && body.excludedCategories?.length) {
      body.excludedCategories.forEach((c) => {
        if (c && c.trim()) excludedCategorySet.add(normalizeStr(c));
      });
    }

    // Existing records (directory listings + vendor accounts, or parents) for
    // matching signals.
    const existing = await loadExistingIndex(spec.key);
    // CSV key -> first row number that will be imported with it.
    const seenCsv = new Map<string, number>();

    let newCount = 0;
    let existingCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let excludedCityCount = 0;
    let excludedCategoryCount = 0;
    let willImportCount = 0;
    let willSkipCount = 0;

    const rowAnalysis = rows.map((raw, index) => {
      const rowNo = index + 2;
      const bName = val(raw, body.mapping, 'businessName') || val(raw, body.mapping, 'name');
      const city = val(raw, body.mapping, 'city');
      const rawCategory = val(raw, body.mapping, 'category') || 'Pet Service';

      // Apply category mapping if admin mapped custom CSV category
      const category = body.categoryMapping[rawCategory] || rawCategory;

      const rawPhone = val(raw, body.mapping, 'phone');
      const email = val(raw, body.mapping, 'email');
      const keys = rowKeys(spec.key, { name: bName, city, phone: rawPhone, email });
      const csvHit = keys.find((k) => seenCsv.has(k));
      const dbHit = keys.find((k) => existing.has(k));
      const invalid = invalidReason(spec.key, { name: bName, city, phone: rawPhone, email });

      let classification: 'NEW' | 'EXISTING' | 'DUPLICATE' | 'INVALID' | 'EXCLUDED_CITY' | 'EXCLUDED_CATEGORY' = 'NEW';
      let reason = spec.key === 'parents' ? 'New pet parent ready to import' : 'New listing ready to import';
      let defaultAction: 'Import' | 'Skip' = 'Import';
      let matchingSignals: any = null;

      // 1. Validation check
      if (invalid) {
        classification = 'INVALID';
        reason = invalid;
        defaultAction = 'Skip';
        invalidCount++;
      }
      // 2. Excluded City Check
      else if (body.applyCityExclusions && city && excludedCitySet.has(normalizeCity(city))) {
        classification = 'EXCLUDED_CITY';
        reason = `City "${city}" is on the exclusion list`;
        defaultAction = 'Skip';
        excludedCityCount++;
      }
      // 3. Excluded Category Check
      else if (body.applyCategoryExclusions && category && excludedCategorySet.has(normalizeStr(category))) {
        classification = 'EXCLUDED_CATEGORY';
        reason = `Category "${category}" is on the exclusion list`;
        defaultAction = 'Skip';
        excludedCategoryCount++;
      }
      // 4. Duplicate within CSV check
      else if (csvHit) {
        classification = 'DUPLICATE';
        const prevRowNo = seenCsv.get(csvHit);
        const byPhone = csvHit.startsWith('p:');
        reason = `Duplicate row in the uploaded file (matches row #${prevRowNo})`;
        defaultAction = body.skipDuplicates ? 'Skip' : 'Import';
        duplicateCount++;
        matchingSignals = {
          matchedRowNo: prevRowNo,
          phoneMatch: byPhone,
          phoneExactMatch: byPhone,
          nameMatch: csvHit.startsWith('nc:'),
          cityMatch: csvHit.startsWith('nc:'),
          reasons: [
            byPhone
              ? 'Same phone number as an earlier row in this file'
              : csvHit.startsWith('e:')
                ? 'Same email as an earlier row in this file'
                : 'Same name & city as an earlier row in this file',
          ],
        };
      }
      // 5. Existing record in DB check
      else if (dbHit) {
        classification = 'EXISTING';
        const matched = existing.get(dbHit)!;
        const phoneExact = keys.some((k) => k.startsWith('p:') && existing.get(k)?.id === matched.id);
        reason = `Already on Pets24x7 ("${matched.businessName}")`;
        defaultAction = body.skipExisting ? 'Skip' : 'Import';
        existingCount++;

        const simPct = calcSimilarity(bName, matched.businessName);
        const cityMatch = city && matched.city ? normalizeCity(city) === normalizeCity(matched.city) : false;
        matchingSignals = {
          matchedListing: {
            id: matched.id,
            businessName: matched.businessName,
            city: matched.city,
            phone: matched.phone,
            category: matched.category,
            source: matched.source,
          },
          // The names the panel's row drawer reads.
          matchedVendorId: matched.id,
          matchedVendorName: matched.businessName,
          nameSimilarity: simPct,
          phoneExactMatch: phoneExact,
          nameSimilarityPct: simPct,
          cityMatch,
          reasons: [
            phoneExact ? 'Exact phone number match in DB' : '',
            dbHit.startsWith('e:') ? 'Same email in DB' : '',
            simPct > 70 ? `${simPct}% name similarity` : '',
            cityMatch ? 'Same city match' : '',
          ].filter(Boolean),
        };
      } else {
        newCount++;
      }

      // Allow admin row-level action override (the panel sends 'Import' /
      // 'Skip'; upper-case-only matching ignored every toggle). A row missing
      // required data cannot be forced through: it would create a nameless or
      // cityless record.
      const userOverride = overrideFor(body.rowActions, rowNo);
      const action: 'Import' | 'Skip' = invalid
        ? 'Skip'
        : userOverride === 'IMPORT' ? 'Import' : userOverride === 'SKIP' ? 'Skip' : defaultAction;

      // Only rows that will actually be written claim their keys — the same
      // rule commit follows, so the preview and the real run count alike.
      if (action === 'Import') {
        for (const k of keys) if (!seenCsv.has(k)) seenCsv.set(k, rowNo);
        willImportCount++;
      } else {
        willSkipCount++;
      }

      return {
        rowNo,
        businessName: bName || '(Unnamed)',
        city: city || 'Unspecified',
        phone: rawPhone || 'N/A',
        category,
        address: val(raw, body.mapping, 'address') || '',
        email: val(raw, body.mapping, 'email') || '',
        website: val(raw, body.mapping, 'website') || '',
        openingHours: val(raw, body.mapping, 'openingHours') || '',
        about: val(raw, body.mapping, 'about') || '',
        // The source row as uploaded, for the panel's row drawer.
        raw,
        classification,
        reason,
        defaultAction,
        action,
        matchingSignals,
      };
    });

    const categoryDist: Record<string, number> = {};
    const cityDist: Record<string, number> = {};
    let hasEmailCount = 0;
    let hasAddressCount = 0;
    let hasHoursCount = 0;

    rows.forEach((raw) => {
      const rawCat = val(raw, body.mapping, 'category') || 'Pet Service';
      const cat = body.categoryMapping[rawCat] || rawCat;
      const cty = val(raw, body.mapping, 'city') || 'Unspecified';
      categoryDist[cat] = (categoryDist[cat] || 0) + 1;
      cityDist[cty] = (cityDist[cty] || 0) + 1;

      if (val(raw, body.mapping, 'email')) hasEmailCount++;
      if (val(raw, body.mapping, 'address')) hasAddressCount++;
      if (val(raw, body.mapping, 'openingHours')) hasHoursCount++;
    });

    res.json({
      ok: true,
      totalRows: rows.length,
      newCount,
      existingCount,
      duplicateCount,
      invalidCount,
      excludedCityCount,
      excludedCategoryCount,
      willImportCount,
      willSkipCount,
      categoryDist,
      cityDist,
      qualityStats: {
        hasEmail: hasEmailCount,
        hasAddress: hasAddressCount,
        hasHours: hasHoursCount,
      },
      rows: rowAnalysis,
    });
  }),
);

// ---------- Commit & Database Insertion ----------
const CommitBody = z.object({
  target: z.string().default('vendors'),
  mapping: z.record(z.string()),
  categoryMapping: z.record(z.string()).optional().default({}),
  content: z.string().min(1).max(MAX_CHARS),
  encoding: EncodingField,
  fileName: z.string().optional(),
  excludedCities: z.array(z.string()).optional().default([]),
  excludedCategories: z.array(z.string()).optional().default([]),
  skipDuplicates: z.boolean().optional().default(true),
  skipExisting: z.boolean().optional().default(true),
  skipInvalid: z.boolean().optional().default(true),
  applyCityExclusions: z.boolean().optional().default(true),
  applyCategoryExclusions: z.boolean().optional().default(true),
  rowActions: z.record(z.string()).optional().default({}),
  // A dry run classifies every row exactly as a real commit would, but writes
  // nothing: no listings, no parents, no Sheets push, no job row, no email.
  dryRun: z.boolean().optional().default(false),
});

adminImportRouter.post(
  '/import/commit',
  asyncHandler(async (req, res) => {
    const body = CommitBody.parse(req.body);
    const spec = targetSpec(body.target);
    const dryRun = body.dryRun;

    let rows: Record<string, string>[];
    try {
      rows = (await parseUpload(body.content, body.fileName, body.encoding)).rows;
    } catch (err: any) {
      throw new BadRequestError(`Could not read the file: ${String(err?.message ?? err)}`);
    }

    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);

    // Normalize excluded cities
    const excludedCitySet = new Set<string>();
    if (body.applyCityExclusions && body.excludedCities?.length) {
      body.excludedCities.forEach((c) => {
        if (c && c.trim()) excludedCitySet.add(normalizeCity(c));
      });
    }

    // Normalize excluded categories
    const excludedCategorySet = new Set<string>();
    if (body.applyCategoryExclusions && body.excludedCategories?.length) {
      body.excludedCategories.forEach((c) => {
        if (c && c.trim()) excludedCategorySet.add(normalizeStr(c));
      });
    }

    const existing = await loadExistingIndex(spec.key);
    const seenCsv = new Set<string>();

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;
    let excludedCityCount = 0;
    let excludedCategoryCount = 0;

    const errors: { row: number; message: string }[] = [];
    const reportDetails: any[] = [];
    const importedListingsForSheets: any[] = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      const rowNo = i + 2;

      const bName = val(raw, body.mapping, 'businessName') || val(raw, body.mapping, 'name');
      const city = val(raw, body.mapping, 'city');
      const rawCategory = val(raw, body.mapping, 'category') || 'Pet Service';
      const category = body.categoryMapping[rawCategory] || rawCategory;
      const rawPhone = val(raw, body.mapping, 'phone');
      const country = normCountry(val(raw, body.mapping, 'country'));
      const normalizedPh = rawPhone ? normalizePhone(rawPhone, country) : '';
      const rowEmail = val(raw, body.mapping, 'email');
      const keys = rowKeys(spec.key, { name: bName, city, phone: rawPhone, email: rowEmail });
      const invalid = invalidReason(spec.key, { name: bName, city, phone: rawPhone, email: rowEmail });

      // Check row action override or default decision
      let defaultAction: 'IMPORT' | 'SKIP' = 'IMPORT';
      let reason = spec.key === 'parents' ? 'New pet parent ready to import' : 'New listing ready to import';

      if (invalid) {
        invalidCount++;
        defaultAction = 'SKIP';
        reason = invalid;
      } else if (body.applyCityExclusions && city && excludedCitySet.has(normalizeCity(city))) {
        excludedCityCount++;
        defaultAction = 'SKIP';
        reason = `City "${city}" is on the exclusion list`;
      } else if (body.applyCategoryExclusions && category && excludedCategorySet.has(normalizeStr(category))) {
        excludedCategoryCount++;
        defaultAction = 'SKIP';
        reason = `Category "${category}" is on the exclusion list`;
      } else if (keys.some((k) => seenCsv.has(k))) {
        duplicateCount++;
        defaultAction = body.skipDuplicates ? 'SKIP' : 'IMPORT';
        reason = 'Duplicate row in the uploaded file';
      } else if (keys.some((k) => existing.has(k))) {
        defaultAction = body.skipExisting ? 'SKIP' : 'IMPORT';
        reason = 'Already on Pets24x7';
      }

      // The panel's per-row toggles ('Import' / 'Skip'). They were compared
      // against upper-case strings only, so every override was silently ignored.
      // Invalid rows cannot be forced through.
      const userOverride = overrideFor(body.rowActions, rowNo);
      const effectiveAction = invalid ? 'SKIP' : userOverride ?? defaultAction;

      if (effectiveAction === 'SKIP') {
        skippedCount++;
        reportDetails.push({ rowNo, businessName: bName || '(Missing)', city, phone: rawPhone, category, status: 'SKIPPED', reason });
        continue;
      }

      for (const k of keys) seenCsv.add(k);

      try {
        if (spec.key === 'vendors') {
          const generatedListingId = `listing_imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const listingId = val(raw, body.mapping, 'listingId') || generatedListingId;

          const categoryName = category || 'Pet Service';
          const categorySlug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'pet-service';
          const cityName = city; // required — invalidReason() rejects rows without one
          const citySlug = cityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';

          const existingListing = getListingById(listingId);
          // A CSV that carries a listing id must not overwrite a listing a
          // business has claimed — the import writes it back as UNCLAIMED and
          // replaces the owner's details with the spreadsheet's.
          if (existingListing) {
            const claimedBy =
              existingListing.claimStatus === 'CLAIMED' ||
              !!(await prisma.vendor.findUnique({ where: { listingId }, select: { id: true } }).catch(() => null));
            if (claimedBy) {
              skippedCount++;
              reportDetails.push({ rowNo, listingId, businessName: bName, city, phone: rawPhone, category, status: 'SKIPPED', reason: 'Listing is claimed by a business; not overwritten' });
              continue;
            }
          }

          // A blank cell means "not in this file": on an update it leaves the
          // stored value alone rather than wiping it.
          const cellOrUndef = (key: string) => val(raw, body.mapping, key) || undefined;
          const rowWhatsapp = cellOrUndef('whatsapp');
          const detailEmail = cellOrUndef('email')?.toLowerCase();
          const listingItem: ListingRecord = {
            id: listingId,
            name: bName,
            category: categoryName,
            category_slug: categorySlug,
            city: cityName,
            city_slug: citySlug,
            country: country || 'IN',
            state: cellOrUndef('state'),
            address: cellOrUndef('address'),
            phone: normalizedPh || undefined,
            website: cellOrUndef('website'),
            pincode: cellOrUndef('pincode'),
            // No reviews yet, so no rating. A made-up 4.5 showed every imported
            // business to the public as highly rated.
            rating: 0,
            review_count: 0,
            claimStatus: 'UNCLAIMED',
            // Directory detail, stored on the listing (these columns used to be
            // mapped in the panel and then thrown away).
            description: cellOrUndef('about'),
            opening_hours: cellOrUndef('openingHours'),
            services: cellOrUndef('servicesList'),
            email: detailEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(detailEmail) ? detailEmail : undefined,
            whatsapp: rowWhatsapp ? normalizePhone(rowWhatsapp, country) : undefined,
            locality: cellOrUndef('locality'),
          };
          for (const k of Object.keys(listingItem) as Array<keyof ListingRecord>) {
            if (listingItem[k] === undefined) delete listingItem[k];
          }

          if (existingListing) {
            // Keep what the directory already knows (its reputation, Google
            // CID/Maps link, icon, hidden flag); the file's non-blank cells win.
            Object.assign(listingItem, { ...existingListing, ...listingItem });
            listingItem.rating = existingListing.rating;
            listingItem.review_count = existingListing.review_count;
            if (!dryRun) await addAndPersistImportedListing(listingItem);
            updatedCount++;
            reportDetails.push({ rowNo, listingId, businessName: bName, city, phone: rawPhone, category, status: 'UPDATED', reason: 'Unclaimed directory listing updated' });
          } else {
            if (!dryRun) await addAndPersistImportedListing(listingItem);
            createdCount++;
            reportDetails.push({ rowNo, listingId, businessName: bName, city, phone: rawPhone, category, status: 'IMPORTED', reason: 'New unclaimed directory listing created' });
          }

          importedListingsForSheets.push({
            listingId,
            businessName: bName,
            category: categoryName,
            city: cityName,
            phone: normalizedPh,
            email: val(raw, body.mapping, 'email') || null,
            website: val(raw, body.mapping, 'website') || null,
            whatsapp: val(raw, body.mapping, 'whatsapp') || normalizedPh,
            address: val(raw, body.mapping, 'address') || null,
            locality: val(raw, body.mapping, 'locality') || null,
            pincode: val(raw, body.mapping, 'pincode') || null,
            claimStatus: 'UNCLAIMED',
          });
        } else {
          // Pet Parents Target
          const email = rowEmail.toLowerCase() || null;
          const phone = normalizedPh || null;
          // Match on email, then phone. Both are unique: creating a second
          // account with a known phone used to fail the row outright.
          const existingParent =
            (email ? await prisma.petParent.findUnique({ where: { email } }) : null) ??
            (phone ? await prisma.petParent.findUnique({ where: { phone } }) : null);
          if (existingParent) {
            // Fill gaps only; never overwrite details the parent set themselves.
            if (!dryRun) await prisma.petParent.update({
              where: { id: existingParent.id },
              data: {
                name: existingParent.name || bName,
                ...(email && !existingParent.email ? { email } : {}),
                ...(phone && !existingParent.phone ? { phone } : {}),
                ...(city && !existingParent.city ? { city } : {}),
              },
            });
            updatedCount++;
            reportDetails.push({ rowNo, businessName: bName, city, phone: rawPhone, status: 'UPDATED', reason: 'Existing pet parent updated' });
          } else {
            if (!dryRun) await prisma.petParent.create({ data: { name: bName, email, phone, city: city || null, country } });
            createdCount++;
            reportDetails.push({ rowNo, businessName: bName, city, phone: rawPhone, status: 'IMPORTED', reason: 'New pet parent created' });
          }
        }
      } catch (err: any) {
        failedCount++;
        if (errors.length < MAX_ERRORS_KEPT) {
          errors.push({ row: rowNo, message: String(err?.message ?? err).slice(0, 200) });
        }
        reportDetails.push({ rowNo, businessName: bName, status: 'FAILED', reason: String(err?.message || err) });
      }
    }

    if (dryRun) {
      res.json({
        ok: true,
        dryRun: true,
        jobId: null,
        totalRows: rows.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        failed: failedCount,
        duplicateCount,
        invalidCount,
        excludedCityCount,
        excludedCategoryCount,
        googleSheetsSyncedCount: 0,
        googleSheetsFailedCount: 0,
        errors,
        rows: reportDetails.slice(0, 500),
      });
      return;
    }

    // Sync imported listings to Google Sheets Integration
    const sheetsResult = await syncListingsToGoogleSheets(importedListingsForSheets);

    // Save job audit history
    const job = await prisma.importJob.create({
      data: {
        actorId: req.auth!.sub,
        target: spec.key,
        fileName: body.fileName ?? 'import.csv',
        dryRun: false,
        totalRows: rows.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        failed: failedCount,
        duplicateCount,
        invalidCount,
        excludedCityCount,
        excludedCategoryCount,
        googleSheetsSyncedCount: sheetsResult.synced,
        googleSheetsFailedCount: sheetsResult.failed,
        status: 'COMPLETED',
        mapping: body.mapping,
        config: {
          excludedCities: body.excludedCities,
          excludedCategories: body.excludedCategories,
          categoryMapping: body.categoryMapping,
          skipDuplicates: body.skipDuplicates,
          skipExisting: body.skipExisting,
          skipInvalid: body.skipInvalid,
        },
        errors: errors.length ? errors : undefined,
        reportDetails: reportDetails.slice(0, 500),
      },
    });

    logger.info(
      { jobId: job.id, created: createdCount, updated: updatedCount, skipped: skippedCount, sheetsSynced: sheetsResult.synced },
      'Listing import completed',
    );

    // Send admin notification email
    const admin = await prisma.admin.findUnique({ where: { id: req.auth!.sub } }).catch(() => null);
    notifyIf(admin?.email, (to) =>
      importFinishedEmail(to, admin?.name ?? 'Admin', {
        target: spec.label,
        fileName: body.fileName ?? 'import.csv',
        totalRows: rows.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        failed: failedCount,
      }),
    );

    res.json({
      ok: true,
      dryRun: false,
      jobId: job.id,
      totalRows: rows.length,
      created: createdCount,
      updated: updatedCount,
      skipped: skippedCount,
      failed: failedCount,
      duplicateCount,
      invalidCount,
      excludedCityCount,
      excludedCategoryCount,
      googleSheetsSyncedCount: sheetsResult.synced,
      googleSheetsFailedCount: sheetsResult.failed,
      errors,
    });
  }),
);
