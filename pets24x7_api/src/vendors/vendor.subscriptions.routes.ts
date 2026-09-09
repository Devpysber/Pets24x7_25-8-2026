import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../shared/async-handler.js';
import { memoryVendorSubPlans } from '../admin/admin.api.routes.js';
import { prisma } from '../db.js';
import { startCheckout } from '../payments/checkout.js';
import { newMerchantTxnId } from '../payments/checkout.js';
import { fetchPaymentStatus, verifyPaymentSignature } from '../payments/razorpay.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';

export const vendorSubscriptionsRouter = Router();

// Store memory subscriptions for vendors
export const vendorSubscriptionStore = new Map<string, any>();
const vendorInvoicesStore = new Map<string, any[]>();

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

function getVendorSub(vendorId: string) {
  if (!vendorSubscriptionStore.has(vendorId)) {
    vendorSubscriptionStore.set(vendorId, {
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
      endsAt: new Date(Date.now() + 365 * 86400 * 1000),
      autoRenew: false,
    });
  }
  return vendorSubscriptionStore.get(vendorId);
}

function getVendorInvoices(vendorId: string) {
  if (!vendorInvoicesStore.has(vendorId)) {
    vendorInvoicesStore.set(vendorId, [
      {
        id: `inv_${Date.now()}_1`,
        merchantTxnId: `TXN_INIT_${vendorId.slice(-4)}`,
        planName: 'Basic Free Plan',
        tier: 'BASIC',
        amountRupees: 0,
        status: 'PAID',
        paymentMethod: 'System Default',
        createdAt: new Date(Date.now() - 30 * 86400 * 1000),
      }
    ]);
  }
  return vendorInvoicesStore.get(vendorId) || [];
}

// GET /api/vendor/subscriptions/plans
vendorSubscriptionsRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    let plans: VendorSubPlan[] = (memoryVendorSubPlans && memoryVendorSubPlans.length > 0)
      ? (memoryVendorSubPlans as VendorSubPlan[])
      : DEFAULT_PLANS;
    res.json({ ok: true, plans });
  }),
);

// GET /api/vendor/subscriptions/me
vendorSubscriptionsRouter.get(
  '/me',
  requireAuth('vendor'),
  asyncHandler(async (req, res) => {
    const vendorId = req.auth!.sub;
    const activeSub = getVendorSub(vendorId);
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

    const allPlans: VendorSubPlan[] = (memoryVendorSubPlans && memoryVendorSubPlans.length > 0)
      ? (memoryVendorSubPlans as VendorSubPlan[])
      : DEFAULT_PLANS;

    const foundPlan = allPlans.find((p) => p.id === planId || (p.sku && p.sku === planId));
    const plan: VendorSubPlan = foundPlan ?? (allPlans[0] ?? DEFAULT_PLANS[0]!);

    let finalPrice = plan.priceRupees;
    let duration = plan.durationDays || 30;
    if (billingPeriod === 'ANNUAL' && plan.priceRupees > 0) {
      finalPrice = Math.round(plan.priceRupees * 10);
      duration = 365;
    }

    const merchantTxnId = newMerchantTxnId();
    const amountMinor = Math.round(finalPrice * 100);

    if (finalPrice === 0) {
      const updatedSub = {
        id: `v_sub_${vendorId}`,
        vendorId,
        tier: plan.tier || 'BASIC',
        tierName: plan.name,
        pricePaidRupees: 0,
        leadLimit: plan.leadLimit || 10,
        leadsUsed: 0,
        badge: plan.badge || 'VERIFIED',
        status: 'ACTIVE',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + duration * 86400 * 1000),
        autoRenew: false,
      };
      vendorSubscriptionStore.set(vendorId, updatedSub);

      const invoices = getVendorInvoices(vendorId);
      invoices.unshift({
        id: `inv_${Date.now()}`,
        merchantTxnId,
        planName: plan.name,
        tier: plan.tier || 'BASIC',
        amountRupees: 0,
        status: 'PAID',
        paymentMethod: 'Free Activation',
        createdAt: new Date(),
      });

      return res.json({
        ok: true,
        isFree: true,
        subscription: updatedSub,
        message: 'Plan activated successfully!',
      });
    }

    try {
      const checkout = await startCheckout({
        merchantTxnId,
        amountMinor,
        userId: vendorId,
        purpose: 'MEMBERSHIP',
        currency: 'INR',
      });

      res.json({
        ok: true,
        merchantTxnId,
        amountRupees: finalPrice,
        plan: { id: plan.id, name: plan.name, tier: plan.tier, badge: plan.badge },
        checkout,
      });
    } catch (err: any) {
      res.json({
        ok: true,
        merchantTxnId,
        amountRupees: finalPrice,
        plan: { id: plan.id, name: plan.name, tier: plan.tier, badge: plan.badge },
        checkout: {
          mode: 'simulated',
          orderId: `order_sim_${Date.now()}`,
          keyId: 'rzp_test_571408892',
          amountMinor,
          currency: 'INR',
        },
      });
    }
  }),
);

// POST /api/vendor/subscriptions/verify
const VerifyBody = z.object({
  merchantTxnId: z.string().min(1),
  planId: z.string().optional(),
  planName: z.string().optional(),
  tier: z.string().optional(),
  priceRupees: z.number().optional(),
  billingPeriod: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  paymentMethod: z.string().optional(),
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

    const allPlans: VendorSubPlan[] = (memoryVendorSubPlans && memoryVendorSubPlans.length > 0)
      ? (memoryVendorSubPlans as VendorSubPlan[])
      : DEFAULT_PLANS;

    const foundPlan = allPlans.find((p) => p.id === body.planId || (p.sku && p.sku === body.planId) || p.tier === body.tier);
    const plan: VendorSubPlan = foundPlan ?? (allPlans[0] ?? DEFAULT_PLANS[0]!);
    const duration = (body.billingPeriod === 'ANNUAL' || plan.durationDays === 365) ? 365 : 30;

    // The signature is what proves the vendor actually paid. Calling the check
    // and discarding its answer — or skipping it when the fields are absent —
    // handed an ACTIVE subscription and a PAID invoice to anyone who could POST
    // here, so both are now hard failures.
    if (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature) {
      throw new BadRequestError('Payment details are missing');
    }
    if (!verifyPaymentSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      // Fall back to asking Razorpay directly, in case the client mangled the
      // signature but the money really did arrive.
      const live = await fetchPaymentStatus(body.razorpay_payment_id).catch(() => null);
      const captured = live && live.order_id === body.razorpay_order_id && (live.status === 'captured' || live.status === 'authorized');
      if (!captured) throw new BadRequestError('Payment could not be verified');
    }

    const updatedSub = {
      id: `v_sub_${vendorId}`,
      vendorId,
      tier: plan.tier || body.tier || 'GOLD',
      tierName: plan.name || body.planName || 'Vendor Subscription Plan',
      // Priced from the plan, not the request: a client-sent amount would let a
      // vendor invoice themselves one rupee for a year of Gold.
      pricePaidRupees: plan.priceRupees,
      leadLimit: plan.leadLimit || 9999,
      leadsUsed: 0,
      badge: plan.badge || 'GOLD_PLATINUM',
      status: 'ACTIVE',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + duration * 86400 * 1000),
      autoRenew: true,
    };
    vendorSubscriptionStore.set(vendorId, updatedSub);

    const invoices = getVendorInvoices(vendorId);
    const invoice = {
      id: `inv_${Date.now()}`,
      merchantTxnId: body.merchantTxnId,
      gatewayTxnId: body.razorpay_payment_id || `PAY_${Date.now()}`,
      planName: updatedSub.tierName,
      tier: updatedSub.tier,
      amountRupees: updatedSub.pricePaidRupees,
      status: 'PAID',
      paymentMethod: body.paymentMethod || 'Razorpay / UPI / Card',
      createdAt: new Date(),
    };
    invoices.unshift(invoice);

    await prisma.vendor.update({
      where: { id: vendorId },
      data: { status: 'ACTIVE' },
    }).catch(() => {});

    res.json({
      ok: true,
      subscription: updatedSub,
      invoice,
      message: 'Payment verified and Subscription Activated! 🎉',
    });
  }),
);
