// Email OTP — issue + verify a 6-digit code delivered by email.
//
// Mirrors the WhatsApp OTP module (../whatsapp/otp.ts) but keys the OtpCode
// row on `email` instead of `phone`, so one table serves both channels.
//
// - 6-digit numeric, expires in 10 minutes
// - Max 5 attempts per code
// - 60-second resend cool-down enforced at the DB layer
// - Only the SHA-256 hash is stored; comparison is timing-safe

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { notify } from '../mail/notify.js';
import { loginCodeEmail } from '../mail/action-templates.js';
import { TooManyRequestsError, BadRequestError } from '../shared/errors.js';
import type { OtpPurpose } from '@prisma/client';

export const EMAIL_OTP_TTL_MIN = 10;

const OTP_TTL_MS = EMAIL_OTP_TTL_MIN * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

export type EmailOtpPurpose = 'EMAIL_LOGIN_PARENT' | 'EMAIL_LOGIN_VENDOR' | 'EMAIL_LOGIN_ADMIN';

export function normEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Creates a fresh code for (email, purpose) and mails it. Any earlier
 * unconsumed code for the same pair is invalidated, so only the newest one can
 * ever succeed.
 *
 * Returns the code itself ONLY in development, where SMTP is usually unset and
 * the login flow would otherwise be unusable offline.
 */
export async function issueEmailOtp(
  rawEmail: string,
  purpose: EmailOtpPurpose,
  ctx: { name?: string | null; ip?: string | undefined; ua?: string | undefined } = {},
): Promise<{ email: string; devCode?: string }> {
  const email = normEmail(rawEmail);

  const last = await prisma.otpCode.findFirst({
    where: { email, purpose: purpose as OtpPurpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new TooManyRequestsError('Please wait a minute before requesting another code');
  }

  await prisma.otpCode.updateMany({
    where: { email, purpose: purpose as OtpPurpose, consumedAt: null },
    data: { consumedAt: new Date(0) },
  });

  const code = randomInt(100_000, 1_000_000).toString();
  await prisma.otpCode.create({
    data: {
      email,
      code: hash(code),
      purpose: purpose as OtpPurpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipAddress: ctx.ip ?? null,
      userAgent: ctx.ua?.slice(0, 250) ?? null,
    },
  });

  // Login codes are transactional and must ignore marketing opt-out, so they
  // go through notify() rather than notifyIf().
  notify(loginCodeEmail(email, ctx.name ?? null, code, EMAIL_OTP_TTL_MIN));

  const isDev = env.NODE_ENV === 'development';
  if (isDev) {
    logger.info({ email, purpose, code }, 'dev email OTP issued');
    return { email, devCode: code };
  }
  return { email };
}

/**
 * Burns the newest unconsumed code for (email, purpose). Returns false on a
 * wrong code (and counts the attempt); throws when there is nothing to verify
 * against, so the caller can tell "wrong code" from "ask for a new one".
 */
export async function verifyEmailOtp(
  rawEmail: string,
  code: string,
  purpose: EmailOtpPurpose,
): Promise<boolean> {
  const email = normEmail(rawEmail);
  const rec = await prisma.otpCode.findFirst({
    where: { email, purpose: purpose as OtpPurpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) throw new BadRequestError('No active code — please request a new one');
  if (rec.expiresAt < new Date()) throw new BadRequestError('Code expired — please request a new one');
  if (rec.attempts >= MAX_ATTEMPTS) throw new TooManyRequestsError('Too many attempts — request a new code');

  const incoming = Buffer.from(hash(code));
  const stored = Buffer.from(rec.code);
  const ok = incoming.length === stored.length && timingSafeEqual(incoming, stored);

  if (!ok) {
    await prisma.otpCode.update({ where: { id: rec.id }, data: { attempts: { increment: 1 } } });
    return false;
  }

  await prisma.otpCode.update({ where: { id: rec.id }, data: { consumedAt: new Date() } });
  return true;
}
