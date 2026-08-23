# Execution status

**Phase 1 is complete.** **Phase 2 (authoring) is in progress.**

Branch: `phase-1-foundations-reader` · **389 vitest + 8 Playwright tests passing** ·
cold-start smoke green · typecheck, build and `plan:check` clean · working tree clean

Plans: [phase 1](2026-08-21-docs-platform-phase-1-foundations-reader.md) ·
[phase 2](2026-08-23-docs-platform-phase-2-authoring.md) ·
[roadmap](2026-08-21-docs-platform-roadmap.md)

## Phase 2 — authoring

Decisions taken with the user: **CodeMirror 6** for the editing surface, **soft delete** for
removal. Fifteen tasks; see the plan for what Phase 2 deliberately leaves to Phases 3–6.

| Task | State |
|---|---|
| 1. Schema: drafts, redirects, audit, soft delete | ✅ |
| 2. Soft-delete predicate + enumeration guard | ✅ |
| 3. Slug and path rules | ✅ |
| 4. Draft repo and the conflict contract | ✅ |
| 5. Draft autosave endpoint | ✅ |
| 6. Creating a page | ✅ |
| 7. The editor (CodeMirror 6) | ✅ |
| 8. Server-rendered preview | ✅ |
| 9. Publishing | ✅ |
| **10. Moving a page — the landmine** | **next** |
| 11–15 | not started |

Findings already worth carrying:

- **The `deletedAt` index does not help the read path.** Measured at 60k rows: live pages are
  ~70% of the table, so the planner seq-scans with or without it. It is kept for the inverse
  query — listing deleted pages to restore.
- **A per-slug length cap does not bound `Page.path`.** Depth is unbounded, so 33 levels of
  legal 80-char slugs breach the btree index row limit (measured: 2600 bytes inserts, 2700
  fails with `exceeds btree version 4 maximum 2704`). `validatePath` guards the assembled
  path; create and move both call it. **Probe with incompressible text** — `repeat('x', 3000)`
  inserted happily because it compressed, and suggested there was no limit at all.
- **A concurrency test that never blocks is not testing a write predicate.** The obvious
  shape — fire two saves with `Promise.all`, assert exactly one wins — reads like a race test
  and is not one: with a real connection pool they stagger, so the loser re-reads, takes the
  conflict branch, and the write's `WHERE updatedAt = ?` is never consulted. Measured: with
  that predicate deleted, the `Promise.all` test passed 3 runs out of 3. Testing it needs the
  interleaving staged deterministically with a held row lock.
- **A coverage guard scoped to one file stops covering as soon as the thing it guards moves.**
  The soft-delete guard enumerated one module's exports; `saveDraft` queries `Page` from a
  different module and was invisible to it. It is now a filesystem sweep of `src/` for
  `db.page.*`, with the per-module enumeration inside. Both escape routes mutation-verified.
  **Then it was too narrow again**: `create.ts` does every query as `tx.page.*` inside an
  interactive transaction and has zero `db.page.*`, so the sweep saw nothing. Tasks 10 and 12
  are transactional too and would both have escaped. Now `/\b(?:db|tx)\.page\.\w+/`. Three
  times in one project the guard has been too narrow **and silent about it** — when writing
  one, ask what shape of the thing it would fail to see.
- **Check a comparison rule in both directions before calling it done.** `decideSave`
  documented, at length and convincingly, why "no `seen` but a draft exists" must be a
  conflict rather than an overwrite — and then answered `create` for the mirror case, "a
  `seen` but no draft". Once Task 9's publish deletes drafts, that silently resurrects a
  draft with pre-publish text over the version just published, returns 201 and tells nobody.
  Four cases, not three; write the table before the function.
- **Two project rules can conflict, and an implementer cannot resolve it.** "Extract a rule
  implemented twice" collided with "plan fences stay in sync" and "implementers do not edit
  plans": the control-character strip could not be shared out of `src/lib/bugs/schema.ts`
  because a Phase 1 whole-file fence quotes it. The agent duplicated it and escalated, which
  was right. Resolved by extracting to `src/lib/text/control.ts` and annotating the Phase 1
  fence as superseded. **Escalate a rule conflict; do not pick a side quietly.**

## Phase 1 — foundations and reader

All 15 tasks approved and every exit criterion verified.

| Task | State |
|---|---|
| 1. Scaffold + design tokens | ✅ approved |
| 2. Postgres schema + test harness | ✅ approved |
| 3. Permission module | ✅ approved |
| 4. Page schema + filtered reads | ✅ approved |
| 5. Markdown pipeline | ✅ approved |
| 6. Page tree builder | ✅ approved |
| 7. OIDC + viewer loader | ✅ approved |
| 8. Build version module | ✅ approved |
| 9. Seed script | ✅ approved |
| 10. Reader shell | ✅ approved |
| 11. Bug reporting | ✅ approved |
| 12. Page reader route | ✅ approved |
| 13. Space landing | ✅ approved |
| 14. Playwright E2E | ✅ approved |
| 15. Cold-start smoke test | ✅ approved |

## Test suite

128 vitest tests, 18 files: 88 pure unit (no database), 40 integration against real
Postgres. Plus 8 Playwright specs in `e2e/`, run separately with `npm run test:e2e`.

| File | Tests |
|---|---|
| `src/lib/users/gate.test.ts` | 15 |
| `src/lib/authz/can.test.ts` | 14 |
| `tests/integration/pages-repo.test.ts` | 12 |
| `src/lib/markdown/render.test.ts` | 12 |
| `src/lib/bugs/schema.test.ts` | 10 |
| `src/lib/pages/tree.test.ts` | 9 |
| `src/lib/spaces/landing.test.ts` | 8 |
| `src/lib/pages/href.test.ts` | 8 |
| `tests/integration/bug-route.test.ts` | 6 |
| `src/lib/version/build.test.ts` | 6 |
| `tests/integration/bug-context.test.ts` | 5 |
| `tests/integration/viewer.test.ts` | 4 |
| `tests/integration/user-upsert.test.ts` | 4 |
| `tests/integration/bug-report.test.ts` | 4 |
| `tests/integration/authz-where.test.ts` | 3 |
| `src/lib/auth/test-login.test.ts` | 3 |
| `src/lib/auth/providers.test.ts` | 3 |
| `tests/integration/spaces.test.ts` | 2 |

## Running it

```bash
./scripts/setup-db.sh   # idempotent: creates the badam role, both databases, and .env.test
npm run db:seed         # dev database only; prints "Seeded 2 spaces and 7 pages."
npm test
npm run test:e2e       # 8 Playwright specs; builds and serves on 3100 itself
npm run typecheck && npm run build
npm run plan:check      # reports plan fences that no longer match the code they quote
npm run smoke           # cold start: provisions, seeds, builds, serves, asserts, tears down
```

Postgres is the local Homebrew `postgresql@16` service on port 5432 — there is no container
runtime on this machine. The integration harness refuses to run unless `DATABASE_URL` names
a database ending in `_test`.

**Signing in locally:** set `ALLOW_TEST_LOGIN=1` and sign in at `/api/auth/signin` as
`aisyah@example.com` (member of engineering), `stranger@example.com` (member of nothing —
how 404-not-403 is demonstrated), or `efcorporates@gmail.com` (super-admin). A session
minted this way is revoked the moment the flag is turned off, because the token records
which provider minted it.

## Seeded data

Two spaces, seven pages, three users.

- `engineering` (**MEMBERS**) — 6 pages at depths 1/2/3, one deliberately unpublished.
  The three-deep page `architecture/mqtt-contracts/topic-registry` exists specifically to
  exercise the recursive nav rail.
- `handbook` (**ALL_STAFF**) — one published `welcome` page, so a viewer who belongs to
  nothing still sees something.
- `aisyah@example.com` EDITOR · `efcorporates@gmail.com` super-admin ·
  `stranger@example.com` member of nothing.

**The seed is idempotent.** Re-running it publishes a new `PageVersion` only when the title,
markdown or status actually differs from what is already published; an unchanged page is left
entirely alone, `publishedAt` included. It did not start that way — the original always called
`pageVersion.create`, so every run added six identical "Seed" versions (58 had accumulated) and
pushed `publishedAt` to "now", which also reshuffled "Recently published" on each run. Publish
timestamps are now fixed (`2026-08-20T09:00Z` plus a minute per page) rather than `new Date()`,
so a fresh database is reproducible. Page **titles** are still not updated on re-run —
`update: {}` leaves existing `Page` rows alone.

## Decisions that should not be relitigated

- **`readableSpace(viewer, ...and)` returns the complete Prisma `where` and must never be
  spread**, at any nesting depth. The spread form silently drops the permission predicate;
  both the top-level and nested-relation shapes were reproduced against Postgres.
- **Two sources of truth for membership, deliberately.** `can()` reads the in-memory
  `Viewer.memberships`; `readableSpace` filters on the `SpaceMembership` row in SQL. A
  synthetic viewer with a self-declared membership reads nothing — so testing the read path
  needs a real membership row.
- **Every query in `src/lib/pages/repo.ts` states its own permission predicate.** One rule,
  no exceptions based on call ordering.
- **Never `include:` in Prisma queries here** — it expands to a column list at generation
  time, so it starts shipping future columns with no diff to review.
- **`React.cache()` is inert outside an RSC render.** Do not try to verify the memoization
  from a unit test.
- **`trustHost: true` is required**, or every auth endpoint 500s in production while
  `next-auth` swallows the error and reports everyone as logged out.
- **`ALLOWED_EMAIL_DOMAINS` fails closed.** Empty denies everyone, deliberately: "nobody can
  sign in" is loud, "everybody can" is silent.
- **The nav rail renders recursively**, or a three-deep page is invisible while reachable by
  URL.
- **Sanitise before `rehype-slug`**, or heading ids become `user-content-*` and every table
  of contents anchor silently stops matching.
- **A test-login session dies when the flag does.** The JWT records its minting provider;
  without that a passwordless super-admin token is byte-identical to an OIDC one and cannot
  be revoked or audited. `AUTH_SECRET` must therefore be distinct per environment.
- **Drafts appear in the rail as inert text, not links.** `getPublishedPage` requires a
  published version, so a linked draft would 404 for everyone.
- **A signed-out deep link lands on the space root**, not the requested page. The layout has
  only the space key; preserving the full path needs middleware, which needs the auth config
  split into edge-safe and node halves. Deferred deliberately.
- **Bug-report page context is derived from `routePath`, never accepted from the client.**
  A client-supplied `pageId` could name a page in a space the reporter cannot read, which an
  admin would then see. Deriving it also means there is nothing to validate.
- **The bug endpoint caps on declared `Content-Length` before reading the body**, and
  rejects a *missing* length with 411 — `Number(null)` is 0, so a numeric-only check lets a
  chunked body through. The cap is 128KB because Zod counts UTF-16 units while
  `Content-Length` counts UTF-8 bytes, and a max-length CJK report is ~54KB.
- **`summary` is stored raw.** Encode at output; sanitising on write destroys the evidence.
  The control-character strip is `\p{Cc}` only (keeping newline, tab, return) because
  Postgres rejects NUL — `\p{C}` would also break ZWJ emoji and bidi marks.
- **`doc.css` is imported by the space layout, never by a page.** Importing it from a page
  route made `.doc` compute differently on a hard load than on a soft navigation to the same
  route — measured `max-width: none` versus `820px`.
- **Breadcrumbs take real titles and published state from the page tree**, not from the path
  string. Deriving labels from slugs disagreed with the nav rail beside it, and linking every
  ancestor prefix offered links to unpublished pages that 404 — the exact links the rail
  refuses to render.
- **A guard that asserts a class over a fixed corpus is testing the corpus.** The Playwright
  test "no page scrolls horizontally, whatever the content" was green for all of Phase 1 while
  the reader overflowed **4,660px** on a long heading — `doc.css`'s `overflow-wrap` guard
  stopped short of headings, and no seeded page has an unbreakable one. Found only when Phase
  2's preview pane rendered hostile content. Fixed in `doc.css`, not in the pane. Test a class
  by **injecting** the hostile case, not by hoping the fixtures contain it.
- **Lock the resource actually shared, not the biggest one to hand.** Create and move take a
  space-wide advisory lock because they rewrite paths. Publish does not touch paths, so it
  takes a `FOR UPDATE` row lock on the `PageDraft` row instead — its only competitors are
  another publish and an autosave of the *same page*. Reusing the space lock would serialise
  every publish in a space against every create and move over a resource none of them share.
- **No reader page may scroll horizontally.** An unbreakable token — an autolinked URL, a
  long mermaid identifier, a wide image — widens the document, and because the top bar and
  both rails are sticky in that scroll container they slide apart. Fixed three times in
  three shapes before being guarded as a class by a Playwright assertion on
  `scrollWidth === clientWidth`.
- **The bug dialog portals to `document.body`.** Rendered as a sibling of its trigger it sat
  inside `.rail-l`, which is `display: none` below 860px — taking the open dialog and the
  user's typed text with it.
- **"Published" means `publishedVersionId`, never `publishedAt`.** They are two independent
  nullable columns with no constraint tying them together. A query filtering on the
  timestamp alone survives an unpublish or a rollback and returns a row whose link 404s and
  whose byline has no author. State both.
- **Every link to a page goes through `pageHref`** (`src/lib/pages/href.ts`). `Page.path` has
  no format constraint, so a slug containing `#`, `?` or a space silently produces a broken
  link. Three sites needed this and two of them had grown their own divergent copy.
- **A rule implemented in two places is not yet a convention.** The draft-is-inert rule and
  the path-encoding rule were each honoured by the nav rail and the breadcrumbs and then
  quietly dropped by the third link site to be written. Both times the fix was to make the
  rule a shared function rather than a habit.
- **Importing the Prisma client loads `.env` into `process.env`.** A test that clears an
  env var and then imports anything touching Prisma gets the file's value back — and for
  `ALLOW_TEST_LOGIN` that fails *open*: the test passes against a build that registers the
  passwordless login unconditionally. Stub the module, not the environment.
- **`next-auth` must be inlined for vitest** (`server.deps.inline`). It imports
  `next/server`, which Vite's node resolution cannot satisfy from an externalised dep.
- **E2E and smoke runs write to the dev database.** The bug-reporting checks insert a real
  row; delete it after. Only these two suites touch `badam` — everything else uses
  `badam_test`.
- **The seed must stay idempotent.** `npm run smoke` and the E2E suite both re-seed the dev
  database, so anything that writes unconditionally there accumulates on every run.
- Implementers create a **new commit**, never `--amend`.

## Working method that has earned its keep

- **Read each task section verbatim and diff it against HEAD before dispatching.** Four
  times a later task's text would have reverted an earlier fix — a vitest glob narrowed back
  to `.ts`, a hardcoded `TRUNCATE` list restored over an introspected one, a stale file list,
  a reprinted `requireViewer()` call losing its callback.
- **Sync plan fences from source, but know there are three drift directions** and they need
  different handling. Getting this wrong left Task 10's section describing a `NavLink` that
  had not existed for twenty commits:
  | Direction | Correct action |
  |---|---|
  | Plan specifies something not yet built | Dispatch it, or mark it pending |
  | Code changed by the task's **own** fix rounds | Sync the fence |
  | Code replaced by a **later** task | Leave it; note the supersession |

  And sync **only whole-file fences**. Some steps show a fragment — "append this function
  to the file" — and a blind sync replaces the fragment with the entire file, turning an
  append step into a replace step. Done once, caught by eye — which is not a control, so
  `npm run plan:check` now encodes it: a fence that appears verbatim *inside* the file it
  quotes is a FRAGMENT and is never a sync candidate.

  The backlog it first reported — 20 fences that no longer matched the file they quoted —
  is cleared, and `plan:check` now reports **0 drifted**. Git history decided each one:
  **7 had drifted from their own task's fix rounds and were synced**; **13 were snapshots a
  later task changed and are now annotated** with what changed and where to read the current
  version. Syncing those 13 would have been actively wrong — it would have put Playwright in
  Task 1's scaffold and Task 4's models in Task 2's schema.

  Keep that split when new drift appears: **`git log -- <file>` tells you which it is.** If
  every commit touching the file belongs to the fence's own task, sync it; if a later task
  changed it, annotate instead.
  Syncing after a task's first commit is not enough — most tasks here needed two or three
  fix rounds, and each one moves the code out from under the plan.
- **A forward plan edit is not a code change.** Amending the plan to specify something new
  creates drift until a task actually ships it — which happened once: the plan gained
  `id: true` on a Prisma select that the file never got, and the next task built a
  workaround around an accurate description of stale code. Either dispatch the change or
  note it as pending; do not leave the plan describing a future that has not happened.
- **Mutation-test any test whose job is to catch a catastrophic failure.** The tree builder's
  cycle tests could not detect a cyclic result until they were mutation-tested; the helper's
  docstring claimed a property it did not check.
- **Reproduce the class, not the instance.** Three fixes this session were mis-sized: one
  too broad (`\p{C}` for a NUL problem, which mangled emoji and bidi text) and two too
  narrow (a byte cap derived from character counts; an image-only fix for a general overflow
  class). Too broad gets caught, because it breaks something visible. **Too narrow does
  not** — the reported case genuinely disappears and the class stays open.
- **A bucket for "cannot classify" must be printed, not just counted.** The fence checker
  quietly binned anything whose first line disagreed with its file, and a stale `RailFoot`
  snapshot — rewritten enough that even its first line changed — sat in that bucket
  reported as a number. It surfaced only once the tool used the plan's own "Step N: Create
  `x`" wording to decide when a fence *claims* to be a whole file. Same failure shape as the
  three mis-sized fixes: too narrow, and silent about it.
- **Only ever stage explicit paths while a subagent is live.** A `git add -A` once swept an
  implementer's in-flight work into an unrelated commit.
- **Ask a reviewer to name which mutant each test kills.** It is the only question that has
  reliably separated a test that pins behaviour from one that merely runs it. On Task 13 it
  found that three real mutations — uncounted nested drafts, only the first module
  summarised, and every module link pointing at the wrong URL — passed the whole suite, and
  that one test could not fail at all, because `[].map(anything)` is `[]`.
- **A fixture whose fields all default to the same value cannot catch a field mix-up.**
  `slug`, `path` and `title` all defaulted to the node id, so swapping `path` for `slug` in
  the implementation was invisible. Give every field a distinguishable default.
- **Verifying a fix by hand is not the same as verifying its class.** The pluralisation fix
  landed on `page/pages` and left `draft` singular directly beside it, and the seed has
  exactly one draft, so every by-hand check of that line looked right.

## Offboarding a user

Not what you would guess. Deleting a `User` row is **not** offboarding — the next sign-in
upserts it back. Delete their `SpaceMembership` rows (the only immediate lever), revoke at
the IdP (stops future sign-ins), and leave the `User` row alone (it carries authorship).
`session.maxAge` is 8 hours, so IdP revocation bites within a working day.
