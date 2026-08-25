import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '../env.js';

export type ActorRole = 'pet_parent' | 'vendor' | 'admin';

export interface AuthPayload {
  sub: string;          // user id
  role: ActorRole;
  iat?: number;
  exp?: number;
}

const ACCESS_TTL = '30d';
const COOKIE_NAME_BY_ROLE: Record<ActorRole, string> = {
  pet_parent: 'p24_parent',
  vendor:     'p24_vendor',
  admin:      'p24_admin',
};

export function signToken(payload: AuthPayload): string {
  return jwt.sign({ sub: payload.sub, role: payload.role }, env.JWT_SECRET, {
    issuer: env.JWT_ISSUER,
    expiresIn: ACCESS_TTL,
  });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: env.JWT_ISSUER });
    if (typeof decoded === 'string') return null;
    const role = decoded.role as ActorRole;
    if (!role || !decoded.sub) return null;
    return { sub: String(decoded.sub), role };
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, payload: AuthPayload): void {
  const token = signToken(payload);
  res.cookie(COOKIE_NAME_BY_ROLE[payload.role], token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response, role: ActorRole): void {
  res.clearCookie(COOKIE_NAME_BY_ROLE[role], {
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  });
}

export function readAuthCookie(cookies: Record<string, string>, role: ActorRole): string | undefined {
  return cookies[COOKIE_NAME_BY_ROLE[role]];
}
