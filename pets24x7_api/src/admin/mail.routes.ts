// Admin email console — browse every template, preview it rendered, and send
// real mail by hand.
//
//   GET  /api/admin/mail/templates          catalogue + sample data
//   POST /api/admin/mail/preview            { templateId, data? } → rendered html
//   POST /api/admin/mail/audience/count     { audience } → how many addresses
//   POST /api/admin/mail/send               { templateId, data?, to[] | audience }
//
// Sending is deliberately explicit: an audience send never happens unless the
// caller names the audience AND passes confirm:true, and every send is capped
// and written to the audit log.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError } from '../shared/errors.js';
import { logger } from '../logger.js';
import { MAIL_CATALOG, catalogEntry } from '../mail/catalog.js';
import { mailEnabled, sendMail } from '../mail/mailer.js';

export const adminMailRouter = Router();
adminMailRouter.use(requireAuth('admin'));

/** Hard ceiling on one send, whatever the audience size. */
const MAX_RECIPIENTS = 500;

const AUDIENCES = ['parents', 'members', 'vendors', 'active_vendors'] as const;
type Audience = (typeof AUDIENCES)[number];

async function audienceEmails(audience: Audience): Promise<string[]> {
  if (audience === 'parents') {
    const rows = await prisma.petParent.findMany({
      where: { email: { not: null } },
      select: { email: true },
      take: MAX_RECIPIENTS,
    });
    return rows.map((r) => r.email!).filter(Boolean);
  }
  if (audience === 'members') {
    const rows = await prisma.membership.findMany({
      where: { status: 'ACTIVE', parent: { email: { not: null } } },
      select: { parent: { select: { email: true } } },
      take: MAX_RECIPIENTS,
    });
    return rows.map((r) => r.parent?.email).filter((e): e is string => !!e);
  }
  const rows = await prisma.vendor.findMany({
    where: { email: { not: null }, ...(audience === 'active_vendors' ? { status: 'ACTIVE' } : {}) },
    select: { email: true },
    take: MAX_RECIPIENTS,
  });
  return rows.map((r) => r.email!).filter(Boolean);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Drops opted-out addresses. sendMail suppresses them individually too, but
 * filtering here keeps the previewed audience count honest.
 */
async function withoutOptOuts(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return emails;
  const out = await prisma.emailOptOut.findMany({
    where: { email: { in: emails } },
    select: { email: true },
  });
  const blocked = new Set(out.map((r) => r.email));
  return emails.filter((e) => !blocked.has(e));
}

// ---------- Catalogue ----------
adminMailRouter.get(
  '/mail/templates',
  asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      smtpConfigured: mailEnabled(),
      maxRecipients: MAX_RECIPIENTS,
      audiences: AUDIENCES,
      templates: MAIL_CATALOG.map((t) => ({
        id: t.id,
        category: t.category,
        label: t.label,
        description: t.description,
        sample: t.sample,
      })),
    });
  }),
);

// ---------- Preview ----------
const PreviewBody = z.object({
  templateId: z.string().min(1),
  data: z.record(z.any()).optional(),
  to: z.string().email().optional(),
});

adminMailRouter.post(
  '/mail/preview',
  asyncHandler(async (req, res) => {
    const body = PreviewBody.parse(req.body);
    const entry = catalogEntry(body.templateId);
    if (!entry) throw new BadRequestError('Unknown template');

    const data = { ...entry.sample, ...(body.data ?? {}) };
    let mail;
    try {
      mail = entry.build(body.to ?? 'preview@example.com', data as Record<string, any>);
    } catch (err: any) {
      // A bad data shape is the admin's typo, not a server fault — say which.
      throw new BadRequestError(`Could not render "${entry.label}": ${String(err?.message ?? err)}`);
    }
    res.json({ ok: true, id: entry.id, subject: mail.subject, html: mail.html, text: mail.text });
  }),
);

// ---------- Audience size ----------
adminMailRouter.post(
  '/mail/audience/count',
  asyncHandler(async (req, res) => {
    const { audience } = z.object({ audience: z.enum(AUDIENCES) }).parse(req.body);
    const all = dedupe(await audienceEmails(audience));
    const emails = await withoutOptOuts(all);
    res.json({
      ok: true,
      audience,
      count: emails.length,
      optedOut: all.length - emails.length,
      capped: all.length >= MAX_RECIPIENTS,
    });
  }),
);

// ---------- Send ----------
const SendBody = z
  .object({
    templateId: z.string().min(1),
    data: z.record(z.any()).optional(),
    to: z.array(z.string().email()).max(MAX_RECIPIENTS).optional(),
    audience: z.enum(AUDIENCES).optional(),
    /** Required for an audience send — guards against a mis-click. */
    confirm: z.boolean().optional(),
  })
  .refine((b) => (b.to && b.to.length > 0) || b.audience, {
    message: 'Provide either `to` addresses or an `audience`',
  });

adminMailRouter.post(
  '/mail/send',
  asyncHandler(async (req, res) => {
    const body = SendBody.parse(req.body);
    const entry = catalogEntry(body.templateId);
    if (!entry) throw new BadRequestError('Unknown template');
    if (!mailEnabled()) throw new BadRequestError('SMTP is not configured on this server');

    let recipients: string[];
    if (body.to?.length) {
      recipients = dedupe(body.to);
    } else {
      if (!body.confirm) {
        throw new BadRequestError('Audience sends need confirm: true');
      }
      recipients = await withoutOptOuts(dedupe(await audienceEmails(body.audience!)));
    }
    if (recipients.length === 0) throw new BadRequestError('No recipients with an email address');
    if (recipients.length > MAX_RECIPIENTS) recipients = recipients.slice(0, MAX_RECIPIENTS);

    const data = { ...entry.sample, ...(body.data ?? {}) };
    const results: { to: string; ok: boolean }[] = [];
    for (const to of recipients) {
      let ok = false;
      try {
        const built = entry.build(to, data as Record<string, any>);
        ok = await sendMail({ ...built, kind: entry.kind ?? 'marketing' });
      } catch (err) {
        logger.warn({ err, to, templateId: entry.id }, 'admin mail send failed');
      }
      results.push({ to, ok });
    }

    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    await prisma.auditLog
      .create({
        data: {
          actorType: 'ADMIN',
          actorId: req.auth!.sub,
          action: 'mail.send',
          meta: { templateId: entry.id, audience: body.audience ?? null, recipients: results.length, sent, failed },
          ipAddress: req.ip ?? null,
        },
      })
      .catch(() => {});

    res.json({ ok: true, templateId: entry.id, sent, failed, results });
  }),
);
