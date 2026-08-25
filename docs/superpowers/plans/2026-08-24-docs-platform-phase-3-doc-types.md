# Phase 3 — Doc types and lifecycle

Spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)
(§6, §5.2 `PageRelation`, §9 steps 1/4/5, §11) ·
Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md) ·
Phase 2: [`2026-08-23-docs-platform-phase-2-authoring.md`](2026-08-23-docs-platform-phase-2-authoring.md)

**Deliverable.** An ADR opens on a template, carries validated frontmatter, and declares what
it supersedes or decides. Publishing it applies those relations and retires the other side in
the same transaction. A retired page still reads, with a banner naming its replacement.
Generated indexes list a space's ADRs and RFCs, filterable by status.

## Decisions taken before writing this

- **Relations name their target by space-relative page path** — `supersedes: decisions/adr-0031-…`
  — which is what the author already sees in the URL and the nav rail. Resolved to a page id at
  publish time, so a later move cannot break the stored row. No document-number column, no
  second identity to keep in step with the slug.
- **Templates are one-file modules in the repo**, versioned and reviewed like code, beside the
  zod schema that validates what they produce. Making them editable content is Phase 6's
  problem, and building an admin surface here would build it twice.

  This was chosen as "**Markdown files** in the repo", and the `.md` extension turned out to be
  unworkable — see Task 4, which measured four mechanisms against a real build. The substance is
  unchanged: files in the repo, one per doc type, each a one-file diff that reads like a
  document, as against editable content with an admin surface. What is given up is Markdown
  syntax highlighting in an editor, and a backtick inside a template needing an escape — which
  TypeScript reports at compile time.

## What Phase 3 does NOT do

- **Search ranking demotion for retired pages** (§6.4's last clause, §13) — Phase 4 owns search.
  The banner and the status are here; the ranking consequence is not.
- **`PageSystem` rows and the systems facet** (§7) — Phase 6. Frontmatter may *carry* a
  `systems:` key, but Phase 3 neither stores nor validates it against a catalogue that does not
  exist. Decide deliberately whether to reject the unknown key or ignore it, and say which.
- **`/systems`, `/search`, `/admin`** (§11) — Phases 4 and 6.
- **Git mirroring of the frontmatter** (§10) — Phase 5.

## A bug this phase inherits, and must fix first

**The render pipeline turns frontmatter into garbage.** Measured on the shipped code:

```
input:   ---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\n# Title
output:  <hr>\n<h2 id="status-acceptedsupersedes-decisionsadr-0031">…</h2>\n<h1 id="title">…
```

The `---` becomes a thematic break and the keys become a heading — with an id derived from the
concatenated keys, which also puts a junk entry in the table of contents. Nothing writes
frontmatter today, so nothing has ever shown it. Phase 3 makes every ADR do so, on the reader,
in the preview pane, and in the published version. Task 2 fixes it before anything else depends
on it.

## Landmines this phase introduces

**Cascades write to pages the publisher may not be able to edit.** Publishing an ADR that
supersedes another sets `status = SUPERSEDED` on a *different page*. That page may sit in a
space the publisher cannot edit — or cannot read. This is a new authorization shape: every
write in Phases 1–2 was to a page the actor held `EDIT` on. Task 8 must decide and argue it,
and whatever it decides, **a cascade must never be a way to discover that a page exists**.

**Cascades introduce a lock-ordering hazard.** Publish currently takes a `FOR UPDATE` on its
own draft row — a single row, so no ordering question arises. A cascade locks a second page,
and two ADRs superseding each other concurrently will deadlock unless rows are locked in a
deterministic order. Lock by ascending page id, and say so in the code.

**A cascade is a second place a status changes.** Spec §6.3: *"Status is never maintained by
hand in two places."* The cascade and `PUBLISHABLE_INTO` must agree, or a cascade will set a
status the vocabulary forbids. Validate the cascade's target transition through the same table.

## Conventions that carry forward

Settled in Phases 1–2. Changing one is a decision, not a detail.

- `readableSpace(...)` and `visiblePage(...)` return complete `where` objects and **must never
  be spread**, at any nesting depth.
- Every query states its own permission predicate; none is guarded by call ordering.
- Never `include:`; always an explicit `select:`.
- **Every module that queries the database is registered** in `src/lib/pages/visible.test.ts`,
  with soft-delete tests or a stated reason it cannot reach a page row.
- Only `src/lib/audit/log.ts` may touch the `auditLog` delegate.
- Pure logic imports nothing from Prisma and unit-tests without a database.
- A concurrency test that never blocks is not testing a write predicate.
- `npm run plan:check` must report **0 drifted** before a task is closed.
- Implementers create a new commit, never `--amend`, and stage explicit paths.

---

## Task 1: Schema for relations and frontmatter ✅

**Files:** `prisma/schema.prisma`, a migration.

- [x] **Step 1: `RelationType` and `PageRelation`**

Per spec §5.2, and note what it does *not* have: no reverse rows. §6.2 — *"Relations are stored
one direction only and the inverse is derived at read time, so the two sides can never
disagree."* Do not add a `reverseOf`, and do not write both directions.

```prisma
enum RelationType {
  SUPERSEDES
  DECIDES
  AMENDS
  RELATES_TO
}

model PageRelation {
  id        String       @id @default(cuid())
  fromId    String
  toId      String
  type      RelationType
  createdAt DateTime     @default(now())

  from Page @relation("RelationFrom", fields: [fromId], references: [id], onDelete: Cascade)
  to   Page @relation("RelationTo",   fields: [toId],   references: [id], onDelete: Cascade)

  @@unique([fromId, toId, type])
  @@index([toId, type])
}
```

`@@index([toId, type])` is what makes the derived inverse cheap — the read that asks "what
supersedes *this* page" is keyed on `toId`, and it runs on every retired page's banner.

- [x] **Step 2: Decide where validated frontmatter is stored**

`PageVersion.frontmatter` and `PageDraft.frontmatter` already exist as `Json @default("{}")`,
added in Phase 2 Task 1 precisely so this phase would not have to add a `NOT NULL` column to a
populated table. Use them. The draft holds what the author typed; the version holds what
validation accepted — **they are not the same value**, and a test should pin that.

- [x] **Step 3: Migrate, and check the plan for `NOT NULL` on a populated table**

The `Page` and `PageVersion` tables are populated in every environment this will run against.
Clean: the migration is a new enum, a new table and its two indexes — no `ALTER TABLE … NOT
NULL`, because Phase 2 Task 1 added both `frontmatter` columns with a `{}` default in advance,
precisely so this phase would not face that migration.

---

## Task 2: Frontmatter out of the rendered body ✅

Fixes the inherited bug. Nothing else in this phase should be built on top of it.

**Files:** `src/lib/markdown/render.ts`, `src/lib/markdown/frontmatter.ts` + tests.

- [x] **Step 1: Strip frontmatter from the render pipeline**

`remark-frontmatter` in the pipeline, before `remarkRehype`. Verify against the exact input in
"A bug this phase inherits" above and assert the `<hr>` and the junk `<h2>` are both gone —
**and that the table of contents no longer contains an entry for it**, which is the half that
is easy to miss.

- [x] **Step 2: Parse it separately, with `yaml`**

A pure module: text in, `{ frontmatter, body }` out. It must **not** throw on malformed YAML —
an author mid-keystroke produces malformed YAML constantly, and autosave runs every two
seconds. Return a typed failure the editor can show and the publish path can refuse.

Guard the parse: `yaml` will happily construct large or deeply nested structures, and this input
arrives from an HTTP body. Cap depth and **entries**, and test the caps.

**"Key count" was wrong, and the correction is the useful part.** A key-only cap leaves the
obvious hole open: `related: [0, 1, … 100000]` has exactly **one** key and a depth of 2, so it
passes a key cap and a depth cap both. Count mapping keys *and* sequence items at every level —
the same "count the right unit" lesson as the byte cap, one level up. Shipped as
`MAX_FRONTMATTER_ENTRIES = 200`, with `MAX_FRONTMATTER_DEPTH = 6` (the deepest shape the spec
asks for is 3) and `MAX_FRONTMATTER_BYTES = 16_384` in **UTF-8 bytes**, checked before the parse
so the structure is never built. Without that byte cap, a one-megabyte document could be one
megabyte of YAML — `MAX_DRAFT_BODY_BYTES` is the only other bound.

**Two hazards this step did not anticipate, both real and both silent:**

- **Cyclic anchors.** `a: &x\n  b: *x` is two lines, produces no YAML errors at all, and yields
  a self-referential object. `JSON.stringify` throws on it, so it would have reached the `Json`
  column and turned four words of bad input into a 500 on autosave — and a naive recursive walk
  blows the stack before getting there. Detected with an ancestor-path set, reported as
  `frontmatter-cyclic`.
- **Alias expansion.** A billion-laughs bomb is tiny on the wire, syntactically clean, and only
  explodes *during* `toJS()`, so a post-parse walk never sees a value. `yaml`'s `maxAliasCount`
  throws first.

Also verified and pinned: `yaml` v2 defines a literal `__proto__` key as an **own** property
rather than assigning it, so `Object.prototype` is not polluted. That is a library behaviour
being relied on, so it gets a test.

- [x] **Step 3: Prove the two halves agree**

The renderer strips exactly what the parser consumes. **They agree by construction rather than
by convention**: one declaration of what frontmatter is (`FRONTMATTER_MATTER`), imported by the
pipeline, and the split locates the block by *parsing* and slicing on the mdast node's
`position.end.offset`. A regex was never viable — a regex cannot see a fenced code block.

Fifteen shapes are pinned, asserting both the HTML and the headings. Three go the **opposite**
way from what a line scanner would guess, and those are the valuable ones:

- **A code fence opening the document** — ` ```\n---\na: 1\n---\n``` ` is not frontmatter, so
  anything that skips to the first `---` line is wrong.
- **A leading blank line** — `\n---\na: 1\n---` demotes it to a thematic break plus a setext
  heading. Anything that `trimStart()`s first strips content the renderer keeps.
- **`Title\n---`** — a setext h1, and the mistake runs the other direction.

CRLF is read directly: YAML 1.2 accepts it, and normalising line endings before parsing would
desynchronise the offsets the body is sliced on.

---

## Task 3: Per-doc-type frontmatter schemas ✅

**Files:** `src/lib/lifecycle/schema.ts` + tests.

- [x] **Step 1: A zod schema per doc type**

Shared keys (`status`, `systems`, `related`) plus per-type keys — an ADR takes `supersedes`,
`amends`, `decides`; a runbook takes none of those. **Reject unknown keys** rather than ignoring
them: a typo'd `supersedez:` that is silently dropped is a relation the author believes exists.

**Decided: `systems:` is accepted, stored, shape-checked, and not validated against a
catalogue.** Rejecting it would ship a template that cannot be published and refuse the one
thing §7 documents about the key. Ignoring it is the exact silent loss this module exists to
prevent — the author's systems vanish, the page becomes indistinguishable from one that declared
nothing, and Phase 6 arrives with nothing to migrate from. Accepting it means the declaration
survives in `PageVersion.frontmatter` and Phase 6 populates `PageSystem` from data that already
exists.

This is **not** a hole in "reject unknown keys": `systems` is a *known* key in every doc type's
table, carrying a `TODO(phase-6)`. Only *which* system keys exist is deferred.

The wording here was tightened during implementation, from "unvalidated" to
**catalogue-unvalidated**. Phase 3 checks everything it can know — text or a list of text,
non-empty, whitespace-padding refused rather than trimmed, JSON-safe — because a full
passthrough would let `systems: {a: {b: 1}}` into the `Json` column for Phase 6 to clean up.

**`MAX_RELATION_TARGETS = 20`, because `MAX_FRONTMATTER_ENTRIES` does not bound this.** The
entry cap cannot tell 200 list items from 200 units of work inside one transaction.

**Two thirds of that reasoning has now gone stale, and correcting it twice is still better than
leaving a measurement a future reader would trust.** It originally read "each target costs Task 5
a resolution query, Task 6 a cycle walk, and Task 8 a row lock". Task 5 batches — resolution is
**three** queries regardless of reference count. Task 6 batches within a walk (one query per
level, not per page) **and** shares a single 200-page budget across the whole call, so its
transaction exposure is independent of the target count too.

The cap now rests on **Task 8's row locks**, which genuinely do not batch. It is still the right
cap; two of its three original reasons are gone.

**`status` is validated by `publishableStatuses(docType)`, derived from `PUBLISHABLE_INTO`** and
added to `transition.ts` rather than to this module, because Task 10's status filter needs the
same list. `DRAFT` falls out for free — it appears in no row's value — so no doc type accepts
`status: DRAFT` and nothing special-cases it.

**`amends` was ADR-only here, and Task 6 accepted the invitation below and widened it.** The
paragraph as written said it was the one cell with no derivation behind it, and that erring
strict was a decision rather than an omission. Task 6 pointed out the premise was itself the
defect: with no guardrail, an ADR could declare `amends: <a runbook>` and **nothing refused it**.
Writing the guardrail dissolved the argument for keeping the key narrow.

*Which* types get it is now derived rather than chosen: `AMENDS` is for a document that must not
be rewritten in place, which is exactly a doc type whose vocabulary has a **terminal status** —
one it can publish into and never out of. ADR and RFC have them; DOC and RUNBOOK have none,
because `ARCHIVED` publishes back into `CURRENT`, so those are edited and "I amended it" is what
their version history already says. The test asserts that equivalence against `terminalStatuses`
rather than against the row, so a vocabulary change moves the key table with it.

- [x] **Step 2: Field-level errors, not exceptions**

Reuse the `FieldError` shape from `src/lib/pages/slug.ts`. Publishing must be able to say *which
key* is wrong, in the editor, against the field.

**Task 2 flagged that `field` alone cannot deliver that promise.** Frontmatter has no per-key
input — it is prose in one textarea — so `field: "markdown"` can only underline the whole pane.
This step's error shape needs a `key`, or a line number, alongside `field`.

Two more things Task 2 established that this step should not rediscover:

- **YAML 1.2's core schema admits `.nan` and `.inf`**, and `JSON.stringify` turns both into
  `null` — so they would land in the `Json` column silently altered. Reject non-finite numbers
  explicitly rather than inheriting that.
- **Duplicate keys already fail** in Task 2 as `frontmatter-unparseable` (`yaml` reports "Map
  keys must be unique"), before any schema sees them. A repeated `supersedes:` is an author who
  believes both relations exist, so failing is right — but do not write a second duplicate check
  here expecting to be the one that catches it.

---

## Task 4: Templates ✅

**Files:** `src/lib/templates/{adr,rfc,runbook,doc}.ts` (**not** `.md` — see below), a loader
+ tests, `create.ts`, `NewPageForm`.

**`.md` files cannot work here, and the measurement is the useful part.** Four mechanisms were
probed against a real `next build`, with the `.md` files moved out of the tree to stand in for a
deployment shipping `.next` without `src/`:

| Mechanism | Result |
|---|---|
| `readFileSync(join(process.cwd(), "src/lib/templates/adr.md"))` | `ENOENT` — nothing traces `src/` into the output. **Works in a checkout**, which is what makes it dangerous |
| the same, with the paths hoisted into a `const` | Build fails: *"Static analysis determined that this filesystem access causes the whole project to be traced"*. One level of indirection is one too many |
| `readFileSync(new URL("./adr.md", import.meta.url))` at module load | Build fails — a cross-realm `URL` in the sandbox Next evaluates route modules in |
| the same, read lazily inside a function | **Builds, and passes from an API route — then fails from a Server Component** |

That last row is the finding. Turbopack recognises `new URL(<literal>, import.meta.url)` as an
asset reference, but **rewrites it differently per layer**: a route handler gets
`.next/server/assets/adr.<hash>.md`, a real file it can open, while the RSC/SSR layer gets
`/_next/static/media/adr.<hash>.md` — a **browser** URL, with no file there for the server to
read. `templateFor` is reached from the server action in `(editor)/new/page.tsx`, which is the
half that fails.

And it fails *only* there: vitest green, `next build` green, an API-route probe green. Precisely
the "works in vitest and 404s in production" shape this task was warned about.

A `.md`-to-string loader would be layer-independent, but needs a `turbopack.rules` entry, a
Vite-side equivalent for vitest, and a `declare module "*.md"` — three mechanisms across two
toolchains for four short documents, with the same one-environment-only failure if any is wrong.

- [x] **Step 1: The four templates**

ADR: Context / Decision / Consequences. RFC: Summary / Motivation / Design / Open questions.
Runbook: Symptoms / Checks / Fix / Escalation. Doc: minimal.

Each opens with frontmatter carrying the keys its type accepts, so an author sees the shape
rather than discovering it from a validation error.

- [x] **Step 2: A new page opens on its template**

The template becomes the draft's initial markdown at create time — **not** a placeholder the
editor renders, which would vanish on first keystroke and leave an empty page.

- [x] **Step 3: The templates must pass their own schemas**

A test that loads each template, parses its frontmatter, and validates it against that type's
schema. Otherwise the product ships a template that cannot be published, which is the most
embarrassing possible bug in this phase.

---

## Task 5: Resolving a relation reference ✅

**Files:** `src/lib/lifecycle/resolve.ts` + integration tests.

- [x] **Step 1: Path → page**

Within the same space. Resolve through `Redirect` as the reader does, so a reference to a moved
page still lands — and record what it resolved *to*, not the path it was written as.

- [x] **Step 2: The refusals, each with its own message**

Unreadable target, missing target, soft-deleted target, **self-reference**, and a target in
another space. Cross-space is refused in Phase 3: `SUPERSEDES` between spaces raises a
permission question this phase should not answer quietly, and no seeded case needs it.

**A refusal must not leak.** "No such page" and "you cannot read that page" have to be the same
answer, exactly as the reader's 404-not-403 rule requires. They are merged into one `not-found`,
and the tests assert the two answers are `toEqual` for the **same** reference string resolved
twice — once unreadable, once after a hard delete — so any leaked field fails.

The other three refusals are specific because each is safe to be. `deleted` is only reachable
inside a readable space, so for a stranger it collapses back into `not-found` — pinned by its own
`toEqual` test. `self-reference` is checked on the **resolved** page. `cross-space` is decided
from the reference's own text before any query runs, so `/handbook/x` and `/ghost-space/x` get
the same answer and it is not a second way to ask whether something exists.

**This step did not say how a cross-space reference is even expressible, so "refuse it" was
unimplementable as written** — a space-relative path scoped to `spaceId` can never name another
space, and the refusal would have been dead code. The grammar is now: a reference beginning with
`/` is read as a reader URL, `/{spaceKey}/{path}`. A different space key is `cross-space`; this
space's own key resolves normally, because the author pasted their address bar; a malformed
absolute form (`/`, `/engineering`, `//x`) is `not-found` rather than a fifth code for
punctuation.

**One documented blind spot, pinned rather than fixed.** A page moved *and then* soft-deleted
gets `not-found`, not `deleted`: the reference names the old path while the deleted row sits at
the new one. Closing it needs a fourth query joining `Redirect` to deleted pages, to improve the
wording of a case requiring two separate accidents. The part that matters — that it does not
*resolve* — is what kills the `toPage: visiblePage(...)` mutant.

**A target is not required to be published.** Requiring it would be judging rather than
resolving; an unpublished page resolves carrying `status: DRAFT` for Task 6 to rule on. Not a
leak: `listSpacePages` already shows unpublished pages in the nav rail of anyone who can read
the space.

---

## Task 6: Relation guardrails ✅

**Files:** `src/lib/lifecycle/relations.ts` + tests. Pure where it can be.

Spec §6.3, each with its own test.

**Self-reference is NOT here. It is Task 5's, and restating it would break the rule this project
enforces most carefully.** The plan originally listed it in both tasks — which is a permission-
shaped predicate stated twice, exactly the `resolveRedirect` failure PROGRESS records: mutating
away either copy leaves the suite green, so neither is testable. Task 5 owns it because only
resolution can catch the case that matters — a reference to the page's **own pre-move path**,
which resolves through the redirect back to itself and which a path-string comparison would
happily write as a relation to itself. Task 5 checks the **resolved** page, for all four relation
types. Record it here as subsumed; do not add a guardrail.

- [x] ~~A page cannot supersede itself~~ — subsumed by Task 5, see above.
- [x] `SUPERSEDES` same doc type · `AMENDS` same doc type · `DECIDES` `ADR→RFC` ·
      `RELATES_TO` unconstrained. Each row carries its own sentence, so `SUPERSEDES` and `AMENDS`
      share a *kind* and no *message* — pinned by a test that they differ.
- [x] **Cycle detection**, breadth-first over stored `PageRelation` rows from the target back to
      the publishing page. Complete because every new edge shares one `fromId`: a cycle made
      only of new edges would need two sources, and one publish has one.

      **Walked only for `SUPERSEDES`, and that is derived rather than listed.** A type can loop
      only if it may join one doc type — `DECIDES` cannot, so its loop is *unrepresentable*
      rather than unchecked — and a loop only *matters* if it cascades, which is why two ADRs
      amending each other are left alone.
- [x] **A pathologically long acyclic chain refuses as `chain-too-long`, never as a cycle.**
      `MAX_SUPERSEDE_WALK = 200` counts *pages reached*, so a long chain and a wide fan-out are
      bounded by one number, and the budget is **shared across the whole call** so 20 declared
      targets cannot buy 20 walks. Fail-closed: the message says a loop could not be *ruled
      out*, never that one exists — asserted.
- [x] The `ACCEPTED` precondition. **The gate is on the destination status, and it gates the
      cascade rather than the relation.** An ADR's first publish lands at `PROPOSED`, and a
      proposal saying what it *would* retire is exactly what a reviewer needs; refusing the
      relation would push `supersedes:` into a second edit at acceptance time, which is §6.3's
      "never maintained by hand in two places" objection wearing a different hat.

### The chain walk carries no permission predicate — deliberate, and ruled on

It is the only query in this codebase without one, so it needs to be findable. The argument,
which I accept:

- It returns **no row** to the caller — `select: { toId: true }`, and the function's result is
  `"ok" | "cycle" | "chain-too-long"`. It names no page.
- Its only observable is a boolean about the **caller's own** page, whose targets were already
  resolved by Task 5 through queries that each carried `readableSpace`.
- Relations cannot cross spaces in Phase 3, so the walk cannot leave a space the viewer has
  already been permitted to read.
- Adding one anyway would be defence in depth — and this project has measured what that costs:
  a predicate stated twice makes neither copy testable.

**The forward note matters more than the decision.** A phase that allows cross-space relations
must add a **space filter on `from`**, not a viewer — the question there is whether the graph may
leave the space, not whether this viewer may read it.
- [ ] `SUPERSEDES` is legal only between two pages of the **same** doc type.
- [ ] `DECIDES` is legal only from an `ADR` to an `RFC`.
- [ ] **Cycle detection rejects a supersede chain that loops.** Walk the existing
      `PageRelation` rows, not the frontmatter. Phase 1's `buildTree` exists because this
      project's data can already contain a cycle; a naive walk here loops forever rather than
      returning an answer.
- [ ] The source must reach `ACCEPTED` for a cascade to fire, so a draft cannot retire a live
      decision.
- [ ] **Decide `AMENDS`.** Task 3 made it ADR-only by erring strict, and flagged it as the one
      cell in its table with no derivation behind it: `AMENDS` fires no cascade, so the
      vocabulary constrains nothing and no guardrail exists. An RFC amending an RFC is
      plausible. Either write the guardrail and widen the table in the same change, or record
      why ADR-only is right — but do not widen the table alone.

---

## Task 7: Relations in the publish transaction ✅

Spec §9 step 4. `src/lib/pages/publish.ts` already carries `TODO(phase-3)` at the exact point.

**This task's real scope is §9 steps 1 *and* 4.** Relations come from validated frontmatter, so
three of `publish.ts`'s four `TODO(phase-3)` markers belong here: validate the frontmatter, store
the **validated** value on the version instead of its `{}` default, and upsert the relations.
Only the cascade marker is Task 8's.

- [x] **Step 1: Upsert the declared relations**

Inside the existing transaction. Relations the frontmatter no longer declares must be
**removed** — an author who deletes `supersedes:` and republishes is saying the relation is
wrong, and leaving it would make the frontmatter and the database disagree with no way to tell
which is right. Shipped as `deleteMany({ fromId, NOT: { OR: declared } })` then
`createMany({ skipDuplicates })`: the `NOT` is also what leaves an unchanged row's `createdAt`
alone.

**Resolution and the guardrails run before any row is written, not at step 4's place in the
spec's sequence, and that is forced rather than preferred.** A refusal inside `$transaction` is a
`return` — and **returning commits**. Deciding after the version insert could only abort by
throwing a field error through a sentinel. The reads still happen on `tx`, so a reference
resolves against the same snapshot the relation row commits into.

**The frontmatter's `status:` is wired into the transition**, which this plan did not explicitly
assign. Spec §9 step 1 is "validate frontmatter **and status transition**", and `publish.ts`
already carried a comment promising Phase 3 would supply it. Without it the transaction would
write a version whose stored frontmatter said `ACCEPTED` over a page whose status said
`PROPOSED` — §6.3's "never maintained by hand in two places", broken by the single write that
exists to enforce it. Precedence is `options.status ?? frontmatter.status ??
defaultPublishStatus(...)`, pinned by a test.

**The plural-error question is answered without taking Task 11's decision.** The invalid branch
carries **both** `error` (the first, unchanged, so no consumer breaks) and `errors` (all of them,
with `errors[0] === error` pinned). Task 11 still chooses *which* to render and where.

**Three findings for later tasks, reported rather than quietly absorbed:**

- **`PageDraft.frontmatter` is an unused column** — nothing writes it and nothing reads it. Task 1
  Step 2 reads as though it should be populated; it should not be. The author's frontmatter *is*
  the first few lines of the one textarea they type in, so a copy in a column would be a second
  source of truth for the same characters, which autosave would have to keep in step while the
  YAML is mid-keystroke and unparseable. **Recorded as deliberately unused**, not a gap. Phase 5
  may want it for the git mirror; until then it stays at its `{}` default.
- **A document that is *only* frontmatter now publishes with an empty body.** `draft-empty`
  measures the whole markdown, so `---\nstatus:\n---` is "not empty". Before Task 2 that block
  rendered as visible garbage; now it renders as nothing, so the reader gets a title and a blank
  page. The fix is to test `split.body` — but that changes a Phase 2 rule with its own message and
  test. **Assigned to Task 11**, which owns the publish surface.
- **A removed relation leaves no audit trace.** Not lost — every publish's
  `PageVersion.frontmatter` records what was declared at that publish, so the history is
  reconstructible from the version chain. **Task 8 should decide deliberately**, since it is
  already adding audit rows for the cascade side.

- [x] **Step 2: Tests**

Including: republishing with a relation removed deletes the row; republishing unchanged is
idempotent and does not churn `createdAt`.

---

## Task 8: Cascades ✅

Spec §9 step 5 and §6.3. **Re-read "Landmines this phase introduces" before starting.**

- [x] **Step 1: The two cascades**

`supersedes: X` → X becomes `SUPERSEDED`. `decides: R` → R becomes `CLOSED`. Same transaction as
the version write. Validate each target transition through `PUBLISHABLE_INTO`, so a cascade
cannot set a status the vocabulary forbids.

**Decided: a cascade the target's vocabulary forbids refuses the whole publish**
(`cascade-illegal-transition`). Skipping would write a `SUPERSEDES` row from an `ACCEPTED` ADR
over a target that was never retired — the exact divergence §6.3 exists to prevent, and Task 9
derives the relation from the row while the banner comes from the status, so a reader would see a
page that both is and is not superseded. It would also be **lost rather than deferred**: cascades
fire from the source's publish and nothing re-runs them.

**And the derived case that would otherwise have shipped as a permanent bug: a target already at
the cascade status is a no-op, not a transition.** Asked about `SUPERSEDED → SUPERSEDED` the table
refuses — terminal — so **an ADR that had ever superseded another could never be republished**, a
typo fix refused on account of a cascade that already happened. Mutating that branch out kills
both the new test and a pre-existing Task 7 one.

**Authorization: nothing beyond the `PUBLISH` already held on the source's space.** The target is
always in the source's space — resolution refuses absolute references syntactically *and* scopes
every query to `source.spaceId` — so a `can(viewer, targetSpace, "EDIT")` would be the same call
on the same space as the check already made: a predicate stated twice, and untestable. Same-space
**is** what makes it safe, and it is exactly what a later phase widens. So the cascade write
carries `spaceId: page.spaceId` as a **shape** constraint: widening resolution without revisiting
that line produces a zero-row update, a rollback and a loud failure rather than a silent
cross-space write. Disclosure is closed upstream — an unreadable target is `not-found`, so no
cascade is ever computed for a page the viewer cannot see.

**Lock ordering: ascending page id, own row included, one statement**, with `COLLATE "C"` so the
order is byte order and cannot vary with a deployment's locale. `EXPLAIN` confirms `LockRows`
sits above `Sort`. Two staged tests with explicit ids (`0-…`, `z-…`) use a third connection with
`lock_timeout` to ask whether the publish holds the *other* row while it waits.

**A removed relation is audited**, as edges on the `page.publish` row alongside the adds.
"Reconstructible from the version chain" is weaker than it sounds: frontmatter stores
*references*, so recovering an edge means re-resolving a path as it would have resolved then,
through redirects a later move may since have replaced. Removal also does **not** un-retire the
target, so the audit row is the only account of how a `SUPERSEDED` page with no incoming relation
got that way. The cascade gets its own `page.cascade` action because it changes a *different*
page, and `AuditLog` is indexed by `pageId`.

**One honest equivalent mutant, reported rather than given a test that pins the wrong thing:**
dropping `spaceId` from the cascade *write* alone leaves all 52 tests passing, because
resolution's scoping already holds. Dropping *both* layers fails — the publish succeeds and
cascades another space's page. The write-side constraint is defence in depth whose value is the
fail-closed behaviour, not a currently-reachable bug.

**Task 6 left this task a decision it must not inherit silently.** `checkRelations` emits
`cascade: "SUPERSEDED"` for a target ADR sitting at `PROPOSED` — which `PUBLISHABLE_INTO`
forbids, because an ADR reaches `SUPERSEDED` only from `ACCEPTED`. Task 6 deliberately did not
resolve it there (stating the rule in both places would make neither testable) and flagged it in
its docstring. So: **is that a refusal of the whole publish, or a skipped cascade?** Refusing
tells the author their ADR cannot supersede a proposal that was never accepted; skipping
silently leaves a declared relation with no consequence. Decide, argue it, and test whichever
you choose.

- [x] **Step 2: Decide the authorization**

The publisher is changing another page's status. Does that require `EDIT` on the target's space?
Argue it. Whatever the answer, the failure mode must not reveal that an unreadable page exists.

- [x] **Decide whether a removed relation is audited.** Task 7 leaves no trace when a relation
      row is deleted. It is reconstructible from the version chain's stored frontmatter, so this
      is a judgement about whether the audit log should stand alone. You are already adding audit
      rows for the cascade side.

- [x] **Step 3: Lock in a deterministic order**

Task 7 confirmed the hazard is **yours alone**: its relation insert takes only a foreign-key
`KEY SHARE` lock on the target `Page` rows, which does not conflict with the `FOR NO KEY UPDATE`
the page update takes — so two publishes declaring relations to each other's pages do not
deadlock. The hazard arrives with the cascade, because it *updates* the target's status.

Ascending page id, including the publishing page's own row. Two ADRs superseding each other
concurrently is the case; a staged test that holds one lock and proves the second blocks is the
only thing that pins it. A `Promise.all` race does not.

- [x] **Step 4: Audit both sides**

The cascade changed a page the audit trail should show changing. `writeAudit` from
`src/lib/audit/log.ts` — do not touch the delegate directly, a sweep enforces it.

---

## Task 9: Reading relations, and the retired banner ✅

Spec §6.2 and §6.4.

- [x] **Step 1: Derive the inverse at read time**

Stored one direction; the page reader asks both "what does this supersede" and "what supersedes
this", the second keyed on `toId`. Both filtered by `visiblePage` and `readableSpace` — a
relation must not surface a page the viewer cannot read.

- [x] **Step 0: Make "remains editable" true.** Task 8 found that §6.1's vocabulary gives the
      terminal statuses **no onward transition at all**, so a retired page's annotation can be
      drafted and never published — and §6.4 promises the opposite. Latent since Phase 2, routine
      now that a cascade puts pages into those statuses without anyone choosing to.

      **Resolved in the spec: a terminal status may publish into itself.**
      `SUPERSEDED → SUPERSEDED` is legal; `SUPERSEDED → ACCEPTED` is not. Add the rows to
      `PUBLISHABLE_INTO` for both ADR and RFC terminal statuses, and note the interaction Task 8
      already handles — a cascade onto a page already at that status is a no-op, not a
      transition, so this must not reopen that.

- [x] **Step 2: The banner**

**Step 0 nearly shipped a silent regression, and the way it was caught is the lesson.**
`terminalStatuses` was derived as "appears as a destination and **has no row**". Step 0 gives
every terminal status a row, so left alone it returned `[]` for ADR and RFC — and
`RELATION_KEYS_BY_TYPE` derives the `amends` key from it, so a vocabulary **widening** would have
quietly **removed** a frontmatter key. Re-derived as "has no destination but itself".

The docstring first claimed no test would have failed. That was measured and found wrong:
`schema.test.ts`'s equivalence assertion goes **vacuously true** — both sides empty — and it is
the **non-vacuity line beside it** that catches it. An equivalence assertion over two derived
sets needs a companion asserting the sets are non-empty, or it passes hardest exactly when both
derivations break together.

**The retirement date is the replacement's `publishedAt`, labelled as the replacement's publish
date — not as a retirement date.** For a cascade they are the same instant by construction, since
the cascade runs inside the replacement's publish transaction. The alternatives are each wrong
somewhere reachable:

- **The relation's `createdAt`** is wrong on the *documented happy path*: Task 6 gates the cascade
  and not the relation, so the row is normally written by the `PROPOSED` publish and Task 7's
  `NOT` clause preserves it. It would date the retirement to the day someone *proposed* it.
- **The retired page's own `publishedAt`** is wrong for every cascade-retired page: `applyCascade`
  writes the status and deliberately nothing else, so it still says when the page was last
  published *while in force*.
- **The `page.cascade` audit row** is right for a cascade and absent for an author-retired page,
  and it would put the reader's hot path on the one table only `src/lib/audit/log.ts` may query.

The **label** is what keeps it honest: after the replacement is republished, "published 4 March"
stays a true sentence about the replacement, where "retired 4 March" would have become a false
one about this page. A true retirement instant needs a column written by the statement that
writes the status — spec §6.4 asks for a date the schema does not record.

**A page retired with no incoming relation** shows the status, no date, and a sentence saying so.
Reachable three ways — author-retired directly, an `ARCHIVED` doc that can never have one, and a
replacement that dropped `supersedes:` without un-retiring its target — so it is a branch, not a
fallback.

**Which incoming relation counts as the replacement is derived**, not listed:
`retiresInto(type) === page.status`. An incoming `AMENDS` is therefore never a replacement, and a
`DEPRECATED` ADR whose only incoming `SUPERSEDES` comes from an unaccepted proposal names none —
a reachable state the derivation declines on its own.

**Deliberately no `spaceId` shape constraint on either read — the opposite of `resolveRedirect`,
and for a reason worth keeping.** Scoping to the page's own space would make `readableSpace`
**unfalsifiable** here: a viewer reading a page can always read its space, so the only rows the
predicate can hide are cross-space ones — exactly the rows a shape constraint would hide first.
That is a predicate stated twice with one copy invisible.

**`RETIRED_STATUSES` is transcribed from §6.4, not derived** — the one list in this change.
`ARCHIVED` is retired *and* reversible (`ARCHIVED → CURRENT`), so no property of
`PUBLISHABLE_INTO` separates the six. Held by two tests instead: the spec transcription, and
"every terminal status is a retired status", which is the half that would otherwise rot.

A page whose status is `SUPERSEDED`, `DEPRECATED`, `CLOSED`, `WITHDRAWN`, `REJECTED` or
`ARCHIVED` renders a banner above the body naming the replacement and the date it stopped being
in force. **The body stays fully readable** — this is history, not an error state, and it stays
editable so it can be annotated.

- [x] **Step 3: Overflow**

The banner carries a page title, which is user-typed text that can be one unbreakable
300-character token. That class has bitten five times, most recently on the page title itself.
Guard it, and inject the hostile case rather than hoping a fixture contains it.

---

## Task 10: Generated indexes

Spec §11: `/[space]/-/adrs`, `/[space]/-/rfcs`, filterable by status.

- [ ] **Step 1: The routes**

Under the `-/` prefix, which `validateSlug` reserves — the refusal is upstream of create and
move, so no page can shadow these. `-/deleted` already proves the pattern.

- [ ] **Step 2: Filtering**

By status, from the vocabulary rather than a hardcoded list, so a Phase 3 vocabulary change
cannot leave the filter behind.

- [ ] **Step 3: Empty and unreadable**

A space with no ADRs renders an explanation, not an empty list. The route is subject to the same
permission rules as everything else.

---

## Task 11: The editor's status and frontmatter surface

- [ ] Publishing into a chosen status, from the legal destinations `PUBLISHABLE_INTO` gives for
      the page's current status — not a free list.
- [ ] **Refuse, or warn about, a document that is only frontmatter.** Task 7 found that
      `draft-empty` measures the whole markdown, so `---\nstatus:\n---` publishes and the reader
      gets a title over a blank page. Before Task 2 it rendered as visible garbage; now it
      renders as nothing. Testing `split.body` is the one-line fix, but it changes a Phase 2 rule
      that has its own message and test.
- [ ] **Tell an author when their cascade is dormant.** Task 6 gates a cascade on publishing into
      `ACCEPTED`, so an ADR published at `PROPOSED` carries a `supersedes:` that does nothing
      yet. The flag exists; the sentence does not. Without it, "I said it supersedes ADR-31 and
      ADR-31 is still current" reads as a bug.
- [ ] Frontmatter validation errors shown against the offending key. Task 3 returns **all**
      errors, not the first — frontmatter is several keys written in one pass, unlike a slug.
      `PublishResult` currently carries a single `error`, so this step has to choose: take
      `errors[0]`, or make the publish error plural. One line either way, but it is a choice.
- [ ] Autosave must **not** start failing because frontmatter is momentarily malformed. Phase 2
      settled this shape for the title: a draft accepts what publish refuses.

---

## Task 12: End-to-end

- [ ] Create an ADR from the template, publish it, read it.
- [ ] A second ADR supersedes the first; the first shows the banner naming the second, and stays
      readable.
- [ ] An ADR decides an RFC; the RFC closes.
- [ ] The generated index lists them and filters by status.
- [ ] A cycle is refused with a message.
- [ ] **Inject hostile content** into the banner and the index — the guard that has caught five
      shapes only catches what it is shown.
- [ ] Clean up: the suite asserts the dev database counts are unchanged.

---

## Task 13: Extend the smoke test

- [ ] A cold-start lifecycle pass over HTTP: publish an ADR, supersede it, confirm the first is
      `SUPERSEDED` and still readable, confirm the index lists both.
- [ ] Clean up everything, including `PageRelation` rows and the audit rows the cascades write.
- [ ] Prove it can fail; the exit code is the contract.

---

## Phase 3 exit criteria

- [ ] `npm test`, `npm run test:e2e`, `npm run smoke` all pass
- [ ] `npm run typecheck && npm run build` clean; `npm run plan:check` 0 drifted
- [ ] Frontmatter never appears in a rendered body or a table of contents
- [ ] An ADR opens on its template and publishes with validated frontmatter
- [ ] Publishing an ADR that supersedes another retires the other **in the same transaction**,
      and the retired page still reads with a banner naming its replacement
- [ ] An ADR that decides an RFC closes it
- [ ] Every guardrail in §6.3 refuses, each with its own message: self-supersede, cycle,
      cross-type, non-ADR deciding, unaccepted source
- [ ] A relation never surfaces a page the viewer cannot read, and a refusal never reveals that
      one exists
- [ ] Generated ADR and RFC indexes list and filter by status
