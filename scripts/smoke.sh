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
# follow, delete, 404 — over plain HTTP. Phase 3 added the lifecycle pass: publish an ADR,
# supersede it, and confirm the first is retired, still readable, and listed beside its
# replacement in the generated index. Phase 4 added the search pass: a word unique to a published
# page finds it, and once that page is retired it is still found and ranks below a live match.
# Phase 5 added the git-mirror pass: publish over HTTP, drain `npm run git:worker` against a
# temporary working tree and a local bare remote, and assert the file, its frontmatter, the
# commit, the sha on the version row and the sha on the page.
# Deliberately no browser: Playwright owns those.
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

# The two ADRs the lifecycle pass publishes: one that ends up retired, one that retires it. Named
# for what becomes of them rather than "one" and "two", because every assertion below is about
# which of the two it is talking about, and `smoke-adr-two` in a failure message says nothing.
# Both carry the `smoke-` slug prefix `sweep` keys on.
ADR_RETIRED="smoke-adr-retired"
ADR_LIVE="smoke-adr-replacement"
ADR_RETIRED_TITLE="Smoke ADR that gets superseded"
ADR_LIVE_TITLE="Smoke ADR that supersedes it"
# Body text, distinct per page and distinct from the titles. The retired one's marker is what
# proves §6.4's promise that a superseded document still reads: the banner can be right and the
# body gone, and a check on the banner alone would not know.
ADR_RETIRED_MARKER="This decision was in force until the cold-start smoke test replaced it."
ADR_LIVE_MARKER="This decision replaced one, in a cold-start smoke test."

# The two pages the search pass ranks against each other — Phase 4, Task 7. Named for what
# becomes of them, for the same reason the ADRs above are: every assertion in that pass is about
# which of the two it is talking about. Both carry the `smoke-` slug prefix `sweep` keys on.
SEARCH_LIVE="smoke-search-live"
SEARCH_RETIRED="smoke-search-retired"
SEARCH_LIVE_TITLE="Smoke page that stays in force"
SEARCH_RETIRED_TITLE="Smoke page that gets retired"
# The word searched for. It appears in no seeded page and nowhere else in this script, which is
# asserted rather than assumed — the "only match" check below is what makes it a needle. One
# unstemmed English word, so `english` reduces it to itself on both sides of the index (measured:
# `to_tsvector('english', 'capybara')` is `'capybara':1`, and the seeded corpus matches it 0 times).
NEEDLE="capybara"
# **The same prose in both pages, and this is the one place in this script where two fixtures must
# NOT carry distinct markers.** The needle sits in the body of both and in the title of neither, so
# both match in the same weight band with the same term density — measured identical, 0.12158542
# each before the demotion — and the only thing left that can order the two results is §6.4's
# retired demotion. A needle in one title would match at band `A` and drown the effect; a longer
# body on one side would measure density instead. Each row is identified by its **path** below, so
# nothing here needs the bodies to differ.
SEARCH_BODY="The $NEEDLE bridge retries on a fixed interval, so the kiosk sees a stale price."

# The page the git-mirror pass publishes — Phase 5, Task 9. One page, because what this pass is
# about is the *seam* to git rather than the lifecycle: the file's bytes, the commit, the sha on
# the version row and the sha on the page. Moves, deletes and restores against a real tree are
# `e2e/mirror-tree.spec.ts`, which can read a repository between two HTTP calls.
MIRROR_SLUG="smoke-mirror"
MIRROR_TITLE="Smoke page that reaches the mirror"
# Distinct from the title, so a mirror that wrote a canonical block and dropped the body fails.
MIRROR_MARKER="This body was written into the content repository by the cold-start smoke test."
# The mirror's working tree and its remote, both throwaway.
#
# **Never `content/`.** That directory is gitignored and real in a developer's checkout, and a
# smoke run that wrote into it would commit fixtures into whatever tree that developer happens to
# have — `GIT_MIRROR_ROOT` is what makes it avoidable, and `mktemp -d` is what makes it avoided.
# The guard below is the same one `tests/setup/scratch.ts` states for the vitest suites: prove the
# directory is not inside this checkout rather than trusting `mktemp`.
MIRROR_TMP="$(mktemp -d)"
MIRROR_ROOT="$MIRROR_TMP/tree"
MIRROR_REMOTE="$MIRROR_TMP/content.git"
# The worker's own output, so a failed drain can print what it said instead of only its status.
WLOG="$(mktemp)"

cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  rm -f "$JAR" "$LOG" "$OUT" "$FORM" "$WLOG"
  # The mirror tree and its remote are files, and files do not cascade with the rows the sweep
  # takes. A crashed run leaves them under $TMPDIR rather than in the repository.
  [ -n "$MIRROR_TMP" ] && rm -rf "$MIRROR_TMP"
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

# The first space id the create form offers, read out of the form's own `<select>` in "$FORM".
#
# A cuid, so it cannot be hardcoded from the seed's key. Extracted rather than written out at
# each call site: the authoring pass and the lifecycle pass both create pages, and a parse this
# fiddly copied into the second one is the shape this project has three times watched two sites
# agree on the day they were written and then drift.
#
# `|| :` for the reason the `/new` fetch above carries one: `awk` exits on the first option while
# `tr` is still writing, and under `pipefail` that pipeline reports the WRITER's SIGPIPE — the
# same latent flake `expect_body` documents. It has never fired, because the form is small enough
# that `tr` finishes first. If it ever does, the caller's own emptiness check names it, rather
# than `set -e` abandoning the run before Teardown can sweep.
space_option() {
  tr '<' '\n' < "$FORM" | awk '
    /^select / && /name="spaceId"/ { in_select = 1; next }
    in_select && /^\/select/ { exit }
    in_select && /^option value="/ { sub(/^option value="/, ""); sub(/".*/, ""); print; exit }' \
    || :
}

# One row of a generated index, matched by the `<code class="idx-path">` cell that carries the
# page's path.
#
# **A page title is not usable as the needle here, and finding that out is what the negative
# check below was for.** `/{space}/-/adrs` renders inside the space layout, so the nav rail
# beside the list names every page in the space, by title, on the same HTML — a title needle is
# satisfied by the chrome and says nothing about the index. Measured: the first version of the
# filter check asserted the still-in-force ADR was absent from `?status=SUPERSEDED`, and it
# failed, because the rail was listing it. The positive checks were passing for the same reason
# and would have gone on passing with the index rendering nothing at all.
#
# `idx-path` is the one class the rail does not use, and the row is where the index says "this
# page is in this list".
idx_row() { # slug
  printf 'idx-path">%s<' "$1"
}

# One relation row, label and all. `RetiredBanner` and `RelationList` render through the same
# `RelationRow`, so this matches the banner's "Superseded by" entry and the relation list under a
# document alike.
#
# Same lesson as `idx_row`, and it arrived the same way — from a mutant rather than from care.
# With the cascade disabled in `cascadeFor`, "the banner names the replacement by title" stayed
# **green**: the reader paints the nav rail beside the document, so both titles are on the page
# whether or not any relation is rendered at all. Binding the label, the link target and the
# title into one needle is what makes this a statement about the row.
rel_row() { # label slug title
  printf 'rel-k">%s</span><a class="rel-title" href="/engineering/%s">%s<' "$1" "$2" "$3"
}

# One result row on `/search`, matched by the `<code class="q-path">` cell that carries the page's
# path — `idx_row`'s reasoning, arriving on a route where it is sharper still.
#
# **`/search?q=capybara` paints the needle into the page whether or not anything matched.** The
# term is the search input's `value`, and the no-hits sentence quotes it too — *No page matches
# “capybara”* — so `grep capybara` on this response is satisfied by **zero results**. That is the
# vacuous-assertion shape this phase has already been bitten by twice, and it is why nothing below
# ever greps for the needle itself.
#
# The path cell is also the one string per row that is unique to that row: `.q-title`'s href
# carries the slug too, and so does the RSC flight payload at the foot of the document in its own
# JSON spelling (`\"className\":\"q-path\"`), which this needle deliberately does not match —
# measured, one hit per row in the rendered markup.
q_row() { # slug
  printf 'q-path">%s<' "$1"
}

# The head of a retired result row: the status badge, and the title as a link to the page.
#
# Three things in one needle for `rel_row`'s reason — a badge on its own is satisfied by any row's
# badge, and a title on its own is satisfied by the nav rail on any other route. `q-retired` is in
# it because that class is `isRetired` having been derived at all; a row that lost the derivation
# would still print the status name.
q_retired_row() { # status slug title
  printf 'q-status q-retired">%s</span><a class="q-title" href="/engineering/%s">%s<' "$1" "$2" "$3"
}

# Which of two result rows comes first in one response — the whole of "ranks below".
#
# **Grepping for both paths and finding both is not this assertion**: it passes in whichever order
# the two rows are rendered, which is exactly the property under test. So this reads their
# **positions** and compares them.
#
# `grep -bo` and not `grep -n`: the response is one enormous line of HTML, so every line number is
# 1 and `grep -n` would report the same position for both rows. Byte offsets are the only positions
# this markup has.
#
# `sed -n '1s/…//p'` and not `head -1`, and `|| :` on the pipeline: `head` closing the pipe early
# leaves the pipeline reporting grep's SIGPIPE under `pipefail` — the flake `expect_body`
# documents — and grep exits 1 when a row is absent, which is a named failure below rather than
# `set -e` abandoning the run before Teardown can sweep. A missing row is reported as a missing
# row: the offsets are printed either way, so a failure says where each row actually was.
expect_ranked() { # url higher-slug lower-slug label
  curl -s -b "$JAR" "$BASE$1" > "$OUT"
  local higher lower
  higher="$(grep -boF -- "$(q_row "$2")" "$OUT" | sed -n '1s/:.*//p' || :)"
  lower="$(grep -boF -- "$(q_row "$3")" "$OUT" | sed -n '1s/:.*//p' || :)"
  if [ -z "$higher" ] || [ -z "$lower" ]; then
    fail "$4 (a row is missing at $1: $2 at ${higher:-none}, $3 at ${lower:-none})"
  elif [ "$higher" -lt "$lower" ]; then
    ok "$4 ($2 at byte $higher, $3 at byte $lower)"
  else
    fail "$4 ($2 is at byte $higher, which is not above $3 at byte $lower)"
  fi
}

# One assertion about the mirrored file "$MIRROR_FILE", which the git-mirror pass has already
# located. The file's own bytes, not a response body — so unlike every needle above it, nothing on
# a page can echo one back and satisfy it.
mirror_has() { # needle label
  grep -q -- "$1" "$MIRROR_FILE" && ok "$2" \
    || fail "$2 (no match for '$1' in $MIRROR_FILE)"
}

# One run of `npm run git:worker` against the temporary tree, leaving its output in "$WLOG" for
# the assertions that follow and its status in `WORKER_CODE`.
#
# **The exit code is read bare, and that is the whole reason this is a function.** A pipe reports
# its LAST command's status — the trap this project has been bitten by five times, and the one this
# script's own header warns about for `npm run smoke | tail` — so the run is redirected to a file
# and `$?` is read on the next line. `set +e` around it because a non-zero here is a named check
# below rather than a reason to abandon the run before Teardown can sweep.
#
# `npm run --silent git:worker` and not `npx tsx scripts/git-worker.ts`: the alias is what an
# operator puts in a cron, so the alias is what a smoke test should exercise, and `--silent` keeps
# npm's own banner out of the output these checks grep.
worker_drain() { # what-is-being-drained
  set +e
  GIT_MIRROR_ROOT="$MIRROR_ROOT" GIT_REMOTE_URL="$MIRROR_REMOTE" \
    npm run --silent git:worker > "$WLOG" 2>&1
  WORKER_CODE=$?
  set -e
  [ "$WORKER_CODE" = "0" ] && ok "the worker drained $1 and exited 0" \
    || fail "the worker exited $WORKER_CODE draining $1: $(tr -d '\r' < "$WLOG" | tail -c 300)"
}

# Whether a path is this checkout or inside it. The mirror's working tree must be neither: `git`
# run in a subdirectory of a repository reports the ANCESTOR's root, so a mirror rooted under this
# checkout would commit fixtures into the branch under test rather than refusing.
inside_checkout() { # path
  case "$1" in
    "$PWD" | "$PWD"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Creates a page through `/new`, saves `markdown` into its draft, and leaves the new page's id in
# `PAGE_ID` — empty if any step failed, so the caller branches on one variable.
#
# **A global rather than a value on stdout**, which is not a style choice: this function prints
# named checks, and a `$(...)` around it would capture those `ok` lines into the variable and run
# every `fail` in a subshell, where `FAILURES` is incremented and thrown away. The exit code is
# the contract, and a check that cannot reach the counter is not a check.
#
# The form is fetched afresh on each call. `$ACTION_KEY` and the action id are build-time hashes
# scraped from it, and reusing a `$FORM` left over from an earlier step would make this depend on
# a file the caller cannot see it reading.
author_page() { # slug title docType markdown-as-a-json-string
  PAGE_ID=""
  local location id space_id seen
  curl -s -b "$JAR" -o "$FORM" "$BASE/new" || :
  space_id="$(space_option)"
  if [ -z "$space_id" ]; then
    fail "$1: no space in the create form — /new rendered no spaceId options"
    return 0
  fi

  # The 303 to `/edit/{id}` is `createPage`'s own redirect, and its Location header is where the
  # new page's id comes from — the same way a browser learns it.
  location="$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -D - -X POST "$BASE/new" \
    --form-string "\$ACTION_REF_1=" \
    --form-string "\$ACTION_1:0=$(action_field '$ACTION_1:0')" \
    --form-string "\$ACTION_1:1=$(action_field '$ACTION_1:1')" \
    --form-string "\$ACTION_KEY=$(action_field '$ACTION_KEY')" \
    --form-string "spaceId=$space_id" \
    --form-string "parentId=" \
    --form-string "title=$2" \
    --form-string "slug=$1" \
    --form-string "docType=$3" \
    | sed -n 's/^[Ll]ocation: *//p' | tr -d '\r')"
  id="${location#/edit/}"
  if [ -z "$id" ] || [ "$id" = "$location" ]; then
    fail "$1: create did not redirect to the editor (Location: ${location:-none})"
    return 0
  fi
  ok "$1: created as $3 (303 -> $location)"

  # The `updatedAt` the editor was served, which is what the autosave client sends back as
  # `seen`. Sending `null` instead is a positive claim that no draft exists — `createPage` leaves
  # one — and `decideSave` correctly answers 409 to that.
  seen="$(curl -s -b "$JAR" "$BASE/edit/$id" \
    | sed -n 's/.*updatedAt\\":\\"\([0-9T:.Z-]*\)\\.*/\1/p')"
  if [ -z "$seen" ]; then
    fail "$1: no draft timestamp in /edit/$id"
    return 0
  fi
  ok "$1: the editor serves its draft"

  api PUT "/api/drafts/$id" "{\"title\":\"$2\",\"markdown\":\"$4\",\"seen\":\"$seen\"}" \
    200 "$1: document saved"
  PAGE_ID="$id"
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
#
# **Nine of the ten tables in `prisma/schema.prisma`, and the two exceptions are stated rather
# than left to be noticed.** `User` and `SpaceMembership` are not counted because nothing in this
# script writes a row to either: every `sign_in` is an **upsert** of one of the three seeded
# emails, and a membership exists only where the seed put one. Enumerated against the schema and
# checked, not assumed — the e2e suite's own count contract was found missing a `BugReport` column
# in Phase 4 Task 6 exactly because "it writes nothing" had been assumed there. Widen this the day
# the script signs in as an address the seed does not create, or joins anybody to a space.
#
# **Phase 4 adds no table**, checked the same way: `Page.searchVector` and
# `PageVersion.searchText`/`searchHeadings` are columns on tables already counted here, and the
# search index is a GIN index over one of those columns rather than a row anywhere. So the search
# pass's cleanup contract is the existing nine numbers, unchanged.
#
# **Phase 5 does add one**, and `GitJob` is counted here from the task that creates the table
# rather than from the task that writes to it. Task 4 makes publish, move, delete and restore each
# enqueue a row, so this script starts creating them the moment that lands; a column added later
# would leave exactly those tasks unwatched, which is the same "the contract could not see the
# only write" gap Phase 4 Task 6 closed after the fact. `GitJob` cascades from `Page`, so `sweep()`
# below needs no statement of its own — and this number is what proves that rather than assumes it.
counts() {
  psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -d badam -tAX -v ON_ERROR_STOP=1 -c "
    select format(
      '%s spaces / %s pages / %s versions / %s drafts / %s audit / %s redirects / '
      || '%s relations / %s bug reports / %s git jobs / %s soft-deleted',
      (select count(*) from \"Space\"),
      (select count(*) from \"Page\"),
      (select count(*) from \"PageVersion\"),
      (select count(*) from \"PageDraft\"),
      (select count(*) from \"AuditLog\"),
      (select count(*) from \"Redirect\"),
      (select count(*) from \"PageRelation\"),
      (select count(*) from \"BugReport\"),
      (select count(*) from \"GitJob\"),
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

# That the form offers a space at all is its own check: `listEditableSpaces` drops a space this
# editor can read but not write, and an empty select means the form renders a "nowhere to create
# a page" message instead of inputs. `author_page` re-fetches the form and re-reads the same
# `<select>` for the id it creates in; this asserts the property, that one uses the value.
# `|| :` so a transport failure surfaces as the named check below rather than as `set -e`
# abandoning the run before Teardown can sweep.
curl -s -b "$JAR" -o "$FORM" "$BASE/new" || :
[ -n "$(space_option)" ] && ok "the create form offers a space to create in" \
  || fail "no space in the create form — /new rendered no spaceId options"

author_page "$SLUG" "Smoke page" "DOC" "$MARKER\\n"

if [ -n "$PAGE_ID" ]; then
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

step "Doc lifecycle"
# Phase 3, Task 13. An ADR is published, a second ADR supersedes it, and the first is asked — in
# a production build, from a cold start, over plain HTTP — to be `SUPERSEDED`, to still read, and
# to be listed alongside its replacement in the generated index.
#
# **Both ADRs are fixtures this script created, and that is a cleanup decision.** A cascade is
# the one write here that lands on a page the request never names, and a status written onto a
# *seeded* page is the one thing `sweep` could not take back: there is no record of what that
# page's status was before. So the page this pass retires is one it made, and the sweep removes
# it whole.
#
# **`status:` is in the document, not in the request**, and that is the mechanism rather than a
# shortcut. The publish route reads no body at all — the editor's status picker writes the
# document's own `status:` line and lets the next publish read it — so a saved document carrying
# `status: ACCEPTED` is exactly what that picker produces, reached without a browser.
#
# **`ACCEPTED` on the first publish of each, which is where the publish count comes from.** A
# cascade fires only on a publish into `ACCEPTED` (an ADR published at `PROPOSED` records the
# relation and leaves its target alone — correct, and not what this pass is checking), and it
# must land a transition `PUBLISHABLE_INTO` allows, which for `SUPERSEDED` means the target is
# `ACCEPTED` too. `ADR: DRAFT -> [PROPOSED, ACCEPTED]` lets each page get there in one publish.
sign_in "aisyah@example.com"

author_page "$ADR_RETIRED" "$ADR_RETIRED_TITLE" "ADR" \
  "---\\nstatus: ACCEPTED\\n---\\n\\n$ADR_RETIRED_MARKER\\n"
RETIRED_ID="$PAGE_ID"

if [ -n "$RETIRED_ID" ]; then
  api POST "/api/pages/$RETIRED_ID/publish" "" 200 "the first ADR published"
  body_has '"status":"ACCEPTED"' "and landed at ACCEPTED, asked for by its own status: line"
  expect_body "/engineering/$ADR_RETIRED" "$ADR_RETIRED_MARKER" "the first ADR reads"

  author_page "$ADR_LIVE" "$ADR_LIVE_TITLE" "ADR" \
    "---\\nstatus: ACCEPTED\\nsupersedes: $ADR_RETIRED\\n---\\n\\n$ADR_LIVE_MARKER\\n"
  LIVE_ID="$PAGE_ID"
fi

if [ -n "$RETIRED_ID" ] && [ -n "${LIVE_ID:-}" ]; then
  api POST "/api/pages/$LIVE_ID/publish" "" 200 "the superseding ADR published"
  body_has '"status":"ACCEPTED"' "and it too landed at ACCEPTED"
  # An EMPTY `dormant` is the cascade reporting that it fired. The same publish at `PROPOSED`
  # answers 200 with the relation listed here and the other page untouched, so without this the
  # pass could quietly decay into checking that a publish returns 200.
  body_has '"dormant":\[\]' "the cascade fired rather than being reported dormant"

  # §6.4, and the half of it that is easy to lose: retiring a document must not remove it.
  expect_status "/engineering/$ADR_RETIRED" 200 "the superseded ADR still answers 200"
  expect_body "/engineering/$ADR_RETIRED" "SUPERSEDED" "and carries the retired status"
  expect_body "/engineering/$ADR_RETIRED" "This document has been superseded." \
    "the banner says what happened"
  expect_body "/engineering/$ADR_RETIRED" \
    "$(rel_row 'Superseded by' "$ADR_LIVE" "$ADR_LIVE_TITLE")" \
    "and names the replacement, by §6.2's inverse label, as a link"
  expect_body "/engineering/$ADR_RETIRED" "$ADR_RETIRED_MARKER" \
    "with the body it was published with still whole"

  # The stored direction of the same row, read from the other end. It survives the cascade being
  # disabled — correctly, since the row is written at PROPOSED too — so it is asserting the
  # relation and not the retirement.
  expect_body "/engineering/$ADR_LIVE" \
    "$(rel_row 'Supersedes' "$ADR_RETIRED" "$ADR_RETIRED_TITLE")" \
    "the replacement lists the page it retired, in the stored direction"

  # The generated index — spec §11. Both are listed, because a retired ADR is history and not a
  # deletion, and the status filter separates them.
  expect_body "/engineering/-/adrs" "$(idx_row "$ADR_RETIRED")" \
    "the ADR index lists the retired one"
  expect_body "/engineering/-/adrs" "$(idx_row "$ADR_LIVE")" "and the one that replaced it"
  expect_body "/engineering/-/adrs?status=SUPERSEDED" "$(idx_row "$ADR_RETIRED")" \
    "filtering to SUPERSEDED keeps the retired one"
  expect_absent "/engineering/-/adrs?status=SUPERSEDED" "$(idx_row "$ADR_LIVE")" \
    "and drops the one still in force"
else
  fail "doc lifecycle pass skipped: both ADRs are needed and one was not created"
fi

step "Search"
# Phase 4, Task 7. §13's search and §6.4's demotion, over plain HTTP against a production build:
# a word unique to a published page finds that page, and once the page is retired it is still
# found and ranks **below** a live match.
#
# **Searched as the editor and not as the super admin, and that is a cleanup decision** — the same
# one the lifecycle pass takes about which page it retires. A super admin resolving a `MEMBERS`
# space they hold no role in writes a `space.access` audit row, and that row carries a `spaceId`
# and **no `pageId`**, so `sweep` — which keys audit rows on the page ids this script created —
# could not take it back, and Teardown's count comparison would fail on a row the script meant to
# write. `aisyah` is a member of `engineering`, so `needsAccessAudit` is false and search writes
# nothing at all.
sign_in "aisyah@example.com"

# The affordance, over HTTP, because PROGRESS records this failure twice: `/search` shipped with
# nothing linking to it, and Phase 2's `movePage` shipped as a library function with no caller and
# cost a whole extra task to reach. A route nobody can get to passes every test written about the
# route. The href is in the needle — a link with no destination is not a way in.
expect_body "/engineering" 'topbar-search" href="/search"' "the reader offers a way into search"

author_page "$SEARCH_RETIRED" "$SEARCH_RETIRED_TITLE" "ADR" \
  "---\\nstatus: ACCEPTED\\n---\\n\\n$SEARCH_BODY\\n"
SEARCH_RETIRED_ID="$PAGE_ID"

if [ -n "$SEARCH_RETIRED_ID" ]; then
  api POST "/api/pages/$SEARCH_RETIRED_ID/publish" "" 200 "the page that will be retired published"
  # `ACCEPTED`, asked for by the document's own `status:` line — and it is the status a retirement
  # has to come *from*: `ADR: ACCEPTED -> [ACCEPTED, SUPERSEDED, DEPRECATED]`, while `DRAFT`
  # reaches neither terminal status.
  body_has '"status":"ACCEPTED"' "at ACCEPTED, which is where a retirement has to start"

  expect_body "/search?q=$NEEDLE" "$(q_row "$SEARCH_RETIRED")" \
    "a word unique to the published page finds it"
  # The count sentence, which is what makes the row above a *result* and not the term being echoed
  # back — see `q_row`. It is also the non-vacuity companion for the ordering check further down:
  # it says the needle matches exactly one page in the whole corpus before a second one exists, so
  # "2 pages match" later is two pages this pass published and not one of them plus a seeded page.
  expect_body "/search?q=$NEEDLE" 'q-count">One page matches' "and it is the only match"

  author_page "$SEARCH_LIVE" "$SEARCH_LIVE_TITLE" "DOC" "$SEARCH_BODY\\n"
  SEARCH_LIVE_ID="$PAGE_ID"
fi

if [ -n "$SEARCH_RETIRED_ID" ] && [ -n "${SEARCH_LIVE_ID:-}" ]; then
  api POST "/api/pages/$SEARCH_LIVE_ID/publish" "" 200 "the page that stays in force published"
  body_has '"status":"CURRENT"' "at CURRENT, so one of the two matches is live"

  # **Retiring is a second publish, not a status write.** An ADR cannot go from `DRAFT` to a
  # terminal status, and there is no route that writes a status — the editor's picker writes the
  # document's own `status:` line and the next publish reads it, which is what these two calls are.
  #
  # `"seen":null`, and a **201** rather than a 200: the publish above deleted the draft, so there
  # is no timestamp to echo back and `null` is the true claim that none exists — `decideSave`
  # answers `create`, which the route reports as 201. That `null` is only true *because* the page
  # was published first, and it is one of the four rows of `decideSave`'s table rather than three:
  # measured, with that publish skipped, this same call answers **409 `conflict`**, because a
  # `null` seen against a draft that does exist is a claim the repository refuses.
  api PUT "/api/drafts/$SEARCH_RETIRED_ID" \
    "{\"title\":\"$SEARCH_RETIRED_TITLE\",\"markdown\":\"---\\nstatus: SUPERSEDED\\n---\\n\\n$SEARCH_BODY\\n\",\"seen\":null}" \
    201 "the retirement is saved as a new document"
  api POST "/api/pages/$SEARCH_RETIRED_ID/publish" "" 200 "and published a second time"
  body_has '"status":"SUPERSEDED"' "which retires the page"

  # §6.4's first half, which is the one that is easy to lose: a retired document stays findable,
  # with the status a person searching for a decision needs to see.
  expect_body "/search?q=$NEEDLE" \
    "$(q_retired_row SUPERSEDED "$SEARCH_RETIRED" "$SEARCH_RETIRED_TITLE")" \
    "the retired page is still a result, carrying its status"
  expect_body "/search?q=$NEEDLE" 'q-count">2 pages match' "and both pages match the word"
  # §6.4's other half. **This cannot pass by accident, and the ordering of the two publishes above
  # is what buys that.** The two `ts_rank`s are identical (measured: 0.12158542 each), so with the
  # demotion removed the query falls through to its `publishedAt DESC` tiebreak — and the
  # retirement is the *later* publish, so the retired page would come **first**. Take
  # `RETIRED_RANK_FACTOR` out and this check fails; publish the live page last instead and it would
  # pass either way. It discriminates in the other direction too, measured while proving these
  # checks can fail: with the retirement skipped the page stays live and *later*, and this reports
  # `smoke-search-live is at byte 4021, which is not above smoke-search-retired at byte 3477`.
  expect_ranked "/search?q=$NEEDLE" "$SEARCH_LIVE" "$SEARCH_RETIRED" \
    "the retired page ranks below the live one"
else
  fail "search pass skipped: both pages are needed and one was not created"
fi

step "Git mirror"
# Phase 5, Task 9. §10 over plain HTTP against a production build: a publish reaches a real git
# repository, the file that lands there says what the version row says, and the commit's sha comes
# back to the page a reader looks at.
#
# **The tree is a temporary directory and the remote is a local bare repository**, so this runs
# without a network and still exercises the real push path — Task 5 measured that `push` with no
# remote *configured* is a no-op success, which would make the sha check below pass while nothing
# was ever pushed anywhere.
#
# **Published as the editor, not the super admin**, for the reason the search pass states: a super
# admin resolving a `MEMBERS` space they hold no role in writes a `space.access` audit row with a
# `spaceId` and no `pageId`, which `sweep` cannot key on and Teardown's count comparison would
# then fail on.
if [ -z "$MIRROR_TMP" ] || inside_checkout "$MIRROR_TMP"; then
  # `mktemp -d` honours `TMPDIR`, so this is reachable rather than theoretical — and the failure it
  # prevents is the worst one in the phase: `git commit` inside this checkout, mirroring fixtures
  # into the branch under test. `tests/setup/scratch.ts` makes the same check for the same reason.
  fail "refusing to mirror into '$MIRROR_TMP': it is inside this checkout. Unset TMPDIR."
else
  ok "the mirror's working tree is outside this checkout"

  git init --quiet --bare --initial-branch main -- "$MIRROR_REMOTE" \
    && ok "a bare content remote to push at" \
    || fail "could not create the bare remote at $MIRROR_REMOTE"

  # **The backlog the passes above left is drained first, and discovering it was this step's
  # surprise.** Every publish enqueues a `GitJob`, and so does every move, delete and restore — so
  # by the time this step runs, the authoring, lifecycle and search passes have queued **nine**
  # jobs, and the first worker run mirrored all nine (measured: `9 done, 0 retrying, 0 failed`).
  # The first version of this step asserted `1 done` and `1 commit` against that and failed
  # honestly, which is the check working.
  #
  # Draining them here does two jobs. It is the precondition for everything below — "one job done"
  # is a statement about *this* pass's publish only once the backlog is gone — and it is a check in
  # its own right: every change this cold-start run made reaches a real repository, through a real
  # push, without one failure.
  #
  # **The count is deliberately not asserted**, unlike the drain below it. It moves with every pass
  # added above this one, and a number that has to be edited when an unrelated pass grows is a
  # number that ends up lying. What is asserted is that none of those jobs failed or is retrying.
  worker_drain "the queue the earlier passes left"
  grep -q "0 retrying, 0 failed" "$WLOG" \
    && ok "and every change this run had already made is mirrored" \
    || fail "the backlog did not drain cleanly: $(tr -d '\r' < "$WLOG" | tail -c 300)"

  BASE_COMMITS="$(git -C "$MIRROR_ROOT" rev-list --count HEAD 2>/dev/null)" || BASE_COMMITS=0
  ok "the mirror holds $BASE_COMMITS commit(s) before this pass publishes"

  sign_in "aisyah@example.com"
  author_page "$MIRROR_SLUG" "$MIRROR_TITLE" "DOC" "$MIRROR_MARKER\\n"
  MIRROR_ID="$PAGE_ID"

  if [ -z "$MIRROR_ID" ]; then
    fail "git mirror pass skipped: the page to mirror was not created"
  else
    api POST "/api/pages/$MIRROR_ID/publish" "" 200 "the page to mirror published"
    # The version id, from the publish's own response — it is what the mirrored file must name and
    # what carries the sha afterwards, and reading it here is what makes those two assertions about
    # the same row rather than about whatever the newest row happens to be.
    VERSION_ID="$(sed -n 's/.*"versionId":"\([^"]*\)".*/\1/p' "$OUT")"
    [ -n "$VERSION_ID" ] && ok "the publish names the version it created" \
      || fail "no versionId in the publish response: $(tr -d '\n' < "$OUT" | head -c 200)"

    worker_drain "the publish this pass just made"
    # **Exactly one job, which is a guard rather than pedantry** now that the backlog is drained. A
    # worker takes every claimable job in the database it is pointed at, which here is the
    # developer's own `badam` — so if a page outside this script had one queued, this says so
    # instead of that page being mirrored into a temporary tree in silence.
    grep -q "1 done, 0 retrying, 0 failed" "$WLOG" \
      && ok "and reported exactly one job done" \
      || fail "the drain summary was not one job done: $(tr -d '\r' < "$WLOG" | tail -c 300)"

    MIRROR_FILE="$MIRROR_ROOT/engineering/$MIRROR_SLUG.md"
    if [ ! -f "$MIRROR_FILE" ]; then
      fail "nothing was mirrored at engineering/$MIRROR_SLUG.md under $MIRROR_ROOT"
    else
      ok "the mirror wrote engineering/$MIRROR_SLUG.md"
      # The file *parses back to the version*, asserted line by line because this is bash and the
      # canonical block is one key per line. `^…$` on each, so a value appearing inside another
      # key's value cannot satisfy it — the same reason `idx_row` binds its own cell.
      mirror_has "^version: $VERSION_ID$" "and named the version that was published"
      mirror_has "^title: $MIRROR_TITLE$" "with the title as a single scalar key"
      mirror_has "^space: engineering$" "the space it belongs to"
      mirror_has "^path: $MIRROR_SLUG$" "the path it sits at"
      mirror_has "^status: CURRENT$" "and the status it was published into"
      # Not the title: a mirror that wrote a canonical block and dropped the body would pass every
      # line above.
      mirror_has "$MIRROR_MARKER" "and the body it was published with"
    fi

    SHA="$(git -C "$MIRROR_ROOT" rev-parse HEAD 2>/dev/null)" || SHA=""
    COMMITS="$(git -C "$MIRROR_ROOT" rev-list --count HEAD 2>/dev/null)" || COMMITS="none"
    [ "$COMMITS" = "$((BASE_COMMITS + 1))" ] \
      && ok "one publish added exactly one commit ($BASE_COMMITS -> $COMMITS)" \
      || fail "the mirror went from $BASE_COMMITS to $COMMITS commit(s) for one publish"

    # The sharper form of the same claim, and the one that survives a pass being added above:
    # exactly one commit in the whole history names this version. A retry that committed instead of
    # pushing would leave a **second** commit carrying the same `Version:` line, which is what the
    # commit/push split exists to prevent — `e2e/mirror-tree.spec.ts` drives that failure with a
    # remote that goes away, where this script only asserts the healthy shape.
    git -C "$MIRROR_ROOT" log --format=%B > "$OUT" 2>/dev/null || :
    NAMING="$(grep -c -- "$VERSION_ID" "$OUT")" || NAMING=0
    [ "$NAMING" = "1" ] && ok "and exactly one commit in the history names that version" \
      || fail "$NAMING commit message(s) name $VERSION_ID, wanted 1"

    # `psql` and not the smoke output of `counts()`: this reads one column of one row, and a value
    # that has to be compared against `rev-parse` cannot come from a `format()` whose failure is
    # swallowed. Same connection as `counts()` — the local server, `badam`, the developer's role.
    DB_SHA="$(psql -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" -d badam -tAX \
      -v ON_ERROR_STOP=1 -c \
      "select coalesce(\"gitSha\", '') from \"PageVersion\" where id = '$VERSION_ID'" 2>/dev/null)" \
      || DB_SHA="unreadable"
    if [ ${#SHA} -eq 40 ] && [ "$DB_SHA" = "$SHA" ]; then
      ok "the version carries the commit that mirrors it ($DB_SHA)"
    else
      fail "the version's gitSha is '$DB_SHA' and the tree's HEAD is '$SHA'"
    fi

    # The publisher authored it. Task 5 measured that the author email is the field a git host
    # matches to an account, which is why it is this one and not the name.
    AUTHOR="$(git -C "$MIRROR_ROOT" log -1 --format=%ae 2>/dev/null)" || AUTHOR=""
    [ "$AUTHOR" = "aisyah@example.com" ] \
      && ok "the commit is authored by the publisher" \
      || fail "the commit's author email is '${AUTHOR:-none}', wanted aisyah@example.com"

    # It really reached the remote, which is what "mirrored" means once one is configured.
    git ls-remote -- "$MIRROR_REMOTE" HEAD > "$OUT" 2>/dev/null || :
    if [ ${#SHA} -eq 40 ] && grep -q -- "$SHA" "$OUT"; then
      ok "the commit is on the bare remote"
    else
      fail "the remote's HEAD does not name $SHA: $(tr -d '\n' < "$OUT" | head -c 200)"
    fi

    # §10's other half, and the one a person sees: the sha in the repository is the sha on the
    # page. The needle is the `title` attribute, which carries the whole value — the visible text
    # is ten characters, and a ten-character prefix is satisfied by any commit sharing it.
    if [ ${#SHA} -eq 40 ]; then
      expect_body "/engineering/$MIRROR_SLUG" "sha\" title=\"$SHA\"" \
        "the reader shows the content commit for the version it renders"
    else
      fail "no sha to look for on the page"
    fi
  fi
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
# the page it retired. Phase 4's search pass adds two more pages and **three** versions — the page
# it retires is published twice — with no relation between them and no audit row beyond the create
# and publish ones, because it searches as a member and not as a super admin. Phase 5's git-mirror
# pass adds one more page, its version and the one `GitJob` its publish enqueued — which the drain
# leaves `DONE` rather than deleting, because deleting finished jobs would make "the job drained"
# and "no job was ever enqueued" the same observation. `GitJob` cascades from `Page`, so the sweep
# needs no statement for it and `counts()` is what proves that rather than assuming it.
# `sweep` removes all of it and then asserts it is gone, so this run leaves
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
