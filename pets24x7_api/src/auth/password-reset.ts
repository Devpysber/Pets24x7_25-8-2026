// Password-reset tokens.
//
// Same rules as email verification (src/auth/email-verification.ts): 32 random
// bytes base64url-encoded, only the SHA-256 hash persisted, issuing a new token
// voids every outstanding one, and consuming a token marks it used. A reset
// link therefore stops working the moment it is used or superseded.
//
// The link points at the static site rather than the API, because the person
// clicking it has to type a new password before anything is applied.

import crypto from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { sendMail } from '../mail/mailer.js';
import { passwordResetEmail } from '../mail/lifecycle-templates.js';

export const RESET_TTL_MIN = 30;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function resetLink(token: string): string {
  return `${env.PUBLIC_SITE_URL.replace(/\/+$/, '')}/reset/?token=${encodeURIComponent(token)}`;
}

/** Issues a fresh token, voids earlier ones, and mails the link. */
export async function sendPasswordResetEmail(parent: { id: string; name: string; email: string }): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { parentId: parent.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        parentId: parent.id,
        tokenHash: hash(token),
        expiresAt: new Date(now.getTime() + RESET_TTL_MIN * 60_000),
      },
    }),
  ]);

  await sendMail({
    ...passwordResetEmail(parent.email, parent.name, resetLink(token), RESET_TTL_MIN),
    // The link is the credential, so it must not reach the logs.
    sensitive: true,
  });
}

export type ResetConsumeResult =
  | { ok: true; parentId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/**
 * Validates and burns a token. Returns the parent it belongs to; the caller
 * writes the new password hash.
 */
export async function consumeResetToken(token: string): Promise<ResetConsumeResult> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.usedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const now = new Date();
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.passwordResetToken.updateMany({
      where: { parentId: row.parentId, usedAt: null },
      data: { usedAt: now },
    }),
  ]);

  return { ok: true, parentId: row.parentId };
}
