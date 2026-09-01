import type { Request, Response, NextFunction } from 'express';
import { verifyToken, readAuthCookie, clearAuthCookie, type ActorRole, type AuthPayload } from './jwt.js';
import { resolveActor, type Actor } from './actor.js';
import { UnauthorizedError, ForbiddenError } from '../shared/errors.js';

declare global {
  namespace Express {
    interface Request {
      // populated by requireAuth / optionalAuth
      auth?: AuthPayload;
      // the live account row behind that token (requireAuth / requireAnyAuth)
      actor?: Actor;
    }
  }
}

function pickToken(req: Request, role: ActorRole): string | undefined {
  // Prefer Authorization: Bearer <jwt> (for cross-origin XHR), fall back to cookie.
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return readAuthCookie(req.cookies ?? {}, role);
}

/**
 * Turns a failed actor lookup into the right HTTP error. A dead token also has
 * its cookie cleared, so the browser stops replaying it on every request.
 */
function rejection(res: Response, role: ActorRole, reason: 'unknown' | 'revoked' | 'suspended' | 'rejected') {
  if (reason === 'suspended') {
    return new ForbiddenError('This business account is suspended. Contact support@pets24x7.com.');
  }
  if (reason === 'rejected') {
    return new ForbiddenError('This listing claim was not approved.');
  }
  clearAuthCookie(res, role);
  return new UnauthorizedError(reason === 'revoked' ? 'Session ended — please sign in again' : 'Invalid or expired token');
}

export function requireAuth(role: ActorRole) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = pickToken(req, role);
    if (!token) return next(new UnauthorizedError());
    const payload = verifyToken(token);
    if (!payload) return next(new UnauthorizedError('Invalid or expired token'));
    if (payload.role !== role) return next(new ForbiddenError());

    // The signature is valid, but the account behind it may since have been
    // deleted, suspended, or signed out everywhere.
    try {
      const result = await resolveActor(payload);
      if (!result.ok) return next(rejection(res, role, result.reason));
      req.auth = payload;
      req.actor = result.actor;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Non-blocking: if a valid token for `role` is present, populate req.auth.
// Never throws — used by public endpoints that behave better when they know
// who the caller is (e.g. attach an enquiry to a signed-in pet parent).
export function optionalAuth(role: ActorRole) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = pickToken(req, role);
    if (!token) return next();
    const payload = verifyToken(token);
    if (!payload || payload.role !== role) return next();
    try {
      const result = await resolveActor(payload);
      if (result.ok) {
        req.auth = payload;
        req.actor = result.actor;
      }
    } catch {
      // Anonymous is a valid outcome here — never fail the request over it.
    }
    next();
  };
}

export function requireAnyAuth(roles: ActorRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let lastReason: 'unknown' | 'revoked' | 'suspended' | 'rejected' | null = null;
    let lastRole: ActorRole | null = null;

    for (const r of roles) {
      const token = pickToken(req, r);
      if (!token) continue;
      const payload = verifyToken(token);
      if (!payload || payload.role !== r) continue;
      try {
        const result = await resolveActor(payload);
        if (result.ok) {
          req.auth = payload;
          req.actor = result.actor;
          return next();
        }
        lastReason = result.reason;
        lastRole = r;
      } catch (err) {
        return next(err);
      }
    }

    // A suspended account presented the only usable cookie: say so, rather than
    // a bare 401 that reads as "not signed in".
    if (lastReason && lastRole) return next(rejection(res, lastRole, lastReason));
    next(new UnauthorizedError());
  };
}
