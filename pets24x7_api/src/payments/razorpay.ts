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
  return hasRazorpayKeys() || env.NODE_ENV === 'development';
}

/**
 * True only when real API credentials are present. isRazorpayConfigured() also
 * answers true on a development box with no keys (so createRazorpayOrder can
 * hand back a local test order); anything that must actually call Razorpay, or
 * read the key id, has to check this instead.
 */
export function hasRazorpayKeys(): boolean {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${env.RAZORPAY_KEY_ID || ''}:${env.RAZORPAY_KEY_SECRET || ''}`).toString('base64');
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
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    if (env.NODE_ENV === 'development') {
      return {
        id: 'order_' + opts.receipt.replace(/[^a-zA-Z0-9]/g, '').slice(-16),
        amount: opts.amountMinor,
        currency: opts.currency ?? 'INR',
        receipt: opts.receipt,
        status: 'created',
      };
    }
    throw new Error('Razorpay is not configured');
  }
  try {
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
      if (env.NODE_ENV === 'development') {
        logger.warn({ status: res.status, data }, 'razorpay.createOrder failed — using dev test order');
        return {
          id: 'order_' + opts.receipt.replace(/[^a-zA-Z0-9]/g, '').slice(-16),
          amount: opts.amountMinor,
          currency: opts.currency ?? 'INR',
          receipt: opts.receipt,
          status: 'created',
        };
      }
      throw new Error(data?.error?.description || `Razorpay createOrder ${res.status}`);
    }
    return data as RzpOrder;
  } catch (err) {
    if (env.NODE_ENV === 'development') {
      logger.warn({ err }, 'razorpay.createOrder network error — using dev test order');
      return {
        id: 'order_' + opts.receipt.replace(/[^a-zA-Z0-9]/g, '').slice(-16),
        amount: opts.amountMinor,
        currency: opts.currency ?? 'INR',
        receipt: opts.receipt,
        status: 'created',
      };
    }
    throw err;
  }
}

// Poll a payment's status (used as defence-in-depth when the client verify call
// is missed). Returns 'captured' | 'authorized' | 'failed' | ... or null.
export async function fetchPaymentStatus(
  paymentId: string,
): Promise<{ status: string; order_id?: string; amount?: number; currency?: string } | null> {
  if (!hasRazorpayKeys()) return null;
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: authHeader() },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) return null;
  return { status: data.status, order_id: data.order_id, amount: data.amount, currency: data.currency };
}

/**
 * One order as Razorpay holds it — amount, what has been paid against it, and
 * the notes we attached at creation. Used to recover a checkout's context when
 * our own in-process record of it is gone (a restart between pay and verify).
 */
export async function fetchRazorpayOrder(orderId: string): Promise<{
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
  receipt?: string;
  notes: Record<string, string>;
} | null> {
  if (!hasRazorpayKeys()) return null;
  const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: authHeader() },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    logger.warn({ status: res.status, orderId }, 'razorpay.fetchOrder failed');
    return null;
  }
  // Razorpay returns an empty array rather than an object when no notes exist.
  const notes = data.notes && !Array.isArray(data.notes) && typeof data.notes === 'object' ? data.notes : {};
  return {
    id: data.id,
    amount: Number(data.amount) || 0,
    amount_paid: Number(data.amount_paid) || 0,
    currency: String(data.currency || ''),
    status: String(data.status || ''),
    receipt: data.receipt,
    notes,
  };
}

/**
 * Every payment attempt made against an order. Needed to reconcile a checkout
 * the payer abandoned mid-flight: we hold the order id, but never saw the
 * payment id the client-side verify call would have handed us.
 */
export async function fetchOrderPayments(
  orderId: string,
): Promise<Array<{ id: string; status: string; amount: number }>> {
  if (!hasRazorpayKeys()) return [];
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
  // Development with no key secret has nothing to check against: the checkout
  // there is the local bypass, which never produces a real signature. Any other
  // case — including development with real keys — is verified for real, so a
  // forged signature cannot walk through the door marked "dev".
  if (!env.RAZORPAY_KEY_SECRET) return env.NODE_ENV === 'development';
  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

// webhook signature: HMAC_SHA256(rawBody, webhook_secret)
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
  speed_processed?: string;
}

/**
 * Send the money back. Amount is optional — omitting it refunds the payment in
 * full. `speed: 'normal'` settles in 5-7 working days at no extra fee.
 *
 * Razorpay rejects a second refund beyond the captured amount, so a duplicate
 * admin click surfaces as an error rather than paying twice.
 */
export async function createRefund(opts: {
  paymentId: string;
  amountMinor?: number;
  notes?: Record<string, string>;
  /** Our own key, so a retried request cannot refund twice. */
  idempotencyKey?: string;
}): Promise<RzpRefund> {
  // Without keys the call below would go out with empty credentials and fail
  // with an opaque 401 — say what is actually wrong.
  if (!hasRazorpayKeys()) throw new Error('Razorpay is not configured');
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(opts.paymentId)}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
      ...(opts.idempotencyKey ? { 'X-Razorpay-Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      ...(opts.amountMinor ? { amount: opts.amountMinor } : {}),
      speed: 'normal',
      notes: opts.notes ?? {},
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    logger.warn({ status: res.status, paymentId: opts.paymentId, data }, 'razorpay.createRefund failed');
    throw new Error(data?.error?.description || `Razorpay refund ${res.status}`);
  }
  return data as RzpRefund;
}
