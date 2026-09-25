"""
Strip the invented ratings that older builds of build_data.py baked into
data/*.json (and the PETS_FEATURED block of pets-data.js).

Those builds filled gaps in the scraped CSVs with made-up numbers:
  - rating 4.4 whenever the "Review" column had no "Rated X out of 5"
  - review_count = 18 + (digit_sum(cid) * 7919) % 462 whenever "Rating count"
    was empty (digit_sum of 0 counts as 31)
Both were published as "Rated 4.4/5 on Google from 237 reviews" and as
AggregateRating JSON-LD. The formula is deterministic, so a baked value can be
recognised exactly:
  - review_count equal to the formula for its CID  -> 0 (no count known)
  - rating 4.4 on such a row                        -> null (no rating known)
A rating other than 4.4 came from the source ("Rated 4.8 out of 5") and is
kept; with no count behind it every template hides it anyway. Rows are
otherwise untouched, so the output of a second run equals its input.

  python scripts/strip_synthetic_ratings.py            # dry run, prints counts
  python scripts/strip_synthetic_ratings.py --apply    # rewrite changed files
  python scripts/strip_synthetic_ratings.py --apply --no-index   # data/ only
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
INDEX_FILE = ROOT / "pets-data.js"

DEFAULT_RATING = 4.4


def synthetic_count(cid: str) -> int:
    """The exact count the old build_data.py derived from a CID."""
    seed = sum(int(ch) for ch in cid if ch.isdigit()) or 31
    return 18 + (seed * 7919) % 462


def strip_row(r: dict, stats: dict) -> bool:
    """Clear the invented values on one listing. True if it changed."""
    # Any CID, not only a numeric one: the old build summed the digits of a
    # spreadsheet-mangled "6.47E+18" too, so those rows carry the same fake.
    cid = str(r.get("google_cid") or "")
    if not cid:
        return False
    try:
        count = int(r.get("review_count") or 0)
    except (TypeError, ValueError):
        return False
    if count <= 0 or count != synthetic_count(cid):
        return False
    r["review_count"] = 0
    stats["count"] += 1
    if r.get("rating") == DEFAULT_RATING:
        r["rating"] = None
        stats["rating"] += 1
    else:
        stats["real_rating_kept"] += 1
    return True


def dump_like(original_text: str, value) -> str:
    """Re-serialise in the file's own layout: build_data.py writes compact
    JSON, the API writes imported_listings.json indented."""
    if original_text.lstrip().startswith("[\n") or "\n  " in original_text[:200]:
        return json.dumps(value, ensure_ascii=False, indent=2)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def process_data(apply: bool, stats: dict) -> None:
    for fp in sorted(DATA_DIR.glob("*.json")):
        text = fp.read_text(encoding="utf-8")
        try:
            rows = json.loads(text)
        except ValueError:
            print(f"[skip] {fp.name}: not JSON", file=sys.stderr)
            continue
        if not isinstance(rows, list):
            continue
        stats["files"] += 1
        stats["rows"] += len(rows)
        changed = sum(1 for r in rows if isinstance(r, dict) and strip_row(r, stats))
        if changed:
            stats["files_changed"] += 1
            if apply:
                fp.write_text(dump_like(text, rows), encoding="utf-8")


# Decoded as one JSON value after the "=", not matched up to the first "];":
# a featured business name can contain "];".
FEATURED_RE = re.compile(r"\bwindow\.PETS_FEATURED\s*=\s*")


def process_index(apply: bool, stats: dict) -> None:
    """pets-data.js carries full rows for the home page's featured strip. Its
    PETS_INDEX top_rating is read by no page, so only the featured rows are
    rewritten; the next build_data.py run recomputes the whole file."""
    if not INDEX_FILE.exists():
        return
    text = INDEX_FILE.read_text(encoding="utf-8")
    m = FEATURED_RE.search(text)
    if not m:
        print(f"[warn] {INDEX_FILE.name}: PETS_FEATURED not found", file=sys.stderr)
        return
    start = m.end()
    try:
        rows, end = json.JSONDecoder().raw_decode(text, start)
    except ValueError as err:
        print(f"[warn] {INDEX_FILE.name}: PETS_FEATURED is not valid JSON ({err})", file=sys.stderr)
        return
    if not isinstance(rows, list):
        print(f"[warn] {INDEX_FILE.name}: PETS_FEATURED is not a list", file=sys.stderr)
        return
    before = dict(stats)
    changed = sum(1 for r in rows if strip_row(r, stats))
    stats["featured_changed"] = changed
    # Featured rows are not listings on their own; keep them out of the totals.
    for k in ("count", "rating", "real_rating_kept"):
        stats[k] = before[k]
    if changed and apply:
        new = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
        INDEX_FILE.write_text(text[:start] + new + text[end:], encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--no-index", action="store_true", help="leave pets-data.js alone")
    args = ap.parse_args()

    stats = {"files": 0, "files_changed": 0, "rows": 0, "count": 0, "rating": 0,
             "real_rating_kept": 0, "featured_changed": 0}
    process_data(args.apply, stats)
    if not args.no_index:
        process_index(args.apply, stats)

    mode = "applied" if args.apply else "dry run (use --apply to write)"
    print(f"[{mode}]")
    print(f"  data files scanned:        {stats['files']:>7}  ({stats['rows']:,} rows)")
    print(f"  data files with changes:   {stats['files_changed']:>7}")
    print(f"  invented review counts -> 0:    {stats['count']:>7}")
    print(f"  default 4.4 ratings -> null:    {stats['rating']:>7}")
    print(f"  source ratings kept (count 0):  {stats['real_rating_kept']:>7}")
    if not args.no_index:
        print(f"  pets-data.js featured rows fixed: {stats['featured_changed']:>5}")


if __name__ == "__main__":
    main()
