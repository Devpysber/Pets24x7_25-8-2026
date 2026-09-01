// Email verification tokens + the two parent-facing mails.
//
// A token is 32 random bytes, base64url-encoded. Only its SHA-256 hash is
// persisted, so the DB never holds a usable link. Consuming a token marks it
// used and invalidates every other outstanding token for that parent, which is
// what makes a link "expire instantly" once clicked.

import crypto from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { sendMail } from '../mail/mailer.js';
import { verifyEmail, welcomeEmail } from '../mail/templates.js';

export const VERIFY_TTL_MIN = env.EMAIL_VERIFY_TTL_MIN;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function verifyLink(token: string): string {
  return `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/parent/email/verify?token=${encodeURIComponent(token)}`;
}

/** Issues a fresh token, voiding any earlier unused ones, and mails the link. */
export async function sendVerificationEmail(parent: { id: string; name: string; email: string }): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.emailVerificationToken.create({
      data: {
        parentId: parent.id,
        email: parent.email,
        tokenHash: hash(token),
        expiresAt: new Date(now.getTime() + VERIFY_TTL_MIN * 60_000),
      },
    }),
  ]);

  await sendMail(verifyEmail(parent.email, parent.name, verifyLink(token), VERIFY_TTL_MIN));
}

export type ConsumeResult =
  | { ok: true; parentId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/** Validates and burns a token. Single use; expiry is enforced server-side. */
export async function consumeVerificationToken(token: string): Promise<ConsumeResult> {
  const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.usedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    // Any sibling token is void too — one click retires the whole batch.
    prisma.emailVerificationToken.updateMany({
      where: { parentId: row.parentId, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.petParent.update({
      where: { id: row.parentId },
      data: { emailVerified: true, emailVerifiedAt: now, email: row.email },
    }),
  ]);

  return { ok: true, parentId: row.parentId };
}

/** Sends the welcome mail at most once per parent. */
/** Returns true when this call actually sent the welcome mail (first time). */
export async function sendWelcomeEmailOnce(parent: { id: string; name: string; email: string | null; welcomeEmailAt: Date | null }): Promise<boolean> {
  if (!parent.email || parent.welcomeEmailAt) return false;

  const sent = await sendMail(welcomeEmail(parent.email, parent.name));
  if (!sent) return false; // leave the flag unset so a later attempt can retry
  await prisma.petParent.update({ where: { id: parent.id }, data: { welcomeEmailAt: new Date() } });
  return true;
}
