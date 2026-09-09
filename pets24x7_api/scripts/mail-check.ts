// Verifies the SMTP relay in .env accepts our credentials, and optionally sends
// one real test message.
//
//   npm run mail:check                 → handshake + auth only, sends nothing
//   npm run mail:check you@example.com → also sends a live test email
//
// Exits non-zero when the relay is unreachable or rejects the login, so a
// deploy can gate on it.

import nodemailer from 'nodemailer';

import { env } from '../src/env.js';
import { sendMail } from '../src/mail/mailer.js';
import { MAIL_CATALOG } from '../src/mail/catalog.js';

async function main(): Promise<void> {
  if (!env.SMTP_USER || !env.SMTP_PASS) {
    console.error('SMTP_USER / SMTP_PASS are not set — mail is disabled.');
    process.exit(1);
  }
  console.log(`relay   ${env.SMTP_HOST}:${env.SMTP_PORT} (secure=${env.SMTP_SECURE})`);
  console.log(`user    ${env.SMTP_USER}`);
  console.log(`from    ${env.MAIL_FROM}`);
  console.log(`catalog ${MAIL_CATALOG.length} templates`);

  const tx = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await tx.verify();
  console.log('\nSMTP handshake + auth OK');

  const to = process.argv[2];
  if (!to) {
    console.log('No recipient given — nothing sent. Pass an address to send a live test.');
    return;
  }
  const entry = MAIL_CATALOG.find((e) => e.id === 'custom')!;
  const ok = await sendMail({
    ...entry.build(to, {
      subject: 'Pets24x7 SMTP test',
      heading: 'SMTP is working',
      message: `Sent from ${env.SMTP_HOST} at ${new Date().toISOString()}.\n\nIf you can read this, transactional email is configured correctly.`,
    }),
    kind: 'transactional',
    force: true,
  });
  console.log(ok ? `test email sent to ${to}` : `send failed for ${to} — see the log above`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('\nSMTP check failed:', err?.message ?? err);
  process.exit(1);
});
