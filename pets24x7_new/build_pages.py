"""
Pets24x7 — pre-render static SEO pages from per-city JSON.

Generates ~38,000 self-contained HTML files so every city, city+category,
and listing has a real indexable URL. Each page includes:
  - Title + meta description tuned for the page
  - Open Graph + Twitter cards
  - schema.org JSON-LD: LocalBusiness (listings), ItemList (cities),
    BreadcrumbList (every page), AggregateRating where data exists
  - Full content rendered on first paint (no JS required to read)
  - Same blue palette as the rest of the site, via /styles.css

URL structure:
  /<country>/<city>/                        e.g. /in/mumbai/
  /<country>/<city>/page/<n>/               pagination beyond 50 results
  /<country>/<city>/<category-slug>/        e.g. /in/mumbai/veterinary-clinics/
  /<country>/<city>/<listing-slug>/         e.g. /in/mumbai/cocos-pet-boarding-63035557/

Data comes from data/<cc>-<city>.json + pets-data.js, written by build_data.py
(CSV scrape) or, on the server, by pets24x7_api/scripts/export-listings-static.mjs
(the listings table; see ops/pets24x7-publish.sh). Optional per-listing keys
from the export (description, opening_hours, services, locality, photos) are
rendered when present; a listing flagged hidden gets no page, card or sitemap
entry. City page 1 and category pages carry a small script that appends
listings added in the API since the build (LIVE_MERGE_JS).

Run after build_data.py / the export:
  python build_pages.py                 # writes in/, us/, sitemap*.xml here
  python build_pages.py --out /tmp/x    # same, into another folder

Env (all optional): PETS_PAGES_OUT (same as --out), PETS_SITEMAP_CHUNK (URLs
per child sitemap, default 10000), PETS_OG_IMAGE (share image for city and
category pages, default /pets24x7_logo.png).
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
from datetime import date
from html import escape
from pathlib import Path
from urllib.parse import urlparse

# ---- Config ---------------------------------------------------------------

ROOT       = Path(__file__).resolve().parent
DATA_DIR   = ROOT / "data"
INDEX_FILE = ROOT / "pets-data.js"
# Where in/, us/ and the sitemap files are written. The site root by default;
# --out DIR (or PETS_PAGES_OUT) builds somewhere else, e.g. to test a build
# without wiping the live in/ and us/.
OUT_ROOT   = Path(os.environ.get("PETS_PAGES_OUT") or ROOT)
SITE       = "https://pets24x7.com"
SITE_NAME  = "Pets24x7"
WA_NUMBER  = "919930090487"
PAGE_SIZE  = 50          # city-page pagination
# URLs per sitemap file. Google's cap is 50,000 URLs / 50 MB uncompressed per
# file; 10k keeps each file a few MB and a re-crawl of one country cheap.
SITEMAP_CHUNK = int(os.environ.get("PETS_SITEMAP_CHUNK") or 10000)
# Share image for pages without a photo of their own (city, category). A
# 1200x630 image can be dropped in and pointed at with PETS_OG_IMAGE (a path
# on the site, or an absolute URL); the logo is the fallback.
OG_IMAGE   = os.environ.get("PETS_OG_IMAGE") or "/og-image.jpg"

# /styles.css is served `immutable` for a year (_headers, .htaccess,
# vercel.json), so a returning visitor never re-fetches it. Version the URL by
# content so a stylesheet change reaches them on the next build.
try:
    STYLES_VER = hashlib.sha1((ROOT / "styles.css").read_bytes()).hexdigest()[:10]
except OSError:
    STYLES_VER = date.today().strftime("%Y%m%d")

# Pet-themed Unsplash photo IDs grouped by category slug.
# Kept byte-for-byte identical to pet-images.js's POOL (same order per
# category) and paired with the same djb2 hash (see img_for()) so a business
# resolves to the same representative photo whether it's rendered by this
# static generator (og:image / schema.org image on its permanent page) or by
# pet-images.js client-side (index.html, listing.html, city.html).
IMG_POOL = {
    "veterinary-clinics":              ["photo-1628009368231-7bb7cfcb0def","photo-1583337130417-3346a1be7dee","photo-1581888227599-779811939961","photo-1543466835-00a7907e9de1","photo-1535930891776-0c2dfb7fda1a"],
    "emergency-animal-hospital":       ["photo-1583337130417-3346a1be7dee","photo-1628009368231-7bb7cfcb0def","photo-1543466835-00a7907e9de1","photo-1535930891776-0c2dfb7fda1a","photo-1601758125946-6ec2ef64daf8"],
    "vaccination-centers":             ["photo-1543466835-00a7907e9de1","photo-1581888227599-779811939961","photo-1628009368231-7bb7cfcb0def","photo-1583337130417-3346a1be7dee","photo-1574144611937-0df059b5ef3e"],
    "mobile-vet-services":             ["photo-1601758228041-f3b2795255f1","photo-1535930891776-0c2dfb7fda1a","photo-1450778869180-41d0601e046e","photo-1601758003122-53c40e686a19","photo-1520087619250-584c0cbd35e8"],
    "specialty-vets-exotics-avian-reptiles": ["photo-1452857297128-d9c29adba80b","photo-1574144611937-0df059b5ef3e","photo-1441057206919-63d19fac2369","photo-1535930891776-0c2dfb7fda1a","photo-1583337130417-3346a1be7dee"],
    "veterinary-labs-diagnostics":     ["photo-1581093588401-fbb62a02f120","photo-1559190394-df5a28aab5c5","photo-1574144611937-0df059b5ef3e","photo-1543466835-00a7907e9de1","photo-1583337130417-3346a1be7dee"],
    "pet-dental-care":                 ["photo-1548199973-03cce0bbc87b","photo-1601758125946-6ec2ef64daf8","photo-1543466835-00a7907e9de1","photo-1583512603805-3cc6b41f3edb","photo-1552053831-71594a27632d"],
    "pet-physiotherapy-rehab":         ["photo-1576201836106-db1758fd1c97","photo-1450778869180-41d0601e046e","photo-1601758003122-53c40e686a19","photo-1518020382113-a7e8fc38eac9","photo-1543466835-00a7907e9de1"],
    "pet-grooming-spa":                ["photo-1516734212186-a967f81ad0d7","photo-1596492784531-6e6eb5ea9993","photo-1548767797-d8c844163c4c","photo-1560807707-8cc77767d783","photo-1583512603805-3cc6b41f3edb"],
    "pet-boarding-daycare":            ["photo-1543466835-00a7907e9de1","photo-1477884213360-7e9d7dcc1e48","photo-1596492784531-6e6eb5ea9993","photo-1507146426996-ef05306b995a","photo-1444212477490-ca407925329e"],
    "pet-walking":                     ["photo-1450778869180-41d0601e046e","photo-1518020382113-a7e8fc38eac9","photo-1601758003122-53c40e686a19","photo-1441057206919-63d19fac2369","photo-1552053831-71594a27632d"],
    "pet-training-obedience-behavior": ["photo-1587300003388-59208cc962cb","photo-1551717743-49959800b1f6","photo-1552053831-71594a27632d","photo-1518020382113-a7e8fc38eac9","photo-1594149929911-78975a43d4f5"],
    "pet-sitting-in-home-care":        ["photo-1596492784531-6e6eb5ea9993","photo-1507146426996-ef05306b995a","photo-1522276498395-f4f68f7f8454","photo-1560807707-8cc77767d783","photo-1477884213360-7e9d7dcc1e48"],
    "pet-relocation-services":         ["photo-1518717758536-85ae29035b6d","photo-1425082661705-1834bfd09dca","photo-1520087619250-584c0cbd35e8","photo-1601758003122-53c40e686a19","photo-1441057206919-63d19fac2369"],
    "pet-taxi-transport":              ["photo-1425082661705-1834bfd09dca","photo-1518717758536-85ae29035b6d","photo-1520087619250-584c0cbd35e8","photo-1450778869180-41d0601e046e","photo-1601758003122-53c40e686a19"],
    "pet-therapy-services":            ["photo-1541599540903-216a46ca1dc0","photo-1522276498395-f4f68f7f8454","photo-1594149929911-78975a43d4f5","photo-1507146426996-ef05306b995a","photo-1551717743-49959800b1f6"],
}
DEFAULT_IMGS = ["photo-1583337130417-3346a1be7dee","photo-1477884213360-7e9d7dcc1e48","photo-1444212477490-ca407925329e","photo-1552053831-71594a27632d","photo-1507146426996-ef05306b995a"]

# What a pet parent should ask before booking, per category. These replace the
# old per-listing "amenities" ("AC kennels", "Insured walkers", "Certified
# therapy animals"), which were drawn from a pool by a hash of the listing id
# and stated as facts about businesses we know nothing of. A checklist is true
# for every listing and more useful to the reader.
CATEGORY_ASK = {
    "veterinary-clinics":              ["Consultation fee and timings", "Walk-in or appointment only", "Vaccinations and deworming available", "Emergency contact after hours", "Which species they treat"],
    "emergency-animal-hospital":       ["Open 24 hours, or on-call after hours", "Emergency consultation fee", "ICU and surgery on site", "What to bring for an urgent visit", "Directions and parking"],
    "pet-grooming-spa":                ["Price for your breed and coat", "Products used on sensitive skin", "Pickup and drop available", "Time taken per session", "Vaccination proof required"],
    "pet-boarding-daycare":            ["Daily rate and minimum stay", "Supervision overnight", "Feeding: their food or yours", "Vaccination records required", "Can you visit before booking"],
    "pet-walking":                     ["Walk length and price", "Solo or group walks", "Same walker each time", "Pickup from home", "What happens if it rains"],
    "pet-training-obedience-behavior": ["Home sessions or at their centre", "Number of sessions in a course", "Methods they use", "Puppy or adult dog programmes", "Follow-up support"],
    "pet-sitting-in-home-care":        ["Visits per day or overnight stay", "Rate per visit or per night", "Medication handling", "Photo or video updates", "References from other owners"],
    "pet-dental-care":                 ["Check-up and cleaning cost", "Is anaesthesia needed", "Pre-procedure blood tests", "Aftercare at home", "Follow-up visit included"],
    "mobile-vet-services":             ["Areas they cover", "Home-visit fee", "Vaccinations at home", "Sample collection for tests", "How soon they can come"],
    "vaccination-centers":             ["Which vaccines are in stock", "Vaccination card or certificate", "Booster reminders", "Walk-in or appointment", "Fee per vaccine"],
    "pet-relocation-services":         ["Domestic or international", "Paperwork they handle", "Crate provided or needed", "Total cost with fees", "Timeline to plan for"],
    "pet-taxi-transport":              ["AC vehicle", "Crate provided", "Fare for your route", "Airport and inter-city trips", "Can you ride along"],
    "pet-physiotherapy-rehab":         ["Therapies they offer", "Vet referral needed", "Sessions in a plan", "Cost per session", "Home exercises given"],
    "veterinary-labs-diagnostics":     ["Tests available", "Home sample collection", "Report turnaround time", "Vet referral needed", "Price list"],
    "specialty-vets-exotics-avian-reptiles": ["Which species they treat", "Consultation fee", "Emergency care for exotics", "Boarding for exotic pets", "Diet and housing advice"],
    "pet-therapy-services":            ["Type of therapy offered", "Sessions at home or at a centre", "Who the sessions are for", "Cost per session", "Trainer qualifications"],
    "pet-store":                       ["Brands they stock", "Home delivery", "Prescription diets", "Return policy", "Grooming or vet on site"],
    "pet-adoption":                    ["Animals currently available", "Adoption process and fee", "Home check required", "Vaccination and sterilisation status", "Support after adoption"],
}
DEFAULT_ASK = ["Prices and timings", "Services they offer", "Booking or walk-in", "Payment options", "Location and directions"]


def a_an(word):
    return "an" if str(word or "").strip()[:1].lower() in "aeiou" else "a"


def ask_list(biz):
    return CATEGORY_ASK.get(biz.get("category_slug"), DEFAULT_ASK)


CATEGORY_BLURB = {
    "veterinary-clinics":              "Veterinary clinics handle check-ups, vaccinations, illness and minor procedures for dogs, cats and other pets.",
    "emergency-animal-hospital":       "Emergency animal hospitals take urgent cases such as injuries, poisoning or sudden illness, often outside normal clinic hours.",
    "vaccination-centers":             "Vaccination centres give core and booster vaccines to puppies, kittens and adult pets, and can issue vaccination records.",
    "mobile-vet-services":             "Mobile vets visit you at home for check-ups, vaccinations and sample collection, which helps with anxious or elderly pets.",
    "specialty-vets-exotics-avian-reptiles": "Specialty vets see pets beyond dogs and cats, such as birds, reptiles, rabbits and small mammals.",
    "pet-dental-care":                 "Pet dental care covers check-ups, cleaning, scaling and extractions to keep your pet's teeth and gums healthy.",
    "pet-physiotherapy-rehab":         "Pet physiotherapy helps pets recover after surgery or injury and supports older pets with joint problems.",
    "pet-grooming-spa":                "Groomers bathe, trim and care for your pet's coat, nails and ears, with cuts suited to the breed.",
    "pet-boarding-daycare":            "Boarding and daycare look after your pet while you are at work or away, for a day or a longer stay.",
    "pet-walking":                     "Dog walkers take your dog out for regular exercise, alone or in small groups, while you are busy.",
    "pet-training-obedience-behavior": "Trainers teach puppies and adult dogs basic obedience and help with problems like pulling, barking or aggression.",
    "pet-sitting-in-home-care":        "Pet sitters feed, walk and look after your pet in your own home while you travel.",
    "pet-relocation-services":         "Pet relocation services move pets between cities or countries and help with travel paperwork.",
    "pet-taxi-transport":              "Pet taxis drive you and your pet to the vet, groomer, airport or a new home.",
    "veterinary-labs-diagnostics":     "Veterinary labs run blood tests and other diagnostics that vets use to find out what is wrong.",
    "pet-therapy-services":            "Pet therapy services use trained animals to support people in hospitals, schools and care homes.",
    "pet-store":                       "Pet stores sell food, treats, toys, accessories and supplies for your pet.",
    "pet-adoption":                    "Adoption centres and rescues find new homes for dogs, cats and other animals.",
}

# Schema.org maps (LocalBusiness subtypes that Google understands).
SCHEMA_TYPE = {
    "veterinary-clinics":              "VeterinaryCare",
    "emergency-animal-hospital":       "VeterinaryCare",
    "vaccination-centers":             "VeterinaryCare",
    "mobile-vet-services":             "VeterinaryCare",
    "specialty-vets-exotics-avian-reptiles": "VeterinaryCare",
    "veterinary-labs-diagnostics":     "MedicalClinic",
    "pet-dental-care":                 "VeterinaryCare",
    "pet-physiotherapy-rehab":         "VeterinaryCare",
    "pet-grooming-spa":                "LocalBusiness",
    "pet-boarding-daycare":            "LocalBusiness",
    "pet-walking":                     "LocalBusiness",
    "pet-training-obedience-behavior": "LocalBusiness",
    "pet-sitting-in-home-care":        "LocalBusiness",
    "pet-relocation-services":         "MovingCompany",
    "pet-taxi-transport":              "TaxiService",
    "pet-therapy-services":            "LocalBusiness",
}

# ---- Helpers --------------------------------------------------------------

def e(s):    return escape(str(s or ""), quote=False)
def ea(s):   return escape(str(s or ""), quote=True)
def slugify(s):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", (s or "").lower()))[:64]

def country_name(c):  return "India" if c == "IN" else "USA"
def country_lc(c):    return "in" if c == "IN" else "us"

def seed_of(s):  return sum(ord(c) for c in (s or ""))

def djb2(s):
    """Same djb2 hash pet-images.js uses, so img_for() picks the identical
    photo index for a given listing id as the client-side renderer."""
    h = 5381
    for c in (s or ""):
        h = ((h << 5) + h + ord(c)) & 0xFFFFFFFF
    return h

def js(value):
    """JSON for embedding inside a <script> block.

    json.dumps leaves "</script>" intact, so a business name containing it would
    close the tag and turn the rest of the name into markup. U+2028/2029 are
    valid JSON but end a line in older JavaScript parsers.
    """
    return (json.dumps(value, ensure_ascii=False)
            .replace("</", "<\\/")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))

def clean_website(w):
    """Mirror of cleanWebsite() in listing.html.

    Scraped `website` values are often Google Ads /aclk redirects, bare paths or
    google.com links. Only a real external http(s) URL is shown or put in schema.
    """
    if not w or not isinstance(w, str):
        return None
    w = w.strip()
    if not re.match(r"^https?://", w, re.I):
        return None
    try:
        u = urlparse(w)
    except ValueError:
        return None
    h = (u.hostname or "").lower()
    if not h or re.search(r"(^|\.)google\.(com|co\.[a-z]+)$", h) or h == "business.google.com" or u.path.startswith("/aclk"):
        return None
    return w

def img_for(biz, idx=0, w=600, h=450):
    pool = IMG_POOL.get(biz.get("category_slug"), DEFAULT_IMGS)
    key  = biz.get("id") or biz.get("name") or ""
    pic  = pool[(djb2(key) + idx) % len(pool)]
    return f"https://images.unsplash.com/{pic}?w={w}&h={h}&fit=crop&q=70"

def amenities_for(biz, n=10):
    """Services the business itself listed (vendor or admin). Nothing is made up."""
    return services_of(biz)[:n]

# The old version of this drew ten "recent customer ratings" from a hash of the
# listing id. They looked like real ratings and were not: no customer gave them.
# Showing invented ratings against a named business is not something we can put
# in front of a pet owner, so the block is gone. What remains on the page is the
# real Google average, the real review count, and reviews people actually left
# on Pets24x7.

def has_rating(b):
    """A real Google rating: a score and at least one review behind it.

    Unknown is rating None / review_count 0 (see build_data.py); a score with
    no count behind it is not shown, and never goes into AggregateRating.
    """
    return (b.get("review_count") or 0) >= 1 and (b.get("rating") or 0) > 0

def is_top_rated(b):
    return has_rating(b) and b["rating"] >= 4.8 and b["review_count"] >= 100


# ---- Listing detail published from the database ---------------------------
# scripts/export-listings-static.mjs adds these keys only when they hold
# something; data written by build_data.py has none of them, and such a listing
# renders exactly as before.

_PUBLIC_URL = re.compile(r"""^(https?://[^\s"'<>]+|/(?!/)[^\s"'<>]*)$""", re.I)

def own_photos(biz, limit=10):
    """The business's own photos: http(s) or site-relative URLs only."""
    out = []
    for u in biz.get("photos") or []:
        if isinstance(u, str) and _PUBLIC_URL.match(u.strip()) and u.strip() not in out:
            out.append(u.strip())
    return out[:limit]

def services_of(biz):
    v = biz.get("services")
    if isinstance(v, str):
        v = re.split(r"[\n,;]+", v)
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        x = str(x or "").strip()
        if x and x.lower() not in (o.lower() for o in out):
            out.append(x[:80])
    return out[:30]

def text_of(biz, key, limit):
    v = biz.get(key)
    if not isinstance(v, str):
        return ""
    v = v.strip()
    return v[:limit]

def paras_html(text):
    """Plain text -> <p> per blank-line block, <br> per line. Escaped."""
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text or "") if b.strip()]
    return "".join(f'<p style="margin-top:10px;">{"<br>".join(e(l) for l in b.splitlines())}</p>' for b in blocks)

def area_label(biz):
    """'Locality, City' when a locality is known."""
    loc = text_of(biz, "locality", 160)
    return f"{loc}, {biz['city']}" if loc and loc.lower() != str(biz.get("city", "")).lower() else biz["city"]

def is_hidden(b):
    v = b.get("hidden")
    return v is True or v == 1 or str(v).lower() in ("1", "true", "yes") or str(b.get("active", "yes")).lower() == "no"


def listing_url(biz):
    return f"/{country_lc(biz['country'])}/{slugify(biz['city_slug'])}/{biz['id']}/"

def city_url(country, city_slug, page=1):
    base = f"/{country_lc(country)}/{slugify(city_slug)}/"
    return base if page == 1 else f"{base}page/{page}/"

def category_url(country, city_slug, cat_slug):
    return f"/{country_lc(country)}/{slugify(city_slug)}/{slugify(cat_slug)}/"

def wa_link_for(biz):
    msg = (f"Hi Pets24x7! I'm interested in '{biz['name']}' "
           f"({biz['category']}, {biz['city']}). "
           f"Please share availability, services and pricing.")
    from urllib.parse import quote
    return (f"https://wa.me/{WA_NUMBER}?text={quote(msg)}"
            f"&utm_source=website&utm_medium=listing_page&utm_campaign=enquiry")

def wa_link_city(city, category=None):
    cat = category or "pet service"
    msg = f"Hi Pets24x7! I need a {cat} in {city}. Please share recommendations."
    from urllib.parse import quote
    return f"https://wa.me/{WA_NUMBER}?text={quote(msg)}&utm_source=website&utm_medium=city_page&utm_campaign=enquiry"

# ---- Shared chrome (header, footer, floating WA) -------------------------

def header_html(active=None):
    return f"""\
<header class="hdr"><div class="hdr-in">
  <a href="/" class="brand">
    <img class="brand-logo" src="/pets24x7_logo.png" alt="Pets24x7" width="500" height="182" />
  </a>
  <div class="hdr-right">
    <nav class="hdr-nav" id="siteNav" aria-label="Main">
      <a href="/#cats"{' aria-current="page"' if active=="categories" else ""}>Categories</a>
      <a href="/marketing.html"{' aria-current="page"' if active=="marketing" else ""}>For Businesses</a>
      <a href="/membership/"{' aria-current="page"' if active=="membership" else ""}>Membership</a>
      <a href="/login/"{' aria-current="page"' if active=="login" else ""}>Sign In</a>
    </nav>
    <a href="tel:+{WA_NUMBER}" class="call-link">📞 +91 99300 90487</a>
    <a href="https://wa.me/{WA_NUMBER}?text=Hi%20Pets24x7!" class="hdr-cta" target="_blank" rel="noopener" aria-label="Chat with Pets24x7 on WhatsApp">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
      <span>Chat</span>
    </a>
    <button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="siteNav">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</div></header>
"""

def footer_html():
    return f"""\
<footer><div class="foot-in">
  <span>© 2026 Pets24x7.com — Pet Services Marketplace.</span>
  <span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/marketing.html">For Businesses</a> · <a href="https://wa.me/{WA_NUMBER}">WhatsApp</a> · <a href="mailto:hello@pets24x7.com">hello@pets24x7.com</a></span>
</div></footer>
<a href="https://wa.me/{WA_NUMBER}?text=Hi%20Pets24x7!%20I%20need%20a%20pet%20service%20recommendation..." class="float-wa" target="_blank" rel="noopener" aria-label="Help on WhatsApp">
  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
  <span>Help on WhatsApp</span>
</a>
<script src="/nav-auth.js" defer></script>
"""

def google_logo_html():
    return ('<span class="glogo"><span class="gB">G</span><span class="go1">o</span>'
            '<span class="go2">o</span><span class="gg">g</span><span class="gl">l</span>'
            '<span class="ge">e</span></span>')

# ---- Schema generators ----------------------------------------------------

def breadcrumb_jsonld(items):
    """items = [(name, url_or_none), ...] — url is None for the last (current) item.

    Google requires an `item` URL on every crumb but the last. A crumb with no
    page of its own ("India": there is no /in/ page) stays in the visible trail
    and is left out here, with positions renumbered.
    """
    out = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": []}
    last = len(items) - 1
    for i, (name, url) in enumerate(items):
        if not url and i != last:
            continue
        entry = {"@type": "ListItem", "position": len(out["itemListElement"]) + 1, "name": name}
        if url:
            entry["item"] = SITE + url
        out["itemListElement"].append(entry)
    return js(out)

def abs_url(u):
    return u if re.match(r"^https?://", u or "", re.I) else SITE + "/" + (u or "").lstrip("/")

# Google shows roughly 60 characters of a title and cuts the rest mid-word;
# scraped business names and the long category labels ("Pet Training
# (Obedience, Behavior)") pushed most listing titles to 80-120. The first
# candidate that fits wins; the last one is cut at a word boundary.
TITLE_MAX = 65


def short_category(name):
    return re.sub(r"\s*\([^)]*\)", "", name or "").strip()


def fit_title(*candidates):
    for t in candidates:
        if len(t) <= TITLE_MAX:
            return t
    last = candidates[-1]
    cut = last[:TITLE_MAX - 1].rsplit(" ", 1)[0].rstrip(" ,-—|:")
    return cut + "…"


def social_meta(title, desc, url, image=None, image_alt=None, og_type="website", extra=None):
    """Open Graph + Twitter card tags. Every URL is absolute: scrapers do not
    resolve relative ones. `extra` is [(property, content), ...] for og_type
    specific tags (business:contact_data:* on a listing)."""
    image = abs_url(image or OG_IMAGE)
    alt = image_alt or SITE_NAME
    tags = [
        ("property", "og:type", og_type),
        ("property", "og:site_name", SITE_NAME),
        ("property", "og:title", title),
        ("property", "og:description", desc),
        ("property", "og:url", url),
        ("property", "og:image", image),
        ("property", "og:image:alt", alt),
    ]
    tags += [("property", k, v) for k, v in (extra or []) if v]
    tags += [
        ("name", "twitter:card", "summary_large_image"),
        ("name", "twitter:title", title),
        ("name", "twitter:description", desc),
        ("name", "twitter:image", image),
        ("name", "twitter:image:alt", alt),
    ]
    return "\n".join(f'<meta {attr}="{k}" content="{ea(v)}" />' for attr, k, v in tags)

def listing_jsonld(biz):
    obj = {
        "@context": "https://schema.org",
        "@type": SCHEMA_TYPE.get(biz["category_slug"], "LocalBusiness"),
        "@id": SITE + listing_url(biz),
        "name": biz["name"],
        "url": SITE + listing_url(biz),
        "image": abs_url(own_photos(biz)[0]) if own_photos(biz) else img_for(biz, 0, 1200, 800),
        "description": (text_of(biz, "description", 300) or
                        (f'{biz["name"]} is {a_an(biz["category"])} {biz["category"].lower()} in '
                         f'{biz["city"]}{", " + biz["state"] if biz.get("state") else ""}.'
                         + (f' Rated {biz["rating"]}/5 on Google from {biz["review_count"]} reviews.' if has_rating(biz) else ''))),
        # Empty strings are dropped: "postalCode": "" is an invalid value to a
        # validator, where a missing optional field is not.
        "address": {k: v for k, v in {
            "@type": "PostalAddress",
            "streetAddress": biz.get("address") or "",
            "addressLocality": biz["city"],
            "addressRegion": biz.get("state") or "",
            "postalCode": biz.get("pincode") or "",
            "addressCountry": biz["country"],
        }.items() if v},
    }
    # A listing with no reviews used to be published as "1 review" at its
    # default rating, and every listing claimed a "$$" price band nobody
    # measured. Only real figures go into structured data.
    if has_rating(biz):
        obj["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": biz["rating"],
            "reviewCount": biz["review_count"],
            "bestRating": 5,
            "worstRating": 1,
        }
    if biz.get("phone"):
        obj["telephone"] = biz["phone"]
    if biz.get("email"):
        obj["email"] = biz["email"]
    same_as = [x for x in (clean_website(biz.get("website")), biz.get("gmb_link")) if x]
    if same_as:
        obj["sameAs"] = same_as
    return js(obj)

def itemlist_jsonld(items, city, base_url):
    """For city / category pages — a summary ItemList of the businesses on this page."""
    out = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": f"Pet services in {city}",
        "itemListOrder": "https://schema.org/ItemListOrderDescending",
        "numberOfItems": len(items),
        "itemListElement": []
    }
    for i, b in enumerate(items[:20], start=1):
        out["itemListElement"].append({
            "@type": "ListItem",
            "position": i,
            "url": SITE + listing_url(b),
            "name": b["name"],
        })
    return js(out)

# ---- Components ----------------------------------------------------------

def biz_card_html(b, badge=None):
    img = (own_photos(b) or [img_for(b, 0)])[0]
    amens = "".join(f'<span class="amenity">{e(a)}</span>' for a in amenities_for(b, 4))
    badge_html = ""
    if badge == "top":
        badge_html = '<span class="badge">Top Rated</span>'
    elif badge == "featured":
        badge_html = '<span class="badge" style="background:var(--warning);color:#1F2937;">Featured</span>'

    google_box = ""
    if b.get("google_cid") and has_rating(b):
        google_box = (f'<span class="google-badge"><span class="gscore">{b["rating"]:.1f}/5</span>'
                      f'{google_logo_html()}'
                      f'<a href="https://www.google.com/maps?cid={ea(b["google_cid"])}" '
                      f'target="_blank" rel="noopener">{b["review_count"]} reviews</a></span>')

    phone_html = ""
    if b.get("phone"):
        clean_phone = re.sub(r"\s+", "", b["phone"])
        phone_html = (f'<div class="biz-phone">📞 <a href="tel:{ea(clean_phone)}">'
                      f'{e(b["phone"])}</a></div>')

    return f"""<article class="biz-card" data-lid="{ea(b["id"])}">
  <a class="biz-img" href="{listing_url(b)}">
    {badge_html}
    <span class="ct-chip">{e(b.get("category_icon") or "📍")} {e(b["category"])}</span>
    <img loading="lazy" src="{ea(img)}" alt="{ea(b["name"])}" width="280" height="210" onerror="this.style.display='none';">
  </a>
  <div class="biz-info">
    <h3><a href="{listing_url(b)}">{e(b["name"])}</a></h3>
    <div class="biz-loc">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
      {e(b.get("address") or (area_label(b) + (", " + b["state"] if b.get("state") else "")))}
    </div>
    <div class="biz-rating">
      {f'<span class="rating-pill">★ {b["rating"]:.1f}</span>' if has_rating(b) else ''}
      {'<span class="rating-pill" style="background:#DCFCE7;color:#166534;">✓ Owner-managed</span>' if b.get("claimed") else ''}
      {google_box}
    </div>
    {f'<div class="amenities">{amens}</div>' if amens else ''}
  </div>
  <div class="biz-action">
    {phone_html}
    <a class="open-btn" href="{listing_url(b)}">View Details</a>
    <a class="wa-btn" href="{ea(wa_link_for(b))}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
      WhatsApp →
    </a>
    {f'<a class="map-link" href="https://www.google.com/maps?cid={ea(b["google_cid"])}" target="_blank" rel="noopener">View on Google Maps ↗</a>' if b.get("google_cid") else ""}
  </div>
</article>"""

RECO_TRACK_TAG = '<script src="/reco-track.js" defer></script>'

# Listing-page recommendations ("Top-rated similar" + "Also nearby"), shared
# verbatim with listing.html. Plain string, not an f-string: its braces are JS.
RECO_LISTING_JS = r'''/* Recommendations on a listing page: "Top-rated similar" (with at most one
   labelled sponsored card first) and "Also nearby", from GET /api/reco/listing/:id.
   Both sections stay hidden when the API has nothing or fails. Impressions and
   clicks go through /reco-track.js; internal links carry ?src=reco_<surface>. */
(function(){
  var RBASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) ||
    ((location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') ? '' : 'https://api.pets24x7.com');

  function resc(v){
    return String(v == null ? '' : v).replace(/[<>&"']/g, function(c){
      return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function itemUrl(it, surface){
    var u = String(it.url || '');
    if (!/^\/(?!\/)/.test(u)) {
      u = '/' + String(it.country || 'in').toLowerCase() + '/' + encodeURIComponent(it.city_slug || '') + '/' + encodeURIComponent(it.id) + '/';
    }
    if (u.indexOf('src=') === -1) u += (u.indexOf('?') === -1 ? '?' : '&') + 'src=reco_' + surface;
    return u;
  }
  // Outbound vendor links carry UTM so the business sees Pets24x7 traffic in
  // its own analytics. The API already adds it; this only fills a gap.
  function outUrl(u, surface){
    try {
      var x = new URL(String(u || ''));
      if (!/^https?:$/.test(x.protocol)) return '';
      if (!x.searchParams.has('utm_source')) {
        x.searchParams.set('utm_source', 'pets24x7');
        x.searchParams.set('utm_medium', 'referral');
        x.searchParams.set('utm_campaign', 'reco_' + surface);
      }
      return x.toString();
    } catch (e) { return ''; }
  }
  function cardHtml(it, rid, surface, pos){
    var sp = !!it.sponsored;
    var label = it.label || 'Sponsored';
    var rc = Number(it.review_count) || 0;
    // A score is shown only with a count behind it, as on the static pages.
    var rating = rc >= 1 ? (Number(it.rating) || 0) : 0;
    var why = sp ? '' : ((it.reason && it.reason.text) || '');
    var web = sp && it.website ? outUrl(it.website, surface) : '';
    var reason = sp ? 'SPONSORED' : ((it.reason && it.reason.code) || '');
    return '<article class="reco-card' + (sp ? ' is-sponsored' : '') + '"' +
        ' data-rid="' + resc(rid) + '" data-lid="' + resc(it.id) + '" data-pos="' + (Number(it.pos) || pos) + '"' +
        ' data-reason="' + resc(reason) + '" data-sp="' + (sp ? '1' : '0') + '" data-surface="' + surface + '">' +
      (sp ? '<span class="badge-sponsored" aria-label="Sponsored listing">' + resc(label) + '</span>' : '') +
      '<a class="reco-name reco-link" href="' + resc(itemUrl(it, surface)) + '">' + resc(it.name) + '</a>' +
      '<div class="reco-meta">' +
        (rating ? '<span class="rating-pill">★ ' + rating.toFixed(1) + '</span>' : '') +
        (rc ? '<span>' + rc + ' reviews</span>' : '') +
        '<span>' + resc(it.category_icon || '') + ' ' + resc(it.category || '') + '</span>' +
      '</div>' +
      (why ? '<div class="reco-why">' + resc(why) + '</div>' : '') +
      (web ? '<a class="reco-web" href="' + resc(web) + '" target="_blank" rel="sponsored noopener">Website ↗</a>' : '') +
    '</article>';
  }
  function skeleton(n){ var s = ''; for (var i = 0; i < n; i++) s += '<div class="reco-skel" aria-hidden="true"></div>'; return s; }

  function whenTracker(fn){
    if (window.recoTrack) { try { fn(window.recoTrack); } catch (e) {} return; }
    window.addEventListener('load', function(){ if (window.recoTrack) { try { fn(window.recoTrack); } catch (e) {} } });
  }
  // Card clicks: the tracker when it loaded, otherwise one keepalive event so
  // a slow or blocked /reco-track.js does not lose the click.
  function onCardClick(el){
    var d = el.dataset || {};
    var sp = d.sp === '1';
    try { if (window.trackEvent) window.trackEvent(sp ? 'sponsored_click' : 'reco_click', { surface: d.surface, reason: d.reason, listing_id: d.lid }); } catch (e) {}
    if (window.recoTrack && window.recoTrack.click) { try { window.recoTrack.click(el); } catch (e) {} return; }
    var ev = { rid: d.rid, type: 'click', listingId: d.lid, pos: Number(d.pos) || undefined, reason: d.reason || undefined, sponsored: sp, surface: d.surface };
    try { sessionStorage.setItem('reco:last', JSON.stringify({ rid: d.rid, listingId: d.lid, surface: d.surface, pos: ev.pos, reason: d.reason, sponsored: sp, ts: Date.now() })); } catch (e) {}
    try {
      fetch(RBASE + '/api/reco/events', { method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [ev] }) }).catch(function(){});
    } catch (e) {}
  }
  function wire(box){
    if (box.getAttribute('data-reco-wired')) return;
    box.setAttribute('data-reco-wired', '1');
    box.addEventListener('click', function(ev){
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      var el = a && a.closest('[data-lid]');
      if (el) onCardClick(el);
    });
  }

  function fill(sectionId, items, rid, surface, lead){
    var sec = document.getElementById(sectionId);
    var box = document.getElementById(sectionId + 'List');
    if (!sec || !box) return;
    var list = (lead ? [lead] : []).concat(items || []);
    if (!list.length) { sec.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = list.map(function(it, i){ return cardHtml(it, rid, surface, i + 1); }).join('');
    sec.hidden = false;
    wire(box);
    whenTracker(function(t){ if (t.observe) t.observe(box, surface); });
  }

  // Landing attribution: ?src=reco_<surface> came from a recommendation card.
  // Returns the src (for the listing_view `source`) and reports the click once
  // when the card's rid is known from sessionStorage 'reco:last'.
  window.recoLandingSource = function(listingId){
    var src = '';
    try { src = new URLSearchParams(location.search).get('src') || ''; } catch (e) {}
    if (!/^reco_[a-z0-9_]{1,35}$/.test(src)) return '';
    try {
      var raw = sessionStorage.getItem('reco:last');
      var last = null;
      if (raw) { try { last = JSON.parse(raw); } catch (e) { last = { rid: raw }; } }
      var rid = last && (typeof last === 'string' ? last : last.rid);
      var lid = last && typeof last === 'object' ? (last.listingId || last.lid) : '';
      if (rid && /^[A-Za-z0-9_-]{8,64}$/.test(rid) && (!lid || lid === listingId)) {
        sessionStorage.removeItem('reco:last');
        var ev = { rid: rid, type: 'click', listingId: listingId, surface: src.slice(5) };
        if (last && typeof last === 'object') {
          if (last.pos) ev.pos = Number(last.pos) || undefined;
          if (last.reason) ev.reason = last.reason;
          if (last.sponsored != null || last.sp != null) ev.sponsored = !!(last.sponsored || last.sp === '1' || last.sp === true);
        }
        fetch(RBASE + '/api/reco/events', { method: 'POST', credentials: 'include', keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [ev] }) }).catch(function(){});
      }
    } catch (e) {}
    return src;
  };

  window.loadRecoListing = function(listingId){
    if (!listingId || !window.fetch) return;
    var simBox = document.getElementById('recoSimilarList');
    var simSec = document.getElementById('recoSimilar');
    if (simBox && simSec) { simBox.innerHTML = skeleton(3); simSec.hidden = false; }
    var nearBox = document.getElementById('recoNearbyList');
    var nearSec = document.getElementById('recoNearby');
    if (nearBox && nearSec) { nearBox.innerHTML = skeleton(3); nearSec.hidden = false; }
    fetch(RBASE + '/api/reco/listing/' + encodeURIComponent(listingId) + '?limit=6', { credentials: 'omit', headers: { 'Accept': 'application/json' } })
      .then(function(r){ if (!r.ok) throw new Error('reco ' + r.status); return r.json(); })
      .then(function(d){
        if (!d || !d.ok) throw new Error('reco');
        var rid = d.rid || '';
        var sponsored = d.sponsored && d.sponsored.id !== listingId ? d.sponsored : null;
        var similar = (d.similar || []).filter(function(it){ return it && it.id !== listingId && (!sponsored || it.id !== sponsored.id); });
        var seen = {}; similar.forEach(function(it){ seen[it.id] = 1; }); if (sponsored) seen[sponsored.id] = 1;
        var nearby = (d.nearby || []).filter(function(it){ return it && it.id !== listingId && !seen[it.id]; });
        fill('recoSimilar', similar, rid, 'listing_similar', sponsored);
        fill('recoNearby', nearby, rid, 'listing_nearby', null);
      })
      .catch(function(){
        ['recoSimilar', 'recoNearby'].forEach(function(id){ var s = document.getElementById(id); if (s) s.hidden = true; });
      });
  };
})();
'''


def reco_click_helper_script():
    """window.recoCardClick(el): one place for reco/sponsored card clicks.

    Uses /reco-track.js when it loaded; otherwise sends a single keepalive
    event so a slow or blocked tracker does not lose the click. Also fires the
    GA4 reco_click / sponsored_click events.
    """
    return """<script>
(function(){
  if (window.recoCardClick) return;
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || (isLocal ? '' : 'https://api.pets24x7.com');
  window.recoCardClick = function(el){
    var d = (el && el.dataset) || {};
    if (!d.rid || !d.lid) return;
    var sp = d.sp === '1';
    try { if (window.trackEvent) window.trackEvent(sp ? 'sponsored_click' : 'reco_click', { surface: d.surface, reason: d.reason, listing_id: d.lid }); } catch (e) {}
    if (window.recoTrack && window.recoTrack.click) { try { window.recoTrack.click(el); } catch (e) {} return; }
    var ev = { rid: d.rid, type: 'click', listingId: d.lid, pos: Number(d.pos) || undefined, reason: d.reason || undefined, sponsored: sp, surface: d.surface };
    try { sessionStorage.setItem('reco:last', JSON.stringify({ rid: d.rid, listingId: d.lid, surface: d.surface, pos: ev.pos, reason: d.reason, sponsored: sp, ts: Date.now() })); } catch (e) {}
    try {
      fetch(BASE + '/api/reco/events', { method: 'POST', credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [ev] }) }).catch(function(){});
    } catch (e) {}
  };
  // observe once the deferred tracker is there (it may load after the fetch).
  window.recoObserve = function(box, surface){
    function go(){ if (window.recoTrack && window.recoTrack.observe) { try { window.recoTrack.observe(box, surface); } catch (e) {} return true; } return false; }
    if (!go()) window.addEventListener('load', go);
  };
})();
</script>"""


def reco_rail_html():
    """Category page: 'Top rated in {city}' across the other services."""
    return ('<section class="reco-section" id="recoCityRail" hidden aria-labelledby="recoCityRailH">'
            '<h2 id="recoCityRailH">More pet services in this city</h2>'
            '<p class="reco-sub" id="recoCityRailSub"></p>'
            '<div class="reco-row" id="recoCityRailList"></div>'
            '</section>')


def reco_rail_script(country, city_slug, city_name, category_slug):
    """Fills the rail from GET /api/reco/city (organic only: the paid strip at
    the top of the page already carries this page's sponsored placement).
    Listings of this page's own category are skipped — they are already here."""
    return f"""<script>
(function(){{
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || (isLocal ? '' : 'https://api.pets24x7.com');
  var CITY = {js(city_name)}, CAT = {js(category_slug)};
  var sec = document.getElementById('recoCityRail');
  var box = document.getElementById('recoCityRailList');
  if (!sec || !box || !window.fetch) return;
  function esc(v){{
    return String(v == null ? '' : v).replace(/[<>&"']/g, function(c){{
      return {{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}}[c];
    }});
  }}
  function url(it){{
    var u = String(it.url || '');
    if (!/^\\/(?!\\/)/.test(u)) u = '/' + String(it.country || 'in').toLowerCase() + '/' + encodeURIComponent(it.city_slug || '') + '/' + encodeURIComponent(it.id) + '/';
    if (u.indexOf('src=') === -1) u += (u.indexOf('?') === -1 ? '?' : '&') + 'src=reco_city_top';
    return u;
  }}
  var qs = 'city=' + encodeURIComponent({js(city_slug)}) + '&country=' + encodeURIComponent({js(country)}) + '&sort=top&limit=12&sponsored=0';
  fetch(BASE + '/api/reco/city?' + qs, {{ credentials: 'omit', headers: {{ 'Accept': 'application/json' }} }})
    .then(function(r){{ if (!r.ok) throw new Error('reco ' + r.status); return r.json(); }})
    .then(function(d){{
      var items = ((d && d.items) || []).filter(function(it){{ return it && it.category_slug !== CAT && !it.sponsored; }}).slice(0, 6);
      if (!items.length) return;
      var rid = d.rid || '';
      document.getElementById('recoCityRailH').textContent = 'More pet services in ' + (d.city || CITY);
      document.getElementById('recoCityRailSub').textContent = 'Vets, groomers, boarding and more in ' + (d.city || CITY);
      box.innerHTML = items.map(function(it, i){{
        var rc = Number(it.review_count) || 0, rating = rc >= 1 ? (Number(it.rating) || 0) : 0;
        var why = (it.reason && it.reason.text) || '';
        return '<article class="reco-card" data-rid="' + esc(rid) + '" data-lid="' + esc(it.id) + '" data-pos="' + (Number(it.pos) || i + 1) + '"' +
            ' data-reason="' + esc((it.reason && it.reason.code) || '') + '" data-sp="0" data-surface="city_top">' +
          '<a class="reco-name reco-link" href="' + esc(url(it)) + '">' + esc(it.name) + '</a>' +
          '<div class="reco-meta">' + (rating ? '<span class="rating-pill">\u2605 ' + rating.toFixed(1) + '</span>' : '') +
            (rc ? '<span>' + rc + ' reviews</span>' : '') +
            '<span>' + esc(it.category_icon || '') + ' ' + esc(it.category || '') + '</span></div>' +
          (why ? '<div class="reco-why">' + esc(why) + '</div>' : '') +
        '</article>';
      }}).join('');
      sec.hidden = false;
      box.addEventListener('click', function(ev){{
        var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
        var el = a && a.closest('[data-lid]');
        if (el && window.recoCardClick) window.recoCardClick(el);
      }});
      if (window.recoObserve) window.recoObserve(box, 'city_top');
    }})
    .catch(function(){{ sec.hidden = true; }});
}})();
</script>"""


def popular_strip_html():
    """Empty until the activity data can carry the claim. See /api/listings/popular."""
    return ('<div class="popular-strip" id="popularStrip" hidden>'
            '<div class="popular-head">Most contacted this month '
            '<span id="popularNote"></span></div>'
            '<div class="popular-row" id="popularList"></div>'
            '</div>')


def popular_script(city_name, category_name=None):
    """Ranks by phone, WhatsApp and website taps over the last 30 days.

    Views are not counted: a view is where the reader already was, a tap is a
    decision. The API returns nothing until enough people have tapped, so a
    quiet city prints no leaderboard rather than a misleading one.
    """
    cat = f", category: {js(category_name)}" if category_name else ""
    return f"""<script>
(function(){{
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || (isLocal ? '' : 'https://api.pets24x7.com');
  var params = {{ city: {js(city_name)}{cat} }};
  var qs = Object.keys(params).map(function(k){{ return k + '=' + encodeURIComponent(params[k]); }}).join('&');

  function esc(v){{
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }}

  fetch(BASE + '/api/listings/popular?' + qs, {{ credentials: 'omit' }})
    .then(function(r){{ return r.json(); }})
    .then(function(d){{
      if (!d || !d.enough || !(d.cards || []).length) return;
      var strip = document.getElementById('popularStrip');
      var list = document.getElementById('popularList');
      var note = document.getElementById('popularNote');
      if (!strip || !list) return;
      if (note) note.textContent = 'Ranked by calls and WhatsApp messages in the last ' + (d.windowDays || 30) + ' days';
      list.innerHTML = d.cards.map(function(c, i){{
        return '<a class="popular-card" href="' + esc(c.url) + '">' +
          '<span class="popular-rank">' + (i + 1) + '</span>' +
          '<span class="popular-name">' + esc(c.name) + '</span>' +
          '<span class="popular-meta">' + esc(c.category) + (Number(c.rating) > 0 && Number(c.reviewCount) >= 1 ? ' \u00b7 \u2605 ' + Number(c.rating).toFixed(1) : '') + '</span>' +
          '<span class="popular-count">' + c.contacts + ' contacted</span>' +
        '</a>';
      }}).join('');
      strip.hidden = false;
    }})
    .catch(function(){{}});
}})();
</script>"""


def wa_link_featured(name, city, category=None):
    """Owner asking about paid placement: goes to the Pets24x7 sales WhatsApp."""
    what = f"{name} ({category}, {city})" if category else f"{name} in {city}"
    msg = f"Hi Pets24x7! I'd like to know about Featured placement for {what}."
    from urllib.parse import quote
    return f"https://wa.me/{WA_NUMBER}?text={quote(msg)}&utm_source=website&utm_medium=owner_cta&utm_campaign=featured"


def owner_card_html(biz, city):
    """Listing sidebar: claim for unclaimed listings, featured upsell for all."""
    from urllib.parse import urlencode
    feat = wa_link_featured(biz["name"], city, biz.get("category"))
    if biz.get("claimed"):
        return f"""<div class="owner-card">
        <strong>✓ Managed by the business</strong>
        <p>The details on this page are kept up to date by {e(biz["name"])}.</p>
        <p class="owner-small">Is this your business? <a href="/vendor-login/">Sign in to your dashboard</a> · <a href="{ea(feat)}" target="_blank" rel="noopener">Get featured in {e(city)}</a></p>
      </div>"""
    claim = "/find-my-listing/?" + urlencode({"q": biz["name"], "city": city})
    return f"""<div class="owner-card">
        <strong>Own {e(biz["name"])}?</strong>
        <p>Claim this listing free. Add your photos, services and opening hours, and get customer enquiries straight to your WhatsApp.</p>
        <a class="owner-btn" href="{ea(claim)}">Claim this listing, free</a>
        <p class="owner-small">Want more customers? <a href="{ea(feat)}" target="_blank" rel="noopener">Featured placement</a> puts you at the top of {e(city)} pages.</p>
      </div>"""


def business_cta_html(city, category=None):
    """City and category pages: invite owners to list or get featured."""
    what = f"{category.lower()} business" if category else "pet business"
    feat = wa_link_featured("my business", city, category)
    return f"""<section class="biz-cta" aria-label="For businesses">
    <div>
      <strong>Run a {e(what)} in {e(city)}?</strong>
      <p>List it free and get enquiries from pet parents on WhatsApp. Featured businesses are shown at the top of this page.</p>
    </div>
    <div class="biz-cta-actions">
      <a class="biz-cta-primary" href="/register-business/">List your business free</a>
      <a class="biz-cta-secondary" href="/find-my-listing/">Already listed? Claim it</a>
      <a class="biz-cta-link" href="{ea(feat)}" target="_blank" rel="noopener">Ask about Featured →</a>
    </div>
  </section>"""


def featured_strip_html():
    """Empty container. Filled at runtime — a placement bought this morning has
    to appear on a page that was built last month."""
    return ('<div class="featured-strip" id="featuredStrip" hidden>'
            '<div class="featured-head">Featured placements '
            '<span>Paid promotion</span></div>'
            '<div class="biz-list" id="featuredList"></div>'
            '</div>')


def featured_script(country, city_slug, category_slug=None):
    """Pins businesses that paid for top-of-page placement.

    A listing already printed on this page is moved into the strip rather than
    drawn twice. One that is not on this page — it sits on page 3, or the
    placement covers the whole city while the reader is in one category — is
    drawn from what the API returns.
    """
    cat = f", category: {js(category_slug)}" if category_slug else ""
    return f"""<script>
(function(){{
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || (isLocal ? '' : 'https://api.pets24x7.com');
  var params = {{ city: {js(city_slug)}{cat} }};
  var qs = Object.keys(params).map(function(k){{ return k + '=' + encodeURIComponent(params[k]); }}).join('&');

  function esc(v){{
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }}

  // A score is shown only with a count behind it, as on the static pages.
  function rated(c){{ return Number(c.rating) > 0 && Number(c.reviewCount || c.review_count) >= 1; }}

  function cardFor(c){{
    var loc = esc(c.address || (c.city + (c.state ? ', ' + c.state : '')));
    var tel = c.phone ? String(c.phone).replace(/\\s+/g,'') : '';
    var href = esc(withSrc(c.url));
    return '<article class="biz-card is-featured">' +
      '<a class="biz-img" href="' + href + '">' +
        '<span class="badge badge-featured badge-sponsored" aria-label="Sponsored listing">' + esc(labelOf(c)) + '</span>' +
        '<span class="ct-chip">' + esc(c.categoryIcon || '📍') + ' ' + esc(c.category) + '</span>' +
      '</a>' +
      '<div class="biz-info">' +
        '<h3><a href="' + href + '">' + esc(c.name) + '</a></h3>' +
        '<div class="biz-loc">' + loc + '</div>' +
        '<div class="biz-rating">' + (rated(c) ? '<span class="rating-pill">\u2605 ' + Number(c.rating).toFixed(1) + '</span>' : '') +
          (rated(c) ? '<span class="google-badge"><span class="gscore">' +
            Number(c.rating || 0).toFixed(1) + '/5</span> ' + c.reviewCount + ' reviews</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="biz-action">' +
        (tel ? '<div class="biz-phone">📞 <a href="tel:' + esc(tel) + '">' + esc(c.phone) + '</a></div>' : '') +
        '<a class="open-btn" href="' + href + '">View Details</a>' +
      '</div>' +
    '</article>';
  }}

  // Paid placements are labelled with the server's label ('Sponsored' by
  // default) and report impressions/clicks as surface featured_strip.
  function labelOf(c){{ return c.label || 'Sponsored'; }}
  function withSrc(u){{
    u = String(u || '');
    if (!/^\\/(?!\\/)/.test(u)) return u;
    return u.indexOf('src=') === -1 ? u + (u.indexOf('?') === -1 ? '?' : '&') + 'src=reco_featured_strip' : u;
  }}
  function tag(el, c, rid, pos){{
    el.setAttribute('data-rid', rid);
    el.setAttribute('data-lid', c.id || '');
    el.setAttribute('data-pos', String(pos));
    el.setAttribute('data-reason', 'SPONSORED');
    el.setAttribute('data-sp', '1');
    el.setAttribute('data-surface', 'featured_strip');
  }}

  fetch(BASE + '/api/featured?' + qs, {{ credentials: 'omit' }})
    .then(function(r){{ return r.json(); }})
    .then(function(d){{
      var cards = (d && d.cards) || [];
      if (!cards.length) return;
      var strip = document.getElementById('featuredStrip');
      var list = document.getElementById('featuredList');
      if (!strip || !list) return;

      var rid = (d && d.rid) || '';
      cards.slice(0, 3).forEach(function(c, i){{
        var existing = document.querySelector('.biz-list .biz-card[data-lid="' + (c.id || '').replace(/"/g,'') + '"]');
        var el = null;
        if (existing && existing.parentNode !== list) {{
          // Move the card that is already here, so nothing appears twice and
          // the page count below stays honest.
          existing.classList.add('is-featured');
          var img = existing.querySelector('.biz-img');
          if (img) {{
            // A paid card must not also claim an organic "Top Rated" badge.
            var old = img.querySelector('.badge');
            if (old) old.parentNode.removeChild(old);
            var b = document.createElement('span');
            b.className = 'badge badge-featured badge-sponsored';
            b.setAttribute('aria-label', 'Sponsored listing');
            b.textContent = labelOf(c);
            img.insertBefore(b, img.firstChild);
          }}
          Array.prototype.forEach.call(existing.querySelectorAll('a[href^="/"]'), function(a){{
            a.setAttribute('href', withSrc(a.getAttribute('href')));
          }});
          list.appendChild(existing);
          el = existing;
        }} else if (!existing) {{
          list.insertAdjacentHTML('beforeend', cardFor(c));
          el = list.lastElementChild;
        }}
        if (el && rid) tag(el, c, rid, i + 1);
      }});

      if (list.children.length) {{
        strip.hidden = false;
        if (rid) {{
          list.addEventListener('click', function(ev){{
            var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
            var el = a && a.closest('[data-rid]');
            if (el && window.recoCardClick) window.recoCardClick(el);
          }});
          if (window.recoObserve) window.recoObserve(list, 'featured_strip');
        }}
      }}
    }})
    .catch(function(){{}});
}})();
</script>"""


# Listings added after this page was built are live in the API straight away;
# the next publish bakes them in. Until then this appends them to the list, and
# drops cards the API no longer returns (hidden or deleted) when it returned
# the whole set. The page is complete without it: it never blocks rendering,
# makes at most two bounded requests, and any failure changes nothing.
# `known` is the djb2 hash (base 36) of every listing id this page's set had
# at build time, so a listing that sits on another page of the city is not
# mistaken for a new one. Plain string, not an f-string: its braces are JS.
LIVE_MERGE_JS = r'''(function(){
  var C = window.P24_LIVE;
  if (!C || !window.fetch) return;
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  var BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) || (isLocal ? '' : 'https://api.pets24x7.com');
  var list = document.querySelector('main .biz-list:not(#featuredList)');
  if (!list) return;
  var known = {};
  String(C.known || '').split(',').forEach(function(h){ if (h) known[h] = 1; });
  // Same djb2 as build_pages.djb2 (code points, 32-bit).
  function djb2(s){
    var h = 5381;
    Array.from(String(s)).forEach(function(ch){ h = (((h << 5) >>> 0) + h + ch.codePointAt(0)) >>> 0; });
    return h.toString(36);
  }
  function esc(v){
    return String(v == null ? '' : v).replace(/[<>&"']/g, function(c){
      return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function slug(v){ return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function nameKey(b){ return String(b.name || '').toLowerCase().trim() + '|' + String(b.city || '').toLowerCase().trim(); }
  function url(b){ return '/' + String(b.country || C.country).toLowerCase() + '/' + encodeURIComponent(b.city_slug || C.city) + '/' + encodeURIComponent(b.id) + '/'; }
  function card(b){
    var rc = Number(b.review_count) || 0, rating = rc >= 1 ? (Number(b.rating) || 0) : 0;
    var tel = b.phone ? String(b.phone).replace(/\s+/g, '') : '';
    var photo = (Array.isArray(b.photos) ? b.photos : []).filter(function(u){ return /^(https?:\/\/|\/(?!\/))/i.test(String(u || '')); })[0];
    var where = b.address || ((b.locality ? b.locality + ', ' : '') + (b.city || '') + (b.state ? ', ' + b.state : ''));
    var href = esc(url(b));
    return '<article class="biz-card is-new" data-lid="' + esc(b.id) + '">' +
      '<a class="biz-img" href="' + href + '"><span class="badge">New</span>' +
        '<span class="ct-chip">' + esc(b.category_icon || '📍') + ' ' + esc(b.category || '') + '</span>' +
        (photo ? '<img loading="lazy" src="' + esc(photo) + '" alt="' + esc(b.name) + '" width="280" height="210" onerror="this.style.display=\'none\';">' : '') +
      '</a>' +
      '<div class="biz-info"><h3><a href="' + href + '">' + esc(b.name) + '</a></h3>' +
        '<div class="biz-loc">' + esc(where) + '</div>' +
        '<div class="biz-rating">' + (rating ? '<span class="rating-pill">\u2605 ' + rating.toFixed(1) + '</span>' : '<span class="rating-pill" style="opacity:.7">New</span>') + '</div>' +
      '</div>' +
      '<div class="biz-action">' +
        (tel ? '<div class="biz-phone">📞 <a href="tel:' + esc(tel) + '">' + esc(b.phone) + '</a></div>' : '') +
        '<a class="open-btn" href="' + href + '">View Details</a>' +
      '</div>' +
    '</article>';
  }

  var got = [], complete = false, MAX_PAGES = 2;
  function page(offset, n){
    var qs = 'citySlug=' + encodeURIComponent(C.city) + '&country=' + encodeURIComponent(C.country) +
      (C.cat ? '&category=' + encodeURIComponent(C.cat) : '') + '&limit=100&newest=1&offset=' + offset;
    return fetch(BASE + '/api/listings/search?' + qs, { credentials: 'omit', headers: { 'Accept': 'application/json' } })
      .then(function(r){ if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then(function(d){
        if (!d || !d.ok) throw new Error('api');
        got = got.concat(d.listings || []);
        if (d.hasMore && d.nextOffset != null) { if (n + 1 < MAX_PAGES) return page(d.nextOffset, n + 1); return; }
        complete = true;
      });
  }
  page(0, 0).then(function(){
    var live = got.filter(function(b){
      return b && b.id && !b.hidden && slug(b.city_slug || b.city) === C.city &&
        String(b.country || C.country).toUpperCase() === C.country && (!C.cat || b.category_slug === C.cat);
    });
    var onPage = {};
    Array.prototype.forEach.call(list.querySelectorAll('.biz-card[data-lid]'), function(el){ onPage[el.getAttribute('data-lid')] = el; });
    var fresh = live.filter(function(b){ return !known[djb2(b.id)] && !onPage[b.id]; }).slice(0, 20);
    if (fresh.length) {
      list.insertAdjacentHTML('beforeend', fresh.map(card).join(''));
      var sub = document.querySelector('.results-count');
      if (sub && !document.getElementById('liveNote')) {
        sub.insertAdjacentHTML('beforeend', ' <span id="liveNote">· ' + fresh.length + ' newly added</span>');
      }
    }
    if (complete && live.length) {
      // The API collapses same-name rows in one city: a duplicate of a live
      // name is not evidence of a removal.
      var liveId = {}, liveName = {};
      live.forEach(function(b){ liveId[b.id] = 1; liveName[nameKey(b)] = 1; });
      var gone = [];
      Object.keys(onPage).forEach(function(id){
        var el = onPage[id];
        if (liveId[id] || el.classList.contains('is-featured')) return;
        var h = el.querySelector('h3');
        var nk = String(h ? h.textContent : '').toLowerCase().trim() + '|' + String(C.cityName || '').toLowerCase().trim();
        if (!liveName[nk]) gone.push(el);
      });
      if (gone.length && gone.length <= Math.max(3, Object.keys(onPage).length / 2)) {
        gone.forEach(function(el){ if (el.parentNode) el.parentNode.removeChild(el); });
      }
    }
  }).catch(function(){});
})();
'''


def live_merge_script(country, city_slug, city_name, known_ids, category_slug=None):
    known = ",".join(sorted({_b36(djb2(i)) for i in known_ids}))
    cfg = {"country": country, "city": slugify(city_slug), "cityName": city_name,
           "cat": category_slug or "", "known": known}
    return f"<script>window.P24_LIVE = {js(cfg)};</script>\n<script>{LIVE_MERGE_JS}</script>"


def _b36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if not n:
            return out


def cat_chips_html(country, city_slug, categories, active_cat=None):
    """categories = [{slug, name, icon, count}, ...]"""
    chips = [f'<a class="cat-chip{" active" if active_cat is None else ""}" href="{city_url(country, city_slug)}">All categories</a>']
    for c in categories:
        cls = "cat-chip active" if c["slug"] == active_cat else "cat-chip"
        chips.append(
            f'<a class="{cls}" href="{category_url(country, city_slug, c["slug"])}">'
            f'{e(c["icon"])} {e(c["name"])} <span class="ct">{c["count"]}</span></a>'
        )
    search = (
        '<div class="city-search">'
        '<input id="citySearch" type="search" autocomplete="off" '
        'placeholder="Search these businesses by name, area or service…" '
        'aria-label="Search businesses on this page">'
        '<span id="citySearchCount"></span>'
        '</div>'
    )
    return (
        '<section class="cat-chips"><div class="container">'
        + search
        + f'<div class="cat-chips-row">{"".join(chips)}</div>'
        + '</div></section>'
    )

def pagination_html(country, city_slug, page, total_pages):
    if total_pages <= 1:
        return ""
    parts = []
    if page > 1:
        parts.append(f'<a href="{city_url(country, city_slug, page - 1)}" rel="prev">← Prev</a>')
    start = max(1, page - 2)
    end   = min(total_pages, start + 4)
    if start > 1:
        parts.append(f'<a href="{city_url(country, city_slug, 1)}">1</a>')
        if start > 2:
            parts.append('<span class="dot">…</span>')
    for p in range(start, end + 1):
        if p == page:
            parts.append(f'<span class="cur">{p}</span>')
        else:
            parts.append(f'<a href="{city_url(country, city_slug, p)}">{p}</a>')
    if end < total_pages:
        if end < total_pages - 1:
            parts.append('<span class="dot">…</span>')
        parts.append(f'<a href="{city_url(country, city_slug, total_pages)}">{total_pages}</a>')
    if page < total_pages:
        parts.append(f'<a href="{city_url(country, city_slug, page + 1)}" rel="next">Next →</a>')
    return f'<nav class="pagination" aria-label="Pagination">{"".join(parts)}</nav>'

def seo_copy_city(city, country_n, total, categories):
    cats_txt = ", ".join(c["name"].lower() for c in categories[:6])
    return f"""<section class="seo-copy">
  <h2>Pet services in {e(city)}, {e(country_n)}</h2>
  <p>Pets24x7 lists {total:,} pet service businesses across {e(city)} — including {cats_txt} and more. Every listing links to its public Google Business profile, so you can check a provider for your dog, cat, bird or exotic pet before you call.</p>
  <p>Use the category chips above to narrow down by what you need today — an emergency vet, a weekend groomer, a daycare slot, or a relocation specialist. Tap any listing to see the full address, phone, its Google Maps profile, reviews left on Pets24x7, and a one-tap WhatsApp enquiry button.</p>
  <h3>How Pets24x7 verifies {e(city)} listings</h3>
  <ul>
    <li>Every business has a public Google Business profile.</li>
    <li>A Google rating is shown only where we hold both the score and its review count — we never fill one in.</li>
    <li>Listings are categorised by service type, so a "vet" search doesn't surface a groomer.</li>
    <li>Featured placements (where shown) are paid promotions and are always labelled as such; the list below them is ranked on its own.</li>
    <li>If you spot an inaccuracy or want to claim your listing, message us on WhatsApp.</li>
  </ul>
</section>"""

def seo_copy_category(category, city, country_n, total):
    blurb = CATEGORY_BLURB.get(slugify(category), "")
    return f"""<section class="seo-copy">
  <h2>{e(category)} in {e(city)}, {e(country_n)}</h2>
  <p>Browse {total} {e(category.lower())} business{"es" if total != 1 else ""} in {e(city)}. {e(blurb)}</p>
  <p>Tap any listing to view the full address, contact details, its Google Maps profile, reviews left on Pets24x7 and a one-tap WhatsApp enquiry button. No booking fees. No platform commission. You talk to the business directly.</p>
</section>"""

def related_cities_html(country, current_slug, all_cities, limit=12):
    """Sidebar of other cities in the same country, for SEO interlinking."""
    cities = [c for c in all_cities if c["country"] == country and c["city_slug"] != current_slug][:limit]
    if not cities:
        return ""
    pills = "".join(f'<a href="{city_url(country, c["city_slug"])}">{e(c["city"])} <span style="color:var(--text-light);font-weight:500;">· {c["count"]}</span></a>' for c in cities)
    return f'<section class="related"><h3>More cities in {country_name(country)}</h3><div class="related-grid">{pills}</div></section>'

# ---- Page templates -------------------------------------------------------

def robots_meta(thin):
    """Thin city and category pages resolve but are not offered to Google.

    A visitor who followed a link to a city with one business should see that
    business, not a 404. Google being asked to index thousands of near-empty
    pages is a different matter, and hurts the pages that do have substance.
    """
    return '<meta name="robots" content="noindex,follow" />\n' if thin else ""


def render_city(country, city_slug, city, items, categories, page, total_pages, all_cities, page_size=PAGE_SIZE, thin=False, known_ids=None):
    country_n = country_name(country)
    state = next((b["state"] for b in items if b.get("state")), "")
    full_city = f"{city}{', ' + state if (country == 'US' and state) else ''}"

    page_items = items[(page - 1) * page_size : page * page_size]

    n = len(items)
    providers = f"{n:,} listed"
    title = fit_title(
        *([f"Pet services in {full_city} — {n:,} vets, groomers & more | Pets24x7"] if n > 1 else []),
        f"Pet services in {full_city} — {providers} | Pets24x7",
        f"Pet services in {city} — {providers} | Pets24x7",
        f"Pet services in {city} | Pets24x7",
    )
    if page > 1:
        title = fit_title(
            f"Pet services in {full_city} (page {page} of {total_pages}) | Pets24x7",
            f"Pet services in {city} (page {page} of {total_pages}) | Pets24x7",
        )
    desc = (f"Browse {len(items):,} pet service businesses in {full_city} on Pets24x7 — "
            f"vets, groomers, boarders, walkers, trainers and more. Direct WhatsApp enquiries, zero booking fees.")

    canonical = SITE + city_url(country, city_slug, page)
    prev_link = f'<link rel="prev" href="{SITE}{city_url(country, city_slug, page - 1)}" />' if page > 1 else ""
    next_link = f'<link rel="next" href="{SITE}{city_url(country, city_slug, page + 1)}" />' if page < total_pages else ""

    cards = "".join(
        biz_card_html(b, badge=("top" if is_top_rated(b) else None))
        for b in page_items
    )

    bc_items = [("Home", "/"), (country_n, None), (city, city_url(country, city_slug))]
    if page > 1:
        bc_items[-1] = (city, city_url(country, city_slug))
        bc_items.append((f"Page {page}", None))
    else:
        bc_items[-1] = (city, None)
    bc_jsonld = breadcrumb_jsonld([(n, u) for n, u in bc_items])
    list_jsonld = itemlist_jsonld(page_items, city, canonical)

    bc_html = " &nbsp;›&nbsp; ".join(
        (f'<a href="{u}">{e(n)}</a>' if u else e(n)) for n, u in bc_items
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#2563EB" />
<title>{e(title)}</title>
<meta name="description" content="{ea(desc)}" />
<link rel="canonical" href="{canonical}" />
{robots_meta(thin)}
{prev_link}{next_link}
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
{social_meta(title, desc, canonical, image_alt=f"Pet services in {full_city} on Pets24x7")}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css?v={STYLES_VER}" />
<script src="/config.js"></script>
<script src="/analytics.js"></script>
{RECO_TRACK_TAG}
<script type="application/ld+json">{bc_jsonld}</script>
<script type="application/ld+json">{list_jsonld}</script>
</head>
<body>

{header_html()}

<section class="city-hero"><div class="container">
  <nav class="bc" aria-label="Breadcrumb">{bc_html}</nav>
  <h1>Pet services in {e(full_city)}{f' · page {page}' if page > 1 else ''}</h1>
  <p class="sub">{len(items):,} businesses · from Google Business profiles · WhatsApp them direct</p>
</div></section>

{cat_chips_html(country, city_slug, categories)}

<main class="main"><div class="container">
  <div class="results-bar">
    <div class="results-count"><strong>{len(items):,}</strong> businesses in {e(full_city)}{f' — showing {(page-1)*page_size + 1}–{(page-1)*page_size + len(page_items)}' if total_pages > 1 else ''}</div>
  </div>
  {featured_strip_html()}
  {popular_strip_html()}
  <div class="biz-list">{cards}</div>
  {pagination_html(country, city_slug, page, total_pages)}
  {business_cta_html(city)}
  {seo_copy_city(full_city, country_n, len(items), categories)}
  {related_cities_html(country, city_slug, all_cities)}
</div></main>

<script>
(function(){{
  var input = document.getElementById('citySearch');
  if (!input) return;
  var countEl = document.getElementById('citySearchCount');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.biz-list .biz-card'));
  var total = cards.length;
  // Match on everything the card already shows, so searching an area, a service
  // or a phone number works without building a separate index.
  var hay = cards.map(function(c){{ return (c.textContent || '').toLowerCase(); }});

  function apply(){{
    var q = input.value.toLowerCase().trim();
    if (!q) {{
      cards.forEach(function(c){{ c.classList.remove('is-hidden'); }});
      countEl.textContent = '';
      return;
    }}
    var shown = 0;
    cards.forEach(function(c, i){{
      var hit = hay[i].indexOf(q) !== -1;
      c.classList.toggle('is-hidden', !hit);
      if (hit) shown++;
    }});
    countEl.innerHTML = shown
      ? shown + ' of ' + total + ' on this page'
      : 'Nothing on this page — <a href="/search/?q=' + encodeURIComponent(input.value.trim()) + '">search everywhere</a>';
  }}

  var t;
  input.addEventListener('input', function(){{ clearTimeout(t); t = setTimeout(apply, 120); }});
  input.addEventListener('search', apply);
}})();
</script>

{reco_click_helper_script()}

{featured_script(country, city_slug)}

{popular_script(city)}

{live_merge_script(country, city_slug, city, known_ids) if (page == 1 and known_ids) else ""}

{footer_html()}
</body>
</html>
"""

def render_category(country, city_slug, city, category_name, category_slug, items, all_cats, all_cities, thin=False, known_ids=None):
    country_n = country_name(country)
    state = next((b["state"] for b in items if b.get("state")), "")
    full_city = f"{city}{', ' + state if (country == 'US' and state) else ''}"

    providers = f"{len(items)} listed"
    title = fit_title(
        f"{category_name} in {full_city} — {providers} | Pets24x7",
        f"{short_category(category_name)} in {full_city} — {providers} | Pets24x7",
        f"{short_category(category_name)} in {city} — {providers} | Pets24x7",
        f"{short_category(category_name)} in {city} | Pets24x7",
    )
    desc = (f"Find {len(items)} {category_name.lower()} provider{'s' if len(items) != 1 else ''} in {full_city}. "
            f"Google-listed businesses. Direct WhatsApp enquiries. Zero booking fees.")

    canonical = SITE + category_url(country, city_slug, category_slug)
    cards = "".join(
        biz_card_html(b, badge=("top" if is_top_rated(b) else None))
        for b in items
    )

    bc_items = [("Home", "/"), (country_n, None), (city, city_url(country, city_slug)), (category_name, None)]
    bc_jsonld = breadcrumb_jsonld(bc_items)
    list_jsonld = itemlist_jsonld(items, full_city, canonical)

    bc_html = " &nbsp;›&nbsp; ".join(
        (f'<a href="{u}">{e(n)}</a>' if u else e(n)) for n, u in bc_items
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#2563EB" />
<title>{e(title)}</title>
<meta name="description" content="{ea(desc)}" />
<link rel="canonical" href="{canonical}" />
{robots_meta(thin)}
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
{social_meta(title, desc, canonical, image_alt=f"{category_name} in {full_city} on Pets24x7")}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css?v={STYLES_VER}" />
<script src="/config.js"></script>
<script src="/analytics.js"></script>
{RECO_TRACK_TAG}
<script type="application/ld+json">{bc_jsonld}</script>
<script type="application/ld+json">{list_jsonld}</script>
</head>
<body>

{header_html()}

<section class="city-hero"><div class="container">
  <nav class="bc" aria-label="Breadcrumb">{bc_html}</nav>
  <h1>{e(category_name)} in {e(full_city)}</h1>
  <p class="sub">{len(items)} provider{'s' if len(items) != 1 else ''} · from Google Business profiles · WhatsApp them direct</p>
</div></section>

{cat_chips_html(country, city_slug, all_cats, active_cat=category_slug)}

<main class="main"><div class="container">
  <div class="results-bar">
    <div class="results-count"><strong>{len(items)}</strong> {e(category_name.lower())} provider{'s' if len(items) != 1 else ''} in {e(full_city)}</div>
  </div>
  {featured_strip_html()}
  {popular_strip_html()}
  <div class="biz-list">{cards}</div>
  {business_cta_html(city, category_name)}
  {reco_rail_html()}
  {seo_copy_category(category_name, full_city, country_n, len(items))}
  {related_cities_html(country, city_slug, all_cities)}
</div></main>

<script>
(function(){{
  var input = document.getElementById('citySearch');
  if (!input) return;
  var countEl = document.getElementById('citySearchCount');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.biz-list .biz-card'));
  var total = cards.length;
  // Match on everything the card already shows, so searching an area, a service
  // or a phone number works without building a separate index.
  var hay = cards.map(function(c){{ return (c.textContent || '').toLowerCase(); }});

  function apply(){{
    var q = input.value.toLowerCase().trim();
    if (!q) {{
      cards.forEach(function(c){{ c.classList.remove('is-hidden'); }});
      countEl.textContent = '';
      return;
    }}
    var shown = 0;
    cards.forEach(function(c, i){{
      var hit = hay[i].indexOf(q) !== -1;
      c.classList.toggle('is-hidden', !hit);
      if (hit) shown++;
    }});
    countEl.innerHTML = shown
      ? shown + ' of ' + total + ' on this page'
      : 'Nothing on this page — <a href="/search/?q=' + encodeURIComponent(input.value.trim()) + '">search everywhere</a>';
  }}

  var t;
  input.addEventListener('input', function(){{ clearTimeout(t); t = setTimeout(apply, 120); }});
  input.addEventListener('search', apply);
}})();
</script>

{reco_click_helper_script()}

{featured_script(country, city_slug, category_slug)}

{popular_script(city, category_name)}

{reco_rail_script(country, city_slug, city, category_slug)}

{live_merge_script(country, city_slug, city, known_ids, category_slug) if known_ids else ""}

{footer_html()}
</body>
</html>
"""

def render_listing(biz, all_in_city, all_cats):
    country = biz["country"]
    country_n = country_name(country)
    city, city_slug = biz["city"], biz["city_slug"]
    state = biz.get("state") or ""
    full_city = f"{city}{', ' + state if (country == 'US' and state) else ''}"

    title = fit_title(
        f"{biz['name']} — {biz['category']} in {full_city} | Pets24x7",
        f"{biz['name']} — {short_category(biz['category'])} in {city} | Pets24x7",
        f"{biz['name']} — {short_category(biz['category'])} in {city}",
        f"{biz['name']} | Pets24x7",
        f"{biz['name']}",
    )
    desc = (f"{biz['name']} is {a_an(biz['category'])} {biz['category'].lower()} in {full_city}. "
            + (f"Rated {biz['rating']:.1f}/5 on Google from {biz['review_count']} reviews. " if has_rating(biz) else "")
            + "WhatsApp them direct via Pets24x7 — no booking fees.")

    canonical = SITE + listing_url(biz)
    photos = own_photos(biz)
    img_main = abs_url(photos[0]) if photos else img_for(biz, 0, 1200, 800)
    imgs = [img_for(biz, 0, 1000, 600), img_for(biz, 1, 600, 400),
            img_for(biz, 2, 600, 400), img_for(biz, 3, 600, 400),
            img_for(biz, 4, 600, 400)]
    if photos:
        # The business's own photos first, stock only to fill the collage and
        # labelled as such in the alt text.
        n = len(photos)
        slots = [(u, f"{biz['name']} — photo {i + 1} of {n}") for i, u in enumerate(photos[:5])]
        for i in range(len(slots), 5):
            slots.append((imgs[i], f"Illustrative {biz['category'].lower()} photo"))
        gallery_html = (f'<img class="g0" src="{ea(slots[0][0])}" alt="{ea(slots[0][1])}" loading="eager">'
                        + "".join(f'\n    <img src="{ea(u)}" alt="{ea(a)}" loading="lazy">' for u, a in slots[1:]))
    else:
        illus = f"Illustrative {biz['category'].lower()} photo"
        gallery_html = (f'<img class="g0" src="{ea(imgs[0])}" alt="{ea(illus)}" loading="eager">'
                        + "".join(f'\n    <img src="{ea(imgs[i])}" alt="{ea(illus)}" loading="lazy">' for i in range(1, 5)))

    bc_items = [
        ("Home", "/"),
        (country_n, None),
        (full_city, city_url(country, city_slug)),
        (biz["category"], category_url(country, city_slug, biz["category_slug"])),
        (biz["name"], None),
    ]
    bc_jsonld = breadcrumb_jsonld(bc_items)
    biz_jsonld = listing_jsonld(biz)

    bc_html = " &nbsp;›&nbsp; ".join(
        (f'<a href="{u}">{e(n)}</a>' if u else e(n)) for n, u in bc_items
    )

    amens = amenities_for(biz, 10)
    amens_html = "".join(
        f'<div class="amenity-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>{e(a)}</span></div>'
        for a in amens
    )

    blurb = CATEGORY_BLURB.get(biz["category_slug"], "")
    address = biz.get("address") or (area_label(biz) + (", " + state if (country == "US" and state) else ""))
    description = text_of(biz, "description", 5000)
    hours = text_of(biz, "opening_hours", 1000)
    services = services_of(biz)
    locality = text_of(biz, "locality", 160)
    email = biz.get("email") if re.match(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[a-z]{2,}$", str(biz.get("email") or ""), re.I) else ""

    # What the business says about itself replaces the generic category blurb.
    about_html = (f"<p>{e(biz['name'])} is {a_an(biz['category'])} {e(biz['category'].lower())} in {e(address)}.</p>"
                  + paras_html(description)) if description else \
                 (f"<p>{e(biz['name'])} is listed on Pets24x7 as {a_an(biz['category'])} {e(biz['category'].lower())} in {e(address)}, "
                  f"from its public Google Business profile.</p><p>{e(blurb)}</p>")
    hours_line = ""
    if hours:
        lines = [l.strip() for l in hours.splitlines() if l.strip()]
        hours_line = (f'<p style="margin-top:6px;">🕒 <strong>Hours:</strong> '
                      + ("<br>" if len(lines) > 1 else "") + "<br>".join(e(l) for l in lines) + "</p>")
    email_line = (f'<p style="margin-top:6px;">✉️ <strong>Email:</strong> <a href="mailto:{ea(email)}" '
                  f'style="color:var(--primary);font-weight:600;">{e(email)}</a></p>') if email else ""
    if services:
        services_section = ('<section>\n        <h2>Services</h2>\n'
                            '        <p style="margin:0 0 10px;color:var(--text-muted);font-size:13px;">As listed by the business — confirm current services and rates with them directly.</p>\n'
                            '        <div class="amenity-grid">' + "".join(
                                f'<div class="amenity-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>{e(x)}</span></div>'
                                for x in services) + '</div>\n      </section>')
    else:
        asks = "".join(
            f'<div class="amenity-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>{e(q)}</span></div>'
            for q in ask_list(biz))
        services_section = f"""<section>
        <h2>Questions to ask before you book</h2>
        <p style="margin:0 0 10px;color:var(--text-muted);font-size:13px;">{e(biz['name'])} hasn't listed its services on Pets24x7 yet. Ask about these when you message them.</p>
        <div class="amenity-grid">{asks}</div>
      </section>"""

    # Google reviews block (only if CID exists)
    reviews_section = ""
    if biz.get("google_cid") and has_rating(biz):
        reviews_section = f"""<section>
  <h2>Guest reviews</h2>
  <div class="greviews-head">
    <div class="greviews-score">{biz["rating"]:.1f}<small>/5</small></div>
    <div class="glogo-big">
      {google_logo_html()}<br>
      <a href="https://www.google.com/maps?cid={ea(biz['google_cid'])}" target="_blank" rel="noopener">View {biz["review_count"]} ratings →</a>
    </div>
  </div>
  <p style="margin:6px 0 0;">{e(biz['name'])} holds a <strong>{biz['rating']:.1f} / 5</strong> average on Google from <strong>{biz['review_count']}</strong> public review{"" if biz["review_count"] == 1 else "s"}. Open them on Google to read the reviews themselves.</p>
  <a href="https://www.google.com/maps?cid={ea(biz['google_cid'])}" target="_blank" rel="noopener" style="display:inline-block;margin-top:12px;background:#EFF6FF;color:var(--primary);border:1px solid #BFDBFE;padding:8px 14px;border-radius:8px;font-weight:600;font-size:13px;text-decoration:none;">Open in Google Maps ↗</a>
  <iframe class="gmap-embed" loading="lazy" src="https://www.google.com/maps?cid={ea(biz['google_cid'])}&output=embed" allowfullscreen title="Map of {ea(biz['name'])}"></iframe>
</section>"""
    elif biz.get("google_cid"):
        # No rating we can stand behind: the Google profile and map still are.
        reviews_section = f"""<section>
  <h2>On Google Maps</h2>
  <p style="margin:6px 0 0;">Read {e(biz['name'])}'s reviews and photos on its Google Business profile.</p>
  <a href="https://www.google.com/maps?cid={ea(biz['google_cid'])}" target="_blank" rel="noopener" style="display:inline-block;margin-top:12px;background:#EFF6FF;color:var(--primary);border:1px solid #BFDBFE;padding:8px 14px;border-radius:8px;font-weight:600;font-size:13px;text-decoration:none;">Open in Google Maps ↗</a>
  <iframe class="gmap-embed" loading="lazy" src="https://www.google.com/maps?cid={ea(biz['google_cid'])}&output=embed" allowfullscreen title="Map of {ea(biz['name'])}"></iframe>
</section>"""

    # Reviews people leave here, and the form to leave one. Rendered empty and
    # filled from the API, so a page built weeks ago still shows what came in
    # since — the static build is a shell, not a snapshot of the reviews.
    p24_reviews_section = """<section id="p24reviews">
  <h2>Reviews on Pets24x7</h2>
  <div id="p24rvSummary" style="color:var(--text-muted);font-size:14px;">Loading reviews…</div>
  <div id="p24rvList" style="margin-top:14px;"></div>

  <div style="margin-top:18px;border:1px solid var(--border);border-radius:12px;padding:18px;">
    <h3 style="font-size:15px;font-weight:800;margin:0 0 4px;">Been here? Leave a review</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px;">Reviews are checked by our team before they appear.</p>
    <form id="p24rvForm" onsubmit="return submitListingReview(event)">
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <label style="flex:1;min-width:180px;font-size:12px;font-weight:700;color:var(--text-muted);">YOUR NAME
          <input id="rvName" type="text" required autocomplete="name" placeholder="e.g. Priya S." style="width:100%;margin-top:5px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;">
        </label>
        <label style="flex:1;min-width:180px;font-size:12px;font-weight:700;color:var(--text-muted);">RATING
          <select id="rvRating" style="width:100%;margin-top:5px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;">
            <option value="5">★★★★★ Excellent</option>
            <option value="4">★★★★ Good</option>
            <option value="3">★★★ Okay</option>
            <option value="2">★★ Poor</option>
            <option value="1">★ Bad</option>
          </select>
        </label>
      </div>
      <label style="font-size:12px;font-weight:700;color:var(--text-muted);">YOUR REVIEW
        <textarea id="rvText" rows="4" required placeholder="What was the visit like? Be specific and fair." style="width:100%;margin-top:5px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit;"></textarea>
      </label>
      <div id="rvMsg" style="font-size:13px;margin-top:10px;"></div>
      <button type="submit" id="rvSubmit" style="margin-top:12px;background:var(--primary);color:#fff;border:none;padding:11px 20px;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;">Submit review</button>
    </form>
  </div>
</section>"""

    phone_line = ""
    if biz.get("phone"):
        clean_phone = re.sub(r"\s+", "", biz["phone"])
        phone_line = f'<p style="margin-top:6px;">📞 <strong>Phone:</strong> <a href="tel:{ea(clean_phone)}" style="color:var(--primary);font-weight:600;">{e(biz["phone"])}</a></p>'

    website_line = ""
    site_url = clean_website(biz.get("website"))
    if site_url:
        display_web = site_url.replace("http://", "").replace("https://", "").rstrip("/")
        website_line = f'<p style="margin-top:6px;">🌐 <strong>Website:</strong> <a href="{ea(site_url)}" target="_blank" rel="noopener nofollow" style="color:var(--primary);font-weight:600;">{e(display_web)}</a></p>'

    # Sibling listings in the same city + category, for SEO interlinking.
    siblings = [b for b in all_in_city if b["category_slug"] == biz["category_slug"] and b["id"] != biz["id"]][:6]
    related_html = ""
    if siblings:
        sib = "".join(f'<a href="{listing_url(s)}">{e(s["name"])}' + (f' <span style="color:var(--text-light);font-weight:500;">★ {s["rating"]:.1f}</span>' if has_rating(s) else '') + '</a>' for s in siblings)
        related_html = f'<section class="related" style="margin-top:24px;"><h3>Other {e(biz["category"])} in {e(full_city)}</h3><div class="related-grid">{sib}</div></section>'

    # Phone number formatted for tel: link.
    biz_phone_clean = re.sub(r"\s+", "", biz.get("phone") or "")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="theme-color" content="#2563EB" />
<title>{e(title)}</title>
<meta name="description" content="{ea(desc)}" />
<link rel="canonical" href="{canonical}" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
{social_meta(f"{biz['name']} — {biz['category']} in {full_city}", desc, canonical, img_main,
             image_alt=f"{biz['name']}, {biz['category']} in {full_city}", og_type="business.business",
             extra=[("business:contact_data:street_address", biz.get("address") or city),
                    ("business:contact_data:locality", city),
                    ("business:contact_data:region", state),
                    ("business:contact_data:postal_code", biz.get("pincode")),
                    ("business:contact_data:country_name", country_n),
                    ("business:contact_data:phone_number", biz.get("phone"))])}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css?v={STYLES_VER}" />
<script src="/config.js"></script>
<script src="/analytics.js"></script>
{RECO_TRACK_TAG}
<script type="application/ld+json">{biz_jsonld}</script>
<script type="application/ld+json">{bc_jsonld}</script>
</head>
<body>

{header_html()}

<div class="container">
  <nav class="bc bc-page" aria-label="Breadcrumb">{bc_html}</nav>

  <div class="title-block">
    <div>
      <h1>{e(biz["name"])}</h1>
      <div class="meta-row">
        {f'<span class="rating-pill">★ {biz["rating"]:.1f}</span>' if has_rating(biz) else ''}
        {f'''<a href="https://www.google.com/maps?cid={ea(biz["google_cid"])}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--border);padding:3px 8px 3px 5px;border-radius:6px;font-size:12px;font-weight:600;color:var(--text);text-decoration:none;">
          <span style="background:var(--success);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;font-size:11px;">{biz["rating"]:.1f}/5</span>
          <span class="glogo-big" style="font-size:12px;">{google_logo_html()}</span>
          <span style="color:var(--primary);">View {biz["review_count"]} ratings</span>
        </a>''' if (biz.get("google_cid") and has_rating(biz)) else ""}
        <span>{e(biz.get("category_icon") or "📍")} {e(biz["category"])}</span>
        <span>📍 {e((locality + ", ") if locality and locality.lower() != city.lower() else "")}{e(full_city)}{f" · {e(biz['pincode'])}" if biz.get("pincode") else ""}</span>
      </div>
    </div>
  </div>

  <div class="gallery{'' if photos else ' is-stock'}">
    {gallery_html}
    {'' if photos else '<span class="gallery-note">Illustrative photos · the business hasn&rsquo;t added its own yet</span>'}
  </div>

  <div class="pdp-layout">
    <div class="pdp-main">
      <section>
        <h2>About this listing</h2>
        {about_html}
        <p style="margin-top:14px;">📍 <strong>Address:</strong> {e(address)}</p>
        {hours_line}
        {phone_line}
        {email_line}
        {website_line}
      </section>

      {services_section}

      {reviews_section}
{p24_reviews_section}

      <section class="reco-section" id="recoSimilar" hidden aria-labelledby="recoSimilarH">
        <h2 id="recoSimilarH">More {e(biz["category"].lower())} in {e(city)}</h2>
        <p class="reco-sub">Compare a few before you decide</p>
        <div class="reco-row" id="recoSimilarList"></div>
      </section>
      <section class="reco-section" id="recoNearby" hidden aria-labelledby="recoNearbyH">
        <h2 id="recoNearbyH">Also nearby</h2>
        <p class="reco-sub">Other pet services close to {e(biz["name"])}</p>
        <div class="reco-row" id="recoNearbyList"></div>
      </section>

      <section>
        <h2>Business details</h2>
        <div class="info-grid">
          <div class="info-block"><strong>Category</strong><span>{e(biz["category"])}</span></div>
          <div class="info-block"><strong>City</strong><span>{e(full_city)}</span></div>
          {f'<div class="info-block"><strong>Area</strong><span>{e(locality)}</span></div>' if locality else ""}
          <div class="info-block"><strong>{'PIN code' if country == 'IN' else 'ZIP code'}</strong><span>{e(biz.get("pincode") or "—")}</span></div>
          <div class="info-block"><strong>Google rating</strong><span>{f'★ {biz["rating"]:.1f} / 5 · {biz["review_count"]} reviews' if has_rating(biz) else ('See it on Google Maps' if biz.get("google_cid") else 'Not rated yet')}</span></div>
          {f'<div class="info-block"><strong>Phone</strong><span><a href="tel:{ea(biz_phone_clean)}">{e(biz["phone"])}</a></span></div>' if biz.get("phone") else ""}
          {f'<div class="info-block"><strong>Website</strong><span><a href="{ea(site_url)}" target="_blank" rel="noopener nofollow">Visit site ↗</a></span></div>' if site_url else ""}
        </div>
      </section>

      <section>
        <h2>Good to know</h2>
        <ul class="policy-list">
          <li><span>Booking</span><span>Direct via WhatsApp / phone — no platform fee</span></li>
          <li><span>Source</span><span>{'Managed by the business owner' if biz.get("claimed") else 'Public Google Business profile'}</span></li>
          <li><span>Cancellation</span><span>Set directly by the business when you confirm</span></li>
          <li><span>Payment</span><span>Direct to business — UPI / card / cash as they accept</span></li>
          <li><span>Pet policy</span><span>Confirm species, breed &amp; vaccination needs before visiting</span></li>
        </ul>
      </section>

      {related_html}
    </div>

    <aside>
      <div class="booking-card" id="enquiryForm">
        <span class="cat-tag">{e(biz.get("category_icon") or "📍")} {e(biz["category"])}</span>
        <h3>Enquire about {e(biz["name"])}</h3>
        <div class="price-tax">{f'★ {biz["rating"]:.1f} / 5 · {biz["review_count"]} Google reviews · ' if has_rating(biz) else ''}{e(full_city)}</div>
        <a href="{ea(wa_link_for(biz))}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:8px;background:var(--whatsapp);color:#fff;padding:13px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin:14px 0;box-shadow:0 6px 16px rgba(37,211,102,0.25);">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
          Quick WhatsApp Enquiry →
        </a>
        <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:16px;">— or fill the form below —</div>
        <form id="bookForm" onsubmit="return submitEnquiry(event)" novalidate>
          <div class="form-row"><div class="form-field form-field-full"><label for="fName">Your full name *</label><input type="text" id="fName" autocomplete="name" required placeholder="e.g. Priya Sharma"></div></div>
          <div class="form-row"><div class="form-field form-field-full"><label for="fPhone">WhatsApp / Phone *</label><input type="tel" id="fPhone" autocomplete="tel" inputmode="tel" required pattern="[0-9 +-]{{10,15}}" placeholder="e.g. +91 98765 43210"></div></div>
          <div class="form-row"><div class="form-field form-field-full"><label for="fEmail">Email <span style="font-weight:400;opacity:.7">(for your confirmation)</span></label><input type="email" id="fEmail" placeholder="you@example.com" autocomplete="email"></div></div>
          <div class="form-row">
            <div class="form-field"><label for="fPetType">Pet type</label>
              <select id="fPetType"><option>Dog</option><option>Cat</option><option>Bird</option><option>Rabbit</option><option>Reptile</option><option>Small mammal</option><option>Other</option></select>
            </div>
            <div class="form-field"><label for="fDate">Preferred date</label><input type="date" id="fDate"></div>
          </div>
          <div class="form-row"><div class="form-field form-field-full"><label for="fNotes">What do you need? *</label><textarea id="fNotes" required placeholder="e.g. Grooming for a Golden Retriever this Saturday, anti-tick bath + nail clip."></textarea></div></div>
          <div class="form-error" id="formError"></div>
          <button type="submit" class="submit-wa">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
            Send Enquiry on WhatsApp
          </button>
          <a href="tel:+{WA_NUMBER}" class="secondary-call">📞 Or call +91 99300 90487</a>
        </form>
        <ul class="trust-points">
          <li>{'Owner-managed listing' if biz.get("claimed") else 'Listed from its Google Business profile'}</li>
          <li>Direct contact — no booking fees</li>
          <li>The reply comes straight to your WhatsApp</li>
          <li>Free to enquire · No commitment</li>
        </ul>
      </div>
      {owner_card_html(biz, city)}
    </aside>
  </div>
</div>

<div class="mobile-book-bar">
  <div class="mb-name"><strong>{e(biz["name"])}</strong><span>{e(biz["category"])}</span></div>
  <a href="#enquiryForm" class="mb-btn">
    <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
    Enquire
  </a>
</div>

{footer_html()}

<script>{RECO_LISTING_JS}</script>
<script>
  var biz = {{
    id:{js(biz["id"])},
    name:{js(biz["name"])},
    category:{js(biz["category"])},
    city:{js(biz["city"])},
    state:{js(biz.get("state") or "")},
    country:{js(biz["country"])}
  }};
  var API_BASE = (window.PETS_CONFIG && window.PETS_CONFIG.API_BASE) ||
    ((location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '') ? '' : 'https://api.pets24x7.com');

  function rvEsc(x){{ return (x==null?'':String(x)).replace(/[<>&"]/g, function(c){{ return {{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}}[c]; }}); }}

  // A tap on the phone number, WhatsApp or the website is intent that never
  // becomes an enquiry row. Recording it is what lets the vendor be shown
  // something real, and support answer "who contacted us". Best effort: the
  // call is never held up by it, and a failure is ignored.
  function logTap(kind){{
    // Google gets the same signal, so a conversion in Analytics and a row in
    // our own activity table always agree. trackEvent is a no-op when
    // analytics is off, which it is on localhost and in the dashboards.
    try {{
      if (window.trackEvent) {{
        window.trackEvent(kind, {{
          listing_id: biz.id,
          listing_name: biz.name,
          city: biz.city,
          category: biz.category
        }});
      }}
    }} catch (e) {{}}
    try {{
      // A view that came from a recommendation card keeps its src
      // (reco_<surface>), so the reco funnel joins to real views.
      var source = (kind === 'listing_view' && RECO_SRC) ? RECO_SRC : 'listing_page';
      var payload = JSON.stringify({{ listingId: biz.id, kind: kind, source: source }});
      if (window.fetch) {{
        fetch(API_BASE + '/api/activity', {{ method:'POST', credentials:'include', keepalive:true,
          headers:{{ 'Content-Type':'application/json' }}, body: payload }}).catch(function(){{}});
      }} else if (navigator.sendBeacon) {{
        navigator.sendBeacon(API_BASE + '/api/activity', new Blob([payload], {{ type: 'application/json' }}));
      }}
    }} catch (e) {{}}
    return true;
  }}

  // Every tel:, wa.me and website link on the page reports itself, without each
  // one needing its own handler in the markup.
  document.addEventListener('click', function(ev){{
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.indexOf('tel:') === 0) logTap('phone_click');
    else if (href.indexOf('wa.me') !== -1 || href.indexOf('api.whatsapp.com') !== -1) logTap('whatsapp_click');
    else if (a.getAttribute('rel') && a.getAttribute('rel').indexOf('nofollow') !== -1 && /^https?:/.test(href)) logTap('website_click');
  }}, true);

  var RECO_SRC = window.recoLandingSource ? window.recoLandingSource(biz.id) : '';
  logTap('listing_view');
  if (window.loadRecoListing) window.loadRecoListing(biz.id);

  function loadListingReviews(){{
    fetch(API_BASE + '/api/reviews/listing/' + encodeURIComponent(biz.id), {{ headers: {{ 'Accept':'application/json' }} }})
      .then(function(r){{ return r.ok ? r.json() : null; }})
      .then(function(d){{
        var sum = document.getElementById('p24rvSummary');
        var list = document.getElementById('p24rvList');
        if(!d || !d.count){{
          sum.textContent = 'No Pets24x7 reviews yet — be the first to leave one.';
          list.innerHTML = '';
          return;
        }}
        sum.innerHTML = '<strong>' + d.average + ' / 5</strong> from ' + d.count + ' Pets24x7 review' + (d.count === 1 ? '' : 's');
        list.innerHTML = (d.reviews||[]).map(function(r){{
          return '<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
              '<strong>' + rvEsc(r.reviewerName) + '</strong>' +
              '<span style="color:#D97706;font-weight:800;">★ ' + r.rating + '</span>' +
            '</div>' +
            '<p style="margin:6px 0 0;font-size:14px;line-height:1.5;">' + rvEsc(r.text) + '</p>' +
            (r.vendorReply ? '<div style="margin-top:8px;padding:8px 10px;background:#F1F5F9;border-radius:8px;font-size:13px;"><strong>Reply from the business:</strong> ' + rvEsc(r.vendorReply) + '</div>' : '') +
          '</div>';
        }}).join('');
      }})
      .catch(function(){{
        var sum = document.getElementById('p24rvSummary');
        if (sum) sum.textContent = 'Reviews could not be loaded right now.';
      }});
  }}

  function submitListingReview(ev){{
    ev.preventDefault();
    var msg = document.getElementById('rvMsg');
    var btn = document.getElementById('rvSubmit');
    if (btn.disabled) return false;
    var body = {{
      reviewerName: document.getElementById('rvName').value.trim(),
      rating: Number(document.getElementById('rvRating').value),
      text: document.getElementById('rvText').value.trim()
    }};
    if (body.reviewerName.length < 2) {{ msg.style.color='#DC2626'; msg.textContent='Please enter your name.'; return false; }}
    if (body.text.length < 10) {{ msg.style.color='#DC2626'; msg.textContent='Please write at least a sentence.'; return false; }}

    btn.disabled = true; btn.textContent = 'Sending…';
    msg.style.color = '#6B7280'; msg.textContent = 'Sending…';
    fetch(API_BASE + '/api/reviews/listing/' + encodeURIComponent(biz.id), {{
      method: 'POST',
      credentials: 'include',
      headers: {{ 'Content-Type':'application/json', 'Accept':'application/json' }},
      body: JSON.stringify(body)
    }}).then(function(r){{ return r.json().then(function(d){{ if(!r.ok) throw new Error(d.message||d.error||'Could not submit'); return d; }}); }})
      .then(function(d){{
        document.getElementById('p24rvForm').reset();
        msg.style.color = '#047857';
        msg.textContent = d.message || 'Thanks — your review goes live once checked.';
      }})
      .catch(function(e){{ msg.style.color = '#DC2626'; msg.textContent = e.message; }})
      .finally(function(){{ btn.disabled = false; btn.textContent = 'Submit review'; }});
    return false;
  }}

  loadListingReviews();

  var LEADS_WEBAPP_URL = (window.PETS_CONFIG && window.PETS_CONFIG.LEADS_WEBAPP_URL) || '';
  function pushLead(data){{
    if(!LEADS_WEBAPP_URL)return;
    try{{
      var body = new URLSearchParams();
      Object.keys(data).forEach(function(k){{ body.append(k, data[k]==null?'':String(data[k])); }});
      body.append('userAgent', navigator.userAgent||'');
      body.append('page', location.pathname);
      fetch(LEADS_WEBAPP_URL, {{ method:'POST', mode:'no-cors', body:body }}).catch(function(){{}});
    }}catch(e){{}}
  }}
  // Saves the lead to the Pets24x7 API, which is what sends the parent's
  // confirmation email and alerts the claimed vendor. Fire-and-forget: the
  // WhatsApp hand-off below never waits on it.
  function pushLeadToApi(data){{
    try {{
      fetch(API_BASE + '/api/enquiries', {{
        method:'POST', credentials:'include', keepalive:true,
        headers:{{ 'Content-Type':'application/json', 'Accept':'application/json' }},
        body: JSON.stringify(data)
      }}).catch(function(){{}});
    }} catch(e) {{}}
  }}
  // One enquiry per tap: a double tap posted the lead twice and opened a
  // second WhatsApp tab (same guard as /listing.html).
  var enquiryBusyUntil = 0;
  function submitEnquiry(ev){{
    ev.preventDefault();
    if (Date.now() < enquiryBusyUntil) return false;
    var name=document.getElementById('fName').value.trim();
    var phone=document.getElementById('fPhone').value.trim();
    var emailEl=document.getElementById('fEmail');
    var email=emailEl ? emailEl.value.trim() : '';
    var pet=document.getElementById('fPetType').value;
    var date=document.getElementById('fDate').value;
    var notes=document.getElementById('fNotes').value.trim();
    var err=document.getElementById('formError');
    err.style.color='';
    if(!name||name.length<2){{ err.textContent='Please enter your full name.'; err.classList.add('show'); return false; }}
    if(!phone||phone.replace(/[^0-9]/g,'').length<10){{ err.textContent='Please enter a valid phone / WhatsApp number.'; err.classList.add('show'); return false; }}
    if(!notes){{ err.textContent='Please describe what you need.'; err.classList.add('show'); return false; }}
    if(email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)){{ err.textContent='That email address does not look right.'; err.classList.add('show'); return false; }}
    err.classList.remove('show');
    var msg = "🐾 *New Enquiry — Pets24x7.com*\\n\\n" +
      "*Business:* " + biz.name + "\\n" +
      "*Category:* " + biz.category + "\\n" +
      "*City:* " + biz.city + (biz.state ? ", " + biz.state : "") + "\\n" +
      "*Listing ID:* " + biz.id + "\\n\\n" +
      "*Customer:* " + name + "\\n" +
      "*Phone / WhatsApp:* " + phone + "\\n" +
      "*Pet type:* " + pet + "\\n" +
      (date ? "*Preferred date:* " + date + "\\n" : "") +
      "\\n*What they need:* " + notes + "\\n" +
      "\\nPlease confirm availability & pricing. Thanks!";
    pushLead({{name:name,business:biz.name,category:biz.category,city:biz.city,country:biz.country,listing_id:biz.id,phone:phone,email:email,pet:pet,date:date,notes:notes,source:'listing_page'}});
    pushLeadToApi({{
      name:name, phone:phone, email: email || undefined,
      listingId: biz.id, listingName: biz.name, category: biz.category, city: biz.city,
      country: (biz.country === 'IN' || biz.country === 'US') ? biz.country : undefined,
      petType: pet, preferredDate: date || undefined, notes: notes, source: 'listing_page'
    }});
    try {{ if (window.trackEvent) window.trackEvent('generate_lead', {{ listing_id: biz.id, category: biz.category, city: biz.city, source: 'listing_form' }}); }} catch (e) {{}}
    enquiryBusyUntil = Date.now() + 4000;
    var url = 'https://wa.me/{WA_NUMBER}?text=' + encodeURIComponent(msg) + '&utm_source=website&utm_medium=listing_form&utm_campaign=enquiry';
    window.open(url, '_blank');
    err.style.color = '#047857';
    err.textContent = email ? 'Enquiry sent — a confirmation is on its way to ' + email + '.' : 'Enquiry sent — continue the chat on WhatsApp.';
    err.classList.add('show');
    return false;
  }}
  // Default date: tomorrow
  (function(){{
    var d=new Date(); d.setDate(d.getDate()+1);
    var f=d.toISOString().slice(0,10);
    var di=document.getElementById('fDate'); if(di){{ di.value=f; di.min=new Date().toISOString().slice(0,10); }}
  }})();
</script>

</body>
</html>
"""

# ---- Main -----------------------------------------------------------------

def load_index():
    """window.PETS_INDEX from pets-data.js.

    Decoded as one JSON value starting right after the "=", not cut out with a
    pattern: city names come from the listings table (admins, imports, vendor
    profiles), and the old non-greedy `\\[.+?\\];` stopped at the first "];"
    inside one of them. A city called "Zz];" failed every publish.
    """
    txt = INDEX_FILE.read_text(encoding="utf-8")
    m = re.search(r"\bPETS_INDEX\s*=\s*", txt)
    if not m:
        sys.exit("[fatal] could not parse PETS_INDEX from pets-data.js")
    try:
        index, _ = json.JSONDecoder().raw_decode(txt, m.end())
    except ValueError as err:
        sys.exit(f"[fatal] PETS_INDEX in pets-data.js is not valid JSON: {err}")
    if not isinstance(index, list):
        sys.exit("[fatal] PETS_INDEX in pets-data.js is not a list")
    return index

def clean_items(items):
    """Guard against data files written before build_data.py checked CIDs.

    A CID that went through a spreadsheet ("6.47E+18") makes every Google link
    on the page dead, so it is dropped. The same Google business listed twice
    (once per keyword CSV, the copy under a city-prefixed id) would get two
    pages and show twice in the city list; the first one is kept. The second
    URL still resolves: the host rewrites it to /listing.html, which reads the
    same data file.
    """
    out, seen = [], set()
    for b in items:
        # Hidden in the admin panel: no page, no card, no sitemap entry. The
        # export already leaves these out; this covers hand-edited data.
        if is_hidden(b):
            continue
        cid = str(b.get("google_cid") or "")
        if cid and not cid.isdigit():
            b["google_cid"] = cid = ""
            b["gmb_link"] = ""
        if cid:
            if cid in seen:
                continue
            seen.add(cid)
        out.append(b)
    return out

def sitemap_group(path):
    """Child sitemap a URL belongs to: one per country, the rest 'static'."""
    m = re.match(r"^/(in|us)/", path)
    return m.group(1) if m else "static"

def write_sitemaps(out_root, urls, chunk=None, default_lastmod=None):
    """Write sitemap.xml as a <sitemapindex> over chunked child files.

    urls = [(path, priority, changefreq, lastmod_or_None), ...]. Children are
    sitemap-static.xml, sitemap-in-1.xml.., sitemap-us-1.xml.., at most `chunk`
    URLs each (Google caps a file at 50k URLs / 50 MB). The index keeps the
    name sitemap.xml, so robots.txt and Search Console need no change. Child
    files from an earlier, bigger build are removed so the index never points
    at a stale one and no orphan lingers on the host.
    """
    chunk = max(1, int(chunk or SITEMAP_CHUNK))
    default_lastmod = default_lastmod or date.today().isoformat()
    out_root = Path(out_root)
    groups = {}
    for u in urls:
        groups.setdefault(sitemap_group(u[0]), []).append(u)

    for old in out_root.glob("sitemap-*.xml"):
        old.unlink()

    children = []  # (filename, lastmod)
    for g in ("static", "in", "us"):
        rows = groups.get(g) or []
        parts = [rows[i:i + chunk] for i in range(0, len(rows), chunk)]
        for n, part in enumerate(parts, start=1):
            name = f"sitemap-{g}.xml" if g == "static" and len(parts) == 1 else f"sitemap-{g}-{n}.xml"
            sm = ['<?xml version="1.0" encoding="UTF-8"?>',
                  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
            newest = ""
            for path, prio, cf, lm in part:
                lm = lm or default_lastmod
                newest = max(newest, lm)
                sm.append(
                    f"  <url><loc>{escape(SITE + path)}</loc><lastmod>{lm}</lastmod>"
                    f"<changefreq>{cf}</changefreq><priority>{prio}</priority></url>"
                )
            sm.append("</urlset>")
            (out_root / name).write_text("\n".join(sm) + "\n", encoding="utf-8")
            children.append((name, newest or default_lastmod))

    idx = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for name, lm in children:
        idx.append(f"  <sitemap><loc>{SITE}/{name}</loc><lastmod>{lm}</lastmod></sitemap>")
    idx.append("</sitemapindex>")
    (out_root / "sitemap.xml").write_text("\n".join(idx) + "\n", encoding="utf-8")
    return children

def main():
    global OUT_ROOT
    ap = argparse.ArgumentParser(description="Pre-render the static SEO pages and sitemaps.")
    ap.add_argument("--out", help="write in/, us/ and the sitemaps here instead of the site root "
                                  "(default: PETS_PAGES_OUT, else the site root)")
    args = ap.parse_args()
    if args.out:
        OUT_ROOT = Path(args.out)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    print(f"[info] reading index: {INDEX_FILE.name}")
    index = load_index()
    print(f"[info] {len(index)} cities to generate -> {OUT_ROOT}")

    # Wipe any previous build of these dirs (don't touch root files).
    for sub in ("in", "us"):
        d = OUT_ROOT / sub
        if d.exists():
            shutil.rmtree(d)

    counts = {"city": 0, "city_pages": 0, "category": 0, "listing": 0}
    sitemap_urls = []  # list of (path, priority, changefreq, lastmod)

    # Track which paths we've generated to flag any duplicates.
    seen_paths = set()
    def write(rel_path, html):
        path = OUT_ROOT / rel_path.lstrip("/")
        # Every page URL ends in "/", so it is a folder with an index.html.
        # Deciding by suffix wrote ids like "...-6.47E+18" (suffix ".47E+18")
        # out as a bare file, so /us/denton/<id>/ was a 404.
        if rel_path.endswith("/") or path.suffix == "":
            path = path / "index.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        if str(path) in seen_paths:
            print(f"[warn] duplicate write: {path}")
        seen_paths.add(str(path))

    for cmeta in index:
        country = cmeta["country"]
        city_slug = cmeta["city_slug"]
        # An older pets-data.js has no flag; treat those cities as substantial,
        # which is what they were when that file was written.
        thin = bool(cmeta.get("thin", False))
        data_file = DATA_DIR / f"{country.lower()}-{city_slug}.json"
        if not data_file.exists():
            print(f"[skip] missing data: {data_file.name}")
            continue
        raw_items = json.loads(data_file.read_text(encoding="utf-8"))
        items = clean_items(raw_items)
        if not items:
            continue
        # Every id this city had at build time (CID duplicates included: they
        # still resolve through /listing.html), for the live-merge script.
        city_ids = [b["id"] for b in raw_items if b.get("id") and not is_hidden(b)]
        city = items[0]["city"]

        # Build the canonical categories list (by count desc).
        cat_count = {}
        for b in items:
            key = (b["category_slug"], b["category"], b.get("category_icon", "📍"))
            cat_count[key] = cat_count.get(key, 0) + 1
        cats = [{"slug": k[0], "name": k[1], "icon": k[2], "count": v}
                for k, v in sorted(cat_count.items(), key=lambda x: -x[1])]

        # ---- City pages (with pagination) ----
        total_pages = max(1, math.ceil(len(items) / PAGE_SIZE))
        for page in range(1, total_pages + 1):
            html = render_city(country, city_slug, city, items, cats, page, total_pages, index, thin=thin,
                               known_ids=city_ids if page == 1 else None)
            url  = city_url(country, city_slug, page)
            write(url, html)
            if not thin:
                sitemap_urls.append((url, "0.8" if (page == 1 and len(items) >= 100) else ("0.7" if page == 1 else "0.5"), "weekly", None))
            counts["city_pages"] += 1
        counts["city"] += 1

        # ---- City + Category pages ----
        for cat in cats:
            cat_items = [b for b in items if b["category_slug"] == cat["slug"]]
            if not cat_items:
                continue
            cat_ids = [b["id"] for b in raw_items if b.get("category_slug") == cat["slug"] and b.get("id") and not is_hidden(b)]
            html = render_category(country, city_slug, city, cat["name"], cat["slug"], cat_items, cats, index, thin=thin,
                                   known_ids=cat_ids)
            url  = category_url(country, city_slug, cat["slug"])
            write(url, html)
            if not thin:
                sitemap_urls.append((url, "0.7", "weekly", None))
            counts["category"] += 1

        # ---- Listing pages ----
        for b in items:
            html = render_listing(b, items, cats)
            url  = listing_url(b)
            write(url, html)
            sitemap_urls.append((url, "0.6", "monthly", None))
            counts["listing"] += 1

        if (counts["city"]) % 50 == 0:
            print(f"[..] {counts['city']:>4}/{len(index)} cities · "
                  f"city_pages={counts['city_pages']:>5} · "
                  f"cat={counts['category']:>5} · "
                  f"listings={counts['listing']:>6}")

    print()
    print(f"[done] city pages:      {counts['city_pages']:>6}")
    print(f"[done] city+cat pages:  {counts['category']:>6}")
    print(f"[done] listing pages:   {counts['listing']:>6}")
    print(f"[done] total pages:     {counts['city_pages'] + counts['category'] + counts['listing']:>6}")

    # ---- Sitemap index + child files ----
    static_urls = [
        ("/",                 "1.0", "daily",   None),
        ("/marketing.html",   "0.9", "weekly",  None),
        ("/register-business/", "0.8", "monthly", None),
        ("/find-my-listing/", "0.7", "monthly", None),
        ("/membership/",      "0.7", "monthly", None),
        ("/privacy.html",     "0.3", "yearly",  None),
        ("/terms.html",       "0.3", "yearly",  None),
    ]
    all_urls = static_urls + sitemap_urls
    children = write_sitemaps(OUT_ROOT, all_urls)
    print(f"[done] sitemap.xml index -> {len(children)} child files "
          f"({len(all_urls):,} URLs, max {SITEMAP_CHUNK:,} per file)")


if __name__ == "__main__":
    main()
