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

  # An existing .env.test is never regenerated, so every key added to .env.example after that
  # file was created is silently absent from it — and the absence is invisible until something
  # reads the variable. That drift is not hypothetical: it hid a real bug for two phases. A
  # truthy AUTH_URL in .env.test breaks three tests in src/lib/auth/providers.test.ts, and
  # every existing checkout stayed green only because its .env.test predated AUTH_URL being
  # added here, while a fresh clone failed immediately. The tests are fixed, but the drift that
  # concealed the mismatch is the more general problem, so it gets reported.
  #
  # Reported, never repaired: appending a key with .env.example's placeholder value would put a
  # wrong value in a working file, and this script cannot know the right one. `|| true` on the
  # grep because `set -e` would otherwise abort on a file with no matching lines.
  example_keys=$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env.example 2>/dev/null | tr -d '=' || true)
  missing=""
  for key in $example_keys; do
    grep -q "^${key}=" .env.test || missing="$missing $key"
  done
  if [ -n "$missing" ]; then
    echo "warning: .env.test lacks keys that .env.example defines:$missing" >&2
    echo "         Add them by hand, or delete .env.test and re-run this script." >&2
  fi
elif [ -f .env.example ]; then
  sed 's|/badam?schema|/badam_test?schema|' .env.example > .env.test
  echo "created .env.test"
else
  echo "warning: .env.example is missing, cannot create .env.test" >&2
fi
