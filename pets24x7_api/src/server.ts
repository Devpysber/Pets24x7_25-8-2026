import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcrypt';

import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { HttpError } from './shared/errors.js';
import { makeLimiter } from './shared/rate-limit.js';
import { warmKv } from './shared/kv.js';
import { ZodError } from 'zod';

import { whatsappRouter } from './whatsapp/webhook.routes.js';
import { parentAuthRouter } from './auth/parent.routes.js';
import { parentEmailAuthRouter } from './auth/email.routes.js';
import { vendorAuthRouter } from './auth/vendor.routes.js';
import { vendorClaimRegistrationRouter } from './auth/vendor-claim-registration.routes.js';
import { adminAuthRouter } from './auth/admin.routes.js';
import { adminApiRouter, loadPersistedPlanStores } from './admin/admin.api.routes.js';
import { adminMailRouter } from './admin/mail.routes.js';
import { adminImportRouter } from './admin/import.routes.js';
import { adminPublishRouter } from './admin/publish.routes.js';
import { adminExtraRouter } from './admin/admin.extra.routes.js';
import { meRouter } from './auth/me.routes.js';
import { parentDashboardRouter } from './pets/parent.routes.js';
import { vendorDashboardRouter } from './vendors/dashboard.routes.js';
import { adminPanelRouter } from './admin/panel.routes.js';
import { listingsRouter } from './listings/lookup.routes.js';
import { activityRouter, adminActivityRouter } from './listings/activity.routes.js';
import { initListingsIndex, startListingsSync } from './listings/index.js';
import { membershipRouter } from './payments/membership.routes.js';
import { razorpayRouter } from './payments/razorpay.routes.js';
import { vendorReviewsRouter } from './reviews/vendor.routes.js';
import { reviewShortLinkRouter, reviewPublicApiRouter } from './reviews/public.routes.js';
import { enquiryRouter } from './enquiries/enquiry.routes.js';
import { vendorServicesRouter } from './vendors/service.routes.js';
import { vendorCampaignsRouter } from './marketing/campaign.routes.js';
import { featuredPublicRouter, vendorFeaturedRouter } from './featured/featured.routes.js';
import { vendorSubscriptionsRouter } from './vendors/vendor.subscriptions.routes.js';
import { recommendRouter } from './feed/recommend.routes.js';
import { feedRouter } from './feed/feed.routes.js';
import { recoRouter } from './feed/reco/reco.routes.js';
import { adminRecoRouter } from './feed/reco/admin.reco.routes.js';
import { startRecoJobs } from './jobs/reco-jobs.js';
import { unsubscribeRouter } from './mail/unsubscribe.routes.js';
import { startReminderJob } from './jobs/reminders.js';
import { startEngagementJob } from './jobs/engagement.js';
import { startVendorEngagementJob } from './jobs/vendor-engagement.js';
import { startAdminDigestJob } from './jobs/admin-digest.js';
import { mailEnabled, verifyMailTransport } from './mail/mailer.js';
import { startExpiryJob } from './jobs/expiry.js';
import { devRouter } from './dev/dev.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ---- Trust proxy (nginx, and Cloudflare in front of it in production) ----
// Hop count comes from TRUST_PROXY; see env.ts for why it matters.
app.set('trust proxy', env.TRUST_PROXY);

// A wrong hop count fails silently: req.ip becomes a Cloudflare edge address
// and every visitor on that edge shares one OTP / verify / login budget. When
// Cloudflare names the client and req.ip disagrees, say so once, loudly.
if (env.NODE_ENV === 'production') {
  let warned = false;
  app.use((req, _res, next) => {
    const cfIp = req.headers['cf-connecting-ip'];
    if (!warned && typeof cfIp === 'string' && cfIp && req.ip !== cfIp) {
      warned = true;
      logger.warn(
        { trustProxy: env.TRUST_PROXY, reqIp: req.ip, cfConnectingIp: cfIp },
        'req.ip does not match CF-Connecting-IP: rate limits are keyed on a proxy address. Set TRUST_PROXY=2 for Cloudflare -> nginx -> Node (see DEPLOY.md).',
      );
    }
    next();
  });
}

// ---- View engine for admin panel ----
// Prefer the compiled copy (dist/admin/views, populated by scripts/copy-assets.mjs);
// fall back to the TS source tree so a build that forgot to copy still renders.
const compiledViews = path.join(__dirname, 'admin', 'views');
const sourceViews = path.join(__dirname, '..', 'src', 'admin', 'views');
app.set('views', existsSync(compiledViews) ? compiledViews : sourceViews);
app.set('view engine', 'ejs');

// ---- Core middleware ----
app.use(pinoHttp({ logger, autoLogging: { ignore: (r) => r.url === '/health' } }));
app.use(cors({
  origin: [env.PUBLIC_SITE_URL, /\.pets24x7\.com$/, ...(env.NODE_ENV === 'development' ? ['http://localhost:8000', 'http://localhost:5173'] : [])],
  credentials: true,
}));
app.use(express.json({
  limit: '10mb',
  // Keep the raw bytes for HMAC-verified webhooks (Razorpay).
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Aggressive default limit in production; relaxed in dev mode for testing.
// Shared across instances when REDIS_URL is set (shared/rate-limit.ts).
app.use('/api', makeLimiter('api-global', {
  windowMs: 60_000,
  max: process.env.NODE_ENV === 'development' ? 10_000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---- Root & Healthcheck ----
app.get('/', (_req, res) => res.json({
  ok: true,
  service: 'pets24x7-api',
  frontend: 'http://localhost:8000',
  admin: '/dashboard/admin/',
  health: '/health',
}));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pets24x7-api', ts: Date.now() }));

// Public front-end config. Only values that are safe in a browser: the Google
// OAuth *client* id is public by design, the secret never leaves the server.
// Keeps the site from having to duplicate anything already set in .env.
app.get('/api/config', (_req, res) =>
  res.json({
    ok: true,
    googleClientId: env.GOOGLE_CLIENT_ID ?? null,
    emailAuth: true,
  }),
);

// ---- Routes ----
app.use('/api/parent',  parentAuthRouter);
app.use('/api/parent',  parentEmailAuthRouter);
app.use('/api/vendor',  vendorAuthRouter);
app.use('/api/vendor',  vendorClaimRegistrationRouter);
app.use('/api/vendor/subscriptions', vendorSubscriptionsRouter);
app.use('/api/admin/reco', adminRecoRouter);   // before the generic /api/admin routers
app.use('/api/admin',   adminAuthRouter);
app.use('/api/admin',   adminApiRouter);
app.use('/api/admin',   adminExtraRouter);
app.use('/api/admin',   adminMailRouter);
app.use('/api/admin',   adminImportRouter);
app.use('/api/admin',   adminPublishRouter);
app.use('/api/me',      meRouter);
app.use('/api/parent',  parentDashboardRouter);
app.use('/api/vendor',  vendorDashboardRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/admin',   adminActivityRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/memberships', membershipRouter);
app.use('/api/payments/razorpay', razorpayRouter);
app.use('/api/vendor/reviews', vendorReviewsRouter);
app.use('/api/vendor/services', vendorServicesRouter);
app.use('/api/vendor/campaigns', vendorCampaignsRouter);
app.use('/api/vendor/featured', vendorFeaturedRouter);
app.use('/api/reviews', reviewPublicApiRouter);
app.use('/api/enquiries', enquiryRouter);
app.use('/api/featured', featuredPublicRouter);
app.use('/api', unsubscribeRouter);
app.use('/api', feedRouter);
app.use('/api', recommendRouter);
app.use('/api/reco', recoRouter);
app.use('/r', reviewShortLinkRouter);
app.use('/admin', adminPanelRouter);
// Dev-only one-click auth portal. NEVER mount outside development — these
// routes mint privileged cookies with no credential check.
if (env.NODE_ENV === 'development') {
  app.use('/dev', devRouter);
  app.use('/api/dev', devRouter);
}

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

// ---- Central error handler ----
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    req.log.warn({ err }, 'http error');
    return res.status(err.status).json({ ok: false, error: err.code ?? 'error', message: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    req.log.warn({ issues: err.issues }, 'validation error');
    // api-client.js shows `message`; without one the user saw "validation_failed".
    const first = err.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return res.status(400).json({
      ok: false,
      error: 'validation_failed',
      message: first ? `${where}${first.message}` : 'Some fields are invalid.',
      issues: err.issues,
    });
  }
  // body-parser failures carry their own status (400 malformed JSON, 413 body
  // over the limit). They are the caller's fault, not a server fault, and used
  // to fall through to a 500 internal_error.
  const parserType = (err as { type?: string })?.type;
  if (parserType === 'entity.parse.failed') {
    req.log.warn({ err }, 'malformed request body');
    return res.status(400).json({ ok: false, error: 'bad_json', message: 'The request body is not valid JSON.' });
  }
  if (parserType === 'entity.too.large') {
    req.log.warn({ err }, 'request body too large');
    return res.status(413).json({ ok: false, error: 'payload_too_large', message: 'The request is too large. Try a smaller image.' });
  }
  // A bare "internal_error" is what made the pet-photo failure invisible: the
  // dashboard showed it, the cause was a column too narrow for the value, and
  // nothing in the response tied the two together. Two things fix that.
  //
  // First, the request id goes back to the caller, so a reported failure can be
  // found in the log without guessing at timestamps.
  //
  // Second, the handful of Prisma errors that mean "your data did not fit"
  // answer 400 with the offending field rather than 500. Those are caused by
  // the request, not by the server being broken, and saying so turns a silent
  // mystery into something the caller can act on. The message stays generic in
  // production so it never leaks a column name or a constraint to the public.
  const code = (err as { code?: string })?.code;
  const meta = (err as { meta?: { target?: unknown; column_name?: unknown } })?.meta;
  const rawField = String(meta?.column_name ?? (Array.isArray(meta?.target) ? meta!.target.join(', ') : meta?.target ?? ''));
  // Column names stay in the log; the public response only names them off-production.
  const field = env.NODE_ENV === 'production' ? '' : rawField;

  // P2000 value too long for the column, P2005/P2006 invalid value for the field.
  if (code === 'P2000' || code === 'P2005' || code === 'P2006') {
    req.log.error({ err, code, field: rawField }, 'value rejected by the database');
    return res.status(400).json({
      ok: false,
      error: 'value_too_large',
      message: field
        ? `The value sent for "${field}" is larger than this field allows.`
        : 'One of the values sent is larger than the field allows.',
      requestId: req.id,
    });
  }

  // P2002 unique constraint — a duplicate the caller can fix (phone or email
  // already on another account), not a server failure.
  if (code === 'P2002') {
    req.log.warn({ err, code, field: rawField }, 'unique constraint violated');
    return res.status(409).json({
      ok: false,
      error: 'conflict',
      message: field
        ? `That ${field} is already in use.`
        : 'That value is already used by another record.',
      requestId: req.id,
    });
  }

  // P2025 the row an update/delete targeted is gone (deleted in another tab).
  if (code === 'P2025') {
    req.log.warn({ err, code }, 'record not found');
    return res.status(404).json({ ok: false, error: 'not_found', message: 'That record no longer exists.', requestId: req.id });
  }

  req.log.error({ err, code }, 'unhandled error');
  res.status(500).json({ ok: false, error: 'internal_error', requestId: req.id });
});

// Idempotent admin bootstrap so /admin/login always has a usable account in
// every environment. Upserts the SEED_ADMIN_* account on each boot (same as
// `npm run seed:admin`); no-op if those env vars are unset.
async function ensureSeedAdmin(): Promise<void> {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    logger.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — no admin auto-provisioned; /admin/login will reject all logins until an Admin row exists');
    return;
  }
  try {
    const email = env.SEED_ADMIN_EMAIL.toLowerCase();
    const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12);
    const admin = await prisma.admin.upsert({
      where: { email },
      update: { passwordHash, name: env.SEED_ADMIN_NAME ?? 'Pets24x7 Admin' },
      create: { email, passwordHash, name: env.SEED_ADMIN_NAME ?? 'Pets24x7 Admin', role: 'OWNER' },
    });
    logger.info(`admin ready: ${admin.email}`);
  } catch (err) {
    logger.error({ err }, 'ensureSeedAdmin failed (DB offline?) — /admin/login may not work');
  }
}

// ---- Boot ----
// Deployed by pets24x7-deploy.timer from the deploy branch; see ops/README.md.
(async () => {
  await initListingsIndex();   // load static-frontend listings into memory for phone lookups
  startListingsSync();         // pulls other instances' listing writes; off on a single server (LISTINGS_SYNC_MS)
  await ensureSeedAdmin();     // make sure an admin account exists for /admin/login
  // Admin-saved plan prices must be live before the first checkout quote;
  // otherwise the first requests after boot are priced from the defaults.
  await loadPersistedPlanStores().catch(() => {});
  warmKv();                   // opens the Redis connection early when REDIS_URL is set
  // Scheduled sweeps. Each run takes a cluster-wide lease first (shared/job-lock.ts),
  // so several instances never duplicate a sweep; RUN_JOBS=false keeps a
  // web-only instance out of the rotation entirely.
  if (env.RUN_JOBS) {
    startExpiryJob();         // periodic membership/campaign/featured/deal/event lifecycle sweep
    startReminderJob();       // hourly "about to lapse" and unanswered-enquiry reminders
    startEngagementJob();       // 3-4 random times a day; at most one promo per parent per day
    startVendorEngagementJob(); // the same for businesses, in an earlier window
    startAdminDigestJob();      // one briefing a day: what is waiting, and what moved
  } else {
    logger.info('RUN_JOBS=false: scheduled sweeps are not started on this instance');
  }
  // Not behind RUN_JOBS: the reco stats flush drains this process's own
  // in-memory counters and the signals snapshot feeds this process's cache,
  // so every serving instance needs them.
  startRecoJobs();            // reco signals snapshot (5 min), admin insights (15 min), stats flush (60 s)
  // Production must never fall back to the logged no-op: an unconfigured relay
  // there means verification links, receipts and invoices are silently dropped
  // while every request still returns 200. Refuse to boot instead.
  if (env.NODE_ENV === 'production' && !mailEnabled()) {
    logger.fatal('SMTP_USER / SMTP_PASS are not set — refusing to start in production without a mail relay');
    process.exit(1);
  }
  // The login check itself stays non-blocking: a relay that is briefly
  // unreachable must not stop the API serving, but it must be loud in the log
  // rather than showing up as mail that quietly never arrives.
  void verifyMailTransport().catch(() => {});
  app.listen(env.PORT, env.HOST, () => {
    logger.info(`pets24x7-api ready on http://${env.HOST}:${env.PORT}  (NODE_ENV=${env.NODE_ENV})`);
  });
})().catch((err) => {
  logger.fatal({ err }, 'boot failure');
  process.exit(1);
});
