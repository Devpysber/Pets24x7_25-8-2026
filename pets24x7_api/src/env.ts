import 'dotenv/config';
import { z } from 'zod';

// z.coerce.boolean() is Boolean(value), so the string "false" in .env becomes
// true. That silently turned MAIL_ALLOW_DEV_SEND=false (as shipped in
// .env.example) into "send real mail from dev", and SMTP_SECURE=false into TLS
// on a STARTTLS port. Parse the words people actually write instead.
const envBool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      const s = (v ?? '').trim().toLowerCase();
      if (s === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(s);
    });

// .env.example ships optional credentials as KEY="" and says to leave them
// blank (Razorpay in development, SMTP when there is no relay). min(1) turned
// that blank into a refusal to boot; blank means "not configured" instead.
const optionalSecret = () =>
  z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

const Env = z.object({
  // Fails closed. 'development' switches on the OTP bypasses in the parent and
  // vendor sign-in routes and mounts /dev, which mints admin cookies with no
  // credential check — a deploy that forgot to set NODE_ENV must not get those.
  // Local runs set it explicitly (.env.example ships NODE_ENV=development).
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(4000),
  // Bind address. Defaults to loopback so the API is only reachable through the
  // reverse proxy; set to 0.0.0.0 only when nothing fronts it.
  HOST: z.string().default('127.0.0.1'),
  // Reverse-proxy hops in front of the API whose X-Forwarded-For entries are
  // trusted when working out the client IP (every rate limit keys on it).
  // Behind nginx alone that is 1. Behind Cloudflare -> nginx it is 2: with 1,
  // req.ip is a Cloudflare edge address, so each auth limit (4 OTPs a minute,
  // 10 admin logins per 5 minutes) is shared by everyone on that edge.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PUBLIC_SITE_URL: z.string().url(),
  // Base URL for links and branding inside outbound email only. A dev box runs
  // on localhost, and a sign-in link that points there is useless in a real
  // inbox. Falls back to PUBLIC_SITE_URL, so production needs nothing extra.
  MAIL_SITE_URL: z.string().url().optional(),
  PUBLIC_API_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('pets24x7.com'),
  COOKIE_DOMAIN: z.string().default(''),
  ADMIN_SESSION_SECRET: z.string().min(32),

  WA_PHONE_NUMBER_ID: z.string().min(1),
  WA_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WA_ACCESS_TOKEN: z.string().min(1),
  WA_VERIFY_TOKEN: z.string().min(1),
  // Meta App Dashboard > Settings > Basic > App secret. Signs webhook payloads
  // (X-Hub-Signature-256); unset means signatures are not verified.
  WA_APP_SECRET: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  WA_OTP_TEMPLATE_NAME: z.string().default('pets24x7_otp'),
  WA_OTP_TEMPLATE_LANG: z.string().default('en'),
  WA_REVIEW_TEMPLATE_NAME: z.string().default('pets24x7_review_request'),
  WA_REVIEW_TEMPLATE_LANG: z.string().default('en'),

  STATIC_DATA_DIR: z.string().default('../pets24x7_new/data'),
  PUBLIC_SHORTLINK_BASE: z.string().url().default('https://pets24x7.com'),

  // ---- PhonePe Payment Gateway ----
  // Where PhonePe redirects the user after pay (browser navigation).
  // Server-to-server callback (must be reachable by PhonePe — production hostname).

  // ---- Razorpay Payment Gateway (preferred when configured) ----
  RAZORPAY_KEY_ID: optionalSecret(),
  RAZORPAY_KEY_SECRET: optionalSecret(),
  RAZORPAY_WEBHOOK_SECRET: optionalSecret(),

  // ---- Invoices (read by payments/invoice.ts) ----
  // Set to issue GST "Tax invoice"s; blank renders a plain invoice.
  SELLER_GSTIN: z.string().optional(),
  GST_RATE_PERCENT: z.coerce.number().min(0).max(28).optional(),

  // ---- Email (any SMTP relay) ----
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_SECURE: envBool(true),
  // Not an email address: Gmail uses one, but Resend's SMTP user is the literal
  // string 'resend' and SES uses an IAM SMTP key. Requiring email format here
  // made the API refuse to boot on any provider that authenticates properly.
  SMTP_USER: optionalSecret(),
  // Provider password or API key. Gmail app passwords are printed with spaces;
  // those are stripped at load time below.
  SMTP_PASS: optionalSecret(),
  // Must be an address on a domain you control and have signed with DKIM —
  // sending as a free consumer mailbox lands transactional mail in spam.
  MAIL_FROM: z.string().default('Pets24x7 <pets24x7.com@gmail.com>'),
  // A development database is full of seeded and abandoned test addresses, and
  // a background job that mails all of them from the live relay both bounces
  // and burns sender reputation. Sending is therefore off outside production
  // unless this is explicitly set.
  MAIL_ALLOW_DEV_SEND: envBool(false),
  // Verification links stay valid this long unless used sooner.
  EMAIL_VERIFY_TTL_MIN: z.coerce.number().int().min(1).default(10),

  // ---- Google Sign-In ----
  // Blank is allowed and means "Google Sign-In not configured yet" — the key
  // ships commented-in but empty in .env.example.
  GOOGLE_CLIENT_ID: z.string().optional().transform((v) => (v ? v : undefined)),

  // Inbox for admin-facing alerts raised by public requests (a new vendor
  // signing up). Falls back to the OWNER admins on record, then SEED_ADMIN_EMAIL.
  // ---- Horizontal scale (all optional; one server needs none of them) ----
  // Shared cache + rate-limit counters for several API instances behind one
  // load balancer, e.g. redis://:password@10.0.0.5:6379/0. Unset keeps every
  // counter and cache in process memory, which is correct for a single server.
  // See src/shared/kv.ts and DEPLOY.md "Scaling to multiple servers".
  REDIS_URL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  // Namespace for every key this app writes, so a shared Redis can host other
  // apps (or a staging copy of this one) without collisions.
  REDIS_KEY_PREFIX: z.string().default('p24x7:'),
  // Upper bound on the in-memory cache used when REDIS_URL is unset (and as the
  // fallback while Redis is unreachable). Least recently used entries go first.
  KV_MEMORY_MAX_ENTRIES: z.coerce.number().int().min(100).default(10_000),
  // Background schedulers (reminders, engagement mail, digests, expiry sweep).
  // Every instance takes a database lease before a run, so leaving this on
  // everywhere is safe; set false on web-only instances to keep them out of
  // the rotation entirely.
  RUN_JOBS: envBool(true),
  // How often each instance pulls listing rows changed by another instance
  // (imports, vendor edits, deletions) into its in-memory index. 0 turns it
  // off. Unset means 60s when REDIS_URL is set (several instances) and off
  // otherwise: one server already updates its own index on every write.
  LISTINGS_SYNC_MS: z.coerce.number().int().min(0).optional(),

  ADMIN_NOTIFY_EMAIL: z.string().email().optional(),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_NAME: z.string().optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] invalid configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Gmail shows app passwords as "abcd efgh ijkl mnop"; SMTP wants them unspaced.
if (env.SMTP_PASS) env.SMTP_PASS = env.SMTP_PASS.replace(/\s+/g, '');

export type EnvType = typeof env;
