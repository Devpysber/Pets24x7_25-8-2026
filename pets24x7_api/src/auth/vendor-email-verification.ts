// Vendor email verification — the Vendor-side twin of email-verification.ts.
//
// A vendor claims a listing by WhatsApp OTP, so their phone is proven but the
// business email they type into the dashboard is not. Until it is verified we
// still send to it (a vendor who mistyped an address is better served by mail
// bouncing than by silence), but `emailVerified` tells the dashboard and the
// admin panel whether the address can be trusted for anything important.
//
// Same token rules as the parent flow: 32 random bytes, only the SHA-256 hash
// is persisted, single use, and consuming one voids every sibling token.

import crypto from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { sendMail } from '../mail/mailer.js';
import { vendorVerifyEmail } from '../mail/templates.js';

export const VENDOR_VERIFY_TTL_MIN = env.EMAIL_VERIFY_TTL_MIN;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function vendorVerifyLink(token: string): string {
  return `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/vendor/email/verify?token=${encodeURIComponent(token)}`;
}

/** Issues a fresh token, voiding any earlier unused ones, and mails the link. */
export async function sendVendorVerificationEmail(vendor: {
  id: string;
  businessName: string;
  email: string;
}): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await prisma.$transaction([
    prisma.vendorEmailToken.updateMany({
      where: { vendorId: vendor.id, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.vendorEmailToken.create({
      data: {
        vendorId: vendor.id,
        email: vendor.email,
        tokenHash: hash(token),
        expiresAt: new Date(now.getTime() + VENDOR_VERIFY_TTL_MIN * 60_000),
      },
    }),
  ]);

  await sendMail(
    vendorVerifyEmail(vendor.email, vendor.businessName, vendorVerifyLink(token), VENDOR_VERIFY_TTL_MIN),
  );
}

export type VendorConsumeResult =
  | { ok: true; vendorId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/** Validates and burns a token. Single use; expiry enforced server-side. */
export async function consumeVendorVerificationToken(token: string): Promise<VendorConsumeResult> {
  const row = await prisma.vendorEmailToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.usedAt) return { ok: false, reason: 'used' };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const now = new Date();
  await prisma.$transaction([
    prisma.vendorEmailToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.vendorEmailToken.updateMany({
      where: { vendorId: row.vendorId, usedAt: null },
      data: { usedAt: now },
    }),
    // The address on the token wins: it is the one that was actually proven.
    prisma.vendor.update({
      where: { id: row.vendorId },
      data: { emailVerified: true, emailVerifiedAt: now, email: row.email },
    }),
  ]);

  return { ok: true, vendorId: row.vendorId };
}
