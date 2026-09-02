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

### Switch Prisma to MySQL (server-side only, repo stays Postgres for local dev)

The schema is already MySQL-compatible (no `String[]`, no `Unsupported`, no
`@db.*` Postgres-only types — `Json` and `@db.Text` both work on MySQL 8).
On the server, before building:

```bash
cd /opt/pets24x7/app/pets24x7_api
sed -i 's/provider = "postgresql"/provider = "mysql"/' prisma/schema.prisma
npx prisma generate
npx prisma db push        # fresh DB, no migration history needed
```

Keep this `sed` in your deploy script so every fresh checkout gets it. Do **not**
commit the provider flip — local dev uses embedded Postgres.

---

## 3. `pets24x7_api/.env` on the server (production)

```ini
NODE_ENV=production
PORT=4000
LOG_LEVEL=info

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

STATIC_DATA_DIR="/opt/pets24x7/app/pets24x7_new/data"

# PhonePe — keep sandbox values unless you have prod PhonePe creds.
# Razorpay is preferred and takes priority when configured, so these can stay as-is.
PHONEPE_MODE="sandbox"
PHONEPE_MERCHANT_ID="PGTESTPAYUAT"
PHONEPE_SALT_KEY="099eb0cd-02cf-4e2a-8aca-3e6c6aff0399"
PHONEPE_SALT_INDEX=1
PHONEPE_REDIRECT_URL="https://pets24x7.com/membership/return/"
PHONEPE_CALLBACK_URL="https://api.pets24x7.com/api/payments/phonepe/callback"

SEED_ADMIN_EMAIL="founder@pets24x7.com"
SEED_ADMIN_PASSWORD="___strong___"
SEED_ADMIN_NAME="Pets24x7 Founder"

# ---- Razorpay (LIVE) ----
RAZORPAY_KEY_ID=rzp_live_TD5szYcJYZbQqE
RAZORPAY_KEY_SECRET=k3V8cq7DnsxMMm6nQpA5T1QC
RAZORPAY_WEBHOOK_SECRET=___set_after_creating_webhook___
```

`chmod 600 .env`.

> **These Razorpay keys are LIVE and were pasted into a chat transcript.**
> Rotate them in the Razorpay dashboard (Settings - API Keys - Regenerate) once
> the box is up, and put the new secret only in this file.

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

    client_max_body_size 2m;

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
   Otherwise `/api/payments/razorpay/webhook` and `/api/payments/phonepe/callback`
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

# on the server:
mkdir -p /var/www/pets24x7
tar -xzf /tmp/site.tgz -C /var/www/pets24x7 && rm /tmp/site.tgz
```

### Pre-render the SEO pages — do not skip

The repo ships templates and `data/*.json`, **not** the ~36k rendered pages.
`sitemap.xml` lists 36,396 URLs, so without this step every city, category and
listing URL 404s.

```bash
cd /var/www/pets24x7 && python3 build_pages.py   # ~36,392 pages, rewrites sitemap.xml
chown -R www-data:www-data /var/www/pets24x7
find /var/www/pets24x7 -type d -exec chmod 755 {} +
find /var/www/pets24x7 -type f -exec chmod 644 {} +
```

Roughly 1.1 GB and 38k files when built. Re-run it after any data refresh.

### nginx

`/etc/nginx/sites-available/pets24x7.com` (apex + a `www` -> apex block) ports
the `.htaccess` rules: legacy `city.html` / `listing.html` query-string 301s,
`/IN/` -> `/in/`, trailing-slash 301, review short-links, `/r/<CODE>` -> API 302,
pretty 404, cache headers, and the deny rules for dotfiles / `.py` / `.md` /
`_headers`.

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

## What is NOT done / needs a decision

- **Real WhatsApp Cloud API creds** — OTP login is dead without them (dev bypass
  routes are disabled when `NODE_ENV=production`).
- **PhonePe production creds** — optional; Razorpay is the primary gateway.
- **`app.pets24x7.com`** — still pointed at the dead Hostinger origin and has
  no vhost here. What it served was never established.
- **Ports 5432 (postgres) and 5000 (`/var/www/carsindias`, running as root) are
  open to the internet** on this box. Neither belongs to Pets24x7, so both were
  left alone. Postgres `pg_hba.conf` only permits localhost and the docker
  subnets, so remote auth fails, but the port is still reachable.
- **DB backups** — add a nightly `mysqldump pets24x7` cron once live.
