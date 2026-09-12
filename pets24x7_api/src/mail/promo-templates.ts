// Promotional mail for businesses, and the link tagging both sides share.
//
// Every message here is kind:'marketing': suppressed for opted-out addresses,
// carries unsubscribe headers, and is paced by jobs/vendor-engagement.ts. None
// of it is a consequence of something the vendor just did — that mail lives in
// action-templates.ts and must never be rate-limited.
//
// Each template says one thing, backs it with a real number from the vendor's
// own account, and links to the exact page that acts on it. A promotional mail
// with no number and no destination is the kind people unsubscribe from.

import { env } from '../env.js';
import type { MailInput } from './mailer.js';
import { Button, InfoBox, Note, Text, esc, h, page } from './components.js';

const SITE = () => env.PUBLIC_SITE_URL.replace(/\/+$/, '');
const VENDOR_DASH = () => `${SITE()}/dashboard/vendor/`;

/**
 * Tags a link so clicks from mail are attributable in analytics.
 *
 * Without this every visit from these campaigns lands in "direct" and there is
 * no way to tell which message actually brought anyone back.
 */
export function track(url: string, campaign: string, medium = 'email'): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}utm_source=pets24x7&utm_medium=${encodeURIComponent(medium)}&utm_campaign=${encodeURIComponent(campaign)}`;
}

export interface VendorPromoContext {
  businessName: string;
  city?: string | null;
  /** Public URL of their listing, when they have a claimed one. */
  listingUrl?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
}

// ---------------------------------------------------------------------------
// "Your listing is live" — the one every vendor gets first.
// ---------------------------------------------------------------------------
export function vendorListingLiveEmail(to: string, ctx: VendorPromoContext, cityListings: number): MailInput {
  const url = ctx.listingUrl ? track(ctx.listingUrl, 'vendor_listing_live') : track(VENDOR_DASH(), 'vendor_listing_live');
  const where = ctx.city ? `in ${ctx.city}` : 'in your city';
  return {
    to,
    kind: 'marketing',
    subject: `${ctx.businessName} is live on Pets24x7 — see your page`,
    html: page({
      eyebrow: 'Your listing',
      heading: 'Your page is live',
      intro: h`Pet owners searching ${where} can find ${ctx.businessName} right now. Here is what they see.`,
      blocks: [
        InfoBox([
          ['Business', ctx.businessName],
          ['Area', ctx.city || '—'],
          ['Rating shown', ctx.rating ? `${ctx.rating} / 5` : 'No public rating yet'],
          ['Competing listings nearby', cityListings > 0 ? String(cityListings) : '—'],
        ]),
        Button('View my live listing', url),
        Note('A listing with a photo and a description gets opened far more often than one without. Both take a minute to add from your dashboard.'),
      ],
      preheader: `See how ${ctx.businessName} appears to pet owners searching ${where}.`,
    }),
    text: `${ctx.businessName} is live on Pets24x7.\n\nView your listing: ${url}\n`,
  };
}

// ---------------------------------------------------------------------------
// Profile completion — names the specific gaps rather than a percentage.
// ---------------------------------------------------------------------------
export function vendorProfileGapsEmail(to: string, ctx: VendorPromoContext, missing: string[]): MailInput {
  const url = track(`${VENDOR_DASH()}?view=listing`, 'vendor_profile_gaps');
  const list = missing.map((m) => `<li style="margin-bottom:6px">${esc(m)}</li>`).join('');
  return {
    to,
    kind: 'marketing',
    subject: `${missing.length} thing${missing.length === 1 ? '' : 's'} missing from your Pets24x7 listing`,
    html: page({
      eyebrow: 'Your listing',
      heading: 'Finish your listing',
      intro: h`${ctx.businessName} is live, but pet owners are seeing an incomplete page. These are the gaps:`,
      blocks: [
        Text(`<ul style="margin:0 0 4px 18px;padding:0;line-height:22px">${list}</ul>`),
        Button('Complete my listing', url),
        Note('Each one takes under a minute, and photos make the biggest difference.'),
      ],
      preheader: `Add the missing details to ${ctx.businessName}.`,
    }),
    text: `Your Pets24x7 listing is missing:\n${missing.map((m) => `- ${m}`).join('\n')}\n\nFinish it: ${url}\n`,
  };
}

// ---------------------------------------------------------------------------
// Unanswered enquiries — the only promo mail with real money behind it.
// ---------------------------------------------------------------------------
export function vendorOpenEnquiriesEmail(to: string, ctx: VendorPromoContext, openCount: number): MailInput {
  const url = track(`${VENDOR_DASH()}?view=enquiries`, 'vendor_open_enquiries');
  return {
    to,
    kind: 'marketing',
    subject: `${openCount} customer${openCount === 1 ? '' : 's'} waiting on ${ctx.businessName}`,
    html: page({
      eyebrow: 'Enquiries',
      heading: openCount === 1 ? 'One customer is waiting' : `${openCount} customers are waiting`,
      intro: h`Pet owners enquired about ${ctx.businessName} and have not heard back yet. Most people book whoever replies first.`,
      blocks: [
        Button('Open my enquiries', url),
        Note('You can reply straight to WhatsApp from the enquiry, and mark it handled in one tap.'),
      ],
      preheader: `${openCount} unanswered enquir${openCount === 1 ? 'y' : 'ies'} on your listing.`,
    }),
    text: `${openCount} unanswered enquiries on Pets24x7.\n\nOpen them: ${url}\n`,
  };
}

// ---------------------------------------------------------------------------
// Reviews — asking is the only thing that reliably produces them.
// ---------------------------------------------------------------------------
export function vendorCollectReviewsEmail(to: string, ctx: VendorPromoContext): MailInput {
  const url = track(`${VENDOR_DASH()}?view=performance`, 'vendor_collect_reviews');
  const has = (ctx.reviewCount ?? 0) > 0;
  return {
    to,
    kind: 'marketing',
    subject: has
      ? `Add to the ${ctx.reviewCount} reviews on ${ctx.businessName}`
      : `${ctx.businessName} has no reviews yet`,
    html: page({
      eyebrow: 'Reviews',
      heading: has ? 'Keep the reviews coming' : 'Your first review matters most',
      intro: has
        ? h`${ctx.businessName} shows ${String(ctx.reviewCount)} review${ctx.reviewCount === 1 ? '' : 's'}. Listings with recent reviews get chosen more often than ones with none.`
        : h`A listing with no reviews is a harder choice for a pet owner. One or two from regular customers changes that.`,
      blocks: [
        Button('Ask my customers', url),
        Note('Send a request on WhatsApp in a couple of taps — the customer just opens the link and rates you.'),
      ],
      preheader: `Collect reviews for ${ctx.businessName}.`,
    }),
    text: `Collect reviews for ${ctx.businessName}: ${url}\n`,
  };
}

// ---------------------------------------------------------------------------
// Visibility upsell — honest about what it does and does not buy.
// ---------------------------------------------------------------------------
export function vendorVisibilityEmail(to: string, ctx: VendorPromoContext, cityListings: number): MailInput {
  const url = track(`${VENDOR_DASH()}?view=subscriptions`, 'vendor_visibility');
  const where = ctx.city || 'your city';
  return {
    to,
    kind: 'marketing',
    subject: `Get ${ctx.businessName} seen first in ${where}`,
    html: page({
      eyebrow: 'Grow',
      heading: `You are one of ${cityListings > 0 ? cityListings : 'many'} in ${esc(where)}`,
      intro: h`Pet owners rarely scroll past the first few results. A featured placement puts ${ctx.businessName} at the top of its category in ${where}.`,
      blocks: [
        Button('See placement options', url),
        Note('No lock-in. You can stop at the end of any billing period, and your listing stays live either way.'),
      ],
      preheader: `Placement options for ${ctx.businessName} in ${where}.`,
    }),
    text: `Get seen first in ${where}: ${url}\n`,
  };
}

// ---------------------------------------------------------------------------
// Pet parents — new businesses near them. The counterpart to the digest, and
// the one message that is genuinely new information rather than a re-ranking.
// ---------------------------------------------------------------------------
export function parentNewNearbyEmail(
  to: string,
  name: string,
  city: string,
  businesses: Array<{ name: string; category: string; rating: number | string; url: string }>,
): MailInput {
  const rows = businesses
    .map(
      (b) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #E5E7EB">
           <a href="${track(b.url, 'parent_new_nearby')}" style="color:#2563EB;font-weight:700;text-decoration:none">${esc(b.name)}</a>
           <div style="color:#6B7280;font-size:13px;margin-top:2px">${esc(b.category)}${b.rating ? ` · ★ ${esc(b.rating)}` : ''}</div>
         </td></tr>`,
    )
    .join('');
  const browse = track(`${SITE()}/search/?city=${encodeURIComponent(city)}`, 'parent_new_nearby');
  return {
    to,
    kind: 'marketing',
    subject: `${businesses.length} new pet business${businesses.length === 1 ? '' : 'es'} in ${city}`,
    html: page({
      eyebrow: 'New near you',
      heading: `Just added in ${esc(city)}`,
      intro: h`Hi ${name} — these joined Pets24x7 in ${city} recently. They were not on the site last time you looked.`,
      blocks: [
        Text(`<table role="presentation" width="100%" style="border-collapse:collapse">${rows}</table>`),
        Button(`Browse everything in ${city}`, browse),
      ],
      preheader: `New pet businesses in ${city}.`,
    }),
    text:
      `New pet businesses in ${city}:\n` +
      businesses.map((b) => `- ${b.name} (${b.category}) ${b.url}`).join('\n') +
      `\n\nBrowse: ${browse}\n`,
  };
}

// ---------------------------------------------------------------------------
// "Claim your listing" — sent to a business that is listed but has never
// completed a claim. The pitch is the enquiries they are already missing, not
// a feature list.
// ---------------------------------------------------------------------------
export function claimListingEmail(to: string, ctx: VendorPromoContext): MailInput {
  const claimUrl = track(`${SITE()}/find-my-listing/`, 'vendor_claim_listing');
  const listingUrl = ctx.listingUrl ? track(ctx.listingUrl, 'vendor_claim_listing') : null;
  const where = ctx.city ? ` in ${ctx.city}` : '';
  return {
    to,
    kind: 'marketing',
    subject: `${ctx.businessName} is listed on Pets24x7 — claim it free`,
    html: page({
      eyebrow: 'Your listing',
      heading: 'Your business is already on Pets24x7',
      intro: h`${ctx.businessName} appears in our directory${where}, and pet owners are finding it. Claiming it — free, a couple of minutes — puts you in control of what they see.`,
      blocks: [
        InfoBox([
          ['Business', ctx.businessName],
          ['Area', ctx.city || '—'],
          ['Google rating shown', ctx.rating ? `${ctx.rating} / 5` : 'Not shown yet'],
          ['Reviews shown', ctx.reviewCount ? String(ctx.reviewCount) : '—'],
        ]),
        Text(
          '<p style="margin:0 0 8px;line-height:22px">Claiming lets you:</p>' +
          '<ul style="margin:0 0 4px 18px;padding:0;line-height:22px">' +
          '<li>Receive enquiries from pet owners straight to your WhatsApp</li>' +
          '<li>Correct your address, hours, services and phone number</li>' +
          '<li>Add photos, and reply publicly to reviews</li>' +
          '</ul>',
        ),
        Button('Claim my listing', claimUrl),
        ...(listingUrl ? [Note(`Prefer to look first? <a href="${listingUrl}">See your listing as it appears today</a>.`)] : []),
        Note('We verify with the phone number already on the listing, so nobody else can claim your business.'),
      ],
      preheader: `Claim ${ctx.businessName} on Pets24x7 — free.`,
    }),
    text:
      `${ctx.businessName} is listed on Pets24x7${where}.\n\n` +
      `Claim it free: ${claimUrl}\n` +
      (listingUrl ? `See your listing: ${listingUrl}\n` : ''),
  };
}
