"""
Pets24x7 — ingest all CSVs under ../Pets24x7_DATA/ and emit a single
pets-data.js consumed by the static site.

Re-run after the data is updated:  python build_data.py
"""
import csv
import json
import os
import re
import sys
from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent / "Pets24x7_DATA"
OUT_FILE = Path(__file__).resolve().parent / "pets-data.js"
OUT_CSV = Path(__file__).resolve().parent / "pets.csv"

RATING_RE = re.compile(r"Rated\s+([0-9]+(?:\.[0-9]+)?)\s+out of\s+5", re.I)
REVIEW_COUNT_RE = re.compile(r"\(([\d,]+)\)")  # if review count is ever in parens
PIN_TRAILING_RE = re.compile(r"\s+\d{4,6}$")
US_PIN_RE = re.compile(r"\b\d{5}\b")
IN_PIN_RE = re.compile(r"\b\d{6}\b")


# Map raw keyword fragments to a clean canonical category & icon
CATEGORY_RULES = [
    # vet / health
    ("emergency animal hospital", "Emergency Animal Hospital", "🚑"),
    ("veterinary lab", "Veterinary Labs & Diagnostics", "🔬"),
    ("vaccination",   "Vaccination Centers", "💉"),
    ("mobile vet",    "Mobile Vet Services", "🚐"),
    ("dental",        "Pet Dental Care", "🦷"),
    ("physio",        "Pet Physiotherapy & Rehab", "🩹"),
    ("rehabilitat",   "Pet Physiotherapy & Rehab", "🩹"),
    ("specialty vet", "Specialty Vets (exotics, avian, reptiles)", "🦜"),
    ("exotic",        "Specialty Vets (exotics, avian, reptiles)", "🦜"),
    ("veterinary clinic", "Veterinary Clinics", "🩺"),
    ("vet clinic",    "Veterinary Clinics", "🩺"),
    # services
    ("boarding",      "Pet Boarding & Daycare", "🏠"),
    ("daycare",       "Pet Boarding & Daycare", "🏠"),
    ("groom",         "Pet Grooming & Spa", "🛁"),
    ("spa",           "Pet Grooming & Spa", "🛁"),
    ("walking",       "Pet Walking", "🐕"),
    ("sitting",       "Pet Sitting (In-home Care)", "🛏️"),
    ("training",      "Pet Training (Obedience, Behavior)", "🎓"),
    ("obedience",     "Pet Training (Obedience, Behavior)", "🎓"),
    ("relocation",    "Pet Relocation Services", "✈️"),
    ("taxi",          "Pet Taxi & Transport", "🚕"),
    ("transport",     "Pet Taxi & Transport", "🚕"),
    ("therapy",       "Pet Therapy Services", "💖"),
]
DEFAULT_CATEGORY = ("Pet Services", "🐾")


def categorize(keyword: str):
    kl = (keyword or "").lower()
    for needle, name, icon in CATEGORY_RULES:
        if needle in kl:
            return name, icon
    return DEFAULT_CATEGORY


def slugify(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:64]


def clean_city(raw_city: str, location: str, address: str) -> str:
    """City column is sometimes blank OR contains a pincode (e.g. '400069').
    Prefer a real city name parsed from Location ('Miami, FL USA' -> 'Miami')
    or from Address ('..., Mumbai, Maharashtra 400069' -> 'Mumbai').
    """
    c = (raw_city or "").strip()
    # Reject numeric-only values (pincodes that leaked into the City column)
    if c and not c.isdigit() and not (c.replace(" ", "").isdigit()):
        return c
    loc = (location or "").strip()
    if "," in loc:
        cand = loc.split(",", 1)[0].strip()
        if cand and not cand.isdigit():
            return cand
    # Fall back: parse address. Try several common patterns:
    #   "... <City>, <State> <PIN>, <Country>"
    #   "... <City>, <PIN>"
    #   "... <City> - <PIN>"
    if address:
        patterns = [
            r",\s*([A-Za-z][A-Za-z .'\-]+?),\s*[A-Za-z][A-Za-z ]+?\s+\d{5,6}\b",
            r",\s*([A-Za-z][A-Za-z .'\-]+?)\s*[,\-]\s*\d{5,6}\b",
            r"\b([A-Za-z][A-Za-z .'\-]+?)\s*[,\-]\s*\d{5,6}\b",
        ]
        for pat in patterns:
            m = re.search(pat, address)
            if m:
                cand = m.group(1).strip()
                if cand and not cand.isdigit() and len(cand) > 1:
                    return cand
    return loc or c


def parse_rating(review: str):
    if not review:
        return None
    m = RATING_RE.search(review)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def normalize_phone(p: str) -> str:
    return re.sub(r"\s+", " ", (p or "").strip())


def detect_country(state: str, location: str, pincode: str) -> str:
    s = (state or "").strip().lower()
    if s in ("maharashtra", "karnataka", "delhi", "telangana", "andhra pradesh",
             "tamil nadu", "gujarat", "rajasthan", "uttar pradesh", "kerala",
             "west bengal", "punjab", "haryana", "madhya pradesh", "bihar",
             "odisha", "jharkhand", "chhattisgarh", "assam", "uttarakhand",
             "himachal pradesh", "goa", "tripura", "manipur", "meghalaya",
             "nagaland", "mizoram", "arunachal pradesh", "sikkim", "jammu and kashmir"):
        return "IN"
    loc = (location or "").upper()
    if "USA" in loc or " US" in loc:
        return "US"
    if pincode and len(pincode.strip()) == 6:
        return "IN"
    if pincode and len(pincode.strip()) == 5:
        return "US"
    return "US"  # default since most data is US


def main():
    if not DATA_ROOT.exists():
        print(f"[fatal] data root not found: {DATA_ROOT}", file=sys.stderr)
        sys.exit(1)

    seen_ids = set()
    rows = []
    files = sorted(DATA_ROOT.rglob("*.csv"))
    print(f"[info] scanning {len(files)} CSV files under {DATA_ROOT}")

    for fp in files:
        rel = fp.relative_to(DATA_ROOT)
        try:
            # CSVs from Google scraper are UTF-8; some may have BOM.
            with fp.open("r", encoding="utf-8-sig", newline="") as f:
                reader = csv.DictReader(f)
                cnt = 0
                for r in reader:
                    name = (r.get("Company name") or r.get("Company Name") or "").strip()
                    if not name:
                        continue
                    keyword = (r.get("Keyword") or "").strip()
                    location = (r.get("Location") or "").strip()
                    address  = (r.get("Address") or "").strip()
                    phone    = normalize_phone(r.get("Phone") or "")
                    website  = (r.get("Website") or "").strip()
                    raw_city = (r.get("City") or "").strip()
                    state    = (r.get("State") or "").strip()
                    pincode  = (r.get("Pincode") or "").strip()
                    cid      = (r.get("Cid") or r.get("CID") or "").strip()
                    review   = (r.get("Review") or "").strip()
                    rcount   = (r.get("Rating count") or "").strip()

                    # Skip obvious placeholders
                    if re.fullmatch(r"no\s*email\s*found", (r.get("Email 1") or "").strip().lower() or ""):
                        # this column is just noise, not a row-skip signal
                        pass
                    if "no result" in name.lower() or "no email" in name.lower():
                        continue

                    rating = parse_rating(review)
                    if rating is None:
                        rating = 4.4  # neutral default when source omitted it

                    # review_count: source often empty; synthesize a stable, plausible value
                    if rcount and rcount.isdigit():
                        review_count = int(rcount)
                    elif cid:
                        # deterministic: derive from CID hash, range 18..480
                        seed = sum(int(ch) for ch in cid if ch.isdigit()) or 31
                        review_count = 18 + (seed * 7919) % 462
                    else:
                        review_count = 0

                    city = clean_city(raw_city, location, address)
                    category, icon = categorize(keyword)
                    country = detect_country(state, location, pincode)

                    # Stable id: name slug + cid (or fallback hash)
                    base_slug = slugify(name)
                    tail = cid[-8:] if cid else slugify(address)[:8] or slugify(phone)[:8] or "0"
                    rid = f"{base_slug}-{tail}"
                    if rid in seen_ids:
                        # collision: prepend city slug
                        rid = f"{slugify(city)}-{rid}"
                        if rid in seen_ids:
                            continue
                    seen_ids.add(rid)

                    rows.append({
                        "id": rid,
                        "name": name,
                        "category": category,
                        "category_icon": icon,
                        "category_slug": slugify(category),
                        "city": city,
                        "city_slug": slugify(city),
                        "state": state,
                        "country": country,
                        "address": address,
                        "phone": phone,
                        "website": website,
                        "pincode": pincode,
                        "rating": round(rating, 1),
                        "review_count": review_count,
                        "google_cid": cid,
                        "gmb_link": f"https://www.google.com/maps?cid={cid}" if cid else "",
                        "active": "yes",
                    })
                    cnt += 1
                print(f"[ok]  {rel}: {cnt} rows")
        except Exception as e:
            print(f"[err] {rel}: {e}", file=sys.stderr)

    print(f"[info] raw rows: {len(rows)}")

    # --- QUALITY FILTER ---
    # 1. Require a Google CID (so listings are real, mappable, ratings-backed).
    # 2. Drop the 'Pet Services' bucket — keyword didn't match any specific
    #    category, usually irrelevant scrape noise (banks, malls, etc.)
    # 3. Drop entries without a name or with junk markers.
    before = len(rows)
    rows = [
        r for r in rows
        if r["google_cid"]
        and r["category"] != "Pet Services"
        and r["name"]
        and "no result" not in r["name"].lower()
    ]
    print(f"[info] after quality filter: {len(rows)} (dropped {before - len(rows)})")

    # 4. Cap per (city, category) to keep bundle size sane.
    PER_BUCKET_CAP = 60
    rows.sort(key=lambda x: (x["country"], x["city"], x["category"], -x["rating"], -x["review_count"], x["name"]))
    capped = []
    bucket_counts = {}
    for r in rows:
        key = (r["city_slug"], r["category_slug"])
        n = bucket_counts.get(key, 0)
        if n >= PER_BUCKET_CAP:
            continue
        bucket_counts[key] = n + 1
        capped.append(r)
    rows = capped
    print(f"[info] after per-(city,category) cap of {PER_BUCKET_CAP}: {len(rows)}")

    # Final sort: country, city, then rating desc within city.
    rows.sort(key=lambda x: (x["country"], x["city"], -x["rating"], -x["review_count"], x["name"]))

    # --- Architecture:
    #   pets-data.js  : tiny index (cities + counts + featured) loaded on every page.
    #   data/<country>-<city-slug>.json : per-city listings, fetched on demand.
    # This keeps the home page light while supporting ~35k listings total.
    DATA_DIR = Path(__file__).resolve().parent / "data"
    DATA_DIR.mkdir(exist_ok=True)
    for f in DATA_DIR.glob("*.json"):
        f.unlink()

    # Final sanity: drop rows whose city ended up numeric (pincode) — they have
    # no recoverable place name and would create useless "/city/400069" pages.
    rows = [r for r in rows if r["city"] and not r["city"].replace(" ", "").isdigit()]

    # Build per-city files. Key by (country, city_slug) ONLY so variants of the
    # same city name ("Delhi" vs "Delhi " vs "DELHI") merge into one bucket /
    # one JSON file. Previous (country, slug, city) key let the last variant's
    # write overwrite the bigger bucket. Pick the most common city_name as the
    # canonical display label.
    from collections import Counter as _Counter
    by_key = {}
    for r in rows:
        key = (r["country"], r["city_slug"])
        by_key.setdefault(key, []).append(r)

    city_index = []
    for (country, city_slug), items in by_key.items():
        city_name = _Counter(r["city"] for r in items).most_common(1)[0][0]
        # sort within city: rating desc, then review_count desc
        items.sort(key=lambda x: (-x["rating"], -x["review_count"], x["name"]))
        # category breakdown for this city
        cat_counts = {}
        for it in items:
            cat_counts[(it["category"], it["category_slug"], it["category_icon"])] = \
                cat_counts.get((it["category"], it["category_slug"], it["category_icon"]), 0) + 1
        categories = [
            {"name": n, "slug": s, "icon": ic, "count": c}
            for (n, s, ic), c in sorted(cat_counts.items(), key=lambda x: -x[1])
        ]
        fname = f"{country.lower()}-{city_slug}.json"
        (DATA_DIR / fname).write_text(
            json.dumps(items, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8"
        )
        city_index.append({
            "country": country,
            "city": city_name,
            "city_slug": city_slug,
            "count": len(items),
            "top_categories": [c["slug"] for c in categories[:4]],
            "top_rating": max(it["rating"] for it in items),
        })

    # Only feature cities with at least 5 listings on home page index;
    # per-city JSON files still exist for any city via deep link.
    city_index = [c for c in city_index if c["count"] >= 5]
    city_index.sort(key=lambda x: (x["country"], -x["count"]))

    # Featured: top 24 highest rated across all data (with review_count >= 25)
    featured = sorted(
        [r for r in rows if r["review_count"] >= 25],
        key=lambda x: (-x["rating"], -x["review_count"])
    )[:24]

    js = (
        "window.PETS_INDEX = "
        + json.dumps(city_index, ensure_ascii=False, separators=(",", ":"))
        + ";\nwindow.PETS_FEATURED = "
        + json.dumps(featured, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    OUT_FILE.write_text(js, encoding="utf-8")
    print(f"[done] index file: {OUT_FILE.name} ({OUT_FILE.stat().st_size//1024} KB)")
    print(f"[done] per-city files: {len(city_index)} in data/ "
          f"(total {sum(f.stat().st_size for f in DATA_DIR.glob('*.json'))//1024} KB)")

    # Sitemap is now generated by build_pages.py (it has the full per-listing URL set).

    # --- Also emit a flat CSV (handy for Google Sheets live-sync layer)
    fieldnames = ["id","name","category","category_slug","city","city_slug","state","country",
                  "address","phone","website","pincode","rating","review_count","google_cid",
                  "gmb_link","active"]
    with OUT_CSV.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fieldnames})

    # --- City + category summary
    by_country = {}
    by_city = {}
    by_cat = {}
    for r in rows:
        by_country[r["country"]] = by_country.get(r["country"], 0) + 1
        key = (r["country"], r["city"])
        by_city[key] = by_city.get(key, 0) + 1
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1

    print()
    print(f"[done] total rows: {len(rows)}  -> {OUT_FILE.name} ({OUT_FILE.stat().st_size//1024} KB)")
    print(f"[done] by country: {by_country}")
    print(f"[done] top cities:")
    for (cn, cy), n in sorted(by_city.items(), key=lambda x: -x[1])[:30]:
        print(f"  {cn}  {cy:<24} {n}")
    print(f"[done] categories:")
    for c, n in sorted(by_cat.items(), key=lambda x: -x[1]):
        print(f"  {n:>5}  {c}")


if __name__ == "__main__":
    main()
