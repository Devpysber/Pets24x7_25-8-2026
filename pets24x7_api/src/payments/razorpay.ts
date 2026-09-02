// Razorpay — Orders API + signature verification. No SDK; plain REST + HMAC.
// Docs: https://razorpay.com/docs/api/orders/  /  https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
//
// Flow:
//   1. createOrder(amountMinor, receipt)  → POST /v1/orders  → { id: 'order_xxx' }
//   2. Frontend opens Razorpay Checkout with { key, order_id }. On success the
//      handler gets { razorpay_order_id, razorpay_payment_id, razorpay_signature }.
//   3. POST that to /api/payments/razorpay/verify — we check
//      HMAC_SHA256(order_id + "|" + payment_id, key_secret) === signature.
//   4. Webhook (optional) at /api/payments/razorpay/webhook validates
//      HMAC_SHA256(rawBody, webhook_secret) === X-Razorpay-Signature.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';

export function isRazorpayConfigured(): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
}

export interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

export async function createRazorpayOrder(opts: {
  amountMinor: number;
  currency?: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RzpOrder> {
  if (!isRazorpayConfigured()) throw new Error('Razorpay is not configured');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: JSON.stringify({
      amount: opts.amountMinor,
      currency: opts.currency ?? 'INR',
      receipt: opts.receipt.slice(0, 40),
      payment_capture: 1,
      notes: opts.notes ?? {},
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    logger.warn({ status: res.status, data }, 'razorpay.createOrder failed');
    throw new Error(data?.error?.description || `Razorpay createOrder ${res.status}`);
  }
  return data as RzpOrder;
}

// Poll a payment's status (used as defence-in-depth when the client verify call
// is missed). Returns 'captured' | 'authorized' | 'failed' | ... or null.
export async function fetchPaymentStatus(paymentId: string): Promise<{ status: string; order_id?: string } | null> {
  if (!isRazorpayConfigured()) return null;
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader() },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) return null;
  return { status: data.status, order_id: data.order_id };
}

/**
 * Every payment attempt made against an order. Needed to reconcile a checkout
 * the payer abandoned mid-flight: we hold the order id, but never saw the
 * payment id the client-side verify call would have handed us.
 */
export async function fetchOrderPayments(
  orderId: string,
): Promise<Array<{ id: string; status: string; amount: number }>> {
  if (!isRazorpayConfigured()) return [];
  const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
    headers: { Authorization: authHeader() },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.items)) {
    logger.warn({ status: res.status, orderId }, 'razorpay.fetchOrderPayments failed');
    return [];
  }
  return data.items as Array<{ id: string; status: string; amount: number }>;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// webhook signature: HMAC_SHA256(rawBody, webhook_secret)
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}
