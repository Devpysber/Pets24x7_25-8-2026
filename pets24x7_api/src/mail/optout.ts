// Email suppression + unsubscribe-token helpers.
//
// Two classes of mail exist:
//   • transactional — a direct consequence of something the recipient did
//     (OTP, verification, receipt, enquiry ack). Always sent, never suppressed.
//   • marketing     — recommendations, admin broadcasts, nudges. Suppressed for
//     any address on the opt-out list, and carries an unsubscribe link plus
//     RFC 8058 List-Unsubscribe headers.
//
// The unsubscribe link is a keyed HMAC of the address, so the link works with
// no session and cannot be forged to unsubscribe someone else's address.

import crypto from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';

export type MailKind = 'transactional' | 'marketing';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Stable, non-expiring token — an unsubscribe link must work months later. */
export function unsubscribeToken(email: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`unsub:${normalizeEmail(email)}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = unsubscribeToken(email);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function unsubscribeUrl(email: string): string {
  const e = encodeURIComponent(normalizeEmail(email));
  return `${env.PUBLIC_API_URL}/api/email/unsubscribe?e=${e}&t=${unsubscribeToken(email)}`;
}

export async function isOptedOut(email: string): Promise<boolean> {
  const row = await prisma.emailOptOut.findUnique({
    where: { email: normalizeEmail(email) },
    select: { id: true },
  });
  return Boolean(row);
}

export async function optOut(email: string, source = 'unsubscribe_link'): Promise<void> {
  const e = normalizeEmail(email);
  await prisma.emailOptOut.upsert({
    where: { email: e },
    create: { email: e, source },
    update: {},
  });
}

export async function optIn(email: string): Promise<void> {
  await prisma.emailOptOut.deleteMany({ where: { email: normalizeEmail(email) } });
}
