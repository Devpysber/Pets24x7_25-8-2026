// Email layout primitives. Every transactional mail is assembled from these,
// so one change here restyles all of them.
//
// Table-based, inline-styled markup — Gmail/Outlook strip <style> blocks and
// ignore flexbox, so nothing here relies on either beyond the media query.

import { env } from '../env.js';
import type { MailInput } from './mailer.js';

export const BRAND = '#ff6b35';
/**
 * The brand orange darkened to pass WCAG AA (5.2:1 on white). #ff6b35 is only
 * 2.8:1, so it is kept for decoration (the top bar, the logo tile) and this is
 * used for anything a reader has to read: links, small labels, button fills.
 */
export const BRAND_TEXT = '#c2410c';
export const INK = '#111827';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
/**
 * Base URL for links and branding inside outbound email. MAIL_SITE_URL wins so
 * a dev box still mails production-looking links; PUBLIC_SITE_URL is the
 * fallback, which is what production already sets.
 */
export const mailSite = (): string => (env.MAIL_SITE_URL ?? env.PUBLIC_SITE_URL).replace(/\/+$/, '');

const SITE = mailSite;

/** Absolute link to a page on the public site, e.g. siteUrl('/membership/'). */
export function siteUrl(path = '/'): string {
  return `${mailSite()}${path.startsWith('/') ? path : `/${path}`}`;
}

// Dashboard deep links. The value after ?view= must be a real `view-<id>`
// pane in the matching dashboard (pets24x7_new/dashboard/*/index.html) — an
// unknown id lands on the default view, so keep these lists in sync with it.
export type ParentView = 'home' | 'search' | 'pets' | 'enquiries' | 'membership' | 'account';
export type VendorView =
  | 'dash' | 'listing' | 'enquiries' | 'services' | 'reviews' | 'performance' | 'grow' | 'subscriptions' | 'settings';
export type AdminView =
  | 'dash' | 'vendors' | 'parents' | 'enquiries' | 'services' | 'payments' | 'reviews' | 'featured'
  | 'plans' | 'deals' | 'directory' | 'mail' | 'import' | 'activity' | 'audit' | 'reports' | 'settings';

const dash = (role: string, view?: string, extra?: string): string =>
  siteUrl(`/dashboard/${role}/${view ? `?view=${view}${extra ? `&${extra}` : ''}` : ''}`);

export const parentDash = (view?: ParentView): string => dash('parent', view);
export const vendorDash = (view?: VendorView, extra?: string): string => dash('vendor', view, extra);
export const adminDash = (view?: AdminView, extra?: string): string => dash('admin', view, extra);

// ---------------------------------------------------------------------------
// Click attribution.
//
// Every link from an email to our own site carries
//   utm_source=email & utm_medium=<template tag> & utm_campaign=<campaign>
// so analytics can tell which message brought a visit back. Templates set
// `tag` (and optionally `campaign`) on the MailInput; withTracking() applies
// it to every link at send time, so no template has to remember to.
// ---------------------------------------------------------------------------

function isOwnSite(url: string): boolean {
  const bases = [mailSite(), env.PUBLIC_SITE_URL.replace(/\/+$/, '')];
  return bases.some((b) => url === b || url.startsWith(`${b}/`) || url.startsWith(`${b}?`) || url.startsWith(`${b}#`));
}

/**
 * Adds UTM parameters to one of our own URLs. Leaves alone: other hosts (the
 * API's verify/unsubscribe endpoints, WhatsApp), links already tagged, and
 * links that carry a credential — a token in the URL must not also be copied
 * into analytics page-location reports.
 */
export function track(url: string, medium: string, campaign = 'transactional'): string {
  if (!url || !isOwnSite(url) || /[?&]utm_source=/.test(url) || /[?&]token=/.test(url)) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const sep = base.includes('?') ? '&' : '?';
  const qs = `utm_source=email&utm_medium=${encodeURIComponent(medium)}&utm_campaign=${encodeURIComponent(campaign)}`;
  return `${base}${sep}${qs}${hash}`;
}

/** Applies track() to every own-site link in both the HTML and text parts. */
export function withTracking(mail: MailInput): MailInput {
  const medium = mail.tag || 'email';
  const campaign = mail.campaign || (mail.kind === 'marketing' ? 'marketing' : 'transactional');
  const html = mail.html.replace(/href="([^"]*)"/g, (whole, raw: string) => {
    const url = raw.replace(/&amp;/g, '&');
    const tagged = track(url, medium, campaign);
    return tagged === url ? whole : `href="${esc(tagged)}"`;
  });
  const text = mail.text.replace(/https?:\/\/[^\s<>"')]+/g, (found) => {
    const trail = /[.,;:!?]+$/.exec(found)?.[0] ?? '';
    const url = trail ? found.slice(0, -trail.length) : found;
    return track(url, medium, campaign) + trail;
  });
  return { ...mail, html, text };
}

/** Salutation-safe name: an empty or missing name never renders as "Hi ,". */
export function who(name: string | null | undefined, fallback = 'there'): string {
  const n = String(name ?? '').trim();
  return n && n !== 'null' && n !== 'undefined' ? n : fallback;
}

export function money(amountMinor: number, currency = 'INR'): string {
  const symbol = currency === 'USD' ? '$' : '₹';
  const locale = currency === 'USD' ? 'en-US' : 'en-IN';
  return `${symbol}${(amountMinor / 100).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * Timezone dates and times are shown in. The server runs in UTC, so without
 * this a 10:00 IST appointment read "4:30 am" in the mail. Most recipients are
 * in India; a caller mailing a US audience passes its own zone.
 */
export const MAIL_TZ = 'Asia/Kolkata';

export function day(d: Date | null | undefined, timeZone: string = MAIL_TZ): string {
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
}

export function dayTime(d: Date | null | undefined, timeZone: string = MAIL_TZ): string {
  if (!d || Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' });
  return `${day(d, timeZone)}, ${time}`;
}

// ---------------------------------------------------------------------------
// The shell.
//
// One card, 600px wide, on a light grey canvas: brand bar, wordmark, optional
// eyebrow, content rows, footer. Every row is a <tr> inside the card table so
// templates can drop in their own rows (lists, cards) and inherit the gutters.
//
// Colour: the palette is declared light-only (color-scheme meta + CSS). Apple
// Mail then renders it as designed instead of half-inverting it, and clients
// that force-invert (Gmail app, Outlook.com) get high-contrast text on plain
// backgrounds that survive inversion — no text sits on an image, and no pale
// grey is used for anything a reader needs.
// ---------------------------------------------------------------------------

/** Grey scale, all AA-contrast on white except MUTED, which is only used for fine print. */
const TEXT = '#374151';
const SUBTLE = '#4b5563';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const CANVAS = '#f3f4f6';
const PANEL = '#f9fafb';
/** Horizontal gutter inside the card. Custom rows in templates use the same 44px. */
const GUTTER = 44;

/**
 * Marker the Footer leaves for sendMail: marketing mail replaces it with the
 * unsubscribe line, so the link sits inside the card rather than under it.
 */
export const UNSUBSCRIBE_SLOT = '<!--p24:unsubscribe-->';

export function Layout(content: string, preheader?: string, title = 'Pets24x7'): string {
  // Filler after the preheader stops clients pulling body text into the inbox preview.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root{color-scheme:light;supported-color-schemes:light}
  body{margin:0!important;padding:0!important;width:100%!important;background:${CANVAS};font-family:${FONT};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table{border-spacing:0;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0} td{padding:0} img{border:0;display:block;-ms-interpolation-mode:bicubic}
  a{color:${BRAND_TEXT}}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
  @media only screen and (max-width:620px){
    .shell{padding:0!important} .main{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}
    .pad{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:22px!important;line-height:30px!important}
    .btn,.btn a{display:block!important;width:100%!important;box-sizing:border-box;text-align:center!important}
  }
</style></head>
<body style="margin:0;padding:0;background:${CANVAS}">
${preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${CANVAS}">${esc(preheader)}${filler}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS}">
<tr><td class="shell" align="center" style="padding:32px 12px">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="main" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
<tr><td style="height:4px;line-height:4px;font-size:0;background:${BRAND}">&nbsp;</td></tr>
${content}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body></html>`;
}

export function Header(eyebrow?: string): string {
  return `<tr><td class="pad" align="left" style="padding:26px ${GUTTER}px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" width="34" height="34" align="center" bgcolor="${BRAND}" style="width:34px;height:34px;border-radius:9px;background:${BRAND};color:#ffffff;font-size:17px;line-height:34px;font-family:${FONT}">&#128062;</td>
      <td valign="middle" style="padding-left:10px">
        <a href="${siteUrl('/')}" style="text-decoration:none;font-size:21px;font-weight:800;letter-spacing:-.4px;color:${INK};font-family:${FONT}">Pets<span style="color:#ea580c">24x7</span></a>
      </td>
    </tr></table>
  </td></tr>
  ${eyebrow ? `<tr><td class="pad" style="padding:24px ${GUTTER}px 0">
    <span style="display:inline-block;font-size:11px;font-weight:700;color:${BRAND_TEXT};text-transform:uppercase;letter-spacing:1.2px;font-family:${FONT}">${esc(eyebrow)}</span>
  </td></tr>` : ''}`;
}

export type BannerType = 'info' | 'success' | 'warning' | 'danger';

export function StatusBanner(text: string, type: BannerType = 'info'): string {
  // Text colours are the -800 shade of each hue: AA on their tint.
  const palette: Record<BannerType, [string, string, string]> = {
    info: ['#eff6ff', '#1e40af', '#bfdbfe'],
    success: ['#f0fdf4', '#166534', '#bbf7d0'],
    warning: ['#fffbeb', '#92400e', '#fde68a'],
    danger: ['#fef2f2', '#991b1b', '#fecaca'],
  };
  const [bg, fg, border] = palette[type];
  return `<tr><td class="pad" style="padding:16px ${GUTTER}px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${bg}" style="background:${bg};border:1px solid ${border};color:${fg};padding:6px 12px;border-radius:9999px;font-size:12px;font-weight:700;font-family:${FONT}">${esc(text)}</td>
    </tr></table>
  </td></tr>`;
}

/** Headline + intro paragraph. `message` may contain trusted inline HTML. */
export function Hero(heading: string, message: string): string {
  return `<tr><td class="pad" style="padding:14px ${GUTTER}px 4px">
    <h1 class="h1" style="margin:0 0 12px;color:${INK};font-size:26px;line-height:34px;font-weight:800;letter-spacing:-.4px;font-family:${FONT}">${esc(heading)}</h1>
    <p style="margin:0;color:${TEXT};font-size:16px;line-height:26px;font-family:${FONT}">${message}</p>
  </td></tr>`;
}

export function Text(html: string): string {
  return `<tr><td class="pad" style="padding:14px ${GUTTER}px 0">
    <div style="margin:0;color:${TEXT};font-size:15px;line-height:24px;font-family:${FONT}">${html}</div>
  </td></tr>`;
}

export function Quote(text: string): string {
  return `<tr><td class="pad" style="padding:20px ${GUTTER}px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="border-left:3px solid ${BRAND};background:${PANEL};padding:12px 16px;color:${TEXT};font-size:15px;line-height:24px;font-style:italic;font-family:${FONT}">${esc(text)}</td>
    </tr></table>
  </td></tr>`;
}

export function InfoBox(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:11px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:14px;color:${SUBTLE};font-family:${FONT}">${esc(k)}</td>` +
        `<td style="padding:11px 0 11px 12px;${i ? `border-top:1px solid ${LINE};` : ''}font-size:14px;color:${INK};text-align:right;font-weight:600;font-family:${FONT}">${esc(v)}</td></tr>`,
    )
    .join('');
  // Padding lives on a cell, not the table: Outlook ignores table padding.
  return `<tr><td class="pad" style="padding:20px ${GUTTER}px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PANEL};border:1px solid ${LINE};border-radius:12px">
      <tr><td style="padding:6px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table></td></tr>
    </table>
  </td></tr>`;
}

/** Big monospaced one-time code, the focal point of a sign-in email. */
export function CodeBlock(code: string): string {
  return `<tr><td class="pad" align="center" style="padding:26px ${GUTTER}px 0">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${PANEL}" style="background:${PANEL};border:1px solid ${LINE};border-radius:12px;padding:18px 30px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:10px;color:${INK}">${esc(code)}</td>
    </tr></table>
  </td></tr>`;
}

/**
 * Bulletproof call-to-action: a real <a> styled as a pill for every client,
 * plus a VML round-rect for desktop Outlook, which ignores padding on links.
 * Full width on phones.
 */
export function Button(label: string, url: string): string {
  const href = esc(url);
  const text = esc(label);
  const width = Math.min(520, Math.max(180, label.length * 9 + 60));
  return `<tr><td class="pad" align="left" style="padding:26px ${GUTTER}px 0">
    <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:${width}px" arcsize="50%" stroke="f" fillcolor="${BRAND_TEXT}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold">${text}</center></v:roundrect><![endif]-->
    <!--[if !mso]><!-->
    <table role="presentation" class="btn" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" bgcolor="${BRAND_TEXT}" style="border-radius:9999px;background:${BRAND_TEXT}">
        <a href="${href}" target="_blank" style="display:inline-block;padding:13px 30px;font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9999px;font-family:${FONT}">${text}</a>
      </td>
    </tr></table>
    <!--<![endif]-->
  </td></tr>`;
}

/** Small grey print under the call to action. */
export function Note(html: string): string {
  return `<tr><td class="pad" style="padding:16px ${GUTTER}px 0">
    <div style="margin:0;color:${MUTED};font-size:13px;line-height:20px;font-family:${FONT}">${html}</div>
  </td></tr>`;
}

/** WhatsApp support line, shown in every footer. */
export const SUPPORT_WHATSAPP = 'https://wa.me/919930090487';

export function Footer(): string {
  const link = `color:${SUBTLE};text-decoration:underline`;
  return `<tr><td style="padding:32px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
  <tr><td class="pad" bgcolor="${PANEL}" style="padding:24px ${GUTTER}px 28px;border-top:1px solid ${LINE};background:${PANEL}">
    <p style="margin:0 0 6px;font-size:14px;line-height:21px;color:${INK};font-weight:700;font-family:${FONT}">Need a hand?</p>
    <p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${SUBTLE};font-family:${FONT}">
      Reply to this email or message us on
      <a href="${SUPPORT_WHATSAPP}" style="color:${BRAND_TEXT};text-decoration:none;font-weight:700">WhatsApp</a>.
      We usually answer within a working day.
    </p>
    <p style="margin:0 0 14px;font-size:13px;line-height:20px;font-family:${FONT}">
      <a href="${siteUrl('/search/')}" style="color:${INK};text-decoration:none;font-weight:600">Find pet services</a>
      <span style="color:${MUTED}">&nbsp;&middot;&nbsp;</span>
      <a href="${siteUrl('/membership/')}" style="color:${INK};text-decoration:none;font-weight:600">Membership</a>
      <span style="color:${MUTED}">&nbsp;&middot;&nbsp;</span>
      <a href="${siteUrl('/register-business/')}" style="color:${INK};text-decoration:none;font-weight:600">List your business</a>
    </p>
    <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};font-family:${FONT}">
      Pets24x7 &middot; Pet care directory for India and the USA<br>
      &copy; ${new Date().getFullYear()} Pets24x7 &middot;
      <a href="${siteUrl('/privacy.html')}" style="${link}">Privacy</a> &middot;
      <a href="${siteUrl('/terms.html')}" style="${link}">Terms</a><br>
      You received this email because this address is used on ${esc(SITE().replace(/^https?:\/\//, ''))}.${UNSUBSCRIBE_SLOT}
    </p>
  </td></tr>`;
}

/**
 * Inbox preview line for a template that did not set one: the intro as plain
 * text. Without any, clients show whatever text comes first — the wordmark
 * and eyebrow — which is the same for every mail we send.
 */
function previewText(introHtml: string): string {
  const plain = introHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!)
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 120 ? `${plain.slice(0, 117).trimEnd()}...` : plain;
}

/** Assembles the standard body: header, optional banner, hero, extras, footer. */
export function page(parts: {
  eyebrow?: string;
  banner?: [string, BannerType];
  heading: string;
  intro: string;
  blocks?: string[];
  preheader?: string;
}): string {
  return Layout(
    [
      Header(parts.eyebrow),
      parts.banner ? StatusBanner(parts.banner[0], parts.banner[1]) : '',
      Hero(parts.heading, parts.intro),
      ...(parts.blocks ?? []),
      Footer(),
    ].join(''),
    parts.preheader ?? previewText(parts.intro),
    `${parts.heading} · Pets24x7`,
  );
}

/**
 * Tagged template for body HTML: literal markup passes through, every
 * interpolated value is escaped. Use it anywhere user-supplied text (a name,
 * a business, a reason) lands inside HTML.
 */
export function h(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? esc(values[i]) : ''), '');
}

/**
 * Deterministic pick from `options`, keyed by recipient and day. Recurring
 * marketing mail uses it so the subject line and lead-in vary from one send to
 * the next (the same words every time reads as a duplicate, and is what gets a
 * digest filtered), while a re-render for the same person on the same day —
 * a retry, the preview script — stays identical.
 */
export function rotate<T>(options: readonly T[], recipient: string, at: Date = new Date()): T {
  const key = `${recipient.trim().toLowerCase()}|${at.toISOString().slice(0, 10)}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return options[(hash >>> 0) % options.length]!;
}
