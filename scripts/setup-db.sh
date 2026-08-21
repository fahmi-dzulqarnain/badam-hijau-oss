#!/usr/bin/env bash
# Creates the badam role and its two databases on a local Postgres.
# Idempotent: safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")/.."

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

# The integration harness refuses to run without .env.test, because falling back to
# .env would truncate the development database.
if [ -f .env.test ]; then
  echo ".env.test already exists"
elif [ -f .env.example ]; then
  sed 's|/badam?schema|/badam_test?schema|' .env.example > .env.test
  echo "created .env.test"
else
  echo "warning: .env.example is missing, cannot create .env.test" >&2
fi
