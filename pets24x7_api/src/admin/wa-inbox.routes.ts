// Admin WhatsApp inbox — every chat on the linked number (and Meta webhook),
// automatic or manual per chat, and manual replies.
//
//   GET  /api/admin/whatsapp/chats                 chat list, newest first (?q= filters)
//   GET  /api/admin/whatsapp/chats/:phone          one conversation; marks it read
//   POST /api/admin/whatsapp/chats/:phone/send     { text } → reply from the active sender
//   POST /api/admin/whatsapp/chats/:phone/mode     { mode: auto | manual | default }
//   GET  /api/admin/whatsapp/inbox-settings        auto-reply settings
//   PUT  /api/admin/whatsapp/inbox-settings        { autoReply, defaultMode, message, cooldownHours }

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError } from '../shared/errors.js';
import { whatsappProvider } from '../whatsapp/cloud-api.js';
import { chatId, getInboxSettings, INBOX_DEFAULTS, phoneVariants, saveInboxSettings } from '../whatsapp/inbox.js';
import { sendReply } from '../whatsapp/reply.js';
import { linkStatus } from '../whatsapp/baileys.js';

export const adminWaInboxRouter = Router();
adminWaInboxRouter.use('/whatsapp', requireAuth('admin'));

const NOT_STATUS = { OR: [{ type: null }, { type: { not: 'status' } }] };

function audit(req: any, action: string, meta: object) {
  return prisma.auditLog
    .create({ data: { actorType: 'ADMIN', actorId: req.auth!.sub, action, meta: meta as any, ipAddress: req.ip ?? null } })
    .catch(() => {});
}

/** Who a number belongs to on Pets24x7, when we know. */
async function whoIs(phones: string[]): Promise<Map<string, string>> {
  const all = phones.filter((p) => !p.startsWith('lid:')).flatMap(phoneVariants);
  const out = new Map<string, string>();
  if (!all.length) return out;
  const [parents, vendors] = await Promise.all([
    prisma.petParent.findMany({ where: { phone: { in: all } }, select: { phone: true, name: true } }),
    prisma.vendor.findMany({ where: { phone: { in: all } }, select: { phone: true, businessName: true } }),
  ]);
  for (const p of parents) { const id = chatId(p.phone); if (id) out.set(id, `Pet parent · ${p.name}`); }
  for (const v of vendors) { const id = chatId(v.phone); if (id) out.set(id, `Business · ${v.businessName}`); }
  return out;
}

adminWaInboxRouter.get(
  '/whatsapp/chats',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const [rows, chats, settings] = await Promise.all([
      prisma.waMessage.findMany({
        where: NOT_STATUS,
        orderBy: { createdAt: 'desc' },
        take: 4000,
        select: { direction: true, fromNumber: true, toNumber: true, body: true, createdAt: true, type: true, status: true },
      }),
      prisma.waChat.findMany(),
      getInboxSettings(),
    ]);
    const meta = new Map(chats.map((c) => [c.phone, c]));

    interface Row { phone: string; name: string | null; lastText: string | null; lastAt: Date; lastDirection: string; lastStatus: string | null; unread: number; mode: string | null; effectiveMode: string; messages: number }
    const byPhone = new Map<string, Row>();
    for (const m of rows) {
      const id = chatId(m.direction === 'INBOUND' ? m.fromNumber : m.toNumber);
      if (!id) continue;
      let r = byPhone.get(id);
      if (!r) {
        const c = meta.get(id);
        r = { phone: id, name: c?.name ?? null, lastText: m.body, lastAt: m.createdAt, lastDirection: m.direction, lastStatus: m.status, unread: 0, mode: c?.mode ?? null, effectiveMode: c?.mode ?? settings.defaultMode, messages: 0 };
        byPhone.set(id, r);
      }
      r.messages++;
      const readAt = meta.get(id)?.lastReadAt;
      if (m.direction === 'INBOUND' && (!readAt || m.createdAt > readAt)) r.unread++;
    }
    const list = [...byPhone.values()];
    const who = await whoIs(list.slice(0, 300).map((r) => r.phone));
    let out = list.map((r) => ({ ...r, who: who.get(r.phone) ?? null }));
    if (q) out = out.filter((r) => [r.phone, r.name, r.who, r.lastText].some((x) => String(x ?? '').toLowerCase().includes(q)));
    const l = await linkStatus();
    res.json({
      ok: true,
      chats: out.slice(0, 300),
      settings,
      provider: whatsappProvider(),
      linked: { state: l.state, number: l.linkedNumber, usage: l.usage, limits: l.limits, error: l.error },
      unreadTotal: out.reduce((n, r) => n + r.unread, 0),
    });
  }),
);

adminWaInboxRouter.get(
  '/whatsapp/chats/:phone',
  asyncHandler(async (req, res) => {
    const id = chatId(String(req.params.phone));
    if (!id) throw new BadRequestError('Not a phone number');
    const v = phoneVariants(id);
    const [messages, chat, settings, who] = await Promise.all([
      prisma.waMessage.findMany({
        where: { AND: [NOT_STATUS, { OR: [{ direction: 'INBOUND', fromNumber: { in: v } }, { direction: 'OUTBOUND', toNumber: { in: v } }] }] },
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, direction: true, body: true, type: true, status: true, createdAt: true },
      }),
      prisma.waChat.upsert({ where: { phone: id }, update: { lastReadAt: new Date() }, create: { phone: id, lastReadAt: new Date() } }),
      getInboxSettings(),
      whoIs([id]),
    ]);
    // When did they last write? Meta only allows free text for 24h after that.
    const lastIn = messages.find((m) => m.direction === 'INBOUND')?.createdAt ?? null;
    res.json({
      ok: true,
      chat: { phone: id, name: chat.name, mode: chat.mode, effectiveMode: chat.mode ?? settings.defaultMode, who: who.get(id) ?? null, lastInboundAt: lastIn },
      messages: messages.reverse(),
      provider: whatsappProvider(),
    });
  }),
);

adminWaInboxRouter.post(
  '/whatsapp/chats/:phone/send',
  asyncHandler(async (req, res) => {
    const id = chatId(String(req.params.phone));
    if (!id) throw new BadRequestError('Not a phone number');
    const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body ?? {});
    try {
      const r = await sendReply(id, text, 'manual');
      await prisma.waChat.upsert({ where: { phone: id }, update: { lastReadAt: new Date() }, create: { phone: id, lastReadAt: new Date() } });
      await audit(req, 'whatsapp.reply', { phone: id, provider: r.provider });
      res.json({ ok: true, provider: r.provider });
    } catch (err) {
      throw new BadRequestError((err as Error).message);
    }
  }),
);

adminWaInboxRouter.post(
  '/whatsapp/chats/:phone/mode',
  asyncHandler(async (req, res) => {
    const id = chatId(String(req.params.phone));
    if (!id) throw new BadRequestError('Not a phone number');
    const { mode } = z.object({ mode: z.enum(['auto', 'manual', 'default']) }).parse(req.body ?? {});
    const value = mode === 'default' ? null : mode;
    await prisma.waChat.upsert({ where: { phone: id }, update: { mode: value }, create: { phone: id, mode: value } });
    await audit(req, 'whatsapp.chat_mode', { phone: id, mode });
    res.json({ ok: true, mode: value });
  }),
);

adminWaInboxRouter.get(
  '/whatsapp/inbox-settings',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, settings: await getInboxSettings(), defaults: INBOX_DEFAULTS });
  }),
);

adminWaInboxRouter.put(
  '/whatsapp/inbox-settings',
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        autoReply: z.boolean(),
        defaultMode: z.enum(['auto', 'manual']),
        message: z.string().trim().min(1).max(1000),
        cooldownHours: z.coerce.number().int().min(1).max(168),
        quickReplies: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
      })
      .parse(req.body ?? {});
    const saved = await saveInboxSettings(body as any, req.auth!.sub);
    await audit(req, 'whatsapp.inbox_settings', { autoReply: body.autoReply, defaultMode: body.defaultMode, cooldownHours: body.cooldownHours });
    res.json({ ok: true, settings: saved });
  }),
);
