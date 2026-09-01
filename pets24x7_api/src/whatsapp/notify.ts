// Best-effort outbound notifications + a helper to persist every WA message
// event into the WaMessage log. Never throws — notifications must not break
// the request that triggered them.

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { sendText } from './cloud-api.js';
import { normalizePhone } from '../shared/phone.js';

export async function logWaMessage(entry: {
  waMessageId?: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | 'STATUS';
  fromNumber?: string | null;
  toNumber?: string | null;
  type?: string | null;
  status?: string | null;
  body?: string | null;
  payload?: unknown;
}): Promise<void> {
  try {
    if (entry.waMessageId && (entry.direction === 'OUTBOUND' || entry.direction === 'INBOUND')) {
      await prisma.waMessage.upsert({
        where: { waMessageId: entry.waMessageId },
        update: { status: entry.status ?? undefined, payload: (entry.payload ?? undefined) as any },
        create: {
          waMessageId: entry.waMessageId,
          direction: entry.direction,
          fromNumber: entry.fromNumber ?? null,
          toNumber: entry.toNumber ?? null,
          type: entry.type ?? null,
          status: entry.status ?? null,
          body: entry.body ?? null,
          payload: (entry.payload ?? undefined) as any,
        },
      });
      return;
    }
    await prisma.waMessage.create({
      data: {
        waMessageId: entry.waMessageId ?? null,
        direction: entry.direction,
        fromNumber: entry.fromNumber ?? null,
        toNumber: entry.toNumber ?? null,
        type: entry.type ?? null,
        status: entry.status ?? null,
        body: entry.body ?? null,
        payload: (entry.payload ?? undefined) as any,
      },
    });
  } catch (err) {
    logger.warn({ err }, 'logWaMessage failed');
  }
}

// Fire-and-forget plain-text nudge. Only lands if the recipient messaged us in
// the last 24h (WA service window); otherwise Meta rejects it — we swallow that.
export async function notify(rawPhone: string, text: string): Promise<void> {
  const phone = normalizePhone(rawPhone);
  try {
    const { messageId } = await sendText(phone, text);
    await logWaMessage({ waMessageId: messageId, direction: 'OUTBOUND', toNumber: phone, type: 'text', status: 'sent', body: text });
  } catch (err: any) {
    await logWaMessage({ direction: 'OUTBOUND', toNumber: phone, type: 'text', status: 'failed', body: text, payload: { error: String(err?.message ?? err) } });
    logger.debug({ err: String(err?.message ?? err), phone }, 'notify: WA send skipped');
  }
}

export async function notifyVendorById(vendorId: string, text: string): Promise<void> {
  try {
    const v = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { phone: true } });
    if (v?.phone) await notify(v.phone, text);
  } catch (err) {
    logger.debug({ err }, 'notifyVendorById failed');
  }
}
