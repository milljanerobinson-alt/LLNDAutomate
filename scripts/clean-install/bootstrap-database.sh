#!/usr/bin/env bash
# Clean-install bootstrap for an EMPTY LLND Automate database.
#
#   scripts/clean-install/bootstrap-database.sh --db-url <postgres-url> --source-commit <sha> [--execute]
#
# Without --execute the script only builds and checks the bootstrap SQL.
# With --execute it applies every migration in ONE transaction, records the
# Supabase CLI migration ledger in the same transaction, then runs the
# clean-install verification. Afterwards, new migrations are applied with the
# normal `supabase db push`.
#
# Safety:
# - Refuses any connection string containing a denied project ref
#   (supabase/clean-install/manifest.json: denied_project_refs).
# - The generated SQL refuses to run unless the public schema has no tables
#   and the migration ledger is empty.
# - The connection string is never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_URL=""
SOURCE_COMMIT=""
EXECUTE=0
OUT="${TMPDIR:-/tmp}/llnd-clean-install-bootstrap.sql"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-url) DB_URL="$2"; shift 2 ;;
    --source-commit) SOURCE_COMMIT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --execute) EXECUTE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SOURCE_COMMIT" ]]; then
  SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
fi
if [[ -n "$(git -C "$ROOT" status --porcelain -- supabase/migrations supabase/clean-install 2>/dev/null)" ]]; then
  echo "refused: supabase/migrations or supabase/clean-install has uncommitted changes" >&2
  exit 1
fi

denied="$(node -e 'const m=require(process.argv[1]);console.log((m.denied_project_refs||[]).join("\n"))' "$ROOT/supabase/clean-install/manifest.json")"
if [[ -n "$DB_URL" ]]; then
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    if [[ "$DB_URL" == *"$ref"* ]]; then
      echo "refused: the connection string targets a denied project (the original paused project must never be modified)" >&2
      exit 1
    fi
  done <<< "$denied"
fi

node "$ROOT/scripts/clean-install/build-bootstrap.mjs" --out "$OUT" --source-commit "$SOURCE_COMMIT"
expected="$(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ')"
echo "bootstrap SQL written to $OUT (expected migrations: $expected)"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "dry run only: pass --execute to apply"
  exit 0
fi
if [[ -z "$DB_URL" ]]; then
  echo "--db-url is required with --execute" >&2
  exit 2
fi

psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$OUT"
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v expected_migrations="$expected" \
  -f "$ROOT/scripts/clean-install/verify-clean-install.sql"
