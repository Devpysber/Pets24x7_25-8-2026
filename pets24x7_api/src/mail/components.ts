// Email layout primitives. Every transactional mail is assembled from these,
// so one change here restyles all of them.
//
// Table-based, inline-styled markup — Gmail/Outlook strip <style> blocks and
// ignore flexbox, so nothing here relies on either beyond the media query.

import { env } from '../env.js';

export const BRAND = '#ff6b35';
export const INK = '#111827';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const SITE = () => env.PUBLIC_SITE_URL;

export function money(amountMinor: number, currency = 'INR'): string {
  const symbol = currency === 'USD' ? '$' : '₹';
  const locale = currency === 'USD' ? 'en-US' : 'en-IN';
  return `${symbol}${(amountMinor / 100).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function day(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dayTime(d: Date | null | undefined): string {
  if (!d) return '—';
  return `${day(d)}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

export function Layout(content: string, preheader?: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f6f7f9;font-family:${FONT};-webkit-font-smoothing:antialiased}
  table{border-spacing:0;border-collapse:collapse} td{padding:0} img{border:0;display:block}
  .wrapper{width:100%;background:#f6f7f9;padding:32px 0}
  .main{background:#fff;max-width:600px;margin:0 auto;width:100%;border-radius:16px;overflow:hidden;border:1px solid #e9eaee}
  @media only screen and (max-width:600px){
    .main{border-radius:0;border:none} .wrapper{padding:0} .pad{padding:28px 24px !important}
  }
</style></head>
<body><center class="wrapper">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:0">${esc(preheader)}</div>` : ''}
<table width="100%" class="main">${content}</table>
</center></body></html>`;
}

export function Header(eyebrow?: string): string {
  return `<tr><td align="center" style="padding:28px 0 20px;border-bottom:1px solid #f1f2f4">
    <a href="${SITE()}" style="text-decoration:none;font-size:24px;font-weight:800;letter-spacing:-.5px;color:${INK};font-family:${FONT}">
      Pets<span style="color:${BRAND}">24x7</span>
    </a>
  </td></tr>
  ${eyebrow ? `<tr><td align="center" style="padding:16px 0 0">
    <span style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-family:${FONT}">${esc(eyebrow)}</span>
  </td></tr>` : ''}`;
}

export type BannerType = 'info' | 'success' | 'warning' | 'danger';

export function StatusBanner(text: string, type: BannerType = 'info'): string {
  const palette: Record<BannerType, [string, string]> = {
    info: ['#eff6ff', '#1d4ed8'],
    success: ['#f0fdf4', '#15803d'],
    warning: ['#fffbeb', '#a16207'],
    danger: ['#fef2f2', '#b91c1c'],
  };
  const [bg, fg] = palette[type];
  return `<tr><td class="pad" style="padding:24px 44px 0">
    <div style="background:${bg};color:${fg};padding:10px 14px;border-radius:8px;font-size:13px;font-weight:700;font-family:${FONT};display:inline-block">${esc(text)}</div>
  </td></tr>`;
}

/** Headline + intro paragraph. `message` may contain trusted inline HTML. */
export function Hero(heading: string, message: string): string {
  return `<tr><td class="pad" style="padding:24px 44px 8px">
    <h1 style="margin:0 0 12px;color:${INK};font-size:26px;font-weight:800;letter-spacing:-.5px;font-family:${FONT}">${esc(heading)}</h1>
    <p style="margin:0;color:#374151;font-size:16px;line-height:26px;font-family:${FONT}">${message}</p>
  </td></tr>`;
}

export function Text(html: string): string {
  return `<tr><td class="pad" style="padding:12px 44px 0">
    <p style="margin:0;color:#374151;font-size:15px;line-height:24px;font-family:${FONT}">${html}</p>
  </td></tr>`;
}

export function Quote(text: string): string {
  return `<tr><td class="pad" style="padding:20px 44px 0">
    <div style="border-left:3px solid ${BRAND};padding:4px 0 4px 16px;color:#374151;font-size:15px;line-height:24px;font-style:italic;font-family:${FONT}">${esc(text)}</div>
  </td></tr>`;
}

export function InfoBox(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:11px 0;${i ? 'border-top:1px solid #eceef2;' : ''}font-size:14px;color:#6b7280;font-family:${FONT}">${esc(k)}</td>` +
        `<td style="padding:11px 0;${i ? 'border-top:1px solid #eceef2;' : ''}font-size:14px;color:${INK};text-align:right;font-weight:600;font-family:${FONT}">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<tr><td class="pad" style="padding:20px 44px 0">
    <table width="100%" style="background:#fafaf9;border:1px solid #f1f2f4;border-radius:12px;padding:6px 18px">${cells}</table>
  </td></tr>`;
}

/** Big monospaced one-time code, the focal point of a sign-in email. */
export function CodeBlock(code: string): string {
  return `<tr><td class="pad" align="center" style="padding:26px 44px 0">
    <div style="display:inline-block;background:#fafaf9;border:1px solid #f1f2f4;border-radius:12px;padding:18px 34px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${INK}">${esc(code)}</div>
  </td></tr>`;
}

export function Button(label: string, url: string): string {
  return `<tr><td class="pad" align="left" style="padding:24px 44px 0">
    <table border="0" cellspacing="0" cellpadding="0"><tr>
      <td align="center" bgcolor="${BRAND}" style="border-radius:9999px">
        <a href="${esc(url)}" target="_blank" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#fff;text-decoration:none;font-family:${FONT}">${esc(label)}</a>
      </td>
    </tr></table>
  </td></tr>`;
}

/** Small grey print under the call to action. */
export function Note(html: string): string {
  return `<tr><td class="pad" style="padding:18px 44px 0">
    <p style="margin:0;color:#6b7280;font-size:13px;line-height:20px;font-family:${FONT}">${html}</p>
  </td></tr>`;
}

export function Footer(): string {
  return `<tr><td class="pad" style="padding:32px 44px 36px;margin-top:24px;border-top:1px solid #f1f2f4;background:#fafaf9">
    <a href="${SITE()}" style="color:${INK};text-decoration:none;font-weight:600;font-size:15px;font-family:${FONT}">Find pet services near you &rarr;</a>
    <p style="margin:14px 0 10px;font-size:13px;color:#6b7280;line-height:20px;font-family:${FONT}">
      Questions? Reply to this email or message us on
      <a href="https://wa.me/919930090487" style="color:${BRAND};text-decoration:none;font-weight:600">WhatsApp</a>.
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:18px;font-family:${FONT}">
      &copy; ${new Date().getFullYear()} Pets24x7.<br>
      You received this because this address is used on ${esc(SITE())}.
    </p>
  </td></tr>`;
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
    parts.preheader,
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
