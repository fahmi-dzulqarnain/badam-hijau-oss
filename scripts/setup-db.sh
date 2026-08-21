#!/usr/bin/env bash
# Creates the badam role and its two databases on a local Postgres.
# Idempotent: safe to run repeatedly.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"

psql -h "$PGHOST" -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'badam') THEN
    CREATE ROLE badam LOGIN PASSWORD 'badam' CREATEDB;
  END IF;
END
$$;
SQL

for name in badam badam_test; do
  if psql -h "$PGHOST" -p "$PGPORT" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$name'" | grep -q 1; then
    echo "$name already exists"
  else
    createdb -h "$PGHOST" -p "$PGPORT" -O badam "$name"
    echo "created $name"
  fi
done
