# Pets24x7.com — Setup Notes

Static site. No backend required. Upload all files to any static host (Netlify, Vercel, AWS S3 + CloudFront, GitHub Pages).

> **Test locally with a real web server** — don't double-click `index.html`. Clean URLs like `/in/mumbai/` and the `/styles.css`, `/config.js` imports only resolve when served by HTTP. From this folder run:
> ```
> python -m http.server 8000
> ```
> then visit **http://localhost:8000/**. Opening pages via `file://` will show broken links + missing styles.

## What's in this folder

| File / folder | Purpose |
|---|---|
| `index.html` | Home — hero search, popular cities (IN + US), top-rated featured listings, B2B "List your business" pitch, FAQ. |
| `marketing.html` | B2B page for vets / groomers / boarders / trainers — services, pricing tiers (Starter / Pro / Chain), success stories, lead modal. |
| `privacy.html` / `terms.html` | Legal pages — IT Act / SPDI Rules compliant. |
| `404.html` | Branded not-found page. |
| `pets24x7_logo.png` | Brand logo (favicon + header). |
| `styles.css` | Shared stylesheet for all pre-rendered SEO pages under `/in/` and `/us/`. |
| **`/in/<city>/index.html`** | **Pre-rendered city page** — schema.org `ItemList` + `BreadcrumbList`, top 50 listings rendered server-side as cards, category chips, SEO copy, related cities. Paginated `page/2/` etc when listings > 50. |
| **`/in/<city>/<category>/index.html`** | **Pre-rendered city + category page** — same shape, filtered. |
| **`/<country>/<city>/<listing-slug>/index.html`** | **Pre-rendered listing page** — schema.org `LocalBusiness` (or `VeterinaryCare` etc) with `AggregateRating`, full content + gallery + Google reviews block + embedded map + enquiry form, baked in for first-paint indexing. |
| `city.html` | Legacy query-string fallback. Visitors get an instant JS redirect to the clean URL (`/in/mumbai/?cat=...` → `/in/mumbai/<cat>/`). Keeps old inbound links alive. |
| `listing.html` | Legacy listing fallback. Same redirect behaviour. |
| `pets-data.js` | Auto-generated `window.PETS_INDEX` (570 cities) + `window.PETS_FEATURED` (24 top listings). ~130 KB. |
| `pets-loader.js` | Optional live Google Sheets refresh layer. Disabled until you paste a CSV URL. |
| `data/<country>-<city>.json` | Per-city listings (570 files, ~20 MB total). Used by both pre-render + legacy fallback. |
| `pets.csv` | Flat snapshot of every listing — handy for Google Sheets live sync. |
| `robots.txt`, `sitemap.xml` (+ shards) | SEO. Sitemap index points to shards covering every static page, city, city+category and listing URL. |
| `build_data.py` | Re-run when raw CSVs in `../Pets24x7_DATA/` change. Rewrites `pets-data.js`, `pets.csv`, `data/*.json`. |
| `build_pages.py` | Re-run when data changes. Wipes `/in/`, `/us/` and rebuilds every static SEO page + sitemap shards. |
| `config.js` | **Single config file** loaded by every page. Set `LEADS_WEBAPP_URL` (form sheet) + `CSV_URL` (listings sheet) here — see "Google Sheet integration" below. |
| `LEADS-APPS-SCRIPT.gs` | Google Apps Script template — paste into your leads Sheet's Extensions → Apps Script. See "Google Sheet integration" below. |

## SEO architecture

The site has two layers:

1. **Pre-rendered static pages** at clean URLs (`/in/mumbai/`, `/in/mumbai/veterinary-clinics/`, `/in/mumbai/aarey-veterinary-hospital-12153081/`). Every page ships full content, schema.org JSON-LD (`LocalBusiness` / `AggregateRating` / `BreadcrumbList` / `ItemList`) and renders without JavaScript. This is what Google indexes.

2. **Legacy query-string pages** (`city.html?...`, `listing.html?...`) that JS-redirect to the clean URL above. Keeps existing inbound links and shared URLs working.

After re-running `build_data.py` and `build_pages.py`, you get ~38,000 indexable URLs covering every city, category and listing.

> **Heads up on file count:** ~38k files is over Cloudflare Pages' 20k limit. Recommended hosts: **Netlify (100k limit), Vercel, AWS S3 + CloudFront, or GitHub Pages.**

## To re-build everything from source CSVs

```
python build_data.py     # rewrites pets-data.js, pets.csv, data/*.json
python build_pages.py    # wipes /in/, /us/ and re-renders all 38k static SEO pages + sitemap shards
```

The two scripts are decoupled — `build_data.py` is data only, `build_pages.py` consumes the per-city JSON and emits HTML. Run both after every CSV refresh.

Tunables inside the script:

- `PER_BUCKET_CAP` (default 60) — max listings per (city, category) bucket.
- Quality filter requires a Google CID and drops the uncategorised "Pet Services" noise bucket.
- City index only includes cities with 5+ listings.

## Google Sheet integration — one config file

The site loads **`config.js`** on every page. That's the only file you ever edit when wiring Sheets. Two values:

```js
window.PETS_CONFIG = {
  LEADS_WEBAPP_URL: '',   // ← form submissions sheet (Apps Script Web App)
  CSV_URL: '',            // ← live listings sheet (published CSV)
  WHATSAPP_NUMBER: '919930090487',
  BRAND: 'Pets24x7'
};
```

### A. Listings data sheet — `CSV_URL`

So you can edit listings in Google Sheets and the home page auto-refreshes within 30 min, without re-running Python.

1. Go to [sheets.new](https://sheets.new) — create a sheet called **Pets24x7 Listings**.
2. **File → Import → Upload** → drag `pets.csv` from this folder → "Replace spreadsheet" → Import.
3. **File → Share → Publish to web** → Link tab → "Entire document" → format **Comma-separated values (.csv)** → **Publish** → Confirm.
4. Copy the long URL (looks like `https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?output=csv`).
5. Open `config.js`, paste it into `CSV_URL: ''`.
6. Reload the home page — DevTools console should print `[Pets24x7] Live CSV loaded: N rows.`

Adding / editing rows in the sheet updates the home-page index + legacy city.html fallback. **Static pre-rendered pages (`/in/<city>/`, `/<city>/<listing>/`) still come from `build_pages.py`** — re-run that whenever you want the static SEO surface to reflect sheet edits.

### B. Form submissions sheet — `LEADS_WEBAPP_URL`

Every form on the site (the listing-page enquiry form on all 30k generated pages, plus the marketing-page lead modal) writes a row to one shared Google Sheet.

1. Go to [sheets.new](https://sheets.new) — create a sheet called **Pets24x7 Leads**. Rename the first tab to **Leads** (matters — script looks for this name).
2. **Extensions → Apps Script** → delete the auto-generated code → paste the entire contents of `LEADS-APPS-SCRIPT.gs` → File → Save.
3. **Deploy → New deployment** → ⚙ icon → choose **Web app**.
   - Description: `Pets24x7 leads webhook`
   - Execute as: **Me**
   - Who has access: **Anyone** (required for no-cors POST — the script only accepts inserts, no read endpoint)
   - Click **Deploy** → grant permissions.
4. Copy the **Web app URL** it gives you (`https://script.google.com/macros/s/AKfycb…/exec`).
5. Open `config.js`, paste it into `LEADS_WEBAPP_URL: ''`.
6. Sanity check — open the URL in a browser, you should see `Pets24x7 leads webhook is live.`
7. Submit a test form on the site — a new row appears in the **Leads** tab within ~1 second.

The Apps Script auto-creates columns for any new form fields you add later, so you never have to keep the sheet schema in sync manually.

### Columns the leads sheet captures

| Column | From which form |
|---|---|
| `timestamp`, `source`, `page`, `userAgent` | every submission |
| `name`, `phone`, `email` | every form |
| `business`, `category`, `city`, `country`, `listing_id`, `pet`, `date`, `notes` | listing enquiry |
| `business`, `category` (= biz category), `location`, `service`, `size`, `notes` | marketing modal |

> If you later edit forms to add new fields, just call `pushLead({ newField: value })` — the script appends a new column on first sight.

## Deploy

### Hostinger (your hosting — full guide in [HOSTINGER-DEPLOY.md](HOSTINGER-DEPLOY.md))
```
1. Edit config.js  (paste Apps Script URL + published CSV URL)
2. Double-click pack_for_hostinger.bat  → produces pets24x7-deploy.zip
3. hPanel → File Manager → public_html/ → Upload zip → Right-click → Extract
4. hPanel → Security → SSL → Install Let's Encrypt cert
```
`.htaccess` ships with the site — handles clean URLs, 301s, gzip, cache, 404.

### Netlify (recommended — easiest)
```
1. https://app.netlify.com/drop  → drag this entire folder onto the page.
2. After upload finishes, click Site settings → Domain management → add pets24x7.com.
3. Done. _redirects, _headers, netlify.toml are all in the folder — Netlify reads them automatically.
```
First-time bandwidth budget: ~1 GB will cover a few thousand sessions on the free tier.

### Vercel
```
npm i -g vercel
cd <this folder>
vercel --prod
```
`vercel.json` is in the folder — `cleanUrls` and cache headers apply automatically.

### Cloudflare Pages
File count exceeds the **20,000 file limit** as of writing — pick another host OR enable Pages' new "Bulk redirects" + reduce listing pages first.

### AWS S3 + CloudFront
```
aws s3 sync . s3://pets24x7-prod --exclude "*.py" --exclude "*.md" --exclude ".*" --delete
```
Set CloudFront default root object to `index.html`. Use the included `_redirects` rules via a Lambda@Edge function, or replace with CloudFront Functions.

### Quick pre-deploy checks
- `config.js` — paste your Apps Script URL + published CSV URL (or leave blank to ship without sheet integration).
- `index.html` head — add your GA4 tag if you want analytics.
- `pets24x7.com` is the assumed domain everywhere. Search-and-replace if different.

## Things you may want to customise before going live

- **GA4 tag.** Not wired yet. Drop your `G-XXXXXXXXXX` ID into each HTML page in a `<script async src="...gtag/js?id=...">` block (same pattern as the Hotelzz reference).
- **WhatsApp number.** Currently `+91-9930090487` everywhere. Find-and-replace across all HTML if you swap it.
- **Domain.** Canonical URLs and the sitemap assume `https://pets24x7.com`. Search for `pets24x7.com` and update if you go with a different TLD.
- **OG image.** Currently uses `pets24x7_logo.png`. Consider a wider 1200x630 social card.
- **Featured rotation.** The home page's "Top Rated" grid is the top 8 of 24 cached featured listings. To rotate, re-run `build_data.py` (it picks deterministically by rating + review count).
