// Recommendation mail: the parent digest and the vendor growth digest.
//
// Both are kind:'marketing' — suppressed for opted-out addresses, carrying the
// global unsubscribe footer that sendMail injects. The parent digest also
// carries a digest-only opt-out (unsubscribe?scope=digest) so a parent can drop
// these without leaving every other mail, and a link to change how often.
//
// Every item says why it is there (its reason code text from the engine), and
// every sponsored item is labelled as such — the same disclosure as the site.

import type { MailInput } from './mailer.js';
import { unsubscribeUrl } from './optout.js';
import { BRAND_TEXT, Button, Note, Text, esc, h, page, parentDash, rotate, siteUrl, vendorDash, who, type VendorView } from './components.js';
import type { VendorPromoContext } from './promo-templates.js';

export interface RecoDigestItem {
  name: string;
  category: string;
  city?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  /** Absolute URL, carrying ?src=reco_email_digest. */
  url?: string | null;
  reason?: { code: string; text: string } | null;
  reasons?: string[];
  sponsored?: boolean;
  label?: string | null;
}

export interface RecoDigestDeal {
  title: string;
  offerLabel: string;
  vendor?: string | null;
  endsAt?: Date | string | null;
  url?: string | null;
  code?: string | null;
}

/** ISO week label, e.g. "2026-W39". */
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function endsLabel(v: Date | string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `Ends ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

/** Digest-only opt-out: the global unsubscribe link, scoped to this mail. */
export function digestOptOutUrl(to: string): string {
  return `${unsubscribeUrl(to)}&scope=digest`;
}

/**
 * Subject for a digest. Leads with the first place in THIS mail — the list
 * rotates between sends, so the subject does too — in one of a few phrasings
 * picked per recipient and day. It used to be the fixed "Picked for Bruno this
 * week" on every send, whatever the cadence, which read as the same mail again.
 */
export function digestSubject(to: string, petName: string | null, items: Array<{ name: string }>): string {
  // Scraped names can run to a line of keywords ("X CENTRE : VACCINATION,
  // SONOGRAPHY, ..."); inboxes cut a subject near 60 characters anyway.
  const raw = (items[0]?.name ?? '').replace(/\s+/g, ' ').trim();
  const top = raw.length > 40 ? `${raw.slice(0, 38).replace(/[\s,.:;-]+\S*$/, '')}…` : raw;
  const more = items.length - 1;
  const forWho = petName ? ` for ${petName}` : '';
  if (!top) return petName ? `New picks for ${petName}` : 'Pet services picked for you';
  return rotate(
    [
      more > 0 ? `${top} + ${more} more picked${forWho}` : `${top}, picked${forWho}`,
      `New picks${forWho}: ${top}${more > 0 ? ' and more' : ''}`,
      petName ? `${petName}'s picks near you: ${top}${more > 0 ? ` and ${more} more` : ''}` : `Near you: ${top}${more > 0 ? ` and ${more} more` : ''}`,
    ],
    to,
  );
}

export function recoDigestEmail(
  to: string,
  name: string,
  petName: string | null,
  items: RecoDigestItem[],
  opts: { deals?: RecoDigestDeal[]; week?: string } = {},
): MailInput {
  const shown = items.slice(0, 6);
  const cards = shown
    .map((it) => {
      const stars = it.rating ? `★ ${Number(it.rating).toFixed(1)}` : '';
      const reviews = it.reviewCount ? ` · ${it.reviewCount} Google reviews` : '';
      const why = it.sponsored ? '' : it.reason?.text || (it.reasons ?? [])[0] || '';
      const title = it.url
        ? `<a href="${esc(it.url)}" style="color:#111827;text-decoration:none">${esc(it.name)}</a>`
        : esc(it.name);
      const badge = it.sponsored
        ? ` <span aria-label="Sponsored listing" style="display:inline-block;margin-left:6px;padding:1px 7px;border:1px solid #d1d5db;border-radius:9999px;font-size:11px;font-weight:600;color:#6b7280;vertical-align:middle">${esc(it.label || 'Sponsored')}</span>`
        : '';
      return `<tr><td style="padding:14px 0;border-top:1px solid #eceef2">
        <div style="font-size:15px;font-weight:700;line-height:1.35">${title}${badge}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(it.category)}${it.city ? ` · ${esc(it.city)}` : ''}</div>
        ${stars || reviews ? `<div style="font-size:13px;color:#6b7280;margin-top:3px">${esc(stars)}${esc(reviews)}</div>` : ''}
        ${why ? `<div style="font-size:12px;color:${BRAND_TEXT};font-weight:600;margin-top:5px">${esc(why)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  const deals = (opts.deals ?? []).slice(0, 2);
  const dealRows = deals
    .map((d) => {
      const title = d.url
        ? `<a href="${esc(d.url)}" style="color:#111827;text-decoration:none">${esc(d.title)}</a>`
        : esc(d.title);
      const meta = [d.vendor, endsLabel(d.endsAt), d.code ? `Code ${d.code}` : ''].filter(Boolean).join(' · ');
      return `<tr><td style="padding:12px 0;border-top:1px solid #eceef2">
        <span style="display:inline-block;background:#fff4ee;color:${BRAND_TEXT};font-size:12px;font-weight:700;padding:2px 8px;border-radius:6px">${esc(d.offerLabel)}</span>
        <div style="font-size:14px;font-weight:700;margin-top:6px">${title}</div>
        ${meta ? `<div style="font-size:12px;color:#6b7280;margin-top:3px">${esc(meta)}</div>` : ''}
      </td></tr>`;
    })
    .join('');

  const forPet = petName ? ` for ${petName}` : '';
  const manage = parentDash('account');
  const optOut = digestOptOutUrl(to);
  name = who(name);
  return {
    tag: 'recommendations',
    campaign: `digest_${opts.week ?? isoWeek()}`,
    kind: 'marketing',
    to,
    subject: digestSubject(to, petName, shown),
    html: page({
      eyebrow: 'Recommendations',
      heading: petName ? `Picked for ${petName}` : 'Picked for you',
      intro: rotate(
        [
          h`Hi ${name} — places near you that match what ${petName ?? 'your pet'} needs, and what you have been looking at.`,
          h`Hi ${name} — a fresh set of places near you, none of them from your last few emails.`,
          h`Hi ${name} — here is what stands out near you right now for ${petName ?? 'your pet'}.`,
        ],
        to,
      ),
      blocks: [
        `<tr><td class="pad" style="padding:8px 44px 0"><table width="100%">${cards}</table></td></tr>`,
        ...(dealRows
          ? [
              Text('<strong>Deals near you</strong>'),
              `<tr><td class="pad" style="padding:0 44px 0"><table width="100%">${dealRows}</table></td></tr>`,
            ]
          : []),
        Button('See all recommendations', parentDash('home')),
        Note(
          'Ranked from your pets, what you saved, viewed and enquired about, and public ratings. Sponsored places are labelled.<br>' +
            `<a href="${esc(manage)}" style="color:#6b7280;text-decoration:underline">Get these less often</a> · ` +
            `<a href="${esc(optOut)}" style="color:#6b7280;text-decoration:underline">Stop recommendation emails</a>`,
        ),
      ],
      preheader: shown.length ? `${shown.length} places near you${forPet}` : 'Your recommendations',
    }),
    text:
      `Hi ${name},\n\nPicked${forPet}:\n\n` +
      shown
        .map(
          (it) =>
            `- ${it.name} (${it.category})${it.sponsored ? ` [${it.label || 'Sponsored'}]` : ''}${it.rating ? ` — ${Number(it.rating).toFixed(1)}★` : ''}` +
            (!it.sponsored && (it.reason?.text || (it.reasons ?? [])[0]) ? `\n  why: ${it.reason?.text || (it.reasons ?? [])[0]}` : '') +
            (it.url ? `\n  ${it.url}` : ''),
        )
        .join('\n') +
      (deals.length
        ? `\n\nDeals near you:\n` + deals.map((d) => `- ${d.offerLabel}: ${d.title}${d.vendor ? ` (${d.vendor})` : ''}${d.url ? `\n  ${d.url}` : ''}`).join('\n')
        : '') +
      `\n\nAll recommendations: ${parentDash('home')}\n` +
      `Get these less often: ${manage}\nStop recommendation emails: ${optOut}\n`,
  };
}

export interface GrowthAction {
  title: string;
  body: string;
  metric?: { label: string; value: number | string; benchmark?: number | string };
  cta: { label: string; view?: string; href?: string };
}

const VENDOR_VIEWS: VendorView[] = ['dash', 'listing', 'enquiries', 'services', 'reviews', 'performance', 'grow', 'subscriptions', 'settings'];

function ctaUrl(cta: GrowthAction['cta']): string {
  if (cta.href) return /^https?:\/\//i.test(cta.href) ? cta.href : siteUrl(cta.href);
  const view = cta.view === 'grow-plans' ? 'grow' : cta.view;
  return VENDOR_VIEWS.includes(view as VendorView) ? vendorDash(view as VendorView) : vendorDash();
}

/** Weekly growth digest for a business: its top actions plus one benchmark line. */
export function vendorGrowthDigestEmail(
  to: string,
  ctx: VendorPromoContext,
  actions: GrowthAction[],
  benchmarkLine: string | null,
): MailInput {
  const top = actions.slice(0, 3);
  const rows = top
    .map((a) => {
      const metric = a.metric
        ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${esc(a.metric.label)}: <strong>${esc(a.metric.value)}</strong>${a.metric.benchmark != null ? ` · benchmark ${esc(a.metric.benchmark)}` : ''}</div>`
        : '';
      return `<tr><td style="padding:14px 0;border-top:1px solid #eceef2">
        <div style="font-size:15px;font-weight:700">${esc(a.title)}</div>
        <div style="font-size:14px;color:#374151;margin-top:4px;line-height:21px">${esc(a.body)}</div>
        ${metric}
        <div style="margin-top:8px"><a href="${esc(ctaUrl(a.cta))}" style="color:${BRAND_TEXT};font-weight:600;text-decoration:none">${esc(a.cta.label)} &rarr;</a></div>
      </td></tr>`;
    })
    .join('');
  const where = ctx.city ? ` in ${ctx.city}` : '';
  return {
    tag: 'vendor_growth_digest',
    campaign: 'vendor_engagement',
    kind: 'marketing',
    to,
    subject: `${ctx.businessName}: ${top.length} thing${top.length === 1 ? '' : 's'} to do this week`,
    html: page({
      eyebrow: 'Your week',
      heading: 'Grow your listing this week',
      intro: h`Here is what will bring ${ctx.businessName} the most new customers${where} right now.`,
      blocks: [
        ...(benchmarkLine ? [Note(esc(benchmarkLine))] : []),
        `<tr><td class="pad" style="padding:8px 44px 0"><table width="100%">${rows}</table></td></tr>`,
        Button('Open my dashboard', vendorDash('dash')),
        Note('Benchmarks use public data only: Google ratings and review counts, and anonymised medians for your city and category.'),
      ],
      preheader: top[0]?.title ?? `This week for ${ctx.businessName}`,
    }),
    text:
      `This week for ${ctx.businessName}:\n\n` +
      (benchmarkLine ? `${benchmarkLine}\n\n` : '') +
      top.map((a) => `- ${a.title}\n  ${a.body}\n  ${a.cta.label}: ${ctaUrl(a.cta)}`).join('\n') +
      `\n\nDashboard: ${vendorDash('dash')}\n`,
  };
}
