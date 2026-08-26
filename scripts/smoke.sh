#!/usr/bin/env bash
# End-to-end smoke test. Provisions, seeds, builds, serves and exercises the running app
# over HTTP. Answers "does a cold start work", which no other test does.
#
#   ./scripts/smoke.sh
#
# Requires ALLOW_TEST_LOGIN=1 — it authenticates as seeded users. Never run against a
# deployed environment: it seeds data and expects the passwordless login.
#
# Every later phase EXTENDS this script rather than replacing it: it is the one check that
# answers "does this work from nothing", which is the question asked before a deploy and after
# every dependency bump. Phase 2 added the authoring pass — create, save, publish, read, move,
# follow, delete, 404 — over plain HTTP. Deliberately no browser: Playwright owns those.
#
# The EXIT CODE is the contract. `npm run smoke | tail` reports tail's status, not this
# script's; check `${PIPESTATUS[0]}` or do not pipe.
set -euo pipefail
cd "$(dirname "$0")/.."

# 3998, and deliberately not Playwright's 3100: `npm run test:e2e` starts its own server there
# and both suites write to the same development database.
PORT="${SMOKE_PORT:-3998}"
BASE="http://localhost:$PORT"
JAR="$(mktemp)"
LOG="$(mktemp)"
# Response bodies from the JSON API checks, so a failure can print what came back instead of
# only the status that did not match.
OUT="$(mktemp)"
FORM="$(mktemp)"
SERVER=""
FAILURES=0

# The marker every row the authoring pass creates carries, in its **slug** — not its path.
# The pass renames the page it creates, and a path-based marker would stop matching the row it
# identifies at exactly the moment that row needs cleaning up. The moved slug keeps the prefix
# for the same reason.
SLUG="smoke-page"
MOVED_SLUG="smoke-page-moved"
# What the published body must contain when it is read back. Distinct from the title, so a
# reader that renders the title and drops the document still fails.
MARKER="Written by the cold-start smoke test."

cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  rm -f "$JAR" "$LOG" "$OUT" "$FORM"
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

expect_absent() { # url needle label
  # The mirror of `expect_body`, and it exists because a filter that filters nothing looks
  # exactly like a filter that works: `?status=SUPERSEDED` listing the retired ADR proves only
  # that the page renders. What makes that check mean something is the page NOT listing the ADR
  # still in force.
  curl -s -b "$JAR" "$BASE$1" > "$OUT"
  grep -q -- "$2" "$OUT" \
    && fail "$3 ('$2' is present at $1)" || ok "$3"
}

expect_body() { # url needle label
  # Written to a file and grepped, not piped: under `pipefail` a pipeline reports the WRITER's
  # status, and `grep -q` exits on its first match while curl is still writing — so a matching
  # body can surface as curl's SIGPIPE. It has never bitten here because the seeded pages are
  # small enough that curl finishes first, which is exactly the kind of latent flake that
  # appears the first time a page grows. `body_has` already does it this way.
  curl -s -b "$JAR" "$BASE$1" > "$OUT"
  grep -q -- "$2" "$OUT" \
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

# One JSON API call, with the response body left in "$OUT" for the assertions that follow it.
# Pass "" as the body for the routes that read none — publish and delete both refuse a body on
# purpose, and sending one would suggest some part of what they do is negotiable.
api() { # method path body expected label
  local got
  if [ -z "$3" ]; then
    got=$(curl -s -b "$JAR" -o "$OUT" -w "%{http_code}" -X "$1" "$BASE$2")
  else
    got=$(curl -s -b "$JAR" -o "$OUT" -w "%{http_code}" -X "$1" "$BASE$2" \
      -H "Content-Type: application/json" -d "$3")
  fi
  [ "$got" = "$4" ] && ok "$5" \
    || fail "$5 ($1 $2 -> $got, wanted $4: $(tr -d '\n' < "$OUT" | head -c 200))"
}

# An assertion about the body "$OUT" already holds, so the response is read once.
body_has() { # needle label
  grep -q -- "$1" "$OUT" && ok "$2" \
    || fail "$2 (no '$1' in $(tr -d '\n' < "$OUT" | head -c 200))"
}

# The value of one hidden field React renders into a server-action form. `/new` is a SERVER
# ACTION and not a JSON route, so creating a page over HTTP means sending the POST a browser
# with JavaScript disabled sends: these four fields plus the form's own inputs. The action id
# is scraped rather than hardcoded because it is a build-time hash — pinning one would make
# this check silently stop exercising create after the next build.
#
# `sed` and not `grep -o … | head -1`: with `pipefail` set, `head` closing the pipe early can
# leave the pipeline reporting the writer's SIGPIPE rather than the match.
action_field() { # field-name
  sed -n "s/.*name=\"$1\" value=\"\([^\"]*\)\".*/\1/p" "$FORM" | sed 's/&quot;/"/g'
}

# Every row count in the development database, on one line.
#
# **`psql` and not `npx prisma db execute`.** That command is a write channel: it returns no
# result set at all, which is why the sweep below can only assert a count inside a
# `raise exception` and can never report one. `psql` is not a new dependency — `setup-db.sh`,
# which the Provision step runs first, is built entirely on it — and this connects the way that
# script connects: the local server, the `badam` database, the developer's own role. `.env`'s
# `DATABASE_URL` is deliberately not reused as the connection string; libpq refuses its
# `?schema=public` parameter outright.
#
# This is the guard that covers `PageRelation`, and the reason it has to be a whole-table count
# rather than another clause in `sweep`'s `raise exception` block is in that block's comment.
counts() {
  psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -d badam -tAX -v ON_ERROR_STOP=1 -c "
    select format(
      '%s spaces / %s pages / %s versions / %s drafts / %s audit / %s redirects / '
      || '%s relations / %s bug reports / %s soft-deleted',
      (select count(*) from \"Space\"),
      (select count(*) from \"Page\"),
      (select count(*) from \"PageVersion\"),
      (select count(*) from \"PageDraft\"),
      (select count(*) from \"AuditLog\"),
      (select count(*) from \"Redirect\"),
      (select count(*) from \"PageRelation\"),
      (select count(*) from \"BugReport\"),
      (select count(*) from \"Page\" where \"deletedAt\" is not null))" 2>/dev/null \
    || echo "counts unavailable"
}

# Everything the authoring, lifecycle and bug-report checks create, taken back out.
#
# Called TWICE: once before the authoring pass, because a fixture left behind by a crashed run
# makes this run's create fail on an occupied path — which reads as a product bug and is not
# one — and once in Teardown.
#
# Three orderings are load-bearing:
#
# - `publishedVersionId` is nulled first. It is a foreign key from `Page` into a `PageVersion`
#   that the page's own delete cascades away, and leaving Postgres to resolve a cascade against
#   a column pointing into the set being cascaded is not a bet worth taking.
# - `AuditLog` goes before the pages, because that is the last moment those page ids can be
#   read. Every mutation writes a row — create, publish, move and delete are four of them — and
#   the row deliberately has NO foreign key, so nothing cascades and the id is the only handle.
# - `Redirect` rows are swept by `fromPath` as well as by cascade. A move's redirect points AT
#   the fixture and cascades with it; a delete's redirect points at the nearest surviving
#   ANCESTOR, which is a seeded page, so nothing would cascade it away.
# - `PageRelation` goes with the audit rows and for the same reason — Phase 3. A relation row is
#   two page ids and carries no marker of its own, so the page ids are the only handle and this
#   is the last moment they can be read. The schema *would* cascade it from either end, and the
#   statement is here anyway: an `onDelete: Cascade` in `prisma/schema.prisma` is a decision two
#   files away that could be relaxed without this script noticing, and cleanup this script is
#   responsible for should be readable in the sweep that is responsible for it.
#
# The `do` block at the end is what makes this a contract rather than a hope: a sweep that
# silently left rows behind would otherwise be invisible until the next run failed to create.
#
# **It has no `PageRelation` clause, and that is deliberate rather than an omission.** Every
# relation this script can write has a `smoke-` page at both ends, and both foreign keys cascade,
# so a clause here could only ever be true when the `Page` clause above it is already true — a
# check that cannot fail on its own, which this project has just spent a task learning to
# recognise. What can fail is a whole-table count: `counts()` above is read before the passes and
# again after this sweep, and Teardown compares them. That catches a leaked relation whatever its
# ends are, along with every other row this script did not mean to leave.
sweep() {
  npx --no prisma db execute --stdin --schema prisma/schema.prisma > /dev/null 2>&1 <<'SQL'
update "Page" set "publishedVersionId" = null where slug like 'smoke-%';
delete from "AuditLog" where "pageId" in (select id from "Page" where slug like 'smoke-%');
delete from "PageRelation"
 where "fromId" in (select id from "Page" where slug like 'smoke-%')
    or "toId"   in (select id from "Page" where slug like 'smoke-%');
delete from "Redirect" where "fromPath" like 'smoke-%';
delete from "Page" where slug like 'smoke-%';
delete from "BugReport" where summary = 'smoke test';
do $$
begin
  if exists (select 1 from "Page" where slug like 'smoke-%')
     or exists (select 1 from "Redirect" where "fromPath" like 'smoke-%')
     or exists (select 1 from "BugReport" where summary = 'smoke test') then
    raise exception 'the sweep left smoke fixtures behind';
  end if;
end $$;
SQL
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

step "Authoring"
# A fixture left behind by a crashed run would make the create below fail on `path-occupied`,
# which reads as a product bug and is not one.
sweep && ok "swept any fixtures an earlier run left behind" \
  || fail "could not sweep before the authoring pass"

# Read AFTER that sweep, so a fixture a crashed run left behind is not counted as part of the
# baseline this run promises to restore.
BEFORE="$(counts)"
ok "dev database before the passes: $BEFORE"

sign_in "aisyah@example.com"

# The space to create in. Its id is a cuid, so it cannot be hardcoded from the seed's key —
# it is read out of the form's own `<select>`, which also proves the form offers a space at
# all: `listEditableSpaces` drops a space this editor can read but not write, and an empty
# select means the form renders a "nowhere to create a page" message instead of inputs.
# `|| :` so a transport failure surfaces as the named check below rather than as `set -e`
# abandoning the run before Teardown can sweep.
curl -s -b "$JAR" -o "$FORM" "$BASE/new" || :
SPACE_ID=$(tr '<' '\n' < "$FORM" | awk '
  /^select / && /name="spaceId"/ { in_select = 1; next }
  in_select && /^\/select/ { exit }
  in_select && /^option value="/ { sub(/^option value="/, ""); sub(/".*/, ""); print; exit }')
[ -n "$SPACE_ID" ] && ok "the create form offers a space to create in" \
  || fail "no space in the create form — /new rendered no spaceId options"

# Create. The 303 to `/edit/{id}` is `createPage`'s own redirect, and its Location header is
# where the new page's id comes from — the same way a browser learns it.
CREATED=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -D - -X POST "$BASE/new" \
  --form-string "\$ACTION_REF_1=" \
  --form-string "\$ACTION_1:0=$(action_field '$ACTION_1:0')" \
  --form-string "\$ACTION_1:1=$(action_field '$ACTION_1:1')" \
  --form-string "\$ACTION_KEY=$(action_field '$ACTION_KEY')" \
  --form-string "spaceId=$SPACE_ID" \
  --form-string "parentId=" \
  --form-string "title=Smoke page" \
  --form-string "slug=$SLUG" \
  --form-string "docType=DOC" \
  | sed -n 's/^[Ll]ocation: *//p' | tr -d '\r')
PAGE_ID="${CREATED#/edit/}"
[ -n "$PAGE_ID" ] && [ "$PAGE_ID" != "$CREATED" ] \
  && ok "created a page (303 -> $CREATED)" \
  || fail "create did not redirect to the editor (Location: ${CREATED:-none})"

if [ -n "$PAGE_ID" ] && [ "$PAGE_ID" != "$CREATED" ]; then
  # The `updatedAt` the editor was served, which is what the autosave client sends back as
  # `seen`. Sending `null` instead is a positive claim that no draft exists — `createPage`
  # leaves one — and `decideSave` correctly answers 409 to that.
  SEEN=$(curl -s -b "$JAR" "$BASE/edit/$PAGE_ID" \
    | sed -n 's/.*updatedAt\\":\\"\([0-9T:.Z-]*\)\\.*/\1/p')
  [ -n "$SEEN" ] && ok "the editor serves the new page's draft" \
    || fail "no draft timestamp in /edit/$PAGE_ID"

  api PUT "/api/drafts/$PAGE_ID" \
    "{\"title\":\"Smoke page\",\"markdown\":\"$MARKER\\n\",\"seen\":\"$SEEN\"}" \
    200 "draft saved"

  # No body, and no `seen`: publish takes its content from the draft row. A save AFTER this
  # would be a `vanished` 409 rather than a create, because publishing deletes the draft.
  api POST "/api/pages/$PAGE_ID/publish" "" 200 "published"
  body_has '"status":"CURRENT"' "publish moved the page to CURRENT"

  expect_status "/engineering/$SLUG" 200 "the published page is readable at its real URL"
  expect_body "/engineering/$SLUG" "$MARKER" "the reader renders the published markdown"

  api POST "/api/pages/$PAGE_ID/move" \
    "{\"newParentId\":null,\"newSlug\":\"$MOVED_SLUG\"}" 200 "moved"
  body_has "\"path\":\"$MOVED_SLUG\"" "the move reports the new path"

  # 308, not the spec's 301: `permanentRedirect()` emits 308, which forbids an intermediary
  # rewriting the method on the retry. Recorded as spec §14 drift by Task 11.
  LOCATION=$(curl -s -b "$JAR" -o /dev/null -D - "$BASE/engineering/$SLUG" \
    | sed -n 's/^[Ll]ocation: *//p' | tr -d '\r')
  [ "$LOCATION" = "/engineering/$MOVED_SLUG" ] \
    && ok "the old URL 308s to the new one" \
    || fail "the old URL pointed at '${LOCATION:-nothing}', wanted /engineering/$MOVED_SLUG"
  expect_status "/engineering/$SLUG" 308 "and the status is a permanent redirect"

  # Pointing somewhere is not landing there.
  LANDED=$(curl -s -b "$JAR" -L -o /dev/null -w "%{http_code} %{url_effective}" \
    "$BASE/engineering/$SLUG")
  [ "$LANDED" = "200 $BASE/engineering/$MOVED_SLUG" ] \
    && ok "following the redirect lands on the moved page" \
    || fail "following the redirect gave '$LANDED'"

  api POST "/api/pages/$PAGE_ID/delete" "" 200 "deleted"
  # A deleted ROOT page gets no redirect: `Redirect.toPageId` is not nullable and there is no
  # surviving ancestor to aim at. That is why the answer below is a 404 and not a 308 to
  # nowhere, so it is asserted rather than left to be inferred from the status.
  body_has '"redirectTo":null' "a deleted root page leaves no redirect behind"
  expect_status "/engineering/$MOVED_SLUG" 404 "the deleted page 404s"
else
  fail "authoring pass skipped: no page id to work with"
fi

step "Bug reporting"
sign_in "aisyah@example.com"
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/bugs" \
  -H "Content-Type: application/json" \
  -d '{"summary":"smoke test","routePath":"/engineering","appVersion":"0.0.0","userAgent":"smoke","viewport":"800x600"}')
[ "$code" = "201" ] && ok "bug report accepted" || fail "bug report POST returned $code"

step "Teardown"
# The checks above insert real rows into the DEVELOPMENT database: a bug report, and — since
# Phase 2's authoring pass — a page, a version, a redirect from the move and four `AuditLog`
# rows, one for each of create, publish, move and delete. Phase 3's lifecycle pass adds two more
# pages, their versions, a `PageRelation`, and the `page.cascade` audit row the cascade writes on
# the page it retired. `sweep` removes all of it and then asserts it is gone, so this run leaves
# `badam` at exactly the counts it found. Scoped to the markers this script writes rather than a
# TRUNCATE, so a developer's own rows survive.
sweep && ok "removed everything this run created" \
  || fail "could not clean up after the run — check for smoke- pages and 'smoke test' bugs"

# The cleanup contract, stated as a number rather than as a marker — and the only guard that can
# see a `PageRelation`, which has no marker to be scoped to. It is also stricter than the sweep:
# the sweep asserts that everything it knows how to delete is gone, and this asserts that nothing
# else appeared either.
AFTER="$(counts)"
[ "$AFTER" = "$BEFORE" ] \
  && ok "dev database after the run:  $AFTER" \
  || fail "the run changed the dev database — before: $BEFORE — after: $AFTER"

step "Result"
if [ "$FAILURES" -eq 0 ]; then
  printf "\n\033[32mSMOKE PASSED\033[0m\n"
else
  printf "\n\033[31mSMOKE FAILED: %s check(s)\033[0m\n" "$FAILURES"
  exit 1
fi
