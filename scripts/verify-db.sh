#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Apply all Supabase migrations to a throwaway PostgreSQL database and run the
# database test suite against it.
#
#   Usage: scripts/verify-db.sh
#   Env:   PGHOST / PGPORT / PGUSER   (connection to a superuser on PG 15+)
#          RH_TEST_DB                 (database name, default rackethub_test;
#                                      it is DROPPED and recreated)
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${RH_TEST_DB:-rackethub_test}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

echo "▶ Recreating database ${DB}"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB} with (force)" >/dev/null
"${PSQL[@]}" -d postgres -c "create database ${DB}" >/dev/null

echo "▶ Supabase shim"
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/db/00_supabase_shim.sql" >/dev/null

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "▶ Migration $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -1 -f "$f" >/dev/null
done

echo "▶ Seed"
"${PSQL[@]}" -d "$DB" -1 -f "$ROOT/supabase/seed.sql" >/dev/null

for t in "$ROOT"/tests/db/[1-9]*.sql; do
  echo "▶ Test $(basename "$t")"
  # Query results are noise; assertions report through NOTICEs on stderr.
  "${PSQL[@]}" -d "$DB" -o /dev/null -f "$t" 2>&1 | sed -E -e 's/^psql:[^ ]+ (NOTICE|WARNING):  /  /' -e 's/^NOTICE:  /  /'
  [[ ${PIPESTATUS[0]} -eq 0 ]] || { echo "✘ $(basename "$t") failed"; exit 1; }
done

if [[ -x "$ROOT/tests/db/concurrency.sh" ]]; then
  echo "▶ Concurrency tests"
  RH_TEST_DB="$DB" "$ROOT/tests/db/concurrency.sh"
fi

echo "✔ All database checks passed"
