// One entry point for starting a checkout. Picks a gateway in this order:
//   1. Dev bypass      — NODE_ENV=development + PhonePe is the dead sandbox:
//                        skip all real gateways (no live Razorpay orders in dev),
//                        return a URL that marks the payment COMPLETED on visit.
//   2. Razorpay        — if RAZORPAY_KEY_ID/SECRET are set: return an order for
//                        the JS checkout modal (no redirect).
//   3. PhonePe         — otherwise; return a redirect URL.

import { env } from './../env.js';
import { createOrder } from './phonepe.js';
import { createRazorpayOrder, isRazorpayConfigured } from './razorpay.js';

const DEAD_SANDBOX_MERCHANTS = new Set(['PGTESTPAYUAT', 'MERCHANTUAT', '']);

export function isDevGatewayBypass(): boolean {
  return env.NODE_ENV === 'development' && DEAD_SANDBOX_MERCHANTS.has(env.PHONEPE_MERCHANT_ID);
}

/**
 * Where a redirect gateway should return the payer, per payment purpose. Each
 * page polls its own status endpoint, so sending a vendor to the membership
 * return page would report the wrong result.
 */
export function returnUrlFor(purpose?: string): string {
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, '');
  if (purpose === 'CAMPAIGN') return `${site}/dashboard/vendor/?view=marketing`;
  if (purpose === 'FEATURED') return `${site}/dashboard/vendor/?view=marketing&featured=1`;
  return env.PHONEPE_REDIRECT_URL;
}

export type CheckoutResult =
  | { mode: 'razorpay'; keyId: string; orderId: string; amountMinor: number; currency: string; dev: false; redirectUrl?: undefined }
  | { mode: 'redirect'; redirectUrl: string; dev: boolean };

export async function startCheckout(opts: {
  merchantTxnId: string;
  amountMinor: number;
  userId: string;
  mobileNumber?: string;
  purpose?: string;
  currency?: string;
  /** Overrides the per-purpose default. */
  returnUrl?: string;
}): Promise<CheckoutResult> {
  if (isDevGatewayBypass()) {
    return {
      mode: 'redirect',
      redirectUrl: `${env.PUBLIC_API_URL}/api/dev/pay/${encodeURIComponent(opts.merchantTxnId)}/complete`,
      dev: true,
    };
  }

  if (isRazorpayConfigured()) {
    const order = await createRazorpayOrder({
      amountMinor: opts.amountMinor,
      currency: opts.currency ?? 'INR',
      receipt: opts.merchantTxnId,
      notes: { purpose: opts.purpose ?? 'PAYMENT', userId: opts.userId, merchantTxnId: opts.merchantTxnId },
    });
    return {
      mode: 'razorpay',
      keyId: env.RAZORPAY_KEY_ID!,
      orderId: order.id,
      amountMinor: order.amount,
      currency: order.currency,
      dev: false,
    };
  }

  const { redirectUrl } = await createOrder({
    merchantTxnId: opts.merchantTxnId,
    amountMinor: opts.amountMinor,
    parentId: opts.userId,
    mobileNumber: opts.mobileNumber,
    returnUrl: opts.returnUrl ?? returnUrlFor(opts.purpose),
  });
  return { mode: 'redirect', redirectUrl, dev: false };
}
