// Admin WhatsApp inbox: who messaged us, and the automatic reply.
//
// Every chat is either "auto" (the platform answers a new message once with
// the auto-reply, then a person takes over) or "manual" (only people reply).
// A chat without its own choice follows the inbox default. The auto-reply
// answers someone at most once per cooldown, and only after they wrote first,
// so it never starts conversations.

import { prisma } from '../db.js';
import { logger } from '../logger.js';

export interface InboxSettings {
  /** Master switch for the automatic reply. */
  autoReply: boolean;
  /** What a chat without its own choice does. */
  defaultMode: 'auto' | 'manual';
  /** The reply text. {name} is replaced with the sender's WhatsApp name. */
  message: string;
  /** Hours before the same person can get the auto-reply again. */
  cooldownHours: number;
  /** Canned answers the team can drop into a reply with one tap. */
  quickReplies: string[];
}

const KEY = 'wa_inbox';
export const INBOX_DEFAULTS: InboxSettings = {
  autoReply: true,
  defaultMode: 'auto',
  message:
    'Hi {name}! Thanks for messaging Pets24x7 🐾 Our team will reply here shortly (9 am to 9 pm IST). ' +
    'Meanwhile you can find vets, groomers and boarding near you at https://pets24x7.com',
  cooldownHours: 12,
  quickReplies: [
    'Thanks for reaching out! Which city are you in, and what does your pet need?',
    'We have shared your request with the business. They will contact you shortly.',
    'You can find vets, groomers and boarding near you at https://pets24x7.com',
    "Could you share your pet's breed and age so we can suggest the right service?",
  ],
};

export async function getInboxSettings(): Promise<InboxSettings> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } }).catch(() => null);
  return { ...INBOX_DEFAULTS, ...((row?.value as Partial<InboxSettings>) ?? {}) };
}

export async function saveInboxSettings(next: InboxSettings, by: string): Promise<InboxSettings> {
  await prisma.setting.upsert({
    where: { key: KEY },
    update: { value: next as any, updatedBy: by },
    create: { key: KEY, value: next as any, updatedBy: by },
  });
  return next;
}

/**
 * Canonical chat id: "+<digits>" for a phone number (Meta sends bare digits,
 * Baileys +digits), or "lid:<digits>" for a WhatsApp user whose number is hidden.
 */
export function chatId(raw: string | null | undefined): string | null {
  const r = String(raw ?? '').trim();
  if (/^lid:\d+$/.test(r)) return r;
  const d = r.replace(/\D/g, '');
  return d.length >= 8 ? '+' + d : null;
}

/** All the spellings a chat id is stored under in the message log. */
export function phoneVariants(id: string): string[] {
  if (id.startsWith('lid:')) return [id];
  const d = id.replace(/\D/g, '');
  return ['+' + d, d];
}

/**
 * Record an incoming message on its chat and, when the chat is automatic,
 * answer it once. Never throws.
 */
export async function handleInbound(rawPhone: string, name: string | null): Promise<void> {
  const phone = chatId(rawPhone);
  if (!phone) return;
  try {
    const chat = await prisma.waChat.upsert({
      where: { phone },
      update: name ? { name } : {},
      create: { phone, name },
    });
    const s = await getInboxSettings();
    const mode = chat.mode ?? s.defaultMode;
    if (!s.autoReply || mode !== 'auto' || !s.message.trim()) return;
    if (chat.lastAutoReplyAt && Date.now() - chat.lastAutoReplyAt.getTime() < s.cooldownHours * 3_600_000) return;

    // Claim the slot first so two quick messages cannot both trigger a reply.
    const claimed = await prisma.waChat.updateMany({
      where: { phone, OR: [{ lastAutoReplyAt: null }, { lastAutoReplyAt: { lt: new Date(Date.now() - s.cooldownHours * 3_600_000) } }] },
      data: { lastAutoReplyAt: new Date() },
    });
    if (!claimed.count) return;

    const text = s.message.replace(/\{name\}/g, (name || chat.name || 'there').split(' ')[0] ?? 'there');
    const { sendReply } = await import('./reply.js');
    try {
      await sendReply(phone, text, 'auto');
    } catch (err) {
      // Not sent (no sender, cap reached): free the slot for the next message.
      await prisma.waChat.update({ where: { phone }, data: { lastAutoReplyAt: chat.lastAutoReplyAt } }).catch(() => {});
      throw err;
    }
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err), phone }, 'inbox: auto-reply skipped');
  }
}
