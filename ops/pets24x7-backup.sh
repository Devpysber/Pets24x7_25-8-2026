#!/bin/bash
# Nightly mysqldump of the pets24x7 database. Keeps 14 days.
set -euo pipefail

DEST=/var/backups/pets24x7
STAMP=$(date +%F)
mkdir -p "$DEST"

# Credentials come from the API's own .env so there is one place to rotate them.
DB_URL=$(grep -m1 '^DATABASE_URL=' /opt/pets24x7/app/pets24x7_api/.env | cut -d= -f2- | tr -d '"')
DB_USER=$(printf '%s' "$DB_URL" | sed -E 's|^mysql://([^:]+):.*|\1|')
DB_PASS=$(printf '%s' "$DB_URL" | sed -E 's|^mysql://[^:]+:([^@]+)@.*|\1|')
DB_NAME=$(printf '%s' "$DB_URL" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')

MYSQL_PWD="$DB_PASS" mysqldump \
  --user="$DB_USER" \
  --single-transaction --quick --routines --triggers --no-tablespaces \
  "$DB_NAME" | gzip -9 > "$DEST/pets24x7-$STAMP.sql.gz"

chmod 600 "$DEST/pets24x7-$STAMP.sql.gz"
find "$DEST" -name 'pets24x7-*.sql.gz' -mtime +14 -delete
