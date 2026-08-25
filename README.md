# Pets24x7 — pet services marketplace

Two-folder monorepo. Frontend ships static SEO pages + dashboards; backend handles auth, payments, admin.

```
Pets24x7_AI/
├── pets24x7_new/      Static frontend  (deploy: Hostinger via .htaccess)
├── pets24x7_api/      Node + TS + Prisma  (deploy: Railway + Supabase Postgres)
├── HANDOFF.md         Full project onboarding (12 sections, ~10 min read)
├── CONTINUE-PROMPT.md Paste this into a fresh AI-IDE chat (Antigravity / Cursor / Claude Code) to resume
└── README.md          You are here
```

## Status

| Phase | Status | Highlights |
|---|---|---|
| 1   | ✅ shipped | 35k pre-rendered SEO pages · schema.org markup · static-listing JSON index · admin EJS panel · WhatsApp OTP auth (parent + vendor claim) |
| 1.5 | ✅ shipped | `/login/`, `/parent-login/`, `/vendor-login/`, `/dashboard/parent/`, `/dashboard/vendor/` |
| 2   | ✅ shipped | Bronze/Silver/Gold memberships · PhonePe Standard Checkout · admin memberships + payments views |
| 3   | ⏳ next    | Review-request flow (vendor → past customers via WhatsApp) · Google Places reviews import · review dashboards |
| 4   | ⏳ later   | FB / IG / GMB OAuth · Meta Marketing API ad drafts → admin approve → publish |
| 5   | ⏳ later   | Deals + events tables · nearby feed · email/WhatsApp digest |

## Stack

| Layer | Tech |
|---|---|
| Frontend | HTML + vanilla JS + CSS (no build step) |
| Backend | Node 20 · TypeScript · Express 5 · Prisma · Zod · pino · ejs · bcrypt |
| Database | PostgreSQL (Supabase) |
| Auth | JWT in httpOnly cookies, 3 cookies (parent/vendor/admin), scoped to `.pets24x7.com` |
| WA OTP | Meta WhatsApp Cloud API (template `pets24x7_otp`) |
| Payments | PhonePe Standard Checkout (SHA256 X-VERIFY, base64 payload) |
| Forms | Google Apps Script → Google Sheet (legacy) + DB (in progress) |

## Quick start

```bash
# Backend
cd pets24x7_api
cp .env.example .env             # fill DATABASE_URL, JWT_SECRET, WA_*, PHONEPE_*
npm install
npm run prisma:migrate
npm run seed:admin
npm run seed:plans
npm run dev                      # http://localhost:4000

# Frontend (separate terminal)
cd pets24x7_new
python -m http.server 8000       # http://localhost:8000
```

End-to-end test flow in `HANDOFF.md` §5.

## Deploys

- **Frontend** → Hostinger. See `pets24x7_new/HOSTINGER-DEPLOY.md`. `.htaccess` handles clean URLs + redirects.
- **Backend** → Railway. See `pets24x7_api/README.md`. Add CNAME `api → <railway>.up.railway.app`.
- **Database** → Supabase (free tier covers 5k vendors).

## Live URLs

- https://pets24x7.com — static site
- https://api.pets24x7.com — Node API
- https://api.pets24x7.com/admin — admin panel

## Contact

WhatsApp: +91 99300 90487 · Email: hello@pets24x7.com
