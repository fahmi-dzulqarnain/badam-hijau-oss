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

## Task 2: Resolving what authors already wrote ✅

**Files:** `src/lib/systems/resolve.ts`, `src/lib/pages/publish.ts` + tests.

- [x] **Step 1: Measure the seeded corpus first**

Before choosing a rule, find out which `systems:` keys exist in the dev database and the seed and
whether they resolve against Task 1's catalogue. The rule is a decision about real data, not a
hypothetical.

- [x] **Step 2: Resolve at publish, inside the transaction that already exists**

§9 step 3 puts `PageSystem` rows in the publish transaction. Phase 5 Task 4 established the
pattern and the trap: use `tx`, never `db`, and note that for publish the mistake **times out on
a lock** rather than committing silently.

- [x] **Step 3: An unknown key is reported, never dropped**

Refuse the publish or accept and report — but the author must see it. Phase 3's own note is the
specification for the failure to avoid.

**The corpus contains no `systems:` at all, and that is what decided the rule.** Measured before
anything was written: no seeded page's markdown has a frontmatter block and `publishSeedVersion`
writes no `frontmatter` column, so all six published versions in the dev database carry `{}`;
there are no drafts and `PageSystem` was empty. Every template ships `systems:` with nothing after
it, which normalises to `[]`. So **no page anywhere declares a system, and none declares one that
fails to resolve** — nothing to migrate, no author to ask for a re-edit, and **the seed needed no
attention**, which is the branch this step was told to watch for.

That measurement is what makes the strict rule affordable rather than merely defensible. Had a
published version held an unresolvable key, refusing would have made an already-published page
unrepublishable until someone edited text they may not own, and *accept and report* would have
been the right answer. The two keys in the repository that do not resolve were both **test
fixtures** — `mqtt-broker` in `tests/integration/git-worker.test.ts` and `e2e/mirror-tree.spec.ts`
— invented while nothing validated them; both now name `order-hub`, so a fixture can no longer pass
on a key the product does not have.

**An unknown key refuses the publish.** The argument is in `src/lib/systems/resolve.ts` and the
half that decided it is consistency with Task 1: `PageSystem.systemId` is `Restrict` because
"cascade does not drop a facet; it manufactures a lie" — a document whose text says
`systems: [order-hub]` with no row behind it. *Accept and report* manufactures exactly that lie
from the authoring side, with one keystroke, and **permanently**, because nothing re-resolves a
published version until someone republishes it. A phase that forbids an admin from creating that
state while letting any author create it has taken half a decision. It is also **not** the option
Phase 3 declined: Phase 3 declined rejecting `systems:` *as a key*, and every template's empty
`systems:` still publishes; what is refused is a value that names nothing, exactly as
`supersedes: no-such-page` already is. `publishPage` had already written the rest of the argument
for `body-empty` — publish is one round trip with a boolean outcome, so "report" means a message
nobody has to read or a confirm-and-resend handshake.

No new error channel: the refusal is a `PublishFieldError` with `key: "systems"`, which
`src/lib/editor/publish.ts` already turns into the "line N · systems:" control Phase 3 shipped for
the supersede-cycle refusal. `SystemRefusalCode` joins the four unions `PublishErrorCode` imports
rather than being restated there.

**The four smaller decisions.** *Case* is folded with `toLowerCase` — on a lowercase-only column
`@unique` is folded uniqueness, so `Order-Hub` can name at most one row and there is nothing to
disambiguate; `toLocaleLowerCase` is deliberately avoided, because a Turkish default locale would
fold `store-IOS` to a key the CHECK forbids and the same document would publish in one deployment
and be refused in another. *No trim*, because `systemsSchema` already refuses surrounding
whitespace and the `Space.key` lesson is what happens when one string is normalised in several
places by habit. *Duplicates* collapse **after** the fold, which is the case that matters —
`[Order-Hub, order-hub]` is one system. *A sunsetting system may be declared*: `isActive` is a
catalogue state (§7's "active or sunsetting"), not an authoring gate, and the documents that most
need the facet are the ones written about a retirement — the seeded `adr-0042-mqtt-topic-naming`
already says the bridge is on its way out, and a decommissioning runbook would otherwise be the
one page that could not be published. Filtering on it would also let an admin flipping one boolean
make pages unpublishable in spaces they never looked at: a permission-shaped consequence on a
table §7 says carries no permissions. *And no cap*, with the reasoning **in the code** rather than
only here: on success the rows one page can cause are bounded by `count(System)`, because unknown
keys are refused and duplicates collapsed, and on the way in the list is already bounded by
`MAX_FRONTMATTER_ENTRIES` (200, counting list items) and the 16KB block cap. A constant of 20 here
could never bind before either of those, and `MAX_RELATION_TARGETS` is the cautionary tale — two
thirds of its stated reasoning went stale and sat in the file for three tasks.

**Three mutation results corrected a claim rather than confirming one**, and they are the useful
part of this task:

- **`replaceSystems(db, …)` blocks; it does not commit silently.** The plan's warning is right and
  the mechanism is worth recording: publish updates `Page.publishedVersionId`, which carries
  `Page_publishedVersionId_key`, so Postgres takes `FOR UPDATE` on the row rather than
  `FOR NO KEY UPDATE` — and the `PageSystem` insert's foreign key wants `FOR KEY SHARE` on that
  same row from another connection. It arrives as `Test timed out in 5000ms` against a line that
  names nothing. The discrimination is a lock and cannot be made into an assertion, so what is
  shaped deliberately is the diagnosis: the facet test's docstring says a timeout there means the
  client is `db`.
- **`resolveSystems(db, …)` is an equivalent mutant** — 68 of 68 green. It reads a table this
  transaction never writes or locks, and the foreign key is checked against committed data at
  insert time either way, so the race it looks like it introduces exists on `tx` too. Reported
  rather than pinned by a manufactured test, per this project's rule.
- **Deleting the `deleteMany` alone dies for the wrong reason** — a `PageSystem` unique violation
  when the second publish re-declares a surviving system, which is a crash and not the removal the
  test names. So the re-resolution test is written against the *accumulating* implementation (no
  delete, `skipDuplicates: true`) and kills it by assertion:
  `['backend','order-hub','store-ios']` where `['backend','order-hub']` was expected.

**`skipDuplicates` is deliberately absent, and that was measured too.** With it restored and the
dedupe deleted, the whole publish file passes 68 of 68 — so a `[order-hub, order-hub]` test would be
testing `ON CONFLICT DO NOTHING` rather than the dedupe it names. Without it that mutation dies on
`@@id([pageId, systemId])`. `replaceSystems` also uses a plain `deleteMany({ where: { pageId } })`
where `replaceRelations` uses a `NOT`, and the difference is argued rather than copied: the `NOT`
exists to keep a surviving relation's `createdAt`, and `PageSystem` "is exactly its two keys" with
no payload to preserve — the statement Task 1 named in as many words.

**No `systems` diff in the audit row, and that is a decision.** Both halves of `RelationDiff`'s
argument fail here: "reconstructible from the version chain" was too weak for relations because
recovering an edge means re-resolving a *path* through `Redirect` rows a later move may have
replaced, while a system key resolves through one lookup against a closed catalogue with no
time-dependent hop; and "removal has a consequence nothing else records" was the deciding half —
dropping a system fires no cascade and changes no other row. What remains is that a `System.key`
renamed by Task 5 would strand an old version's stored keys, and that rename is Task 5's own
audited mutation on the row that changed.

**Registered `reachesPage: false`** in `src/lib/pages/visible.test.ts`, with the reason spelled
out: four statements, none of which reads, selects or filters a `Page` row — not through a delegate
and not through a `page:` relation filter. The `pageId` is never looked up; `publishPage` has
already authorised that row under `visiblePage({ space: readableSpace(viewer) })` and locked it, so
restating the predicate here would be the `resolveRedirect` mistake. Same registration and same
argument as `src/lib/git/enqueue.ts`, the FK `KEY SHARE` locks included. **This module performs no
permission check at all**, said at each query rather than once: `System` has no `spaceId`, no
`visibility` and no `deletedAt`, because §7 makes a system a label and not a container.

**`snapshot()` in `tests/integration/publish.test.ts` was widened to carry the `PageSystem` rows.**
Every atomicity assertion in that file compares a whole snapshot precisely so a half-commit fails
in whichever half nobody looked at, and until that line existed a facet row written by a publish
that then rolled back was in exactly that blind spot — the eighth time a count contract on this
project has been too narrow. The staged soft-delete test is what proves the rollback rather than
the comment claiming it.

**Phase 3's `TODO(phase-7)` on `systemsSchema` is gone rather than left to be trusted**, and its
cap note corrected in the same change: correcting a plan is not correcting the code comment that
says the same thing, and that comment is where a reader meets this decision first.

---

## Task 3: `/systems` and `/systems/[key]` ✅

**Files:** `src/lib/systems/read.ts`, `src/lib/systems/groups.ts`,
`src/lib/systems/repo-url.ts`, routes + tests. The two extra modules are the pure halves — which
groups exist and what "open" means, and whether a stored `repoUrl` may be linked — following
`src/lib/lifecycle/indexes.ts`'s split from `index-read.ts`, so both are unit-testable without a
database and Task 5 can reuse the second without importing a module that queries.

- [x] **Step 1: The catalogue index**

Metadata per §7: kind, owning team, repo, active or sunsetting.

- [x] **Step 2: The per-system page, filtered by readable space in SQL**

Grouped by doc type — ADRs affecting it, its runbooks, open RFCs.

**~~The readable set is derived from `readableSpace`, exactly as `src/lib/search/query.ts` does
it.~~ Superseded: that is the wrong precedent, and reading *why* search derives is what says so.**
Search derives because `tsvector`/`ts_rank`/`ts_headline` have no Prisma expression, so its query
is raw SQL and a Prisma `where` cannot compose into it. These queries are Prisma, so the predicate
composes directly — and `src/lib/authz/where.ts:26` sanctions exactly that shape: *"Correct:
`where: readableSpace(v, { key })` and `where: { spaceId, space: readableSpace(v) }`"*. Copying the
derivation would have added a round trip, an intermediate id list, and a `spaceId: { in: [...] }`
clause one step further from the definition, to dodge a composition problem this module does not
have.

Both queries share **one** `pageScope()` builder rather than restating the predicate — a deliberate
divergence from `index-read.ts`, whose registration has to say both halves are asserted separately
because "with the filter dropped from the aggregate alone, the list is right and the chip beside it
counts a page nobody can open". A shared builder makes that unrepresentable.

**§7's three groups are not enough, and the gap is Phase 3's failure arriving by a third route.**
`resolveSystems` gates on no doc type, so a `DOC` can declare a system and land a `PageSystem` row.
Rendering only ADR/RUNBOOK/RFC would drop it silently; refusing `systems:` on a `DOC` would be a new
authoring rule invented on a read surface. `SYSTEM_GROUPS` is a `Record<DocType, …>`, so a fifth
doc type cannot be added without a decision.

**"Open RFCs" is `IN_REVIEW` and `ACCEPTED`**, and the heading names what it excludes —
`WITHDRAWN, REJECTED and CLOSED` — with an `excluded` **count** from the aggregate, so it says
"3 more are not listed here" rather than leaving a reader to wonder. Swapping `isRetired` for
`terminalStatuses("RFC")` is an **equivalent mutant**, reported rather than pinned by a
manufactured test: the two ask different questions and come apart only on `ARCHIVED`, which the RFC
vocabulary does not contain, so they agree by accident.

**The route collision is wider than `/-/mirror`'s, measured the same way.** Phase 5 found `/-/mirror`
shadowed exactly one URL because `/-/welcome` still worked. Here the shadowing segment is `[key]`,
which matches *any* single segment, so a space keyed `systems` loses its landing page **and every
depth-one path** — and a shadowed path **404s rather than falling through**, while depth two and
below are untouched. Measured on a real `next build` and `next start` against a space genuinely
keyed `systems`: `/systems/ordinary` 404, `/systems/deep/page` 200. No such space exists today;
Task 6 closes it going forward.

**A credentialed `repoUrl` is withheld, not redacted** — nothing of the URL leaves
`src/lib/systems/repo-url.ts`, not even the host. It withholds on `username` **or** `password`,
because `https://<token>@host` is the common single-component form that a password-only rule passes
straight through, and the protocol allowlist is checked **first**, because the column is
unvalidated until Task 5 and `javascript:` in an `href` is script execution.

**The overflow probe found a real defect, the ninth shape.** `.sys-team { flex: none }` — and
`overflow-wrap: anywhere` cannot break a token inside a box that is not allowed to shrink, because
`flex: none` is `0 0 auto` so the basis is the content width. 515px of overflow at 1280. Fixed as a
class rather than a case: `flex: none` is now reserved for values the **database** bounds — a
`SystemKind`, a `DocStatus`, a formatted date — while everything a person typed may shrink.

**Task 1's deferred `SLUG_MAX_LENGTH` on `System.key` has a rendering consequence today**: a
300-character lowercase key is legal under the CHECK and reaches this route. Handled in CSS here,
but Task 5 should know the cap is doing more than tidiness.

> **Superseded by the task.** The derivation is not copied, and the plan's "exactly as
> `src/lib/search/query.ts` does it" is the half of that sentence that does not transfer — see
> the first closing note below.

- [x] **Step 3: Two viewers, one URL, different lists**

A discrimination test: a member of one space and a member of the other must both see *something*
and not the same thing. An empty list for one of them proves nothing.

**The plan said to derive the readable set, and this task nested the predicate instead.** The
instruction was to copy `src/lib/search/query.ts`, and reading *why* that module derives is what
decided against it: its own docstring gives the cause — *"`readableSpace` returns a Prisma `where`
and does not compose into raw SQL"* — and search is raw SQL only because `tsvector`, `ts_rank` and
`ts_headline` have no Prisma expression. These two queries are Prisma, so the predicate composes
directly, nested as the `space` relation filter in the shape `where.ts` sanctions. Copying the
derivation would have added a round trip, an intermediate id list and a `spaceId: { in: [...] }`
clause one step further from the definition, to avoid a composition problem this module does not
have. Derivation exists to keep the predicate stated **once**; nesting states it once too. The
plan's *rule* — filter in the query, never after fetching — is what carried over, and it is the
one Phase 4 Task 3 measured leaving 24 tests green over a deleted SQL clause.

**One `pageScope()` for both page queries, which is a deliberate divergence from
`index-read.ts`.** That module gives its list and its aggregate a `visiblePage(...)` each, and its
registration in `visible.test.ts` has to say both halves are asserted separately because "with the
filter dropped from the aggregate alone, the list is right and the `ACCEPTED 3` chip beside it
counts a page nobody can open". A shared builder makes that divergence unrepresentable: the two
`where`s differ only in the group filter passed as an extra condition, and there is exactly one
place either predicate can be deleted from. Deleting `{ space: readableSpace(viewer) }` fails
`two viewers, one URL, two different lists` with
`expected [ 'Bunkering runbook (alpha)', …(1) ] to deeply equal [ 'Bunkering runbook (alpha)' ]`,
the extra element being the other space's title.

**"Open RFCs" is `IN_REVIEW` and `ACCEPTED`, derived from `isRetired` and not from
`terminalStatuses`** — and swapping the two is an **equivalent mutant**, 22 of 22 green, reported
rather than pinned by a manufactured test. They return the same three names for `RFC` today. The
argument for `isRetired` is that "open" asks §6.4's question — is this document in force *now* —
while `terminalStatuses` asks whether it can ever be in force again, and the two come apart on
`ARCHIVED`: retired but not terminal, because a `DOC` publishes `ARCHIVED → CURRENT`. `ARCHIVED`
is not in the RFC vocabulary, so they agree by accident, and `groups.test.ts` asserts the accident
rather than the coincidence.

The heading is **"Open RFCs"**, its blurb is assembled from the two derived lists so it names
`WITHDRAWN, REJECTED and CLOSED` as what it leaves out, and the group carries an `excluded`
**count** from the aggregate. "Some may be hidden" is not a checkable claim where a number is, and
a group labelled "RFCs" that silently hid the closed ones would be the same lie Task 1 refused
from the cascade side and Task 2 from the authoring side.

**`DOC` gets a fourth group, and §7's list of three is why that needs saying.** `resolveSystems`
gates on no doc type, so a `DOC` can declare a system today and the row lands in `PageSystem`. A
page rendering only §7's three groups would drop it silently — Phase 3's "empty facet" failure
arriving by a third route — and the alternative, refusing `systems:` on a `DOC`, would be a new
authoring rule invented on a read surface. `SYSTEM_GROUPS` is `Record<DocType, …>`, so a fifth doc
type cannot be added without a decision here.

**Three exclusions, each mutation-verified, and the third one is not reachable from the product.**
Dropping `visiblePage()` kills only the soft-delete test; dropping the systems join filter kills
only "a page that names one system is not on another system's page"; dropping
`publishedVersionId: { not: null }` kills only "a page whose published version has gone is not
listed". That last state exists because `Page_publishedVersionId_fkey` is `ON DELETE SET NULL` —
deleting a `PageVersion` nulls the column while the facet rows survive — so the test constructs
the row shape with a direct write and says so, rather than pretending it is a user journey.
`index-read.ts` makes the opposite choice for unpublished pages (inert text, not hidden) and the
difference is the space boundary: that list is inside a space the viewer already reads.

**The audit call pattern: `auditSpaceAccess(viewer, space)` at the default `"request"` scope, once
per space that produced a listed row.** No rule is re-decided here — `needsAccessAudit` and the
dedupe stay in `log.ts` — and the `"subresource"` window is wrong for a render, whose fan-out
belongs to a person navigating. Only spaces that produced a row, as `search` decided it; the
bounded gap is that under truncation a space can contribute to a *count* without contributing a
row, which discloses one integer with no page identity in it — the same thing Task 1 already said
needs no audit. Removing the loop kills three tests. `listSystems` audits nothing and reads no
space.

**The route collision, measured the way Phase 5 Task 8 measured `/-/mirror`, and it is wider.** A
throwaway `badam_p7_probe` database, `prisma migrate deploy`, a space genuinely keyed `systems`
holding published pages at `store-ios`, `ordinary`, `deep` and `deep/page`, a real `next build` and
`next start`, signed in through `test-login`:

| URL | Answer | What served it |
|---|---|---|
| `/systems` | 200 | the catalogue — the space's landing page is gone |
| `/systems/store-ios` | 200 | the system page, over the space's page at `store-ios` |
| `/systems/ordinary` | **404** | a published page at depth one, unreachable |
| `/systems/deep` | **404** | likewise, and it has children |
| `/systems/no-such-system` | 404 | |
| `/systems/deep/page` | 200 | the **space's** own page, at depth two |

`routes-manifest.json` puts `^/systems(?:/)?$` in `staticRoutes` (matched ahead of every dynamic
route) and `/systems/[key]` at index 11 of `dynamicRoutes`, before `/[space]` at 12 and
`/[space]/[...path]` at 17. **So the window is not "one path deep" as it was for `/-/mirror`:**
the shadowing segment is `[key]`, which matches any single segment, so such a space loses its
landing page and **every** depth-one path, while depth two and below is untouched — and a shadowed
path **404s rather than falling through**, so those pages are gone and not merely outranked. No
space is keyed `systems` today; Task 6 closes the window going forward without retro-validating.

**A credentialed `repoUrl` is withheld, not redacted, and the guard is a scheme allowlist as
well.** `repoLinkOf` returns `{ kind: "withheld", reason }` and nothing of the URL — not the host,
not a starred form — because a redaction is a transformation of a secret and this surface has no
reason to hold one. `username` **or** `password` withholds, because `https://<token>@host` is the
common single-component form and a password-only rule would pass it straight through. The
protocol is checked first and against an allowlist, because the column is unvalidated until Task 5
and `javascript:` in an `href` is script execution rather than a broken link; that ordering also
keeps `ssh://git@host` reported as a scheme problem instead of a false credential alarm. Both
mutations die: `if (url.password !== "")` alone fails the username test, and deleting the scheme
check fails the `javascript:`/`data:`/`ssh:` one.

**The overflow probe found a real defect, and it is the class's ninth shape.** Injected `HOSTILE`
into a system's `name`, `ownerTeam` and `description`, a 300-character `System.key` (legal: Task 1
constrained the character class and **deferred the length cap to Task 5**), a 200-character path
and a 300-character `repoUrl`: **515px of overflow on a 1280px viewport**, from `.sys-team`
declared `flex: none`. `overflow-wrap: anywhere` cannot break a token inside a box that is not
allowed to shrink — `flex: none` is `0 0 auto`, so the basis is the content width. Fixed as a
class in `doc.css`: `flex: none` is now reserved for the values the *database* bounds
(`SystemKind`, `DocStatus`, a formatted date), and everything a person typed shrinks. 0px at 1280,
860 and 380 after; reverting the one rule reproduces `Received: 515`.

**The affordance ships with the thing.** `/systems` is linked from the top bar beside `/search`,
because two features in this project have shipped with nothing linking to them and both were found
late by asking "can a person get to this?" rather than by a test. `e2e/systems.spec.ts` asks it.

**The discrimination is deliberately not in the e2e suite.** It needs two spaces with disjoint
memberships; the dev corpus has one `MEMBERS` space and one `ALL_STAFF` one, so an e2e version
would be near-vacuous or need a third space — which would disturb the `2 spaces / 7 pages`
baseline `scripts/smoke.sh` and four other specs assert. It lives in
`tests/integration/systems-read.test.ts` against real SQL, where it can have two. What the e2e
spec owns instead is what vitest cannot show: the **seeded** corpus rendering `kiosk-bridge`
as sunsetting and `backend` with no repository (Task 1 asked for the corpus and not a fixture),
the overflow measurement, the credential in real HTML, and the affordance.

---

## Task 4: Due for review ✅

**Files:** `src/lib/pages/review.ts`, the space landing, a confirm action + tests.

- [x] **Step 1: The interval is configuration**

§17 lists "review interval in months" as an environment variable, default twelve. It is absent
from `.env.example` — add it there too, or every other checkout breaks silently.

- [x] **Step 2: The list on `/[space]`**

§11: the space landing shows modules, recently published, and due for review.

- [x] **Step 3: Confirming a review writes one column**

No version, no `GitJob`, and `Page.searchVector` **byte-identical** — asserted, with a companion
proving `reviewedAt` moved.

**The byte-identity assertion is stronger than "we did not touch it", and the reason is measured.**
`page_search_vector_refresh` is `BEFORE INSERT OR UPDATE` with **no `WHEN` clause** — confirmed
against `pg_get_triggerdef` — so a `reviewedAt` write *does* fire it and the vector is genuinely
rebuilt. The test therefore drives a real publish and asserts the lexemes are present **first**,
because an empty tsvector equals another empty one.

**Outside the seed, every page is unowned and never reviewed — permanently.** `createPage` writes
neither `ownerId` nor `reviewedAt`, and neither does `publishPage`; the only writes in `src/` are
the seed's. That measurement rules out two of the three readings of a null `reviewedAt`: "not due"
means no page the product creates is ever listed, dead on arrival and silently, while "due
immediately" puts a page published this morning at the head of the list. So **due is measured from
`publishedAt`** — publication is the stronger assertion — which also makes an unpublished page
never due, there being no anchor and no reader.

**Who may confirm: the owner, or `MANAGE_SPACE` — and the second arm is forced, not decorative.**
Not `EDIT`, because an editor may rewrite a page without vouching for it, and if `EDIT` sufficed
the list's own sentence would be false of half its rows. But `ownerId` is usually null, so the
owner arm alone would leave every unowned page on the list for ever. The discriminating viewer in
the refusal test is an **editor of the page's own space**; refusing a non-member would have been
the space filter talking.

**Confirming is audited as `page.review`** — the clearest case in the product, since it writes no
version, no job and no vector change, and `reviewedAt` is a single mutable column, so the *second*
confirm destroys the first's only record.

**Two of this task's own tests did not kill what they named, and mutation is what said so.** The
soft-delete test survived deleting `visiblePage()` from the read, because the write's predicate
produces an identical `not-found` — the `resolveRedirect` read/write-pair shape. What separates
them is §8: without the read's filter the row *is* read, `mayConfirmReview` runs on it, and a
non-owner is told **forbidden** — a soft-deleted page answering a question about itself. And
`readableSpace` on that write is a genuine **equivalent mutant**, reported in the module rather
than pinned by a manufactured test.

**The confirm control lives in `.meta`, never `PageInfoCard`** — `.rail-r` is `display: none`
below 1180px, the shape that took Phase 1's bug dialog and the user's typed text with it. It is on
the page rather than the landing list, because confirming is a claim you can only make after
reading; and the reader deliberately says nothing about due-ness, a TypeScript copy of the SQL
`where` being Phase 4 Task 3's trap.

**`REVIEW_INTERVAL_MONTHS` has a default in the CODE, and that is the opposite polarity from
`BLOB_STORE`.** It is in `.env.example` and in this checkout's untracked `.env.test`, but an unset
or empty value returns twelve rather than refusing to boot — because the failure this project
actually had was a tracked template gaining a variable with no default and breaking 27 tests in
another checkout the moment Phase 6 merged. `BLOB_STORE` refuses to guess because guessing wrong
either loses uploads or breaks every laptop; guessing twelve months wrong nags somebody early.
Zero **is** refused rather than clamped: it is the "a page is due the moment it is published"
reading below, arriving through configuration instead of through code, and a validator that
silently substituted the default would overrule a deployment that meant it.

**The plan's central fact was right, and it decided the tests.** Measured before anything was
written: all seven seeded pages carry an `ownerId` and a `reviewedAt` of `2026-08-18`, today is
`2026-09-05`, so under twelve months **nothing in the seeded corpus is due** and the list renders
its empty sentence in both spaces. Every due fixture in
`tests/integration/review.test.ts` and `e2e/review.spec.ts` therefore backdates its own anchor and
has a **not-due companion in the same assertion**; the one test that does assert an empty section
(`handbook`, over HTTP) is placed after a test that has already shown a due page being listed.

**The second measurement is the one the plan did not ask for, and it chose the rule.**
`reviewedAt` is written by `prisma/seed.ts` and by nothing else — `createPage` sets neither
`ownerId` nor `reviewedAt`, and `publishPage` sets neither either. So outside the seed **every
page this product creates is unowned and has never been reviewed**, permanently. That makes null
the ordinary case rather than the edge one and rules out two of the three answers:

| Rule for a null `reviewedAt` | Consequence on this corpus |
|---|---|
| Not due | no page the product creates is ever listed; the feature is dead on arrival, silently |
| Due immediately | literal §12, and a page published this morning heads a list called "due for review" |
| **Measured from `publishedAt`** | a page never confirmed becomes due one interval after publication |

The third, because publication is the last moment somebody asserted the document was correct and
is a *stronger* assertion than a confirmation — an author read it and shipped it. It also makes
the anchor **total**: every candidate row has a non-null date, so there is no third branch. The
choice is unobservable on the seeded corpus (both `reviewedAt` and `publishedAt` are inside twelve
months there), which is exactly why it needed a fixture pair rather than an inspection.

**An unpublished page is never due, and `confirmReview` deliberately does not require one.** The
list needs the bound — a draft has no reader, and it is what keeps the anchor total. The mutation
does not, and adding a `publishedVersionId` clause there would be a guard that cannot fire: the
list only offers published pages and the reader route only renders published pages, so no surface
can reach a draft's control. Same shape as Task 1's declined repair clause.

**Who may confirm: the owner, or `MANAGE_SPACE` — and not `EDIT`.** §12 names the owner, and an
editor may rewrite what a page says without vouching that it is still true; if `EDIT` sufficed,
the sentence the list is built on would be false of every row an editor had touched. The second
arm is not a nicety — `Page.ownerId` is nullable and, per the measurement above, usually null, so
with the owner arm alone an unowned page becomes due one interval after publication and then sits
there for ever, unactionable by anybody. The same hole opens for an owner who has left, since
offboarding here keeps the `User` row. `can()` folds `isSuperAdmin` in, so there is no third arm.
The refusal's message names the rule, because "an editor is not enough" is the one thing nobody
can guess: *"Only this page's owner, or an administrator of the space, can confirm a review."*
**Mutation-verified** — with `mayConfirmReview` replaced by `can(viewer, space, "EDIT")` the test
fails with `expected { ok: true, … } to deeply equal { ok: false, reason: 'forbidden', … }`, and
the viewer that makes it discriminate is an `EDITOR` **of the page's own space** who does not own
the page: refusing a non-member would have been the space filter talking.

**Confirming is audited, and `page.review` joins `AuditAction`.** It is the clearest case in the
product: the confirm writes no `PageVersion`, enqueues no `GitJob` and leaves the search vector
byte-identical — all three deliberately — so it is the one mutation that would otherwise leave no
trace at all. And `reviewedAt` is a single mutable column, so the *second* confirm destroys the
record of the first; the test asserts two rows, the second carrying the value the first wrote.
`detail` holds `by` (which arm allowed it, exactly as `space.access` records why a super admin's
read was permitted) and `previousReviewedAt` (null and not absent, because an omitted key and a
null one mean different things to anyone querying the column).

**The byte-identity is a stronger claim than "we did not touch it".** `page_search_vector` is a
`BEFORE INSERT OR UPDATE` trigger with **no `WHEN` clause**, so a `reviewedAt` update fires it and
the vector is genuinely rebuilt from title, headings and body. The test drives a real
`publishPage` so the vector under test is one the product built, asserts the lexemes are present
before comparing (an empty `tsvector` is byte-identical to another empty one), and carries the
non-vacuity companion in the same test: `reviewedAt` moved. Without that line every other
assertion passes over a `confirmReview` that did nothing.

**The control is in `.meta` and not in `PageInfoCard`**, for Phase 5 Task 7's reason: `.rail-r` is
`display: none` below 1180px, so a control there would not exist on a laptop in a split window —
Phase 1's bug dialog inside `.rail-l` is the same bug. The rail keeps **Last reviewed**, which is
a fact; the row carries the action. It is on the page and not on the landing list, because
confirming is a claim you can only make after reading the document and a button on a list clears
the cycle without opening anything. Asserted as CSS at three widths in `e2e/review.spec.ts`, with
the rail's own presence at 1280 and absence at 900 as the control.

**The reader says nothing about whether a page is due, and that is deliberate.** A TypeScript
`isDueForReview` beside the SQL `where` is the shape Phase 4 Task 3 measured, where a post-fetch
filter left the SQL clause deletable with 24 tests green. The predicate lives in one `dueScope()`
builder shared by the list and the count — the divergence `src/lib/systems/read.ts` argued for
against `index-read.ts` — so there is exactly one place any of the four filters can be deleted
from.

**One claim in this task's own test file turned out to be wrong, and it is the useful finding.**
`confirmReview` states `visiblePage()` twice, on the read and on the write, and the obvious test —
"a soft-deleted page cannot be confirmed, and reads as not-found" — **stays green with the read's
filter deleted**, because the write's predicate then produces the identical answer. That is the
`resolveRedirect` shape arriving through a read/write pair. What separates them is §8: without the
filter the deleted row is read, `mayConfirmReview` runs against it, and a non-owner is told
*forbidden* — a soft-deleted page answering a question about itself. `a soft-deleted page reads as
not-found even for a viewer who could not confirm it` is the only test that kills it. The write's
own filter has the staged test with a held row lock, since a predicate on an `updateMany` is
invisible to anything that cannot change the row underneath it.

**`readableSpace` on that same write IS an equivalent mutant** — deleting it leaves all twenty
tests green, because the read already refused every viewer it would refuse. Reported in the module
rather than pinned by a manufactured test, per this project's rule, and kept for consistency with
`publish.ts`, `move.ts` and `delete.ts`, which all restate both predicates on their writes.

**A zero row count returns rather than throwing, which is the difference from `publishPage`.**
Publish throws `PageNoLongerPublishable` because by that point it has inserted a version — the
only way out of a transaction that has written is to abort it. Nothing has been written here (the
audit row is deliberately below the update), so an empty commit and a rollback are the same
observable event and the caller gets the ordinary not-found instead of a 500 for a page somebody
legitimately deleted a millisecond ago. No lock either: the only competitor is another confirm of
the same page, and the loser's value being overwritten is two legitimate confirmations a second
apart, both audited.

**The order is two tiers and says so, rather than approximating "most overdue".** Postgres could
produce the strict order from `coalesce("reviewedAt", "publishedAt")` and Prisma has no expression
for it, so the honest choices were raw SQL or an order that means what it says. Never-confirmed
first (`nulls: "first"`), then longest since confirmation, oldest first within each tier, `id`
breaking the final tie so the cut at `MAX_DUE_ROWS` cannot shuffle between requests. The third row
in the ordering test has an older effective date than the first, which is the point.

**The overflow probe found nothing, and was counter-checked rather than trusted.** The class has
bitten nine times and only catches what it is shown, so a 300-character `HOSTILE` title goes onto
a page that is *due* — with a non-vacuity assertion that it reached both routes before anything is
measured. 0px at 1280, 860 and 380. With `.landing li { overflow-wrap: anywhere }` removed the
same probe reports `Received: 1348` at 1280px, so it measures; the existing landing rule already
covers the new rows, and `.doc-review` is deliberately **not** `flex: none`, which is Task 3's
ninth shape.

**`e2e/review.spec.ts` asserts one thing `snapshotCounts` structurally cannot see.** A confirm
moves a column on a row rather than creating or deleting one, so the count contract is blind to
it — the "too narrow, and silent about it" shape, met from a new direction. Its `afterAll`
therefore also asserts that all seven seeded pages still carry
`reviewedAt = 2026-08-18T00:00:00.000Z`.

**Phase 1's whole-file fence for `src/app/(reader)/[space]/page.tsx` is annotated, not synced.**
Direction 3 of the drift table: a later task changed the file. Syncing would have put a §12 review
list inside Phase 1 Task 13's scaffold. `plan:check`: **0 drifted**, with `superseded` 29 → 30 and
`in sync` and `unmatched` both unchanged — the counts, not just the drift line.

**Numbers:** 1400 vitest over 95 files (was 1364/92 — +34 tests, plus 2 from the new
`visible.test.ts` registration, which `test.each`es twice), 83 Playwright (was 76), typecheck 0,
build 0, `plan:check` 0 drifted, 119-check smoke passing, dev baseline unchanged at
2 spaces / 7 pages / 7 systems / 0 page systems.

---

## Task 5: `/admin/systems` ✅

**Files:** routes, `src/lib/systems/admin.ts` + tests. Plus three modules the plan did not name:
`src/lib/admin/gate.ts` (the refusal, once, for four surfaces), `src/lib/systems/key.ts` (Task 1's
deferred `validateSystemKey`) and `src/components/AdminSystems.tsx`.

- [x] **Step 1: Manage the list** — §7: "Admins manage the list."
- [x] **Step 2: Show the reference count**, so Task 1 Step 3's decision is visible before it acts.
- [x] **Step 3: The refusal survives deleting the guard it names** — mutation-verify it.

**The gating is a seam and not a line, because three more surfaces copy it.** `refuseNonAdmin`
lives in `src/lib/admin/gate.ts`, states `viewer.isSuperAdmin` **once** and returns the not-found
value as well as the decision — a boolean helper would have stated the predicate once and the
*answer* four times, and the answer (not-found, never forbidden) is the half this project keeps
having to say out loud. Every entry point opens with the same two lines and
`src/lib/admin/gate.test.ts` sweeps `src/lib/**/admin.ts` for one that forgets, with the
non-vacuity companion the sweep discipline has now needed six times. `src/lib/git/failures.ts` is
listed as a **named exemption** rather than rewritten: `/-/mirror` is Task 7's to fold in, and a
task that moves another task's permission line without owning its tests is how a phase loses an
afternoon.

**Mutation-verified in both directions, which is what Task 4's finding demands.** With
`if (viewer.isSuperAdmin) return null;` deleted, 15 of 18 tests in
`tests/integration/systems-admin.test.ts` fail — including the super admin's own calls, e.g.
`expected { ok: false, reason: 'not-found' } to deeply equal { ok: true, key: 'kiosk-bridge' }`.
With the body replaced by `return null`, four fail the other way, including
`expected { ok: true, …(1) } to deeply equal { ok: false, reason: 'not-found' }`. There is no
second guard that could produce either answer: `listSystemsForAdmin` has no other filter at all,
and `createSystem` genuinely inserts the row. The discriminating viewer is an **ADMIN of a real
space** — the viewer `can(v, space, "MANAGE_SPACE")` says yes to — and not a stranger, because a
member of nothing is refused by any predicate at all.

**`can(viewer, space, "MANAGE_SPACE")` was not an option here, for a structural reason rather than
a strict one:** §7 makes a system global, so `/admin/systems` administers rows with no `spaceId`
for `can()` to be asked about. That is worth carrying to Task 6, where a space *is* to hand and the
temptation will be real.

**`validateSystemKey` borrows `validateSlug`'s rules and remaps only the sentences.** The character
class is the same predicate — one lowercase URL segment — so a second regex here would be the
untestable-duplicate failure this project keeps finding; what is new is the wording (two of
`validateSlug`'s messages would be wrong on this field: `reserved-prefix` explains application
routes, which is true of `/{space}/-/adrs` and irrelevant under `/systems/`) and **one rule**: no
**trailing** hyphen, which Task 1's CHECK has and a slug does not. `validateSlug("hub-")` is
`{ ok: true }` and `validateSystemKey("hub-")` is `hyphen-edge`; that pairing is the test that
would fail if this module were replaced by a bare delegation.

`SYSTEM_KEY_MAX_LENGTH = SLUG_MAX_LENGTH`, **derived and asserted as an identity rather than typed
as 80** — the tie Task 1 refused to make in SQL. `src/lib/systems/key.test.ts` also re-types the
migration's regex *on purpose* and runs both over the same corpus: a test whose job is to catch a
divergence between two independent statements of a rule cannot share one of them. Task 3's
measurement is restated as an assertion there: a 300-character key **passes the CHECK** and is
refused here.

**The credential fix's other end, and it reuses `repo-url.ts` rather than parsing again.**
`repoField` calls `repoLinkOf` and refuses **every** `withheld` reason, not only `credentials` —
the scheme allowlist matters as much on the way in, since a stored `javascript:` URL is script
execution in an `href`. What is stored is `url.href`, the parsed form whose scheme and userinfo
were just checked, so nothing inspected can differ from what is written. The sentences are this
surface's own (`REPO_REFUSED_SENTENCE`, about a URL being typed) and not `REPO_WITHHELD_SENTENCE`'s
(about one already stored): one predicate, two audiences.

**The test and its non-vacuity companion are in one assertion** — the same repository, one
component removed, is accepted and stored:
`expected a field error, got {"ok":true,…}` is what the mutation produces when the `withheld`
branch is deleted (4 tests die, including `expected [ 'key', 'name' ] to deeply equal [ 'key',
'name', 'repoUrl' ]`). The message is asserted to contain neither the token, nor `oauth2`, nor the
host: an error message is rendered, logged and screenshotted.

**An edit is a `PATCH`, and `repoUrl` is what decided it.** A replacement form has to prefill every
input, which would mean sending a stored — possibly credentialed — URL to the browser and undoing
Task 3's half of the fix on the one page whose job is to repair it. So the field is never
prefilled, its placeholder describes the column's state without quoting it, a checkbox clears it,
and `an edit that does not mention repoUrl leaves a stored credentialed URL untouched` pins that an
edit of the *name* neither clears nor prints it.

**What a refused delete shows and offers.** The reference count is on **every row before anything
is clicked** — that is the prediction half — and it counts every `PageSystem` row, soft-deleted and
unpublished pages included, because every one of them is a row `Restrict` refuses over. It is
therefore **not** the number `/systems/[key]` renders, which is smaller, and the module says so.
The refusal itself states the count, the reason (a facet row is a projection of authored
frontmatter) and the alternative, and the surface renders `Mark it sunsetting instead` in the place
the refusal appeared. When the system is already sunsetting the sentence changes rather than
repeating itself.

**There is deliberately no pre-check before the delete.** `if (count > 0) return referenced` would
be the same predicate stated twice with the copy that mattered untestable — deleting it changes
nothing an assertion can see, because the `P2003` catch produces the identical answer — and it
would still be wrong under a race. The count in the message is read **after** the refusal, where it
describes the state that actually refused.

**The rename: allowed, warned about with that same count, and audited on the row that changed.**
Refusing would make a key immutable for ever the moment one page named it, with **no escape hatch
behind it** — `Restrict` refuses the delete-and-recreate an admin would fall back on — so a typo
noticed after the first publish would be permanent. The breakage a rename does cause is loud,
bounded and already has a message: `resolveSystems` refuses the republish with a
`PublishFieldError` on `systems:` that lists the catalogue. That is asserted end to end rather than
from a comment — `after a rename, republishing a page that named the old key is refused and says
so` drives a real `createPage`, `saveDraft`, `publishPage`, rename, `saveDraft`, `publishPage`,
with the first publish as the non-vacuity companion. Nothing rewrites the author's frontmatter: a
published version is what an author wrote and what the mirror committed.

**`AuditEntry.spaceId` widened to `string | null`, which is the deliberate widening that type asked
for.** Its own docstring said *"a future spaceless event should widen this deliberately rather than
discover that `undefined` was allowed all along"*, and a system has no space. Required-and-nullable
rather than optional, so the five page actions still cannot omit it by accident. Three actions join
`AuditAction` — `system.create` (the only record of when a system was added, since Task 1 removed
`createdAt` on precisely that argument), `system.update` (carrying `previousKey`, null and not
absent, plus `strandedPages`), and `system.delete` (the only record left, the row being gone).
**No audit row carries `repoUrl` by value**, only by name in `fields`: an audit row is a column, it
is designed to outlive what it describes, and nothing redacts it.

**Task 1's audit line, applied and mutation-verified.** *"Showing the number needs no audit; showing
the titles does."* The count ships with every row and writes nothing; `listBlockingPages` is a
separate endpoint behind a separate control and calls `auditSpaceAccess` once per space that
produced a row. Asserted as a **discrimination**: one super admin, one `MEMBERS` space they do not
belong to, two calls, one `space.access` row. Removing the loop fails it with
`expected [] to have a length of 1`. `handbook` is `ALL_STAFF` and contributes none, which is
`needsAccessAudit` being called rather than copied.

**`readableSpace` and `visiblePage` are absent from this module, at the line, and the second
absence is load-bearing.** `readableSpace` would be inert (`readableSpaceWhere` answers `{}` for a
super admin — the `resolveRedirect` shape) *and* wrong, since a page in a space the admin is not a
member of blocks the delete exactly as hard as one they can read. `visiblePage` would be plainly
wrong: `PageSystem.pageId` cascades from `Page` and this product has no hard delete, so a
soft-deleted page keeps its facet row and keeps blocking. Adding
`page: { deletedAt: null }` fails `a soft-deleted page still blocks, is listed, and is flagged`
with `expected [ [ 'Live note', false ] ] to deeply equal [ [ 'Gone note', true ], …(1) ]`. The
test also asserts the list's length equals the refusal's count, which is the property the filter
would break.

**The route collision, measured the way Phase 5 Task 8 and Task 3 measured theirs — and it is the
narrow shape.** A throwaway `badam_p7t5_probe`, `prisma migrate deploy`, a space genuinely keyed
`admin` holding published pages at `systems`, `ordinary`, `deep` and `deep/page`, a real
`next build` and `next start` on 3177, signed in through `test-login`:

| URL | Answer | What served it (asserted on the `h1`) |
|---|---|---|
| `/admin` | 200 | **the space's landing page** — `Admin space` |
| `/admin/systems` | 200 | this route — `Manage systems`, over the space's page at `systems` |
| `/admin/ordinary` | 200 | the space's own page at depth one |
| `/admin/deep/page` | 200 | the space's own page at depth two |
| `/admin/no-such-page` | 404 | |

`routes-manifest.json` puts `^/admin/systems(?:/)?$` in **`staticRoutes`** and adds **nothing** to
`dynamicRoutes` — the contrast with `/systems/[key]`, which sits at index 14 of `dynamicRoutes`
ahead of `/[space]` at 15, and therefore swallows every depth-one path in a space keyed `systems`,
404ing rather than falling through. **So the window here is exactly one path**, the `/-/mirror`
shape and not the `/systems` one, and that is a property of this route being fully static rather
than of anything anyone chose. There is deliberately **no `/admin/page.tsx`**: a layout without a
page creates no route, which is why `/admin` still resolves to `[space]`. Tasks 6, 7 and 8 each add
one more leaf and one more path to the window; an `/admin` index is what would also take the
landing page. No space is keyed `admin` today.

**The overflow probe, injected and counter-checked.** `HOSTILE` into the name, owning team and
description, a 300-character credentialed `repoUrl`, and a blocking page whose title is `HOSTILE`,
with the row's listing **and** its edit form open before anything is measured — the non-vacuity
half, because a probe over a page where the hostile strings never rendered reports 0px and means
nothing. **0px at 1280, 860 and 380.** Counter-checked rather than trusted: setting
`.adm-page-title` to `flex: none` reproduces **667px at 1280px**, which is Task 3's ninth shape
arriving on this surface. The page reuses `.sys-row`, `.sys-key`, `.sys-team` and `.sys-repo`
rather than growing parallel rules, so it inherits the guards that shape earned; `flex: none` here
is reserved for `.sys-kind` (a `SystemKind`) and `.adm-refs` (an integer from a `_count`).

**Two things the e2e suite found that no module test could**, and they are the useful part:

- **A refusal must survive the button it invites.** "Which pages?" is what an admin presses after a
  refused delete, and the request cleared the row's feedback — so pressing it deleted the
  refusal's sentence *and* the sunsetting offer at the exact moment they acted on them. Found by
  walking the loop in the order an admin walks it, not by asserting each step. The listing request
  no longer clears; the four mutations still do.
- **An assertion over `page.content()` is an assertion about the framework.** `not.toContain(
  "forbidden")` fails on **every** page in this product, 200s included: Next 16 ships `forbidden()`
  as an API and its name is in the client bundle. The assertion is now over rendered text, and over
  the stronger claim — the refusal's visible text is **identical** to the 404 for a URL nobody
  built a route for.

**One thing in the brief turned out not to hold.** It said to measure the collision because
`/admin/systems` is fully static and the cost should be measured "rather than assuming either
precedent" — and the measurement lands squarely on the `/-/mirror` precedent, one path deep, with
no third shape. The brief also implied `/admin` itself might be at stake; it is not, because
nothing routes it. That is worth Task 6 knowing before it adds `/admin/spaces`.

**Numbers:** 1456 vitest over 99 files (was 1400/95 — +56 tests, +4 files: `key.test.ts`,
`gate.test.ts`, `systems-admin.test.ts`, `systems-admin-route.test.ts`, plus 2 from the new
`visible.test.ts` registration, which `test.each`es twice), 90 Playwright (was 83), typecheck 0,
build 0, `plan:check` **0 drifted** with every bucket unchanged (70 in sync · 13 fragment · 30
superseded · 19 unmatched · 66 not code), 119-check smoke passing, dev baseline unchanged at
2 spaces / 7 pages / 7 systems / 0 page systems and every seeded `reviewedAt` still `2026-08-18`.

---

## Task 6: `/admin/spaces`, and the key that was never validated ✅

**Files:** routes, `src/lib/spaces/admin.ts`, `src/lib/spaces/key.ts` + tests. Plus four the plan
did not name: `prisma/migrations/20260905150800_space_key_shape` (the CHECK), a
`RESERVED_TOP_LEVEL_SEGMENTS` constant in `src/lib/pages/href.ts`, `validateUrlSegment` extracted
into `src/lib/pages/slug.ts` when the second caller arrived, and `src/components/AdminSpaces.tsx`.

- [x] **Step 1: Spaces and memberships**

The first surface that creates a `Space`; until now only the seed did.

- [x] **Step 2: Validate `Space.key` — the debt Phase 5 named three times**

~~Reuse `validateSlug`'s rules — it already refuses a leading `-`, uppercase, dots and anything
outside `[a-z0-9-]` — and add the **folded uniqueness** a slug rule cannot express.~~ **Superseded
in one half and confirmed in the other**: the rules are reused, and delegating the route collision
to them closes one of seven — see the first closing note.

- [x] **Step 3: Say what the window was**

**`validateSlug` accepts six of the seven segments a space key can shadow, so a slug rule does not
close route shadowing.** The seven top-level static segments this application serves are `api`,
`admin`, `search`, `systems`, `edit`, `new` and `-`. Run against `validateSlug`:

```
  admin ACCEPTED · search ACCEPTED · systems ACCEPTED
  api   ACCEPTED · new    ACCEPTED · edit    ACCEPTED
  -     refused (reserved-prefix)
```

So Phase 5 Task 8's promise — *"it does not remove the collision, it makes the fix a rule the
product already states"*, offered as costing this phase "one rule" where a list would cost "a list
that grows with every route" — was measuring one case and generalising. That fence in
`src/lib/pages/href.ts` is annotated as superseded rather than rewritten, and the six-of-seven
count is now an **assertion** in `src/lib/spaces/key.test.ts` rather than a sentence anywhere, so
it cannot rot.

**What closes it is `RESERVED_TOP_LEVEL_SEGMENTS`, and the argument is against Phase 5's objection
rather than around it.** The objection was that such a list grows with every route. Three answers,
and only the first is the measurement above:

1. **The list does not grow with every route; it grows with every top-level *segment*.** A space
   key is exactly one segment, so `/admin/spaces` and `/systems/[key]` cannot shadow one at all.
   Seven segments in six phases, and each was already a decision somebody wrote a docstring
   about — this file's `href.ts` holds three of them. About one per phase, not one per route.
2. **A growing list is only a cost when it is maintained by attention**, and this project stopped
   maintaining rules that way six widenings ago. `src/lib/spaces/key.test.ts` derives the segments
   from the `src/app` directory — descending into route groups, skipping dynamic segments — and
   fails when the constant disagrees. Adding a top-level route without deciding about the
   collision is a **failing test**, which is the same discipline as `gate.test.ts`'s sweep for an
   ungated admin module and `visible.test.ts`'s for an unregistered query. It carries the
   non-vacuity companion those two needed, which this project has now written **seven** times.
3. **The alternatives lose on their own terms.** *Moving the routes* under `-/` was already refused
   for `/systems` on §11 grounds and cannot move `api`. *Accepting the collision* means a page that
   exists in Postgres and in the git mirror answers 404, which Task 3 measured for a whole
   depth-one level. *Nothing at all* is the six-of-seven measurement.

Framework-owned names need no entry and are asserted not to have one: `_next`, `favicon.ico` and
friends contain `_` or `.`, which the character class refuses long before the reserved check.

**The list is deliberately not in the database, and the CHECK deliberately is.** `Space_key_shape`
is `System_key_shape`'s regex character for character and constrains the column for *every* writer;
the route list changes when a directory is added under `src/app` and would be, in SQL, the
untestable half of a rule stated twice. That is `validateSystemKey`'s split against Task 1's CHECK,
one rule further along.

**Folded uniqueness came free, and a second index would have been the half-measure.** Task 1's
insight holds: on a lowercase-only column `key = lower(key)` for every row, so the existing
`Space_key_key` **is** a unique index on `lower(key)`. A `CREATE UNIQUE INDEX ON "Space"
(lower(key))` would be a second statement of one guarantee with the removable copy untestable. The
class being ASCII also closes the half `src/lib/git/paths.ts` refused to half-close: there is no
NFC/NFD pair and no Turkish dotless `ı` inside `[a-z0-9-]`, so `Engineering`/`engineering` sharing
one mirror directory on this machine's case-insensitive filesystem is now unrepresentable rather
than merely discouraged. That module's two notes are annotated, and its `paths.test.ts` needed no
change — it takes strings as **arguments**, which is the level it operates at.

**The rows were verified before the ALTER was written, and the failure mode was reproduced rather
than imagined.** In SQL against the development database:

```
     key     | len | passes_check | is_folded | is_ascii
-------------+-----+--------------+-----------+----------
 engineering |  11 | t            | t         | t
 handbook    |   8 | t            | t         | t
```

with `select count(*) from "Space" where key !~ '…' or char_length(key) > 80` returning `0` and the
folded-duplicate group-by returning nothing. Then, on a throwaway `badam_p7t6_probe` at
`prisma migrate deploy`, the same three rows plus one keyed `eng ops`:

```
ERROR:  check constraint "Space_key_shape" of relation "Space" is violated by some row
```

Deleting that row and retrying: `ALTER TABLE`. And `prisma migrate diff` from the probe to the
schema afterwards: `-- This is an empty migration.` — so Prisma's diff cannot see the CHECK on this
table either, which is the property Task 1 measured for `System` and the reason a hand-written
migration survives the next `migrate dev`.

**What the seeded rows said nothing about, and this is the thing in the brief that turned out
wrong.** The brief and the plan both frame Step 2's risk as *"two rows exist and both look legal,
verify before writing the ALTER"*. Both rows are legal and the verification was worth doing — but
the rows that actually violated the constraint were **not in any database the brief pointed at**.
`tests/integration/review-route.test.ts` creates a space keyed `"eng ops"` and
`tests/integration/restore-route.test.ts` updates one to it, and the same migration lands on
`badam_p5_test`. A scan for every `key: "…"` literal in the repository found exactly those two
(plus two `System` create *inputs*, which are refused in application code and never reach the
column). Checking the populated table is the necessary step; checking the **fixtures** is the one
that would have been skipped, and it is the one that would have turned a green suite red at the
end of the task rather than at the start.

Both fixtures now use `eng-ops`, and the coverage they exist for survives intact: their claim is
that a route calls `pageHref` rather than concatenating, and **`Page.path` still has no CHECK** —
those same tests write `architecture notes/mqtt-contracts` and `architecture/mqtt contracts`
directly, so the assertion is still `/eng-ops/architecture%20notes/mqtt-contracts`, one segment
encoded and the separators surviving. What is lost is only the *space-key* half of a hostile
fixture, and it is lost because the database now makes it impossible, which is the point.

**The window, stated in three parts.** Validation closes this going forward and retro-validates
nothing — no migration rewrites a key, because a `Space.key` is in every URL of the space, is the
mirror's directory name, and is in every link anyone has shared, so a repair pass would break all
three silently. The CHECK is the one retroactive part, and only because it was verified to pass
first. So:

1. The two rows that exist are legal and neither is a reserved word; `key.test.ts` pins both so a
   future seed cannot introduce a key the create form would refuse.
2. **A key created before this task could shadow a route, and the cost differs per route** — Task 3
   measured a space keyed `systems` losing its landing page *and every depth-one path*, each
   **404ing rather than falling through** to a page Postgres and the git mirror both still hold;
   Task 5 measured a space keyed `admin` losing one path per admin leaf and keeping its landing
   page. Nothing in the product reports either.
3. **A key created before this task could still be `Engineering` or `eng ops`.** Neither is
   storable now, by any writer. There is no such row here; had there been one, the migration would
   have failed loudly against it rather than quietly excusing it, and the probe shows exactly what
   that looks like.

**`/admin/spaces` widens the `admin` window by exactly one path, and that was checked against this
build's manifest rather than assumed.** `^/admin/spaces(?:/)?$` is in `staticRoutes` and nothing
was added to `dynamicRoutes` except its `/api/…` siblings, which live under `api`;
`/systems/[key]` is still at `dynamicRoutes` index 17, ahead of `/[space]` at 18. Task 5's shape,
confirmed rather than re-measured with a probe database — its measurement was of the route *class*
(fully static, no `/admin` index) and this route is in the same class.

**The membership surface's audit decisions, and the line moved one category from Task 1's.** Task 1
drew it as *"showing the number needs no audit; showing the titles does"*. Here it is **the
container versus what is inside it, and the people are inside it**: `listSpacesForAdmin` writes
nothing — keys, names, visibilities and two integers, which a super admin needs to administer
anything and already sees on every admin surface — while `listSpaceMembers` writes one
`space.access` row, because *this named person belongs to this private space* is what a `MEMBERS`
space keeps to itself. Its own endpoint behind its own control, `listBlockingPages`'s shape, so the
count is free and the names cost. Asserted as a **discrimination**: one super admin, one request,
the whole index plus an `ALL_STAFF` space plus a `MEMBERS` space, **one** row — `handbook`
contributing none is `needsAccessAudit` being called rather than copied. Removing the call fails
two tests.

**Five new `AuditAction` values, and three of them are memberships because they are three
questions.** `space.member.add`/`.role`/`.remove` rather than one action with a verb in `detail`:
*who was granted access* is asked after a leak and *who lost it* after an offboarding, and
collapsing them makes both a JSON predicate over an unindexed column. `.role` earns its place
separately because a `VIEWER` promoted to `ADMIN` gains `MANAGE_SPACE` with no row created and none
deleted — add-and-remove alone would show a membership that never changed. Every one records the
subject by **`userId` and never by email**, which is `accessDetail`'s rule applied to the subject:
`User` rows are never deleted so the id stays resolvable, and an email is the mutable half. On
`space.member.remove` that row is the only surviving record the membership ever existed, the same
standing `system.delete` has.

**The widening no membership action would see, and it also switches off the trail.** A
`MEMBERS` → `ALL_STAFF` flip grants read to every signed-in person without touching a
`SpaceMembership` row, *and* ends this space's `space.access` trail, because `needsAccessAudit`
fires for `MEMBERS` spaces alone. So `space.update` carries `previousVisibility` — null and not
absent, the `previousKey` distinction — and it is the only durable record of the moment. That
consequence is asserted rather than described: one member listing before the flip writes a row, the
identical listing after it writes none, and the `space.update` row saying `previousVisibility:
"MEMBERS"` is what remains.

**A `Space.key` is editable only while the space is empty, which is a deliberate divergence from
Task 5's rename.** Task 5 allowed a `System.key` rename outright because refusing would make a key
permanent with no escape hatch, while the breakage is *loud, bounded and already has a message* —
`resolveSystems` refuses the next republish and names the fix. Both halves invert here. A space
rename breaks every URL anybody has shared (this product writes no space-level `Redirect`;
`Redirect` is per-space and per-path) and strands `content/<old-key>/` in the mirror
(`GitJobKind.MOVE` is per page, and nothing moves a directory) — **and nothing reports either**. The
escape hatch is the empty space, which is the typo case and is Task 1's `Restrict` argument in the
same shape: *deletion is the verb for a row created in error, and a row created in error has no
pages naming it*.

**There is a pre-check, which Task 5 argued against, and the divergence has a reason.**
`deleteSystem` has none because the foreign key is the authority and a pre-check would be
undeletable-by-test. **Nothing in this schema expresses "a space with pages keeps its key"**, so
this check *is* the rule and its only statement — deleting it fails a test. The count it reads is
every `Page` row, **soft-deleted included**, because a soft delete does not un-share a URL and
`restorePage` brings the mirror file back; filtering it to live pages fails the same test on the
number in the sentence. The window it cannot close is stated at the line: the count is read inside
the transaction, a page committed concurrently is not prevented under READ COMMITTED, and losing
that race costs one page mirrored under the old key — which is what Task 7's reconciliation pass is
the operator surface for. Locking `Space` on every publish to buy exactness is a hot-path cost for
a race between two administrators.

**`refuseNonAdmin` reused, and mutation-verified in both directions.** Seven entry points, each
opening with the same two lines; `src/lib/admin/gate.test.ts`'s sweep sees the new module without
being told about it. With `if (viewer.isSuperAdmin) return null;` deleted, **15 of 19** tests in
`tests/integration/spaces-admin.test.ts` fail, including the super admin's own calls — e.g.
`"admin" was accepted` and `refused: {"ok":false,"reason":"not-found"}`. With the body replaced by
`return null`, **2** fail the other way:
`expected { ok: true, …(1) } to deeply equal { ok: false, reason: 'not-found' }`. The
discriminating viewer is an **ADMIN of a real space**, not a stranger. `can(v, space,
"MANAGE_SPACE")` was the temptation Task 5 predicted, and beyond being the wrong scope it is
**circular here**: the membership rows this surface writes are what `can()` reads, so a space with
no `ADMIN` — which `createSpace` produces every time — would be one nobody could ever staff.

**A new space has no members, and that is left true.** The creating super admin is not inserted as
an `ADMIN`: `can()` already says yes to them so the row would grant nothing, and it would put a
non-member in the list this surface exists to keep accurate. The consequence — a `MEMBERS` space
with zero members is readable by super admins alone — is on the row rather than in a message that
scrolls away. Removing the last `ADMIN` is likewise reported and not refused, `admins` being read
after the write inside the same transaction: refusing would make the last admin of a space
unoffboardable, and a super admin can still manage it.

**`validateUrlSegment` was extracted rather than duplicated, and that touched a closed task's
module.** `Space_key_shape` is `System_key_shape` character for character, so `validateSpaceKey`
needed Task 5's exact decision and a different set of sentences. The two available shapes were a
space key asking a *system*-key function for a decision with nothing to do with systems, or the
rule written out twice; the third is what this project did to `stripControl` when
`src/lib/bugs/schema.ts` acquired a second caller. `validateSystemKey` is now its old body with the
decision moved out, and `src/lib/systems/key.test.ts` — which re-types the migration's regex on
purpose and runs both over one corpus — passes unchanged, which is the evidence the move changed no
behaviour.

**What the e2e suite found that no module test could, and it is Task 5's finding arriving again.**
`showMembers` was written with `clears = true`. Widening a space says what it just did, with the
page count; **pressing "Members" to see who that affected deleted the sentence at the moment the
admin acted on it** — the identical defect Task 5 found on "Which pages?", on a surface written
after reading its note. It was caught by walking the loop in the order an admin walks it, and by a
test that exists only because Task 5 wrote that note down. Task 5's second lesson needed no
rediscovery: the refusal assertion is over rendered text and against the stronger claim (identical
to a URL nobody built a route for), never over `page.content()`.

**The overflow probe: 0px at 1280, 860 and 380**, with the non-vacuity half first — a 300-character
name and description on the row, the member list open with an email in it, and the edit form
rendering the same strings again in inputs. The page reuses `.sys-row`, `.sys-head`, `.sys-meta`,
`.sys-key`, `.adm-page-title` and the rest rather than growing parallel rules, so it inherits
Task 3's ninth shape by construction; the three new selectors that could have repeated it —
`.adm-email`, `.adm-note`, `.adm-member` — all shrink, and `flex: none` is reserved for
`.sys-kind` (a `SpaceVisibility`), `.adm-refs` (two integers) and `.adm-role` (a three-value
`select`).

**The affordance ships with the thing**, and it cost no route: the `/admin/*` cross-links are in
`src/app/(reader)/admin/layout.tsx`, because **a layout without a page creates no route** — so
`/admin` still resolves to `[space]` and the index page that would have taken a space's landing
page still does not exist. `e2e/admin-spaces.spec.ts` walks both links and asserts `/admin` is
still a 404.

**Three things worth flagging beyond the fixture finding.**

- **There is no space `DELETE`, deliberately.** A `Space` cascades to `SpaceMembership` but its
  `Page` rows are the documents, this product has no hard delete for a page, and `content/<key>/`
  is a mirror directory nothing here could remove — so a space delete would be the largest
  destructive act in the product arriving with none of the machinery the smallest one has. The
  honest gap is that a space that should stop being used has no state for it; `System.isActive` is
  the shape a later phase should copy. Said at the route rather than left as an omission.
- **`Space.initials` is required and rendered nowhere.** `getReadableSpaceByKey` selects it and no
  component reads it. This surface asks for it rather than deriving it from `name`, because a
  derived value is one the admin never typed — but the column is a chip with no chip.
- **`prisma migrate status` was clean before and after**, and the migration was generated by hand
  and applied with `prisma migrate deploy` to both databases. `migrate dev` was never run, which is
  what PROGRESS says to do here.

**Numbers:** **1512 vitest over 102 files** (was 1456/99 — +56 tests, +3 files:
`src/lib/spaces/key.test.ts`, `tests/integration/spaces-admin.test.ts`,
`tests/integration/spaces-admin-route.test.ts`), **97 Playwright** (was 90, +7), typecheck 0, build
0, `plan:check` **0 drifted** with every bucket unchanged (70 in sync · 13 fragment · 30 superseded
· 19 unmatched · 66 not code), **119-check smoke passing** and unextended — Task 9 owns the two new
tables it does not have, and this task added none. Dev baseline unchanged at 2 spaces / 7 pages /
7 systems / 0 page systems, and every seeded `reviewedAt` still `2026-08-18`.

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
