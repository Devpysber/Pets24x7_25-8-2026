import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import bcrypt from 'bcrypt';

import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { HttpError } from './shared/errors.js';
import { ZodError } from 'zod';

import { whatsappRouter } from './whatsapp/webhook.routes.js';
import { parentAuthRouter } from './auth/parent.routes.js';
import { parentEmailAuthRouter } from './auth/email.routes.js';
import { vendorAuthRouter } from './auth/vendor.routes.js';
import { vendorClaimRegistrationRouter } from './auth/vendor-claim-registration.routes.js';
import { adminAuthRouter } from './auth/admin.routes.js';
import { adminApiRouter } from './admin/admin.api.routes.js';
import { adminMailRouter } from './admin/mail.routes.js';
import { adminImportRouter } from './admin/import.routes.js';
import { adminExtraRouter } from './admin/admin.extra.routes.js';
import { meRouter } from './auth/me.routes.js';
import { parentDashboardRouter } from './pets/parent.routes.js';
import { vendorDashboardRouter } from './vendors/dashboard.routes.js';
import { adminPanelRouter } from './admin/panel.routes.js';
import { listingsRouter } from './listings/lookup.routes.js';
import { initListingsIndex } from './listings/index.js';
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
import { unsubscribeRouter } from './mail/unsubscribe.routes.js';
import { startReminderJob } from './jobs/reminders.js';
import { startEngagementJob } from './jobs/engagement.js';
import { mailEnabled, verifyMailTransport } from './mail/mailer.js';
import { startExpiryJob } from './jobs/expiry.js';
import { devRouter } from './dev/dev.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ---- Trust proxy (Railway/Cloudflare put us behind one) ----
app.set('trust proxy', 1);

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
app.use('/api', rateLimit({
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
app.use('/api/admin',   adminAuthRouter);
app.use('/api/admin',   adminApiRouter);
app.use('/api/admin',   adminExtraRouter);
app.use('/api/admin',   adminMailRouter);
app.use('/api/admin',   adminImportRouter);
app.use('/api/me',      meRouter);
app.use('/api/parent',  parentDashboardRouter);
app.use('/api/vendor',  vendorDashboardRouter);
app.use('/api/listings', listingsRouter);
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
    return res.status(400).json({ ok: false, error: 'validation_failed', issues: err.issues });
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
  const field = String(meta?.column_name ?? (Array.isArray(meta?.target) ? meta!.target.join(', ') : meta?.target ?? ''));

  // P2000 value too long for the column, P2005/P2006 invalid value for the field.
  if (code === 'P2000' || code === 'P2005' || code === 'P2006') {
    req.log.error({ err, code, field }, 'value rejected by the database');
    return res.status(400).json({
      ok: false,
      error: 'value_too_large',
      message: field
        ? `The value sent for "${field}" is larger than this field allows.`
        : 'One of the values sent is larger than the field allows.',
      requestId: req.id,
    });
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
  await ensureSeedAdmin();     // make sure an admin account exists for /admin/login
  startExpiryJob();         // periodic membership/campaign/featured/deal/event lifecycle sweep
  startReminderJob();       // hourly "about to lapse" and unanswered-enquiry reminders
  startEngagementJob();     // 6-hourly promotional sweep, one mail per parent per 3 days
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
