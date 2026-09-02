#!/bin/bash
# Pull the deploy branch and roll out whatever changed. Idempotent: exits
# early when the remote has not moved, so it is safe to run on a short timer.
#
# Rebuilds the API only when pets24x7_api/ changed, and re-renders the static
# site only when pets24x7_new/ changed, because a full page render is ~36k
# files and takes a couple of minutes.
set -euo pipefail

REPO=/opt/pets24x7/app
BRANCH=main
APP=$REPO/pets24x7_api
SITE_SRC=$REPO/pets24x7_new
SITE_LINK=/var/www/pets24x7          # symlink nginx serves from
RELEASES=/var/www/pets24x7-releases

# Everything touching the checkout runs as the app user, with nvm's node on PATH.
as_app() { su pets24x7 -c ". ~/.nvm/nvm.sh; cd $REPO && $*"; }

OLD=$(as_app 'git rev-parse HEAD')
as_app "git fetch -q origin $BRANCH"
NEW=$(as_app "git rev-parse origin/$BRANCH")

if [ "$OLD" = "$NEW" ]; then
  echo "up to date at ${OLD:0:7}"
  exit 0
fi

echo "deploying ${OLD:0:7} -> ${NEW:0:7}"
CHANGED=$(as_app "git diff --name-only $OLD $NEW")
as_app "git reset -q --hard origin/$BRANCH"

if grep -q '^pets24x7_api/' <<<"$CHANGED"; then
  echo "-- api changed, rebuilding"
  # The repo targets Postgres for local dev; this box runs MySQL.
  as_app "sed -i 's/provider = \"postgresql\"/provider = \"mysql\"/' pets24x7_api/prisma/schema.prisma"
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
  rm -rf "$REL"
  mkdir -p "$REL"
  rsync -a "$SITE_SRC/" "$REL/"
  ( cd "$REL" && python3 build_pages.py >/dev/null )
  chown -R www-data:www-data "$REL"
  find "$REL" -type d -exec chmod 755 {} +
  find "$REL" -type f -exec chmod 644 {} +

  ln -sfn "$REL" "$SITE_LINK.tmp" && mv -Tf "$SITE_LINK.tmp" "$SITE_LINK"
  curl -fsS -m 10 -o /dev/null -H 'Host: pets24x7.com' http://127.0.0.1/ || { echo "FAILED: site check"; exit 1; }
  echo "-- site ok ($(find "$REL" -type f | wc -l) files)"

  # Keep the current release plus one to roll back to.
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +3 | xargs -r rm -rf
fi

echo "deployed ${NEW:0:7}"
