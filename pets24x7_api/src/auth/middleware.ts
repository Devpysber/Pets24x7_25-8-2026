import type { Request, Response, NextFunction } from 'express';
import { verifyToken, readAuthCookie, type ActorRole, type AuthPayload } from './jwt.js';
import { UnauthorizedError, ForbiddenError } from '../shared/errors.js';

declare global {
  namespace Express {
    interface Request {
      // populated by requireAuth / optionalAuth
      auth?: AuthPayload;
    }
  }
}

function pickToken(req: Request, role: ActorRole): string | undefined {
  // Prefer Authorization: Bearer <jwt> (for cross-origin XHR), fall back to cookie.
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return readAuthCookie(req.cookies ?? {}, role);
}

export function requireAuth(role: ActorRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = pickToken(req, role);
    if (!token) return next(new UnauthorizedError());
    const payload = verifyToken(token);
    if (!payload) return next(new UnauthorizedError('Invalid or expired token'));
    if (payload.role !== role) return next(new ForbiddenError());
    req.auth = payload;
    next();
  };
}

export function requireAnyAuth(roles: ActorRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const r of roles) {
      const token = pickToken(req, r);
      if (!token) continue;
      const payload = verifyToken(token);
      if (payload && payload.role === r) {
        req.auth = payload;
        return next();
      }
    }
    next(new UnauthorizedError());
  };
}
