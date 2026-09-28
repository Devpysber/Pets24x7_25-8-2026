// Admin WhatsApp — the two senders for codes and short notices.
//
//   GET  /api/admin/whatsapp/status   linked number (Baileys) + Meta setup steps
//   POST /api/admin/whatsapp/link     { phone? } → start linking: QR, or a pairing code for that phone
//   POST /api/admin/whatsapp/unlink   log the linked number out and forget it
//   POST /api/admin/whatsapp/test     { phone } → sends one real code on the active sender
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
import { metaConfigured, sendOtpTemplate, whatsappConfigured, whatsappProvider } from '../whatsapp/cloud-api.js';
import { linkStatus, requestPairingCode, startBaileys, unlinkBaileys } from '../whatsapp/baileys.js';

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
    const configured = metaConfigured();
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

    const metaReady = steps.filter((s) => s.key !== 'secret').every((s) => s.ok) && steps.length >= 4;
    const provider = whatsappProvider();
    const ready = provider === 'baileys' || (provider === 'meta' && metaReady);
    res.json({
      ready,
      provider,
      providerSetting: env.WA_PROVIDER,
      linked: await linkStatus(),
      metaReady,
      steps,
      claimMode: provider === 'baileys'
        ? 'Codes and notices go out from your linked WhatsApp number. Claims send a 6-digit code to the number on the listing.'
        : ready
          ? 'Codes and notices go out through the Meta WhatsApp API. Claims send a 6-digit code to the number on the listing.'
          : 'No WhatsApp sender is working, so claims cannot send a code and every claim waits for approval in Vendors.',
    });
  }),
);

adminWhatsappRouter.post(
  '/whatsapp/link',
  asyncHandler(async (req, res) => {
    const { phone } = z.object({ phone: z.string().trim().max(20).optional() }).parse(req.body ?? {});
    if (env.WA_PROVIDER === 'meta') throw new BadRequestError('WA_PROVIDER is set to meta on the server; the linked number is switched off.');
    let pairingCode: string | null = null;
    if (phone) {
      try { pairingCode = await requestPairingCode(phone); } catch (err) { throw new BadRequestError((err as Error).message); }
    } else {
      await startBaileys();
    }
    await prisma.auditLog
      .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'whatsapp.link', meta: { method: phone ? 'pairing_code' : 'qr' }, ipAddress: req.ip ?? null } })
      .catch(() => {});
    res.json({ ok: true, pairingCode });
  }),
);

adminWhatsappRouter.post(
  '/whatsapp/unlink',
  asyncHandler(async (req, res) => {
    await unlinkBaileys();
    await prisma.auditLog
      .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action: 'whatsapp.unlink', meta: {}, ipAddress: req.ip ?? null } })
      .catch(() => {});
    res.json({ ok: true });
  }),
);

adminWhatsappRouter.post(
  '/whatsapp/test',
  asyncHandler(async (req, res) => {
    const { phone } = z.object({ phone: z.string().trim().min(8).max(20) }).parse(req.body ?? {});
    if (!whatsappConfigured()) throw new BadRequestError('No WhatsApp sender is working yet. Link a number or finish the Meta setup.');
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
    res.json({ ok: true, code, provider: whatsappProvider() });
  }),
);
