// PhonePe Payment Gateway (Standard Checkout) — thin REST client.
// Docs: https://developer.phonepe.com/v1/reference/pay-api
//
// Flow:
//   1. createOrder(merchantTxnId, amount, parentId)  → POST /pg/v1/pay
//        returns { redirectUrl } — frontend navigates user there
//   2. PhonePe processes payment, redirects user back to PHONEPE_REDIRECT_URL
//        AND fires server-to-server POST to PHONEPE_CALLBACK_URL
//   3. checkStatus(merchantTxnId)  → GET /pg/v1/status/{mid}/{txn}
//        used by the return page AND as defence-in-depth when callback fires
//
// Signing: X-VERIFY = SHA256(base64Payload + endpoint + saltKey) + "###" + saltIndex
// (for status: X-VERIFY = SHA256(endpoint + saltKey) + "###" + saltIndex)

import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';

const HOST = {
  sandbox: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  production: 'https://api.phonepe.com/apis/hermes',
};

const PAY_ENDPOINT = '/pg/v1/pay';
const STATUS_ENDPOINT = (mid: string, txn: string) => `/pg/v1/status/${mid}/${txn}`;

interface PayPayload {
  merchantId: string;
  merchantTransactionId: string;
  merchantUserId: string;
  amount: number;             // paise
  redirectUrl: string;
  redirectMode: 'REDIRECT' | 'POST';
  callbackUrl: string;
  mobileNumber?: string;
  paymentInstrument: { type: 'PAY_PAGE' };
}

interface PayResponse {
  success: boolean;
  code: string;
  message: string;
  data?: {
    merchantId: string;
    merchantTransactionId: string;
    instrumentResponse?: {
      type: string;
      redirectInfo?: { url: string; method: string };
    };
  };
}

interface StatusResponse {
  success: boolean;
  code: string;
  message: string;
  data?: {
    merchantId: string;
    merchantTransactionId: string;
    transactionId?: string;       // PhonePe-side id
    amount: number;
    state: 'COMPLETED' | 'FAILED' | 'PENDING';
    responseCode?: string;
    paymentInstrument?: unknown;
  };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function host(): string {
  return HOST[env.PHONEPE_MODE];
}

function xVerify(payloadOrEmpty: string, endpoint: string): string {
  const sig = sha256Hex(payloadOrEmpty + endpoint + env.PHONEPE_SALT_KEY);
  return `${sig}###${env.PHONEPE_SALT_INDEX}`;
}

export async function createOrder(opts: {
  merchantTxnId: string;
  amountMinor: number;
  parentId: string;
  mobileNumber?: string;
}): Promise<{ redirectUrl: string; raw: PayResponse }> {
  const payload: PayPayload = {
    merchantId: env.PHONEPE_MERCHANT_ID,
    merchantTransactionId: opts.merchantTxnId,
    merchantUserId: opts.parentId,
    amount: opts.amountMinor,
    redirectUrl: env.PHONEPE_REDIRECT_URL + (env.PHONEPE_REDIRECT_URL.includes('?') ? '&' : '?') + 'txn=' + encodeURIComponent(opts.merchantTxnId),
    redirectMode: 'REDIRECT',
    callbackUrl: env.PHONEPE_CALLBACK_URL,
    mobileNumber: opts.mobileNumber,
    paymentInstrument: { type: 'PAY_PAGE' },
  };

  const base64Payload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const verify = xVerify(base64Payload, PAY_ENDPOINT);

  const res = await fetch(host() + PAY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-VERIFY': verify,
    },
    body: JSON.stringify({ request: base64Payload }),
  });
  const data = (await res.json().catch(() => ({}))) as PayResponse;
  if (!res.ok || !data.success || !data.data?.instrumentResponse?.redirectInfo?.url) {
    logger.warn({ status: res.status, data }, 'phonepe.createOrder failed');
    throw new Error(data.message || `PhonePe createOrder ${res.status}`);
  }
  return { redirectUrl: data.data.instrumentResponse.redirectInfo.url, raw: data };
}

export async function checkStatus(merchantTxnId: string): Promise<StatusResponse> {
  const endpoint = STATUS_ENDPOINT(env.PHONEPE_MERCHANT_ID, merchantTxnId);
  const verify = xVerify('', endpoint);

  const res = await fetch(host() + endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-VERIFY': verify,
      'X-MERCHANT-ID': env.PHONEPE_MERCHANT_ID,
    },
  });
  const data = (await res.json().catch(() => ({}))) as StatusResponse;
  if (!res.ok) {
    logger.warn({ status: res.status, data }, 'phonepe.checkStatus failed');
    throw new Error(data.message || `PhonePe status ${res.status}`);
  }
  return data;
}

// PhonePe sends the callback as POST with header X-VERIFY = sha256(base64Body + salt) + "###" + saltIndex
// and the body is { response: base64-encoded-json }.
export function verifyCallback(rawXVerify: string, rawBody: string): {
  ok: boolean;
  payload?: {
    merchantId: string;
    merchantTransactionId: string;
    transactionId?: string;
    amount: number;
    state: 'COMPLETED' | 'FAILED' | 'PENDING';
    responseCode?: string;
  };
} {
  try {
    const expected = sha256Hex(rawBody + env.PHONEPE_SALT_KEY) + '###' + env.PHONEPE_SALT_INDEX;
    if (expected !== rawXVerify) return { ok: false };

    const parsedOuter = JSON.parse(rawBody);
    const inner = JSON.parse(Buffer.from(parsedOuter.response, 'base64').toString('utf8'));
    return { ok: true, payload: inner.data ?? inner };
  } catch (err) {
    logger.warn({ err }, 'phonepe.verifyCallback parse error');
    return { ok: false };
  }
}

// Generate a merchant txn id (≤ 35 chars, alphanumeric + underscore allowed).
// Prefix "P24" + ms timestamp + 4 random chars.
export function newMerchantTxnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `P24_${ts}_${rand}`.toUpperCase().slice(0, 35);
}
