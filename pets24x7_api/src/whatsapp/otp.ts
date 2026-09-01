// OTP issue + verify, backed by the OtpCode table.
// - 6-digit numeric, expires in 10 minutes
// - Max 5 attempts per code
// - Resend cool-down of 60 seconds enforced at the route layer
// - Code is stored hashed; we compare via timingSafeEqual

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { sendOtpTemplate } from './cloud-api.js';
import { TooManyRequestsError, BadRequestError } from '../shared/errors.js';
import type { OtpPurpose } from '@prisma/client';
import { normalizePhone } from '../shared/phone.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function issueOtp(rawPhone: string, purpose: OtpPurpose, ctx: { ip?: string; ua?: string } = {}) {
  const phone = normalizePhone(rawPhone);

  // Rate-limit by phone+purpose at the DB layer.
  const last = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new TooManyRequestsError('Please wait a minute before requesting another OTP');
  }

  // Invalidate any earlier unconsumed codes for this (phone, purpose) so only
  // the latest one can succeed — clean UX, no race conditions.
  await prisma.otpCode.updateMany({
    where: { phone, purpose, consumedAt: null },
    data: { consumedAt: new Date(0) },
  });

  const code = randomInt(100_000, 1_000_000).toString();
  await prisma.otpCode.create({
    data: {
      phone,
      code: hash(code),
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      ipAddress: ctx.ip,
      userAgent: ctx.ua?.slice(0, 250),
    },
  });

  await sendOtpTemplate(phone, code);
  return { phone };
}

export async function verifyOtp(rawPhone: string, code: string, purpose: OtpPurpose): Promise<boolean> {
  const phone = normalizePhone(rawPhone);
  const rec = await prisma.otpCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) throw new BadRequestError('No active code — please request a new OTP');
  if (rec.expiresAt < new Date()) throw new BadRequestError('OTP expired — please request a new one');
  if (rec.attempts >= MAX_ATTEMPTS) throw new TooManyRequestsError('Too many attempts — request a new OTP');

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
