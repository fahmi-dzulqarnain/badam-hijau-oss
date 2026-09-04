# Phase 7 — Systems, administration and review

Spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)
(§7, §11's `/systems` and `/admin/*`, §12's review clause, §5.2 `System`/`PageSystem`, §17) ·
Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md)

Branch: `phase-7-systems-admin-review`, cut from `main` at `e9377ed`. This phase lands through a PR.

**This is the roadmap's sixth and last phase, and it is numbered 7.** Attachments were planned as
Phase 4, became 5, and landed as 6 — under the rule that branch recorded and this one keeps: *the
phase that reaches `main` first keeps its number, because renumbering a shipped phase rewrites
closed exit criteria.* Attachments merged as `e9377ed`, so this one is 7. The roadmap's own table
still says six phases and that is not wrong: there are six, numbered 1–7 with no 4 in this track.

**Deliverable.** A systems catalogue that pages declare themselves into, with a generated page per
system listing the documentation that affects it. Administration for spaces, members, systems, the
git mirror and bug reports. A due-for-review list per space, and a way for an owner to confirm a
review without publishing.

## Decisions taken before writing this

- **Attachments are not in this phase.** §17's S3-with-presigned-URLs was superseded by decision
  D12 on the attachments branch: the store is a SharePoint library over Microsoft Graph, because
  Graph's pre-authenticated URLs are bearer capabilities that cannot express this application's
  permissions. Built and merged. Nothing here revisits it.
- **`/admin/git` absorbs `/-/mirror`** rather than sitting beside it. Phase 5 Task 8 shipped that
  route as explicitly provisional — "Phase 6 owns the real `/admin` and will fold this in" — and
  two surfaces for one thing is how one of them goes stale.
- **Three debts Phase 5 named and deferred are paid here**, because this is the phase whose
  surfaces make them fixable: `Space.key` has no validation (Task 6), finished `GitJob` rows have
  no retention pass (Task 7), and versions published before the mirror existed are never
  reconciled (Task 7).

## What Phase 7 does NOT do

- **Re-open attachments, SSO, or the Entra cutover.** Merged.
- **A per-system C4 diagram.** §7 says the catalogue "doubles as … the inventory behind C4
  container diagrams". Being the inventory is this phase; generating diagrams from it is not, and
  a generated diagram nobody asked for is a maintenance burden with no reader.
- **Cross-space activity on `/`.** §11's home row says "recent activity across them". The home
  route exists and this phase does not rebuild it; the due-for-review list is per space, where
  §11 puts it.
- **A second permission axis.** §7: *"Systems are global, not owned by a space, and carry no
  permissions of their own."* A system is a label, not a container.

## Landmines

**A system page aggregates across spaces by design, and that is a new shape of leak.** Every read
before this one was scoped to a space the URL named. `/systems/[key]` lists "ADRs affecting it,
its runbooks, open RFCs" from wherever they live — so without a readable-space filter in SQL it
becomes a cross-space enumeration of titles and paths. Phase 4's search solved exactly this
shape: derive the readable space ids from `readableSpace` and filter in the query, never after
fetching. Two staff with different memberships must get different lists from the same URL, and
the test needs a **discrimination**, not an absence — Phase 4's non-member search was
near-vacuous until it became one.

**The `systems:` keys authors have already written must not silently vanish.** Phase 3 accepted
the key, shape-checked it, and deliberately did not validate it against a catalogue that did not
exist — recording the failure it was deferring: *"the author writes their systems, publish drops
them, and the page ships with an empty facet."* This phase is where that becomes reachable, so an
unknown key is a decision with a visible consequence: refuse the publish, or accept and report.
Whichever it is, **silently dropping is the one answer that is wrong**, and the seeded corpus must
be checked for keys that no longer resolve before the rule is chosen.

**Confirming a review must move nothing else.** §12: *"Confirming a review updates `reviewedAt`
without creating a version."* So it writes no `PageVersion`, enqueues no `GitJob`, and must leave
`Page.searchVector` byte-identical — Phase 4 measured that the vector's inputs are title,
headings and body, and that a status or path change leaves it unchanged. Assert the
byte-identity, with the non-vacuity companion that proves `reviewedAt` really moved.

**`/admin` is a static top-level segment, and space keys are unvalidated.** Phase 5 Task 8
measured this precisely for `/-/mirror`: a static route beats every dynamic one, so a space keyed
`admin` loses exactly the paths the admin routes occupy — one path deep per route. Task 6 makes
that unreachable going forward by validating `Space.key`, which is why the two tasks are in one
phase; say in the plan which order they land in and what the window is.

**Validating `Space.key` runs against a populated table.** Two rows exist (`engineering`,
`handbook`) and both are already legal, so the constraint is clean today — but the check must be
the *same function* the create form calls, and a folded-uniqueness constraint added to a
populated table is the shape Phase 3 Task 1 Step 3 warned about. Confirm rather than assume.

**Deleting a system that pages reference.** `PageSystem` is a join, so a cascade silently strips
the facet from documents that named it, and a `Restrict` blocks an admin with no way to see what
is blocking them. Decide, and make the admin surface show the count either way.

## Conventions that carry forward

Settled in Phases 1–6. Changing one is a decision, not a detail.

- `readableSpace(...)` and `visiblePage(...)` return complete `where` objects and **must never be
  spread**, at any depth. A system page and an admin page are queries like any other.
- Every query states its own permission predicate; none is guarded by call ordering.
- Never `include:`; always an explicit `select:`.
- **Every module that queries the database is registered** in `src/lib/pages/visible.test.ts`.
  That guard has been too narrow **seven times** and its sweep has been widened **six**; the last
  widening added `new PrismaClient` because both alternations were anchored on the names `db` and
  `tx`. Read its docstring first.
- Only `src/lib/audit/log.ts` may touch the `auditLog` delegate. A super admin reading across a
  boundary is an audited act — Phase 4 established it for search, Phase 5 Task 8 for the mirror.
- Control characters as **escapes, never literals**. Three literal NULs have been found in this
  repository, and the third hid an entire file from `rg` for a whole task.
- An absence assertion needs a viewer, or a fixture, that can see **something**.
- A refusal that survives deleting the guard it names is a test of some other guard.
- A concurrency test that never blocks is not testing a write predicate — and Phase 5 Task 6
  added the converse: with `SKIP LOCKED`, returning immediately *is* the predicate working.
- `npm run plan:check` must report **0 drifted** before a task is closed; never blind-sync a
  fence, and a superseded fence wants an annotation rather than a rewrite.
- Implementers make **small commits**, never `--amend`, and stage explicit paths. **Four** tasks
  in this project have been lost or nearly lost to a stalled agent; the last one survived only
  because its uncommitted tree happened to persist.
- `.env.test` is untracked and per-checkout. A variable added to `.env.example` with no default
  breaks every other checkout silently — that is how merging Phase 6 produced 27 failures here.

---

## Task 1: The catalogue ✅

**Files:** `prisma/schema.prisma`, a migration, `prisma/seed.ts`.

- [x] **Step 1: `System`, `SystemKind` and `PageSystem`**

Per spec §5.2 and `enum SystemKind { MOBILE_APP DEVICE_APP SERVICE LIBRARY }`. `PageSystem` is a
join and §7 says systems carry no permissions, so it holds no role and no visibility.

- [x] **Step 2: Seed the seven systems §7 names**

`store-ios`, `display-ios`, `order-hub`, `pricing-engine`, `backend`, `kiosk-bridge`, `admin-web`.
The seed is idempotent by contract and the dev baseline is asserted by `scripts/smoke.sh` and the
Playwright suites — Phase 2 made it idempotent and Phase 3 needed a *narrow repair* of a row
whose value had become invalid, because `upsert` with `update: {}` does not fix existing rows.
Extend the counts both places rather than deferring: Phase 4 found a count contract blind to the
only write a spec made.

- [x] **Step 3: Decide what a deleted system does to the documents that named it**

Cascade strips the facet silently; `Restrict` blocks an admin who cannot see why. Decide, and make
Task 5's surface show the reference count either way.

**`Restrict`, and the argument is stronger than "don't lose data".** A `PageSystem` row is a
*projection of authored frontmatter*, so a cascade would not lose a label — it would leave the
document's own text saying `systems: [order-hub]` with no row behind it, and nothing re-derives that
until someone happens to republish. The page and the database then disagree, with the page winning
on the reader's screen and the database winning on `/systems/[key]`. **Cascade does not drop a
facet; it manufactures a lie.** And `isActive` already exists, so deletion is the verb for a row
created in error — which by definition has no pages naming it, exactly the case `Restrict` never
blocks. `Restrict`'s weakness is a *surface* problem and this phase owns the surface; cascade's is
unfixable by any surface, the rows being gone.

**What that makes Task 5 owe:** the reference count beside every system so a refusal is predicted
rather than discovered; a refused delete that states the count *and* offers `isActive = false` in
the same place, or the admin ends up in psql; and the distinction that a **count** across spaces
the admin cannot read needs no audit, while **listing** the blocking pages is a cross-boundary
read and therefore an audited act.

**`System.key` is validated here, as a CHECK constraint**, and the free moment is now: on a
lowercase-only column `@unique` *is* folded uniqueness, so unlike `Space.key` in Task 6 there are
no pre-existing rows to retro-validate. It also hands Task 2 a **closed vocabulary** — a lookup of
a lowercased author key that finds no row means "not in the catalogue" and can never mean "present
under a different spelling". Deferred explicitly to Task 5: the field-level message and the length
cap, because a CHECK yields a Postgres error rather than a sentence an admin can act on, and
retyping `SLUG_MAX_LENGTH` into SQL would be a predicate stated twice with one copy untestable.

**This plan's framing of that debt was two-thirds right.** The route-shadowing half **does not
transfer**: `Space.key` is the first path segment and competes with `/admin`, `/search`,
`/systems`, `/new`, `/edit` and `/api`, while `System.key` sits under a static prefix with no
static siblings. What transfers is case folding and URL safety — and the decisive reason is one
this plan did not name: `System.key` is matched against **author-typed frontmatter** by Task 2,
which is Phase 3's "publish drops them" failure arriving from the other side.

**`update: {}` in the seed, and the repair clause was declined deliberately.** Phase 3 needed its
narrow repair because `DocStatus` is a *column type wider than the rule the product enforces* — the
vocabulary is per doc type and lives in application code, so the column could hold a value the
product cannot produce. Nothing on this table qualifies: `key` is the `where` and is now narrowed
by the database itself, every `SystemKind` is legal for every system, and the free-text columns are
what Task 5 exists to edit. A repair clause would be a guard that cannot fire. The cost is stated
in the file: a later change to a seeded system's `name` or `kind` lands only on a fresh database,
so **assertions should bind to a system's `key`**, the one column the upsert can never leave stale.

**`repoUrl` is a credential channel — Phase 5 Task 8's finding arriving somewhere new.** Real
checkouts on this machine carry remotes of the form `https://oauth2:<token>@gitlab…`, which is
exactly what an admin would paste into Task 5's form, and Task 3 renders `repoUrl` as a link to
**every signed-in reader**. The seed stores the credential-free form and deliberately does *not*
repair anything, because a repair over seven seeded rows would read as coverage. **Task 5 owes a
refusal of embedded userinfo on write, and Task 3 owes not linking one if it is somehow stored** —
two ends, because Phase 5's lesson was that removing either alone still leaks.

**`SystemKind` is too narrow for the estate §7 names.** There is no web-app kind, so `admin-web` is
filed as a `SERVICE` — a gap in a normative enum rather than a classification insight. Recorded
rather than fixed, because widening a §5.2 enum is a spec change and `kind` is a reader-visible
label; if Task 3's page reads badly, that comment is where the evidence for a `WEB_APP` value goes.
`MOBILE_APP` versus `DEVICE_APP` also had to be *decided* — both are iPads here, so it is who
operates it: a cashier drives `store-ios`, while `display-ios` faces the customer with no operator.

**`PageSystem` has no normative column list anywhere** — §5.2's sketch stops at `System` and the
join appears only as prose. So the composite primary key, the index direction and `Restrict` are
all this task's choices, argued in the file. `System` also has **no `createdAt`**, a deliberate
divergence from every other model: nothing reads it, §7's metadata list omits it, and "who added
this and when" is what `AuditLog` answers for Task 5's mutations.

---

## Task 2: Resolving what authors already wrote

**Files:** `src/lib/systems/resolve.ts`, `src/lib/pages/publish.ts` + tests.

- [ ] **Step 1: Measure the seeded corpus first**

Before choosing a rule, find out which `systems:` keys exist in the dev database and the seed and
whether they resolve against Task 1's catalogue. The rule is a decision about real data, not a
hypothetical.

- [ ] **Step 2: Resolve at publish, inside the transaction that already exists**

§9 step 3 puts `PageSystem` rows in the publish transaction. Phase 5 Task 4 established the
pattern and the trap: use `tx`, never `db`, and note that for publish the mistake **times out on
a lock** rather than committing silently.

- [ ] **Step 3: An unknown key is reported, never dropped**

Refuse the publish or accept and report — but the author must see it. Phase 3's own note is the
specification for the failure to avoid.

---

## Task 3: `/systems` and `/systems/[key]`

**Files:** `src/lib/systems/read.ts`, routes + tests.

- [ ] **Step 1: The catalogue index**

Metadata per §7: kind, owning team, repo, active or sunsetting.

- [ ] **Step 2: The per-system page, filtered by readable space in SQL**

Grouped by doc type — ADRs affecting it, its runbooks, open RFCs. The readable set is derived from
`readableSpace`, exactly as `src/lib/search/query.ts` does it, because `readableSpace` returns a
Prisma `where` and does not compose into raw SQL.

- [ ] **Step 3: Two viewers, one URL, different lists**

A discrimination test: a member of one space and a member of the other must both see *something*
and not the same thing. An empty list for one of them proves nothing.

---

## Task 4: Due for review

**Files:** `src/lib/pages/review.ts`, the space landing, a confirm action + tests.

- [ ] **Step 1: The interval is configuration**

§17 lists "review interval in months" as an environment variable, default twelve. It is absent
from `.env.example` — add it there too, or every other checkout breaks silently.

- [ ] **Step 2: The list on `/[space]`**

§11: the space landing shows modules, recently published, and due for review.

- [ ] **Step 3: Confirming a review writes one column**

No version, no `GitJob`, and `Page.searchVector` **byte-identical** — asserted, with a companion
proving `reviewedAt` moved. Who may confirm is a decision: §12 says "whose owner has not confirmed
them", which is not the same as anyone with `EDIT`.

---

## Task 5: `/admin/systems`

**Files:** routes, `src/lib/systems/admin.ts` + tests.

- [ ] **Step 1: Manage the list** — §7: "Admins manage the list."
- [ ] **Step 2: Show the reference count**, so Task 1 Step 3's decision is visible before it acts.
- [ ] **Step 3: The refusal survives deleting the guard it names** — mutation-verify it.

---

## Task 6: `/admin/spaces`, and the key that was never validated

**Files:** routes, `src/lib/spaces/admin.ts`, `src/lib/spaces/key.ts` + tests.

- [ ] **Step 1: Spaces and memberships**

The first surface that creates a `Space`; until now only the seed did.

- [ ] **Step 2: Validate `Space.key` — the debt Phase 5 named three times**

It is a bare `String @unique` with no validation anywhere, and that single fact is why
`mirrorPathOf` needs a containment guard, why `/-/mirror` and `/admin/*` are shadowable, and why
`Engineering` and `engineering` are two rows sharing one directory on a case-insensitive
filesystem. Reuse `validateSlug`'s rules — it already refuses a leading `-`, uppercase, dots and
anything outside `[a-z0-9-]` — and add the **folded uniqueness** a slug rule cannot express.

- [ ] **Step 3: Say what the window was**

Validation closes this going forward; it does not retro-validate the two existing rows, both of
which are already legal. State that, and state that a key created before this task could still
shadow a route.

---

## Task 7: `/admin/git`, and two more debts

**Files:** routes, `src/lib/git/retention.ts`, `src/lib/git/reconcile.ts` + tests.

- [ ] **Step 1: Absorb `/-/mirror`**

Move it, do not duplicate it. Keep its credential redaction — Phase 5 Task 8 found the certain
leak is the **argv** this application builds, not git's stderr, and that removing redaction from
either end alone still leaks.

- [ ] **Step 2: Retention for finished jobs**

Phase 5 Task 3 kept `DONE` rows deliberately — deleting them makes success unobservable and every
drain assertion vacuous — and deferred the sweep here, because "a sweep with no operator surface
is a cron job nobody knows about". Now there is a surface.

- [ ] **Step 3: Reconcile the versions that predate the mirror**

Phase 5 said the queue is not a reconciliation and that pre-mirror versions stay `gitSha = null`.
This is where a repair pass can exist — and it must be an operator action with a count, not a
silent backfill, because the mirror's whole value is that a gap is *noticed*.

---

## Task 8: `/admin/bugs`

**Files:** routes, `src/lib/bugs/admin.ts` + tests.

- [ ] **Step 1: Triage over the existing vocabulary** — `BugStatus` already exists.
- [ ] **Step 2: A report's captured context may dangle by design**

`BugReport` deliberately holds `spaceId`/`pageId`/`versionId` **without** foreign keys, because
their value is highest when the referenced page is gone. So this surface must render a dangling id
without throwing, and `routePath` is the durable breadcrumb. A test with a deleted page.

---

## Task 9: End-to-end and the smoke test

- [ ] A page declares systems, publishes, and appears on each system's page.
- [ ] Two viewers with different memberships get different lists from one system URL.
- [ ] An unknown system key is reported to the author and not dropped.
- [ ] A due-for-review page appears, is confirmed, and leaves the search vector unchanged.
- [ ] Every admin surface refuses a non-admin, and the refusal is not-found rather than forbidden.
- [ ] `scripts/smoke.sh`: the catalogue over HTTP, one admin refusal, and the review confirm.
      Extend `counts()` for the two new tables. Prove it can fail; the exit code is the contract.

---

## Phase 7 exit criteria

- [ ] `npm test`, `npm run test:e2e`, `npm run smoke` all pass
- [ ] `npm run typecheck && npm run build` clean; `npm run plan:check` 0 drifted
- [ ] A page's `systems:` keys reach `PageSystem` rows, and an unknown key is reported rather than
      dropped
- [ ] `/systems/[key]` lists only documentation in spaces the viewer can read — proven as a
      discrimination between two viewers, not as an absence
- [ ] A system carries no permissions: it neither grants nor denies access to any page
- [ ] Confirming a review writes `reviewedAt`, creates no version, enqueues no mirror job, and
      leaves the search vector byte-identical
- [ ] Every `/admin` surface refuses a non-super-admin with not-found, each mutation-verified
- [ ] `Space.key` is validated on creation, folded uniqueness included, by the same rules a slug
      already obeys
- [ ] Finished `GitJob` rows can be swept from an operator surface, with a count
- [ ] A pre-mirror version can be reconciled deliberately, never silently
- [ ] A bug report whose page is gone still renders
- [ ] The PR is open with the phase's exit criteria in its description
