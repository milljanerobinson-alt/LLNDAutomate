#!/bin/bash
# WP Assist Product Platform STAGING — encrypted database backup + isolated restore check.
#
# Run on your Mac in Terminal:   bash ~/Downloads/wpa-staging-backup.sh
#
# What it does (and nothing else):
#   1. Creates an AES-256 encrypted disk image in ~/WP-Assist-Backups (not iCloud-synced).
#      macOS asks you for the image password in Terminal. Save it in your password manager.
#   2. Asks for the Staging "Session pooler" connection string and the database password.
#      Neither is printed, written to disk or sent anywhere except Supabase Staging.
#   3. Reads Staging only: table row counts, then a full pg_dump (custom format) into the image.
#   4. Records date, project ref, server version, pg_dump version and SHA-256 in MANIFEST.txt.
#   5. Restores into a throwaway local PostgreSQL container with NO network, compares row counts,
#      then deletes the container and its data.
#   6. Ejects the disk image and prints a summary with no credentials or table contents.
#
# Safety rails: refuses anything that is not the Staging project (bybccpuosrvgwujapasm) and
# refuses the Production project ref outright. It never writes to Supabase.
set -euo pipefail

STAGING_REF="bybccpuosrvgwujapasm"
PRODUCTION_REF="vcielymjoxwzcuhffjbi"
PG_IMAGE="postgres:17"
STAMP="$(date -u +%Y%m%dT%H%MZ)"
DIR="$HOME/WP-Assist-Backups"
IMG="$DIR/wpa-staging-${STAGING_REF}-${STAMP}.dmg"
VOLNAME="WPA-Staging-Backup-${STAMP}"
VOL="/Volumes/${VOLNAME}"
DUMP_NAME="wpa-staging-${STAGING_REF}-${STAMP}.dump"
RESTORE_CTR="wpa-restore-verify-${STAMP}"
say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  docker rm -f "$RESTORE_CTR" >/dev/null 2>&1 || true
  unset PGURL DBPASS RAW_URL
  if [ -d "$VOL" ]; then hdiutil detach "$VOL" -quiet >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

say "Step 0/6  Checking tools"
command -v hdiutil >/dev/null || fail "hdiutil not found (this must run on macOS)."
command -v docker >/dev/null || fail "Docker is not installed. Install/start Docker Desktop, then re-run."
docker info >/dev/null 2>&1 || fail "Docker Desktop is not running. Start it, wait for 'Engine running', then re-run."
command -v shasum >/dev/null || fail "shasum not found."
echo "Pulling ${PG_IMAGE} (PostgreSQL tools; from Docker Hub, no WP Assist data involved)..."
docker pull -q "$PG_IMAGE" >/dev/null
CLIENT_VER="$(docker run --rm "$PG_IMAGE" pg_dump --version)"
echo "OK: $CLIENT_VER"

say "Step 1/6  Creating the encrypted disk image"
mkdir -p "$DIR"; chmod 700 "$DIR"
[ -e "$IMG" ] && fail "$IMG already exists."
echo "macOS will now ask you to choose a password for the disk image (typing is hidden)."
echo "Use a strong new password and save it in your password manager BEFORE continuing."
hdiutil create -size 512m -fs APFS -encryption AES-256 -volname "$VOLNAME" "$IMG" >/dev/null
echo
echo "Now unlock it (same password). If macOS offers to remember it in the Keychain, decline."
hdiutil attach "$IMG" >/dev/null
[ -d "$VOL" ] || fail "The encrypted image did not mount at $VOL."
echo "OK: encrypted image mounted."

say "Step 2/6  Staging connection (nothing is displayed or stored)"
echo "In Supabase: WP Assist Product Platform Staging > Connect > Session pooler > copy the URI."
echo "Paste it here (it may still contain [YOUR-PASSWORD]; typing is hidden), then press Return:"
read -rs RAW_URL; echo
case "$RAW_URL" in *"$PRODUCTION_REF"*) fail "That is the PRODUCTION project. Nothing was done." ;; esac
case "$RAW_URL" in *"postgres.${STAGING_REF}"*) ;; *) fail "That connection string is not for the Staging project ($STAGING_REF)." ;; esac
case "$RAW_URL" in postgres://*|postgresql://*) ;; *) fail "That does not look like a postgres:// connection string." ;; esac
echo "Enter the Staging database password (hidden), then press Return:"
read -rs DBPASS; echo
[ -n "$DBPASS" ] || fail "No password entered."
ENC_PASS="$(printf '%s' "$DBPASS" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g')"
PGURL="${RAW_URL//\[YOUR-PASSWORD\]/$ENC_PASS}"
case "$PGURL" in *\?*) PGURL="${PGURL}&sslmode=require" ;; *) PGURL="${PGURL}?sslmode=require" ;; esac
export PGURL
unset DBPASS ENC_PASS RAW_URL

COUNT_SQL="BEGIN READ ONLY;
SELECT n.nspname||'.'||c.relname||'|'||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1;
COMMIT;"
export COUNT_SQL

say "Step 3/6  Reading Staging (read-only) and exporting"
SERVER_VER="$(docker run --rm -e PGURL "$PG_IMAGE" psql "$PGURL" -XAtqc 'show server_version')" \
  || fail "Could not connect. Check the connection string and password, then re-run (a new image will be created)."
DBNAME_CHECK="$(docker run --rm -e PGURL "$PG_IMAGE" psql "$PGURL" -XAtqc "select current_user")"
case "$DBNAME_CHECK" in *"$STAGING_REF"*|postgres) ;; *) fail "Unexpected database user; stopping." ;; esac
echo "Connected to Staging, PostgreSQL $SERVER_VER"
docker run --rm -e PGURL -e COUNT_SQL "$PG_IMAGE" sh -c 'printf "%s\n" "$COUNT_SQL" | psql "$PGURL" -XAtq -v ON_ERROR_STOP=1' > "$VOL/source-counts-before.txt"
DUMP_SCOPE="full database"
if ! docker run --rm -e PGURL -v "$VOL":/backup "$PG_IMAGE" \
     pg_dump "$PGURL" --format=custom --compress=9 --file="/backup/$DUMP_NAME" 2> "$VOL/pg_dump-full.log"; then
  echo "Full export hit a permission limit on a Supabase-managed schema; exporting application, Auth and Storage schemas instead."
  rm -f "$VOL/$DUMP_NAME"
  DUMP_SCOPE="schemas public, auth, storage"
  docker run --rm -e PGURL -v "$VOL":/backup "$PG_IMAGE" \
     pg_dump "$PGURL" --format=custom --compress=9 -n public -n auth -n storage --file="/backup/$DUMP_NAME" 2> "$VOL/pg_dump-scoped.log" \
     || fail "Export failed (see $VOL/pg_dump-scoped.log for the error; it contains no data)."
fi
docker run --rm -e PGURL -e COUNT_SQL "$PG_IMAGE" sh -c 'printf "%s\n" "$COUNT_SQL" | psql "$PGURL" -XAtq -v ON_ERROR_STOP=1' > "$VOL/source-counts-after.txt"
unset PGURL
[ -s "$VOL/$DUMP_NAME" ] || fail "Export file is empty."
SHA="$(cd "$VOL" && shasum -a 256 "$DUMP_NAME" | tee "$DUMP_NAME.sha256" | awk '{print $1}')"
SIZE="$(stat -f%z "$VOL/$DUMP_NAME")"
OBJECTS="$(docker run --rm -v "$VOL":/backup:ro "$PG_IMAGE" pg_restore --list "/backup/$DUMP_NAME" | grep -vc '^;')"
echo "OK: export written ($SIZE bytes, $OBJECTS archive entries)."

say "Step 4/6  Restoring into an isolated local database (no network)"
LOCALPW="$(head -c 48 /dev/urandom | shasum -a 256 | cut -c1-40)"
docker run -d --rm --name "$RESTORE_CTR" --network none -e POSTGRES_PASSWORD="$LOCALPW" \
  -v "$VOL":/backup:ro "$PG_IMAGE" >/dev/null
unset LOCALPW
for i in $(seq 1 60); do docker exec "$RESTORE_CTR" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
NETS="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$RESTORE_CTR")"
case "$NETS" in "none ") ;; *) fail "Restore container is not isolated (networks: $NETS)." ;; esac
docker exec "$RESTORE_CTR" psql -U postgres -XAtq -v ON_ERROR_STOP=1 -c "
  DO \$\$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','supabase_admin',
      'supabase_auth_admin','supabase_storage_admin','dashboard_user','supabase_read_only_user'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP; END \$\$;" >/dev/null
docker exec "$RESTORE_CTR" createdb -U postgres restore_verify
docker exec "$RESTORE_CTR" psql -U postgres -d restore_verify -XAtq -c "CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA extensions;" >/dev/null
set +e
docker exec "$RESTORE_CTR" pg_restore -U postgres -d restore_verify --no-owner --no-privileges -n public -n auth \
  "/backup/$DUMP_NAME" > /dev/null 2> "$VOL/restore-errors.log"
set -e
RESTORE_ERRORS="$(grep -c 'pg_restore: error' "$VOL/restore-errors.log" || true)"
docker exec -e COUNT_SQL="$COUNT_SQL" "$RESTORE_CTR" sh -c 'printf "%s\n" "$COUNT_SQL" | psql -U postgres -d restore_verify -XAtq' > "$VOL/restored-counts.txt"
docker rm -f "$RESTORE_CTR" >/dev/null
echo "OK: isolated restore finished; the container and its data have been deleted."

say "Step 5/6  Comparing row counts"
MATCH=0; DIFF=0; CHANGED=0; DIFFS=""
while IFS='|' read -r t before; do
  after="$(awk -F'|' -v t="$t" '$1==t{print $2}' "$VOL/source-counts-after.txt")"
  restored="$(awk -F'|' -v t="$t" '$1==t{print $2}' "$VOL/restored-counts.txt")"
  if [ "$before" != "$after" ]; then
    CHANGED=$((CHANGED+1))
    if [ -n "$restored" ] && [ "$restored" -ge "$before" ] && [ "$restored" -le "$after" ]; then MATCH=$((MATCH+1)); else DIFF=$((DIFF+1)); DIFFS="$DIFFS $t"; fi
  elif [ "$restored" = "$before" ]; then MATCH=$((MATCH+1)); else DIFF=$((DIFF+1)); DIFFS="$DIFFS $t"; fi
done < "$VOL/source-counts-before.txt"
TABLES="$(wc -l < "$VOL/source-counts-before.txt" | tr -d ' ')"
ROWS="$(awk -F'|' '{s+=$2} END {print s+0}' "$VOL/source-counts-before.txt")"
if [ "$DIFF" -eq 0 ] && [ "$TABLES" -gt 0 ]; then VERDICT="PASS"; else VERDICT="FAIL"; fi

say "Step 6/6  Writing MANIFEST.txt and ejecting"
cat > "$VOL/MANIFEST.txt" <<EOF
WP Assist Product Platform STAGING backup
Export date (UTC):        $STAMP
Project ref:              $STAGING_REF
Server version:           PostgreSQL $SERVER_VER
Export tool:              $CLIENT_VER (Docker image $PG_IMAGE)
Export scope:             $DUMP_SCOPE (custom format, compression 9)
File:                     $DUMP_NAME ($SIZE bytes, $OBJECTS archive entries)
SHA-256:                  $SHA
Restore check:            $VERDICT — isolated container (network none), schemas public + auth,
                          $TABLES tables, $MATCH matched, $DIFF mismatched, $CHANGED changed during export,
                          $RESTORE_ERRORS pg_restore errors (see restore-errors.log; no table contents)
Encryption:               macOS encrypted disk image, AES-256; password held in owner's password manager
EOF
chmod 600 "$VOL"/* 2>/dev/null || true
hdiutil detach "$VOL" -quiet
IMG_SHA="$(shasum -a 256 "$IMG" | awk '{print $1}')"

cat <<EOF

================ SUMMARY (safe to paste back to Claude) ================
Result:              $VERDICT
Encrypted image:     $IMG  (ejected)
Image SHA-256:       $IMG_SHA
Export date (UTC):   $STAMP
Project ref:         $STAGING_REF
Server version:      PostgreSQL $SERVER_VER
Export tool:         $CLIENT_VER
Export scope:        $DUMP_SCOPE
Dump SHA-256:        $SHA
Dump size:           $SIZE bytes, $OBJECTS archive entries
Restore check:       $TABLES tables, $ROWS source rows; $MATCH matched, $DIFF mismatched, $CHANGED changed during export
Mismatched tables:  ${DIFFS:- none}
pg_restore errors:   $RESTORE_ERRORS
========================================================================
Nothing in Supabase was changed. Production was not contacted.
EOF
