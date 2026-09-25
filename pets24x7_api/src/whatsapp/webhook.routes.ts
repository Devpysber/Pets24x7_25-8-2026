// Meta WhatsApp webhook for delivery status + inbound messages.
// Setup in Meta App Dashboard:
//   Callback URL: https://api.pets24x7.com/api/whatsapp/webhook
//   Verify Token: same value as env.WA_VERIFY_TOKEN
// Subscribe to: messages, message_status

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../shared/async-handler.js';
import { logWaMessage } from './notify.js';

export const whatsappRouter = Router();

/**
 * Meta signs every event POST with X-Hub-Signature-256 = HMAC-SHA256 of the raw
 * body under the app secret. Without the check anyone can post fabricated
 * delivery statuses and inbound messages into the WaMessage log. The secret is
 * optional (WA_APP_SECRET); until it is set the check is skipped with a warning.
 */
function signatureOk(raw: Buffer | undefined, header: string | undefined): boolean {
  const secret = (process.env.WA_APP_SECRET ?? '').trim();
  if (!secret) return true;
  if (!raw || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
if (!(process.env.WA_APP_SECRET ?? '').trim()) {
  logger.warn('WA_APP_SECRET is not set — WhatsApp webhook signatures are not being verified');
}

// GET — handshake verification.
whatsappRouter.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WA_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});

// POST — event delivery (status updates, inbound messages).
whatsappRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    if (!signatureOk((req as any).rawBody as Buffer | undefined, req.get('x-hub-signature-256'))) {
      logger.warn('wa.webhook signature mismatch — ignored');
      return res.sendStatus(401);
    }
    // Meta retries aggressively if we don't 200 fast — ack first, work after.
    res.sendStatus(200);
    try {
      const body = req.body;
      for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value;
          const displayNumber = value?.metadata?.display_phone_number ?? null;
          for (const status of value?.statuses ?? []) {
            logger.debug({ status }, 'wa.status');
            await logWaMessage({
              waMessageId: status.id ?? null,
              direction: 'OUTBOUND',
              toNumber: status.recipient_id ?? null,
              fromNumber: displayNumber,
              type: 'status',
              status: status.status ?? null,
              payload: status,
            });
          }
          for (const msg of value?.messages ?? []) {
            logger.info({ from: msg.from, type: msg.type }, 'wa.inbound');
            await logWaMessage({
              waMessageId: msg.id ?? null,
              direction: 'INBOUND',
              fromNumber: msg.from ?? null,
              toNumber: displayNumber,
              type: msg.type ?? null,
              status: 'received',
              body: msg.text?.body ?? msg.button?.text ?? null,
              payload: msg,
            });
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'wa.webhook processing error');
    }
  }),
);
