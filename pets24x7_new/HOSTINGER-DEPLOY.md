# Pets24x7.com — Hostinger deploy guide

> ~36,000 files / ~900 MB. Don't FTP one-by-one — that takes hours and times out.
> Zip first, upload one file, extract on the server.

## 1. Prep config (2 min)

Open `config.js` and paste your two Sheet URLs:

```js
window.PETS_CONFIG = {
  LEADS_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycb…/exec',
  CSV_URL:          'https://docs.google.com/spreadsheets/d/e/2PACX-…/pub?output=csv',
  WHATSAPP_NUMBER:  '919930090487',
  BRAND:            'Pets24x7'
};
```

Skip this step if you're not ready — site works fine with empty values, you can edit `config.js` directly on the server later.

## 2. Make the zip (1 min)

From a Windows terminal in this folder:

```
powershell -Command "Compress-Archive -Path * -DestinationPath pets24x7-deploy.zip -Force"
```

Or right-click the folder contents → "Send to → Compressed (zipped) folder" → name it `pets24x7-deploy.zip`.

Confirm: the zip should be ~150-200 MB (compressed). The unzipped 900 MB is mostly cacheable static HTML.

> **Important — make sure the zip contains the FILES at the root**, not the parent folder. Open the zip in Explorer — you should see `index.html`, `in/`, `us/`, etc. directly. If you see one folder containing them, re-zip.

## 3. Upload to Hostinger (5 min)

### Option A — hPanel File Manager (easiest)
1. Log in to **hpanel.hostinger.com**.
2. Pick your domain → **Files → File manager**.
3. Open `public_html/` (or `domains/pets24x7.com/public_html/` if you bought multiple domains on the same plan).
4. If there's an existing `default.php` or `index.html`, delete it.
5. Click **Upload files** → pick `pets24x7-deploy.zip` → wait for upload (~3-5 min on home internet).
6. Right-click the uploaded zip → **Extract**. Choose the same folder as destination. Hit Extract. Wait ~30-60 sec.
7. Delete the zip.

### Option B — FTP (if you prefer FileZilla)
1. hPanel → **Files → FTP accounts** → copy host, username, password.
2. FileZilla → New Site → paste credentials → connect.
3. Upload `pets24x7-deploy.zip` to `/public_html/`.
4. SSH into the account (hPanel → Advanced → SSH Access) and run:
   ```
   cd public_html && unzip pets24x7-deploy.zip && rm pets24x7-deploy.zip
   ```

> If SSH access isn't available on your plan, use Option A — File Manager extracts zips natively.

## 4. Point the domain (5 min, then DNS prop ~30 min)

In hPanel:
1. **Domains** → click your domain → **DNS / Nameservers**.
2. If your domain is registered with Hostinger: it auto-points. Skip.
3. If registered elsewhere (GoDaddy, Namecheap…): set the nameservers shown in hPanel — usually `ns1.dns-parking.com` + `ns2.dns-parking.com` — at your registrar. Wait for propagation (15 min – 4 hrs).

## 5. Turn on SSL (1 min)

hPanel → **Security → SSL** → click **Install SSL** → free Let's Encrypt cert. Tick "Force HTTPS".

The included `.htaccess` already redirects http → https + www → apex, so this just needs the cert in place.

## 6. Verify (2 min)

Open in a browser:
- `https://pets24x7.com/` — home page loads, all images appear
- `https://pets24x7.com/in/mumbai/` — Mumbai listings page
- `https://pets24x7.com/in/mumbai/cocos-pet-boarding-and-homestay-63035557/` — random listing
- `https://pets24x7.com/sitemap.xml` — XML output
- `https://pets24x7.com/robots.txt` — text output
- Click a city tile → listing → "Quick WhatsApp Enquiry" → opens WhatsApp with prefilled message
- Submit the enquiry form → check your Google Sheet "Leads" tab for the new row

## 7. Submit to Google (5 min, then 2-7 days for indexing)

1. **Google Search Console** (search.google.com/search-console) → Add property → URL prefix → `https://pets24x7.com/`.
2. Verify ownership: download the HTML file Google gives you, upload to `public_html/` via File Manager.
3. Once verified: **Sitemaps** → add `sitemap.xml` → Submit.

Google will start crawling within a few hours. Listing pages get indexed gradually over 2-4 weeks. Monitor in Search Console → Pages.

## File-count note

Hostinger's shared plans typically allow **400,000 inodes (files)** on Premium and **1,000,000+** on Business/Cloud. This site is ~36,000 files = well within limits on any paid plan.

If your plan shows an inode warning, run this to slim down by ~1,600 unused JSON files for cities with <5 listings (they're not linked from anywhere):

```
cd public_html
# from the SSH terminal — list orphan JSONs (visible cities only have 569)
python3 -c "import json, re, os; idx=json.loads(re.search(r'PETS_INDEX\s*=\s*(\[.+?\]);', open('pets-data.js').read()).group(1)); keep=set((c['country'].lower(), c['city_slug']) for c in idx); [os.remove(f'data/{f}') for f in os.listdir('data') if not any(f==f'{c}-{s}.json' for c,s in keep)]"
```

## Updating content later

**Edit `config.js` only?** Just save it via File Manager → done in 5 min.

**Edit listings via Google Sheet?** Just edit the Sheet. Home page auto-refreshes within 30 min (CSV cache TTL). Static listing pages need a re-build:

```
# Locally
python build_data.py
python build_pages.py
# then re-zip + re-upload via File Manager
```

**Full re-deploy?** Zip + upload + extract again, replace the old files.

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Clean URLs 404 | Apache `mod_rewrite` off | Already enabled by default on Hostinger. If it isn't: hPanel → Advanced → htaccess Editor → confirm `.htaccess` exists. |
| CSS missing on listing pages | uploaded into a sub-folder | Re-check root structure — `index.html` must be at `public_html/index.html`, not `public_html/pets24x7_new/index.html`. |
| Form submits but no row in Sheet | wrong / blank `LEADS_WEBAPP_URL` | Edit `config.js`, paste the **Web App URL** (ends in `/exec`), not the Apps Script editor URL. |
| WhatsApp opens with wrong number | manual override missed | Search/replace `919930090487` across the whole folder before zipping. |
| 404 page is Hostinger default | `.htaccess` not uploaded | Hidden file — make sure your zip includes dot-files. The included PowerShell command does. |

## Quick reference

- **Upload destination:** `public_html/` (or your domain's directory)
- **Required files at root:** `index.html`, `.htaccess`, `config.js`, `styles.css`, `pets-data.js`, `pets-loader.js`, `pets24x7_logo.png`, `sitemap.xml`, `robots.txt`, `in/`, `us/`, `data/`
- **Don't upload:** `*.py`, `*.md`, `*.bat`, `*.toml`, `*.zip`, `LEADS-APPS-SCRIPT.gs` (the `.htaccess` denies access to them anyway, but cleaner to omit).
