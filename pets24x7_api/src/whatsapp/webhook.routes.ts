// Meta WhatsApp webhook for delivery status + inbound messages.
// Setup in Meta App Dashboard:
//   Callback URL: https://api.pets24x7.com/api/whatsapp/webhook
//   Verify Token: same value as env.WA_VERIFY_TOKEN
// Subscribe to: messages, message_status

import { Router } from 'express';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../shared/async-handler.js';

export const whatsappRouter = Router();

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
    // Meta retries aggressively if we don't 200 fast — ack first, work after.
    res.sendStatus(200);
    try {
      const body = req.body;
      for (const entry of body?.entry ?? []) {
        for (const change of entry?.changes ?? []) {
          const value = change?.value;
          for (const status of value?.statuses ?? []) {
            logger.debug({ status }, 'wa.status');
            // Phase 2: persist delivery state for OTPs / lead notifications.
          }
          for (const msg of value?.messages ?? []) {
            logger.info({ from: msg.from, type: msg.type }, 'wa.inbound');
            // Phase 2: route to vendor inbox / auto-reply.
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'wa.webhook processing error');
    }
  }),
);
