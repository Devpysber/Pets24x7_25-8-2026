# Pets24x7 API — Node + Express + Prisma + Postgres

Backend for [pets24x7.com](https://pets24x7.com). The static SEO frontend stays on Hostinger; this API runs on Railway and serves:

- **Pet Parent** auth + dashboard + pet profile CRUD
- **Vendor** auth via WhatsApp OTP, with phone-matched claim against the 34k static listings
- **Admin** EJS panel at `/admin` for approving vendor claims, browsing parents, viewing enquiries

> Phase 1 ships auth + claim + 3 dashboard skeletons. Memberships, payments, FB ad drafts, reviews collection, deals/events come in later phases — schema is intentionally prepared for them.

---

## 1 · Local dev setup

```bash
# Prereqs: Node 20+, npm 10+
git clone <this folder> pets24x7_api
cd pets24x7_api
cp .env.example .env       # fill in DATABASE_URL + WA_* + JWT_SECRET
npm install
npm run prisma:gen
npm run prisma:migrate     # first time: creates dev migration
npm run seed:admin         # creates the first admin from SEED_ADMIN_* env vars
npm run dev                # boots at http://localhost:4000
```

Health check: `curl http://localhost:4000/health`.

The server expects the static frontend's `data/` folder next door (`../pets24x7_new/data`). That's how vendor phone-match lookup works — see `STATIC_DATA_DIR` in `.env`.

---

## 2 · Supabase (Postgres) — 10 min setup

1. https://supabase.com → new project. Pick the closest region (Mumbai for India-heavy traffic).
2. **Settings → Database → Connection string → URI**. Copy the **session pooler** URI (port 6543). Stash the **password** they show — Supabase only displays it once.
3. Paste into `DATABASE_URL` in `.env`. Example:
   ```
   DATABASE_URL="postgresql://postgres.xxxxxxxxxxx:YOUR_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"
   ```
4. Run `npm run prisma:migrate` → creates the schema.
5. Optional: open Prisma Studio with `npm run prisma:studio` to inspect tables.

> Use the **pooler URI (6543)** for the runtime, not the direct connection (5432). Railway opens many short connections; the pooler is what keeps you within Supabase's free-tier connection limit.

---

## 3 · WhatsApp Cloud API (Meta) — 30 min setup

1. **Create / open a Meta Business Manager** at business.facebook.com.
2. **WhatsApp → API Setup** → add a phone number → request a permanent access token (Phase 1 use: temp token from the API Setup page is fine for the first week).
3. Note down:
   - `WA_PHONE_NUMBER_ID`   (under "From")
   - `WA_BUSINESS_ACCOUNT_ID` (top of the page)
   - `WA_ACCESS_TOKEN`
4. **Message Templates → Create template** (you need TWO templates):

   **a. OTP login template:**
   - Category: **Authentication**
   - Name: `pets24x7_otp` (matches `WA_OTP_TEMPLATE_NAME`)
   - Language: English (matches `WA_OTP_TEMPLATE_LANG`)
   - Body: `Your Pets24x7 verification code is {{1}}. It expires in 10 minutes.`
   - Add a "Copy code" button (Authentication template auto-supports this).
   - Submit for approval — Meta usually approves authentication templates in < 1 hour.

   **b. Review-request template (Phase 3.1):**
   - Category: **Marketing** (or Utility — Marketing has stricter rules but is fine here)
   - Name: `pets24x7_review_request` (matches `WA_REVIEW_TEMPLATE_NAME`)
   - Language: English
   - Body: `Hi {{1}}! How was your recent visit to {{2}}? Help other pet parents find them — leave a quick review here (1 tap): {{3}}`
   - Three variables:
     - `{{1}}` → customer name (e.g. "Priya")
     - `{{2}}` → business name (e.g. "Furry Tails Vet")
     - `{{3}}` → short-link (e.g. `https://pets24x7.com/r/A1B2C3D4`)
   - No buttons needed (link is in body).
   - Marketing templates take 24-48 hours for approval.
5. **Webhooks** (after the API is deployed):
   - Callback URL: `https://api.pets24x7.com/api/whatsapp/webhook`
   - Verify Token: same value you set as `WA_VERIFY_TOKEN`
   - Subscribe to: `messages`, `message_status`

> First 1,000 conversations/month are free on Cloud API. OTP delivery in India costs ≈ ₹0.40-0.60 per template above that — cheaper than Twilio, cheaper than SMS.

---

## 4 · Deploy to Railway

```bash
# Install once
npm i -g @railway/cli
railway login

# In this folder
railway init                    # link to a new project
railway link                    # ...or to existing
railway variables --set "DATABASE_URL=<from-supabase>" \
                   --set "JWT_SECRET=<random>" \
                   --set "WA_PHONE_NUMBER_ID=..." \
                   ...etc
railway up                      # builds and deploys
```

Then in the Railway dashboard:
- **Settings → Networking → Custom domain** → add `api.pets24x7.com`.
- It gives you a CNAME target like `abc.up.railway.app`.

In Hostinger hPanel:
- **Domains → DNS / Nameservers → Add record**:
  - Type: `CNAME`, Name: `api`, Points to: `abc.up.railway.app`
- Wait 15-30 min for propagation.
- Railway auto-provisions Let's Encrypt SSL for the subdomain.

---

## 5 · API surface (Phase 1)

```
GET  /health

# Pet Parent
POST /api/parent/request-otp     { phone, name?, email?, city?, country? }
POST /api/parent/verify          { phone, code }                              → cookie p24_parent
GET  /api/parent/dashboard
GET  /api/parent/pets
POST /api/parent/pets            { name, species, breed?, ageYears?, ... }
PATCH/api/parent/pets/:id
DELETE /api/parent/pets/:id

# Vendor (WhatsApp OTP + listing claim)
POST /api/vendor/request-otp     { phone }
  → if phone matches a listing in our 34k → returns matches + sends OTP
  → if no match → returns matches:[], hint:"no_match" (no OTP burned)
POST /api/vendor/verify          { phone, code, listingId, businessName?, email? }
                                                                              → cookie p24_vendor
GET  /api/vendor/dashboard
GET  /api/vendor/listing
PATCH/api/vendor/profile         { businessName?, email? }

# Admin
POST /api/admin/login            { email, password }                          → cookie p24_admin
POST /api/admin/logout

# All roles
GET  /api/me                     → { role, user }
POST /api/me/logout              → clears all 3 role cookies

# Listings (public)
GET  /api/listings/:id
GET  /api/listings/by-phone?p=<phone>     rate-limited

# Webhook (Meta)
GET  /api/whatsapp/webhook       (verification handshake)
POST /api/whatsapp/webhook       (delivery + inbound events)

# Admin panel (server-rendered EJS, cookie-auth)
GET  /admin/login
GET  /admin/dashboard
GET  /admin/vendors?status=PENDING|ACTIVE|REJECTED|SUSPENDED
POST /admin/vendors/:id/approve
POST /admin/vendors/:id/reject   form-body: reason
GET  /admin/parents
GET  /admin/enquiries
```

Auth model: **JWT in httpOnly cookies**, one per role (`p24_parent`, `p24_vendor`, `p24_admin`). 30-day TTL. Cookies scoped to `.pets24x7.com` so the static frontend on `pets24x7.com` and the API on `api.pets24x7.com` share auth state.

---

## 6 · Wiring the static frontend

Once API is live, the static site adds three small JS modules (one per role) that hit the API and stash the role in `localStorage` for UI state. The cookies handle the actual auth — no JWT exposed to JS.

Example login flow (vendor):

```html
<!-- Add to /vendor-login/index.html on the static site -->
<script>
async function requestOtp(phone) {
  const r = await fetch('https://api.pets24x7.com/api/vendor/request-otp', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ phone })
  });
  return r.json();
}
async function verify(phone, code, listingId, businessName) {
  const r = await fetch('https://api.pets24x7.com/api/vendor/verify', {
    method: 'POST', credentials: 'include',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ phone, code, listingId, businessName })
  });
  return r.json();
}
async function me() {
  const r = await fetch('https://api.pets24x7.com/api/me', { credentials: 'include' });
  return r.json();
}
</script>
```

We'll generate these pages + JS modules in **Phase 1.5** once the API is deployed.

---

## 7 · What's next (Phase 2+)

| Phase | Adds |
|---|---|
| 2 | Membership tiers + Razorpay (India) checkout · Pet profile vaccination reminders via WhatsApp |
| 3 | Vendor → customer review-request flow · Reviews import from Google Places API |
| 4 | FB / Instagram / GMB OAuth · Vendor draft → admin approve → publish via Meta Marketing API |
| 5 | Deals + events tables · "Nearby deals" feed for parents · email/WhatsApp digest |

---

## 8 · Files in this repo

```
package.json          deps + npm scripts
tsconfig.json         strict TypeScript, ES2022 modules
.env.example          all required env vars documented
prisma/
  schema.prisma       all Phase 1 models + enums
  seed-admin.ts       bootstrap first admin from .env
src/
  server.ts           express bootstrap, cors, error middleware, route mounting
  env.ts              Zod-validated env vars
  db.ts               PrismaClient singleton (hot-reload safe)
  logger.ts           pino + pino-pretty in dev
  shared/             errors, asyncHandler, phone normalisation
  auth/
    jwt.ts            sign/verify + cookie helpers per role
    middleware.ts     requireAuth(role), requireAnyAuth([...])
    parent.routes.ts  request-otp + verify (Pet Parent)
    vendor.routes.ts  request-otp + verify + claim (Vendor)
    admin.routes.ts   login (Admin, REST)
    me.routes.ts      whoami + logout-all
  whatsapp/
    cloud-api.ts      Meta Graph API client (template + text send)
    otp.ts            issue + verify (hashed code, 10min TTL, 5 attempts)
    webhook.routes.ts Meta delivery + inbound webhook
  listings/
    index.ts          loads ../pets24x7_new/data/*.json into memory on boot
    lookup.routes.ts  public listing lookup + by-phone search (rate-limited)
  pets/
    parent.routes.ts  Parent dashboard + Pet CRUD
  vendors/
    dashboard.routes.ts Vendor dashboard + profile patch
  admin/
    panel.routes.ts   EJS-rendered /admin (cookie auth, no SPA)
    views/            EJS templates (login, dashboard, vendors, parents, enquiries)
```

---

## 9 · Common questions

**Q: Does this replace the Google Sheet for form submissions?**
A: No — Phase 1 keeps the Sheet (via Apps Script) AND will mirror enquiries into Postgres once the static site is wired. You get both: a real-time DB for the admin panel, plus the Sheet for offline review.

**Q: What if a vendor's phone changes?**
A: They can't currently re-claim a listing under a new number — the listing's stored phone won't match. Phase 2 will add an admin-mediated "change vendor phone" action.

**Q: What if the same phone is on multiple listings (chains)?**
A: Listed in `by-phone` response with multiple matches. Vendor picks one at `verify` time. Phase 2 adds multi-listing dashboards for chains.

**Q: Can we run the backend on Hostinger Business?**
A: Yes, but Hostinger's Node.js hosting kills long-lived processes after idle periods — that breaks the boot-time listing index. Railway/Render/Fly stay warm; recommended.
