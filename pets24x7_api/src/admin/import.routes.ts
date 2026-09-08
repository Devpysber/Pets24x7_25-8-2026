// Admin bulk import — CSV / JSON in, mapped rows into the DB, stats back out.
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
import { parseTable, suggestMapping } from './import.parse.js';
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
      { key: 'phone', label: 'Phone', required: true, aliases: ['mobile', 'whatsapp', 'contact', 'phone_number', 'telephone'] },
      { key: 'address', label: 'Address', aliases: ['street', 'location_address', 'full_address'] },
      { key: 'category', label: 'Category', aliases: ['type', 'service', 'segment', 'business_type'] },
      { key: 'email', label: 'Email', aliases: ['mail', 'email_address'] },
      { key: 'website', label: 'Website', aliases: ['web', 'site_url', 'url'] },
      { key: 'whatsapp', label: 'WhatsApp', aliases: ['wa_phone', 'whatsapp_number'] },
      { key: 'locality', label: 'Locality / Area', aliases: ['area', 'neighborhood', 'suburb'] },
      { key: 'pincode', label: 'Pincode', aliases: ['zip', 'zipcode', 'postal_code'] },
      { key: 'about', label: 'About Business', aliases: ['description', 'notes', 'bio'] },
      { key: 'openingHours', label: 'Opening Hours', aliases: ['hours', 'timing', 'schedule'] },
      { key: 'servicesList', label: 'Services Offered', aliases: ['services', 'amenities'] },
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
    const csvHeader = 'Business Name,City,Phone,Address,Category,Email,Website,WhatsApp,Locality,Pincode,About Business,Opening Hours,Services Offered\n';
    const sampleRow1 = 'Paws & Claws Veterinary Clinic,Mumbai,9876543210,123 MG Road Bandra,Pet Clinic,paws@example.com,https://pawsclinic.com,9876543210,Bandra West,400050,Full service vet clinic and surgeries,Mon-Sat 9AM-8PM,Vaccination; Surgery; Dental\n';
    const sampleRow2 = 'Happy Tails Grooming Spa,Delhi,9876543211,45 Connaught Place,Pet Grooming,grooming@example.com,,9876543211,CP,110001,Professional grooming and bath services,Mon-Sun 10AM-7PM,Bath; Haircut; Nail Trimming\n';

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

    const vendorsToSync = await prisma.vendor.findMany({
      where: {
        OR: importedRows.map((r) => ({ businessName: r.businessName, city: r.city || undefined })),
      },
      select: {
        id: true,
        listingId: true,
        businessName: true,
        city: true,
        phone: true,
        address: true,
        locality: true,
        pincode: true,
        category: true,
        email: true,
        website: true,
        whatsapp: true,
        about: true,
        openingHours: true,
        servicesList: true,
      },
    });

    const listingsWithClaim = vendorsToSync.map((v) => ({
      ...v,
      listingId: v.listingId || v.id,
      claimStatus: 'UNCLAIMED',
    }));
    const sheetsResult = await syncListingsToGoogleSheets(listingsWithClaim);

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
const PreviewBody = z.object({
  fileName: z.string().max(200).optional(),
  content: z.string().min(1).max(MAX_CHARS),
  target: z.string().max(40).optional(),
});

adminImportRouter.post(
  '/import/preview',
  asyncHandler(async (req, res) => {
    const body = PreviewBody.parse(req.body);
    let table;
    try {
      table = parseTable(body.content, body.fileName);
    } catch (err: any) {
      throw new BadRequestError(`Could not parse CSV file: ${String(err?.message ?? err)}`);
    }
    if (!table.columns.length) throw new BadRequestError('No columns found in CSV header.');

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
      rows = parseTable(body.content, body.fileName).rows;
    } catch (err: any) {
      throw new BadRequestError(`Could not parse CSV file: ${String(err?.message ?? err)}`);
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

    // Existing vendors in DB for matching signals calculation
    const existingVendors = await prisma.vendor.findMany({
      select: { id: true, phone: true, businessName: true, city: true, category: true },
    });

    const dbPhonesMap = new Map<string, typeof existingVendors[0]>();
    const dbNameCityMap = new Map<string, typeof existingVendors[0]>();

    existingVendors.forEach((v) => {
      if (v.phone) dbPhonesMap.set(v.phone, v);
      if (v.businessName && v.city) {
        dbNameCityMap.set(`${normalizeStr(v.businessName)}_${normalizeCity(v.city)}`, v);
      }
    });

    const seenCsvKeys = new Map<string, number>();
    const seenCsvPhones = new Map<string, number>();

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
      const country = normCountry(val(raw, body.mapping, 'country'));
      const normalizedPh = rawPhone ? normalizePhone(rawPhone, country) : '';
      const nameCityKey = bName && city ? `${normalizeStr(bName)}_${normalizeCity(city)}` : '';

      let classification: 'NEW' | 'EXISTING' | 'DUPLICATE' | 'INVALID' | 'EXCLUDED_CITY' | 'EXCLUDED_CATEGORY' = 'NEW';
      let reason = 'New listing ready to import';
      let defaultAction: 'Import' | 'Skip' = 'Import';
      let matchingSignals: any = null;

      // 1. Validation check
      if (!bName) {
        classification = 'INVALID';
        reason = 'Missing required Business Name';
        defaultAction = 'Skip';
        invalidCount++;
      } else if (!rawPhone) {
        classification = 'INVALID';
        reason = 'Missing required Phone Number';
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
      else if ((normalizedPh && seenCsvPhones.has(normalizedPh)) || (nameCityKey && seenCsvKeys.has(nameCityKey))) {
        classification = 'DUPLICATE';
        const prevRowNo = (normalizedPh ? seenCsvPhones.get(normalizedPh) : null) || (nameCityKey ? seenCsvKeys.get(nameCityKey) : null);
        reason = `Duplicate row in uploaded CSV file (matches row #${prevRowNo})`;
        defaultAction = body.skipDuplicates ? 'Skip' : 'Import';
        duplicateCount++;
        matchingSignals = {
          matchedRowNo: prevRowNo,
          phoneMatch: true,
          nameMatch: !!nameCityKey,
          cityMatch: true,
          reasons: ['Exact phone number match within CSV file', 'Duplicate business name & city'],
        };
      }
      // 5. Existing listing in DB check
      else if ((normalizedPh && dbPhonesMap.has(normalizedPh)) || (nameCityKey && dbNameCityMap.has(nameCityKey))) {
        classification = 'EXISTING';
        const matched = (normalizedPh ? dbPhonesMap.get(normalizedPh) : null) || (nameCityKey ? dbNameCityMap.get(nameCityKey) : null);
        reason = `Listing already exists in Pets24x7 database ("${matched?.businessName ?? bName}")`;
        defaultAction = body.skipExisting ? 'Skip' : 'Import';
        existingCount++;

        const simPct = matched ? calcSimilarity(bName, matched.businessName) : 0;
        matchingSignals = {
          matchedListing: matched
            ? {
                id: matched.id,
                businessName: matched.businessName,
                city: matched.city,
                phone: matched.phone,
                category: matched.category,
              }
            : null,
          phoneExactMatch: normalizedPh ? dbPhonesMap.has(normalizedPh) : false,
          nameSimilarityPct: simPct,
          cityMatch: city && matched?.city ? normalizeCity(city) === normalizeCity(matched.city) : false,
          reasons: [
            normalizedPh && dbPhonesMap.has(normalizedPh) ? 'Exact phone number match in DB' : '',
            simPct > 70 ? `${simPct}% business name similarity` : '',
            city && matched?.city && normalizeCity(city) === normalizeCity(matched.city) ? 'Same city match' : '',
          ].filter(Boolean),
        };
      } else {
        newCount++;
      }

      if (bName && city) seenCsvKeys.set(nameCityKey, rowNo);
      if (normalizedPh) seenCsvPhones.set(normalizedPh, rowNo);

      // Allow admin row-level action override
      const userOverride = body.rowActions[String(rowNo)];
      const action = userOverride === 'IMPORT' || userOverride === 'SKIP' ? userOverride : defaultAction;

      if (action === 'IMPORT') willImportCount++;
      else willSkipCount++;

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
  fileName: z.string().optional(),
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
  '/import/commit',
  asyncHandler(async (req, res) => {
    const body = CommitBody.parse(req.body);
    const spec = targetSpec(body.target);

    let rows: Record<string, string>[];
    try {
      rows = parseTable(body.content, body.fileName).rows;
    } catch (err: any) {
      throw new BadRequestError(`Could not parse CSV file: ${String(err?.message ?? err)}`);
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

    const existingVendors = await prisma.vendor.findMany({
      select: { phone: true, businessName: true, city: true },
    });

    const dbPhones = new Set<string>();
    const dbNameCityKeys = new Set<string>();

    existingVendors.forEach((v) => {
      if (v.phone) dbPhones.add(v.phone);
      if (v.businessName && v.city) dbNameCityKeys.add(`${normalizeStr(v.businessName)}_${normalizeCity(v.city)}`);
    });

    const seenCsvKeys = new Set<string>();
    const seenCsvPhones = new Set<string>();

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
      const nameCityKey = bName && city ? `${normalizeStr(bName)}_${normalizeCity(city)}` : '';

      // Check row action override or default decision
      let defaultAction: 'IMPORT' | 'SKIP' = 'IMPORT';
      let reason = 'New listing ready to import';

      if (!bName || !rawPhone) {
        invalidCount++;
        defaultAction = 'SKIP';
        reason = !bName ? 'Missing required Business Name' : 'Missing required Phone Number';
      } else if (body.applyCityExclusions && city && excludedCitySet.has(normalizeCity(city))) {
        excludedCityCount++;
        defaultAction = 'SKIP';
        reason = `City "${city}" is on the exclusion list`;
      } else if (body.applyCategoryExclusions && category && excludedCategorySet.has(normalizeStr(category))) {
        excludedCategoryCount++;
        defaultAction = 'SKIP';
        reason = `Category "${category}" is on the exclusion list`;
      } else if ((normalizedPh && seenCsvPhones.has(normalizedPh)) || (nameCityKey && seenCsvKeys.has(nameCityKey))) {
        duplicateCount++;
        defaultAction = body.skipDuplicates ? 'SKIP' : 'IMPORT';
        reason = 'Duplicate row in uploaded CSV file';
      } else if ((normalizedPh && dbPhones.has(normalizedPh)) || (nameCityKey && dbNameCityKeys.has(nameCityKey))) {
        defaultAction = body.skipExisting ? 'SKIP' : 'IMPORT';
        reason = 'Listing already exists in Pets24x7 database';
      }

      const userOverride = body.rowActions[String(rowNo)];
      const effectiveAction = userOverride === 'IMPORT' || userOverride === 'SKIP' ? userOverride : defaultAction;

      if (effectiveAction === 'SKIP') {
        skippedCount++;
        reportDetails.push({ rowNo, businessName: bName || '(Missing)', city, phone: rawPhone, category, status: 'SKIPPED', reason });
        continue;
      }

      if (bName && city) seenCsvKeys.add(nameCityKey);
      if (normalizedPh) seenCsvPhones.add(normalizedPh);

      try {
        if (spec.key === 'vendors') {
          const generatedListingId = `listing_imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const listingId = val(raw, body.mapping, 'listingId') || generatedListingId;

          const categoryName = category || 'Pet Service';
          const categorySlug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'pet-service';
          const cityName = city || 'Mumbai';
          const citySlug = cityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'mumbai';

          const listingItem: ListingRecord = {
            id: listingId,
            name: bName,
            category: categoryName,
            category_slug: categorySlug,
            city: cityName,
            city_slug: citySlug,
            country: country || 'IN',
            address: val(raw, body.mapping, 'address') || undefined,
            phone: normalizedPh || undefined,
            website: val(raw, body.mapping, 'website') || undefined,
            pincode: val(raw, body.mapping, 'pincode') || undefined,
            rating: 4.5,
            review_count: 0,
            claimStatus: 'UNCLAIMED',
          };

          const existingListing = getListingById(listingId);
          if (existingListing) {
            await addAndPersistImportedListing(listingItem);
            updatedCount++;
            reportDetails.push({ rowNo, businessName: bName, city, phone: rawPhone, category, status: 'UPDATED', reason: 'Unclaimed directory listing updated' });
          } else {
            await addAndPersistImportedListing(listingItem);
            createdCount++;
            reportDetails.push({ rowNo, businessName: bName, city, phone: rawPhone, category, status: 'IMPORTED', reason: 'New unclaimed directory listing created' });
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
          const email = val(raw, body.mapping, 'email').toLowerCase() || null;
          const parentData = {
            name: bName,
            email,
            phone: normalizedPh || null,
            city: city || null,
            country,
          };

          const existingParent = email ? await prisma.petParent.findUnique({ where: { email } }) : null;
          if (existingParent) {
            await prisma.petParent.update({ where: { id: existingParent.id }, data: parentData });
            updatedCount++;
          } else {
            await prisma.petParent.create({ data: parentData });
            createdCount++;
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
