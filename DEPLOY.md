# Pets24x7 — VPS deploy runbook (Hostinger `srv1891796.hstgr.cloud` / `148.230.66.88`)

Status: **not executed.** No SSH password or key was provided, the box is
multi-tenant (`root`), and a production deploy is outward-facing and hard to
reverse. Run this yourself, or paste an SSH key / password + explicit go-ahead
and it can be run for you.

Everything below is scoped so **no other site on the box is touched**:
- own Linux user `pets24x7` (no root services)
- own MySQL database `pets24x7` + DB user `pets24x7@localhost` (no shared grants)
- own systemd unit `pets24x7-api.service`
- own nginx server block for `api.pets24x7.com` only — no edits to `nginx.conf`
  or any existing `sites-enabled/*`
- Node installed under the `pets24x7` user via `nvm` — no system-wide apt Node,
  no version bump for anything already installed

---

## 0. Prereqs on the box (check, don't clobber)

```bash
ssh root@148.230.66.88
nginx -v                 # already present on a Hostinger stack — keep it
mysql --version          # MySQL/MariaDB already present — keep it
ls /etc/nginx/sites-enabled/   # note existing vhosts, do NOT edit them
```

If nginx or MySQL is missing, install with apt (`apt-get install -y nginx mysql-server`)
— that is additive and safe. Do not `apt upgrade`.

---

## 1. Dedicated user + code

```bash
adduser --system --group --shell /bin/bash --home /opt/pets24x7 pets24x7
su - pets24x7

# Node 20 via nvm (user-scoped, touches nothing system-wide)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 20
nvm alias default 20

git clone <YOUR_REPO_URL> app        # or rsync the project dir up
cd app/pets24x7_api
npm ci
```

---

## 2. MySQL — isolated DB + user

As `root` (or any admin MySQL account):

```sql
CREATE DATABASE pets24x7 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pets24x7'@'localhost' IDENTIFIED BY 'REPLACE_WITH_STRONG_PW';
GRANT ALL PRIVILEGES ON pets24x7.* TO 'pets24x7'@'localhost';
FLUSH PRIVILEGES;
```

Grant is scoped to `pets24x7.*` only — this user cannot see other schemas.

### Create the tables

`prisma/schema.prisma` is committed with `provider = "mysql"`, so there is no
provider flip any more (an older version of this guide `sed`-ed it over from
Postgres). Local development therefore needs a MySQL 8 server as well; the
embedded-Postgres helper (`npm run db:local`) no longer matches the schema.

```bash
cd /opt/pets24x7/app/pets24x7_api
npx prisma generate
npx prisma db push        # fresh DB, no migration history needed
```

Once, after loading listings from an old export: a spreadsheet round-trip left
~580 Google CIDs as `6.60859E+18`. The API already ignores them; this blanks them
in the table too (dry run first, then `--apply`):

```bash
node scripts/clean-listing-cids.mjs
node scripts/clean-listing-cids.mjs --apply
```

---

## 3. `pets24x7_api/.env` on the server (production)

```ini
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
# Cloudflare -> nginx -> Node is two proxy hops. With the default of 1 every
# rate limit keys on a Cloudflare edge IP (all visitors on that edge share one
# OTP / login budget). Use 1 only if nginx sets real_ip from CF-Connecting-IP.
TRUST_PROXY=2

PUBLIC_SITE_URL=https://pets24x7.com
PUBLIC_API_URL=https://api.pets24x7.com

DATABASE_URL="mysql://pets24x7:REPLACE_WITH_STRONG_PW@localhost:3306/pets24x7"

# generate fresh: openssl rand -hex 48
JWT_SECRET="___64+_hex___"
JWT_ISSUER="pets24x7.com"
COOKIE_DOMAIN=""
ADMIN_SESSION_SECRET="___64+_hex___"

# WhatsApp Cloud API — real credentials needed for OTP send to work
WA_PHONE_NUMBER_ID="..."
WA_BUSINESS_ACCOUNT_ID="..."
WA_ACCESS_TOKEN="..."
WA_VERIFY_TOKEN="..."
WA_OTP_TEMPLATE_NAME="pets24x7_otp"
WA_OTP_TEMPLATE_LANG="en"
WA_REVIEW_TEMPLATE_NAME="pets24x7_review_request"
WA_REVIEW_TEMPLATE_LANG="en"
PUBLIC_SHORTLINK_BASE="https://pets24x7.com"

# GST invoices: set your GSTIN to issue a "Tax invoice" (optional rate, default 18)
SELLER_GSTIN=""
# GST_RATE_PERCENT=18

# The API reads the bundled city files here when the listings table is empty,
# and keeps its JSON mirror (imported_listings.json) here. The mirror is never
# published: the publish leaves it out of every release and nginx serves only
# <cc>-<city>.json under /data/.
STATIC_DATA_DIR="/opt/pets24x7/app/pets24x7_new/data"

# Razorpay — dashboard.razorpay.com -> Settings -> API Keys.
RAZORPAY_KEY_ID="rzp_live_xxxxxxxxxxxxx"
RAZORPAY_KEY_SECRET=___from_the_razorpay_dashboard___
RAZORPAY_WEBHOOK_SECRET="xxxxxxxxxxxxxxxxxxxxxxxx"

SEED_ADMIN_EMAIL="founder@pets24x7.com"
SEED_ADMIN_PASSWORD="___strong___"
SEED_ADMIN_NAME="Pets24x7 Founder"

# ---- Razorpay (LIVE) ----
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=___from_the_razorpay_dashboard___
RAZORPAY_WEBHOOK_SECRET=___set_after_creating_webhook___

# ---- Google Sign-In ----
# OAuth 2.0 Web client id (Google Cloud Console -> APIs & Services -> Credentials).
# Public by design; the site reads it back from GET /api/config.
# When this is empty the "Continue with Google" button silently does not render
# on /login/ and /parent-login/. Authorised JavaScript origin must include
# https://pets24x7.com (and https://www.pets24x7.com if used).
GOOGLE_CLIENT_ID=433529532768-01i1g547fpv9shh082srs2p5uv6tve3t.apps.googleusercontent.com
```

`chmod 600 .env`.

> **Never put a real key in this file.** It is tracked, and this repository is
> public — a value committed here is world-readable the moment it is pushed, and
> stays readable in the history afterwards. Live Razorpay credentials were
> committed here previously and must be treated as compromised: regenerate them
> in the Razorpay dashboard (Settings - API Keys - Regenerate). Real values
> belong only in `/opt/pets24x7/app/pets24x7_api/.env` on the server, which is
> gitignored and `chmod 600`.

---

## 4. Build + run

```bash
cd /opt/pets24x7/app/pets24x7_api
npm run build            # tsc -p . && scripts/copy-assets.mjs (copies admin .ejs views)
# smoke test:
node dist/server.js &    # expect "pets24x7-api ready ... (NODE_ENV=production)"; then kill it
```

### systemd unit — `/etc/systemd/system/pets24x7-api.service`

```ini
[Unit]
Description=Pets24x7 API
After=network.target mysql.service

[Service]
Type=simple
User=pets24x7
WorkingDirectory=/opt/pets24x7/app/pets24x7_api
ExecStart=/opt/pets24x7/.nvm/versions/node/v20.19.0/bin/node dist/server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/pets24x7
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

(fix the node path: `readlink -f $(which node)` as the `pets24x7` user)

```bash
systemctl daemon-reload
systemctl enable --now pets24x7-api
systemctl status pets24x7-api
curl -s localhost:4000/health     # {"ok":true,...}
```

---

## 5. nginx — new server block ONLY

`/etc/nginx/sites-available/api.pets24x7.com`:

```nginx
server {
    listen 80;
    server_name api.pets24x7.com;

    client_max_body_size 11m;

    location / {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/api.pets24x7.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx      # -t proves no other vhost broke
certbot --nginx -d api.pets24x7.com     # adds 443 to THIS block only
```

The static site (`pets24x7_new/`) is already hosted wherever `pets24x7.com`
points today — leave it. The frontend calls `https://api.pets24x7.com` directly
(`api-client.js`), CORS already allows `*.pets24x7.com` with credentials, and the
JWT cookies are `SameSite=Lax; Secure` which is fine across `pets24x7.com` -
`api.pets24x7.com` (same site). If the site is served from the bare apex
`pets24x7.com`, keep `PUBLIC_SITE_URL=https://pets24x7.com` so that exact origin
is allowed (the `*.pets24x7.com` regex does not match the apex).

---

## 6. Cloudflare

Account `Shah.antriksh@gmail.com`, zone `pets24x7.com`
(`ff21c60394949770dd5cefd312024b07`).

1. **DNS**: add `A  api  148.230.66.88`, proxied (orange cloud) is fine.
2. **Under Attack Mode is ON for this zone.** Razorpay's webhook is a
   server-to-server POST — a JS challenge will silently drop it. Add a
   **Configuration Rule / WAF skip** for:
   ```
   (http.host eq "api.pets24x7.com")
   ```
   - Security Level: Essentially Off, **or**
   - at minimum skip Managed Challenge for
     `http.host eq "api.pets24x7.com" and starts_with(http.request.uri.path, "/api/payments/")`
   Otherwise `/api/payments/razorpay/webhook`
   will 403/challenge.
3. SSL/TLS mode: **Full (strict)** once certbot has issued the cert in step 5.

---

## 7. Razorpay dashboard

- Settings - Webhooks - Add:
  - URL `https://api.pets24x7.com/api/payments/razorpay/webhook`
  - Secret: generate one, put it in `.env` as `RAZORPAY_WEBHOOK_SECRET`, restart the service
  - Events: `payment.captured`, `payment.failed`, `order.paid`
- Verified working locally: live key auth + order create returns HTTP 200
  (`order_...` id). Signature verify is `HMAC_SHA256(order_id|payment_id, key_secret)`;
  webhook verify is `HMAC_SHA256(rawBody, webhook_secret)` vs `X-Razorpay-Signature`.

---

## 8. Deploy-update loop (later)

```bash
su - pets24x7 -c '
  cd ~/app && git pull &&
  cd pets24x7_api &&
  sed -i "s/provider = \"postgresql\"/provider = \"mysql\"/" prisma/schema.prisma &&
  npm ci && npx prisma generate && npx prisma db push && npm run build
'
systemctl restart pets24x7-api
```

---

## 9. Static site on the same VPS

The Hostinger shared host (`92.112.197.198`) started returning 403 on `/` with
404 on every real file — an empty docroot — and its TLS stopped answering, so
the site moved to this box.

```bash
# from the repo root, local:
tar -czf /tmp/site.tgz -C pets24x7_new .
scp /tmp/site.tgz root@148.230.66.88:/tmp/site.tgz

# on the server: build into a release directory, then point the docroot at it.
# /var/www/pets24x7 MUST end up a symlink, not a directory — pets24x7-deploy.sh
# rolls out by swapping that symlink onto a new release, and `mv -T` a symlink
# onto a real directory fails with "Directory not empty". Setting it up as a
# plain directory is what silently pinned the site to its first deploy while
# every later render was built and then thrown away.
REL=/var/www/pets24x7-releases/$(date +%Y%m%d%H%M%S)
mkdir -p "$REL"
tar -xzf /tmp/site.tgz -C "$REL" && rm /tmp/site.tgz
ln -sfn "$REL" /var/www/pets24x7
```

### Pre-render the SEO pages — do not skip

The repo ships templates and `data/*.json`, **not** the ~36k rendered pages.
`sitemap.xml` lists 36,396 URLs, so without this step every city, category and
listing URL 404s.

```bash
cd "$REL" && python3 build_pages.py              # ~36,392 pages, rewrites sitemap.xml
chown -R www-data:www-data "$REL"
find "$REL" -type d -exec chmod 755 {} +
find "$REL" -type f -exec chmod 644 {} +
```

Roughly 1.1 GB and 38k files when built. That manual render is for the very
first install only. From then on every render is `pets24x7-publish.sh`, which
exports the listings table first (section 10): a hand-run `build_pages.py`
renders the `data/*.json` from git, which lacks every admin edit.

### nginx

`/etc/nginx/sites-available/pets24x7.com` (apex + a `www` -> apex block) ports
the `.htaccess` rules: legacy `city.html` / `listing.html` query-string 301s,
`/IN/` -> `/in/`, trailing-slash 301, review short-links, `/r/<CODE>` -> API 302,
the fallback for cities and listings without a pre-built page (a
`@listing_fallback` named location: category slugs and `/page/<n>/` ->
`city.html`, any other third segment -> `listing.html`, a bare city ->
`city.html`, served in place so the clean URL stays), pretty 404, cache headers
(`/data/` 5 minutes, content-hashed `/media/` immutable), and the deny rules for
dotfiles / `.py` / `.md` / `_headers`. Under `/data/` only the
`<cc>-<city>.json` files the pages fetch are served; anything else there
(the API's `imported_listings.json` mirror sits in the same directory of the
checkout) is a 404. The deploy does not install nginx configs: copy a changed
`ops/nginx-pets24x7.com.conf` by hand and `nginx -t && systemctl reload nginx`.

Two nginx gotchas worth remembering:

- Regexes containing `{n,m}` must be quoted, or nginx parses the brace as a
  block delimiter.
- `add_header` does not inherit into a `location` that sets its own. The four
  security headers therefore live in `/etc/nginx/snippets/pets24x7-security.conf`
  and are `include`d by every location, not declared once at server level.

### DNS + TLS

Point `pets24x7.com` and `www` at `148.230.66.88`, leaving `mail`, MX, SPF,
DKIM and DMARC on Hostinger, then:

```bash
certbot --nginx -d pets24x7.com -d www.pets24x7.com --agree-tos -m <email> --redirect
```

---

## 10. Managing listings

The `listings` table in MySQL is the directory. The admin panel edits it; the
public site shows it in two layers:

- **The API** (`/api/listings/*`, the enquiry form, recommendations, the
  generic `/city.html` and `/listing.html` pages) reads the table live. A change
  there is visible within seconds.
- **The pre-rendered pages** (`/in/<city>/…`, `/us/<city>/…`, the sitemaps)
  and the per-city `data/*.json` files are a snapshot, rebuilt by a
  **publish**. That is what Google indexes and what a first page load shows.

### What the admin panel does

The admin panel (`/dashboard/admin/`) drives these endpoints; each can also
be called directly with an admin session:

| Task | Endpoint |
|---|---|
| Add one listing (duplicate check first; `force: true` to add anyway) | `POST /api/admin/listings` |
| Bulk import from CSV / XLSX / Google Sheet (preview, then commit) | `POST /api/admin/import/preview`, `…/import/commit` |
| Edit name, category, address, phone, website, description, hours, services, locality, WhatsApp | `PATCH /api/admin/listings/:id` |
| Hide / show (hidden listings stay in the admin directory, vanish from every public API and from the next publish) | `POST /api/admin/listings/:id/hide`, `…/unhide` |
| Photos (add, replace the set, remove one) | `POST`/`PUT /api/admin/listings/:id/photos`, `DELETE …/photos/:idx` |
| Delete | `DELETE /api/admin/listings/:id` |
| Publish the site now (the panel's **Publish site** button, where present) | `POST /api/admin/publish` → `202`; last run: `GET /api/admin/publish/status` |

When a business has claimed its listing and its account is approved, the
vendor's own profile (about, hours, services, photos, website, WhatsApp) wins
over the listing's columns on the public page — in the API and in the publish
alike. The listing's columns remain the directory's copy underneath.

Photos stored as data URLs are written out by the publish as content-hashed
files under `/media/listings/`, so pages never embed the image bytes.
`Listing.email` is not published (the public API does not serve it either).
`Listing.whatsapp` is published only for a claimed listing: the pages send an
unclaimed listing's enquiries to the platform's number and never read it.

### How a publish works

`ops/pets24x7-publish.sh`, run as `pets24x7-publish.service`:

1. takes `/run/pets24x7-publish.lock` (runs never overlap; a second run waits);
2. copies `pets24x7_new/` from the checkout into a fresh
   `/var/www/pets24x7-releases/<timestamp>-<tag>/` (`rsync -rlt`: no owner
   or group comes across), leaving out `data/imported_listings.json`, the
   API's JSON mirror (`STATIC_DATA_DIR` points into the checkout). The copy
   runs as `pets24x7` into an empty directory handed to that user: root never
   reads the checkout by path, where that user could swap a file for a
   symlink mid-copy and have root copy a root-only file into the docroot;
3. `node scripts/export-listings-static.mjs` (as `pets24x7`, reading the
   API's `.env`) writes every non-hidden listing into that release's
   `data/<cc>-<city>.json` and `pets-data.js` — keyset-paged, sorted, only
   changed files rewritten; a city whose last listing was hidden or deleted
   loses its file; photos are decoded and written a batch at a time;
4. `build_pages.py` renders `in/`, `us/` and the sitemaps into the release,
   as `pets24x7` (`runuser`), never as root: the checkout is that user's, so
   root must not run code from it;
5. takes the release back from `pets24x7`: walked by file descriptor, each
   directory handed to `www-data` and made 755 before it is listed, each file
   644. Links are never followed; a symlink, FIFO, socket or hard-linked file
   in the release fails the publish (the site has none of its own);
6. checks it: pages exist, the page count has not dropped more than 20 %
   against the live release (`--force` overrides), the sitemap index and every
   child parse and hold only `https://pets24x7.com/` URLs;
7. swaps `/var/www/pets24x7` to the new release (atomic `mv -T`), then fetches
   `https://pets24x7.com/` through nginx on this box (`curl --resolve …:443:127.0.0.1`;
   port 80 only answers with a redirect) plus one city page and one
   `data/<cc>-<city>.json`, which must match the release byte for byte; if
   any of that fails it rolls back to the previous release;
8. keeps the two previous releases, deletes older ones, and writes
   `/var/lib/pets24x7/publish-status.json`.

The render needs `runuser` (util-linux, present on Debian/Ubuntu).

A publish takes about 5–8 minutes on this box (the render is ~40k files).
`pets24x7-deploy.sh` runs the same script whenever a push changes
`pets24x7_new/`, so a git deploy and a DB publish produce the same site; a
deploy never puts back listings that were hidden or edited in the panel.

The export refuses to write zero listings, and publishes a review count that
matches the invented formula of old builds as "unrated" (it warns; run
`scripts/strip-synthetic-ratings.mjs --apply` once to fix the table itself).

### When a change shows where

| Change | API, `/city.html`, `/listing.html` | Pre-rendered city/category page | Pre-rendered listing page, sitemap |
|---|---|---|---|
| New listing | seconds | seconds — appended on page 1 of its city and on its category page by a small script (at most two API calls) | next publish |
| Edit | seconds | next publish | next publish |
| Hide / delete | seconds | seconds when the city (or category) fits in 200 listings — the script drops cards the API no longer returns; otherwise next publish | the page keeps resolving until the next publish removes it (nightly at the latest) |
| Photos | seconds on `/listing.html` | next publish | next publish |

"Next publish" is the nightly run (03:30 IST + up to 20 min), the admin
**Publish site** button (5–10 min), or a deploy that touches `pets24x7_new/`.
HTML is cached for 5 minutes (`s-maxage` 10 at Cloudflare), so allow that on
top.

### One-time setup on the VPS

```bash
# units + script (a deploy installs these too once this commit is live)
install -m 700 /opt/pets24x7/app/ops/pets24x7-publish.sh /usr/local/bin/
install -m 644 /opt/pets24x7/app/ops/pets24x7-publish.{service,timer,path} /etc/systemd/system/
install -d -o pets24x7 -g pets24x7 -m 755 /opt/pets24x7/run
systemctl daemon-reload
systemctl enable --now pets24x7-publish.timer pets24x7-publish.path

# admin "Publish site" button: the API writes a request file, the .path unit
# starts the service. Add to pets24x7_api/.env, then restart the API:
#   PUBLISH_TRIGGER_FILE=/opt/pets24x7/run/publish.request
#   PUBLISH_STATUS_FILE=/var/lib/pets24x7/publish-status.json   (default)
systemctl restart pets24x7-api

# first run by hand, and watch it
systemctl start pets24x7-publish.service
journalctl -u pets24x7-publish.service -f
cat /var/lib/pets24x7/publish-status.json
systemctl list-timers pets24x7-publish.timer
```

Without `PUBLISH_TRIGGER_FILE` (or `PUBLISH_COMMAND`) the button's endpoint
answers `501 publish_disabled`; the nightly timer still runs.

**Alternative trigger, `PUBLISH_COMMAND`.** Instead of the request file the API
can run one fixed command (no shell, argv split on spaces, request data never
reaches it). With sudo that is:

```
PUBLISH_COMMAND=/usr/bin/sudo -n /usr/bin/systemctl start --no-block pets24x7-publish.service
```

plus `/etc/sudoers.d/pets24x7-publish` (mode 440, check with `visudo -cf`):

```
pets24x7 ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block pets24x7-publish.service
```

sudo cannot work under the API unit's `NoNewPrivileges=true`, so this route
also means removing that hardening line from `pets24x7-api.service`. The
request-file route needs neither, which is why it is the default above.

### Running things by hand

```bash
# what would change, without writing (on the server, as the app user)
su - pets24x7 -c 'cd ~/app/pets24x7_api && node scripts/export-listings-static.mjs --out /tmp/pub-check/data --dry-run'

# publish now, past the page-drop guard (after a deliberate mass hide)
/usr/local/bin/pets24x7-publish.sh --force --trigger manual

# roll back to the previous release
ls -1dt /var/www/pets24x7-releases/*/
ln -sfn /var/www/pets24x7-releases/<name> /var/www/pets24x7.tmp && mv -Tf /var/www/pets24x7.tmp /var/www/pets24x7
```

Locally, never render in place: export into a scratch copy of the site and
build there (`--out`), e.g. with `DATABASE_URL` pointing at a local MySQL:

```bash
cp -r pets24x7_new /tmp/site && rm -rf /tmp/site/in /tmp/site/us
(cd pets24x7_api && node scripts/export-listings-static.mjs --out /tmp/site/data)
(cd /tmp/site && python build_pages.py --out /tmp/site)
```

---

## New env vars

All optional. A single server needs none of them and behaves exactly as before.

| Variable | Default | What it does |
|---|---|---|
| `REDIS_URL` | unset | e.g. `redis://:password@10.0.0.5:6379/0`. Moves the rate-limit counters (every limiter built with `makeLimiter()`) and the shared cache (`src/shared/kv.ts`) into Redis, so every API instance sees the same values. When unset, they stay in process memory. When Redis is down, each instance falls back to its own memory and logs at most one warning a minute. Requests do not fail. |
| `REDIS_KEY_PREFIX` | `p24x7:` | Namespace for every key this app writes, so one Redis can host staging and production, or other apps. |
| `KV_MEMORY_MAX_ENTRIES` | `10000` | Size cap of the in-memory cache (LRU, per-entry TTL). The cache is used when `REDIS_URL` is unset and while Redis is unreachable. |
| `RUN_JOBS` | `true` | `false` means this instance does not start the scheduled sweeps (expiry, reminders, parent/vendor engagement mail, admin digest). The reco jobs are not affected, because every serving instance needs them. |
| `LISTINGS_SYNC_MS` | `60000` with `REDIS_URL`, else off | How often each instance pulls listing rows that another instance changed (imports, vendor edits, `/register-business`, admin deletions) into its in-memory index. `0` turns it off. A single server updates its own index on every write and does not need it. |
| `PUBLISH_TRIGGER_FILE` | unset | Absolute path the API writes when an admin presses **Publish site** (`POST /api/admin/publish`); `pets24x7-publish.path` starts the publish when it appears. Recommended: `/opt/pets24x7/run/publish.request`. See "Managing listings". |
| `PUBLISH_COMMAND` | unset | Alternative to the trigger file: one fixed command line run without a shell, e.g. `/usr/bin/sudo -n /usr/bin/systemctl start --no-block pets24x7-publish.service`. With neither set, the endpoint answers `501`. |
| `PUBLISH_STATUS_FILE` | `/var/lib/pets24x7/publish-status.json` | Where the publish script records its last run; read by `GET /api/admin/publish/status`. |

Schema: this release adds one table, `job_locks` (model `JobLock`). Run
`npx prisma db push` (or your migration step) as part of the deploy. If the
table is missing, jobs still run, unlocked as before, and a warning is logged.
That is correct on one server but duplicates jobs on more than one.

One-off data clean-up: the listings table was loaded with invented review
counts (and a default 4.4 rating) from older builds of `build_data.py`. Run
`node scripts/strip-synthetic-ratings.mjs` in `pets24x7_api/` (a dry run that
prints counts), then again with `--apply`, and restart the API. It keeps
scores that came from the source; the API and the pages show a score only
with at least one review behind it. On the local copy it cleared 34,169
counts and 2,791 ratings of 4.4, which matches `export/listings.json`.

---

## Scaling to multiple servers

Today one Node process serves everything. To run N processes behind one load
balancer (N VPSes, or several `pm2`/systemd instances on one box):

1. **One MySQL for all of them.** Every instance's `DATABASE_URL` points at the
   same database. Size the pool: each process opens Prisma's default of
   `num_cpus * 2 + 1` connections, so check that N times that stays under
   MySQL's `max_connections`, or set `?connection_limit=` on the URL.
2. **Set `REDIS_URL` on every instance.** Without it, rate limits are counted
   per instance, so N servers allow N times the budget: 4 OTPs a minute becomes
   4N, and 10 admin password guesses per 5 minutes becomes 10N. Limiters built
   with `makeLimiter()` (`src/shared/rate-limit.ts`) share their counters
   through Redis. "Known gaps" below lists the limiters that do not use it yet.
   A small managed Redis, or a `redis-server` bound to the private network, is
   enough. It needs no persistence, because everything in it is rebuildable.
   With `REDIS_URL` the recommendation engine also shares, through Redis:
   its rids (what a "Show more" page continues from, what an impression or
   click beacon is checked against, and the 7-day rids behind email-digest
   clicks), and its cache invalidation, as generation counters under
   `reco:v1:gen:*`. Ranked result lists stay per instance. Memory: about 30 KB
   per dashboard rid, kept for 15 minutes, so 1,000 dashboard views in a
   15-minute window hold about 30 MB. Set `maxmemory` with
   `maxmemory-policy volatile-lru`: the rid, generation-counter and rate-limit
   keys all carry a TTL, so Redis can evict them under pressure instead of
   refusing writes.
3. **Scheduled jobs run once across the cluster.** Every sweep first takes a
   lease row in `job_locks`. Taking it is one atomic statement:
   `UPDATE … WHERE expiresAt <= NOW(3) OR holder = <this instance>`, or
   `INSERT IGNORE` the first time a job name is seen (an instance's own
   leftover lease never blocks its next run). The holder renews the lease while the job runs, and the
   lease expires if the holder crashes. All times come from the database clock,
   so clock skew between servers does not matter. The random daily mail slots
   are seeded from the job name, the date and `JWT_SECRET`. Every instance
   therefore computes the same slots, and the lease lets exactly one of them
   send each slot.
   *Why not MySQL `GET_LOCK()`:* that lock belongs to one connection, and
   Prisma runs each query on whichever pooled connection is free, so
   `RELEASE_LOCK` can land on another connection and silently do nothing.
   Pinning one connection would mean holding an interactive transaction open
   for the whole sweep (minutes). That exceeds Prisma's transaction timeout and
   takes a connection out of the pool.
   Optionally, set `RUN_JOBS=false` on web-only instances to keep them out of
   the job rotation entirely. The lease already prevents duplicates without it.
4. **`JWT_SECRET` and `ADMIN_SESSION_SECRET` must be identical on every
   instance.** Sessions are stateless cookies, so any instance can serve any
   request and no sticky sessions are needed.
5. **Uploads and the listings JSON mirror** (`STATIC_DATA_DIR`) are local
   files. MySQL is the source of truth for listings; the JSON is only a
   fallback for booting without a database. Serve the static site from one
   place (the release directory in section 9, or a CDN), not from each API box.
6. **nginx upstream**. For example:
   ```nginx
   upstream pets24x7_api { least_conn; server 10.0.0.11:4000; server 10.0.0.12:4000; }
   ```
   Set `HOST=0.0.0.0` (or the private IP) on each instance. Keep `TRUST_PROXY`
   equal to the number of proxy hops, because every rate limit keys on the
   client IP.

### Listings index: memory per instance

`src/listings/index.ts` loads the whole directory into each process at boot:
a `byId` map plus an index on the last 10 digits of the phone number. I
measured the current data (34,182 listings, 26,081 distinct phones, 19 MB of
JSON) by building the same two maps in Node. The result was **about 34 MB of
heap, about 1 KB per listing**. Boot adds a temporary peak of roughly 2-3x
that while the rows are materialised. Projected heap per instance, for the
index alone:

| Listings | Steady heap |
|---|---|
| 35k (today) | ~35 MB |
| 100k | ~100 MB |
| 500k | ~0.5 GB (raise `--max-old-space-size`) |
| 1M+ | move search into MySQL FULLTEXT or a search service |

Every instance holds its own copy. That is fine up to a few hundred thousand
listings.

### With more than one instance: what is shared and what lags

- **Listings index.** An admin import, a vendor edit, a `/register-business`
  or a listing removal updates the index on the instance that handled it at
  once. The others pull the change within `LISTINGS_SYNC_MS` (60 s by default
  with `REDIS_URL`): each tick reads the rows whose `updatedAt` moved and, when
  the table holds fewer rows than the index, drops the ids that are gone. A
  deletion and an insert landing in the same tick leave the deleted row in the
  other indexes until the next deletion or a restart. A bulk SQL update made
  outside the app must also set `updatedAt` for the sync to see it.
- **Vendor subscription payments.** Applying a payment first claims its
  Razorpay payment id as a `Setting` row (`vendor_pay:<id>`), which only one
  instance can create, so a verify on one server and the webhook on another
  cannot both apply it. The row stays `pending` until the plan and invoice are
  saved, then turns `applied`; a claim left pending for 5 minutes by a killed
  process, with no matching saved invoice, is taken over by the next retry
  (webhook or verify). The paid plan is applied on top of the saved row, not
  this instance's cached copy. What remains per instance: another instance's
  cached subscription for that vendor is not refreshed until it restarts or
  handles that vendor's next payment. `pendingCheckouts` is rebuilt from the
  Razorpay order notes when a verify reaches a different instance.
- **Reco ranked results** (`src/feed/reco/*`) are per instance by design; rids
  and invalidation are shared (see step 2). A change to featured listings or
  campaigns reaches the sponsored slots with the next signals snapshot (5 min).
- **Plan catalogues** saved from the admin panel apply at once on the instance
  that saved them. Other instances pick them up within 60 s, because each one
  re-reads `Setting` once a minute.
- **Rate limiters.** Every limiter is built with `makeLimiter()`, so with
  `REDIS_URL` all of them count across instances.

---

## What is NOT done / needs a decision

- **Real WhatsApp Cloud API creds** — OTP login is dead without them (dev bypass
  routes are disabled when `NODE_ENV=production`).
- **Razorpay live keys** — required; Razorpay is the only gateway.
- **`app.pets24x7.com`** — still pointed at the dead Hostinger origin and has
  no vhost here. What it served was never established.
- **Ports 5432 (postgres) and 5000 (`/var/www/carsindias`, running as root) are
  open to the internet** on this box. Neither belongs to Pets24x7, so both were
  left alone. Postgres `pg_hba.conf` only permits localhost and the docker
  subnets, so remote auth fails, but the port is still reachable.
- **Off-box backups** — `pets24x7-backup.timer` dumps the DB nightly at 02:30
  into `/var/backups/pets24x7` (gzipped, mode 600, 14-day retention), but that
  is the same disk as the database. Copy them elsewhere to survive a dead
  server. Hostinger's own VPS backups are weekly.
