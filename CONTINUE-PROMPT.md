# CONTINUE-PROMPT for Pets24x7

> Paste this entire file into a fresh AI-IDE session (Antigravity / Cursor / Claude Code / etc.) to resume work without losing context.
> The IDE should have the repo cloned at the working directory before you paste.

---

You are continuing work on **Pets24x7**, a pet services marketplace + SaaS for India and the USA. The previous Claude session shipped Phases 1, 1.5, and 2. Repo cloned at this working directory. Read this file first, then `README.md` and `HANDOFF.md`.

## Project in 1 paragraph

Static SEO frontend (Hostinger) at `pets24x7.com` showing ~35,000 pre-rendered pet-business listing pages built from CSV scrapes. Node + Express + Prisma backend (Railway) at `api.pets24x7.com` backed by Supabase Postgres. Three user roles: **Pet Parent** (saves pets, buys memberships), **Vendor** (claims one of the 34k listings by WhatsApp-OTP phone match, then improves their profile + collects reviews + runs ads), **Admin** (approves vendor claims, manages memberships + payments). WhatsApp OTP via Meta Cloud API. Payments via PhonePe Standard Checkout.

## Repo layout

```
pets24x7_new/        Static frontend — HTML + vanilla JS, no build step
pets24x7_api/        Node 20 + TS + Express 5 + Prisma backend
HANDOFF.md           Full onboarding (read this second)
README.md            Top-level overview
CONTINUE-PROMPT.md   This file
```

`pets24x7_new/in/` and `pets24x7_new/us/` (~35k generated HTML files, ~900 MB) are **not committed**. Regenerate via `cd pets24x7_new && python build_pages.py`. Needs source CSVs at `../Pets24x7_DATA/` (~50 MB, shared separately).

## Stack reference

| Concern | Implementation |
|---|---|
| Frontend | Static HTML + `<script src="/api-client.js">` hitting `api.pets24x7.com`. Cookie-based auth. No SPA framework. |
| Backend | Express 5, TypeScript strict mode, ES Modules, `tsx` for dev, `tsc` for prod build |
| ORM | Prisma 5.22, schema-first, migrations via `prisma migrate dev` |
| DB | PostgreSQL on Supabase (use the pooler URI port 6543) |
| Auth | JWT in httpOnly cookies, one cookie per role (`p24_parent`, `p24_vendor`, `p24_admin`), scoped to `.pets24x7.com`, 30d TTL |
| Validation | Zod everywhere — body parsed at the route boundary |
| Errors | `src/shared/errors.ts` typed classes → central middleware in `server.ts` → JSON `{ok:false, error, message}` |
| Logging | pino + pino-http (auto request logs) |
| WhatsApp | Direct REST calls to Meta Graph API in `src/whatsapp/cloud-api.ts`. Approved template `pets24x7_otp`. |
| Payments | PhonePe Standard Checkout in `src/payments/phonepe.ts`. SHA256 X-VERIFY = `sha256(base64Payload + endpoint + saltKey) + "###" + saltIndex`. |
| Admin panel | EJS server-rendered at `/admin`, cookie auth, no separate SPA. Sidebar in `src/admin/views/_head.ejs`. |
| Frontend integration | `pets24x7_new/api-client.js` wraps `fetch` with `credentials: 'include'`. Auto-resolves `localhost:4000` in dev / `api.pets24x7.com` in prod. |
| Config | `pets24x7_new/config.js` is single-source for `LEADS_WEBAPP_URL` (Apps Script for form sheet) and `CSV_URL` (live listings sheet). |

## What's done (do not redo)

### Phase 1 — Listings + auth + 3 dashboards
- Schema: `PetParent`, `Pet`, `Vendor`, `Admin`, `OtpCode`, `Enquiry`, `AuditLog`
- Auth routes: parent (`/api/parent/{request-otp,verify}`), vendor (`/api/vendor/{request-otp,verify}` — phone matched against in-memory index of `pets24x7_new/data/*.json`), admin (`/api/admin/login`)
- Vendor claim flow: phone matched listing → OTP → status `PENDING` → admin approves → status `ACTIVE`
- Admin EJS panel at `/admin` with vendors, parents, enquiries
- Static frontend: `/login/`, `/parent-login/`, `/vendor-login/`, `/dashboard/parent/`, `/dashboard/vendor/`

### Phase 2 — Memberships + PhonePe
- Schema additions: `MembershipPlan`, `Membership`, `Payment` + enums (`MembershipTier`, `BillingPeriod`, `MembershipStatus`, `PaymentGateway`, `PaymentStatus`)
- 6 seeded plans: Bronze/Silver/Gold × Monthly/Annual (`prisma/seed-plans.ts`)
- Endpoints: `/api/memberships/{plans,me,checkout}`, `/api/memberships/payment/:txn` (poll), `/api/payments/phonepe/callback` (S2S webhook with X-VERIFY signature check)
- State machine in `src/payments/membership.routes.ts` → `applyPaymentResult()`. Idempotent: callback retries safe.
- Static frontend: `/membership/` (plans + checkout), `/membership/return/` (polls status post-PhonePe redirect)
- Admin views: `/admin/memberships`, `/admin/payments` with status filters + totals

### Conventions to follow
- All async routes wrapped in `asyncHandler(fn)` so errors hit central middleware
- All bodies validated with `zod.parse(req.body)`
- All side effects logged via `req.log` (or `logger` outside requests)
- All privileged actions audited via `prisma.auditLog.create({...})`
- All amounts stored as integers in minor units (paise/cents), never floats
- All phone numbers normalized via `src/shared/phone.ts → normalizePhone()` before DB write
- Frontend pages never store JWTs in localStorage — only httpOnly cookies via the API

## Phase 3 — Next up (priority order)

### 3.1 Vendor review-request flow (HIGH PRIORITY)
**Goal:** Vendor sends WhatsApp messages to past customers asking for a Google review. Tracks who opened, who reviewed, surfaces rating-climb in vendor dashboard.

Implement:
- New Prisma models: `ReviewRequest { id, vendorId, customerPhone, customerName?, sentAt, openedAt?, reviewedAt?, source }`
- POST `/api/vendor/review-requests/bulk` { customers: [{phone, name?}, ...] } — vendor sends a batch (cap at 50/day to start)
- WhatsApp send: new approved template `pets24x7_review_request` with placeholder for business name + a short link
- Short-link route: GET `/r/:reviewId` → mark openedAt, redirect to vendor's Google reviews URL (`https://search.google.com/local/writereview?placeid=...` or `https://www.google.com/maps?cid=<cid>`)
- Vendor dashboard tile: total sent, opened, completed (best-effort — completion = re-checking GMB rating count delta in Phase 3.2)
- Admin throttle: max 50 review requests per vendor per day; rate-limit at the route layer

### 3.2 Google reviews import (HIGH)
**Goal:** Pull live review counts + recent reviews into vendor dashboard so vendors can see their climb after sending requests.

Approach: Google Places API (Place Details). Requires `GOOGLE_PLACES_API_KEY` in `.env`. Use the `google_cid` we already have in static listings to look up Place ID once and cache it on `Vendor.placeId`.

Endpoints to add:
- Background job: nightly cron (`node-cron` or Railway scheduled task) refreshes each vendor's `reviewCount`, `rating`, `lastReviews[]` (cap 5)
- New Prisma model: `VendorReviewSnapshot { id, vendorId, rating, reviewCount, snapshotAt }` — keep history for trend chart
- API: `GET /api/vendor/reviews` returns current + 30-day trend

### 3.3 Customer-invite QR + share link (MEDIUM)
- Vendor dashboard generates a QR code (use `qrcode` npm package) that encodes `https://pets24x7.com/v/<slug>` → that page is a "join Pets24x7, get member deals at this vendor" CTA
- Track invite source on PetParent signup (`signupSource`, `signupVendorId` columns)

### 3.4 Listing photo upload (MEDIUM)
- Vendors upload up to 5 photos
- Storage: Supabase Storage (free tier 1 GB) — use `@supabase/supabase-js` only here
- Vendor.photoUrls JSONB column
- Pre-rendered listing pages should fall back to these photos instead of Unsplash placeholders when present — requires `build_pages.py` enhancement to read DB at build time (or pull via API JSON at render time as an enhancement)

### Phase 4 (later)
- Meta Marketing API: vendor connects FB ad account via OAuth, drafts ad, admin approves, we publish to vendor's account. Library: `facebook-nodejs-business-sdk`.
- Instagram + GMB review aggregation in same model as Google.

### Phase 5 (later)
- `Deal`, `Event` tables. Parent dashboard surfaces nearby deals via geolocation (vendor lat/lng — currently we don't have them; need geocoding pass on the listings using Google Geocoding API).

## Open product decisions (ask the user)

1. **Review-request copy** — do we want the WhatsApp template to push them to Google Reviews OR a Pets24x7-hosted review form (so we own the review data)?
2. **Membership refund window** — currently `TermsOfService` says "7 days, only if no benefit redeemed". Need to wire actual refund logic to PhonePe `POST /pg/v1/refund` endpoint.
3. **Vendor multi-listing** — chains have multiple listings under one phone. Currently `Vendor.listingId` is one-to-one. Should we add a `VendorLocation` junction table now or defer?
4. **GA4 / analytics** — not wired yet. Add via `<script async src="...gtag/js?id=G-XXX">` injection through `build_pages.py` template.

## Local bring-up checklist

```bash
# Backend
cd pets24x7_api
cp .env.example .env
# Fill: DATABASE_URL (Supabase pooler), JWT_SECRET (96 random hex),
#       ADMIN_SESSION_SECRET, WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN,
#       WA_BUSINESS_ACCOUNT_ID, WA_VERIFY_TOKEN, PHONEPE_MERCHANT_ID,
#       PHONEPE_SALT_KEY, PHONEPE_SALT_INDEX, SEED_ADMIN_*
npm install
npm run prisma:gen
npm run prisma:migrate
npm run seed:admin
npm run seed:plans
npm run dev     # http://localhost:4000

# Frontend (separate terminal)
cd pets24x7_new
python -m http.server 8000   # http://localhost:8000
```

End-to-end test in `HANDOFF.md` §5.

## How to verify changes you make

1. `npm run lint` in `pets24x7_api/` runs `tsc --noEmit` — must pass with zero errors before commit
2. Smoke flow: parent signup → vendor claim → admin approve → membership checkout → admin payments view
3. Frontend: load each page over HTTP (not file://) — clean URLs require server
4. Run `python build_pages.py` if you change `build_pages.py` itself or its template strings — regenerates 35k pages, ~3-5 min

## Security checklist (always)

- Never log secrets (`.env` values, JWT tokens, OTP codes, payment keys)
- Never echo `.env` contents in PR diffs
- Always SHA256-hash OTP codes before DB write (`src/whatsapp/otp.ts` does this — follow the pattern)
- Always verify PhonePe callback `X-VERIFY` header before trusting payload (`src/payments/phonepe.ts → verifyCallback()` does this)
- Always use Prisma parameterized queries — never raw string interpolation in `$queryRaw`
- Always use `bcrypt.compare` (constant time) for password checks
- Always rate-limit new auth endpoints (`express-rate-limit` already imported in `server.ts`)

## File-map quick reference

```
pets24x7_api/src/
├── server.ts                           Express bootstrap + middleware
├── env.ts                              Zod-validated env vars
├── db.ts                               Prisma client singleton
├── logger.ts                           pino
├── shared/
│   ├── errors.ts                       HttpError + typed subclasses
│   ├── async-handler.ts                wraps async route handlers
│   └── phone.ts                        E.164 normalization
├── auth/
│   ├── jwt.ts                          sign + verify + cookie helpers per role
│   ├── middleware.ts                   requireAuth(role), requireAnyAuth([...])
│   ├── parent.routes.ts                request-otp + verify
│   ├── vendor.routes.ts                request-otp (phone match) + verify (claim)
│   ├── admin.routes.ts                 email+password login (REST)
│   └── me.routes.ts                    whoami + logout-all
├── whatsapp/
│   ├── cloud-api.ts                    Meta Graph API client
│   ├── otp.ts                          issue + verify (hashed, 10min TTL, 5 attempts)
│   └── webhook.routes.ts               Meta delivery + inbound webhook
├── listings/
│   ├── index.ts                        loads ../pets24x7_new/data/*.json at boot
│   └── lookup.routes.ts                public listing lookup + by-phone (rate-limited)
├── pets/
│   └── parent.routes.ts                Parent dashboard + Pet CRUD
├── vendors/
│   └── dashboard.routes.ts             Vendor dashboard + profile patch
├── payments/
│   ├── phonepe.ts                      PhonePe REST client + signing
│   ├── membership.routes.ts            plans, checkout, status, applyPaymentResult()
│   └── phonepe.routes.ts               S2S callback handler
└── admin/
    ├── panel.routes.ts                 EJS-rendered /admin
    └── views/                          7 EJS templates
        ├── _head.ejs, _foot.ejs
        ├── login.ejs, dashboard.ejs
        ├── vendors.ejs, parents.ejs, enquiries.ejs
        ├── memberships.ejs, payments.ejs

pets24x7_new/
├── index.html, marketing.html, privacy.html, terms.html, 404.html
├── city.html, listing.html             Legacy fallbacks (JS-redirect to clean URLs)
├── login/, parent-login/, vendor-login/  Auth UI
├── dashboard/parent/, dashboard/vendor/  Dashboards
├── membership/, membership/return/     PhonePe checkout pages
├── api-client.js                       Shared fetch wrapper (window.api.*)
├── config.js                           Single-source: API base, sheet URLs
├── styles.css                          Shared CSS for pre-rendered pages
├── pets-data.js, pets-loader.js        Auto-generated index + live CSV sync
├── data/<country>-<city>.json          570 per-city listing files
├── pets.csv                            Flat listing snapshot
├── pets24x7_logo.png, sitemap.xml, robots.txt
├── .htaccess, _redirects, _headers, netlify.toml, vercel.json   Deploy configs
├── build_data.py, build_pages.py       Regenerate pets-data.js + 35k SEO pages
├── start_local.bat, pack_for_hostinger.bat
├── SETUP.md, HOSTINGER-DEPLOY.md
└── LEADS-APPS-SCRIPT.gs                Google Apps Script for form leads sheet
```

## Your first task suggestion

If the human gives no specific direction, start with **Phase 3.1 — Vendor review-request flow**. It's the next user-visible feature with the highest ROI for vendor retention. Plan: model → routes → frontend tile → admin throttle. Open a PR per logical chunk.

---

**End of CONTINUE-PROMPT.**
