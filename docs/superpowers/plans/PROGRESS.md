# Phase 1 execution status

Branch: `phase-1-foundations-reader` · 87 commits · **105 tests passing** · typecheck
and build clean · working tree clean

Plan: [`2026-08-21-docs-platform-phase-1-foundations-reader.md`](2026-08-21-docs-platform-phase-1-foundations-reader.md)
· Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md)

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
| **13. Space landing** | **next — validated, ready to dispatch** |
| 14. Playwright E2E | not started |
| 15. Cold-start smoke test | not started |

## Test suite

105 tests, 15 files. 55 pure unit (no database), 50 integration against real Postgres.

| File | Tests |
|---|---|
| `src/lib/users/gate.test.ts` | 15 |
| `src/lib/authz/can.test.ts` | 14 |
| `src/lib/markdown/render.test.ts` | 12 |
| `src/lib/pages/tree.test.ts` | 9 |
| `tests/integration/pages-repo.test.ts` | 8 |
| `src/lib/version/build.test.ts` | 6 |
| `src/lib/auth/test-login.test.ts` | 3 |
| `src/lib/bugs/schema.test.ts` | 8 |
| `tests/integration/bug-context.test.ts` | 5 |
| `tests/integration/bug-route.test.ts` | 6 |
| `tests/integration/bug-report.test.ts` | 4 |
| `tests/integration/user-upsert.test.ts` | 4 |
| `tests/integration/viewer.test.ts` | 4 |
| `tests/integration/authz-where.test.ts` | 3 |
| `tests/integration/spaces.test.ts` | 2 |

## Running it

```bash
./scripts/setup-db.sh   # idempotent: creates the badam role, both databases, and .env.test
npm run db:seed         # dev database only; prints "Seeded 2 spaces and 7 pages."
npm test
npm run typecheck && npm run build
npm run smoke           # from Task 15: provisions, seeds, builds, serves, asserts, tears down
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

Re-running the seed updates page **markdown** (a new version is published) but not page
**titles** — `update: {}` leaves existing `Page` rows alone.

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
- **No reader page may scroll horizontally.** An unbreakable token — an autolinked URL, a
  long mermaid identifier, a wide image — widens the document, and because the top bar and
  both rails are sticky in that scroll container they slide apart. Fixed three times in
  three shapes before being guarded as a class by a Playwright assertion on
  `scrollWidth === clientWidth`.
- **The bug dialog portals to `document.body`.** Rendered as a sibling of its trigger it sat
  inside `.rail-l`, which is `display: none` below 860px — taking the open dialog and the
  user's typed text with it.
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
  append step into a replace step. Done once, caught by eye.
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
- **Only ever stage explicit paths while a subagent is live.** A `git add -A` once swept an
  implementer's in-flight work into an unrelated commit.

## Offboarding a user

Not what you would guess. Deleting a `User` row is **not** offboarding — the next sign-in
upserts it back. Delete their `SpaceMembership` rows (the only immediate lever), revoke at
the IdP (stops future sign-ins), and leave the `User` row alone (it carries authorship).
`session.maxAge` is 8 hours, so IdP revocation bites within a working day.
