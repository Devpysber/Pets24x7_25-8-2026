import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  // Bind address. Defaults to loopback so the API is only reachable through the
  // reverse proxy; set to 0.0.0.0 only when nothing fronts it.
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PUBLIC_SITE_URL: z.string().url(),
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
  WA_OTP_TEMPLATE_NAME: z.string().default('pets24x7_otp'),
  WA_OTP_TEMPLATE_LANG: z.string().default('en'),
  WA_REVIEW_TEMPLATE_NAME: z.string().default('pets24x7_review_request'),
  WA_REVIEW_TEMPLATE_LANG: z.string().default('en'),

  STATIC_DATA_DIR: z.string().default('../pets24x7_new/data'),
  PUBLIC_SHORTLINK_BASE: z.string().url().default('https://pets24x7.com'),

  // ---- PhonePe Payment Gateway ----
  PHONEPE_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
  PHONEPE_MERCHANT_ID: z.string().min(1),
  PHONEPE_SALT_KEY: z.string().min(1),
  PHONEPE_SALT_INDEX: z.coerce.number().int().min(1).default(1),
  // Where PhonePe redirects the user after pay (browser navigation).
  PHONEPE_REDIRECT_URL: z.string().url().default('https://pets24x7.com/membership/return/'),
  // Server-to-server callback (must be reachable by PhonePe — production hostname).
  PHONEPE_CALLBACK_URL: z.string().url().default('https://api.pets24x7.com/api/payments/phonepe/callback'),

  // ---- Razorpay Payment Gateway (preferred when configured) ----
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ---- Email (any SMTP relay) ----
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_SECURE: z.coerce.boolean().default(true),
  // Not an email address: Gmail uses one, but Resend's SMTP user is the literal
  // string 'resend' and SES uses an IAM SMTP key. Requiring email format here
  // made the API refuse to boot on any provider that authenticates properly.
  SMTP_USER: z.string().min(1).optional(),
  // Provider password or API key. Gmail app passwords are printed with spaces;
  // those are stripped at load time below.
  SMTP_PASS: z.string().min(1).optional(),
  // Must be an address on a domain you control and have signed with DKIM —
  // sending as a free consumer mailbox lands transactional mail in spam.
  MAIL_FROM: z.string().default('Pets24x7 <pets24x7.com@gmail.com>'),
  // Verification links stay valid this long unless used sooner.
  EMAIL_VERIFY_TTL_MIN: z.coerce.number().int().min(1).default(10),

  // ---- Google Sign-In ----
  // Blank is allowed and means "Google Sign-In not configured yet" — the key
  // ships commented-in but empty in .env.example.
  GOOGLE_CLIENT_ID: z.string().optional().transform((v) => (v ? v : undefined)),

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
