#!/bin/bash
# WP Assist Product Platform STAGING: encrypted database backup + isolated restore verification.
# Version 2 (2026-11-03)
#
# Run on your Mac in Terminal:   bash ~/Downloads/wpa-staging-backup.sh
#
# Final result is exactly one of:
#   VERIFIED  full export; every table is in the backup; isolated restore matched; no material errors
#   PARTIAL   only some schemas could be exported; NOT a complete backup
#   FAILED    export or verification failed; the encrypted image is kept for investigation
# Exit codes: 0 = VERIFIED, 2 = PARTIAL, 1 = FAILED or stopped.
#
# Safety:
# - Connects only to Supabase Staging (user postgres.bybccpuosrvgwujapasm on *.pooler.supabase.com).
#   Anything mentioning the Production ref is refused before any connection is made.
# - Never writes to Supabase. Every query runs in a READ ONLY transaction; pg_dump reads in a
#   read-only snapshot.
# - The database password lives only in a private temporary pgpass file (mode 600) that is deleted on
#   exit. It is never in a command line, a URL, a Docker environment variable, the backup or the log.
# - The restore check runs in a container with no network, which is deleted afterwards.
set -euo pipefail

STAGING_REF="bybccpuosrvgwujapasm"
PRODUCTION_REF="vcielymjoxwzcuhffjbi"
EXPECTED_USER="postgres.${STAGING_REF}"
EXPECTED_HOST_SUFFIX=".pooler.supabase.com"
PG_IMAGE="postgres:17"
# Tables that must be present in any acceptable backup of the WP Assist Product Platform.
REQUIRED_TABLES="public.admin_profiles public.audit_log public.customers public.installations public.licences public.releases public.subscriptions auth.users auth.identities auth.mfa_factors"
# pg_restore messages that are documented as harmless in this verification setup. The verifier creates
# the auth and extensions schemas itself before restoring, so "already exists" for them is expected.
HARMLESS_RESTORE_ERRORS='schema "(auth|extensions)" already exists'

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="$HOME/WP-Assist-Backups"
IMG="$DIR/wpa-staging-${STAGING_REF}-${STAMP}.dmg"
VOLNAME="WPA-Staging-Backup-${STAMP}"
DUMP_NAME="wpa-staging-${STAGING_REF}-${STAMP}.dump"
RESTORE_CTR="wpa-restore-verify-${STAMP}"

VOL=""; SECRET_DIR=""; STATUS="FAILED"; REASON="stopped before completion"
EXPORT_SCOPE="none"; SERVER_VER="unknown"; CLIENT_VER="unknown"; SHA="n/a"; SIZE="n/a"
TOC_ENTRIES="n/a"; COVERAGE="not checked"; REQUIRED="not checked"; RESTORE="not run"
RESTORE_MATERIAL="n/a"; RESTORE_HARMLESS="n/a"; COUNTS="not compared"; MISMATCHED=""; EXCLUDED_SCHEMAS=""
FINISHED=0

say()  { printf '\n== %s\n' "$*"; }
stop() { REASON="$*"; printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# psql/pg_dump/pg_restore against Staging, inside Docker. Only non-secret settings are passed in the
# environment; the password comes from the mounted pgpass file.
pg_remote() {
  docker run --rm -i \
    -e PGPASSFILE=/run/wpa-secret/pgpass -e PGSSLMODE=require -e PGCONNECT_TIMEOUT=20 \
    -e PGHOST="$DB_HOST" -e PGPORT="$DB_PORT" -e PGUSER="$DB_USER" -e PGDATABASE="$DB_NAME" \
    -e PGAPPNAME=wpa-staging-backup \
    -v "$SECRET_DIR":/run/wpa-secret:ro ${VOL:+-v "$VOL":/backup} \
    "$PG_IMAGE" "$@"
}
ro_query() {  # one read-only transaction, unaligned output
  printf 'BEGIN READ ONLY;\n%s\nCOMMIT;\n' "$1" | pg_remote psql -XAtq -v ON_ERROR_STOP=1
}

write_manifest() {
  [ -n "$VOL" ] && [ -d "$VOL" ] || return 0
  cat > "$VOL/MANIFEST.txt" <<EOF
WP Assist Product Platform STAGING backup
RESULT:                   $STATUS
Reason:                   $REASON
Export date (UTC):        $STAMP
Project ref:              $STAGING_REF
Server version:           PostgreSQL $SERVER_VER
Export tool:              $CLIENT_VER (Docker image $PG_IMAGE)
Export scope:             $EXPORT_SCOPE
Schemas NOT in backup:    ${EXCLUDED_SCHEMAS:-none}
File:                     $DUMP_NAME ($SIZE bytes, $TOC_ENTRIES archive entries)
SHA-256:                  $SHA
Table coverage:           $COVERAGE
Required tables:          $REQUIRED
Isolated restore:         $RESTORE
Restore errors:           material=$RESTORE_MATERIAL harmless=$RESTORE_HARMLESS (restore-errors.log)
Row counts:               $COUNTS
Mismatched tables:        ${MISMATCHED:-none}
Encryption:               macOS encrypted disk image, AES-256; password held in owner's password manager
EOF
  chmod 600 "$VOL/MANIFEST.txt" 2>/dev/null || true
}

finish() {
  local code=$?
  [ "$FINISHED" -eq 1 ] && return
  FINISHED=1
  set +e
  docker rm -f -v "$RESTORE_CTR" >/dev/null 2>&1
  if [ -n "$SECRET_DIR" ] && [ -d "$SECRET_DIR" ]; then rm -f "$SECRET_DIR"/pgpass "$SECRET_DIR"/*.err; rmdir "$SECRET_DIR"; fi
  unset DBPASS RAW_URL
  if [ "$STATUS" != "VERIFIED" ] && [ "$STATUS" != "PARTIAL" ]; then STATUS="FAILED"; fi
  write_manifest
  local ejected="not mounted"
  if [ -n "$VOL" ] && [ -d "$VOL" ]; then
    ejected="FAILED to eject (eject it in Finder)"
    for i in 1 2 3 4 5; do
      if hdiutil detach "$VOL" -quiet >/dev/null 2>&1; then ejected="ejected"; break; fi
      sleep 3
    done
  fi
  local img_sha="n/a"
  [ -f "$IMG" ] && img_sha="$(shasum -a 256 "$IMG" | awk '{print $1}')"
  [ -f "$IMG" ] || IMG="(not created)"
  cat <<EOF

================ SUMMARY (safe to paste back to Claude) ================
RESULT:              $STATUS
Reason:              $REASON
Encrypted image:     $IMG ($ejected)
Image SHA-256:       $img_sha
Export date (UTC):   $STAMP
Project ref:         $STAGING_REF
Server version:      PostgreSQL $SERVER_VER
Export tool:         $CLIENT_VER
Export scope:        $EXPORT_SCOPE
Schemas not in backup: ${EXCLUDED_SCHEMAS:-none}
Dump SHA-256:        $SHA
Dump size:           $SIZE bytes, $TOC_ENTRIES archive entries
Table coverage:      $COVERAGE
Required tables:     $REQUIRED
Isolated restore:    $RESTORE
Restore errors:      material=$RESTORE_MATERIAL harmless=$RESTORE_HARMLESS
Row counts:          $COUNTS
Mismatched tables:   ${MISMATCHED:-none}
========================================================================
Supabase was only read. Production was not contacted.
EOF
  if [ "$STATUS" = "VERIFIED" ]; then exit 0; elif [ "$STATUS" = "PARTIAL" ]; then exit 2; else exit 1; fi
}
trap finish EXIT
trap 'REASON="interrupted"; exit 1' INT TERM

say "Step 0/7  Checking tools"
command -v hdiutil >/dev/null || stop "hdiutil not found (this must run on macOS)."
command -v docker  >/dev/null || stop "Docker is not installed."
docker info >/dev/null 2>&1   || stop "Docker Desktop is not running. Start it, wait for 'Engine running', then re-run."
command -v shasum  >/dev/null || stop "shasum not found."
echo "Pulling ${PG_IMAGE} (PostgreSQL tools from Docker Hub; no WP Assist data involved)..."
docker pull -q "$PG_IMAGE" >/dev/null || stop "Could not download the PostgreSQL tools image."
CLIENT_VER="$(docker run --rm "$PG_IMAGE" pg_dump --version)"
echo "OK: $CLIENT_VER"

say "Step 1/7  Staging connection details (nothing is displayed, stored or sent until checked)"
echo "In Supabase: WP Assist Product Platform Staging > Connect > Session pooler > copy the URI."
echo "Paste it here (it may contain [YOUR-PASSWORD]; any password in it is ignored), then press Return:"
read -rs RAW_URL; echo
case "$RAW_URL" in *"$PRODUCTION_REF"*) RAW_URL=""; stop "That is the PRODUCTION project. Nothing was done." ;; esac
URI_RE='^postgres(ql)?://([^:@/]+)(:[^@]*)?@([^:/?@]+)(:([0-9]+))?/([^?]+)(\?.*)?$'
[[ "$RAW_URL" =~ $URI_RE ]] || { RAW_URL=""; stop "That does not look like a Supabase postgres:// connection string."; }
DB_USER="${BASH_REMATCH[2]}"; DB_HOST="${BASH_REMATCH[4]}"; DB_PORT="${BASH_REMATCH[6]:-5432}"; DB_NAME="${BASH_REMATCH[7]}"
RAW_URL=""
[ "$DB_USER" = "$EXPECTED_USER" ] || stop "The connection string is not for WP Assist Staging (expected user $EXPECTED_USER)."
case "$DB_HOST" in *"$EXPECTED_HOST_SUFFIX") ;; *) stop "Unexpected host; expected a Supabase session pooler (*${EXPECTED_HOST_SUFFIX})." ;; esac
[ "$DB_NAME" = "postgres" ] || stop "Unexpected database name."
case "$DB_PORT" in 5432) ;; 6543) stop "That is the transaction pooler (port 6543). Copy the Session pooler string instead." ;; *) stop "Unexpected port $DB_PORT." ;; esac
echo "OK: Staging session pooler, user $DB_USER."
echo "Enter the Staging database password (hidden), then press Return:"
read -rs DBPASS; echo
[ -n "$DBPASS" ] || stop "No password entered."
SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wpa-secret.XXXXXX")"
chmod 700 "$SECRET_DIR"
( umask 077
  esc="$(printf '%s' "$DBPASS" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g')"
  printf '%s:%s:%s:%s:%s\n' "$DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_USER" "$esc" > "$SECRET_DIR/pgpass" )
chmod 600 "$SECRET_DIR/pgpass"
unset DBPASS

say "Step 2/7  Checking the connection (read-only)"
if ! SERVER_VER="$(ro_query 'SHOW server_version;' 2> "$SECRET_DIR/connect.err")"; then
  ERR="$(grep -m1 -E 'FATAL|error' "$SECRET_DIR/connect.err" | sed 's/password=[^ ]*//' | cut -c1-160)"
  stop "Could not connect to Staging (${ERR:-unknown error}). Check the password; no image was created."
fi
# Production carries migration 0031 (licences.licence_class); Staging does not. A second, independent
# guard against ever reading the wrong project.
MARKER="$(ro_query "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='licences' AND column_name='licence_class';")"
[ "$MARKER" = "0" ] || stop "This database has the Production-only Internal QA schema. Refusing to continue."
echo "OK: connected to Staging, PostgreSQL $SERVER_VER (read-only)."

say "Step 3/7  Creating the encrypted disk image"
mkdir -p "$DIR"; chmod 700 "$DIR"
[ -e "$IMG" ] && stop "$IMG already exists."
echo "macOS will ask you to choose a password for the disk image (typing is hidden, asked twice)."
echo "Create a strong new password and save it in your password manager BEFORE typing it."
hdiutil create -size 512m -fs APFS -encryption AES-256 -volname "$VOLNAME" "$IMG" \
  || stop "The encrypted disk image could not be created."
hdiutil isencrypted "$IMG" 2>/dev/null | grep -qi 'encrypted: *YES' \
  || stop "macOS does not report the new image as encrypted; it will not be used."
echo
echo "Now unlock it (same password). If macOS offers to remember it in the Keychain, decline."
ATTACH_OUT="$(hdiutil attach -nobrowse -owners on "$IMG")" || stop "The encrypted image could not be unlocked."
VOL="$(printf '%s\n' "$ATTACH_OUT" | grep '/Volumes/' | tail -1 | sed 's#.*\(/Volumes/.*\)$#\1#')"
[ -n "$VOL" ] && [ -d "$VOL" ] || stop "Could not find where the encrypted image was mounted."
echo "OK: encrypted image mounted."

say "Step 4/7  Exporting Staging (read-only)"
TABLES_SQL="SELECT n.nspname||'.'||c.relname||'|'||c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 ORDER BY 1;"
COUNT_SQL="SELECT n.nspname||'.'||c.relname||'|'||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','auth') ORDER BY 1;"
ro_query "$TABLES_SQL" > "$VOL/source-tables.txt" 2>> "$VOL/query-errors.log" || stop "Could not list Staging tables."
ro_query "$COUNT_SQL"  > "$VOL/source-counts-before.txt" 2>> "$VOL/query-errors.log" || stop "Could not count Staging rows."
if pg_remote pg_dump --format=custom --compress=9 --file="/backup/$DUMP_NAME" 2> "$VOL/pg_dump-full.log"; then
  EXPORT_SCOPE="FULL (all schemas)"
else
  rm -f "$VOL/$DUMP_NAME"
  echo "The full export failed (pg_dump-full.log in the image). Trying the application, Auth and Storage schemas only."
  echo "This will be reported as PARTIAL: it is NOT a complete backup."
  if pg_remote pg_dump --format=custom --compress=9 -n public -n auth -n storage --file="/backup/$DUMP_NAME" 2> "$VOL/pg_dump-partial.log"; then
    EXPORT_SCOPE="PARTIAL (schemas public, auth, storage only)"
  else
    stop "Both the full and the partial export failed (see the pg_dump logs in the image)."
  fi
fi
ro_query "$COUNT_SQL" > "$VOL/source-counts-after.txt" 2>> "$VOL/query-errors.log" || stop "Could not re-count Staging rows."
[ -s "$VOL/$DUMP_NAME" ] || stop "The export file is empty."
SHA="$(cd "$VOL" && shasum -a 256 "$DUMP_NAME" | tee "$DUMP_NAME.sha256" | awk '{print $1}')"
SIZE="$(stat -f%z "$VOL/$DUMP_NAME")"
echo "OK: export written ($EXPORT_SCOPE)."

say "Step 5/7  Checking the backup contains every table"
docker run --rm -v "$VOL":/backup:ro "$PG_IMAGE" pg_restore --list "/backup/$DUMP_NAME" > "$VOL/archive-contents.txt" \
  || stop "The export file could not be read back (archive is unreadable)."
TOC_ENTRIES="$(grep -vc '^;' "$VOL/archive-contents.txt" || true)"
awk '!/^;/ { if ($4=="TABLE" && $5=="DATA") print "D " $6 "." $7; else if ($4=="TABLE") print "T " $5 "." $6 }' \
  "$VOL/archive-contents.txt" | sort -u > "$VOL/archive-tables.txt"
case "$EXPORT_SCOPE" in FULL*) SCOPE_RE='.*' ;; *) SCOPE_RE='^(public|auth|storage)\.' ;; esac
EXCLUDED_SCHEMAS="$(cut -d'|' -f1 "$VOL/source-tables.txt" | cut -d. -f1 | sort -u | grep -Ev "^(public|auth|storage)$" | tr '\n' ' ' | sed 's/ $//')"
case "$EXPORT_SCOPE" in FULL*) EXCLUDED_SCHEMAS="" ;; esac
MISSING_DEF=0; MISSING_DATA=0; IN_SCOPE=0
while IFS='|' read -r t kind; do
  printf '%s\n' "$t" | grep -Eq "$SCOPE_RE" || continue
  IN_SCOPE=$((IN_SCOPE+1))
  grep -qxF "T $t" "$VOL/archive-tables.txt" || { MISSING_DEF=$((MISSING_DEF+1)); echo "missing table: $t" >> "$VOL/coverage-problems.txt"; }
  if [ "$kind" = "r" ]; then
    grep -qxF "D $t" "$VOL/archive-tables.txt" || { MISSING_DATA=$((MISSING_DATA+1)); echo "missing data: $t" >> "$VOL/coverage-problems.txt"; }
  fi
done < "$VOL/source-tables.txt"
COVERAGE="$IN_SCOPE tables in scope; $MISSING_DEF missing definitions; $MISSING_DATA missing data"
MISSING_REQ=""
for t in $REQUIRED_TABLES; do
  grep -qxF "T $t" "$VOL/archive-tables.txt" && grep -qxF "D $t" "$VOL/archive-tables.txt" || MISSING_REQ="$MISSING_REQ $t"
done
if [ -z "$MISSING_REQ" ]; then REQUIRED="all present"; else REQUIRED="MISSING:$MISSING_REQ"; fi
[ "$IN_SCOPE" -gt 0 ] || stop "No tables found in scope."
[ "$MISSING_DEF" -eq 0 ] && [ "$MISSING_DATA" -eq 0 ] || stop "The backup is missing tables or table data (coverage-problems.txt in the image)."
[ -z "$MISSING_REQ" ] || stop "Required WP Assist tables are missing from the backup:$MISSING_REQ"
echo "OK: $COVERAGE; required tables present."

say "Step 6/7  Restoring into an isolated local database (no network)"
docker rm -f -v "$RESTORE_CTR" >/dev/null 2>&1 || true
docker run -d --name "$RESTORE_CTR" --network none -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$VOL":/backup:ro "$PG_IMAGE" >/dev/null || stop "Could not start the isolated restore database."
NETS="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$RESTORE_CTR")"
[ "$NETS" = "none " ] || stop "The restore database is not network-isolated ($NETS)."
READY=0
for i in $(seq 1 60); do
  if docker exec "$RESTORE_CTR" pg_isready -U postgres -q 2>/dev/null \
     && docker exec "$RESTORE_CTR" psql -U postgres -XAtqc 'select 1' >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
[ "$READY" -eq 1 ] || stop "The isolated restore database did not start."
docker exec "$RESTORE_CTR" psql -U postgres -XAtq -v ON_ERROR_STOP=1 -c "
  DO \$\$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','supabase_admin',
      'supabase_auth_admin','supabase_storage_admin','dashboard_user','supabase_read_only_user'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP; END \$\$;" >/dev/null || stop "Could not prepare the isolated restore database."
docker exec "$RESTORE_CTR" createdb -U postgres restore_verify || stop "Could not create the restore database."
docker exec "$RESTORE_CTR" psql -U postgres -d restore_verify -XAtq -v ON_ERROR_STOP=1 \
  -c "CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" WITH SCHEMA extensions;" >/dev/null \
  || stop "Could not prepare the restore schemas."
set +e
docker exec "$RESTORE_CTR" pg_restore -U postgres -d restore_verify --no-owner --no-privileges -n public -n auth \
  "/backup/$DUMP_NAME" > /dev/null 2> "$VOL/restore-errors.log"
set -e
grep 'pg_restore: error:' "$VOL/restore-errors.log" > "$VOL/restore-error-lines.txt" || true
RESTORE_HARMLESS="$(grep -Ec "$HARMLESS_RESTORE_ERRORS" "$VOL/restore-error-lines.txt" || true)"
RESTORE_MATERIAL="$(grep -Evc "$HARMLESS_RESTORE_ERRORS" "$VOL/restore-error-lines.txt" || true)"
if ! docker exec -i "$RESTORE_CTR" psql -U postgres -d restore_verify -XAtq -v ON_ERROR_STOP=1 \
     > "$VOL/restored-counts.txt" <<< "BEGIN READ ONLY; $COUNT_SQL COMMIT;"; then
  stop "Could not count rows in the restored database."
fi
docker rm -f -v "$RESTORE_CTR" >/dev/null 2>&1 || true
RESTORE="public + auth restored in a network-isolated container (deleted afterwards)"
echo "OK: isolated restore finished; the container and its data have been deleted."

say "Step 7/7  Comparing row counts"
MATCH=0; DIFF=0; CHANGED=0; MISMATCHED=""
while IFS='|' read -r t before; do
  after="$(awk -F'|' -v t="$t" '$1==t{print $2}' "$VOL/source-counts-after.txt")"
  restored="$(awk -F'|' -v t="$t" '$1==t{print $2}' "$VOL/restored-counts.txt")"
  ok=0
  if [ -n "$restored" ] && [ -n "$after" ]; then
    if [ "$before" = "$after" ]; then [ "$restored" = "$before" ] && ok=1
    else CHANGED=$((CHANGED+1)); [ "$restored" -ge "$before" ] && [ "$restored" -le "$after" ] && ok=1; fi
  fi
  if [ "$ok" -eq 1 ]; then MATCH=$((MATCH+1)); else DIFF=$((DIFF+1)); MISMATCHED="$MISMATCHED $t"; fi
done < "$VOL/source-counts-before.txt"
TOTAL="$(wc -l < "$VOL/source-counts-before.txt" | tr -d ' ')"
COUNTS="$TOTAL tables; $MATCH matched; $DIFF mismatched; $CHANGED changed during export"

if [ "$RESTORE_MATERIAL" != "0" ]; then
  REASON="the isolated restore reported $RESTORE_MATERIAL material error(s) (restore-error-lines.txt in the image)"
  STATUS="FAILED"
elif [ "$TOTAL" -eq 0 ] || [ "$DIFF" -ne 0 ]; then
  REASON="restored row counts do not match Staging"
  STATUS="FAILED"
else
  case "$EXPORT_SCOPE" in
    FULL*) STATUS="VERIFIED"; REASON="full export; every table present; isolated restore matched with no material errors" ;;
    *)     STATUS="PARTIAL";  REASON="only public, auth and storage were exported; NOT a complete backup" ;;
  esac
fi
exit 0   # finish() writes MANIFEST.txt, ejects the image and prints the summary
