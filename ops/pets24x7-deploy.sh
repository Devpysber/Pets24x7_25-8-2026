#!/bin/bash
# Pull the deploy branch and roll out whatever changed. Idempotent: exits
# early when the remote has not moved, so it is safe to run on a short timer.
#
# Rebuilds the API only when pets24x7_api/ changed, and re-renders the static
# site only when pets24x7_new/ changed, because a full page render is ~36k
# files and takes a couple of minutes.
set -Eeuo pipefail

REPO=/opt/pets24x7/app
BRANCH=main
# The revision we last deployed end to end. Deliberately NOT `git rev-parse
# HEAD`: the checkout is reset to origin before anything is built, so a build
# that fails afterwards still leaves HEAD at the new commit. Keying off HEAD
# meant the next run computed OLD == NEW, printed "up to date" and exited 0 —
# a failed deploy turned into a permanent silent skip. That is how the static
# site sat 22 commits behind for a week while every timer tick reported
# success. Only a run that reaches the end writes this file.
STATE=/var/lib/pets24x7/deployed-rev
# Set by a self-reinstall re-exec (see below) so the second run still sees the
# full set of changed files rather than concluding it is already up to date.
FROM_OVERRIDE=""
if [ "${1:-}" = "--from" ] && [ -n "${2:-}" ]; then FROM_OVERRIDE="$2"; fi
APP=$REPO/pets24x7_api
SITE_SRC=$REPO/pets24x7_new
SITE_LINK=/var/www/pets24x7          # symlink nginx serves from
RELEASES=/var/www/pets24x7-releases

# Everything touching the checkout runs as the app user, with nvm's node on PATH.
as_app() { su pets24x7 -c ". ~/.nvm/nvm.sh; cd $REPO && $*"; }

# --from is handed over by a re-exec from the previous copy of this script,
# which derived it from HEAD. Without recorded state that is precisely the
# value that cannot be trusted, so drop it and fall through to a full deploy.
if [ -n "$FROM_OVERRIDE" ] && [ ! -f "$STATE" ]; then
  echo "ignoring --from ${FROM_OVERRIDE:0:7}: no recorded state, so HEAD is not evidence of what is deployed"
  FROM_OVERRIDE=""
fi

OLD=${FROM_OVERRIDE:-$(cat "$STATE" 2>/dev/null || true)}
# No state file means we genuinely do not know what is on this box, and the old
# fallback -- git rev-parse HEAD -- was wrong exactly when it mattered: the
# checkout is reset to origin before anything is built, so after a failed build
# HEAD names a revision that was never deployed. Believing it is what left the
# static site 22 commits behind while every run reported success. Deploy
# everything instead. It costs one full render (~2 min) and converges the box.
FULL=""
if [ -z "$OLD" ]; then
  echo "no deploy state recorded -- treating this as a full deploy"
  FULL=1
fi

as_app "git fetch -q origin $BRANCH"
NEW=$(as_app "git rev-parse origin/$BRANCH")

# Reinstall BEFORE the up-to-date check, not after. This script runs from
# /usr/local/bin, which is a COPY: with the check first, a box already sitting
# at origin/$BRANCH exited "up to date" before ever reaching the reinstall, so
# a fix to this file could never deploy itself — the stale copy kept deciding
# there was nothing to do. Compare against origin rather than the working tree,
# so a run that died before the reset still sees the authoritative version.
SELF=/usr/local/bin/pets24x7-deploy.sh
if ! as_app "git show origin/$BRANCH:ops/pets24x7-deploy.sh" | cmp -s - "$SELF"; then
  echo "-- deploy script changed, reinstalling and re-running"
  as_app "git show origin/$BRANCH:ops/pets24x7-deploy.sh" > "$SELF.new"
  chmod 700 "$SELF.new"
  mv -f "$SELF.new" "$SELF"
  # Re-exec into the new copy. Hand over --from only when it is trustworthy;
  # the new copy decides for itself what to do when it is not.
  REEXEC=()
  if [ -n "$FROM_OVERRIDE" ]; then REEXEC=(--from "$FROM_OVERRIDE"); fi
  exec "$SELF" ${REEXEC[@]+"${REEXEC[@]}"}
fi

if [ -z "$FULL" ] && [ "$OLD" = "$NEW" ]; then
  echo "up to date at ${OLD:0:7}"
  exit 0
fi

if [ -n "$FULL" ]; then
  # Every tracked path, so each `grep -q` below matches and every stage runs.
  CHANGED=$(as_app "git ls-tree -r --name-only $NEW")
  echo "deploying everything at ${NEW:0:7}"
else
  CHANGED=$(as_app "git diff --name-only $OLD $NEW")
  echo "deploying ${OLD:0:7} -> ${NEW:0:7}"
fi
as_app "git reset -q --hard origin/$BRANCH"

# Units and nginx config are copies too. They need a reload rather than a
# re-exec, and nginx is only reloaded when its own config actually parses.
if grep -q '^ops/.*\.\(service\|timer\)$' <<<"$CHANGED"; then
  echo "-- systemd units changed, reinstalling"
  install -m 644 "$REPO"/ops/*.service "$REPO"/ops/*.timer /etc/systemd/system/
  systemctl daemon-reload
fi
# nginx configs are deliberately NOT auto-installed. The api vhost is
# certbot-managed: certbot rewrites its listen-443 and certificate lines on
# every renewal, so the repo copy is always behind and installing it would
# revert TLS config and break HTTPS. Say something instead, and let a human
# copy the parts that actually changed.
if grep -q '^ops/nginx-' <<<"$CHANGED"; then
  echo "!! nginx config changed in the repo — NOT installed automatically."
  echo "!! Review and copy by hand; see ops/README.md for the target paths."
fi

if grep -q '^pets24x7_api/' <<<"$CHANGED"; then
  echo "-- api changed, rebuilding"
  # Preflight, before anything is rebuilt or restarted. The API refuses to boot
  # in production without a mail relay, because a no-op relay silently drops
  # verification links, receipts and invoices while still answering 200. Catch a
  # missing credential here, where the running service is untouched, rather than
  # at the restart, where it would leave the site down.
  if ! grep -qE '^SMTP_USER=.+' "$APP/.env" || ! grep -qE '^SMTP_PASS=.+' "$APP/.env"; then
    echo "FAILED: SMTP_USER / SMTP_PASS are missing from $APP/.env"
    echo "        The API will not start in production without them. Nothing was changed."
    exit 1
  fi
  # The repo targets Postgres for local dev; this box runs MySQL.
  as_app "sed -i 's/provider = \"postgresql\"/provider = \"mysql\"/' pets24x7_api/prisma/schema.prisma"
  # Prisma maps @db.Text to MySQL TEXT, which caps at 64KB. Pet.avatarUrl and
  # Vendor.imageUrl hold resized photos as data URLs and the API accepts up to
  # 600KB, so on TEXT they fail the insert and the dashboard reports a bare
  # "internal_error". Postgres text has no such limit, which is why this only
  # ever bit production. LONGTEXT is stored off-page exactly like TEXT.
  as_app "sed -i 's/@db.Text/@db.LongText/g' pets24x7_api/prisma/schema.prisma"
  as_app "cd pets24x7_api && npm ci --silent"
  as_app "cd pets24x7_api && npx prisma generate"
  as_app "cd pets24x7_api && npx prisma db push --skip-generate"
  # Membership plans are reference data, not user data: without this the
  # /membership/ page renders an empty grid on a fresh or re-pushed DB. The
  # seed upserts by sku, so re-running it on every deploy is a no-op.
  as_app "cd pets24x7_api && npm run seed:plans"
  as_app "cd pets24x7_api && npm run build"
  systemctl restart pets24x7-api
  sleep 3
  systemctl is-active --quiet pets24x7-api || { echo "FAILED: api did not come back"; exit 1; }
  curl -fsS -m 10 -o /dev/null http://127.0.0.1:4100/health || { echo "FAILED: health check"; exit 1; }
  echo "-- api ok"
fi

if grep -q '^pets24x7_new/' <<<"$CHANGED"; then
  echo "-- site changed, building release ${NEW:0:7}"
  # Build into a fresh release directory and swap the symlink, so the live
  # site never serves a half-rendered tree. Rendering in place would 404
  # every city URL for the couple of minutes build_pages.py takes.
  REL=$RELEASES/${NEW:0:7}

  # Prune BEFORE building, not after. A rendered release is ~950 MB, and the
  # cleanup used to sit on the last line of the block: it only ran when
  # everything succeeded, so every failed deploy abandoned a full release on
  # disk and left the next build with less room than the last. One failure
  # snowballs into a full disk that then fails every deploy after it.
  # Keep the two newest, and never delete whatever the symlink points at.
  LIVE=$(readlink -f "$SITE_LINK" 2>/dev/null || true)
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +3 | while read -r d; do
    if [ "$(readlink -f "$d")" != "$LIVE" ]; then rm -rf "$d"; fi
  done

  # Die with a legible message rather than halfway through a 36k-file render
  # with a bare ENOSPC.
  FREE_MB=$(df -Pm "$RELEASES" | awk 'NR==2 {print $4}')
  if [ "$FREE_MB" -lt 2500 ]; then
    echo "FAILED: ${FREE_MB}MB free under $RELEASES; a release needs ~950MB"
    df -h "$RELEASES"
    exit 1
  fi

  # A half-built release is dead weight. Drop it if any step below fails, so a
  # failure costs nothing on disk and the next run starts clean.
  trap 'rm -rf "$REL"' ERR
  rm -rf "$REL"
  mkdir -p "$REL"
  rsync -a "$SITE_SRC/" "$REL/"
  ( cd "$REL" && python3 build_pages.py >/dev/null )
  chown -R www-data:www-data "$REL"
  find "$REL" -type d -exec chmod 755 {} +
  find "$REL" -type f -exec chmod 644 {} +

  # Clear the cleanup trap BEFORE the swap: past this line $REL is the live
  # site, and a trap that deletes it would take the site down with it.
  trap - ERR
  # One-time migration. DEPLOY.md builds $SITE_LINK as a real directory
  # (mkdir -p, untar into it, render in place); this script has always assumed
  # it is a symlink into $RELEASES. `mv -T` a symlink onto a non-empty
  # directory fails with "Directory not empty", so the swap below failed on
  # every single run -- after rendering the whole ~950MB release -- and the
  # directory from the original manual deploy kept serving. That is why the
  # site stayed on its first-deploy content while the API updated normally.
  if [ -e "$SITE_LINK" ] && [ ! -L "$SITE_LINK" ]; then
    echo "-- $SITE_LINK is a directory, not a release symlink; migrating"
    mv "$SITE_LINK" "$SITE_LINK.pre-releases.$(date +%Y%m%d%H%M%S)"
    echo "-- previous tree kept alongside it; delete it by hand to reclaim the space"
  fi
  ln -sfn "$REL" "$SITE_LINK.tmp" && mv -Tf "$SITE_LINK.tmp" "$SITE_LINK"
  curl -fsS -m 10 -o /dev/null -H 'Host: pets24x7.com' http://127.0.0.1/ || { echo "FAILED: site check"; exit 1; }
  echo "-- site ok ($(find "$REL" -type f | wc -l) files)"
fi

mkdir -p "$(dirname "$STATE")"
printf '%s
' "$NEW" > "$STATE"
echo "deployed ${NEW:0:7}"
