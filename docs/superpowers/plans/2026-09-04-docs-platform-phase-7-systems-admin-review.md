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
