import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Wraps an async route handler so thrown errors reach the central error middleware
// instead of becoming an unhandled promise rejection.
export const asyncHandler =
  <Req extends Request = Request, Res extends Response = Response>(
    fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    fn(req as Req, res as Res, next).catch(next);
  };
