#!/usr/bin/env bash
# Recreate a local test database: shim → migrations → seed. Usage: scripts/db-reset.sh [dbname]
set -euo pipefail
DB=${1:-soytutaxi_test}
PSQL="psql -v ON_ERROR_STOP=1 -q -h ${PGHOST:-/tmp} -p ${PGPORT:-54329} -U ${PGUSER:-postgres}"
export PGHOST PGPORT PGUSER
$PSQL -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB"
$PSQL -d $DB -f tests/db/supabase_shim.sql
for f in supabase/migrations/*.sql; do $PSQL -d $DB -f "$f"; done
$PSQL -d $DB -c "grant all on all tables in schema public to anon, authenticated, service_role"
$PSQL -d $DB -f supabase/seed.sql
echo "reset $DB ok"
