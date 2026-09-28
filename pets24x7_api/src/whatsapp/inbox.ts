// Admin WhatsApp inbox: who messaged us, and the automatic reply.
//
// Every chat is either "auto" or "manual"; a chat without its own choice
// follows the inbox default. In an automatic chat:
//   - with AI on, Claude answers each new message (a few seconds after the
//     last one in a burst), up to a daily limit per chat, and goes quiet for
//     a while whenever someone on the team replies;
//   - otherwise, or when the AI fails, the template reply goes out, at most
//     once per cooldown.
// Manual chats never get an automatic message. Nothing here ever starts a
// conversation: it only answers someone who just wrote.

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
  /** Let Claude answer automatic chats (needs ANTHROPIC_API_KEY). */
  aiEnabled: boolean;
  /** Extra facts and rules for the AI: hours, cities, offers, tone. */
  aiInstructions: string;
  /** Most AI messages to one person in 24 hours. */
  aiMaxPerChatPerDay: number;
  /** After a person on the team replies, the AI stays quiet this many hours. */
  aiPauseHours: number;
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
  aiEnabled: true,
  aiInstructions: 'Team hours: 9 am to 9 pm IST, every day.',
  aiMaxPerChatPerDay: 8,
  aiPauseHours: 12,
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

/** Someone on the team answered this chat: keep the AI out of it for a while. */
export async function pauseAi(phone: string): Promise<void> {
  const st = await getInboxSettings();
  const until = new Date(Date.now() + st.aiPauseHours * 3_600_000);
  await prisma.waChat.upsert({ where: { phone }, update: { aiPausedUntil: until }, create: { phone, aiPausedUntil: until } }).catch(() => {});
}

// A burst of messages ("hi" / "need a groomer" / "in Pune") gets one answer:
// wait a few seconds after the latest one before replying.
const QUIET_MS = 7_000;
const pendingReply = new Map<string, NodeJS.Timeout>();

/**
 * Record an incoming message on its chat and, when the chat is automatic,
 * answer it. Never throws.
 */
export async function handleInbound(rawPhone: string, name: string | null): Promise<void> {
  const phone = chatId(rawPhone);
  if (!phone) return;
  try {
    await prisma.waChat.upsert({ where: { phone }, update: name ? { name } : {}, create: { phone, name } });
  } catch { /* the reply can still go */ }
  clearTimeout(pendingReply.get(phone));
  pendingReply.set(phone, setTimeout(() => {
    pendingReply.delete(phone);
    void answer(phone, name);
  }, QUIET_MS));
}

async function answer(phone: string, name: string | null): Promise<void> {
  try {
    const chat = await prisma.waChat.findUnique({ where: { phone } });
    if (!chat) return;
    const s = await getInboxSettings();
    const mode = chat.mode ?? s.defaultMode;
    if (!s.autoReply || mode !== 'auto') return;
    const { sendReply } = await import('./reply.js');

    // 1) AI, when on and nobody from the team is handling this chat.
    const { aiConfigured } = await import('../ai/claude.js');
    const aiPaused = chat.aiPausedUntil && chat.aiPausedUntil > new Date();
    if (s.aiEnabled && aiConfigured() && !aiPaused) {
      const sentToday = await prisma.waMessage.count({
        where: { direction: 'OUTBOUND', toNumber: { in: phoneVariants(phone) }, type: { endsWith: ':ai' }, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      });
      if (sentToday < s.aiMaxPerChatPerDay) {
        try {
          const { draftReply } = await import('./ai-reply.js');
          const text = await draftReply(phone, { instructions: s.aiInstructions, name: name || chat.name });
          if (text) await sendReply(phone, text, 'ai');
          return; // answered, or the AI judged no answer was needed
        } catch (err) {
          logger.warn({ err: String((err as Error)?.message ?? err), phone }, 'inbox: AI reply failed, using the template');
        }
      }
    }
    if (aiPaused) return; // a person is on it

    // 2) Template reply, at most once per cooldown.
    if (!s.message.trim()) return;
    if (chat.lastAutoReplyAt && Date.now() - chat.lastAutoReplyAt.getTime() < s.cooldownHours * 3_600_000) return;
    // Claim the slot first so two quick messages cannot both trigger a reply.
    const claimed = await prisma.waChat.updateMany({
      where: { phone, OR: [{ lastAutoReplyAt: null }, { lastAutoReplyAt: { lt: new Date(Date.now() - s.cooldownHours * 3_600_000) } }] },
      data: { lastAutoReplyAt: new Date() },
    });
    if (!claimed.count) return;
    const text = s.message.replace(/\{name\}/g, (name || chat.name || 'there').split(' ')[0] ?? 'there');
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
