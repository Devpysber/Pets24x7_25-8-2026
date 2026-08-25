import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from './env.js';
import { logger } from './logger.js';
import { HttpError } from './shared/errors.js';
import { ZodError } from 'zod';

import { whatsappRouter } from './whatsapp/webhook.routes.js';
import { parentAuthRouter } from './auth/parent.routes.js';
import { vendorAuthRouter } from './auth/vendor.routes.js';
import { adminAuthRouter } from './auth/admin.routes.js';
import { adminApiRouter } from './admin/admin.api.routes.js';
import { meRouter } from './auth/me.routes.js';
import { parentDashboardRouter } from './pets/parent.routes.js';
import { vendorDashboardRouter } from './vendors/dashboard.routes.js';
import { adminPanelRouter } from './admin/panel.routes.js';
import { listingsRouter } from './listings/lookup.routes.js';
import { initListingsIndex } from './listings/index.js';
import { membershipRouter } from './payments/membership.routes.js';
import { phonepeRouter } from './payments/phonepe.routes.js';
import { vendorReviewsRouter } from './reviews/vendor.routes.js';
import { reviewShortLinkRouter, reviewPublicApiRouter } from './reviews/public.routes.js';
import { devRouter } from './dev/dev.routes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ---- Trust proxy (Railway/Cloudflare put us behind one) ----
app.set('trust proxy', 1);

// ---- View engine for admin panel ----
app.set('views', path.join(__dirname, 'admin', 'views'));
app.set('view engine', 'ejs');

// ---- Core middleware ----
app.use(pinoHttp({ logger, autoLogging: { ignore: (r) => r.url === '/health' } }));
app.use(cors({
  origin: [env.PUBLIC_SITE_URL, /\.pets24x7\.com$/, ...(env.NODE_ENV === 'development' ? ['http://localhost:8000', 'http://localhost:5173'] : [])],
  credentials: true,
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
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
  admin: '/admin',
  health: '/health',
}));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pets24x7-api', ts: Date.now() }));

// ---- Routes ----
app.use('/api/parent',  parentAuthRouter);
app.use('/api/vendor',  vendorAuthRouter);
app.use('/api/admin',   adminAuthRouter);
app.use('/api/admin',   adminApiRouter);
app.use('/api/me',      meRouter);
app.use('/api/parent',  parentDashboardRouter);
app.use('/api/vendor',  vendorDashboardRouter);
app.use('/api/listings', listingsRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/memberships', membershipRouter);
app.use('/api/payments/phonepe', phonepeRouter);
app.use('/api/vendor/reviews', vendorReviewsRouter);
app.use('/api/reviews', reviewPublicApiRouter);
app.use('/r', reviewShortLinkRouter);
app.use('/admin', adminPanelRouter);
app.use('/dev', devRouter);
app.use('/api/dev', devRouter);

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
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ ok: false, error: 'internal_error' });
});

// ---- Boot ----
(async () => {
  await initListingsIndex();   // load static-frontend listings into memory for phone lookups
  app.listen(env.PORT, () => {
    logger.info(`pets24x7-api ready on http://localhost:${env.PORT}  (NODE_ENV=${env.NODE_ENV})`);
  });
})().catch((err) => {
  logger.fatal({ err }, 'boot failure');
  process.exit(1);
});
