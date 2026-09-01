// Renders every template in the catalogue with its sample data.
//
//   npx tsx scripts/mail-preview.ts            → writes HTML files to .mail-preview/
//   npx tsx scripts/mail-preview.ts --send     → also emails them to SMTP_USER
//
// Driven by src/mail/catalog.ts, the same source the admin console reads, so a
// newly added template is covered here the moment it is registered.

import fs from 'node:fs';
import path from 'node:path';

import { env } from '../src/env.js';
import { sendMail } from '../src/mail/mailer.js';
import { MAIL_CATALOG } from '../src/mail/catalog.js';

const to = env.SMTP_USER || 'preview@example.com';
const outDir = path.resolve('.mail-preview');
fs.mkdirSync(outDir, { recursive: true });

const send = process.argv.includes('--send');
let i = 0;
let failed = 0;

for (const entry of MAIL_CATALOG) {
  i += 1;
  let mail;
  try {
    mail = entry.build(to, entry.sample as Record<string, any>);
  } catch (err: any) {
    failed += 1;
    console.log('FAILED ', entry.id, '-', String(err?.message ?? err));
    continue;
  }

  const slug = `${String(i).padStart(2, '0')}-${entry.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`;
  fs.writeFileSync(path.join(outDir, slug), mail.html);

  if (send) {
    const ok = await sendMail({ ...mail, subject: `[preview] ${mail.subject}` });
    if (!ok) failed += 1;
    console.log(ok ? 'sent   ' : 'FAILED ', entry.id, '-', mail.subject);
  } else {
    console.log('render ', entry.id.padEnd(32), mail.subject);
  }
}

console.log(`\n${MAIL_CATALOG.length} templates → ${outDir}${failed ? ` (${failed} failed)` : ''}`);
process.exit(failed ? 1 : 0);
