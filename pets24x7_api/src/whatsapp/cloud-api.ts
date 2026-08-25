// Thin client over Meta's WhatsApp Cloud Graph API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
//
// We use a single approved Authentication template ("pets24x7_otp") that takes
// one variable (the OTP). Approve the template in WhatsApp Manager BEFORE
// going live — Meta won't deliver non-template messages to non-opted-in users.

import { env } from '../env.js';
import { logger } from '../logger.js';
import { normalizePhone } from '../shared/phone.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

interface SendResponse {
  messaging_product?: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string }[];
  error?: { code: number; message: string; type?: string };
}

async function postMessage(body: unknown): Promise<SendResponse> {
  const url = `${GRAPH}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as SendResponse;
  if (!res.ok || data.error) {
    logger.warn({ status: res.status, data }, 'whatsapp.send failed');
    throw new Error(data.error?.message ?? `WhatsApp API ${res.status}`);
  }
  return data;
}

export async function sendOtpTemplate(phone: string, code: string): Promise<{ messageId: string }> {
  const to = normalizePhone(phone).replace(/^\+/, ''); // Meta wants digits only
  const data = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: env.WA_OTP_TEMPLATE_NAME,
      language: { code: env.WA_OTP_TEMPLATE_LANG },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ],
    },
  });
  return { messageId: data.messages?.[0]?.id ?? '' };
}

// Vendor → past-customer review request. Uses approved Marketing template.
// Variables: {{1}} customer name, {{2}} business name, {{3}} short-link URL.
export async function sendReviewRequestTemplate(
  phone: string,
  customerName: string,
  businessName: string,
  shortLinkUrl: string,
): Promise<{ messageId: string }> {
  const to = normalizePhone(phone).replace(/^\+/, '');
  const data = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: env.WA_REVIEW_TEMPLATE_NAME,
      language: { code: env.WA_REVIEW_TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName.slice(0, 60) },
            { type: 'text', text: businessName.slice(0, 60) },
            { type: 'text', text: shortLinkUrl },
          ],
        },
      ],
    },
  });
  return { messageId: data.messages?.[0]?.id ?? '' };
}

// Plain text — works only with users who messaged us in the last 24h (the
// "service window"). Useful for transactional replies, NOT for OTP cold-sends.
export async function sendText(phone: string, body: string): Promise<{ messageId: string }> {
  const to = normalizePhone(phone).replace(/^\+/, '');
  const data = await postMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body, preview_url: false },
  });
  return { messageId: data.messages?.[0]?.id ?? '' };
}
