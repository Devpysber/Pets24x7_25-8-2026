#!/bin/bash
# Publish the listings directory from MySQL to the static site.
#
#   export (DB -> data/*.json + pets-data.js) -> build_pages.py into a fresh
#   release (both as the app user) -> release handed to www-data -> sanity
#   checks -> atomic docroot symlink swap -> site check (rollback) -> prune.
#
# Started by:
#   pets24x7-publish.timer   nightly (03:30 IST + random delay)
#   pets24x7-publish.path    when the admin panel's "Publish site" writes the
#                            request file (POST /api/admin/publish)
#   pets24x7-deploy.sh       on every deploy that changes pets24x7_new/, so a
#                            git deploy and a DB publish build the same way and
#                            can never put different data live
#   by hand                  systemctl start pets24x7-publish.service
#                            (or run this script directly, as root)
#
# Options:
#   --force        publish even if the page count drops by more than
#                  PUBLISH_MAX_DROP_PCT (default 20) against the live release
#   --trigger X    label for the status file (timer|api|deploy|manual)
#   --tag T        suffix for the release directory name (deploy passes the rev)
#   --no-wait      exit 0 at once if another publish holds the lock
#                  (default: wait for it, so no request is ever dropped)
#   --no-export    build from the data/ committed in git instead of the DB.
#                  Emergency use only: it puts back whatever git holds,
#                  including listings hidden in the admin panel since.
#
# One run at a time: every run takes $LOCK. Runs never overlap, and a request
# that arrives during a run is picked up by the next one (the request file is
# consumed when a run starts, not when it ends).
set -Eeuo pipefail

REPO=/opt/pets24x7/app
APP=$REPO/pets24x7_api
SITE_SRC=$REPO/pets24x7_new
SITE_LINK=/var/www/pets24x7            # symlink nginx serves from
RELEASES=/var/www/pets24x7-releases
APP_USER=pets24x7
LOCK=/run/pets24x7-publish.lock
STATUS_FILE=${PUBLISH_STATUS_FILE:-/var/lib/pets24x7/publish-status.json}
REQUEST_FILE=${PUBLISH_TRIGGER_FILE:-/opt/pets24x7/run/publish.request}
KEEP_RELEASES=${PUBLISH_KEEP_RELEASES:-2}  # previous releases kept besides the live one
MAX_DROP_PCT=${PUBLISH_MAX_DROP_PCT:-20}
MIN_FREE_MB=${PUBLISH_MIN_FREE_MB:-2500}   # a rendered release is ~1 GB
LOCK_WAIT_SEC=${PUBLISH_LOCK_WAIT_SEC:-2400}

FORCE=""; TRIGGER=""; TAG="db"; WAIT=1; EXPORT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --trigger) TRIGGER=${2:?--trigger needs a value}; shift ;;
    --tag) TAG=${2:?--tag needs a value}; shift ;;
    --no-wait) WAIT="" ;;
    --no-export) EXPORT="" ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
# Only [A-Za-z0-9._-] in a directory name that ends up in rm -rf paths.
TAG=$(printf '%s' "$TAG" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-40)
TRIGGER=$(printf '%s' "${TRIGGER:-}" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-20)

# ---- privilege boundary -------------------------------------------------------
# This script runs as root, but everything under $REPO is owned and writable by
# $APP_USER — the user the API runs as. Code execution as the API must not turn
# into root through a publish, so:
#   * nothing from the checkout is executed, imported or even read as root: the
#     copy, the export and the render run as $APP_USER; root's own python3 runs
#     isolated (-I, cwd /) so a module planted next to it is never imported;
#   * the release is copied without owner or group (no setuid file can come
#     across), and handed back from $APP_USER to www-data by file descriptor,
#     never through a path that user could still swap for a link (step 4).
# All paths below are absolute; do not run from inside the checkout.
cd /

as_app() { su "$APP_USER" -c ". ~/.nvm/nvm.sh >/dev/null; $*"; }
log() { echo "[publish] $*"; }

# ---- status file (read by GET /api/admin/publish/status) -------------------
# Written through python3 so every value is JSON-escaped; the previous file's
# last-success fields are carried forward.
write_status() {
  local state=$1 message=${2:-}
  mkdir -p "$(dirname "$STATUS_FILE")"
  P_STATE=$state P_MSG=$message P_TRIGGER=${TRIGGER:-scheduled} P_STARTED=${STARTED:-} \
  P_RELEASE=${REL_NAME:-} P_PAGES=${NEW_PAGES:-} P_LISTINGS=${LISTINGS:-} P_CITIES=${CITIES:-} \
  python3 -I - "$STATUS_FILE" <<'PY'
import json, os, sys, tempfile, datetime
path = sys.argv[1]
try:
    prev = json.load(open(path, encoding="utf-8"))
except Exception:
    prev = {}
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
e = os.environ
num = lambda k: int(e[k]) if e.get(k, "").isdigit() else None
state = e["P_STATE"]
out = {
    "state": state,
    "trigger": e.get("P_TRIGGER") or None,
    "startedAt": e.get("P_STARTED") or now,
    "finishedAt": None if state == "running" else now,
    "release": e.get("P_RELEASE") or None,
    "pages": num("P_PAGES"),
    "listings": num("P_LISTINGS"),
    "cities": num("P_CITIES"),
    "message": (e.get("P_MSG") or "")[:1000] or None,
    "lastSuccessAt": prev.get("lastSuccessAt"),
    "lastSuccessRelease": prev.get("lastSuccessRelease"),
}
if state == "ok":
    out["lastSuccessAt"] = now
    out["lastSuccessRelease"] = out["release"]
d = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=d, prefix=".publish-status.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

# ---- single run --------------------------------------------------------------
exec 9>"$LOCK"
if [ -n "$WAIT" ]; then
  if ! flock -w "$LOCK_WAIT_SEC" 9; then
    log "FAILED: another publish held $LOCK for ${LOCK_WAIT_SEC}s"
    exit 1
  fi
elif ! flock -n 9; then
  log "another publish is running; nothing to do"
  exit 0
fi

# Consume the admin panel's request now, not at the end: one made while this
# run is building must start another run afterwards (pets24x7-publish.path
# fires again once this unit is inactive and the file exists).
if [ -e "$REQUEST_FILE" ]; then
  TRIGGER=${TRIGGER:-api}
  rm -f "$REQUEST_FILE"
fi
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REL_NAME="$(date +%Y%m%d-%H%M%S)-$TAG"
REL=$RELEASES/$REL_NAME
LIVE=$(readlink -f "$SITE_LINK" 2>/dev/null || true)
LOG=$(mktemp /tmp/pets24x7-publish.XXXXXX)
NEW_PAGES=""; LISTINGS=""; CITIES=""
write_status running "building $REL_NAME"
log "release $REL_NAME (trigger: ${TRIGGER:-scheduled})"

fail() {
  trap - ERR   # a failure in here must not re-enter fail()
  log "FAILED: $1"
  write_status failed "$1"
  # A half-built or rejected release is dead weight; never the live one.
  if [ -n "${REL:-}" ] && [ -d "$REL" ] && [ "$(readlink -f "$REL")" != "$(readlink -f "$SITE_LINK" 2>/dev/null)" ]; then
    rm -rf "$REL"
  fi
  rm -f "$LOG"
  exit 1
}
trap 'fail "unexpected error on line $LINENO (see journalctl -u pets24x7-publish)"' ERR

# ---- disk: prune BEFORE building ------------------------------------------------
# A rendered release is ~1 GB. Cleanup that only ran after a success let every
# failed build abandon a full release, leaving the next build less room than
# the last until the disk filled and every deploy failed. Keep the
# KEEP_RELEASES newest besides the live one; never touch what the symlink
# points at.
prune() {
  local live
  live=$(readlink -f "$SITE_LINK" 2>/dev/null || true)
  { ls -1dt "$RELEASES"/*/ 2>/dev/null || true; } | while read -r d; do
    d=${d%/}
    [ "$(readlink -f "$d")" = "$live" ] && continue
    [ "$d" = "$REL" ] && continue
    echo "$d"
  done | tail -n +"$((KEEP_RELEASES + 1))" | while read -r d; do rm -rf "$d"; done
}
mkdir -p "$RELEASES"
prune
FREE_MB=$(df -Pm "$RELEASES" | awk 'NR==2 {print $4}')
[ "$FREE_MB" -ge "$MIN_FREE_MB" ] || fail "${FREE_MB}MB free under $RELEASES; a release needs ~1GB"

# ---- 1. copy the site source ---------------------------------------------------
# The copy runs as the app user, into an empty directory handed to that user.
# Root must not read the checkout by path: the app user can swap any file in
# it for a symlink between rsync's lstat and its open, and root would copy
# /etc/shadow (or a TLS key) into a world-readable release. Nothing here ever
# needs root's reach: the export and the render write all over the release as
# the app user anyway, and step 4 takes it back.
# in/ and us/ are generated; __pycache__ is noise. data/imported_listings.json
# is the API's own JSON mirror of the listings table (STATIC_DATA_DIR points
# into this checkout): full records, including hidden rows and business email
# addresses, so it must never reach the docroot.
# -rlt, not -a: no owner, group or special files come across. Step 4 fixes
# every mode and fails the publish on any link.
mkdir "$REL"
chown "$APP_USER:" "$REL"
if ! runuser -u "$APP_USER" -- rsync -rlt --exclude '/in/' --exclude '/us/' --exclude '__pycache__/' \
    --exclude '/data/imported_listings.json' "$SITE_SRC/" "$REL/" >"$LOG" 2>&1 \
  || ! runuser -u "$APP_USER" -- mkdir -p "$REL/data" "$REL/media/listings" >>"$LOG" 2>&1; then
  tail -n 20 "$LOG"
  fail "could not copy $SITE_SRC into the release: $(tail -n 1 "$LOG")"
fi

# ---- 2. export the listings table ---------------------------------------------
if [ -n "$EXPORT" ]; then
  # As the app user: it owns node, Prisma and .env.
  if ! as_app "cd $APP && node scripts/export-listings-static.mjs --out '$REL/data' --index '$REL/pets-data.js' --media-dir '$REL/media/listings'" >"$LOG" 2>&1; then
    tail -n 20 "$LOG"
    fail "export from MySQL failed: $(grep -m1 'FAILED' "$LOG" || tail -n 1 "$LOG")"
  fi
  grep -v '^EXPORT_SUMMARY ' "$LOG" | grep -v 'read [0-9]* listings' || true
  SUMMARY=$(grep -m1 '^EXPORT_SUMMARY ' "$LOG" | cut -d' ' -f2- || true)
  [ -n "$SUMMARY" ] || fail "export printed no summary"
  LISTINGS=$(printf '%s' "$SUMMARY" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["listings"])')
  CITIES=$(printf '%s' "$SUMMARY" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["cities"])')
else
  log "--no-export: building from the data/ committed in git"
fi

# ---- 3. render -------------------------------------------------------------------
# As the app user: build_pages.py (and anything it imports) is the app user's
# file, and so is everything in the release it reads. runuser execs python3
# directly (no login shell), so this works whatever the user's shell is.
if ! ( cd "$REL" && runuser -u "$APP_USER" -- python3 build_pages.py --out "$REL" ) >"$LOG" 2>&1; then
  tail -n 20 "$LOG"
  fail "build_pages.py failed: $(tail -n 1 "$LOG")"
fi
tail -n 6 "$LOG"

# ---- 4. take the release back from the app user ----------------------------------
# The API keeps running as $APP_USER, and until now that user owned every
# directory in the release, so it could swap any entry for a symlink or hard
# link while root worked through it; chown/chmod by path would then hit the
# link's target (a chmod 644 of /etc/shadow, a chown of any file). So the
# tree is walked by file descriptor: each directory is opened O_NOFOLLOW,
# handed to www-data and made 755 BEFORE it is listed, so nothing inside can
# change after that; each regular file is opened O_NOFOLLOW, checked by fstat
# and fixed through the descriptor. Links are never followed. A symlink, FIFO,
# socket, device or hard-linked file has no business in a release (the site
# has none of its own, and nginx would follow a symlink to any file www-data
# can read) and fails the publish. After this nothing under $REL is writable
# by the app user, so the checks below see exactly what goes live.
if ! python3 -I - "$REL" "$APP_USER" >"$LOG" 2>&1 <<'PY'
import os, pwd, stat, sys

root, app = sys.argv[1], sys.argv[2]
www = pwd.getpwnam("www-data")
UID, GID = www.pw_uid, www.pw_gid
APP_UID = pwd.getpwnam(app).pw_uid
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC
bad, counts = [], {"dirs": 0, "files": 0}


def same(a, b):
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def fix_file(name, dfd, where, lst):
    fd = os.open(name, FILE_FLAGS, dir_fd=dfd)
    try:
        st = os.fstat(fd)
        # Every file here was copied in by root and chowned to the app user,
        # or written by the export/render: one link, owned by the app user.
        if not (stat.S_ISREG(st.st_mode) and same(st, lst) and st.st_nlink == 1 and st.st_uid == APP_UID):
            bad.append(where)
            return
        os.fchown(fd, UID, GID)
        os.fchmod(fd, 0o644)
        counts["files"] += 1
    finally:
        os.close(fd)


def walk(dfd, where):
    st = os.fstat(dfd)
    if st.st_uid != APP_UID and st.st_uid != 0:
        bad.append(where + "/")
        return
    # Lock first, list second.
    os.fchown(dfd, UID, GID)
    os.fchmod(dfd, 0o755)
    counts["dirs"] += 1
    for name in sorted(os.listdir(dfd)):
        path = where + "/" + name
        lst = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        if stat.S_ISDIR(lst.st_mode):
            cfd = os.open(name, DIR_FLAGS, dir_fd=dfd)
            try:
                if not same(os.fstat(cfd), lst):
                    bad.append(path + "/")
                    continue
                walk(cfd, path)
            finally:
                os.close(cfd)
        elif stat.S_ISLNK(lst.st_mode):
            # Never followed here; but nginx would follow it, serving any file
            # www-data can read. The site has no symlinks of its own.
            os.chown(name, UID, GID, dir_fd=dfd, follow_symlinks=False)
            bad.append(path + " -> " + os.readlink(name, dir_fd=dfd))
        elif stat.S_ISREG(lst.st_mode):
            fix_file(name, dfd, path, lst)
        else:
            bad.append(path)


top = os.open(root, DIR_FLAGS)
try:
    walk(top, root)
finally:
    os.close(top)
if bad:
    print("unexpected entries (only plain files and directories of the app user belong here):")
    for p in bad[:20]:
        print("  " + p)
    print("release has %d unexpected entries, e.g. %s" % (len(bad), bad[0]))
    sys.exit(1)
print("release handed to www-data: %(dirs)d directories, %(files)d files" % counts)
PY
then
  cat "$LOG"
  fail "could not take the release back from $APP_USER: $(tail -n 1 "$LOG")"
fi
cat "$LOG"

# ---- 5. sanity checks ------------------------------------------------------------
NEW_PAGES=$({ find "$REL/in" "$REL/us" -name index.html 2>/dev/null || true; } | wc -l)
[ "$NEW_PAGES" -gt 0 ] || fail "the build produced no pages"
[ -s "$REL/index.html" ] && [ -s "$REL/pets-data.js" ] || fail "index.html or pets-data.js missing from the release"
OLD_PAGES=0
if [ -n "$LIVE" ] && [ -d "$LIVE" ]; then
  OLD_PAGES=$({ find "$LIVE/in" "$LIVE/us" -name index.html 2>/dev/null || true; } | wc -l)
fi
if [ "$OLD_PAGES" -gt 0 ] && [ $((NEW_PAGES * 100)) -lt $((OLD_PAGES * (100 - MAX_DROP_PCT))) ]; then
  if [ -n "$FORCE" ]; then
    log "page count $OLD_PAGES -> $NEW_PAGES (more than ${MAX_DROP_PCT}% down), publishing anyway (--force)"
  else
    fail "page count would drop from $OLD_PAGES to $NEW_PAGES (more than ${MAX_DROP_PCT}%). Check the export; re-run with --force if intended."
  fi
fi
# Sitemap: the index parses, every child it names exists and parses, no child
# exceeds Google's 50k cap, every URL is on the site, and it lists city or
# listing pages at all. (A large drop is the page-count guard's job.)
if ! python3 -I - "$REL" >"$LOG" 2>&1 <<'PY'
import sys, os, xml.etree.ElementTree as ET
root = sys.argv[1]
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


def parse(name):
    path = os.path.join(root, name)
    # Root reads these: a plain file in the release, never a link out of it.
    assert os.path.isfile(path) and not os.path.islink(path), name + " is missing or not a plain file"
    return ET.parse(path).getroot()


idx = parse("sitemap.xml")
assert idx.tag == NS + "sitemapindex", "sitemap.xml is not a sitemap index"
children = [e.findtext(NS + "loc") for e in idx.findall(NS + "sitemap")]
assert children, "sitemap index lists no child sitemaps"
total = pages = 0
for loc in children:
    assert loc.startswith("https://pets24x7.com/"), "foreign child sitemap: " + loc
    name = loc.rsplit("/", 1)[1]
    doc = parse(name)
    locs = [u.findtext(NS + "loc") or "" for u in doc.findall(NS + "url")]
    assert len(locs) <= 50000, name + " exceeds 50,000 URLs"
    bad = [u for u in locs if not u.startswith("https://pets24x7.com/")]
    assert not bad, name + " has foreign URLs, e.g. " + bad[0]
    total += len(locs)
    pages += sum(1 for u in locs if u.startswith(("https://pets24x7.com/in/", "https://pets24x7.com/us/")))
assert pages, "sitemap lists no city or listing URLs"
print("sitemap ok: %d child files, %d URLs (%d city/listing)" % (len(children), total, pages))
PY
then
  cat "$LOG"
  fail "sitemap check failed: $(tail -n 1 "$LOG")"
fi
cat "$LOG"

# ---- 6. swap ---------------------------------------------------------------------
# From here $REL is (about to be) the live site: no failure path may delete it.
trap - ERR
# One-time migration. An early manual deploy made $SITE_LINK a real directory;
# `mv -T` of a symlink onto a non-empty directory fails ("Directory not
# empty"), which once pinned the site to its first deploy while every later
# render was built and thrown away. The old tree is kept alongside; delete it
# by hand to reclaim the space.
if [ -e "$SITE_LINK" ] && [ ! -L "$SITE_LINK" ]; then
  log "$SITE_LINK is a directory, not a release symlink; migrating"
  mv "$SITE_LINK" "$SITE_LINK.pre-releases.$(date +%Y%m%d%H%M%S)"
fi
if ! { ln -sfn "$REL" "$SITE_LINK.tmp" && mv -Tf "$SITE_LINK.tmp" "$SITE_LINK"; }; then
  write_status failed "could not swap $SITE_LINK to $REL_NAME; the previous release is still live"
  log "FAILED: symlink swap"
  rm -f "$LOG"
  exit 1
fi

# ---- 7. check the live site ------------------------------------------------------
# Through nginx's TLS vhost, with the public name resolved to this box. The
# old check asked port 80, which only answers with a 301 to https; curl -f
# counts a 3xx as success and does not follow it, so it passed without
# fetching anything and a broken release was never rolled back.
# The home page must answer, and one rendered city page and one city data file
# must come back byte-identical to the new release: a status code alone proves
# nothing under /in/ and /us/, where the listing fallback answers 200 for any
# URL, and the byte match shows nginx really serves the release just swapped in.
SITE_HOST=${PUBLISH_SITE_HOST:-pets24x7.com}
site_check() {
  local page data url tmp try
  local get=(curl -fsS -g -m 15 --resolve "$SITE_HOST:443:127.0.0.1")
  page=$(find "$REL/in" "$REL/us" -mindepth 2 -maxdepth 2 -type f -name index.html -print -quit 2>/dev/null || true)
  data=$(find "$REL/data" -maxdepth 1 -type f -regextype posix-extended -regex '.*/(in|us)-[a-z0-9-]+\.json' -print -quit 2>/dev/null || true)
  url=${page#"$REL"}
  url=${url%index.html}
  tmp=$(mktemp) || return 1
  for try in 1 2 3; do
    [ "$try" = 1 ] || sleep 3
    "${get[@]}" -o /dev/null "https://$SITE_HOST/" || continue
    if [ -n "$page" ]; then
      "${get[@]}" -o "$tmp" "https://$SITE_HOST$url" && cmp -s "$tmp" "$page" || continue
    fi
    if [ -n "$data" ]; then
      "${get[@]}" -o "$tmp" "https://$SITE_HOST/data/${data##*/}" && cmp -s "$tmp" "$data" || continue
    fi
    rm -f "$tmp"
    return 0
  done
  rm -f "$tmp"
  log "site check failed: https://$SITE_HOST/${page:+, $url}${data:+, /data/${data##*/}} (via 127.0.0.1)"
  return 1
}
if ! site_check; then
  if [ -n "$LIVE" ] && [ -d "$LIVE" ]; then
    ln -sfn "$LIVE" "$SITE_LINK.tmp" && mv -Tf "$SITE_LINK.tmp" "$SITE_LINK"
    [ "$(readlink -f "$SITE_LINK")" = "$(readlink -f "$LIVE")" ] && rm -rf "$REL"
    write_status failed "site check failed after the swap; rolled back to $(basename "$LIVE")"
    log "FAILED: site check after swap; rolled back to $LIVE"
  else
    write_status failed "site check failed after the swap (no previous release to roll back to)"
    log "FAILED: site check after swap"
  fi
  rm -f "$LOG"
  exit 1
fi

prune || true
rm -f "$LOG"
write_status ok "published $NEW_PAGES pages${LISTINGS:+ from $LISTINGS listings}"
log "live: $REL_NAME ($NEW_PAGES pages${LISTINGS:+, $LISTINGS listings in $CITIES cities})"
