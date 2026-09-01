// Typed error classes used across the API.
// Routes throw these; the central error middleware converts them into JSON responses.

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) { super(400, message, 'bad_request', details); }
}
export class UnauthorizedError extends HttpError {
  constructor(message = 'Authentication required') { super(401, message, 'unauthorized'); }
}
export class ForbiddenError extends HttpError {
  constructor(message = 'You do not have access to this resource') { super(403, message, 'forbidden'); }
}
export class NotFoundError extends HttpError {
  constructor(message = 'Resource not found') { super(404, message, 'not_found'); }
}
export class ConflictError extends HttpError {
  constructor(message: string) { super(409, message, 'conflict'); }
}
export class TooManyRequestsError extends HttpError {
  constructor(message = 'Too many requests') { super(429, message, 'rate_limited'); }
}
