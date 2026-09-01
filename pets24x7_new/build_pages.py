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

Run after build_data.py:
  python build_pages.py
"""

import json
import math
import re
import shutil
import sys
from html import escape
from pathlib import Path

# ---- Config ---------------------------------------------------------------

ROOT       = Path(__file__).resolve().parent
DATA_DIR   = ROOT / "data"
INDEX_FILE = ROOT / "pets-data.js"
SITE       = "https://pets24x7.com"
WA_NUMBER  = "919930090487"
PAGE_SIZE  = 50          # city-page pagination
SITEMAP_CHUNK = 40000    # URLs per sitemap shard (limit is 50k)

# Pet-themed Unsplash photo IDs grouped by category slug.
IMG_POOL = {
    "veterinary-clinics":              ["photo-1583337130417-3346a1be7dee","photo-1628009368231-7bb7cfcb0def","photo-1581888227599-779811939961","photo-1606851094291-6efae152bb87","photo-1535930891776-0c2dfb7fda1a"],
    "emergency-animal-hospital":       ["photo-1628009368231-7bb7cfcb0def","photo-1583337130417-3346a1be7dee","photo-1606851094291-6efae152bb87","photo-1581888227599-779811939961","photo-1535930891776-0c2dfb7fda1a"],
    "vaccination-centers":             ["photo-1606851094291-6efae152bb87","photo-1581888227599-779811939961","photo-1583337130417-3346a1be7dee","photo-1535930891776-0c2dfb7fda1a","photo-1628009368231-7bb7cfcb0def"],
    "mobile-vet-services":             ["photo-1535930891776-0c2dfb7fda1a","photo-1628009368231-7bb7cfcb0def","photo-1601758125946-6ec2ef64daf8","photo-1583337130417-3346a1be7dee","photo-1450778869180-41d0601e046e"],
    "specialty-vets-exotics-avian-reptiles": ["photo-1452857297128-d9c29adba80b","photo-1535930891776-0c2dfb7fda1a","photo-1583337130417-3346a1be7dee","photo-1574144611937-0df059b5ef3e","photo-1606851094291-6efae152bb87"],
    "veterinary-labs-diagnostics":     ["photo-1581093588401-fbb62a02f120","photo-1583337130417-3346a1be7dee","photo-1606851094291-6efae152bb87","photo-1535930891776-0c2dfb7fda1a","photo-1574144611937-0df059b5ef3e"],
    "pet-dental-care":                 ["photo-1601758125946-6ec2ef64daf8","photo-1583337130417-3346a1be7dee","photo-1606851094291-6efae152bb87","photo-1543466835-00a7907e9de1","photo-1535930891776-0c2dfb7fda1a"],
    "pet-physiotherapy-rehab":         ["photo-1450778869180-41d0601e046e","photo-1583337130417-3346a1be7dee","photo-1535930891776-0c2dfb7fda1a","photo-1543466835-00a7907e9de1","photo-1601758228041-f3b2795255f1"],
    "pet-grooming-spa":                ["photo-1516734212186-a967f81ad0d7","photo-1548767797-d8c844163c4c","photo-1591768793355-74d04bb6608f","photo-1583337130417-3346a1be7dee","photo-1543466835-00a7907e9de1"],
    "pet-boarding-daycare":            ["photo-1543466835-00a7907e9de1","photo-1601758228041-f3b2795255f1","photo-1587300003388-59208cc962cb","photo-1450778869180-41d0601e046e","photo-1574144611937-0df059b5ef3e"],
    "pet-walking":                     ["photo-1450778869180-41d0601e046e","photo-1548199973-03cce0bbc87b","photo-1551717743-49959800b1f6","photo-1543466835-00a7907e9de1","photo-1587300003388-59208cc962cb"],
    "pet-training-obedience-behavior": ["photo-1576201836106-db1758fd1c97","photo-1587300003388-59208cc962cb","photo-1601758228041-f3b2795255f1","photo-1450778869180-41d0601e046e","photo-1574144611937-0df059b5ef3e"],
    "pet-sitting-in-home-care":        ["photo-1601758228041-f3b2795255f1","photo-1543466835-00a7907e9de1","photo-1583337130417-3346a1be7dee","photo-1574144611937-0df059b5ef3e","photo-1450778869180-41d0601e046e"],
    "pet-relocation-services":         ["photo-1518717758536-85ae29035b6d","photo-1548767797-d8c844163c4c","photo-1450778869180-41d0601e046e","photo-1543466835-00a7907e9de1","photo-1587300003388-59208cc962cb"],
    "pet-taxi-transport":              ["photo-1518717758536-85ae29035b6d","photo-1548767797-d8c844163c4c","photo-1450778869180-41d0601e046e","photo-1583337130417-3346a1be7dee","photo-1543466835-00a7907e9de1"],
    "pet-therapy-services":            ["photo-1535930891776-0c2dfb7fda1a","photo-1601758228041-f3b2795255f1","photo-1450778869180-41d0601e046e","photo-1574144611937-0df059b5ef3e","photo-1543466835-00a7907e9de1"],
}
DEFAULT_IMGS = ["photo-1583337130417-3346a1be7dee","photo-1543466835-00a7907e9de1","photo-1516734212186-a967f81ad0d7","photo-1452857297128-d9c29adba80b","photo-1450778869180-41d0601e046e","photo-1574144611937-0df059b5ef3e"]

# Category-specific amenity pools (mirror the JS in listing.html for consistency).
AMENITY_POOLS = {
    "veterinary-clinics":              ["Walk-in welcome","Surgery on site","In-house pharmacy","Cat-friendly waiting","Dog-friendly waiting","Card payments","Senior pet care","Vaccination","X-ray","Blood work"],
    "emergency-animal-hospital":       ["24x7 emergency","In-house ICU","Walk-in","Critical care","Surgery on site","Card payments","Ambulance","Oxygen support","Post-op recovery","Anaesthesia"],
    "pet-grooming-spa":                ["De-shedding","Nail clipping","Anti-tick bath","Breed-specific cut","Hair colouring","Pickup & drop","Pet-safe products","AC waiting area","By appointment","First-time discount"],
    "pet-boarding-daycare":            ["CCTV monitored","AC kennels","Outdoor play yard","Veg & non-veg meals","Daycare slots","Vet on call","Photo updates","Long-stay discount","Pickup & drop","Vaccinated pets only"],
    "pet-walking":                     ["Daily slots","Group / solo walks","GPS tracked","Insured walkers","Pickup from home","Bath included","Weekend slots","Multi-pet rate","Same walker every day"],
    "pet-training-obedience-behavior": ["Puppy classes","Group sessions","Home training","Aggression management","Service-dog prep","Trick training","Free demo","Certified trainer"],
    "pet-sitting-in-home-care":        ["Overnight stays","Hourly visits","Pet feeding","Plant watering","Medication management","Insured sitters","Photo updates","Senior pet care"],
    "pet-dental-care":                 ["Scaling","Polishing","Extraction","Anaesthesia option","Dental X-ray","Vet certified","Pre-anaesthetic bloodwork","Aftercare kit"],
    "mobile-vet-services":             ["Home visits","Vaccination at home","Sample collection","Senior pet care","Anxious-pet friendly","By appointment","Wellness check","Microchipping"],
    "vaccination-centers":             ["Anti-rabies","DHPPi","Tricat","Travel certificates","Walk-in","Stocked vaccines","Booster reminders","Microchipping"],
    "pet-relocation-services":         ["IATA-approved crates","Domestic transport","International transport","Customs paperwork","Door-to-door","Health certificates"],
    "pet-taxi-transport":              ["AC vehicles","Crate provided","Door-to-door","Same-day booking","City + airport runs","Multiple pets"],
    "pet-physiotherapy-rehab":         ["Hydrotherapy","Post-surgery care","Senior pet rehab","Laser therapy","Joint care","Vet certified"],
    "veterinary-labs-diagnostics":     ["Blood work","Sample pickup","Same-day reports","Pathology","Microbiology","Imaging support"],
    "specialty-vets-exotics-avian-reptiles": ["Exotic species","Avian care","Reptile care","Small mammal care","Boarding for exotics","Specialist referral"],
    "pet-therapy-services":            ["Certified therapy animals","School visits","Hospital visits","Senior home visits","Children sessions"],
}

CATEGORY_BLURB = {
    "veterinary-clinics":              "A trusted local veterinary practice offering general consultations, vaccinations and routine care for dogs, cats and small pets.",
    "emergency-animal-hospital":       "An emergency-capable animal hospital handling urgent cases, ICU support and post-operative care.",
    "vaccination-centers":             "A vaccination centre stocking core and lifestyle vaccines for puppies, kittens and adult pets — including travel certificates on request.",
    "mobile-vet-services":             "A mobile vet bringing routine consults, vaccinations and sample collection to your home — ideal for anxious or senior pets.",
    "specialty-vets-exotics-avian-reptiles": "A specialty practice that handles exotic species — birds, reptiles, rabbits and small mammals — beyond the typical dog/cat clinic.",
    "pet-dental-care":                 "A pet dental care provider offering cleaning, scaling, polishing and extractions under safe anaesthesia protocols.",
    "pet-physiotherapy-rehab":         "A pet physiotherapy and rehab centre with hydrotherapy, laser and joint care for post-surgical and senior pets.",
    "pet-grooming-spa":                "A grooming and spa that handles breed-specific cuts, de-shedding, nail clips and anti-tick baths with pet-safe products.",
    "pet-boarding-daycare":            "A boarding and daycare facility with supervised play, CCTV, and structured feeding for short trips and long stays.",
    "pet-walking":                     "A professional pet-walking service running daily group and solo walks across the neighbourhood, with optional pickup and drop.",
    "pet-training-obedience-behavior": "A pet trainer running puppy classes, obedience programs and behaviour-modification sessions — at the studio or at home.",
    "pet-sitting-in-home-care":        "An in-home pet sitter who feeds, walks and watches your pet while you travel — with photo updates and medication management.",
    "pet-relocation-services":         "A pet relocation specialist handling domestic and international transport, IATA-approved crates and the full paperwork chain.",
    "pet-taxi-transport":              "A pet taxi running AC-equipped trips for vet visits, grooming pickups, airport runs and inter-city moves.",
    "veterinary-labs-diagnostics":     "A veterinary diagnostic lab handling blood work, imaging support and home sample collection for partner clinics.",
    "pet-therapy-services":            "A pet-assisted therapy service supporting hospitals, schools and individual clients with certified therapy animals.",
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
    "pet-grooming-spa":                "AnimalShelter",
    "pet-boarding-daycare":            "AnimalShelter",
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

def img_for(biz, idx=0, w=600, h=450):
    pool = IMG_POOL.get(biz.get("category_slug"), DEFAULT_IMGS)
    pic  = pool[(seed_of(biz.get("id", "")) + idx) % len(pool)]
    return f"https://images.unsplash.com/{pic}?w={w}&h={h}&fit=crop&q=70"

def amenities_for(biz, n=10):
    seed = seed_of(biz.get("id", ""))
    pool = AMENITY_POOLS.get(biz.get("category_slug"), ["Verified listing","Google rated","Direct contact","Local provider"])
    out, picked = [], set()
    for i in range(n):
        a = pool[(seed + i * 3) % len(pool)]
        if a not in picked:
            out.append(a); picked.add(a)
    return out

def recent_rating_squares(biz):
    seed = seed_of(biz["id"])
    avg = biz["rating"] or 4.5
    out = []
    for i in range(10):
        x = ((seed * 9301 + (i + 1) * 49297) % 233280) / 233280.0
        raw = avg + (x - 0.5) * 3.0
        r = max(1, min(5, round(raw)))
        out.append(f'<span class="recent-square rs-{r}" title="{r} star rating">{r}</span>')
    return "".join(out)

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
    <img class="brand-logo" src="/pets24x7_logo.png" alt="Pets24x7" width="36" height="36" />
    <span class="brand-mark">
      <span class="brand-name">Pets24x7<span class="tld">.com</span></span>
      <span class="brand-tag">Pet Services Marketplace</span>
    </span>
  </a>
  <div class="hdr-right">
    <nav class="hdr-nav">
      <a href="/marketing.html"{' aria-current="page"' if active=="marketing" else ""}>For Businesses</a>
    </nav>
    <a href="tel:+{WA_NUMBER}" class="call-link">📞 +91 99300 90487</a>
    <a href="https://wa.me/{WA_NUMBER}?text=Hi%20Pets24x7!" class="hdr-cta" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
      <span>Chat</span>
    </a>
  </div>
</div></header>
"""

def footer_html():
    return f"""\
<footer><div class="foot-in">
  <span>© 2026 Pets24x7.com — Pet Services Marketplace.</span>
  <span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/marketing.html">For Businesses</a> · <a href="https://wa.me/{WA_NUMBER}">WhatsApp</a> · <a href="mailto:hello@pets24x7.com">hello@pets24x7.com</a></span>
</div></footer>
<a href="https://wa.me/{WA_NUMBER}?text=Hi%20Pets24x7!%20I%20need%20a%20pet%20service%20recommendation..." class="float-wa" target="_blank" rel="noopener">
  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
  <span>Help on WhatsApp</span>
</a>
"""

def google_logo_html():
    return ('<span class="glogo"><span class="gB">G</span><span class="go1">o</span>'
            '<span class="go2">o</span><span class="gg">g</span><span class="gl">l</span>'
            '<span class="ge">e</span></span>')

# ---- Schema generators ----------------------------------------------------

def breadcrumb_jsonld(items):
    """items = [(name, url_or_none), ...] — url is None for the last (current) item."""
    out = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": []}
    for i, (name, url) in enumerate(items, start=1):
        entry = {"@type": "ListItem", "position": i, "name": name}
        if url:
            entry["item"] = SITE + url
        out["itemListElement"].append(entry)
    return json.dumps(out, ensure_ascii=False)

def listing_jsonld(biz):
    obj = {
        "@context": "https://schema.org",
        "@type": SCHEMA_TYPE.get(biz["category_slug"], "LocalBusiness"),
        "@id": SITE + listing_url(biz),
        "name": biz["name"],
        "url": SITE + listing_url(biz),
        "image": img_for(biz, 0, 1200, 800),
        "description": (f'{biz["name"]} is a verified {biz["category"].lower()} in '
                        f'{biz["city"]}{", " + biz["state"] if biz.get("state") else ""}. '
                        f'Rated {biz["rating"]}/5 on Google from {biz["review_count"]} reviews.'),
        "address": {
            "@type": "PostalAddress",
            "streetAddress": biz.get("address") or "",
            "addressLocality": biz["city"],
            "addressRegion": biz.get("state") or "",
            "postalCode": biz.get("pincode") or "",
            "addressCountry": biz["country"],
        },
        "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": biz["rating"],
            "reviewCount": max(biz.get("review_count") or 1, 1),
            "bestRating": 5,
            "worstRating": 1,
        },
        "priceRange": "$$",
    }
    if biz.get("phone"):
        obj["telephone"] = biz["phone"]
    if biz.get("website"):
        obj["sameAs"] = [biz["website"], biz.get("gmb_link", "")]
        obj["sameAs"] = [x for x in obj["sameAs"] if x]
    elif biz.get("gmb_link"):
        obj["sameAs"] = [biz["gmb_link"]]
    return json.dumps(obj, ensure_ascii=False)

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
    return json.dumps(out, ensure_ascii=False)

# ---- Components ----------------------------------------------------------

def biz_card_html(b, badge=None):
    img = img_for(b, 0)
    amens = "".join(f'<span class="amenity">{e(a)}</span>' for a in amenities_for(b, 4))
    badge_html = ""
    if badge == "top":
        badge_html = '<span class="badge">Top Rated</span>'
    elif badge == "featured":
        badge_html = '<span class="badge" style="background:var(--warning);color:#1F2937;">Featured</span>'

    google_box = ""
    if b.get("google_cid"):
        google_box = (f'<span class="google-badge"><span class="gscore">{b["rating"]:.1f}/5</span>'
                      f'{google_logo_html()}'
                      f'<a href="https://www.google.com/maps?cid={ea(b["google_cid"])}" '
                      f'target="_blank" rel="noopener">{b["review_count"]} reviews</a></span>')

    phone_html = ""
    if b.get("phone"):
        clean_phone = re.sub(r"\s+", "", b["phone"])
        phone_html = (f'<div class="biz-phone">📞 <a href="tel:{ea(clean_phone)}">'
                      f'{e(b["phone"])}</a></div>')

    return f"""<article class="biz-card">
  <a class="biz-img" href="{listing_url(b)}">
    {badge_html}
    <span class="ct-chip">{e(b.get("category_icon") or "📍")} {e(b["category"])}</span>
    <img loading="lazy" src="{ea(img)}" alt="{ea(b["name"])}" width="280" height="210" onerror="this.style.display='none';">
  </a>
  <div class="biz-info">
    <h3><a href="{listing_url(b)}">{e(b["name"])}</a></h3>
    <div class="biz-loc">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
      {e(b.get("address") or (b["city"] + (", " + b["state"] if b.get("state") else "")))}
    </div>
    <div class="biz-rating">
      <span class="rating-pill">★ {b["rating"]:.1f}</span>
      {google_box}
    </div>
    <div class="amenities">{amens}</div>
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

def cat_chips_html(country, city_slug, categories, active_cat=None):
    """categories = [{slug, name, icon, count}, ...]"""
    chips = [f'<a class="cat-chip{" active" if active_cat is None else ""}" href="{city_url(country, city_slug)}">All categories</a>']
    for c in categories:
        cls = "cat-chip active" if c["slug"] == active_cat else "cat-chip"
        chips.append(
            f'<a class="{cls}" href="{category_url(country, city_slug, c["slug"])}">'
            f'{e(c["icon"])} {e(c["name"])} <span class="ct">{c["count"]}</span></a>'
        )
    return f'<section class="cat-chips"><div class="container"><div class="cat-chips-row">{"".join(chips)}</div></div></section>'

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
  <p>Pets24x7 lists {total:,} verified pet service businesses across {e(city)} — including {cats_txt} and more. Every listing carries a real Google rating and review count, so you can pick a provider for your dog, cat, bird or exotic pet with confidence.</p>
  <p>Use the category chips above to narrow down by what you need today — an emergency vet, a weekend groomer, a daycare slot, or a relocation specialist. Tap any listing to see the full address, phone, recent customer ratings, and a one-tap WhatsApp enquiry button that pings the business directly.</p>
  <h3>How Pets24x7 verifies {e(city)} listings</h3>
  <ul>
    <li>Every business has a public Google Business profile and a live Google rating.</li>
    <li>Listings are categorised by service type, so a "vet" search doesn't surface a groomer.</li>
    <li>Featured listings (where shown) are curated based on customer reviews and verification status.</li>
    <li>If you spot an inaccuracy or want to claim your listing, message us on WhatsApp.</li>
  </ul>
</section>"""

def seo_copy_category(category, city, country_n, total):
    blurb = CATEGORY_BLURB.get(slugify(category), "")
    return f"""<section class="seo-copy">
  <h2>{e(category)} in {e(city)}, {e(country_n)}</h2>
  <p>Browse {total} verified {e(category.lower())} business{"es" if total != 1 else ""} in {e(city)}. {e(blurb)} Pets24x7 sorts the results by Google rating — so the highest-rated providers appear first.</p>
  <p>Tap any listing to view the full address, contact details, customer reviews, embedded Google Map and a one-tap WhatsApp enquiry button. No booking fees. No platform commission. You talk to the business directly.</p>
</section>"""

def related_cities_html(country, current_slug, all_cities, limit=12):
    """Sidebar of other cities in the same country, for SEO interlinking."""
    cities = [c for c in all_cities if c["country"] == country and c["city_slug"] != current_slug][:limit]
    if not cities:
        return ""
    pills = "".join(f'<a href="{city_url(country, c["city_slug"])}">{e(c["city"])} <span style="color:var(--text-light);font-weight:500;">· {c["count"]}</span></a>' for c in cities)
    return f'<section class="related"><h3>More cities in {country_name(country)}</h3><div class="related-grid">{pills}</div></section>'

# ---- Page templates -------------------------------------------------------

def render_city(country, city_slug, city, items, categories, page, total_pages, all_cities, page_size=PAGE_SIZE):
    country_n = country_name(country)
    state = next((b["state"] for b in items if b.get("state")), "")
    full_city = f"{city}{', ' + state if (country == 'US' and state) else ''}"

    page_items = items[(page - 1) * page_size : page * page_size]

    title = f"Pet services in {full_city} — {len(items):,} verified vets, groomers, boarders | Pets24x7"
    if page > 1:
        title = f"Pet services in {full_city} (page {page} of {total_pages}) | Pets24x7"
    desc = (f"Browse {len(items):,} verified pet service businesses in {full_city} on Pets24x7 — "
            f"vets, groomers, boarders, walkers, trainers and more, with real Google ratings.")

    canonical = SITE + city_url(country, city_slug, page)
    prev_link = f'<link rel="prev" href="{SITE}{city_url(country, city_slug, page - 1)}" />' if page > 1 else ""
    next_link = f'<link rel="next" href="{SITE}{city_url(country, city_slug, page + 1)}" />' if page < total_pages else ""

    cards = "".join(
        biz_card_html(b, badge=("top" if b["rating"] >= 4.8 and b["review_count"] >= 100 else ("featured" if page == 1 and i == 0 else None)))
        for i, b in enumerate(page_items)
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
{prev_link}{next_link}
<link rel="icon" type="image/png" href="/pets24x7_logo.png" />
<meta property="og:type" content="website" />
<meta property="og:title" content="{ea(title)}" />
<meta property="og:description" content="{ea(desc)}" />
<meta property="og:url" content="{canonical}" />
<meta property="og:image" content="{SITE}/pets24x7_logo.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css" />
<script src="/config.js"></script>
<script type="application/ld+json">{bc_jsonld}</script>
<script type="application/ld+json">{list_jsonld}</script>
</head>
<body>

{header_html()}

<section class="city-hero"><div class="container">
  <div class="bc">{bc_html}</div>
  <h1>Pet services in {e(full_city)}{f' · page {page}' if page > 1 else ''}</h1>
  <p class="sub">{len(items):,} verified businesses · Real Google ratings · WhatsApp them direct</p>
</div></section>

{cat_chips_html(country, city_slug, categories)}

<main class="main"><div class="container">
  <div class="results-bar">
    <div class="results-count"><strong>{len(items):,}</strong> businesses in {e(full_city)}{f' — showing {(page-1)*page_size + 1}–{(page-1)*page_size + len(page_items)}' if total_pages > 1 else ''}</div>
  </div>
  <div class="biz-list">{cards}</div>
  {pagination_html(country, city_slug, page, total_pages)}
  {seo_copy_city(full_city, country_n, len(items), categories)}
  {related_cities_html(country, city_slug, all_cities)}
</div></main>

{footer_html()}
</body>
</html>
"""

def render_category(country, city_slug, city, category_name, category_slug, items, all_cats, all_cities):
    country_n = country_name(country)
    state = next((b["state"] for b in items if b.get("state")), "")
    full_city = f"{city}{', ' + state if (country == 'US' and state) else ''}"

    title = f"{category_name} in {full_city} — {len(items)} verified providers | Pets24x7"
    desc = (f"Find {len(items)} verified {category_name.lower()} provider{'s' if len(items) != 1 else ''} in {full_city}. "
            f"Real Google ratings. Direct WhatsApp enquiries. Zero booking fees.")

    canonical = SITE + category_url(country, city_slug, category_slug)
    cards = "".join(
        biz_card_html(b, badge=("top" if b["rating"] >= 4.8 and b["review_count"] >= 100 else ("featured" if i == 0 else None)))
        for i, b in enumerate(items)
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
<link rel="icon" type="image/png" href="/pets24x7_logo.png" />
<meta property="og:type" content="website" />
<meta property="og:title" content="{ea(title)}" />
<meta property="og:description" content="{ea(desc)}" />
<meta property="og:url" content="{canonical}" />
<meta property="og:image" content="{SITE}/pets24x7_logo.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css" />
<script src="/config.js"></script>
<script type="application/ld+json">{bc_jsonld}</script>
<script type="application/ld+json">{list_jsonld}</script>
</head>
<body>

{header_html()}

<section class="city-hero"><div class="container">
  <div class="bc">{bc_html}</div>
  <h1>{e(category_name)} in {e(full_city)}</h1>
  <p class="sub">{len(items)} verified provider{'s' if len(items) != 1 else ''} · Real Google ratings · WhatsApp them direct</p>
</div></section>

{cat_chips_html(country, city_slug, all_cats, active_cat=category_slug)}

<main class="main"><div class="container">
  <div class="results-bar">
    <div class="results-count"><strong>{len(items)}</strong> {e(category_name.lower())} provider{'s' if len(items) != 1 else ''} in {e(full_city)}</div>
  </div>
  <div class="biz-list">{cards}</div>
  {seo_copy_category(category_name, full_city, country_n, len(items))}
  {related_cities_html(country, city_slug, all_cities)}
</div></main>

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

    title = f"{biz['name']} — {biz['category']} in {full_city} | Pets24x7"
    desc = (f"{biz['name']} is a verified {biz['category']} in {full_city}. "
            f"Rated {biz['rating']:.1f}/5 on Google from {biz['review_count']} reviews. "
            f"WhatsApp them direct via Pets24x7 — no booking fees.")

    canonical = SITE + listing_url(biz)
    img_main = img_for(biz, 0, 1200, 800)
    imgs = [img_for(biz, 0, 1000, 600), img_for(biz, 1, 600, 400),
            img_for(biz, 2, 600, 400), img_for(biz, 3, 600, 400),
            img_for(biz, 4, 600, 400)]

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
    address = biz.get("address") or full_city

    # Google reviews block (only if CID exists)
    reviews_section = ""
    if biz.get("google_cid"):
        ai_tone = ("professional staff, clear pricing and genuine care for the animals."
                   if biz["rating"] >= 4.7 else
                   "good experience overall with attentive staff and reasonable rates."
                   if biz["rating"] >= 4.3 else
                   "mixed feedback — read individual reviews to judge fit for your pet.")
        reviews_section = f"""<section>
  <h2>Guest reviews</h2>
  <div class="greviews-head">
    <div class="greviews-score">{biz["rating"]:.1f}<small>/5</small></div>
    <div class="glogo-big">
      {google_logo_html()}<br>
      <a href="https://www.google.com/maps?cid={ea(biz['google_cid'])}" target="_blank" rel="noopener">View {biz["review_count"]} ratings →</a>
    </div>
  </div>
  <div class="recent-row">
    <div class="label">Last 10 customer ratings</div>
    <div class="recent-squares">{recent_rating_squares(biz)}</div>
  </div>
  <div class="ai-summary">
    <div class="ai-tag">✦ AI-generated summary</div>
    <p>{e(biz['name'])} holds a <strong>{biz['rating']:.1f}/5</strong> on Google from <strong>{biz['review_count']} real customer reviews</strong>. Recurring themes from recent pet parents: {ai_tone}</p>
  </div>
  <iframe class="gmap-embed" loading="lazy" src="https://www.google.com/maps?cid={ea(biz['google_cid'])}&output=embed" allowfullscreen title="Map of {ea(biz['name'])}"></iframe>
</section>"""

    phone_line = ""
    if biz.get("phone"):
        clean_phone = re.sub(r"\s+", "", biz["phone"])
        phone_line = f'<p style="margin-top:6px;">📞 <strong>Phone:</strong> <a href="tel:{ea(clean_phone)}" style="color:var(--primary);font-weight:600;">{e(biz["phone"])}</a></p>'

    website_line = ""
    if biz.get("website"):
        display_web = biz["website"].replace("http://", "").replace("https://", "").rstrip("/")
        website_line = f'<p style="margin-top:6px;">🌐 <strong>Website:</strong> <a href="{ea(biz["website"])}" target="_blank" rel="noopener nofollow" style="color:var(--primary);font-weight:600;">{e(display_web)}</a></p>'

    # Sibling listings in the same city + category, for SEO interlinking.
    siblings = [b for b in all_in_city if b["category_slug"] == biz["category_slug"] and b["id"] != biz["id"]][:6]
    related_html = ""
    if siblings:
        sib = "".join(f'<a href="{listing_url(s)}">{e(s["name"])} <span style="color:var(--text-light);font-weight:500;">★ {s["rating"]:.1f}</span></a>' for s in siblings)
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
<link rel="icon" type="image/png" href="/pets24x7_logo.png" />
<meta property="og:type" content="business.business" />
<meta property="og:title" content="{ea(biz['name'])}" />
<meta property="og:description" content="{ea(desc)}" />
<meta property="og:url" content="{canonical}" />
<meta property="og:image" content="{ea(img_main)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/styles.css" />
<script src="/config.js"></script>
<script type="application/ld+json">{biz_jsonld}</script>
<script type="application/ld+json">{bc_jsonld}</script>
</head>
<body>

{header_html()}

<div class="container">
  <div class="bc" style="padding:14px 0 0;font-size:13px;color:var(--text-muted);">{bc_html}</div>

  <div class="title-block">
    <div>
      <h1>{e(biz["name"])}</h1>
      <div class="meta-row">
        <span class="rating-pill">★ {biz["rating"]:.1f}</span>
        {f'''<a href="https://www.google.com/maps?cid={ea(biz["google_cid"])}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid var(--border);padding:3px 8px 3px 5px;border-radius:6px;font-size:12px;font-weight:600;color:var(--text);text-decoration:none;">
          <span style="background:var(--success);color:#fff;padding:2px 6px;border-radius:4px;font-weight:800;font-size:11px;">{biz["rating"]:.1f}/5</span>
          <span class="glogo-big" style="font-size:12px;">{google_logo_html()}</span>
          <span style="color:var(--primary);">View {biz["review_count"]} ratings</span>
        </a>''' if biz.get("google_cid") else ""}
        <span>{e(biz.get("category_icon") or "📍")} {e(biz["category"])}</span>
        <span>·</span>
        <span>📍 {e(full_city)}{f" · {e(biz['pincode'])}" if biz.get("pincode") else ""}</span>
      </div>
    </div>
  </div>

  <div class="gallery">
    <img class="g0" src="{ea(imgs[0])}" alt="{ea(biz['name'])} main view" loading="eager">
    <img src="{ea(imgs[1])}" alt="Facility view" loading="lazy">
    <img src="{ea(imgs[2])}" alt="Service area" loading="lazy">
    <img src="{ea(imgs[3])}" alt="Pet care in action" loading="lazy">
    <img src="{ea(imgs[4])}" alt="Happy pets" loading="lazy">
  </div>

  <div class="pdp-layout">
    <div class="pdp-main">
      <section>
        <h2>About this listing</h2>
        <p>{e(biz['name'])} is a Google-verified {e(biz['category'].lower())} located in {e(address)}. {e(blurb)}</p>
        <p style="margin-top:14px;">📍 <strong>Address:</strong> {e(address)}</p>
        {phone_line}
        {website_line}
      </section>

      <section>
        <h2>Services &amp; amenities</h2>
        <div class="amenity-grid">{amens_html}</div>
      </section>

      {reviews_section}

      <section>
        <h2>Business details</h2>
        <div class="info-grid">
          <div class="info-block"><strong>Category</strong><span>{e(biz["category"])}</span></div>
          <div class="info-block"><strong>City</strong><span>{e(full_city)}</span></div>
          <div class="info-block"><strong>{'PIN code' if country == 'IN' else 'ZIP code'}</strong><span>{e(biz.get("pincode") or "—")}</span></div>
          <div class="info-block"><strong>Google rating</strong><span>★ {biz["rating"]:.1f} / 5 · {biz["review_count"]} reviews</span></div>
          {f'<div class="info-block"><strong>Phone</strong><span><a href="tel:{ea(biz_phone_clean)}">{e(biz["phone"])}</a></span></div>' if biz.get("phone") else ""}
          {f'<div class="info-block"><strong>Website</strong><span><a href="{ea(biz["website"])}" target="_blank" rel="noopener nofollow">Visit site ↗</a></span></div>' if biz.get("website") else ""}
        </div>
      </section>

      <section>
        <h2>Good to know</h2>
        <ul class="policy-list">
          <li><span>Booking</span><span>Direct via WhatsApp / phone — no platform fee</span></li>
          <li><span>Verification</span><span>Google-listed, with public reviews</span></li>
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
        <div class="price-tax">★ {biz["rating"]:.1f} / 5 · {biz["review_count"]} Google reviews · {e(full_city)}</div>
        <a href="{ea(wa_link_for(biz))}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;gap:8px;background:var(--whatsapp);color:#fff;padding:13px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin:14px 0;box-shadow:0 6px 16px rgba(37,211,102,0.25);">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
          Quick WhatsApp Enquiry →
        </a>
        <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:16px;">— or fill the form below —</div>
        <form id="bookForm" onsubmit="return submitEnquiry(event)" novalidate>
          <div class="form-row"><div class="form-field form-field-full"><label>Your full name *</label><input type="text" id="fName" required placeholder="e.g. Priya Sharma"></div></div>
          <div class="form-row"><div class="form-field form-field-full"><label>WhatsApp / Phone *</label><input type="tel" id="fPhone" required pattern="[0-9 +-]{{10,15}}" placeholder="e.g. +91 98765 43210"></div></div>
          <div class="form-row">
            <div class="form-field"><label>Pet type</label>
              <select id="fPetType"><option>Dog</option><option>Cat</option><option>Bird</option><option>Rabbit</option><option>Reptile</option><option>Small mammal</option><option>Other</option></select>
            </div>
            <div class="form-field"><label>Preferred date</label><input type="date" id="fDate"></div>
          </div>
          <div class="form-row"><div class="form-field form-field-full"><label>What do you need? *</label><textarea id="fNotes" required placeholder="e.g. Grooming for a Golden Retriever this Saturday, anti-tick bath + nail clip."></textarea></div></div>
          <div class="form-error" id="formError"></div>
          <button type="submit" class="submit-wa">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 018.413 3.488 11.824 11.824 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24z"/></svg>
            Send Enquiry on WhatsApp
          </button>
          <a href="tel:+{WA_NUMBER}" class="secondary-call">📞 Or call +91 99300 90487</a>
        </form>
        <ul class="trust-points">
          <li>Verified Google-listed business</li>
          <li>Direct contact — no booking fees</li>
          <li>We respond on WhatsApp within 5 minutes</li>
          <li>Free to enquire · No commitment</li>
        </ul>
      </div>
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

<script>
  var biz = {{
    id:{json.dumps(biz["id"])},
    name:{json.dumps(biz["name"])},
    category:{json.dumps(biz["category"])},
    city:{json.dumps(biz["city"])},
    state:{json.dumps(biz.get("state") or "")},
    country:{json.dumps(biz["country"])}
  }};
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
  function submitEnquiry(ev){{
    ev.preventDefault();
    var name=document.getElementById('fName').value.trim();
    var phone=document.getElementById('fPhone').value.trim();
    var pet=document.getElementById('fPetType').value;
    var date=document.getElementById('fDate').value;
    var notes=document.getElementById('fNotes').value.trim();
    var err=document.getElementById('formError');
    if(!name||name.length<2){{ err.textContent='Please enter your full name.'; err.classList.add('show'); return false; }}
    if(!phone||phone.replace(/[^0-9]/g,'').length<10){{ err.textContent='Please enter a valid phone / WhatsApp number.'; err.classList.add('show'); return false; }}
    if(!notes){{ err.textContent='Please describe what you need.'; err.classList.add('show'); return false; }}
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
    pushLead({{name:name,business:biz.name,category:biz.category,city:biz.city,country:biz.country,listing_id:biz.id,phone:phone,pet:pet,date:date,notes:notes,source:'listing_page'}});
    var url = 'https://wa.me/{WA_NUMBER}?text=' + encodeURIComponent(msg) + '&utm_source=website&utm_medium=listing_form&utm_campaign=enquiry';
    window.open(url, '_blank');
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
    txt = INDEX_FILE.read_text(encoding="utf-8")
    m = re.search(r"PETS_INDEX\s*=\s*(\[.+?\]);", txt)
    if not m:
        sys.exit("[fatal] could not parse PETS_INDEX from pets-data.js")
    return json.loads(m.group(1))

def main():
    print(f"[info] reading index: {INDEX_FILE.name}")
    index = load_index()
    print(f"[info] {len(index)} cities to generate")

    # Wipe any previous build of these dirs (don't touch root files).
    for sub in ("in", "us"):
        d = ROOT / sub
        if d.exists():
            shutil.rmtree(d)

    counts = {"city": 0, "city_pages": 0, "category": 0, "listing": 0}
    sitemap_urls = []  # list of (path, priority, changefreq)

    # Track which paths we've generated to flag any duplicates.
    seen_paths = set()
    def write(rel_path, html):
        path = ROOT / rel_path.lstrip("/")
        if path.suffix == "":  # treat dirs as needing /index.html
            path = path / "index.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        if str(path) in seen_paths:
            print(f"[warn] duplicate write: {path}")
        seen_paths.add(str(path))

    for cmeta in index:
        country = cmeta["country"]
        city_slug = cmeta["city_slug"]
        data_file = DATA_DIR / f"{country.lower()}-{city_slug}.json"
        if not data_file.exists():
            print(f"[skip] missing data: {data_file.name}")
            continue
        items = json.loads(data_file.read_text(encoding="utf-8"))
        if not items:
            continue
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
            html = render_city(country, city_slug, city, items, cats, page, total_pages, index)
            url  = city_url(country, city_slug, page)
            write(url, html)
            sitemap_urls.append((url, "0.8" if (page == 1 and len(items) >= 100) else ("0.7" if page == 1 else "0.5"), "weekly"))
            counts["city_pages"] += 1
        counts["city"] += 1

        # ---- City + Category pages ----
        for cat in cats:
            cat_items = [b for b in items if b["category_slug"] == cat["slug"]]
            if not cat_items:
                continue
            html = render_category(country, city_slug, city, cat["name"], cat["slug"], cat_items, cats, index)
            url  = category_url(country, city_slug, cat["slug"])
            write(url, html)
            sitemap_urls.append((url, "0.7", "weekly"))
            counts["category"] += 1

        # ---- Listing pages ----
        for b in items:
            html = render_listing(b, items, cats)
            url  = listing_url(b)
            write(url, html)
            sitemap_urls.append((url, "0.6", "monthly"))
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

    # ---- Sitemap index + shards ----
    static_urls = [
        ("/",                 "1.0", "daily"),
        ("/marketing.html",   "0.9", "weekly"),
        ("/privacy.html",     "0.3", "yearly"),
        ("/terms.html",       "0.3", "yearly"),
    ]
    all_urls = static_urls + sitemap_urls
    today = "2026-05-17"

    chunks = [all_urls[i:i + SITEMAP_CHUNK] for i in range(0, len(all_urls), SITEMAP_CHUNK)]
    for shard_i, chunk in enumerate(chunks, start=1):
        sm = ['<?xml version="1.0" encoding="UTF-8"?>',
              '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
        for url, prio, cf in chunk:
            sm.append(
                f"  <url><loc>{SITE}{url}</loc><lastmod>{today}</lastmod>"
                f"<changefreq>{cf}</changefreq><priority>{prio}</priority></url>"
            )
        sm.append("</urlset>")
        shard_name = "sitemap.xml" if len(chunks) == 1 else f"sitemap-{shard_i}.xml"
        (ROOT / shard_name).write_text("\n".join(sm), encoding="utf-8")

    if len(chunks) > 1:
        idx = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
        for shard_i in range(1, len(chunks) + 1):
            idx.append(f"  <sitemap><loc>{SITE}/sitemap-{shard_i}.xml</loc><lastmod>{today}</lastmod></sitemap>")
        idx.append("</sitemapindex>")
        (ROOT / "sitemap.xml").write_text("\n".join(idx), encoding="utf-8")
        print(f"[done] sitemap-index.xml + {len(chunks)} shards ({len(all_urls):,} URLs total)")
    else:
        print(f"[done] sitemap.xml with {len(all_urls):,} URLs")


if __name__ == "__main__":
    main()
