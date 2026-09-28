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
  useMultiFileAuthState,
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
  type: string; status: string; body?: string | null; payload?: unknown;
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
        if (!qrDeadline) qrDeadline = Date.now() + 3 * 60_000;
        // Nobody scanned for three minutes: stop showing codes until asked again.
        if (Date.now() > qrDeadline) { stopBaileys(); lastError = 'Linking timed out. Press "Link a number" again.'; }
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
          logger.warn('baileys: logged out, session removed');
          return;
        }
        state = 'connecting';
        const wait = Math.min(60_000, 3_000 * 2 ** retry++);
        lastError = `Connection dropped (${code ?? 'unknown'}), reconnecting in ${Math.round(wait / 1000)}s.`;
        setTimeout(() => { startBaileys().catch(() => {}); }, wait);
      }
    });

    // Replies from people land in the admin WhatsApp log.
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key.fromMe || !m.key.remoteJid?.endsWith('@s.whatsapp.net')) continue;
        const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null;
        void logRow({ waMessageId: m.key.id ?? null, direction: 'INBOUND', fromNumber: '+' + m.key.remoteJid.split('@')[0], toNumber: me ? '+' + me : null, type: 'baileys:text', status: 'received', body: text });
      }
    });
  })().catch((err) => {
    starting = null; state = 'off';
    lastError = (err as Error).message;
    logger.error({ err }, 'baileys: start failed');
  });
  return starting;
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
  stoppedByUs = true;
  try { await sock?.logout(); } catch { /* not connected */ }
  stopBaileys();
  fs.rmSync(DIR, { recursive: true, force: true });
  state = 'off'; me = null; lastError = null;
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
export function baileysSend(rawPhone: string, text: string, kind: 'otp' | 'notice'): Promise<{ messageId: string }> {
  const to = normalizePhone(rawPhone);
  const digits = to.replace(/\D/g, '');
  const job = queue.then(async () => {
    if (!baileysReady()) throw new Error('The linked WhatsApp number is not connected.');

    const now = Date.now();
    while (recent.length && now - (recent[0] ?? now) > 60_000) recent.shift();
    if (recent.length >= env.WA_BAILEYS_PER_MINUTE) throw new WaLimitError('WhatsApp is busy right now. Please try again in a minute.');
    const [hour, day, toHour] = await Promise.all([sentSince(60 * 60_000), sentSince(24 * 60 * 60_000), sentSince(60 * 60_000, to)]);
    if (hour >= env.WA_BAILEYS_PER_HOUR || day >= env.WA_BAILEYS_PER_DAY) throw new WaLimitError('WhatsApp sending limit reached for now. Please use email instead.');
    if (toHour >= env.WA_BAILEYS_PER_NUMBER_PER_HOUR) throw new WaLimitError('Too many messages to this number. Please try again later.');

    const jid = await resolveJid(digits);
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
