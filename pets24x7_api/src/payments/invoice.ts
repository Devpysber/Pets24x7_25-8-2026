// Printable tax invoice for a completed payment.
//
// Rendered server-side as a standalone HTML page rather than a PDF: it opens in
// a tab, prints to PDF from the browser, and needs no PDF toolchain on the box.
// The mail links here, so the invoice is always the live record rather than a
// copy frozen at send time.

import { env } from '../env.js';
import { esc, money } from '../mail/components.js';

export interface InvoiceLine {
  description: string;
  amountMinor: number;
}

export interface InvoiceData {
  /** Our merchant transaction id — doubles as the invoice number. */
  merchantTxnId: string;
  issuedAt: Date;
  gatewayTxnId: string | null;
  currency: string;
  billTo: { name: string; email: string | null; phone: string | null; city: string | null };
  lines: InvoiceLine[];
  totalMinor: number;
  /** Free-text note under the totals — plan validity, say. */
  footnote?: string;
}

const SELLER = {
  name: 'Pets24x7',
  line1: 'Pets24x7 Online Services',
  site: 'pets24x7.com',
  email: 'support@pets24x7.com',
};

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Invoice number derived from the txn id, so it is stable across re-renders. */
export function invoiceNumber(merchantTxnId: string): string {
  return `INV-${merchantTxnId.replace(/^P24_/, '')}`;
}

export function invoiceUrl(merchantTxnId: string): string {
  const api = env.PUBLIC_API_URL.replace(/\/+$/, '');
  return `${api}/api/memberships/invoice/${encodeURIComponent(merchantTxnId)}`;
}

export function renderInvoice(d: InvoiceData): string {
  const rows = d.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="num">${esc(money(l.amountMinor, d.currency))}</td></tr>`,
    )
    .join('');

  const billLines = [d.billTo.email, d.billTo.phone, d.billTo.city].filter(Boolean) as string[];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(invoiceNumber(d.merchantTxnId))} · Pets24x7</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f3f4f6; font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#111827; }
  .sheet { max-width:760px; margin:24px auto; background:#fff; padding:40px; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 2px; }
  .muted { color:#6b7280; }
  .top { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; border-bottom:2px solid #ff6b35; padding-bottom:18px; margin-bottom:24px; }
  .meta { text-align:right; }
  .grid { display:flex; gap:32px; flex-wrap:wrap; margin-bottom:26px; }
  .grid > div { flex:1 1 220px; }
  .label { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#6b7280; font-weight:700; margin-bottom:4px; }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  th, td { padding:10px 8px; border-bottom:1px solid #e5e7eb; text-align:left; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#6b7280; }
  .num { text-align:right; white-space:nowrap; }
  .total td { border-bottom:none; border-top:2px solid #111827; font-weight:700; font-size:16px; }
  .paid { display:inline-block; margin-top:18px; padding:5px 12px; border-radius:20px; background:#dcfce7; color:#166534; font-weight:700; font-size:12px; }
  .foot { margin-top:28px; padding-top:16px; border-top:1px solid #e5e7eb; font-size:12px; color:#6b7280; }
  .print { margin:0 auto 24px; max-width:760px; text-align:right; }
  .print button { font:inherit; font-weight:600; padding:8px 16px; border-radius:6px; border:1px solid #d1d5db; background:#fff; cursor:pointer; }
  @media print { body { background:#fff; } .sheet { box-shadow:none; margin:0; padding:0; } .print { display:none; } }
</style></head>
<body>
<div class="print"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">
  <div class="top">
    <div>
      <h1>${esc(SELLER.name)}</h1>
      <div class="muted">${esc(SELLER.line1)}<br>${esc(SELLER.site)} · ${esc(SELLER.email)}</div>
    </div>
    <div class="meta">
      <div class="label">Tax invoice</div>
      <div style="font-weight:700">${esc(invoiceNumber(d.merchantTxnId))}</div>
      <div class="muted">${esc(fmtDate(d.issuedAt))}</div>
    </div>
  </div>

  <div class="grid">
    <div>
      <div class="label">Billed to</div>
      <div style="font-weight:600">${esc(d.billTo.name)}</div>
      <div class="muted">${billLines.map((l) => esc(l)).join('<br>')}</div>
    </div>
    <div>
      <div class="label">Payment reference</div>
      <div>${esc(d.merchantTxnId)}</div>
      ${d.gatewayTxnId ? `<div class="muted">Gateway: ${esc(d.gatewayTxnId)}</div>` : ''}
    </div>
  </div>

  <table>
    <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="total"><td>Total paid</td><td class="num">${esc(money(d.totalMinor, d.currency))}</td></tr>
    </tbody>
  </table>

  <div class="paid">● Paid</div>
  ${d.footnote ? `<p class="muted" style="margin-top:18px">${esc(d.footnote)}</p>` : ''}

  <div class="foot">
    Amounts are in ${esc(d.currency)} and inclusive of applicable taxes.
    This is a computer-generated invoice and needs no signature.
    Questions? Reply to your confirmation email or write to ${esc(SELLER.email)}.
  </div>
</div>
</body></html>`;
}
