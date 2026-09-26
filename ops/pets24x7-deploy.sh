#!/bin/bash
# Pull the deploy branch and roll out whatever changed. Idempotent: exits
# early when the remote has not moved, so it is safe to run on a short timer.
#
# Rebuilds the API only when pets24x7_api/ changed, and re-renders the static
# site only when pets24x7_new/ changed, because a full page render is ~40k
# files and takes a few minutes. The render itself is pets24x7-publish.sh — the
# same script the nightly timer and the admin "Publish site" button run — so
# every release is built from the listings table the same way, and a git
# deploy can never put back data that was hidden or edited in the admin panel.
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
if grep -q '^ops/.*\.\(service\|timer\|path\)$' <<<"$CHANGED"; then
  echo "-- systemd units changed, reinstalling"
  install -m 644 "$REPO"/ops/*.service "$REPO"/ops/*.timer "$REPO"/ops/*.path /etc/systemd/system/
  systemctl daemon-reload
fi
# The publish script is a copy as well, and the site stage below runs it.
# Compared on every run (not only when it changed in this diff), so a box that
# missed an update converges.
PUBLISH=/usr/local/bin/pets24x7-publish.sh
if ! cmp -s "$REPO/ops/pets24x7-publish.sh" "$PUBLISH"; then
  echo "-- publish script changed, reinstalling"
  install -m 700 "$REPO/ops/pets24x7-publish.sh" "$PUBLISH"
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
  # A value, not just the key: SMTP_PASS="" (the .env.example style) passed
  # '.+' on its quotes and the API then refused to start anyway.
  if ! grep -qE "^SMTP_USER=[\"']?[^\"'[:space:]]" "$APP/.env" || ! grep -qE "^SMTP_PASS=[\"']?[^\"'[:space:]]" "$APP/.env"; then
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
  # The API loads the whole listing index before it listens, which takes a few
  # seconds; give it up to a minute instead of failing a good deploy.
  api_ok=""
  for _ in $(seq 1 30); do
    sleep 2
    systemctl is-active --quiet pets24x7-api || { echo "FAILED: api did not come back"; exit 1; }
    if curl -fsS -m 5 -o /dev/null http://127.0.0.1:4100/health; then api_ok=1; break; fi
  done
  [ -n "$api_ok" ] || { echo "FAILED: health check"; exit 1; }
  echo "-- api ok"
fi

if grep -q '^pets24x7_new/' <<<"$CHANGED"; then
  echo "-- site changed, publishing release ${NEW:0:7}"
  # Export the listings table, render into a fresh release, check it, swap the
  # docroot symlink, prune old releases -- see ops/pets24x7-publish.sh. It
  # waits for a publish already in progress (nightly or admin-triggered)
  # instead of racing it, and exits non-zero on any failure, which fails this
  # deploy before the state file is written, so the next run retries.
  "$PUBLISH" --trigger deploy --tag "${NEW:0:7}"
fi

mkdir -p "$(dirname "$STATE")"
printf '%s
' "$NEW" > "$STATE"
echo "deployed ${NEW:0:7}"
