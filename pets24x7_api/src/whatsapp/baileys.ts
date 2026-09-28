// Linked-number WhatsApp sender (Baileys: WhatsApp Web protocol, unofficial).
//
// Used for LOW-VOLUME, one-to-one transactional messages only: sign-in /
// claim codes and short account notices. Never for bulk or marketing — that
// is what gets a number banned. Review requests and anything sent to many
// people stay on the Meta Cloud API.
//
// Safety rules applied to every send:
//   - one message at a time, through a single queue, with a minimum gap plus
//     random jitter between messages
//   - caps per minute / hour / day (day cap is counted from the database, so a
//     restart does not reset it) and per recipient per hour
//   - the recipient must be on WhatsApp (checked first, cached)
//   - a short "typing…" before each message, like a person
//   - plain text only, no links in codes
//
// The number is linked once from Admin > Settings (QR or pairing code); the
// session keys live in WA_BAILEYS_DIR and survive restarts and deploys.

import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  isPnUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { normalizePhone } from '../shared/phone.js';

export type LinkState = 'off' | 'connecting' | 'qr' | 'open' | 'logged_out';

const DIR = path.resolve(env.WA_BAILEYS_DIR);
const quiet = pino({ level: 'silent' });

let sock: WASocket | null = null;
let state: LinkState = 'off';
let qr: string | null = null;
let me: string | null = null;
let lastError: string | null = null;
let retry = 0;
let qrDeadline = 0;
let starting: Promise<void> | null = null;
let stoppedByUs = false;

function hasSession(): boolean {
  return fs.existsSync(path.join(DIR, 'creds.json'));
}

/** True when the linked number is connected and can send. */
export function baileysReady(): boolean {
  return state === 'open' && !!sock;
}

async function logRow(data: {
  waMessageId?: string | null; direction: 'INBOUND' | 'OUTBOUND'; fromNumber?: string | null; toNumber?: string | null;
  type: string; status: string; body?: string | null; payload?: unknown; createdAt?: Date;
}) {
  try {
    await prisma.waMessage.create({ data: { ...data, payload: (data.payload ?? undefined) as any } });
  } catch (err) {
    logger.debug({ err }, 'baileys: log row failed');
  }
}

/** Connect (or reconnect) the linked number. Shows a QR until it is scanned. */
export function startBaileys(): Promise<void> {
  if (starting) return starting;
  stoppedByUs = false;
  starting = (async () => {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const { state: auth, saveCreds } = await useMultiFileAuthState(DIR);
    let version: [number, number, number] | undefined;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { /* use the built-in one */ }

    state = 'connecting';
    lastError = null;
    const s = makeWASocket({
      auth,
      version,
      logger: quiet,
      browser: Browsers.ubuntu('Pets24x7'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
    } as any);
    sock = s;
    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', (u) => {
      if (u.qr) {
        qr = u.qr;
        state = 'qr';
        if (!qrDeadline) qrDeadline = Date.now() + 5 * 60_000;
        // Nobody scanned for five minutes: stop showing codes until asked again.
        if (Date.now() > qrDeadline) { stopBaileys(); lastError = 'The QR code expired before it was scanned. Press "Link with QR code" to get a new one.'; }
      }
      if (u.connection === 'open') {
        state = 'open'; qr = null; qrDeadline = 0; retry = 0;
        me = s.user?.id ? (s.user.id.split(':')[0] ?? '').split('@')[0] || null : null;
        logger.info({ me }, 'baileys: linked number connected');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        sock = null; starting = null;
        if (stoppedByUs) { state = 'off'; return; }
        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone (Linked devices > Log out) or banned.
          state = 'logged_out'; me = null; qr = null;
          lastError = 'The number was logged out. Link it again.';
          fs.rmSync(DIR, { recursive: true, force: true });
          void purgeLinkedChats();
          logger.warn('baileys: logged out, session removed');
          return;
        }
        state = 'connecting';
        const wait = Math.min(60_000, 3_000 * 2 ** retry++);
        lastError = `Connection dropped (${code ?? 'unknown'}), reconnecting in ${Math.round(wait / 1000)}s.`;
        setTimeout(() => { startBaileys().catch(() => {}); }, wait);
      }
    });

    // Every one-to-one message lands in the admin inbox: what people send us,
    // and what the team types on the phone itself. New incoming messages may
    // get the auto-reply (see inbox.ts).
    s.ev.on('messages.upsert', ({ messages, type }) => {
      // notify = new messages; append = ones sent from the phone or other devices
      for (const m of messages) void onMessage(s, m, type === 'notify');
    });

    // Right after linking WhatsApp sends recent chats once: import them so the
    // inbox starts with the conversations already on the phone.
    s.ev.on('messaging-history.set', ({ messages, contacts }) => {
      void (async () => {
        for (const c of contacts ?? []) await saveContactName(s, c.id, (c as any).name || c.notify || (c as any).verifiedName);
        const since = Date.now() - HISTORY_DAYS * 86_400_000;
        const recentMsgs = (messages ?? [])
          .filter((m) => tsOf(m) >= since)
          .sort((a, b) => tsOf(a) - tsOf(b))
          .slice(-HISTORY_MAX);
        for (const m of recentMsgs) await onMessage(s, m, false);
        if (recentMsgs.length) logger.info({ n: recentMsgs.length }, 'baileys: chat history imported');
      })();
    });
    // Deleted on WhatsApp: a message deleted for everyone, or a whole chat
    // deleted on the phone, goes from the inbox too.
    s.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        const revoked = (u.update as any)?.message === null || (u.update as any)?.messageStubType === 1;
        if (revoked && u.key.id) void markDeleted(u.key.id);
      }
    });
    s.ev.on('chats.delete', (ids) => {
      void (async () => {
        const { phoneVariants } = await import('./inbox.js');
        for (const id of ids) {
          const key = await keyForJid(s, id);
          if (!key) continue;
          const v = phoneVariants(key);
          await prisma.waMessage.deleteMany({ where: { OR: [{ fromNumber: { in: v } }, { toNumber: { in: v } }] } }).catch(() => {});
          await prisma.waChat.deleteMany({ where: { phone: key } }).catch(() => {});
        }
      })();
    });
    s.ev.on('contacts.upsert', (list) => { for (const c of list) void saveContactName(s, c.id, (c as any).name || c.notify); });
    s.ev.on('contacts.update', (list) => { for (const c of list) if (c.id) void saveContactName(s, c.id, (c as any).name || c.notify); });
  })().catch((err) => {
    starting = null; state = 'off';
    lastError = (err as Error).message;
    logger.error({ err }, 'baileys: start failed');
  });
  return starting;
}

function textOf(m: WAMessage): string | null {
  const c: any = m.message ?? {};
  const inner = c.ephemeralMessage?.message ?? c.viewOnceMessage?.message ?? c;
  return inner.conversation ?? inner.extendedTextMessage?.text ?? inner.imageMessage?.caption ?? inner.videoMessage?.caption
    ?? (inner.imageMessage ? '[photo]' : inner.videoMessage ? '[video]' : inner.audioMessage ? '[voice note]' : inner.documentMessage ? '[document]'
      : inner.stickerMessage ? '[sticker]' : inner.locationMessage ? '[location]' : inner.contactMessage ? '[contact]' : null);
}

const HISTORY_DAYS = 60;

/** Ids of messages this server sent, so their echo is not mistaken for a person typing. */
const sentByServer = new Set<string>();

async function markDeleted(id: string): Promise<void> {
  await prisma.waMessage.updateMany({ where: { waMessageId: id }, data: { body: 'This message was deleted', status: 'deleted' } }).catch(() => {});
}
const HISTORY_MAX = 5000;

function tsOf(m: WAMessage): number {
  const t = Number((m.messageTimestamp as any)?.toNumber?.() ?? m.messageTimestamp ?? 0);
  return t > 0 ? t * 1000 : Date.now();
}

/**
 * The inbox key for a WhatsApp id: "+<digits>" for a phone number, or
 * "lid:<digits>" when WhatsApp hides the number and we cannot map it back.
 */
async function keyForJid(s: WASocket, jid: string | null | undefined, alt?: string | null): Promise<string | null> {
  if (!jid) return null;
  let pn: string | null = isPnUser(jid) ? jid : isPnUser(alt ?? undefined) ? alt! : null;
  if (!pn && isLidUser(jid)) {
    try { pn = await (s as any).signalRepository?.lidMapping?.getPNForLID(jid); } catch { pn = null; }
  }
  if (pn) {
    const d = pn.split('@')[0]?.split(':')[0] ?? '';
    return /^\d{8,}$/.test(d) ? '+' + d : null;
  }
  if (isLidUser(jid)) {
    const d = jid.split('@')[0]?.split(':')[0] ?? '';
    return /^\d+$/.test(d) ? 'lid:' + d : null;
  }
  return null;
}

async function saveContactName(s: WASocket, jid: string | undefined, name: string | null | undefined): Promise<void> {
  if (!jid || !name || jid.endsWith('@g.us')) return;
  const key = await keyForJid(s, jid);
  if (!key || (me && key === '+' + me)) return;
  await prisma.waChat.upsert({ where: { phone: key }, update: { name: name.slice(0, 120) }, create: { phone: key, name: name.slice(0, 120) } }).catch(() => {});
}

async function onMessage(s: WASocket, m: WAMessage, live: boolean): Promise<void> {
  try {
    const jid = m.key.remoteJid ?? '';
    const proto = (m.message as any)?.protocolMessage;
    if (proto && proto.type === 0 && proto.key?.id) { await markDeleted(proto.key.id); return; } // "delete for everyone"
    if (!m.message || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
    const key = await keyForJid(s, jid, (m.key as any).remoteJidAlt);
    if (!key || (me && key === '+' + me)) return;
    const text = textOf(m);
    if (!text) return; // protocol messages, reactions, receipts
    const createdAt = new Date(tsOf(m));
    if (m.key.fromMe) {
      // Our own sends come back here as an echo, sometimes before the send
      // returns; wait a moment so they are not mistaken for the phone.
      const id = m.key.id ?? '';
      const recentLive = live && Date.now() - createdAt.getTime() < 5 * 60_000;
      const record = async () => {
        if (sentByServer.has(id)) return;
        await logRow({ waMessageId: id || null, direction: 'OUTBOUND', fromNumber: me ? '+' + me : null, toNumber: key, type: 'phone:text', status: 'sent', body: text, createdAt });
        // Someone typed on the phone just now: a person is handling this chat.
        if (recentLive) { const { pauseAi } = await import('./inbox.js'); await pauseAi(key); }
      };
      if (recentLive) setTimeout(() => { void record(); }, 4000); else await record();
      return;
    }
    await logRow({ waMessageId: m.key.id ?? null, direction: 'INBOUND', fromNumber: key, toNumber: me ? '+' + me : null, type: 'baileys:text', status: 'received', body: text, createdAt });
    if (m.pushName) {
      // Their WhatsApp name, unless the phone's address book already named them.
      const chat = await prisma.waChat.findUnique({ where: { phone: key } }).catch(() => null);
      if (!chat) await prisma.waChat.create({ data: { phone: key, name: m.pushName.slice(0, 120) } }).catch(() => {});
      else if (!chat.name) await prisma.waChat.update({ where: { phone: key }, data: { name: m.pushName.slice(0, 120) } }).catch(() => {});
    }
    // Only a fresh message may get the auto-reply, never imported history.
    if (!live || Date.now() - createdAt.getTime() > 10 * 60_000) return;
    const { handleInbound } = await import('./inbox.js');
    await handleInbound(key, m.pushName ?? null);
  } catch (err) {
    logger.debug({ err }, 'baileys: incoming message not handled');
  }
}

/** Connect on boot only when a number was linked before (no QR loop on a fresh server). */
export function startBaileysIfLinked(): void {
  if (env.WA_PROVIDER === 'meta') return;
  if (hasSession()) startBaileys().catch(() => {});
}

export function stopBaileys(): void {
  stoppedByUs = true;
  try { sock?.end(undefined); } catch { /* already closed */ }
  sock = null; starting = null; state = 'off'; qr = null; qrDeadline = 0;
}

/** Log the linked device out on WhatsApp's side and forget the keys. */
export async function unlinkBaileys(): Promise<void> {
  // Cancelling a QR that was never scanned is not an unlink: keep the inbox.
  const wasLinked = !!me || linkedBefore();
  stoppedByUs = true;
  try { await sock?.logout(); } catch { /* not connected */ }
  stopBaileys();
  fs.rmSync(DIR, { recursive: true, force: true });
  state = 'off'; me = null; lastError = null;
  if (wasLinked) await purgeLinkedChats();
}

/** The saved session belongs to a number that finished linking. */
function linkedBefore(): boolean {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(DIR, 'creds.json'), 'utf8'));
    return !!creds?.me?.id;
  } catch {
    return false;
  }
}

/**
 * The number is gone: its chats leave the inbox with it. Rows that only exist
 * because of the linked number (and old notices that were never delivered)
 * are removed; the linked-number usage caps start again from zero.
 */
export async function purgeLinkedChats(): Promise<void> {
  try {
    const gone = await prisma.waMessage.deleteMany({ where: { OR: [{ type: { startsWith: 'baileys' } }, { type: { startsWith: 'phone:' } }, { status: 'failed' }] } });
    await prisma.waChat.deleteMany({});
    logger.info({ messages: gone.count }, 'baileys: linked chats cleared');
  } catch (err) {
    logger.warn({ err }, 'baileys: could not clear chats');
  }
}

/** WhatsApp id for an inbox key. */
export function jidForKey(key: string): string {
  return key.startsWith('lid:') ? key.slice(4) + '@lid' : key.replace(/\D/g, '') + '@s.whatsapp.net';
}

/**
 * Delete a chat on the linked phone as well (best effort: WhatsApp needs the
 * newest message's id and time to accept it).
 */
export async function deleteChatOnPhone(key: string): Promise<boolean> {
  if (!sock || state !== 'open') return false;
  const { phoneVariants } = await import('./inbox.js');
  const last = await prisma.waMessage.findFirst({
    where: { waMessageId: { not: null }, OR: [{ direction: 'INBOUND', fromNumber: { in: phoneVariants(key) } }, { direction: 'OUTBOUND', toNumber: { in: phoneVariants(key) } }] },
    orderBy: { createdAt: 'desc' },
  });
  if (!last?.waMessageId) return false;
  const jid = jidForKey(key);
  try {
    await sock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: jid, id: last.waMessageId, fromMe: last.direction === 'OUTBOUND' }, messageTimestamp: Math.floor(last.createdAt.getTime() / 1000) }] } as any, jid);
    return true;
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err) }, 'baileys: delete chat on phone failed');
    return false;
  }
}

/** Link with an 8-character code typed on the phone instead of scanning a QR. */
export async function requestPairingCode(phone: string): Promise<string> {
  if (state === 'open') throw new Error('A number is already linked.');
  await startBaileys();
  // The socket accepts a pairing request once it has reached the QR stage.
  const until = Date.now() + 20_000;
  while (state !== 'qr' && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  if (!sock || state !== 'qr') throw new Error('WhatsApp did not answer. Try again in a minute.');
  const digits = normalizePhone(phone).replace(/\D/g, '');
  const code = await sock.requestPairingCode(digits);
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export async function linkStatus() {
  const [hour, day] = await Promise.all([sentSince(60 * 60_000), sentSince(24 * 60 * 60_000)]);
  return {
    state,
    linkedNumber: me ? '+' + me : null,
    qrSvg: state === 'qr' && qr ? await QRCode.toString(qr, { type: 'svg', margin: 1, width: 240 }) : null,
    error: lastError,
    usage: { lastHour: hour, last24h: day },
    limits: {
      perMinute: env.WA_BAILEYS_PER_MINUTE,
      perHour: env.WA_BAILEYS_PER_HOUR,
      perDay: env.WA_BAILEYS_PER_DAY,
      perNumberPerHour: env.WA_BAILEYS_PER_NUMBER_PER_HOUR,
    },
  };
}

// ---------------------------------------------------------------- sending --

function sentSince(ms: number, to?: string): Promise<number> {
  return prisma.waMessage.count({
    where: { direction: 'OUTBOUND', type: { startsWith: 'baileys' }, status: 'sent', createdAt: { gte: new Date(Date.now() - ms) }, ...(to ? { toNumber: to } : {}) },
  });
}

const recent: number[] = []; // send times in this process, for the per-minute cap
let queue: Promise<unknown> = Promise.resolve();
let lastSentAt = 0;
const onWaCache = new Map<string, { jid: string | null; at: number }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WaLimitError extends Error {}

async function resolveJid(digits: string): Promise<string | null> {
  const hit = onWaCache.get(digits);
  if (hit && Date.now() - hit.at < 24 * 60 * 60_000) return hit.jid;
  const res = await sock!.onWhatsApp(digits);
  const found = res?.find((r) => r.exists);
  const jid = found ? found.jid : null;
  onWaCache.set(digits, { jid, at: Date.now() });
  return jid;
}

/**
 * Queue one plain-text message to one person on the linked number. Resolves
 * with the WhatsApp message id once it is sent; rejects when a cap is hit,
 * the number is not on WhatsApp, or the link is down.
 */
export function baileysSend(rawPhone: string, text: string, kind: 'otp' | 'notice' | 'reply' | 'auto' | 'ai'): Promise<{ messageId: string }> {
  const isLid = rawPhone.startsWith('lid:');
  const to = isLid ? rawPhone : normalizePhone(rawPhone);
  const digits = to.replace(/\D/g, '');
  const job = queue.then(async () => {
    if (!baileysReady()) throw new Error('The linked WhatsApp number is not connected.');

    const now = Date.now();
    while (recent.length && now - (recent[0] ?? now) > 60_000) recent.shift();
    if (recent.length >= env.WA_BAILEYS_PER_MINUTE) throw new WaLimitError('WhatsApp is busy right now. Please try again in a minute.');
    const [hour, day, toHour] = await Promise.all([sentSince(60 * 60_000), sentSince(24 * 60 * 60_000), sentSince(60 * 60_000, to)]);
    if (hour >= env.WA_BAILEYS_PER_HOUR || day >= env.WA_BAILEYS_PER_DAY) throw new WaLimitError('WhatsApp sending limit reached for now. Please use email instead.');
    // Codes and notices are capped per person; replies in a conversation they started are not.
    if ((kind === 'otp' || kind === 'notice') && toHour >= env.WA_BAILEYS_PER_NUMBER_PER_HOUR) throw new WaLimitError('Too many messages to this number. Please try again later.');

    const jid = isLid ? digits + '@lid' : await resolveJid(digits);
    if (!jid) throw new Error('This number is not on WhatsApp.');

    // Keep a human pace between messages.
    const gap = env.WA_BAILEYS_MIN_GAP_MS + Math.floor(Math.random() * 2500);
    const wait = lastSentAt + gap - Date.now();
    if (wait > 0) await sleep(wait);

    try { await sock!.presenceSubscribe(jid); await sock!.sendPresenceUpdate('composing', jid); } catch { /* cosmetic */ }
    await sleep(900 + Math.floor(Math.random() * 1400));
    try { await sock!.sendPresenceUpdate('paused', jid); } catch { /* cosmetic */ }

    const sent = await sock!.sendMessage(jid, { text });
    lastSentAt = Date.now();
    recent.push(lastSentAt);
    const messageId = sent?.key?.id ?? '';
    if (messageId) {
      sentByServer.add(messageId);
      if (sentByServer.size > 500) sentByServer.delete(sentByServer.values().next().value as string);
    }
    await logRow({ waMessageId: messageId || null, direction: 'OUTBOUND', fromNumber: me ? '+' + me : null, toNumber: to, type: `baileys:${kind}`, status: 'sent', body: kind === 'otp' ? '(verification code)' : text });
    return { messageId };
  });
  // A failed job must not block the ones behind it.
  queue = job.catch(() => {});
  return job.catch(async (err) => {
    if (!(err instanceof WaLimitError)) {
      await logRow({ direction: 'OUTBOUND', toNumber: to, type: `baileys:${kind}`, status: 'failed', body: kind === 'otp' ? '(verification code)' : text, payload: { error: String((err as Error).message) } });
    }
    throw err;
  });
}

export function otpText(code: string): string {
  return `${code} is your Pets24x7 verification code. It expires in 10 minutes. Do not share it with anyone.`;
}
