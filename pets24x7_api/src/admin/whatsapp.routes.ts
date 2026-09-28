// Admin WhatsApp check — is the Cloud API set up well enough to send claim codes?
//
//   GET  /api/admin/whatsapp/status   each setup step, checked live against Meta
//   POST /api/admin/whatsapp/test     { phone } → sends the real code template once
//
// Nothing here returns a credential; values are reported as set / not set.

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError } from '../shared/errors.js';
import { logger } from '../logger.js';
import { sendOtpTemplate, whatsappConfigured } from '../whatsapp/cloud-api.js';

export const adminWhatsappRouter = Router();
adminWhatsappRouter.use('/whatsapp', requireAuth('admin'));

const GRAPH = 'https://graph.facebook.com/v20.0';

interface Step { key: string; label: string; ok: boolean; detail: string }

async function graph(path: string): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(`${GRAPH}/${path}`, {
      headers: { Authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    return { ok: res.ok && !data.error, data };
  } catch (err) {
    return { ok: false, data: { error: { message: (err as Error).message } } };
  }
}

adminWhatsappRouter.get(
  '/whatsapp/status',
  asyncHandler(async (_req, res) => {
    const steps: Step[] = [];
    const configured = whatsappConfigured();
    steps.push({
      key: 'credentials',
      label: 'Phone number ID and access token on the server',
      ok: configured,
      detail: configured
        ? 'WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN are set.'
        : 'Missing or still the example values. Set WA_PHONE_NUMBER_ID, WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN in the API .env.',
    });

    let phoneLabel = '';
    if (configured) {
      const r = await graph(`${encodeURIComponent(env.WA_PHONE_NUMBER_ID)}?fields=display_phone_number,verified_name,quality_rating,name_status`);
      phoneLabel = r.ok ? `${r.data.verified_name ?? ''} ${r.data.display_phone_number ?? ''}`.trim() : '';
      steps.push({
        key: 'token',
        label: 'Meta accepts the token and the phone number',
        ok: r.ok,
        detail: r.ok
          ? `Sending from ${phoneLabel}${r.data.quality_rating ? ` (quality ${r.data.quality_rating})` : ''}.`
          : `Meta said: ${r.data?.error?.message ?? 'no answer'}. A temporary token expires after 24 hours; use a permanent System User token.`,
      });

      const t = await graph(
        `${encodeURIComponent(env.WA_BUSINESS_ACCOUNT_ID)}/message_templates?name=${encodeURIComponent(env.WA_OTP_TEMPLATE_NAME)}&fields=name,status,category,language`,
      );
      const rows: any[] = t.ok ? (t.data.data ?? []) : [];
      const tpl = rows.find((x) => x.name === env.WA_OTP_TEMPLATE_NAME && x.language === env.WA_OTP_TEMPLATE_LANG) ?? rows[0];
      const approved = !!tpl && tpl.status === 'APPROVED' && tpl.language === env.WA_OTP_TEMPLATE_LANG;
      steps.push({
        key: 'template',
        label: `Code template "${env.WA_OTP_TEMPLATE_NAME}" (${env.WA_OTP_TEMPLATE_LANG}) approved`,
        ok: approved,
        detail: !t.ok
          ? `Could not read templates: ${t.data?.error?.message ?? 'no answer'}. Check WA_BUSINESS_ACCOUNT_ID.`
          : !tpl
            ? 'Not found. Create an Authentication template with this name and a "Copy code" button in WhatsApp Manager.'
            : approved
              ? `Approved (${tpl.category}).`
              : `Found with status ${tpl.status}, language ${tpl.language}. It must be APPROVED in language ${env.WA_OTP_TEMPLATE_LANG}.`,
      });
    }

    steps.push({
      key: 'secret',
      label: 'App secret for webhook signatures',
      ok: !!env.WA_APP_SECRET,
      detail: env.WA_APP_SECRET ? 'WA_APP_SECRET is set.' : 'Optional for sending codes. Set WA_APP_SECRET so incoming webhooks are verified.',
    });

    const ready = steps.filter((s) => s.key !== 'secret').every((s) => s.ok) && steps.length >= 4;
    res.json({
      ready,
      steps,
      claimMode: ready
        ? 'Claims send a 6-digit WhatsApp code to the number on the listing.'
        : 'Claims cannot send a WhatsApp code, so every claim waits for approval in Vendors.',
    });
  }),
);

adminWhatsappRouter.post(
  '/whatsapp/test',
  asyncHandler(async (req, res) => {
    const { phone } = z.object({ phone: z.string().trim().min(8).max(20) }).parse(req.body ?? {});
    if (!whatsappConfigured()) throw new BadRequestError('WhatsApp is not set up on the server yet.');
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
      await sendOtpTemplate(phone, code);
    } catch (err) {
      logger.warn({ err }, 'whatsapp.test failed');
      throw new BadRequestError(`Meta refused the message: ${(err as Error).message}`);
    }
    await prisma.auditLog
      .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'whatsapp.test', meta: { phone }, ipAddress: req.ip ?? null } })
      .catch(() => {});
    res.json({ ok: true, code });
  }),
);
