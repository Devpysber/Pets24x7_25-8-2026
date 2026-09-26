// Renders every template in the catalogue with its sample data.
//
//   npx tsx scripts/mail-preview.ts            → writes HTML + text files to .mail-preview/
//   npx tsx scripts/mail-preview.ts --send     → also emails them to SMTP_USER
//
// Driven by src/mail/catalog.ts, the same source the admin console reads, so a
// newly added template is covered here the moment it is registered.
//
// Each render is also linted: a leaked "undefined"/"NaN"/"[object Object]", a
// double-escaped entity, a relative or empty link, an own-site link without
// UTM tags or to a page that does not exist in pets24x7_new/, an image with no
// alt text, a missing preheader or a marketing mail with no unsubscribe link
// fails the run, so a broken template is caught before anyone receives it.
//
// Marketing mail is rendered with the unsubscribe line sendMail adds, so the
// files on disk are what a recipient actually gets. Without --send nothing is
// sent: the SMTP transport is never touched.

import fs from 'node:fs';
import path from 'node:path';

import { env } from '../src/env.js';
import { sendMail, withUnsubscribeFooter, withUnsubscribeText } from '../src/mail/mailer.js';
import { MAIL_CATALOG } from '../src/mail/catalog.js';
import { mailSite, withTracking } from '../src/mail/components.js';
import { unsubscribeUrl } from '../src/mail/optout.js';

const send = process.argv.includes('--send');
// Render with a placeholder address unless actually sending, so the preview
// files on disk never carry a real inbox.
const to = send && env.SMTP_USER ? env.SMTP_USER : 'preview@example.com';
const outDir = path.resolve('.mail-preview');
fs.mkdirSync(outDir, { recursive: true });
// Clear the previous run's renders: numbering shifts when the catalogue
// changes, and a stale file would otherwise sit next to its replacement.
for (const f of fs.readdirSync(outDir)) {
  if (/^\d+-.+\.(html|txt)$/.test(f)) fs.rmSync(path.join(outDir, f));
}

let i = 0;
let failed = 0;
let warned = 0;

/**
 * Static site the links must land on. Dashboard ?view= targets are checked
 * against the view-<id> panes in each dashboard. Generated city/listing pages
 * (/in/..., /us/...) are built by build_pages.py and not checked here.
 */
const siteRoot = path.resolve('..', 'pets24x7_new');
const hasSite = fs.existsSync(siteRoot);
const viewCache = new Map<string, Set<string>>();
function dashboardViews(role: string): Set<string> {
  let views = viewCache.get(role);
  if (!views) {
    const file = path.join(siteRoot, 'dashboard', role, 'index.html');
    const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    views = new Set([...src.matchAll(/id="view-([a-z-]+)"/g)].map((m) => m[1]!));
    viewCache.set(role, views);
  }
  return views;
}

/** Why an own-site link would 404 or land on the wrong pane, or null when it is fine. */
function deadLink(href: string): string | null {
  if (!hasSite) return null;
  const u = new URL(href);
  const p = decodeURIComponent(u.pathname);
  if (/^\/(in|us)\//.test(p) || p.startsWith('/api/') || p.startsWith('/r/')) return null;
  const file = p.endsWith('/') ? path.join(siteRoot, p, 'index.html') : path.join(siteRoot, p);
  if (!fs.existsSync(file)) return `dead link: ${p}`;
  const dash = /^\/dashboard\/(parent|vendor|admin)\/$/.exec(p);
  const view = u.searchParams.get('view');
  if (dash && view && !dashboardViews(dash[1]!).has(view)) return `unknown dashboard view: ${p}?view=${view}`;
  return null;
}

function lint(html: string, text: string, subject: string, marketing: boolean): string[] {
  const problems: string[] = [];
  const visible = `${subject}\n${text}\n${html.replace(/<[^>]+>/g, ' ')}`;
  for (const bad of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
    if (visible.includes(bad)) problems.push(`contains "${bad}"`);
  }
  if (/&amp;(amp|lt|gt|quot|#39);/.test(html)) problems.push('double-escaped entity');
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1]!.replace(/&amp;/g, '&');
    if (!/^(https?:|mailto:|tel:)/.test(href)) problems.push(`non-absolute link: ${href || '(empty)'}`);
    else if (href.startsWith(mailSite())) {
      if (!/utm_source=/.test(href) && !/token=/.test(href)) problems.push(`untracked site link: ${href}`);
      const dead = deadLink(href);
      if (dead) problems.push(dead);
    }
  }
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt="/.test(m[0])) problems.push('image without alt text');
  }
  if (!/display:none;max-height:0/.test(html)) problems.push('no preheader');
  if (marketing && !/unsubscribe/i.test(html)) problems.push('marketing mail without an unsubscribe link');
  if (!text.trim()) problems.push('empty plaintext part');
  return [...new Set(problems)];
}

for (const entry of MAIL_CATALOG) {
  i += 1;
  // Classified the way the admin console sends it (admin/mail.routes.ts): the
  // free-form 'custom' mail carries no kind of its own and goes out as
  // marketing, with the unsubscribe line this render must show too.
  const kind = entry.kind ?? 'marketing';
  let mail;
  try {
    mail = withTracking({ ...entry.build(to, entry.sample as Record<string, any>), kind });
    const unsub = mail.kind === 'marketing' ? unsubscribeUrl(to) : null;
    mail = { ...mail, html: withUnsubscribeFooter(mail.html, unsub), text: withUnsubscribeText(mail.text, unsub) };
  } catch (err: any) {
    failed += 1;
    console.log('FAILED ', entry.id, '-', String(err?.message ?? err));
    continue;
  }

  const slug = `${String(i).padStart(2, '0')}-${entry.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  fs.writeFileSync(path.join(outDir, `${slug}.html`), mail.html);
  fs.writeFileSync(path.join(outDir, `${slug}.txt`), `Subject: ${mail.subject}\n\n${mail.text}`);

  const problems = lint(mail.html, mail.text, mail.subject, mail.kind === 'marketing');
  if (problems.length) {
    warned += 1;
    console.log('LINT   ', entry.id, '-', problems.join('; '));
  }

  if (send) {
    // Built again from the catalogue: sendMail adds the unsubscribe line itself.
    const ok = await sendMail({ ...withTracking({ ...entry.build(to, entry.sample as Record<string, any>), kind }), subject: `[preview] ${mail.subject}` });
    if (!ok) failed += 1;
    console.log(ok ? 'sent   ' : 'FAILED ', entry.id, '-', mail.subject);
  } else {
    console.log('render ', entry.id.padEnd(34), mail.subject);
  }
}

console.log(
  `\n${MAIL_CATALOG.length} templates → ${outDir}` +
    `${failed ? ` (${failed} failed)` : ''}${warned ? ` (${warned} with lint problems)` : ''}`,
);
process.exit(failed || warned ? 1 : 0);
