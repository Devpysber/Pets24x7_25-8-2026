// Public unsubscribe endpoints. No session: the link is authenticated by an
// HMAC of the address, so it keeps working from any mail client, months later.
//
//   GET  /api/email/unsubscribe?e=&t=   confirmation page (link scanners are
//                                       harmless — GET never changes state)
//   POST /api/email/unsubscribe?e=&t=   performs the opt-out. Also the RFC 8058
//                                       One-Click target named by the
//                                       List-Unsubscribe-Post header.
//   POST /api/email/resubscribe?e=&t=   undo, offered on the result page.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { asyncHandler } from '../shared/async-handler.js';
import { BadRequestError } from '../shared/errors.js';
import { logger } from '../logger.js';
import { normalizeEmail, optIn, optOut, unsubscribeToken, verifyUnsubscribeToken } from './optout.js';

export const unsubscribeRouter = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

function params(req: { query: Record<string, unknown> }): { email: string; token: string } {
  const email = normalizeEmail(String(req.query.e ?? ''));
  const token = String(req.query.t ?? '');
  if (!email || !email.includes('@')) throw new BadRequestError('Missing email');
  if (!verifyUnsubscribeToken(email, token)) throw new BadRequestError('This unsubscribe link is not valid');
  return { email, token };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Pets24x7</title>
<style>
  body{margin:0;background:#fafaf9;color:#111827;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .card{max-width:520px;margin:12vh auto;background:#fff;border:1px solid #eceef2;border-radius:16px;padding:36px 34px}
  h1{margin:0 0 10px;font-size:22px}
  p{margin:0 0 14px;color:#4b5563}
  button{appearance:none;border:0;background:#f97316;color:#fff;font:600 15px/1 inherit;padding:13px 26px;border-radius:9999px;cursor:pointer}
  button.ghost{background:transparent;color:#6b7280;text-decoration:underline;padding-left:0}
  a{color:#f97316}
</style></head><body><div class="card">${body}</div></body></html>`;
}

unsubscribeRouter.get(
  '/email/unsubscribe',
  limiter,
  asyncHandler(async (req, res) => {
    const { email, token } = params(req as never);
    const qs = `e=${encodeURIComponent(email)}&t=${token}`;
    res.type('html').send(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe ${esc(email)}?</h1>
         <p>You will stop receiving Pets24x7 suggestions and announcements. Account and payment emails — verification links, receipts, enquiry replies — still reach you.</p>
         <form method="post" action="/api/email/unsubscribe?${qs}"><button type="submit">Unsubscribe me</button></form>`,
      ),
    );
  }),
);

unsubscribeRouter.post(
  '/email/unsubscribe',
  limiter,
  asyncHandler(async (req, res) => {
    const { email, token } = params(req as never);
    await optOut(email, 'unsubscribe_link');
    logger.info({ email }, '[mail] unsubscribed');

    // One-Click clients (RFC 8058) post without a browser and want a bare 200.
    const oneClick = String((req.body as Record<string, unknown> | undefined)?.['List-Unsubscribe'] ?? '') === 'One-Click';
    if (oneClick || !req.accepts('html')) {
      res.json({ ok: true, unsubscribed: email });
      return;
    }

    const qs = `e=${encodeURIComponent(email)}&t=${token}`;
    res.type('html').send(
      page(
        'Unsubscribed',
        `<h1>Unsubscribed</h1>
         <p><strong>${esc(email)}</strong> will no longer receive Pets24x7 suggestions.</p>
         <form method="post" action="/api/email/resubscribe?${qs}"><button class="ghost" type="submit">This was a mistake — resubscribe me</button></form>`,
      ),
    );
  }),
);

unsubscribeRouter.post(
  '/email/resubscribe',
  limiter,
  asyncHandler(async (req, res) => {
    const { email } = params(req as never);
    await optIn(email);
    logger.info({ email }, '[mail] resubscribed');
    if (!req.accepts('html')) {
      res.json({ ok: true, resubscribed: email });
      return;
    }
    res.type('html').send(
      page(
        'Resubscribed',
        `<h1>You're back on the list</h1><p><strong>${esc(email)}</strong> will receive Pets24x7 suggestions again.</p>`,
      ),
    );
  }),
);

/** Re-exported so tests and the admin console can build a link. */
export { unsubscribeToken };
