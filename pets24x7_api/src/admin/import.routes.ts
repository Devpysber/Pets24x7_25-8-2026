// Admin bulk import — CSV / JSON in, mapped rows into the DB, stats back out.
//
//   GET  /api/admin/import/targets     what can be imported + their fields
//   POST /api/admin/import/preview     { fileName, content }  → columns, suggested mapping, sample rows
//   POST /api/admin/import/commit      { target, mapping, rows, dryRun } → stats
//   GET  /api/admin/import/history     past runs
//   GET  /api/admin/import/stats       live row counts per table
//
// The file never touches disk: the browser reads it and posts the text, which
// keeps this dependency-free (no multer) and leaves nothing behind on the box.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError } from '../shared/errors.js';
import { normalizePhone } from '../shared/phone.js';
import { logger } from '../logger.js';
import { parseTable, suggestMapping } from './import.parse.js';
import { notifyIf } from '../mail/notify.js';
import { importFinishedEmail } from '../mail/action-templates.js';

export const adminImportRouter = Router();
adminImportRouter.use(requireAuth('admin'));

const MAX_CHARS = 8 * 1024 * 1024; // ~8MB of text
const MAX_ROWS = 5000;
const MAX_ERRORS_KEPT = 50;

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
  /** Field used to detect an existing row, so a re-import updates rather than duplicates. */
  dedupeOn: string;
  fields: FieldSpec[];
}

const TARGETS: TargetSpec[] = [
  {
    key: 'vendors',
    label: 'Vendors / businesses',
    description: 'Pet businesses. Matched on phone — an existing vendor is updated, never duplicated.',
    dedupeOn: 'phone',
    fields: [
      { key: 'phone', label: 'Phone', required: true, aliases: ['mobile', 'whatsapp', 'contact', 'phone_number'] },
      { key: 'businessName', label: 'Business name', required: true, aliases: ['name', 'business', 'company', 'title'] },
      { key: 'email', label: 'Email', aliases: ['mail', 'email_address'] },
      { key: 'city', label: 'City', aliases: ['town', 'location'] },
      { key: 'country', label: 'Country', aliases: ['cc'], hint: 'IN or US' },
      { key: 'category', label: 'Category', aliases: ['type', 'service', 'segment'] },
      { key: 'listingId', label: 'Listing id', aliases: ['listing', 'gmb_id', 'place_id'] },
      { key: 'status', label: 'Status', aliases: ['state'], hint: 'PENDING · ACTIVE · SUSPENDED · REJECTED' },
    ],
  },
  {
    key: 'parents',
    label: 'Pet parents',
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
  {
    key: 'enquiries',
    label: 'Enquiries / leads',
    description: 'Historic leads, e.g. exported from a sheet. Always inserted; nothing is overwritten.',
    dedupeOn: '',
    fields: [
      { key: 'name', label: 'Name', required: true, aliases: ['customer', 'full_name'] },
      { key: 'phone', label: 'Phone', required: true, aliases: ['mobile', 'whatsapp', 'contact'] },
      { key: 'email', label: 'Email', aliases: ['mail'] },
      { key: 'notes', label: 'Message', aliases: ['message', 'requirement', 'enquiry', 'comments'] },
      { key: 'listingName', label: 'Business', aliases: ['business', 'vendor', 'listing'] },
      { key: 'listingId', label: 'Listing id', aliases: ['listing_id', 'place_id'] },
      { key: 'category', label: 'Category', aliases: ['type', 'service'] },
      { key: 'city', label: 'City', aliases: ['town'] },
      { key: 'country', label: 'Country', aliases: ['cc'] },
      { key: 'petType', label: 'Pet type', aliases: ['pet', 'animal', 'species'] },
      { key: 'status', label: 'Status', aliases: ['state'], hint: 'NEW · RESPONDED · COMPLETED · ARCHIVED' },
    ],
  },
];

function targetSpec(key: string): TargetSpec {
  const t = TARGETS.find((x) => x.key === key);
  if (!t) throw new BadRequestError('Unknown import target');
  return t;
}

/** Pull one mapped value out of a source row. */
function val(row: Record<string, string>, mapping: Record<string, string>, key: string): string {
  const col = mapping[key];
  if (!col) return '';
  return (row[col] ?? '').trim();
}

function normCountry(v: string): 'IN' | 'US' | null {
  const s = v.trim().toUpperCase();
  if (['IN', 'IND', 'INDIA'].includes(s)) return 'IN';
  if (['US', 'USA', 'UNITED STATES'].includes(s)) return 'US';
  return null;
}

function pickEnum<T extends string>(v: string, allowed: readonly T[], fallback: T): T {
  const s = v.trim().toUpperCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

// ---------- Metadata ----------
adminImportRouter.get(
  '/import/targets',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, maxRows: MAX_ROWS, targets: TARGETS });
  }),
);

adminImportRouter.get(
  '/import/stats',
  asyncHandler(async (_req, res) => {
    const [vendors, activeVendors, parents, enquiries, pets, reviews, memberships, imports] = await Promise.all([
      prisma.vendor.count(),
      prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      prisma.petParent.count(),
      prisma.enquiry.count(),
      prisma.pet.count(),
      prisma.review.count(),
      prisma.membership.count({ where: { status: 'ACTIVE' } }),
      prisma.importJob.count(),
    ]);
    res.json({
      ok: true,
      stats: { vendors, activeVendors, parents, enquiries, pets, reviews, activeMemberships: memberships, imports },
    });
  }),
);

adminImportRouter.get(
  '/import/history',
  asyncHandler(async (_req, res) => {
    const jobs = await prisma.importJob.findMany({ orderBy: { createdAt: 'desc' }, take: 25 });
    res.json({ ok: true, jobs });
  }),
);

// ---------- Preview ----------
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
      throw new BadRequestError(`Could not parse that file: ${String(err?.message ?? err)}`);
    }
    if (!table.columns.length) throw new BadRequestError('No columns found — is the first row a header?');

    const suggestions: Record<string, Record<string, string>> = {};
    for (const t of TARGETS) suggestions[t.key] = suggestMapping(table.columns, t.fields);

    // Whichever target matches the most columns is the one to preselect.
    const best = Object.entries(suggestions).sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];

    res.json({
      ok: true,
      fileName: body.fileName ?? null,
      columns: table.columns,
      totalRows: table.rows.length,
      truncated: table.rows.length > MAX_ROWS,
      sample: table.rows.slice(0, 10),
      suggestedTarget: body.target ?? best?.[0] ?? 'vendors',
      suggestedMapping: suggestions,
    });
  }),
);

// ---------- Commit ----------
// Either the raw file again (preferred — imports every row, not just the
// preview sample) or an explicit row array for programmatic callers.
const CommitBody = z
  .object({
    target: z.string().min(1),
    mapping: z.record(z.string()),
    content: z.string().max(MAX_CHARS).optional(),
    rows: z.array(z.record(z.string())).max(MAX_ROWS).optional(),
    fileName: z.string().max(200).optional(),
    dryRun: z.boolean().optional(),
  })
  .refine((b) => b.content || b.rows, { message: 'Provide `content` or `rows`' });

adminImportRouter.post(
  '/import/commit',
  asyncHandler(async (req, res) => {
    const body = CommitBody.parse(req.body);
    const spec = targetSpec(body.target);
    const dryRun = body.dryRun ?? false;

    let rows: Record<string, string>[];
    if (body.content) {
      try {
        rows = parseTable(body.content, body.fileName).rows;
      } catch (err: any) {
        throw new BadRequestError(`Could not parse that file: ${String(err?.message ?? err)}`);
      }
    } else {
      rows = body.rows ?? [];
    }
    if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);

    for (const f of spec.fields) {
      if (f.required && !body.mapping[f.key]) {
        throw new BadRequestError(`Map a column to "${f.label}" before importing`);
      }
    }
    if (!rows.length) throw new BadRequestError('Nothing to import');

    let created = 0, updated = 0, skipped = 0, failed = 0;
    const errors: { row: number; message: string }[] = [];
    const noteError = (row: number, message: string) => {
      failed += 1;
      if (errors.length < MAX_ERRORS_KEPT) errors.push({ row, message });
    };

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      const rowNo = i + 2; // +1 for zero-index, +1 for the header line
      try {
        if (spec.key === 'vendors') {
          const rawPhone = val(raw, body.mapping, 'phone');
          const businessName = val(raw, body.mapping, 'businessName');
          if (!rawPhone || !businessName) { skipped += 1; continue; }
          const country = normCountry(val(raw, body.mapping, 'country')) ?? 'IN';
          const phone = normalizePhone(rawPhone, country);
          const data = {
            businessName,
            email: val(raw, body.mapping, 'email') || null,
            city: val(raw, body.mapping, 'city') || null,
            country,
            category: val(raw, body.mapping, 'category') || null,
            listingId: val(raw, body.mapping, 'listingId') || null,
            status: pickEnum(val(raw, body.mapping, 'status'), ['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'] as const, 'PENDING'),
          };
          const existing = await prisma.vendor.findUnique({ where: { phone }, select: { id: true } });
          if (dryRun) { existing ? updated++ : created++; continue; }
          if (existing) {
            // listingId is unique — don't let one import steal another's claim.
            const clash = data.listingId
              ? await prisma.vendor.findFirst({ where: { listingId: data.listingId, NOT: { id: existing.id } }, select: { id: true } })
              : null;
            await prisma.vendor.update({
              where: { id: existing.id },
              data: { ...data, listingId: clash ? null : data.listingId },
            });
            updated += 1;
          } else {
            const clash = data.listingId
              ? await prisma.vendor.findFirst({ where: { listingId: data.listingId }, select: { id: true } })
              : null;
            await prisma.vendor.create({ data: { phone, ...data, listingId: clash ? null : data.listingId } });
            created += 1;
          }
        } else if (spec.key === 'parents') {
          const name = val(raw, body.mapping, 'name');
          const email = val(raw, body.mapping, 'email').toLowerCase() || null;
          const rawPhone = val(raw, body.mapping, 'phone');
          if (!name || (!email && !rawPhone)) { skipped += 1; continue; }
          const country = normCountry(val(raw, body.mapping, 'country'));
          const phone = rawPhone ? normalizePhone(rawPhone, country ?? 'IN') : null;
          const existing = email
            ? await prisma.petParent.findUnique({ where: { email }, select: { id: true } })
            : phone
              ? await prisma.petParent.findUnique({ where: { phone }, select: { id: true } })
              : null;
          const data = {
            name,
            email,
            phone,
            city: val(raw, body.mapping, 'city') || null,
            country: country ?? null,
          };
          if (dryRun) { existing ? updated++ : created++; continue; }
          if (existing) {
            await prisma.petParent.update({ where: { id: existing.id }, data });
            updated += 1;
          } else {
            await prisma.petParent.create({ data });
            created += 1;
          }
        } else {
          const name = val(raw, body.mapping, 'name');
          const rawPhone = val(raw, body.mapping, 'phone');
          if (!name || !rawPhone) { skipped += 1; continue; }
          const country = normCountry(val(raw, body.mapping, 'country'));
          if (dryRun) { created += 1; continue; }
          await prisma.enquiry.create({
            data: {
              name,
              phone: normalizePhone(rawPhone, country ?? 'IN'),
              email: val(raw, body.mapping, 'email') || null,
              notes: val(raw, body.mapping, 'notes'),
              listingName: val(raw, body.mapping, 'listingName') || null,
              listingId: val(raw, body.mapping, 'listingId') || null,
              category: val(raw, body.mapping, 'category') || null,
              city: val(raw, body.mapping, 'city') || null,
              country: country ?? null,
              petType: val(raw, body.mapping, 'petType') || null,
              status: pickEnum(val(raw, body.mapping, 'status'), ['NEW', 'RESPONDED', 'COMPLETED', 'ARCHIVED'] as const, 'NEW'),
              source: 'admin_import',
            },
          });
          created += 1;
        }
      } catch (err: any) {
        noteError(rowNo, String(err?.message ?? err).slice(0, 200));
      }
    }

    const job = await prisma.importJob.create({
      data: {
        actorId: req.auth!.sub,
        target: spec.key,
        fileName: body.fileName ?? null,
        dryRun,
        totalRows: rows.length,
        created,
        updated,
        skipped,
        failed,
        mapping: body.mapping,
        errors: errors.length ? errors : undefined,
      },
    });

    logger.info({ target: spec.key, created, updated, skipped, failed, dryRun }, 'admin import finished');

    if (!dryRun) {
      const admin = await prisma.admin.findUnique({ where: { id: req.auth!.sub } }).catch(() => null);
      notifyIf(admin?.email, (to) =>
        importFinishedEmail(to, admin?.name ?? 'there', {
          target: spec.label,
          fileName: body.fileName ?? null,
          totalRows: rows.length,
          created,
          updated,
          skipped,
          failed,
        }),
      );
    }

    res.json({ ok: true, dryRun, jobId: job.id, target: spec.key, totalRows: rows.length, created, updated, skipped, failed, errors });
  }),
);
