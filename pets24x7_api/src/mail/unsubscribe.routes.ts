// Public unsubscribe endpoints. No session: the link is authenticated by an
// HMAC of the address, so it keeps working from any mail client, months later.
//
//   GET  /api/email/unsubscribe?e=&t=   confirmation page (link scanners are
//                                       harmless — GET never changes state)
//   POST /api/email/unsubscribe?e=&t=   performs the opt-out. Also the RFC 8058
//                                       One-Click target named by the
//                                       List-Unsubscribe-Post header.
//   POST /api/email/resubscribe?e=&t=   undo, offered on the result page.
//
// `&scope=digest` narrows all three to the recommendations digest: the digest
// mail links "Stop recommendation emails" there, and that must switch off the
// digest (PetParent.digestFrequency = OFF) without silencing every other
// suggestion — and certainly without the page claiming it had.

import { Router } from 'express';

import { asyncHandler } from '../shared/async-handler.js';
import { makeLimiter } from '../shared/rate-limit.js';
import { BadRequestError } from '../shared/errors.js';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { normalizeEmail, optIn, optOut, unsubscribeToken, verifyUnsubscribeToken } from './optout.js';

export const unsubscribeRouter = Router();

const limiter = makeLimiter('unsubscribe', { windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

type Scope = 'all' | 'digest';

function params(req: { query: Record<string, unknown> }): { email: string; token: string; scope: Scope; qs: string } {
  const email = normalizeEmail(String(req.query.e ?? ''));
  const token = String(req.query.t ?? '');
  if (!email || !email.includes('@')) throw new BadRequestError('Missing email');
  if (!verifyUnsubscribeToken(email, token)) throw new BadRequestError('This unsubscribe link is not valid');
  const scope: Scope = req.query.scope === 'digest' ? 'digest' : 'all';
  // Carried into every form on the page so the POST acts on the same scope.
  const qs = `e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}${scope === 'digest' ? '&scope=digest' : ''}`;
  return { email, token, scope, qs };
}

/**
 * Sets the digest cadence on the pet-parent account behind this address.
 * Signup flows store addresses lower-cased, and the production collation
 * compares case-insensitively anyway, so an equality match is enough.
 */
async function setDigestFrequency(email: string, value: 'OFF' | null): Promise<number> {
  const { count } = await prisma.petParent.updateMany({ where: { email }, data: { digestFrequency: value } });
  return count;
}

const siteHome = (): string => (env.MAIL_SITE_URL ?? env.PUBLIC_SITE_URL).replace(/\/+$/, '');

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
  button{appearance:none;border:0;background:#c2410c;color:#fff;font:600 15px/1 inherit;padding:13px 26px;border-radius:9999px;cursor:pointer}
  button.ghost{background:transparent;color:#4b5563;text-decoration:underline;padding-left:0}
  a{color:#c2410c}
  .brand{display:block;margin:0 0 22px;font-size:20px;font-weight:800;color:#111827;text-decoration:none}
  .brand span{color:#ff6b35}
  .foot{margin:22px 0 0;font-size:13px;color:#6b7280}
  @media (max-width:560px){.card{margin:0;border-radius:0;border:0;padding:28px 20px}}
</style></head><body><div class="card">
<a class="brand" href="${esc(siteHome())}/">Pets<span>24x7</span></a>
${body}
<p class="foot"><a href="${esc(siteHome())}/">Back to Pets24x7</a> &middot; <a href="${esc(siteHome())}/privacy.html">Privacy</a></p>
</div></body></html>`;
}

unsubscribeRouter.get(
  '/email/unsubscribe',
  limiter,
  asyncHandler(async (req, res) => {
    const { email, token, scope, qs } = params(req as never);
    const all = `e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
    res.type('html').send(
      scope === 'digest'
        ? page(
            'Stop recommendation emails',
            `<h1>Stop recommendation emails?</h1>
             <p><strong>${esc(email)}</strong> will stop receiving the Pets24x7 recommendations digest. Other emails are not affected, and you can switch the digest back on from your dashboard at any time.</p>
             <form method="post" action="/api/email/unsubscribe?${qs}"><button type="submit">Stop recommendation emails</button></form>
             <p style="margin-top:18px">Want no suggestions at all? <a href="/api/email/unsubscribe?${all}">Unsubscribe from all Pets24x7 suggestions</a>.</p>`,
          )
        : page(
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
    const { email, scope, qs } = params(req as never);
    if (scope === 'digest') {
      const updated = await setDigestFrequency(email, 'OFF');
      logger.info({ email, updated }, '[mail] recommendation digest switched off');
    } else {
      await optOut(email, 'unsubscribe_link');
      logger.info({ email }, '[mail] unsubscribed');
    }

    // One-Click clients (RFC 8058) post without a browser and want a bare 200.
    const oneClick = String((req.body as Record<string, unknown> | undefined)?.['List-Unsubscribe'] ?? '') === 'One-Click';
    if (oneClick || !req.accepts('html')) {
      res.json({ ok: true, unsubscribed: email, scope });
      return;
    }

    res.type('html').send(
      scope === 'digest'
        ? page(
            'Recommendation emails off',
            `<h1>Recommendation emails are off</h1>
             <p><strong>${esc(email)}</strong> will no longer receive the recommendations digest.</p>
             <form method="post" action="/api/email/resubscribe?${qs}"><button class="ghost" type="submit">This was a mistake — turn them back on</button></form>`,
          )
        : page(
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
    const { email, scope } = params(req as never);
    // Back to the admin default cadence rather than a guessed DAILY/WEEKLY.
    if (scope === 'digest') await setDigestFrequency(email, null);
    else await optIn(email);
    logger.info({ email, scope }, '[mail] resubscribed');
    if (!req.accepts('html')) {
      res.json({ ok: true, resubscribed: email, scope });
      return;
    }
    res.type('html').send(
      page(
        'Resubscribed',
        scope === 'digest'
          ? `<h1>Recommendation emails are back on</h1><p><strong>${esc(email)}</strong> will receive the recommendations digest again.</p>`
          : `<h1>You're back on the list</h1><p><strong>${esc(email)}</strong> will receive Pets24x7 suggestions again.</p>`,
      ),
    );
  }),
);

/** Re-exported so tests and the admin console can build a link. */
export { unsubscribeToken };
