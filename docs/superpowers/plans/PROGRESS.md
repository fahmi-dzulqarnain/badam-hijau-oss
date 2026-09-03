# Execution status

**Phases 1–4 are complete and in `main`** (Phase 4 merged as `8dfc7c7`). **Phase 5 (git mirror)
is under way — Tasks 1–5 of 9 done.**

Branch: `phase-5-git-mirror` (cut from `main` at `8dfc7c7`; this phase lands through a PR) ·
**951 vitest + 41 Playwright tests passing**, **82-check** cold-start smoke · typecheck, build
and `plan:check` clean · working tree clean

Plans: [phase 1](2026-08-21-docs-platform-phase-1-foundations-reader.md) ·
[phase 2](2026-08-23-docs-platform-phase-2-authoring.md) ·
[phase 3](2026-08-24-docs-platform-phase-3-doc-types.md) ·
[phase 4](2026-08-25-docs-platform-phase-4-search-diagrams.md) ·
[phase 5](2026-08-26-docs-platform-phase-5-git-mirror.md) ·
[roadmap](2026-08-21-docs-platform-roadmap.md)

## Phase 5 — git mirror

Decisions taken with the user: **shell out to the real `git` binary** with argv arrays; **a
standalone worker script on a schedule** rather than an in-process drain; **a minimal super-admin
failure page now**, folded into Phase 6's `/admin` later; and **publish, move and delete all
enqueue** — §9 names only publish, but `movePage` rewrites `Page.path`, so a publish-only mirror
orphans a file at the old path.

One decision this phase took on its own: **the mirrored file is composed from the version row, not
copied from it.** `publishPage` stores the author's whole document, frontmatter text included,
while `PageVersion.frontmatter` holds what validation *accepted* — deliberately a different value.
The deciding fact is that `title` is a column and not part of the document text, so a verbatim
mirror would produce files that cannot say what they are. What is given up: the templates'
explanatory frontmatter comments do not reach the mirror.

Landmines carried in, measured while planning:

- **Three different things here are called `gitSha`**, and two are not this phase's:
  `buildInfo().gitSha` is the application build (7 chars, from `GIT_SHA`), `BugReport.gitSha` is a
  copy of that, and `PageVersion.gitSha` is a commit in the **content** repository — a different
  repository. A page will show two shas that mean different things.
- **A title is user-controlled and lands in two parsers** — YAML, where a newline could inject a
  second key, and a commit message. Measured and reassuring: a `GIT_AUTHOR_NAME` of
  `--upload-pack=…` passed through the environment is stored as a name, not parsed as an option,
  so env vars are the safe channel and `--author=` string building is the thing to avoid.
- **A fresh repository answers 128** to `rev-parse HEAD`, `rev-parse --verify HEAD` and `log -1`
  alike — an expected state, not a crash. Found while a pipeline hid that exit code and reported
  success, which is the fourth time that trap has bitten this project.
- **Commit and push are two failures**, and only one may be retried by repeating it. A sha
  recorded late means a retried push commits twice.

| Task | State |
|---|---|
| 1. The mirrored document | ✅ |
| 2. Where the file goes | ✅ |
| 3. `GitJob` | ✅ |
| 4. Enqueue, inside the transactions that already exist | ✅ |
| 5. The git seam | ✅ |
| **6. The worker** | **next** |
| 7. The sha on the page | — |
| 8. Failures a super admin can see | — |
| 9. End-to-end and the smoke test | — |

## Phase 4 — search and diagrams

Decision taken with the user: **the application strips, the trigger weights.** §13 asks for a
`tsvector` derived from Markdown-stripped body text and maintained by a raw-SQL trigger — and a
plpgsql trigger cannot run remark. So publish produces the plain text with the parser that
already understands the document, and the trigger builds the weighted vector from stored columns,
which keeps what a trigger is *for*: the vector cannot drift from its row when a write that is
**not** a publish changes a searchable field.

Two landmines carried in, both measured rather than guessed:

- **Hydrating a Mermaid diagram decodes what the sanitiser escaped.** Reading `textContent` hands
  Mermaid the literal `</div><script>alert(1)</script>`. `securityLevel: "strict"` is required,
  explicitly, and the source must never move through `innerHTML`. The escaping protects the
  *document*, not the diagram source.
- **Mermaid is 84 MB unpacked**, so it must be a dynamic import absent from the bundle of any
  route without a diagram — asserted against `next build`'s output, not claimed.

| Task | State |
|---|---|
| 1. Plain text from Markdown | ✅ |
| 2. The index, and the trigger that maintains it | ✅ |
| 3. The query | ✅ |
| 4. The search route | ✅ |
| 5. Mermaid hydration | ✅ |
| 6. End-to-end | ✅ |
| 7. Extend the smoke test | ✅ |

**All seven tasks done and every exit criterion verified** — see the end of the
[phase-4 plan](2026-08-25-docs-platform-phase-4-search-diagrams.md).

Three findings from this phase that generalise, all measured:

- **A security test that cannot fail when the setting it is about is weakened is worse than no
  test**, because it reads as coverage. `securityLevel: "strict"` is already Mermaid's default and
  does **not** decide label sanitisation — DOMPurify runs at every level — so the obvious hostile
  label test stays green with the setting mutated to `"loose"`. The assertion that discriminates is
  `click A href "javascript:…"`.
- **An absence assertion needs a viewer who can see *something*.** "A non-member finds nothing"
  is near-vacuous when the viewer reads no space at all: the ids go into `spaceId = ANY(...)`, and
  `ANY('{}')` is indistinguishable from a deleted clause. The test that has teeth is a
  discrimination — the same word in two spaces, and a **count**.
- **The same needle the test searches for is echoed back into the page**, in the input's `value`
  and in the no-hits sentence, so over HTTP a body containing it is entirely consistent with zero
  results. Assert the row, or the count sentence.

The count contract was too narrow for the **seventh** time (`snapshotCounts` could not see the one
`BugReport` a spec wrote), and a plan-fence guard was found matching **by accident** for the fifth
time (`isSuperseded` was matching the word `SUPERSEDED` in a sentence about ADR statuses).

Published (private): https://github.com/fahmi-dzulqarnain/badam-hijau — `main` carries both
completed phases.

## Phase 3 — doc types and lifecycle

Decisions taken with the user: relations name their target by **space-relative page path**,
resolved to a page id at publish time; templates are **files in the repo** (one-file modules, not
`.md` — Task 4 measured why). All 13 tasks done and every exit criterion verified — see the end of
the [phase-3 plan](2026-08-24-docs-platform-phase-3-doc-types.md). Next: **Phase 4, search and
diagrams**, which owns the search-ranking demotion §6.4 promises for retired pages and the Mermaid
hydration constraint the roadmap already records.

| Task | State |
|---|---|
| 1. Schema: relations and frontmatter | ✅ |
| 2. Frontmatter out of the rendered body | ✅ |
| 3. Per-doc-type frontmatter schemas | ✅ |
| 4. Templates | ✅ |
| 5. Resolving a relation reference | ✅ |
| 6. Relation guardrails | ✅ |
| 7. Frontmatter and relations in publish | ✅ |
| 8. Cascades | ✅ |
| 9. Reading relations, and the retired banner | ✅ |
| 10. Generated indexes | ✅ |
| 11. The editor's status and frontmatter surface | ✅ |
| 12. End-to-end | ✅ |
| 13. Extend the smoke test | ✅ |

**It started by fixing a bug it inherited** — the render pipeline turned frontmatter into an
`<hr>` plus a heading whose id landed a junk entry in the table of contents. Fixed in Task 2;
invisible for two phases because nothing wrote frontmatter.

Findings worth carrying from Task 2:

- **Count entries, not keys.** A key cap leaves `related: [0…100000]` open — one key, depth 2,
  passes both a key cap and a depth cap. Same "count the right unit" lesson as the byte cap.
- **A cyclic YAML anchor is two lines, parses with no errors, and yields a self-referential
  object** that makes `JSON.stringify` throw — so it would have reached the `Json` column and
  turned four words into a 500 on autosave. A naive recursive walk blows the stack first.
- **An alias bomb only explodes during `toJS()`**, so a post-parse walk never sees a value;
  `yaml`'s `maxAliasCount` is what catches it.
- **The stripper and the parser agree by construction, not convention** — one declaration of
  what frontmatter is, and the split slices on the parsed node's offset. A regex cannot see a
  fenced code block.
- **A cap has to bound the thing that costs something.** `MAX_FRONTMATTER_ENTRIES` cannot tell
  200 list items from 200 round trips, so relation targets get their own cap: each one costs a
  resolution query, a cycle walk and a row lock inside one transaction.
- **A test for "X is excluded" is vacuous if X could not have been included anyway.** Task 1's
  test that a *second* `---` block is not treated as frontmatter first put prose between the two
  blocks — which pushes the second off offset 0, where `remark-frontmatter` cannot match it
  either way. The mutant that re-enabled the plugin passed 33 of 33. Butting the blocks together
  separates the implementations. Same family as the non-vacuity companion.
- **Any assertion about a list, on a route that renders the reader shell, must bind to that
  list's own markup.** The nav rail names every page in the space on the same HTML, so a
  title-shaped needle passes for free — Task 13's smoke pass had a banner check that stayed green
  with the cascade disabled entirely.
- **Do not add a guard clause that cannot fail on its own.** Task 13 declined to add a
  `PageRelation` clause to the smoke sweep's exception guard: both foreign keys cascade and every
  relation has a marked page at each end, so the clause could only be true when the clause above
  it already was. It added a before/after count comparison instead — which is stricter, because it
  also catches rows nothing knew to delete.
- **A refusal that survives deleting the guard it is about is a test of the other guard.** Task
  12's first cycle test passed with cycle detection disabled, because the same publish was also
  refused by the cascade's transition check. Mutation testing is what exposed it — the test was
  green either way. When a test asserts a refusal, delete the guard it names and confirm the
  refusal *changes*.
- **Playwright parallelises across files, and a sweeping fixture cannot survive that.** `workers:
  1`, because `sweep()` deletes every `e2e-` page and every audit row created since the worker
  started, and `snapshotCounts` is a whole-database count.
- **Correcting a plan is not correcting the code comment that says the same thing.**
  `MAX_RELATION_TARGETS`'s reasoning was corrected twice in the phase plan and once here as tasks
  measured it wrong — and the docstring in `schema.ts` went on stating the original for three more
  tasks, where a reader would meet it first. When a stated measurement goes stale, grep the code
  for it too (with `rg` or Python — see above).
- **An equivalence assertion over two derived sets needs a non-vacuity companion.** Task 9
  changed a vocabulary table and re-derived `terminalStatuses`; had it not, `amends` would have
  silently vanished from the frontmatter keys — and `schema.test.ts`'s equivalence assertion would
  have gone **vacuously true**, both sides empty. The line beside it asserting the sets are
  non-empty is what caught it. An equivalence test passes hardest exactly when both derivations
  break together.
- **Sometimes the right move is to state a predicate in *fewer* places, and the reason is
  falsifiability.** Task 9's relation reads deliberately carry no `spaceId` shape constraint —
  the opposite of `resolveRedirect` — because a viewer reading a page can always read its space,
  so the only rows `readableSpace` can hide there are cross-space ones, which is exactly what a
  shape constraint would hide first. That would be a predicate stated twice with one copy
  invisible.
- **The soft-delete sweep has now been too narrow six times.** The latest: it matches Prisma
  *delegate* calls, and `$queryRaw`/`$executeRaw` name no delegate — so raw SQL was invisible.
  Four modules were registered only *by accident*, because each happens to also make a delegate
  call. Widened, with a companion test proving the new pattern matches something real — which
  earned its keep immediately: the first version of that widening required a `(` and so matched
  no tagged template at all.
- **A decision outlives its argument only if you let it.** `amends` was ADR-only because "no
  guardrail exists, so a wider key would be one nothing validates". Writing the guardrail
  dissolved that premise — and the premise was itself the defect, since an ADR could already
  declare `amends: <a runbook>` with nothing refusing it. When a task's stated reason is removed,
  re-derive the conclusion rather than keeping it.
- **Derive which cases a rule covers, do not list them.** `amends` belongs to doc types with a
  **terminal status** — one they publish into and never out of. ADR and RFC have them; DOC and
  RUNBOOK do not, because `ARCHIVED` publishes back into `CURRENT`. The test asserts that
  equivalence against `terminalStatuses`, so a vocabulary change moves the key table with it.
  Same shape as walking only `SUPERSEDES` for cycles: `DECIDES` cannot loop because the loop is
  *unrepresentable*, not because someone remembered to exclude it.
- **A visited set bounds a walk; it does not detect the loop.** Removing the set while keeping
  detection failed exactly one test — a **4-page** graph reported as a chain of over 200 pages —
  and every cycle test still passed. That is the mutation that tells you which mechanism is
  doing which job.
- **The one query in this codebase with no permission predicate** is the supersede-chain walk,
  and it is deliberate: it returns no row, names no page, its only observable is a boolean about
  the caller's own page, and relations cannot cross spaces in Phase 3. A phase that allows
  cross-space relations must add a **space filter on `from`**, not a viewer.
- **A plan can specify the same predicate in two tasks, and that is the untestable-duplicate
  failure arriving by a new route.** Phase 3's plan listed self-reference under both Task 5 and
  Task 6. Implemented twice, mutating away either copy would leave the suite green — the exact
  `resolveRedirect` shape. It lives in Task 5, because only resolution catches a reference to a
  page's own **pre-move** path, which a path-string comparison writes as a relation to itself.
- **When a stated measurement goes stale, correct it rather than leaving it to be trusted.**
  Task 3 justified its relation cap partly as "each target costs a resolution query"; Task 5
  batches, so that is three queries regardless. The cap survives on its other reasons — cycle
  walks and row locks do not batch — but the dead third was removed.
- **A bundler's asset-reference rewriting is layer-dependent, and only one layer gets a
  filesystem path.** The identical `readFileSync(new URL("./x.md", import.meta.url))` reads a
  real file from a route handler and receives a **browser** URL in a Server Component —
  Turbopack emits `.next/server/assets/…` for one and `/_next/static/media/…` for the other.
  Any future "read a repo file at runtime" must be probed **from the layer that will call it**:
  an API-route probe proves nothing about a server action, and the failure is invisible to
  vitest, to `next build` and to `plan:check`. This is why the templates are `.ts` modules and
  not `.md` files.
- **`z.strictObject`, not `z.object`** — one word between refusing a typo and stripping it
  silently. A mistyped `supersedez:` is a relation the author believes exists.
- **Three shapes go the opposite way from a line scanner's guess**: a code fence opening the
  document, a leading blank line, and `Title\n---` (a setext h1). Any implementation that
  `trimStart()`s or skips to the first `---` gets all three wrong.

## Phase 2 — authoring

Decisions taken with the user: **CodeMirror 6** for the editing surface, **soft delete** for
removal. Sixteen tasks (14b was added mid-phase, when Task 14 found the library had no product
surface); every exit criterion verified — see the end of the
[phase-2 plan](2026-08-23-docs-platform-phase-2-authoring.md). Next: **Phase 3, doc types and
lifecycle**, whose first job is the per-doc-type status vocabularies that Task 9 stubbed a
Phase-2 subset of, and whose RFC row the spec has already had corrected once.

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
| 10. Moving a page — the landmine | ✅ |
| 11. Redirects in the reader | ✅ |
| 12. Soft delete and restore | ✅ |
| 13. Audit wiring, incl. the Phase 1 debt | ✅ |
| 14. End-to-end coverage of authoring | ✅ |
| 14b. Reaching authoring from the product | ✅ |
| 15. Extend the smoke test | ✅ |

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

## A tooling trap that invalidates verification

**`grep` in this environment is a shell function from a Claude Code shell snapshot, and it
silently returns nothing for patterns that plainly match.** Measured: `grep -c publishPage
src/lib/pages/publish.ts` exits 1 and prints nothing, while `rg` finds 11 hits for
`cascade|TODO` in the same file and Python counts 7 `cascade` and 5 `TODO(phase-N)`.

It fails *silently and selectively* — most greps in this project worked, which is what makes it
dangerous. **Any conclusion drawn from grep finding nothing is worthless**, and "I grepped and
the code is absent" has been stated in this project on that basis. Use `rg`, or read the file
with Python, for anything load-bearing — especially a claim that something is *not* there.

**And `rg` has its own version of the same failure.** `src/lib/pages/publish.ts` contained a
literal NUL byte — a map key written as an actual `\0` rather than an escape — which made `rg`
classify the whole module as **binary and skip it silently**. Found while editing that very file.
Fixed to `\u0000`, and it is the same lesson the control-character tests already carry: **write
control characters as escapes, never as literals.** A literal NUL is invisible in a diff and
turns one file into a blind spot for the tool you switched to in order to be safe.

When a search must be trustworthy, read the file with Python and count.

**`timeout` and `gtimeout` are not installed on this machine**, and a missing wrapper reports its
own absence as the command's status: three probes in Phase 5 Task 5 returned `exit=127 elapsed=0s`,
which nearly established that `git push` does not hang against a dead peer. It does. Same family as
the pipeline trap — the status you read belongs to something other than what you meant to measure.

**A git worktree of this repo is not a separate test database, and another session's `npm test`
will corrupt yours.** Measured during Phase 5 Task 1: a full-suite run reported `211 failed`,
including `Foreign key constraint violated on PageDraft_pageId_fkey` for a page created two lines
earlier, and 41 `deadlock detected` errors on `Space`/`Page`/`PageVersion` — the tables `resetDb`
truncates. None of it was the code. `ps` showed `npm test` running from
`.claude/worktrees/onedrive-microsoft-sso-7ac97b`, a worktree that shares this checkout's
`.env.test` and therefore `badam_test`. Two runs, racing `TRUNCATE`s.

**Resolved for this checkout, and the fix is worth knowing.** `.env.test` is untracked, and a
worktree has its own copy — both merely happened to name `badam_test`. This checkout now points at
**`badam_p5_test`**, created and brought up with `prisma migrate deploy`. Proof it works: the run
immediately after the switch passed **998/998 with zero deadlocks while the other session's
processes were running**, under conditions that had just produced 207 failures. The guards only
require a name ending in `_test`, so nothing else changed. The **dev** database `badam` is still
shared, so `npm run smoke` and Playwright can still collide.

**A related trap the collision checklist misses entirely: a shared migration *history*.**
`20260826160447_attachments`, from another branch, is applied to `badam_test` and `badam` but is on
neither `main` nor this branch. `prisma migrate dev` therefore offers to **reset the schema**,
which would drop another branch's table and the dev data — and neither `ps` nor `pg_stat_activity`
can see this coming. Use `prisma migrate deploy` (it applies without drift-checking), generate new
migrations against a throwaway database, and run `prisma migrate status` before any `migrate dev`.

`fileParallelism: false` makes this *look* impossible from inside one run, which is what sends you
looking at the wrong thing — and the failure attributes itself to whatever you changed last. The
same run also passed at the previous commit, which is what finally ruled the code out. **Before
diagnosing a mass integration failure, check `ps` for another `npm test` and
`pg_stat_activity` for connections to `badam_test`.** A pure module's tests can be verified
without collision — `npx vitest run <paths>` — because only the integration suite touches the
database.

**A pipeline hides the exit code of its first command**, and this project has now been bitten by
that three times in three different places: `npm run smoke | tail` reporting tail's status (Phase
2 Task 15, which is why the smoke script's docstring warns about it), a background runner
reporting `exit code 0` over a failing `npm test 2>&1 | tail` (Phase 4 Task 1), and a `PIPESTATUS`
read that came back empty because it was taken after the wrong command. Use `set -o pipefail`, or
run the command bare and read `$?`. **A green exit code from a pipeline is not evidence.**

**A security test that cannot fail when the setting it is about is weakened is worse than no
test.** The roadmap said Mermaid's `securityLevel: "strict"` "sanitises labels", so the obvious
assertion is a `<script>` in a diagram label. Measured in Phase 4 Task 5: DOMPurify runs at
*every* level, so that test **stays green with the setting mutated to `"loose"`**. The levels
disagree about URL handling — `if (securityLevel !== "loose") return sanitizeUrl(url)` — so
`click A href "javascript:…"` is the assertion that earns its keep. (`"strict"` also turned out to
be mermaid's *default*, so pinning it is a pin, not a correction of an unsafe default.)

**A bundle-absence claim needs a presence gate beside it.** "Mermaid is in no route's eager
bundle" passes identically when mermaid is not in the build at all, or when the manifest being
read is the wrong one — under Turbopack, `build-manifest.json` carries only the root shell and
`app-build-manifest.json` does not exist. The check asserts mermaid is *present*, and finds
CodeMirror eager on the editor route as a control, before reporting a verdict.

**Shipping a feature with nothing linking to it has now happened twice.** Phase 2's `movePage`
went out as a library function with no caller and cost a whole extra task (14b) to reach; Phase 4's
`/search` went out with no link. Both were caught late, by asking "can a person get to this?"
rather than by any test. **Add the affordance in the task that builds the thing.**

**Annotating a stale fence was decorative until `plan:check` was fixed.** A fence whose file gained
an *import* has a different first line, so it was dismissed as `unmatched` **before** the
supersession note could be seen — and the only signal was `in sync` falling by one while
`unmatched` rose by one. Supersession now outranks the heuristic. Watch the counts, not just the
drift line.

**A filter applied after fetching hides the SQL filter it duplicates, and reads as care.** Phase 4
Task 3's first version assembled hits through a `byId.get(row.spaceId)` lookup whose miss skipped
the row — a second copy of the space filter, in TypeScript, after the query. **Deleting
`spaceId = ANY(...)` from the SQL left all 24 tests green.** Fixed by joining `Space` for its
columns, which is FK-guaranteed to drop no row, and deleting the lookup. The same trap then
arrived by a second route: an `INNER JOIN` for the snippet would have excluded unpublished pages
as a side effect, so deleting the published-version clause also passed — hence a `LEFT` join and a
counterfactual mutant kept in the record.

**A mutant that dies for the wrong reason has not proven the assertion you meant.** Same task:
without a coalesce, the published-clause mutation died as a `TypeError` inside snippet parsing
rather than as the assertion that names a draft in results.

**Know which columns actually feed a derived value before writing a test about staleness.** The
Phase 4 plan told Task 2 to prove the search vector *moves* when a cascade changes `status` or a
move rewrites `path`. Neither is an input — the vector has three terms and those are a filter and
an address — and both leave it **byte-identical**, measured. The write that really goes stale is a
`title` or `publishedVersionId` change outside `publishPage`. A staleness test aimed at the wrong
column passes for the wrong reason.

**Prisma treats triggers and indexes oppositely, and the dangerous half looks safe.** Measured in
Phase 4 Task 2: a trigger created **in a migration** survives every later `migrate dev`, because
Prisma's diff cannot see it — and a trigger created **by hand** survives too, which is the trap,
because it is equally invisible and therefore exists on the machine that ran it and on no fresh
database ever provisioned. **A trigger that is not in a migration is not deployed.** The GIN index
is the reverse: Prisma *does* model indexes, so one created only in SQL is diffed as an extra and
the next unrelated `migrate dev` emits `DROP INDEX` — reproduced as the only statement of a no-op
migration. Declare indexes in the schema; put triggers in the migration.

**Two `npm test` runs cannot overlap.** They share the one `_test` database, and the loser reports
scores of spurious failures that look like real breakage.

**An absence assertion is vacuous when the mechanism under test would produce the same absence
while broken.** Task 6's "a non-member gets nothing" is the case: `search()` binds the readable
space ids into `= ANY(...)` with no early return, so an empty array is false for every row *by
itself* — meaning a viewer with **no** readable space finds nothing whether the filter
discriminates or not. The fix is a viewer with **one** readable space out of two (`handbook` is
`ALL_STAFF`, `engineering` is `MEMBERS`), the same word seeded into both, and a **count**. Same
family as the non-vacuity companion, arriving from the permission side.

**The count contract has now been too narrow too — seventh time for a guard on this project.**
`reader.spec.ts` was the one spec with no `snapshotCounts` guard, and the reason was assumed to be
"it writes nothing". It writes a real `BugReport`, and `Counts` had no `bugReports` column — so
adding the guard without widening `Counts` would have produced a check that passes over the only
write the file makes. Widened, then **watched fail** by leaking the row on purpose. Bug reporting is
also the one mutation in the product that writes no audit row, which is why nothing else caught it.

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

**827 vitest tests over 53 files**, plus **21 Playwright specs** in `e2e/` and a **37-check
cold-start smoke script**. The per-file table that used to sit here described Phase 1's 128 tests
over 18 files and had been wrong for two phases — a table that has to be edited by hand on every
task is a table that ends up lying, so the counts live in one place now and
`npm test` prints the rest.

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
how 404-not-403 is demonstrated), or `admin@example.com` (super-admin). A session
minted this way is revoked the moment the flag is turned off, because the token records
which provider minted it.

## Seeded data

Two spaces, seven pages, three users.

- `engineering` (**MEMBERS**) — 6 pages at depths 1/2/3, one deliberately unpublished.
  The three-deep page `architecture/mqtt-contracts/topic-registry` exists specifically to
  exercise the recursive nav rail.
- `handbook` (**ALL_STAFF**) — one published `welcome` page, so a viewer who belongs to
  nothing still sees something.
- `aisyah@example.com` EDITOR · `admin@example.com` super-admin ·
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
- **An equivalent mutant is a real category — report it, do not manufacture a test for it.**
  Deleting `ESCAPE '\'` from the move statement passes the whole suite and always will:
  Postgres defaults to backslash, so the clause is documentation and the escaping *function* is
  the mechanism. Saying so beats inventing a test that pins the wrong thing.
- **A guard on the rows is not a guard on the decision.** The move's `LIKE` pattern correctly
  refused to drag `mqtt-contracts-v2` along with `mqtt-contracts`, while the separate
  "is this in the moving subtree" check used a bare `startsWith` — so moving a page under that
  sibling was refused as a cycle. All 32 tests passed. The same off-by-one, on the other side
  of the same function.
- **A staged interleaving must release its lock in a `finally`.** A failed assertion otherwise
  leaks an uncommitted transaction, the next `TRUNCATE` blocks on it, and the run reports
  meaningless hook timeouts that bury the two real failures underneath them.
- **`Prisma`'s `startsWith` does not escape `LIKE` metacharacters.** For a path containing a
  backslash it emits a pattern whose own children stop matching, and the read comes back short
  **silently**. Any prefix query over user-controlled text has to be raw, with escaping.
- **A predicate stated twice is not twice as safe — it is untestable.** `resolveRedirect`
  first carried `readableSpace` on the redirect's space *and* nested inside the `toPage`
  filter, as defence in depth. Removing either one alone left all 22 tests passing. State a
  permission predicate once, on the thing whose readability is the question, and let the other
  filters carry *shape* constraints with their own tests. The exact inverse of the
  "implemented in two places is not yet a convention" rule, which is about *logic*, not
  predicates.
- **The soft-delete guard has now been too narrow four times**, the last one invisible to both
  halves: `resolveRedirect` queries `Redirect` and reaches `Page` through a relation filter, so
  no `page` delegate token exists to sweep for. The sweep now matches **any** Prisma delegate
  call, and the four modules that cannot reach a `Page` row declare `reachesPage: false` with a
  reason. Verified by planting a new module that reads `PageVersion` filtered by
  `{ page: { spaceId } }` — the shape that was previously invisible — and watching it fail.
  **Name the thing you are protecting, not the syntax you expect it to be written in.**
- **A raw write of a `Date` needs `::timestamptz AT TIME ZONE 'UTC'`.** Prisma maps `DateTime`
  to `TIMESTAMP(3)` *without* time zone and converts to UTC itself; a raw statement bypasses
  that, binds the `Date` as `timestamptz`, and the assignment converts to the **session** zone.
  Measured on `Asia/Kuala_Lumpur`: `07:00Z` stored as `15:00`, read back as `15:00Z` — eight
  hours out, silently, and the round trip stayed green because the value was only ever compared
  against itself. `src/lib/pages/delete.ts` is the only such write today.
- **Compare a stored timestamp against the real clock, not against another copy of itself.**
  That is what made the bug above visible.
- **A guard pattern that matches nothing looks exactly like a clean codebase.** Every sweep
  needs a companion test proving the pattern can still see at least one real instance. The
  audit sweep has one; the soft-delete sweep earned the same lesson the hard way, four times.
- **`needsAccessAudit` is no longer unwired**, but no *seeded* path reaches it: the super admin
  is a seeded ADMIN of `engineering`, so the predicate is correctly false for every seeded
  combination. Covered by integration tests; e2e and smoke deliberately skip it rather than add
  a third space and disturb the `2 spaces / 7 pages` baseline.
- **The horizontal-overflow class has now bitten five times, in five different shapes**:
  paragraphs, images, the mermaid placeholder, `.body` headings, and — found by the injection
  probe — the page **title**, which is painted outside `.body` from `Page.title` and so was
  never reached by the `.body` fix. 4,321px at 1280px. A title arrives from a text input, so no
  document content could ever have exercised it. **`min-width: 0` keeps a grid track honest and
  does nothing about inline content overflowing its box.**
- **Test a class by injecting the hostile case.** The suite was green over a 4,660px reader
  overflow for all of Phase 1 because it only measured seeded content.
- **`plan:check` binds a fence to the nearest path reference above it, skipping blockquotes.**
  Getting that right took three wrong versions, each failing differently: a 12-line directive
  window was too narrow (a supersession note pushed a directive out of reach and the fence
  dropped silently into `unmatched`); 40 lines was too wide (mis-bound three fences to the
  *previous* step's file and reported drift that did not exist); "nearest step heading decides"
  over-claimed (the plan puts several fences under one heading). Blockquotes are skipped because
  every supersession note is one and names the file it supersedes. **Watch the counts move** —
  the first failure was visible only as 16 superseded becoming 15.
- **`plan:check` covers `bash` and `sh` fences.** Leaving them out meant `scripts/smoke.sh`
  could be quoted whole-file and drift indefinitely while landing in the "not code" bucket —
  fifth time on this project that a guard could not see a whole category. Adding them surfaced
  three real stale fences and, immediately, a new mis-binding class: a `bash` command snippet
  under a `Create src/app/page.tsx` step bound to that file. **A fence's language now constrains
  which paths it may bind to** — a shell fence is never a `.tsx`.
- **A supersession note must sit immediately above its fence.** `isSuperseded` looks 12 lines
  up; a note placed above an intervening paragraph is not seen, and the fence reads as drift.
  Placing one above the wrong fence is worse — it claims a file was superseded when it was not.
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
