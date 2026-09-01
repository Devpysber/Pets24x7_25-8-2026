// Account mails: welcome, and the one-time email-verification link.
// Everything else lives in action-templates.ts.

import { env } from '../env.js';
import type { MailInput } from './mailer.js';
import { Button, Note, Text, esc, h, page } from './components.js';

export { BRAND, esc as escapeHtml } from './components.js';

export function welcomeEmail(to: string, name: string): MailInput {
  const dash = `${env.PUBLIC_SITE_URL}/dashboard/parent/`;
  return {
    to,
    subject: 'Welcome to Pets24x7 🐾',
    html: page({
      eyebrow: 'Account',
      banner: ['Account ready', 'success'],
      heading: `Welcome, ${name}!`,
      intro: h`Your Pets24x7 account is ready. Find vets, groomers, boarding, trainers and pet shops near you — and keep your pets' profiles in one place.`,
      blocks: [
        Text('Add your first pet to get recommendations tailored to them.'),
        Button('Open my dashboard', dash),
      ],
      preheader: 'Your Pets24x7 account is ready.',
    }),
    text: `Welcome to Pets24x7, ${name}!\n\nYour account is ready. Open your dashboard: ${dash}\n`,
  };
}

export function verifyEmail(to: string, name: string, link: string, ttlMinutes: number): MailInput {
  return {
    to,
    subject: 'Verify your Pets24x7 email',
    html: page({
      eyebrow: 'Security',
      heading: `Confirm your email, ${name}`,
      intro: 'Click the button to verify this address and finish setting up your Pets24x7 account.',
      blocks: [
        Button('Verify my email', link),
        Note(`This link works once and expires in ${ttlMinutes} minutes.`),
        Note(`If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${esc(link)}</span>`),
      ],
      preheader: `Verify your email — link expires in ${ttlMinutes} minutes.`,
    }),
    text: `Hi ${name},\n\nVerify your Pets24x7 email: ${link}\n\nThis link works once and expires in ${ttlMinutes} minutes.\n`,
  };
}

/**
 * Vendor twin of verifyEmail. Addressed to the business, and points at the
 * vendor dashboard rather than a pet-parent account.
 */
export function vendorVerifyEmail(to: string, businessName: string, link: string, ttlMinutes: number): MailInput {
  return {
    to,
    subject: 'Verify your Pets24x7 business email',
    html: page({
      eyebrow: 'Security',
      heading: `Confirm this email for ${businessName}`,
      intro:
        'Click the button to confirm this address. Once verified, it is where enquiry alerts, payment receipts and review notifications for your listing are sent.',
      blocks: [
        Button('Verify this address', link),
        Note(`This link works once and expires in ${ttlMinutes} minutes.`),
        Note(`If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${esc(link)}</span>`),
        Note("If you didn't add this address to a Pets24x7 business listing, ignore this email — nothing changes until the link is clicked."),
      ],
      preheader: `Verify your business email — link expires in ${ttlMinutes} minutes.`,
    }),
    text:
      `Hi ${businessName},\n\nVerify this email for your Pets24x7 listing: ${link}\n\n` +
      `This link works once and expires in ${ttlMinutes} minutes.\n`,
  };
}
