// Loads the account behind a verified JWT and decides whether it may still act.
//
// A signed token only proves who issued it and when. It says nothing about
// whether the account still exists, was suspended by an admin, or signed out
// everywhere — all of which can happen inside the 30-day token lifetime. Every
// authenticated request therefore resolves the actor against the database.

import { prisma } from '../db.js';
import type { ActorRole, AuthPayload } from './jwt.js';

export interface Actor {
  id: string;
  role: ActorRole;
  /** Display label for logs and audit rows. */
  name: string;
  /** Vendors only. */
  status?: string;
}

export type ActorResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: 'unknown' | 'revoked' | 'suspended' | 'rejected' };

/**
 * A token minted before `sessionsRevokedAt` is dead. `iat` is whole seconds, so
 * a token issued in the same second as the revocation is treated as revoked
 * rather than accepted — erring towards logging someone out.
 */
function tokenRevoked(payload: AuthPayload, revokedAt: Date | null | undefined): boolean {
  if (!revokedAt) return false;
  if (!payload.iat) return true; // no issue time to compare — refuse it
  return payload.iat * 1000 <= revokedAt.getTime();
}

export async function resolveActor(payload: AuthPayload): Promise<ActorResult> {
  if (payload.role === 'pet_parent') {
    const p = await prisma.petParent.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, sessionsRevokedAt: true },
    });
    if (!p) return { ok: false, reason: 'unknown' };
    if (tokenRevoked(payload, p.sessionsRevokedAt)) return { ok: false, reason: 'revoked' };
    return { ok: true, actor: { id: p.id, role: 'pet_parent', name: p.name } };
  }

  if (payload.role === 'vendor') {
    const v = await prisma.vendor.findUnique({
      where: { id: payload.sub },
      select: { id: true, businessName: true, status: true, sessionsRevokedAt: true },
    });
    if (!v) return { ok: false, reason: 'unknown' };
    // Status is checked before revocation: disabling an account also revokes
    // its sessions, and "your account is suspended" is the useful half of that.
    // PENDING is allowed — the claim is awaiting admin review and the vendor
    // still needs the dashboard.
    if (v.status === 'SUSPENDED') return { ok: false, reason: 'suspended' };
    if (v.status === 'REJECTED') return { ok: false, reason: 'rejected' };
    if (tokenRevoked(payload, v.sessionsRevokedAt)) return { ok: false, reason: 'revoked' };
    return { ok: true, actor: { id: v.id, role: 'vendor', name: v.businessName, status: v.status } };
  }

  const a = await prisma.admin.findUnique({
    where: { id: payload.sub },
    select: { id: true, name: true, sessionsRevokedAt: true },
  });
  if (!a) return { ok: false, reason: 'unknown' };
  if (tokenRevoked(payload, a.sessionsRevokedAt)) return { ok: false, reason: 'revoked' };
  return { ok: true, actor: { id: a.id, role: 'admin', name: a.name } };
}

/** Invalidates every token already issued for one account. */
export async function revokeSessions(role: ActorRole, id: string): Promise<void> {
  const sessionsRevokedAt = new Date();
  if (role === 'pet_parent') {
    await prisma.petParent.update({ where: { id }, data: { sessionsRevokedAt } }).catch(() => {});
    return;
  }
  if (role === 'vendor') {
    await prisma.vendor.update({ where: { id }, data: { sessionsRevokedAt } }).catch(() => {});
    return;
  }
  await prisma.admin.update({ where: { id }, data: { sessionsRevokedAt } }).catch(() => {});
}
