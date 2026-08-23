#!/usr/bin/env bash
# End-to-end smoke test. Provisions, seeds, builds, serves and exercises the running app
# over HTTP. Answers "does a cold start work", which no other test does.
#
#   ./scripts/smoke.sh
#
# Requires ALLOW_TEST_LOGIN=1 — it authenticates as seeded users. Never run against a
# deployed environment: it seeds data and expects the passwordless login.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3998}"
BASE="http://localhost:$PORT"
JAR="$(mktemp)"
LOG="$(mktemp)"
SERVER=""
FAILURES=0

cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  rm -f "$JAR" "$LOG"
}
trap cleanup EXIT

step()  { printf "\n\033[1m== %s\033[0m\n" "$1"; }
ok()    { printf "  \033[32mok\033[0m   %s\n" "$1"; }
fail()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAILURES=$((FAILURES + 1)); }

expect_status() { # url expected label
  local got
  got=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE$1")
  [ "$got" = "$2" ] && ok "$3 ($1 -> $got)" || fail "$3 ($1 -> $got, wanted $2)"
}

expect_body() { # url needle label
  curl -s -b "$JAR" "$BASE$1" | grep -q -- "$2" \
    && ok "$3" || fail "$3 (no match for '$2' at $1)"
}

sign_in() { # email
  : > "$JAR"
  local csrf
  csrf=$(curl -s -c "$JAR" "$BASE/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
  curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/api/auth/callback/test-login" \
    -d "email=$1" -d "csrfToken=$csrf" -d "json=true"
  curl -s -b "$JAR" "$BASE/api/auth/session" | grep -q "$1" \
    && ok "signed in as $1" || fail "could not sign in as $1"
}

step "Provision"
./scripts/setup-db.sh > /dev/null
npx --no prisma migrate deploy > /dev/null
ok "database ready and migrated"

step "Seed"
npm run db:seed 2>&1 | grep -q "Seeded" && ok "seeded" || fail "seed did not report success"

step "Build"
npm run build > "$LOG" 2>&1 && ok "production build" || { cat "$LOG"; fail "build"; exit 1; }

step "Serve"
ALLOW_TEST_LOGIN=1 npx next start --port "$PORT" > "$LOG" 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "$BASE/" && break; sleep 1; done
curl -s -o /dev/null "$BASE/" && ok "listening on $PORT" || { cat "$LOG"; fail "server did not start"; exit 1; }

step "Signed out"
: > "$JAR"
[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/engineering")" = "307" ] \
  && ok "reader redirects to sign-in" || fail "reader did not redirect when signed out"
curl -s -D - -o /dev/null "$BASE/engineering" | grep -qi "callbackUrl" \
  && ok "redirect carries a callbackUrl" || fail "redirect lost the callbackUrl"

step "Member of engineering"
sign_in "aisyah@example.com"
expect_status "/engineering" 200 "members-only space readable by a member"
expect_status "/handbook"    200 "all-staff space readable"
expect_body "/engineering" "topic-registry" "rail reaches three levels deep"
expect_body "/engineering" "tag-draft"      "unpublished page marked as a draft"
expect_body "/engineering" "brand-channel"  "alpha badge present"

step "Member of nothing"
sign_in "stranger@example.com"
expect_status "/engineering" 404 "members-only space hidden (404, not 403)"
expect_status "/handbook"    200 "all-staff space still readable"
curl -s -b "$JAR" "$BASE/engineering" | grep -qi "MQTT" \
  && fail "a hidden space leaked a page title" || ok "no page titles leaked from the hidden space"

step "Bug reporting"
sign_in "aisyah@example.com"
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/bugs" \
  -H "Content-Type: application/json" \
  -d '{"summary":"smoke test","routePath":"/engineering","appVersion":"0.0.0","userAgent":"smoke","viewport":"800x600"}')
[ "$code" = "201" ] && ok "bug report accepted" || fail "bug report POST returned $code"

step "Teardown"
# The bug-reporting check above inserts a real row. Remove it, or every smoke run leaves
# one behind. Scoped to this run's summary rather than a TRUNCATE, so a developer's own
# reports survive.
printf "delete from \"BugReport\" where summary = 'smoke test';" \
  | npx --no prisma db execute --stdin --schema prisma/schema.prisma > /dev/null 2>&1 \
  && ok "removed the smoke bug report" || fail "could not clean up the smoke bug report"

step "Result"
if [ "$FAILURES" -eq 0 ]; then
  printf "\n\033[32mSMOKE PASSED\033[0m\n"
else
  printf "\n\033[31mSMOKE FAILED: %s check(s)\033[0m\n" "$FAILURES"
  exit 1
fi
