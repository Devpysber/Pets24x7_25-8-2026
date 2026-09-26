import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { loadPersistedPlanStores, memoryVendorSubPlans } from '../admin/admin.api.routes.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startCheckout } from '../payments/checkout.js';
import { newMerchantTxnId } from '../payments/checkout.js';
import { fetchPaymentStatus, fetchRazorpayOrder, verifyPaymentSignature } from '../payments/razorpay.js';
import { alertAdminsAboutPayment } from '../payments/membership.routes.js';
import { notifyIf } from '../mail/notify.js';
import { paymentReceiptEmail } from '../mail/lifecycle-templates.js';
import { isVendorApproved } from '../shared/vendor-status.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../shared/errors.js';

export const vendorSubscriptionsRouter = Router();

// Vendor subscriptions and their invoices. The Maps are a write-through cache;
// the durable copy is one settings row per vendor (`vendor_sub:<vendorId>`),
// read back on first use. Before, the Maps were the only copy and every restart
// or redeploy silently dropped each paying vendor back to the free tier and
// erased their billing history.
export const vendorSubscriptionStore = new Map<string, any>();
const vendorInvoicesStore = new Map<string, any[]>();
const SUB_KEY_PREFIX = 'vendor_sub:';
/** Oldest invoices beyond this are dropped from the stored history. */
const MAX_STORED_INVOICES = 200;

interface VendorSubPlan {
  id: string;
  sku?: string;
  tier: string;
  billingPeriod?: string;
  name: string;
  tagline?: string;
  perks?: string[];
  leadLimit: number;
  badge?: string;
  priceRupees: number;
  durationDays: number;
  recommended?: boolean;
  active?: boolean;
}

const DEFAULT_PLANS: VendorSubPlan[] = [
  {
    id: 'v_plan_free',
    sku: 'vendor_basic_free',
    tier: 'BASIC',
    billingPeriod: 'MONTHLY',
    name: 'Basic Free',
    tagline: 'Essential presence for new pet businesses',
    perks: ['Verified Business Listing', '∞ Unlimited Customer Leads', 'Basic Analytics', 'Standard Support'],
    leadLimit: 9999,
    badge: 'VERIFIED',
    priceRupees: 0,
    durationDays: 30,
    recommended: false,
    active: true,
  },
  {
    id: 'v_plan_silver',
    sku: 'vendor_silver_pro',
    tier: 'SILVER',
    billingPeriod: 'MONTHLY',
    name: 'Silver Pro',
    tagline: 'Ideal for growing clinics, groomers & boarding',
    perks: ['Verified Pro Badge', '∞ Unlimited Customer Leads', 'WhatsApp Direct Enquiries', 'Priority Search Ranking', 'Email Support'],
    leadLimit: 9999,
    badge: 'VERIFIED_PRO',
    priceRupees: 1499,
    durationDays: 30,
    recommended: false,
    active: true,
  },
  {
    id: 'v_plan_gold',
    sku: 'vendor_gold_platinum',
    tier: 'GOLD',
    billingPeriod: 'MONTHLY',
    name: 'Gold Platinum',
    tagline: 'Maximum visibility & unlimited lead generation',
    perks: ['⭐ Gold Verified Badge', '∞ Unlimited Customer Leads', 'Top #1 City & Category Ranking', 'Direct WhatsApp & Phone Leads', 'Dedicated Account Manager'],
    leadLimit: 9999,
    badge: 'GOLD_PLATINUM',
    priceRupees: 2999,
    durationDays: 30,
    recommended: true,
    active: true,
  },
  {
    id: 'v_plan_diamond',
    sku: 'vendor_diamond_enterprise',
    tier: 'DIAMOND',
    billingPeriod: 'ANNUAL',
    name: 'Diamond Enterprise',
    tagline: 'For multi-location chains & premium pet centers',
    perks: ['💎 Diamond Badge', '∞ Unlimited Customer Leads', 'Top Ranking Across All Cities', 'Includes 30 Days Free Featured Spot', 'VIP 24/7 Priority Support'],
    leadLimit: 9999,
    badge: 'DIAMOND_VIP',
    priceRupees: 24999,
    durationDays: 365,
    recommended: false,
    active: true,
  },
];

function basicSubscription(vendorId: string) {
  return {
    id: `v_sub_${vendorId}`,
    vendorId: vendorId,
    tier: 'BASIC',
    tierName: 'Basic Free Plan',
    pricePaidRupees: 0,
    leadLimit: 9999,
    leadsUsed: 0,
    badge: 'STANDARD',
    status: 'ACTIVE',
    startsAt: new Date(),
    // The free tier never lapses. A made-up date a year out showed every new
    // vendor "Valid until …" on a plan that has no term.
    endsAt: null as Date | null,
    autoRenew: false,
  };
}

/**
 * The vendor's current subscription, with an ended paid term folded back to
 * the free tier. Nothing else expires these rows (there is no sweep for the
 * in-memory store), so a lapsed Gold plan used to stay "ACTIVE" for ever.
 */
export function currentVendorSubscription(vendorId: string) {
  const sub = vendorSubscriptionStore.get(vendorId);
  if (!sub) {
    const fresh = basicSubscription(vendorId);
    vendorSubscriptionStore.set(vendorId, fresh);
    return fresh;
  }
  if (sub.tier !== 'BASIC' && sub.endsAt && new Date(sub.endsAt).getTime() < Date.now()) {
    const lapsed = { ...basicSubscription(vendorId), previousTier: sub.tier, previousEndsAt: sub.endsAt };
    vendorSubscriptionStore.set(vendorId, lapsed);
    saveInBackground(vendorId);
    return lapsed;
  }
  return sub;
}

let subsLoad: Promise<void> | null = null;
let subsFailedAt = 0;

/**
 * Reads every saved vendor subscription into the cache. Safe to call on every
 * request: it queries once, and after a failure retries at most every 30s.
 * A row already in the cache is never overwritten — it was written after boot
 * and is newer than what the database holds.
 */
export function loadVendorSubscriptions(): Promise<void> {
  if (!subsLoad && Date.now() - subsFailedAt > 30_000) {
    subsLoad = (async () => {
      const rows = await prisma.setting.findMany({ where: { key: { startsWith: SUB_KEY_PREFIX } } });
      for (const r of rows) {
        const vendorId = r.key.slice(SUB_KEY_PREFIX.length);
        const v = (r.value ?? {}) as { subscription?: any; invoices?: any[] };
        if (!vendorId) continue;
        if (v.subscription && !vendorSubscriptionStore.has(vendorId)) vendorSubscriptionStore.set(vendorId, v.subscription);
        if (Array.isArray(v.invoices) && !vendorInvoicesStore.has(vendorId)) {
          vendorInvoicesStore.set(vendorId, v.invoices);
          // A payment already turned into an invoice must never be applied
          // again, even by a verify call replayed after a restart.
          for (const inv of v.invoices) {
            if (inv?.gatewayTxnId && !appliedPayments.has(inv.gatewayTxnId)) {
              appliedPayments.set(inv.gatewayTxnId, { vendorId, subscription: null, invoice: inv });
            }
          }
        }
      }
    })().catch((err) => {
      logger.warn({ err }, 'vendor subscriptions: could not load saved subscriptions; retrying later');
      subsLoad = null;
      subsFailedAt = Date.now();
    });
  }
  return subsLoad ?? Promise.resolve();
}

/**
 * Writes a vendor's cached subscription and invoices to the database. Exported
 * so the admin status endpoint can persist the changes it makes to the cache.
 */
export async function saveVendorSubscription(vendorId: string, actorId: string = vendorId): Promise<void> {
  const subscription = vendorSubscriptionStore.get(vendorId) ?? null;
  const invoices = (vendorInvoicesStore.get(vendorId) ?? []).slice(0, MAX_STORED_INVOICES);
  const value = JSON.parse(JSON.stringify({ subscription, invoices }));
  await prisma.setting.upsert({
    where: { key: SUB_KEY_PREFIX + vendorId },
    update: { value, updatedBy: actorId },
    create: { key: SUB_KEY_PREFIX + vendorId, value, updatedBy: actorId },
  });
}

/**
 * Replaces one vendor's cached subscription and invoices with the saved row.
 * With several API instances another one may have written it since this
 * process loaded it; a payment is applied on top of the saved copy, so it
 * cannot overwrite an invoice or a plan that instance recorded.
 */
async function reloadVendorSubscription(vendorId: string): Promise<void> {
  const row = await prisma.setting.findUnique({ where: { key: SUB_KEY_PREFIX + vendorId } });
  if (!row) return;
  const v = (row.value ?? {}) as { subscription?: any; invoices?: any[] };
  if (v.subscription) vendorSubscriptionStore.set(vendorId, v.subscription);
  if (Array.isArray(v.invoices)) vendorInvoicesStore.set(vendorId, v.invoices);
}

// With several API instances, a plan bought or changed through one of them is
// only in that instance's cache. Reads re-check the saved row at most this
// often per vendor, so every instance shows the current plan within seconds.
const SUB_RECHECK_MS = 15_000;
const subCheckedAt = new Map<string, number>();

async function refreshVendorSubscription(vendorId: string): Promise<void> {
  const last = subCheckedAt.get(vendorId) ?? 0;
  if (Date.now() - last < SUB_RECHECK_MS) return;
  subCheckedAt.set(vendorId, Date.now());
  if (subCheckedAt.size > 50_000) subCheckedAt.clear();
  await reloadVendorSubscription(vendorId).catch((err) =>
    logger.warn({ err, vendorId }, 'vendor subscriptions: re-check failed; serving cached plan'),
  );
}

function saveInBackground(vendorId: string): void {
  saveVendorSubscription(vendorId).catch((err) =>
    logger.error({ err, vendorId }, 'vendor subscriptions: could not save subscription'),
  );
}

function getVendorInvoices(vendorId: string) {
  // Billing history is what the vendor actually paid for. This used to seed a
  // fake "TXN_INIT_…" PAID receipt for every account, so the empty state never
  // showed and a receipt existed for a payment that never happened.
  if (!vendorInvoicesStore.has(vendorId)) vendorInvoicesStore.set(vendorId, []);
  return vendorInvoicesStore.get(vendorId) || [];
}

function allPlans(): VendorSubPlan[] {
  return memoryVendorSubPlans && memoryVendorSubPlans.length > 0
    ? (memoryVendorSubPlans as VendorSubPlan[])
    : DEFAULT_PLANS;
}

/** Plans a vendor may buy right now — an admin can switch one off. */
function purchasablePlans(): VendorSubPlan[] {
  return allPlans().filter((p) => p.active !== false);
}

function findPlan(planId: string | undefined, plans: VendorSubPlan[] = allPlans()): VendorSubPlan | undefined {
  if (!planId) return undefined;
  return plans.find((p) => p.id === planId || (p.sku && p.sku === planId));
}

/**
 * What a plan costs for the chosen billing period, and for how long. Annual
 * billing is ten months' price for a year — but only for a plan priced per
 * month. A plan that is already annual (Diamond: ₹24,999 / 365 days) was being
 * multiplied by ten again.
 */
function priceFor(plan: VendorSubPlan, billingPeriod: 'MONTHLY' | 'ANNUAL') {
  const baseDays = plan.durationDays || 30;
  const alreadyAnnual = plan.billingPeriod === 'ANNUAL' || baseDays >= 365;
  const priceRupees = Number(plan.priceRupees) || 0;
  if (billingPeriod === 'ANNUAL' && priceRupees > 0 && !alreadyAnnual) {
    return { priceRupees: Math.round(priceRupees * 10), durationDays: 365 };
  }
  return { priceRupees, durationDays: baseDays };
}

// A paid checkout in flight, keyed by Razorpay order id. Verify reads the plan,
// billing period and amount from here — never from the request — so a vendor
// cannot pay for Silver and claim Diamond, or reuse a campaign's payment.
interface PendingVendorCheckout {
  vendorId: string;
  planId: string;
  billingPeriod: 'MONTHLY' | 'ANNUAL';
  amountMinor: number;
  merchantTxnId: string;
  createdAt: number;
}
const pendingCheckouts = new Map<string, PendingVendorCheckout>();
// Razorpay payment id → what it bought. Makes verify idempotent (a double
// click or a retried request returns the same result) and stops one payment
// being applied twice.
const appliedPayments = new Map<string, { vendorId: string; subscription: any; invoice: any }>();
// The Map only covers this process. The cluster-wide claim is a settings row
// per payment id (`vendor_pay:<razorpay payment id>`): the primary key lets
// exactly one instance create it, so a verify on one server and the webhook on
// another cannot both apply the same payment. The prefix is reserved in the
// admin settings editor (RESERVED_SETTING_PREFIXES).
const PAYMENT_CLAIM_PREFIX = 'vendor_pay:';

// A claim row starts 'pending' and turns 'applied' once the plan and invoice
// are saved. A process killed in between (a deploy) would otherwise leave a
// permanent claim for a payment that was never applied, and every retry would
// answer "already applied". A pending claim older than this, whose payment is
// not among the vendor's saved invoices, is taken over by the next retry.
const PAYMENT_CLAIM_STALE_MS = 5 * 60_000;

type PaymentClaimValue = { vendorId?: string; state?: 'pending' | 'applied'; claimedAt?: string };

function paymentClaimKey(paymentId: string): string {
  return (PAYMENT_CLAIM_PREFIX + paymentId).slice(0, 191);
}

/**
 * Claims a payment id in MySQL. 'claimed' when this call created the row (or
 * took over an abandoned one), 'taken' when another call holds or applied it,
 * 'unavailable' when the database could not be asked — then the in-process
 * claim is all there is, exactly as on a single server before this existed.
 */
async function claimPaymentInDb(
  paymentId: string,
  vendorId: string,
): Promise<'claimed' | 'taken' | 'unavailable'> {
  const key = paymentClaimKey(paymentId);
  const value = (): PaymentClaimValue => ({ vendorId, state: 'pending', claimedAt: new Date().toISOString() });
  try {
    await prisma.setting.create({ data: { key, value: value(), updatedBy: vendorId } });
    return 'claimed';
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2002') {
      logger.warn({ err, paymentId }, 'vendor subscriptions: payment claim row not written; relying on this process only');
      return 'unavailable';
    }
  }
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row) return 'taken'; // released a moment ago by a failed attempt; its caller reports the error
    const v = (row.value ?? {}) as PaymentClaimValue;
    // Rows written before the state field existed count as pending: the
    // invoice check below is what decides whether the payment was applied.
    if (v.state === 'applied') return 'taken';
    if (Date.now() - row.updatedAt.getTime() < PAYMENT_CLAIM_STALE_MS) return 'taken';
    await reloadVendorSubscription(v.vendorId || vendorId);
    const saved = vendorInvoicesStore.get(v.vendorId || vendorId) ?? [];
    if (saved.some((inv: any) => inv?.gatewayTxnId === paymentId)) {
      await markPaymentClaimApplied(paymentId);
      return 'taken';
    }
    // Conditional on the row being unchanged, so of two retries racing for an
    // abandoned claim exactly one wins.
    const won = await prisma.setting.updateMany({
      where: { key, updatedAt: row.updatedAt },
      data: { value: value(), updatedBy: vendorId },
    });
    if (won.count !== 1) return 'taken';
    logger.warn({ paymentId, vendorId, abandonedAt: v.claimedAt }, 'vendor subscriptions: took over an abandoned payment claim');
    return 'claimed';
  } catch (err) {
    logger.warn({ err, paymentId }, 'vendor subscriptions: could not check an existing payment claim; treating it as taken');
    return 'taken';
  }
}

/** Marks a claim done, so it is never taken over. The saved invoice already guards it if this fails. */
async function markPaymentClaimApplied(paymentId: string): Promise<void> {
  const key = paymentClaimKey(paymentId);
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const v = (row?.value ?? {}) as PaymentClaimValue;
  await prisma.setting
    .update({ where: { key }, data: { value: { ...v, state: 'applied' } } })
    .catch((err) => logger.warn({ err, paymentId }, 'vendor subscriptions: could not mark payment claim applied'));
}

async function releasePaymentClaim(paymentId: string): Promise<void> {
  await prisma.setting
    .delete({ where: { key: paymentClaimKey(paymentId) } })
    .catch((err) => logger.error({ err, paymentId }, 'vendor subscriptions: could not release payment claim'));
}
const PENDING_TTL_MS = 24 * 3600 * 1000;
const PURPOSE = 'VENDOR_SUBSCRIPTION';

function prunePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [orderId, p] of pendingCheckouts) if (p.createdAt < cutoff) pendingCheckouts.delete(orderId);
}

/**
 * Rebuild a checkout from the Razorpay order's notes when the in-process record
 * is gone (the API restarted between checkout and verify). Without this a
 * vendor who had paid could never get the plan.
 */
async function checkoutFromOrder(orderId: string): Promise<PendingVendorCheckout | null> {
  const order = await fetchRazorpayOrder(orderId).catch(() => null);
  if (!order || order.notes.purpose !== PURPOSE || !order.notes.userId || !order.notes.planId) return null;
  return {
    vendorId: order.notes.userId,
    planId: order.notes.planId,
    billingPeriod: order.notes.billingPeriod === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY',
    amountMinor: order.amount,
    merchantTxnId: order.notes.merchantTxnId || order.receipt || orderId,
    createdAt: Date.now(),
  };
}

/** Put a paid plan live, record the invoice and send the receipt. */
async function activatePaidPlan(opts: {
  vendorId: string;
  plan: VendorSubPlan;
  billingPeriod: 'MONTHLY' | 'ANNUAL';
  amountMinor: number;
  merchantTxnId: string;
  gatewayTxnId: string;
  paymentMethod: string;
}) {
  const { vendorId, plan } = opts;
  const { durationDays } = priceFor(plan, opts.billingPeriod);
  await reloadVendorSubscription(vendorId).catch((err) =>
    logger.warn({ err, vendorId }, 'vendor subscriptions: could not re-read the saved subscription; using the cached copy'),
  );
  const now = new Date();
  const current = currentVendorSubscription(vendorId);
  // Renewing the plan you are already on adds the new term to the end of the
  // current one rather than throwing the unused days away.
  const currentEnds = current.endsAt ? new Date(current.endsAt) : null;
  const base = current.tier === plan.tier && currentEnds && currentEnds > now ? currentEnds : now;

  const updatedSub = {
    id: `v_sub_${vendorId}`,
    vendorId,
    tier: plan.tier || 'GOLD',
    tierName: plan.name || 'Vendor Subscription Plan',
    // What was actually charged, not the request and not the monthly list
    // price (an annual purchase was recorded at one month's price).
    pricePaidRupees: Math.round(opts.amountMinor) / 100,
    leadLimit: plan.leadLimit || 9999,
    leadsUsed: 0,
    badge: plan.badge || 'GOLD_PLATINUM',
    status: 'ACTIVE',
    billingPeriod: opts.billingPeriod,
    startsAt: now,
    endsAt: new Date(base.getTime() + durationDays * 86400 * 1000),
    // Nothing charges a vendor automatically — there is no stored mandate —
    // so claiming auto-renew would promise a renewal that never happens.
    autoRenew: false,
  };
  vendorSubscriptionStore.set(vendorId, updatedSub);

  const invoice = {
    id: `inv_${Date.now()}`,
    merchantTxnId: opts.merchantTxnId,
    gatewayTxnId: opts.gatewayTxnId,
    planName: `${updatedSub.tierName} (${opts.billingPeriod === 'ANNUAL' ? 'Annual' : 'Monthly'})`,
    tier: updatedSub.tier,
    amountRupees: updatedSub.pricePaidRupees,
    status: 'PAID',
    paymentMethod: opts.paymentMethod,
    createdAt: now,
  };
  getVendorInvoices(vendorId).unshift(invoice);

  // The money has already been taken, so a database error must not fail the
  // request — but it must be loud, because the plan would not survive a restart.
  let saved = true;
  await saveVendorSubscription(vendorId).catch((err) => {
    saved = false;
    logger.error({ err, vendorId, merchantTxnId: opts.merchantTxnId }, 'vendor subscriptions: paid plan not saved');
    alertAdminsAboutPayment({
      merchantTxnId: opts.merchantTxnId,
      amountMinor: opts.amountMinor,
      currency: 'INR',
      reason: `Vendor ${vendorId} paid for ${plan.name}, but the subscription could not be saved - check it after the next restart`,
      who: vendorId,
    });
  });

  const vendor = await prisma.vendor
    .findUnique({ where: { id: vendorId }, select: { email: true, businessName: true } })
    .catch(() => null);
  notifyIf(vendor?.email, (to) =>
    paymentReceiptEmail(
      to,
      vendor?.businessName ?? 'there',
      `your ${invoice.planName} subscription`,
      opts.amountMinor,
      'INR',
      opts.merchantTxnId,
      now,
    ),
  );

  return { subscription: updatedSub, invoice, saved };
}

/**
 * Apply a verified payment for a checkout record: at most once per Razorpay
 * payment id. Shared by the client verify call and the webhook (the backstop
 * for a vendor who closed the tab after paying).
 */
async function settleVendorPayment(
  ctx: PendingVendorCheckout,
  razorpayPaymentId: string,
  paymentMethod: string,
): Promise<{ alreadyApplied: true } | { alreadyApplied: false; subscription: any; invoice: any }> {
  // Look the plan up among ALL plans: one switched off after the vendor paid
  // still has to be honoured.
  const plan = findPlan(ctx.planId);
  if (!plan) {
    if (!appliedPayments.has(razorpayPaymentId)) {
      alertAdminsAboutPayment({
        merchantTxnId: ctx.merchantTxnId,
        amountMinor: ctx.amountMinor,
        currency: 'INR',
        reason: `Vendor paid for subscription plan "${ctx.planId}", which no longer exists - activate or refund by hand`,
        who: ctx.vendorId,
      });
    }
    throw new BadRequestError(`Payment received, but the plan could not be found. Our team has been alerted — reference ${ctx.merchantTxnId}.`);
  }

  // Claim synchronously (no await between this check and the set), so two
  // concurrent calls for one payment cannot both activate it.
  if (appliedPayments.has(razorpayPaymentId)) return { alreadyApplied: true };
  appliedPayments.set(razorpayPaymentId, { vendorId: ctx.vendorId, subscription: null, invoice: null });
  // Then across instances. Keeping the local entry on 'taken' makes a repeat
  // call here answer from memory.
  const claim = await claimPaymentInDb(razorpayPaymentId, ctx.vendorId);
  if (claim === 'taken') {
    await reloadVendorSubscription(ctx.vendorId).catch(() => {});
    // Remember it here only once it is on the saved invoices. A claim still
    // in flight elsewhere may yet be abandoned, and a later retry reaching
    // this process has to be able to take it over.
    const onInvoice = getVendorInvoices(ctx.vendorId).some((inv: any) => inv?.gatewayTxnId === razorpayPaymentId);
    if (!onInvoice) appliedPayments.delete(razorpayPaymentId);
    return { alreadyApplied: true };
  }

  let applied: Awaited<ReturnType<typeof activatePaidPlan>>;
  try {
    applied = await activatePaidPlan({
      vendorId: ctx.vendorId,
      plan,
      billingPeriod: ctx.billingPeriod,
      amountMinor: ctx.amountMinor,
      merchantTxnId: ctx.merchantTxnId,
      gatewayTxnId: razorpayPaymentId,
      paymentMethod,
    });
  } catch (err) {
    // Release the claim so a retry (or the webhook) can still apply it.
    appliedPayments.delete(razorpayPaymentId);
    if (claim === 'claimed') await releasePaymentClaim(razorpayPaymentId);
    throw err;
  }
  const { saved, ...result } = applied;
  // Left pending when the save failed (the admins were alerted): the plan is
  // not in the database, so a retry after the stale window may apply it.
  if (claim === 'claimed' && saved) await markPaymentClaimApplied(razorpayPaymentId);
  appliedPayments.set(razorpayPaymentId, { vendorId: ctx.vendorId, ...result });
  return { alreadyApplied: false, ...result };
}

/**
 * Webhook entry point (payment.captured / order.paid). Vendor subscription
 * orders have no Payment row, so the Razorpay webhook cannot settle them the
 * way it settles memberships; without this a vendor who paid and closed the
 * tab before the verify call never got the plan.
 *
 * Returns false when the order is not a vendor subscription checkout.
 */
export async function settleVendorSubscriptionOrder(
  orderId: string,
  razorpayPaymentId: string,
  paidAmountMinor: number | undefined,
  paidCurrency: string | undefined,
): Promise<boolean> {
  await Promise.all([loadPersistedPlanStores(), loadVendorSubscriptions()]);
  if (appliedPayments.has(razorpayPaymentId)) return true;
  const ctx = pendingCheckouts.get(orderId) ?? (await checkoutFromOrder(orderId));
  if (!ctx) return false;
  const shortPaid = typeof paidAmountMinor === 'number' && paidAmountMinor < ctx.amountMinor;
  const wrongCurrency = !!paidCurrency && paidCurrency !== 'INR';
  if (shortPaid || wrongCurrency) {
    alertAdminsAboutPayment({
      merchantTxnId: ctx.merchantTxnId,
      amountMinor: ctx.amountMinor,
      currency: 'INR',
      reason: `Vendor subscription payment ${razorpayPaymentId} captured ${paidAmountMinor ?? '?'} ${paidCurrency ?? ''} against an order for ${ctx.amountMinor} - not credited`,
      who: ctx.vendorId,
    });
    return true;
  }
  try {
    await settleVendorPayment(ctx, razorpayPaymentId, 'Razorpay');
  } catch (err) {
    // settleVendorPayment has already alerted the admins about a missing plan.
    logger.warn({ err, orderId, vendorId: ctx.vendorId }, 'vendor subscription webhook: not applied');
  }
  pendingCheckouts.delete(orderId);
  return true;
}

// GET /api/vendor/subscriptions/plans
vendorSubscriptionsRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    // Admin edits to the catalogue live in the database; answer from them, not
    // from the defaults a freshly booted process starts with.
    await loadPersistedPlanStores();
    // Switched-off plans are hidden: listing one only to have checkout refuse
    // it (or, before, silently sell a different plan) helps nobody.
    res.json({ ok: true, plans: purchasablePlans() });
  }),
);

// GET /api/vendor/subscriptions/me
vendorSubscriptionsRouter.get(
  '/me',
  requireAuth('vendor'),
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    await loadVendorSubscriptions();
    await refreshVendorSubscription(vendorId);
    const activeSub = currentVendorSubscription(vendorId);
    const invoices = getVendorInvoices(vendorId);

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, businessName: true, phone: true, email: true, category: true, city: true }
    }).catch(() => null);

    res.json({
      ok: true,
      subscription: activeSub,
      invoices: invoices,
      vendor: vendor || { id: vendorId, businessName: 'Vendor Account' }
    });
  }),
);

// POST /api/vendor/subscriptions/checkout
const CheckoutBody = z.object({
  planId: z.string().min(1),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional().default('MONTHLY'),
  paymentGateway: z.enum(['RAZORPAY', 'SIMULATED']).optional().default('RAZORPAY'),
});

vendorSubscriptionsRouter.post(
  '/checkout',
  requireAuth('vendor'),
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    const { planId, billingPeriod } = CheckoutBody.parse(req.body);
    await Promise.all([loadPersistedPlanStores(), loadVendorSubscriptions()]);

    // An unknown or switched-off plan is an error. Falling back to the first
    // plan in the list sold the vendor something they never picked.
    const plan = findPlan(planId, purchasablePlans());
    if (!plan) throw new NotFoundError('That plan is no longer available');

    const { priceRupees: finalPrice } = priceFor(plan, billingPeriod);
    const merchantTxnId = newMerchantTxnId();
    const amountMinor = Math.round(finalPrice * 100);
    const current = currentVendorSubscription(vendorId);

    if (finalPrice === 0) {
      // Switching to the free tier would silently throw away paid days.
      if (current.tier !== 'BASIC' && (current.pricePaidRupees || 0) > 0 && current.endsAt && new Date(current.endsAt) > new Date()) {
        throw new ConflictError(
          `Your ${current.tierName} plan is paid up until ${new Date(current.endsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}. You move to the free plan automatically after that.`,
        );
      }
      const updatedSub = {
        ...basicSubscription(vendorId),
        tier: plan.tier || 'BASIC',
        tierName: plan.name,
        leadLimit: plan.leadLimit || 9999,
        badge: plan.badge || 'VERIFIED',
      };
      vendorSubscriptionStore.set(vendorId, updatedSub);
      await saveVendorSubscription(vendorId).catch((err) =>
        logger.error({ err, vendorId }, 'vendor subscriptions: free plan switch not saved'),
      );

      return res.json({
        ok: true,
        isFree: true,
        subscription: updatedSub,
        message: 'Plan activated successfully!',
      });
    }

    // Same bar as buying a campaign or a featured slot: a claim still under
    // review (or rejected) cannot pay for a plan it may never get to use.
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
    if (!vendor) throw new ForbiddenError();
    if (!isVendorApproved(vendor.status)) {
      throw new ForbiddenError('Your vendor account must be approved before buying a subscription');
    }

    let checkout: Awaited<ReturnType<typeof startCheckout>>;
    try {
      checkout = await startCheckout({
        merchantTxnId,
        amountMinor,
        userId: vendorId,
        purpose: PURPOSE,
        currency: 'INR',
        notes: { planId: plan.id, billingPeriod },
      });
    } catch (err: any) {
      // No "simulated" fallback: it handed the browser a made-up Razorpay key
      // that the modal rejects, and no payment made there could ever verify.
      logger.warn({ err, vendorId, planId: plan.id }, 'vendor subscription checkout failed');
      throw new BadRequestError('Could not start payment — please try again');
    }

    if (checkout.mode === 'redirect') {
      // Local development bypass (no test keys): there is no gateway to pay
      // at, so the plan goes live straight away, exactly as a dev payment does
      // for memberships. `isFree` routes the dashboard down its no-payment
      // branch; `dev` says why.
      const { saved: _saved, ...applied } = await activatePaidPlan({
        vendorId,
        plan,
        billingPeriod,
        amountMinor,
        merchantTxnId,
        gatewayTxnId: `DEV_${Date.now()}`,
        paymentMethod: 'Development bypass',
      });
      return res.json({ ok: true, isFree: true, dev: true, merchantTxnId, ...applied, message: 'Plan activated (development).' });
    }

    prunePending();
    pendingCheckouts.set(checkout.orderId, {
      vendorId,
      planId: plan.id,
      billingPeriod,
      amountMinor: checkout.amountMinor,
      merchantTxnId,
      createdAt: Date.now(),
    });

    res.json({
      ok: true,
      merchantTxnId,
      amountRupees: finalPrice,
      plan: { id: plan.id, name: plan.name, tier: plan.tier, badge: plan.badge },
      checkout,
    });
  }),
);

// POST /api/vendor/subscriptions/verify
// Plan, period and amount come from the checkout record; the client-sent
// planId / tier / priceRupees fields are accepted for compatibility but ignored.
const VerifyBody = z.object({
  merchantTxnId: z.string().min(1),
  planId: z.string().optional(),
  planName: z.string().optional(),
  tier: z.string().optional(),
  priceRupees: z.number().optional(),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  paymentMethod: z.string().max(60).optional(),
  razorpay_order_id: z.string().optional(),
  razorpay_payment_id: z.string().optional(),
  razorpay_signature: z.string().optional(),
});

vendorSubscriptionsRouter.post(
  '/verify',
  requireAuth('vendor'),
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    const body = VerifyBody.parse(req.body);
    // Loaded before the idempotency check: it restores which payments were
    // already applied, so a replay after a restart is recognised.
    await Promise.all([loadPersistedPlanStores(), loadVendorSubscriptions()]);

    // The signature is what proves the vendor actually paid. Calling the check
    // and discarding its answer — or skipping it when the fields are absent —
    // handed an ACTIVE subscription and a PAID invoice to anyone who could POST
    // here, so both are now hard failures.
    if (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature) {
      throw new BadRequestError('Payment details are missing');
    }

    const already = appliedPayments.get(body.razorpay_payment_id);
    if (already) {
      if (already.vendorId !== vendorId) throw new ForbiddenError();
      return res.json({
        ok: true,
        alreadyApplied: true,
        subscription: currentVendorSubscription(vendorId),
        invoice: already.invoice,
        message: 'Payment already verified — your subscription is active.',
      });
    }

    const ctx = pendingCheckouts.get(body.razorpay_order_id) ?? (await checkoutFromOrder(body.razorpay_order_id));
    // Any other order — a campaign's, a featured slot's, a membership's — is
    // not a subscription purchase, however valid its signature.
    if (!ctx) throw new BadRequestError('This payment does not belong to a subscription checkout');
    if (ctx.vendorId !== vendorId) throw new ForbiddenError();

    if (!verifyPaymentSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      // Fall back to asking Razorpay directly, in case the client mangled the
      // signature but the money really did arrive.
      const live = await fetchPaymentStatus(body.razorpay_payment_id).catch(() => null);
      const captured = live && live.order_id === body.razorpay_order_id && (live.status === 'captured' || live.status === 'authorized');
      if (!captured) throw new BadRequestError('Payment could not be verified');
      if (typeof live.amount === 'number' && live.amount < ctx.amountMinor) {
        alertAdminsAboutPayment({
          merchantTxnId: ctx.merchantTxnId,
          amountMinor: ctx.amountMinor,
          currency: 'INR',
          reason: `Vendor subscription payment ${body.razorpay_payment_id} captured ${live.amount} against an order for ${ctx.amountMinor} - not credited`,
          who: vendorId,
        });
        throw new BadRequestError('Payment amount does not match the order');
      }
    }

    const result = await settleVendorPayment(ctx, body.razorpay_payment_id, body.paymentMethod || 'Razorpay / UPI / Card');
    pendingCheckouts.delete(body.razorpay_order_id);
    if (result.alreadyApplied) {
      return res.json({
        ok: true,
        alreadyApplied: true,
        subscription: currentVendorSubscription(vendorId),
        message: 'Payment already verified — your subscription is active.',
      });
    }
    const applied = result;

    // Paying for a plan does not approve an account. This used to force the
    // vendor's status to ACTIVE, letting a claim still under admin review
    // approve itself by buying a subscription.

    res.json({
      ok: true,
      subscription: applied.subscription,
      invoice: applied.invoice,
      message: 'Payment verified and Subscription Activated! 🎉',
    });
  }),
);
