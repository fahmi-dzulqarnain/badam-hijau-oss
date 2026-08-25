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

**One third of that reasoning went stale the moment Task 5 shipped, and saying so is better than
leaving a measurement a future reader would trust.** It originally read "each target costs Task 5
a resolution query" — Task 5 batches, so resolution is **three** queries regardless of how many
references there are. The cap is still right, and for the surviving reasons: Task 6's cycle walk
and Task 8's row locks do **not** batch, and both run with a transaction open.

**`status` is validated by `publishableStatuses(docType)`, derived from `PUBLISHABLE_INTO`** and
added to `transition.ts` rather than to this module, because Task 10's status filter needs the
same list. `DRAFT` falls out for free — it appears in no row's value — so no doc type accepts
`status: DRAFT` and nothing special-cases it.

**`amends` is ADR-only, and that is the one cell with no derivation behind it.** `AMENDS` fires
no cascade, so the vocabulary says nothing and Task 6 defines no guardrail. An RFC amending an
RFC is plausible. Erring strict here is a decision, not an omission: **if Task 6 wants RFC
`amends`, it needs a guardrail for it in the same change**, not a table entry on its own.

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

## Task 6: Relation guardrails

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

## Task 7: Relations in the publish transaction

Spec §9 step 4. `src/lib/pages/publish.ts` already carries `TODO(phase-3)` at the exact point.

- [ ] **Step 1: Upsert the declared relations**

Inside the existing transaction. Relations the frontmatter no longer declares must be
**removed** — an author who deletes `supersedes:` and republishes is saying the relation is
wrong, and leaving it would make the frontmatter and the database disagree with no way to tell
which is right.

- [ ] **Step 2: Tests**

Including: republishing with a relation removed deletes the row; republishing unchanged is
idempotent and does not churn `createdAt`.

---

## Task 8: Cascades

Spec §9 step 5 and §6.3. **Re-read "Landmines this phase introduces" before starting.**

- [ ] **Step 1: The two cascades**

`supersedes: X` → X becomes `SUPERSEDED`. `decides: R` → R becomes `CLOSED`. Same transaction as
the version write. Validate each target transition through `PUBLISHABLE_INTO`, so a cascade
cannot set a status the vocabulary forbids.

- [ ] **Step 2: Decide the authorization**

The publisher is changing another page's status. Does that require `EDIT` on the target's space?
Argue it. Whatever the answer, the failure mode must not reveal that an unreadable page exists.

- [ ] **Step 3: Lock in a deterministic order**

Ascending page id, including the publishing page's own row. Two ADRs superseding each other
concurrently is the case; a staged test that holds one lock and proves the second blocks is the
only thing that pins it. A `Promise.all` race does not.

- [ ] **Step 4: Audit both sides**

The cascade changed a page the audit trail should show changing. `writeAudit` from
`src/lib/audit/log.ts` — do not touch the delegate directly, a sweep enforces it.

---

## Task 9: Reading relations, and the retired banner

Spec §6.2 and §6.4.

- [ ] **Step 1: Derive the inverse at read time**

Stored one direction; the page reader asks both "what does this supersede" and "what supersedes
this", the second keyed on `toId`. Both filtered by `visiblePage` and `readableSpace` — a
relation must not surface a page the viewer cannot read.

- [ ] **Step 2: The banner**

A page whose status is `SUPERSEDED`, `DEPRECATED`, `CLOSED`, `WITHDRAWN`, `REJECTED` or
`ARCHIVED` renders a banner above the body naming the replacement and the date it stopped being
in force. **The body stays fully readable** — this is history, not an error state, and it stays
editable so it can be annotated.

- [ ] **Step 3: Overflow**

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
