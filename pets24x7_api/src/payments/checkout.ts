// One entry point for starting a checkout. Razorpay is the only live gateway.
//
//   1. Dev bypass — NODE_ENV=development with no Razorpay keys: skip the real
//      gateway entirely and return a URL that marks the payment COMPLETED on
//      visit, so a local machine never creates a live order.
//   2. Razorpay — return an order for the JS checkout modal (no redirect).
//
// With neither available the checkout fails loudly: silently taking no money
// while activating nothing is worse than an error the payer can retry.

import { env } from './../env.js';
import { createRazorpayOrder, isRazorpayConfigured } from './razorpay.js';

export function isDevGatewayBypass(): boolean {
  return env.NODE_ENV === 'development' && !isRazorpayConfigured();
}

/**
 * Where the dev bypass should return the payer, per payment purpose. Each page
 * polls its own status endpoint, so sending a vendor to the membership return
 * page would report the wrong result.
 */
export function returnUrlFor(purpose?: string): string {
  const site = env.PUBLIC_SITE_URL.replace(/\/$/, '');
  if (purpose === 'CAMPAIGN') return `${site}/dashboard/vendor/?view=marketing`;
  if (purpose === 'FEATURED') return `${site}/dashboard/vendor/?view=marketing&featured=1`;
  return `${site}/membership/return/`;
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

  if (!isRazorpayConfigured()) {
    throw new Error('No payment gateway is configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  }

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

// Our own reference for a checkout, carried to the gateway as the order
// receipt: "P24_" + base36 ms timestamp + 4 random chars. Razorpay caps a
// receipt at 40 characters, so this stays well inside it.
export function newMerchantTxnId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `P24_${ts}_${rand}`.toUpperCase().slice(0, 35);
}
