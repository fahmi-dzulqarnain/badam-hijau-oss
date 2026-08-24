# Phase 2 — Authoring

Spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)
(§5.3, §9, §11, §14) · Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md)
· Phase 1: [`2026-08-21-docs-platform-phase-1-foundations-reader.md`](2026-08-21-docs-platform-phase-1-foundations-reader.md)

**Deliverable.** An editor signs in, creates a page, writes Markdown in the browser with
autosave, previews it exactly as it will publish, and publishes it. A second editor working
on the same page gets a conflict banner rather than a silent overwrite. Pages can be moved
and deleted without breaking existing links.

## Decisions taken before writing this

- **CodeMirror 6 for the editing surface**, not a bare textarea. Chosen deliberately over
  the smaller option; the cost is a client bundle and the discipline of keeping autosave and
  conflict handling working underneath a controlled editor rather than a `<textarea>`.
- **Soft delete.** `Page.deletedAt` hides a page from every read while keeping version
  history, authorship and the ability to restore. The cost is a filter that every page query
  must carry — the same shape of hazard as the permission predicate, and it gets the same
  treatment: a helper that must never be spread, and a test that fails when a new query
  forgets it.
- **Preview renders on the server through the Phase 1 pipeline.** Not an approximation.
  Anything else means preview and published output can disagree, which is the one thing a
  preview exists to rule out.

## What Phase 2 does NOT do

Named so they are not mistaken for oversights. Each is a later phase's work, and the publish
transaction is written with the gaps left open rather than filled with stubs.

- **Frontmatter validation against a template schema** (spec §9 step 1) — Phase 3 defines the
  templates. Phase 2 validates the slug, the title and the status transition it knows about.
- **`PageRelation` upserts and lifecycle cascades** (§9 steps 4–5) — Phase 3.
- **Search vector refresh** (§9 step 6) — Phase 4.
- **`GitJob` enqueue** (§9 step 8) — Phase 5. Publishing must work without it, which is the
  property Phase 5 exists to prove rather than assert.
- **`PageSystem` rows** (§9 step 3) — Phase 6.

## Landmines carried in from Phase 1

Both were measured, not guessed. Re-read them before touching Task 10.

**The unique index on `(spaceId, path)` can never be deferred.** It is a bare unique index,
so `SET CONSTRAINTS ... DEFERRED` does not apply, and Postgres checks it row by row *even
within one statement*. A one-statement swap of two sibling paths fails; a one-statement
subtree prefix rewrite commits, because the new path set shares a prefix no moving row
currently holds. Therefore: rewrite descendants in **one** `$executeRaw` statement, reject an
occupied target path **up front** instead of attempting a two-phase shuffle, and take a
`pg_advisory_xact_lock` on the space id so concurrent moves serialise instead of deadlocking
on row-lock order.

**`readableSpace(viewer, ...and)` returns a complete Prisma `where` and must never be
spread**, at any nesting depth. The spread form silently drops the permission predicate.
Phase 2 adds a second predicate of the same shape and the same rule applies to it.

## Conventions that carry forward

From Phase 1's PROGRESS.md — these are settled, not open:

- Every query states its own permission predicate. No exceptions based on call ordering.
- Never `include:` in Prisma queries; always an explicit `select:`.
- Pure logic takes plain objects and imports nothing from Prisma, so it unit-tests without a
  database.
- Integration tests run against the local Homebrew `postgresql@16` on port 5432 — there is
  no container runtime on this machine, and the harness refuses to run unless
  `DATABASE_URL` ends in `_test`.
- Implementers create a new commit, never `--amend`, and stage explicit paths.
- `npm run plan:check` must report **0 drifted** before a task is closed.

---

## Task 1: Schema for drafts, redirects, audit and soft delete ✅

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a migration under `prisma/migrations/`

- [x] **Step 1: Add `deletedAt` to `Page`**

```prisma
  deletedAt          DateTime?
```

and an index — but **read Step 5 before assuming why**. The obvious justification, "every read
filters on it alongside the space", turned out to be wrong when measured:

```prisma
  @@index([spaceId, deletedAt])
```

- [x] **Step 2: Add the three new models**

`PageDraft` follows the spec sketch (§5.2) exactly, with `frontmatter` left in place for
Phase 3 to populate — it is written as `{}` until then rather than added later, because
adding a `NOT NULL` Json column to a populated table is the migration shape this project has
already agreed to avoid.

```prisma
model PageDraft {
  pageId        String   @id
  title         String
  markdown      String
  frontmatter   Json     @default("{}")
  baseVersionId String?
  updatedById   String
  updatedAt     DateTime @updatedAt
  createdAt     DateTime @default(now())

  page        Page         @relation(fields: [pageId], references: [id], onDelete: Cascade)
  baseVersion PageVersion? @relation("DraftBaseVersion", fields: [baseVersionId], references: [id])
  updatedBy   User         @relation("DraftUpdatedBy", fields: [updatedById], references: [id])
}

model Redirect {
  id        String   @id @default(cuid())
  spaceId   String
  fromPath  String
  toPageId  String
  createdAt DateTime @default(now())

  space  Space @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  toPage Page  @relation("RedirectTarget", fields: [toPageId], references: [id], onDelete: Cascade)

  @@unique([spaceId, fromPath])
  @@index([toPageId])
}

model AuditLog {
  id        String   @id @default(cuid())
  actorId   String
  action    String
  spaceId   String?
  pageId    String?
  detail    Json?
  createdAt DateTime @default(now())

  actor User @relation("AuditActor", fields: [actorId], references: [id])

  @@index([spaceId, createdAt])
  @@index([pageId, createdAt])
}
```

`AuditLog.pageId` is deliberately **not** a foreign key to `Page`. An audit row must outlive
the thing it describes; a `Restrict` would block deletes and a `Cascade` would erase the
record of the delete, which is the one row you most want afterwards. Same reasoning for
`spaceId`.

- [x] **Step 3: Add the back-relations to `Page`, `PageVersion`, `Space` and `User`**

Prisma requires both sides. Missing one fails `prisma validate` with a clear message, so let
it tell you rather than guessing the names.

- [x] **Step 4: Migrate**

```bash
npx prisma migrate dev --name authoring_drafts_redirects_audit
```

**Read the warning if one appears.** Every column added here is nullable or has a default,
so it should be clean — but the convention learned in Phase 1's Task 2 stands: a new
`NOT NULL` column on a populated table needs a default or a three-step migration, and
`Page` is populated in every environment this will ever run against.

- [x] **Step 5: Verify the index is actually used** — measured, and the answer was no

Done, and it corrected the reason the index exists. On a throwaway database with 60,000 pages
(42,000 live in one space), the planner sequential-scans
`where "spaceId" = ? and "deletedAt" is null` **with or without** `Page_spaceId_deletedAt_idx`
— identical plans, 8.5 ms vs 9.1 ms. That is the right plan: live pages are ~70% of the table,
and no index helps a query returning most rows.

So the index does **not** speed up the read path, and the justification written above — "every
read filters on it alongside the space" — is wrong. It is kept for the *inverse* query,
`deletedAt IS NOT NULL`, which selects ~10% and is what the restore listing in Task 12 and the
admin surface in Phase 6 need. Anyone tempted to add a similar index for a similar reason
should measure first: at this shape, the read path never uses it.

---

## Task 2: The soft-delete predicate, and a test that notices a query without it ✅

This task is the reason soft delete is affordable. Adding `deletedAt: null` to four queries
is trivial; *keeping* it on every query added over the next four phases is not, and the
failure is silent — a deleted page quietly reappears in a nav rail or a search result.

**Files:**
- Create: `src/lib/pages/visible.ts`, `src/lib/pages/visible.test.ts`
- Modify: `src/lib/pages/repo.ts`
- Modify: `tests/integration/pages-repo.test.ts`

- [x] **Step 1: Write the predicate, in the same shape as `readableSpace`**

`src/lib/pages/visible.ts`:

```ts
import type { Prisma } from "@prisma/client";

/**
 * Every page read must exclude soft-deleted rows. Returns a complete `where`, exactly like
 * `readableSpace` — and like it, **must never be spread**:
 *
 *     where: { ...visiblePage(), OR: [...] }   // WRONG: a sibling OR silently replaces
 *     where: visiblePage({ OR: [...] })        // right
 *
 * Kept as a function rather than a constant so a caller cannot accidentally mutate a shared
 * object, and so the spread form is at least visibly odd.
 */
export function visiblePage(
  ...and: Prisma.PageWhereInput[]
): Prisma.PageWhereInput {
  return { AND: [{ deletedAt: null }, ...and] };
}
```

- [x] **Step 2: Apply it to all four queries in `repo.ts`**

`getPublishedPage`, `listSpacePages`, `listRecentlyPublished`, and — indirectly —
`getReadableSpaceByKey`, which queries `Space` and therefore does not need it. Say so in a
comment there, or the next reader will wonder whether it was forgotten.

- [x] **Step 3: The guard test**

This is the substance of the task. A test that soft-deleted pages are excluded from the
three queries that exist today is worth little; the queries that matter have not been
written yet. So enumerate the module's exports and fail when one is not covered:

```ts
import { expect, test } from "vitest";
import * as repo from "@/lib/pages/repo";

/**
 * Every exported page reader must be listed here with a soft-delete test below. Adding a
 * query without adding its test fails this, which is the point: a missing `deletedAt` filter
 * is invisible until a deleted page reappears in someone's nav rail.
 *
 * `getReadableSpaceByKey` queries Space, not Page, so it is listed as deliberately exempt
 * rather than omitted — an omission reads as an oversight.
 */
const COVERED = new Set([
  "getPublishedPage",
  "listSpacePages",
  "listRecentlyPublished",
]);
const EXEMPT = new Set(["getReadableSpaceByKey"]);

test("every exported page reader has a soft-delete test", () => {
  const exported = Object.keys(repo).filter((k) => typeof (repo as never)[k] === "function");
  const uncovered = exported.filter((k) => !COVERED.has(k) && !EXEMPT.has(k));
  expect(uncovered, "add a soft-delete test for these, then list them in COVERED").toEqual([]);
});
```

**Verify this test can fail** before moving on: add a throwaway export to `repo.ts`, confirm
the test names it, remove it. A guard that cannot fail is worse than no guard — Phase 1 shipped
one of those and only found it by mutation testing.

**Generalised after Task 4, which walked straight through it.** As first written this
enumerated the exports of `src/lib/pages/repo` only, so `saveDraft` — which queries `Page`
from `src/lib/drafts/repo.ts` — was invisible to it. Tasks 6, 9, 10 and 12 all add page
queries and several land in new modules, so the outer guard is now a **filesystem sweep** of
`src/` for `db.page.*`: a module that queries `Page` and is not registered fails the test.
The per-module export enumeration sits inside that. Both escape routes are mutation-verified —
a new unregistered module, and a new export in a registered one.

The lesson generalises past this guard: **a coverage check scoped to one file silently stops
covering as soon as the thing it guards moves.**

- [x] **Step 4: One integration test per covered query**

Soft-delete a seeded page, then assert it is absent from each. For `getPublishedPage`, assert
`null` rather than a thrown error — the reader route turns that into the same 404 an
unreadable page gets, and the two must stay indistinguishable.

---

## Task 3: Slug and path rules ✅

Pure module, no database. Everything here is a rule the rest of the phase depends on, and all
of it is cheap to test exhaustively.

**Files:**
- Create: `src/lib/pages/slug.ts`, `src/lib/pages/slug.test.ts`

- [x] **Step 1: `validateSlug(slug)`**

Rejects, each with a distinct message the editor can show against the field:

| Input | Why |
|---|---|
| `""` | empty |
| `"-adrs"` | **leading `-` is reserved for application routes** (spec §5.3) — `/[space]/-/adrs` is a real route in Phase 3, and a page allowed to take that path would shadow it |
| `"a/b"` | a slug is one segment |
| `"A-Slug"` | uppercase; slugs are lowercase kebab |
| `"a b"` | whitespace |
| `"."`, `".."` | path traversal shapes |
| anything not `[a-z0-9-]` | keeps paths URL-safe without encoding |
| `> 80` chars | a path is built from these and Postgres indexes have limits |

Accepts `a`, `adr-0042-mqtt-topic-naming`, `v2`, `2026-08-23`.

- [x] **Step 2: `childPath(parentPath, slug)`**

Returns `slug` when `parentPath` is null, else `${parentPath}/${slug}`. Phase 1's seed got
this wrong once by deriving from the parent's **slug** rather than its **path**, which is
silently correct two levels deep and wrong at three. Test the three-level case explicitly.

- [x] **Step 3: `descendantPaths(oldPrefix, newPrefix, path)`**

The pure half of the move: given a path, return what it becomes. Test that
`architecture/mqtt-contracts` moving to `platform/mqtt-contracts` takes
`architecture/mqtt-contracts/topic-registry` with it, and that
`architecture/mqtt-contracts-v2` — a **prefix that is not a path boundary** — is left alone.
That off-by-one is the whole reason this is a tested function rather than a string
concatenation inline in the move.

- [x] **Step 4: `validatePath(path)` — added after Step 1's cap turned out not to guard what it claimed**

The `> 80` per-slug cap was justified above as protecting the btree index. Reviewing the
shipped module showed that reasoning does not hold: the index limit applies to the **whole**
`Page.path`, and nesting depth is unbounded, so 33 levels of perfectly legal 80-character
slugs breach it while every individual slug passes.

Measured on Postgres 16 with a `unique index on (a, b)` mirroring `(spaceId, path)`:

```
  2600 bytes  INSERT 0 1
  2700 bytes  ERROR: index row size 2744 exceeds btree version 4 maximum 2704
```

**Probe with incompressible text.** A first attempt using `repeat('x', 3000)` inserted
happily and suggested there was no limit at all — the value compressed. That false negative
is the more useful half of this finding.

So `slug.ts` now also exports `MAX_PATH_BYTES = 2000` and `validatePath(path)`, returning the
same `FieldError` shape so it renders against the slug field like every other rejection.
The per-slug cap stays — it keeps a URL and a nav entry sane — but it is no longer claimed to
do a job it cannot do.

**Task 6 and Task 10 must both call it**, and their sections say so. The move case is the
sharper one: moving a subtree under a deeper parent lengthens every descendant at once, so a
move that looks small can breach the limit for a page the user was not even looking at —
check the longest resulting descendant, not just the page being moved.

---

## Task 4: Draft repository and the conflict contract ✅

**Files:**
- Create: `src/lib/drafts/repo.ts`, `src/lib/drafts/conflict.ts`, `src/lib/drafts/conflict.test.ts`
- Create: `tests/integration/drafts-repo.test.ts`

The conflict rule from spec §9, stated precisely because everything else depends on it:
*every save sends the `updatedAt` it last saw; a mismatch returns 409 with the other editor's
name, their timestamp, and both texts; a save is never silently discarded and never silently
overwrites.*

- [x] **Step 1: The pure decision, separated from the database**

`src/lib/drafts/conflict.ts`:

```ts
export type SaveDecision =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "vanished" }
  | { kind: "conflict" };

/**
 * `seen` is the `updatedAt` the client last received; `current` is what the row holds now.
 *
 * Both arguments are nullable and all four combinations are answered explicitly, because
 * the two asymmetric ones are the whole point of this module:
 *
 * | `current` | `seen`   | decision   |
 * |-----------|----------|------------|
 * | null      | null     | `create`   — a genuine first save
 * | null      | non-null | `vanished` — the draft this client was editing is gone
 * | non-null  | null     | `conflict` — a client that lost track of what it last received
 * | non-null  | non-null | `update` if the instants match, `conflict` otherwise
 *
 * Neither null is an opt-out; each is a claim about the world, and a claim that disagrees
 * with the row is refused rather than obeyed. A client sending no `seen` while a draft DOES
 * exist is not a first save — it is a client that lost track, and writing would destroy
 * whatever the other editor put there. The mirror is just as dangerous and less obvious: a
 * client sending a `seen` while NO draft exists is not a first save either. Publishing
 * deletes the draft, so that client is holding a timestamp for a row that has been published
 * out from under it, and answering `create` would silently resurrect pre-publish text on top
 * of the version that just went out. Answer `vanished` and let the person decide.
 *
 * Timestamps cross the wire as strings and come back from Postgres as Date objects with
 * millisecond precision, so compare epoch milliseconds — `Date === Date` is reference
 * equality and would report every save as a conflict, while `>=` would let a stale save
 * through whenever the clock ties.
 */
export function decideSave(args: {
  current: Date | null;
  seen: Date | null;
}): SaveDecision {
  if (args.current === null) {
    return args.seen === null ? { kind: "create" } : { kind: "vanished" };
  }
  if (args.seen === null) return { kind: "conflict" };
  return args.current.getTime() === args.seen.getTime()
    ? { kind: "update" }
    : { kind: "conflict" };
}
```

**The rule is symmetric, and the first version of this plan only stated half of it.** As
written it said: a client that sends no `seen` while a draft **does** exist is not a first
save — it is a client that lost track, and the safe answer is a conflict, not an overwrite.
True, and the case a naive implementation gets wrong.

The mirror was missing, and Task 7 found it. A client that sends a **non-null `seen` while no
draft exists** is not a first save either — the draft it was editing has been **deleted**.
The original three-case function answered `create` for that, on the reasoning that there is
"nothing to overwrite". There is: Task 9's publish deletes the draft, so the row is missing
precisely *because* someone just published. Answering `create` silently resurrects a draft
carrying pre-publish text over the version that was published a second earlier, returns 201,
and tells nobody.

So there are four cases, not three, and they are worth writing as a table before writing the
function:

| `current` | `seen` | decision |
|---|---|---|
| null | null | `create` — a genuine first save |
| null | non-null | `vanished` — the draft you were editing is gone |
| non-null | null | `conflict` — a client that lost track |
| non-null | non-null | `update` if the epoch milliseconds match, else `conflict` |

`vanished` is decided **before any query or write**, returns the caller's text in `mine` so
nothing is stranded, and reaches the wire as a 409 with `theirs: null` — the shape Task 5
already specified for a branch that was, until this fix, almost unreachable.

The general lesson is worth more than the fix: **a rule about one direction of a comparison
should be checked in the other direction before it is called done.** The docstring here
argued its case convincingly and was half a rule.

- [x] **Step 2: `saveDraft(viewer, pageId, input)`**

Permission first: `can(viewer, space, "EDIT")`, and a viewer who cannot **read** the space
gets the same `null`/404 an unreadable page gets — never a 403, which would confirm the page
exists. Then apply `decideSave`. On conflict, return the other editor's name, their
`updatedAt`, and both texts, so the API layer does not need a second query to build the 409.

Use an atomic `updateMany` with `updatedAt` in the `where` rather than read-then-write:
two saves arriving together must not both read the same `updatedAt` and both decide "update".
The row count tells you which one lost.

- [x] **Step 3: Integration tests**

Cover: create; update with the correct `seen`; conflict with a stale `seen`; conflict with a
missing `seen` against an existing draft; a viewer with only `VIEWER` role rejected; and a
non-member getting the not-found shape rather than a permission error.

**On testing the atomic write — this instruction was wrong, and the correction is the most
useful thing in this task.** It originally said to fire two saves with `Promise.all` and
assert exactly one wins. That test reads like a race test and is not one: with a real
connection pool the two saves reliably stagger, so the loser's read already returns the
winner's `updatedAt`, `decideSave` returns `conflict`, and **the write predicate is never
consulted**. Verified by removing `updatedAt` from the `updateMany` where clause — the
`Promise.all` test passed three runs out of three with the atomicity guarantee gone.

Keep that test: it pins the outcome contract and it does kill the `>=` comparison. But the
guarantee needs the interleaving **staged deterministically**: hold an interactive transaction
open with an uncommitted `UPDATE` on the row, let `saveDraft` read the pre-update version
under MVCC and decide `update` on a timestamp that is about to stop being true, and let its
own `UPDATE` block until the other commits — Postgres then re-evaluates the predicate against
the new row version. Waits stage the interleaving and nothing is asserted about them; a wait
that is too short only makes the test agree with the one above, and can never make a broken
predicate pass.

Generalise it: **a concurrency test that never blocks is not testing a write predicate.**

---

## Task 5: The draft autosave endpoint ✅

**Files:**
- Create: `src/app/api/drafts/[pageId]/route.ts`
- Create: `tests/integration/draft-route.test.ts`

- [x] **Step 1: `PUT` handler**

Reuse the body-size lesson from Phase 1's bug endpoint verbatim, because a Markdown document
is much larger than a bug report and this endpoint fires every two seconds:

- Reject a **missing** `Content-Length` with **411** before reading the body.
  `Number(request.headers.get("content-length"))` is `0` for a missing header, so a
  numeric-only check lets a chunked body through.
- Cap on the declared length before `request.json()`. Size the cap in **bytes**, and remember
  the Phase 1 measurement: Zod counts UTF-16 units while `Content-Length` counts UTF-8, so a
  document of CJK text is roughly 3× its character count. **1 MB** for Markdown.
- Strip `\p{Cc}` except newline, tab and carriage return — Postgres rejects NUL and a single
  one makes the save permanently unretryable. **Not** `\p{C}`, which also destroys ZWJ emoji
  and bidi marks.

  **Use `stripControl` from `src/lib/text/control.ts`.** It did not exist when this task was
  written: the rule lived inline in `src/lib/bugs/schema.ts`, and Task 5 duplicated it because
  extracting it would have put a Phase 1 whole-file fence into drift — a real conflict between
  two of this project's rules, correctly escalated rather than resolved unilaterally. It is
  now one implementation with its own tests, imported by both surfaces, and Task 9 (publish)
  and Task 12 (delete) should import it too rather than making a third copy.

  Its tests write every control character as an **escape sequence**, never a literal. Literal
  NULs and zero-width marks are invisible in a diff and this project has already had a shell
  command rejected for carrying one.

- [x] **Step 2: The 409 body**

```ts
{
  error: "conflict",
  theirs: { title, markdown, updatedAt, editorName },
  mine:   { title, markdown },
}
```

Both texts, per the spec. The banner cannot offer "load theirs" without theirs, and cannot
offer "keep mine" without having kept mine somewhere the reload will not destroy.

- [x] **Step 3: Tests**

201/200 on create and update, 409 on stale, 411 on missing length, 413 on oversized, 404 for
a page in an unreadable space, and a round-trip proving the returned `updatedAt` is what the
next save must send.

---

## Task 6: Creating a page ✅

**Files:**
- Create: `src/app/(editor)/new/page.tsx`, `src/lib/pages/create.ts`
- Create: `tests/integration/page-create.test.ts`

- [x] **Step 1: `createPage(viewer, { spaceId, parentId, slug, title, docType })`**

Validate the slug and title first, **outside** the transaction — they are pure, a concurrent
write cannot affect them, and holding a space-wide lock across a typo serialises nothing.

Then, inside one transaction that opens with `pg_advisory_xact_lock(hashtext(spaceId))`:
resolve the parent's path, build the child path, **run `validatePath` on the assembled
result** — the per-slug cap does not bound it — **reject an occupied path up front** with a
field-level message, create the `Page` with `status: DRAFT` and no `publishedVersionId`,
create its `PageDraft`, and write an `AuditLog` row.

**The lock is not optional, and this task originally did not ask for one.** Without it the
occupancy pre-check is advisory: at READ COMMITTED a concurrent create — or a Task 10 move —
can take the path between the check and the insert, and the failure arrives as the exact
`P2002` the pre-check exists to prevent. The parent read must be *inside* the lock too: a move
landing between the parent read and the insert creates a child carrying its parent's **old**
path prefix — a page whose path disagrees with its parent's, reachable by URL and missing from
the nav rail.

**Task 10 must take the same lock on the same key.** Two different keys serialise create
against create and move against move, and neither against the other — which is precisely the
pair that corrupts a tree.

**A path held by a soft-deleted page is refused**, with its own error code, naming the page
and pointing at restore. The unique index does not know about `deletedAt`, so a soft-deleted
row still holds its path — which makes the collision check **the one page read in this module
deliberately without `visiblePage()`**. Filtering deleted rows there would let the check pass
and the insert fail with the constraint violation the check exists to avoid. Pin that absence
with a test: it is exactly the line a future reader will try to "fix".

A page created this way is a draft: Phase 1 already renders those as inert text in the nav
rail and 404s them in the reader, so a half-written page is invisible to readers from the
moment it exists. That behaviour is load-bearing here, not incidental.

- [x] **Step 2: The form**

Space (only spaces where `can(viewer, space, "EDIT")`), optional parent, title, slug
prefilled from the title but editable, doc type. On submit, redirect to `/edit/[pageId]`.

- [x] **Step 3: Tests**

Slug rejections surface as field errors, not a 500. An occupied path is rejected with a
message naming the conflict. A viewer without `EDIT` in the target space cannot create, and
cannot discover the space exists by trying.

---

## Task 7: The editor ✅

**Files:**
- Create: `src/app/(editor)/edit/[pageId]/page.tsx`, `src/components/Editor.tsx`,
  `src/components/editor.css`
- Modify: `package.json`, `src/app/(editor)/layout.tsx` — `editor.css` is imported by the
  layout, never by a page route (Phase 1 measured `.doc` computing differently on a hard load
  versus a soft navigation when a page imported its own CSS)
- Create: `src/lib/pages/editable.ts` + `tests/integration/page-editable.test.ts` — loading the
  page belongs in a module, not the route file: the soft-delete sweep would trip on a `Page`
  query in the route either way, and a route file is not integration-testable
- Create: `src/lib/editor/state.ts`, `scheduler.ts`, `save.ts` (+ tests) — the save-state
  machine, the autosave clock and the response-to-action mapping, pulled out of the component
  so they are testable without a browser

- [x] **Step 1: Install CodeMirror 6**

```bash
npm install codemirror @codemirror/lang-markdown @codemirror/state @codemirror/view
```

- [x] **Step 2: The client component**

A controlled CodeMirror instance is the part most likely to go wrong. Two rules:

- **Do not recreate the `EditorView` on every render.** Build it once in an effect keyed on
  the page id and dispatch transactions for external changes ("load theirs"). Recreating it
  loses the cursor, the undo history and the scroll position on every autosave tick.
- **Do not round-trip the document through React state on every keystroke.** Keep the text in
  the view and read it when the debounce fires. Autosave every 2 s (spec §9), and also on
  blur, so a closed tab does not lose the last two seconds.

Show save state — `Saving…` / `Saved 14:22` / `Unsaved changes` — and never leave it blank
after a failure; a silent failure that looks like an idle editor is how work gets lost.

Two bugs found here that the plan did not anticipate, both worth stating as rules:

- **Autosave must suspend while a conflict is unanswered.** It kept firing and produced a
  second 409 for the same unresolved conflict. A `shouldAutosave` flag existed but was wired
  only to the hint text, not to the scheduler.
- **An edit must not overwrite an error status.** The next keystroke replaced a 403's
  explanation with "Unsaved changes" — and nothing retries a 403, so that message was the only
  account the person would ever get. Errors clear on a successful save or an explicit
  resolution, never on typing.

**The autosave timer is armed by the first edit and deliberately not re-armed by later ones.**
A textbook debounce means steady typing never saves at all.

- [x] **Step 3: The conflict banner**

On 409, show the other editor's name and timestamp, with **Keep mine** and **Load theirs**.
Keep mine re-sends with their `updatedAt` as `seen`, so it is an explicit overwrite of a
version the user has been shown. Load theirs dispatches their text into the view. Do not
auto-resolve, and do not dismiss the banner on the next keystroke.

- [x] **Step 4: Manual verification**

Two browser profiles are not available with this tooling; two tabs share a cookie jar, so a
genuinely different editor name needs a second actor driven from a script. Both were used.

Type in both. Confirm: the second save conflicts, the banner
names the first editor, Load theirs replaces the text, Keep mine wins, and no save is lost in
either direction.

---

## Task 8: Server-rendered preview ✅

**Files:**
- Create: `src/app/api/preview/route.ts`
- Modify: `src/components/Editor.tsx`

- [x] **Step 1: `POST` returning rendered HTML**

Call `renderMarkdown` from Phase 1 — the same function the reader uses, not a copy. The whole
value of this route is that preview and published output cannot disagree.

Requires `EDIT` on the page's space. The route renders arbitrary caller-supplied Markdown, so
without that check it is an open HTML-rendering endpoint for anyone with a session.

- [x] **Step 2: Wire it in**

Debounced, same 2 s tick as autosave, rendered beside the editor. Reuse `.doc .body` so the
preview inherits the reader's typography.

Use a **second `createSaveScheduler`**, not a fresh timer: every property that module encodes
is one preview wants too — armed by the first edit so steady typing does not starve it, never
two in flight, an edit mid-flight re-arms. Preview is deliberately independent of saving, so
it keeps rendering while autosave is suspended behind an unanswered conflict.

**This step found a Phase 1 reader bug, and how it hid is the point.** Checking the preview
pane for horizontal overflow turned up a 4,660-pixel overflow **on the reader itself** from a
single long heading: `doc.css`'s `overflow-wrap` guard covered `p, li, dd, td, th, blockquote`
and stopped short of headings. Measured directly — a 300-character token in an `<h2>` gives
4,660px, the same token in a `<p>` gives 0.

The Playwright test named *"no page scrolls horizontally, whatever the content"* never saw it,
because **it only measures the content that happens to be seeded**, and no seeded page has an
unbreakable heading. A guard that asserts a class over a fixed corpus is testing the corpus.

Fixed in `doc.css`, not in the preview pane — a pane-scoped fix would have left the bug on the
surface everyone actually reads, which is the "too narrow, and silent about it" failure this
project has now hit four times.

**Task 14 must close the guard, not just re-run it:** keep the route loop, and add a
DOM-injection probe to the *reader* spec — append an `h2`, a `p` and a `pre` each carrying a
300-character unbreakable token, assert zero overflow, remove them. No database writes, and it
would have caught this.

---

## Task 9: Publishing ✅

**Files:**
- Create: `src/lib/pages/publish.ts`, `src/lib/pages/transition.ts`,
  `src/lib/pages/transition.test.ts`
- Create: `tests/integration/publish.test.ts`
- Create: `src/app/api/pages/[pageId]/publish/route.ts` +
  `tests/integration/publish-route.test.ts`, and a Publish button in
  `src/components/Editor.tsx`. The original list omitted these, but this phase's own exit
  criterion — "an editor creates, writes, previews, publishes and reads back a page in the
  browser" — and Tasks 14 and 15 all require publish to be *reachable*, not merely callable.

- [x] **Step 1: The status transition rule, as a pure function**

Phase 3 owns the full per-doc-type vocabularies. Phase 2 needs only: a page may publish into
`CURRENT`, and an already-`ACCEPTED` ADR may not silently revert to `DRAFT`. Write it as a
table so Phase 3 extends the table rather than rewriting the caller.

**This step found a contradiction in the spec.** §6.1 lists RFC as `DRAFT → IN_REVIEW → …`
while the paragraph below it says `DRAFT` is "legal as an origin state for every type and as a
destination for none". An RFC's first publish therefore has nowhere legal to go, and
publishing into `DRAFT` would make a published RFC indistinguishable from an unpublished one.
Resolved as `FIRST_PUBLISH.RFC = IN_REVIEW`, and the correction is written into spec §6.1
rather than left in a code comment.

**Markdown is stored unstripped and untrimmed.** The preview pane rendered exactly those
bytes, so normalising on the way into `PageVersion` would publish something the approved
preview never showed. Emptiness is tested on a trimmed copy only. The *title* is a different
matter — it is stripped and trimmed, and empty is refused, because Task 5 deliberately allows
an empty title at autosave and publish is where that stops being acceptable.

- [x] **Step 2: The transaction**

Steps 1–3 and 7 of spec §9, all or nothing, in one `db.$transaction`.

**Step 3 is split between phases and this plan twice called it whole.** Spec §9 step 3 is
"Update `Page` (…) **and its `PageSystem` rows**" — the page update is Phase 2, the
`PageSystem` rows are Phase 6. Implement the former and leave `TODO(phase-6)` inside it.

**Concurrency: a `FOR UPDATE` row lock on the `PageDraft` row, taken as the transaction's
first statement.** Not the space-wide `pg_advisory_xact_lock` that Tasks 6 and 10 take —
publish never touches `Page.path`, so that lock would serialise every publish in a space
against every other publish, create and move over a resource none of them share. What publish
does share is *this page's draft*, and it has exactly two competitors: another publish of the
same page, and an autosave of the same page. Both are keyed by `pageId`, so the natural lock
is the draft row itself — which `saveDraft`'s existing atomic write already takes, so Task 4
needed no change.

Without it, two publishes read the same draft under MVCC and insert two identical versions,
one of them pointed at by nothing. `Page.publishedVersionId` being `@unique` does not prevent
this: it constrains which version can be pointed *at*, not how many are created.

A concurrent **soft delete** is handled by a write predicate rather than a second lock — the
page update is an `updateMany` carrying `visiblePage(...)` with a row-count check that rolls
the version insert back. A second `FOR UPDATE` on `Page` would hold a row lock across the
whole publish and impose a lock-ordering rule on Tasks 10 and 12 for no gain.

The steps:

1. Validate the transition and that the draft is not empty.
2. Insert `PageVersion` with the draft's title, markdown and the publisher as author.
3. Update `Page`: `title`, `status`, `publishedVersionId`, `publishedAt`.
4. Delete the `PageDraft` — the published version is now the source, and a draft identical to
   what is published is a confusing thing to reopen.

   **This step is what makes the `vanished` case real, so read that first.** Until publish
   deletes drafts, no draft ever disappears under a live editor. Once it does, every open
   editor on that page is holding a `seen` for a row that no longer exists, and
   `decideSave` must answer `vanished` — not `create`. If it answers `create`, the next
   autosave silently resurrects the draft with pre-publish text over the version that was
   just published, and nobody is told. Task 7 found this before it could happen; do not
   reintroduce it by treating "no row" as "first save".
5. Write `AuditLog`.

Steps 4, 5, 6 and 8 of the spec belong to Phases 3–6 and are **not** stubbed. Leave a
`TODO(phase-N)` at each point so the sequence stays discoverable from the code, the way
Phase 1 marked the audit wiring point.

- [x] **Step 3: Tests**

Publishing makes the page readable by a member (end to end through `getPublishedPage`, not by
inspecting rows). The draft is gone afterwards. An illegal transition is rejected and
**nothing is written** — assert the version count is unchanged, which is the assertion that
actually tests atomicity. A `VIEWER` cannot publish. Publishing twice in a row from a deleted
draft fails cleanly rather than writing an empty version.

---

## Task 10: Moving a page — the landmine ✅

Re-read the landmine section at the top of this document before starting.

**Files:**
- Create: `src/lib/pages/move.ts`
- Create: `tests/integration/page-move.test.ts`

- [x] **Step 1: `movePage(viewer, pageId, { newParentId, newSlug })`**

In one transaction, in this order:

1. `pg_advisory_xact_lock(hashtext(spaceId))` — **the same key Task 6's create takes**. Two
   different keys serialise moves against moves and creates against creates but neither
   against the other, and create-versus-move is the pair that corrupts a tree: a create
   resolving a parent's path while a move rewrites it.
2. Resolve the new path. **Reject a cycle** — a page cannot move under its own descendant.
   Compute this from the path prefix, not by walking parents, which is a loop waiting to
   happen on data that already has a cycle.
2b. **Run `validatePath` on the longest resulting descendant path**, not just on the moved
   page. Moving a subtree deeper lengthens every descendant at once, and the btree index
   rejects the overflow as a raw constraint violation that names no field.
3. Reject an occupied target path up front.
4. One `$executeRaw` rewriting the subtree.
5. Insert a `Redirect` for every old path, and delete any `Redirect` whose `fromPath` equals a
   path now occupied — otherwise moving A→B then B→A leaves a redirect pointing at a live
   page and reads bounce.
6. `AuditLog`.

- [x] **Step 2: The statement**

```sql
UPDATE "Page"
   SET path = $1 || substring(path from char_length($2) + 1)
 WHERE "spaceId" = $3
   AND ("path" = $2 OR "path" LIKE $4 ESCAPE '\')
```

**`$4` is the old prefix with `%`, `_` and `\` escaped, then `/%` appended.** Slugs allow `-`
and digits but a future rule change could allow `_`, and `_` is a single-character wildcard in
`LIKE`: unescaped, moving `a_b` would drag `axb` along with it.

Three corrections to this fence, all found while implementing it:

- **"The `ESCAPE` clause and the escaping are one decision" is good guidance and factually
  wrong.** Postgres already defaults to backslash, so deleting the clause changes nothing and
  **no test can catch it** — an honest *equivalent mutant*. The escaping function carries all
  the weight; dropping *that* is caught immediately. Keep the clause as documentation, but do
  not believe it is the mechanism.
- **In a TypeScript template literal it must be written `ESCAPE '\\'`.** Written `'\'` that is
  the escape sequence for a quote, and Postgres receives `ESCAPE ''` and rejects it.
- **The subtree *read* cannot use Prisma.** `path: { startsWith: oldPath + "/" }` escapes no
  `LIKE` metacharacter and adds no `ESCAPE`, so for a page at `probe/back\` it emits
  `LIKE 'probe/back\/%'` — the backslash escapes the slash, the page's own child stops
  matching, and the read comes back one row short **silently**. Confirmed against Postgres. The
  read must be raw and must share one pattern with the rewrite.

And three things the module needs that this step list does not mention:

- **Update the moved row's own `parentId` and `slug`.** The rewrite moves *paths*; a page whose
  path and `parentId` disagree is reachable by URL and absent from the nav rail.
- **Refuse a no-op move.** Performing it writes a redirect from a live path to itself — the
  exact bug step 5's reclaim exists to prevent, manufactured by the function.
- **Step 5's reclaim is necessary but not sufficient.** A redirect can already be standing
  *dormant* at a path the move is vacating, shadowed by the page now leaving, and
  `(spaceId, fromPath)` is unique — so the insert dies on a `P2002` unrelated to anything the
  author asked for. Delete both sets; the newer redirect wins.

**Soft-deleted descendants are rewritten with the rest of the subtree.** The invariant is one
line: *every row's path is its parent's path plus its slug, deleted or not.* Skipping deleted
rows breaks it three ways — `createPage` reads deleted rows deliberately and would refuse a
path in a subtree that row no longer belongs to; Task 12's restore would return a page to a
path whose ancestors live elsewhere, URL-reachable and rail-invisible; and moving the subtree
back would collide on `(spaceId, path)` with a row nobody can see. The cost is that "restore
puts it back where it was" means *under its parent* — the only version of that promise which
survives the parent moving. Redirects are written for deleted rows too, and are inert until
restore because they point at `toPageId`.

- [x] **Step 3: Tests, including the two shapes the probe distinguished**

- A subtree move rewrites every descendant, verified three levels deep.
- A sibling **swap** is rejected up front rather than attempted — assert the error, and assert
  both paths are unchanged.
- A move onto an occupied path is rejected with both paths intact.
- A page cannot move under its own descendant.
- `a/b_c` is not dragged along when `a/b` moves, and `mqtt-contracts-v2` is not dragged when
  `mqtt-contracts` moves.
- Two concurrent moves in one space serialise. **This bullet originally said to run them with
  `Promise.all`, which contradicts this project's own measured finding** that a pooled race
  staggers and passed 3 runs out of 3 with an atomicity guarantee deleted. Stage it: hold a row
  lock so move #1 is stuck *while holding the advisory lock*, and prove move #2 does not
  complete. Keep a `Promise.all` test too if you like, labelled as an outcome contract — which
  is how `publish.test.ts` does it — but it is not the test of the lock.

---

## Task 11: Redirects in the reader ✅

**Files:**
- Modify: `src/app/(reader)/[space]/[...path]/page.tsx`, `src/lib/pages/repo.ts`
- Modify: `tests/integration/pages-repo.test.ts`

- [x] **Step 1: `resolveRedirect(viewer, { spaceKey, path })`**

**The signature in the original plan — `(viewer, spaceId, path)` — was wrong.** A `spaceId`
means the caller has already resolved a readable space, which is exactly the "guarded by call
ordering" shape `repo.ts` forbids; and on a read miss the route does not know whether the space
was readable. Taking the *key* lets the query state `readableSpace(viewer, { key })` itself.

Return the target only when the viewer may read the space **and** the target is not
soft-deleted — a redirect must not become a way to learn that a page exists somewhere you
cannot read, and it must not deliver you to a deleted page.

**Do not state the permission predicate twice.** The first implementation put
`readableSpace(viewer, { key })` on the redirect's own space *and* again nested inside the
`toPage` filter, as defence in depth. Mutating away **either one alone left all 22 tests
passing**: two statements of one predicate make neither of them testable, and the redundancy
that reads as safety is what stops a mutation being caught. State it once, on the space the URL
names — the space whose readability is the question being asked — and make the `toPage` filter
carry *shape* constraints instead (not soft-deleted; in the space the URL names), each with its
own test.

This is the mirror of the "a rule implemented in two places is not yet a convention" lesson: a
**predicate** stated in two places is not twice as safe, it is untestable.

A third clause was added that the plan did not ask for: the target must be **in the space the
URL names**. Nothing in the schema ties `Redirect.spaceId` to `toPage.spaceId`, and a writer
that broke that would make this function answer `/engineering/…` with a path that only exists
in `handbook`. It has its own test.

- [x] **Step 2: A permanent redirect, one hop only — and it is 308, not 301**

Resolve exactly one hop. A chain is a bug in the move (Task 10 step 5 prevents it), and
following chains turns that bug into an infinite loop in production instead of a wrong answer
in a test.

**One hop is sufficient rather than a limitation, and the schema is why.** `Redirect` stores
`toPageId`, not a target path, so resolution always lands on the page's *current* path. If the
page moves again the old redirect still arrives in one hop. Do not add a `toPath`.

Spec §14 said 301; the code emits **308**, and the spec has been corrected rather than the code
bent to match. `permanentRedirect()` emits 308; forcing a literal 301 means writing the status
by hand where Next also writes it, and it could not live in middleware anyway — the lookup is
permission-checked and the auth config has deliberately not been split for the edge. On the
merits 308 is the more precise of the two: 301 historically licenses an intermediary to rewrite
the method to GET, 308 forbids it. Its only real cost is age (RFC 7538, 2015).

**Where the lookup goes: inside the miss branch, after the page read.** Not for cost, though
that matters — the load-bearing reason is that a `Redirect` row and a live page can legitimately
share a path. A redirect goes dormant the moment something is created or moved on top of it, and
Task 10 only reclaims the ones its own move makes live. Looking the redirect up *first* sends
readers away from a page that exists and renders. **Measured:** with a dormant redirect over a
live published page, the correct order returns 200 and renders it; the lookup hoisted above the
page read returns `308` to somewhere else — **and the whole vitest suite still passed.**

That ordering is a route property, so no vitest can pin it. It is an HTTP-level check, and
Tasks 14 and 15 are where it belongs.

- [x] **Step 3: Tests**

Old path redirects to the new one. A redirect into an unreadable space 404s rather than revealing
the target. A redirect to a soft-deleted page 404s. No redirect chain is followed.

---

## Task 12: Soft delete and restore ✅

**Files:**
- Create: `src/lib/pages/delete.ts`
- Create: `tests/integration/page-delete.test.ts`

- [x] **Step 1: `deletePage(viewer, pageId)`**

Requires `EDIT`. Sets `deletedAt` on the page **and every descendant** in one statement —
leaving children visible under a deleted parent produces pages reachable by URL with a broken
breadcrumb. Takes `pg_advisory_xact_lock(hashtext(spaceId))`, the create/move key. Writes a
`Redirect` from each deleted path to the **nearest surviving ancestor**, so an existing link
lands somewhere useful rather than on a 404. `AuditLog`.

Reuses Task 10's `LIKE` escaping — extracted to `src/lib/pages/like.ts` as `escapeLikeLiteral`
and `subtreePattern`, so a subtree *read* and a subtree *write* cannot disagree about where the
boundary is.

**A deleted root page gets no redirect at all.** `Redirect.toPageId` is not nullable and a root
has no surviving ancestor. A sibling root is arbitrary, and a 308 is permanent and
browser-cached — pointing it at an unrelated page makes `resolveRedirect` lie, which is worse
than the 404 the reader already produces well. Making `toPageId` nullable is a real option and
was deliberately not taken here: it grows a branch in every `Redirect` reader for a case that a
404 plus the nav rail already answers. The result carries `redirectTo: null` explicitly rather
than leaving a caller to infer it from a count of zero.

**`PageDraft` is kept, not dropped.** `PageVersion` rows are immutable history and can always
be re-read; the draft is the only copy of unpublished human text. Dropping it makes a *soft*
delete destructive in the one place restore cannot undo. It costs nothing — every draft reader
already carries `visiblePage()`, and `PageDraft.pageId` cascades, so a future hard delete still
takes it.

**`AT TIME ZONE 'UTC'` on the raw stamp is load-bearing, and it was measured.** Prisma maps
`DateTime` to `TIMESTAMP(3)` *without* time zone and converts to UTC itself on the way in and
out. A raw statement bypasses that: Prisma binds a JavaScript `Date` as a `timestamptz`, and
assigning a `timestamptz` to a `timestamp` column converts it to the **session** time zone.
Measured on this machine (`Asia/Kuala_Lumpur`):

```
timestamptz -> timestamp:      2026-08-23 15:00:00
timestamptz AT TIME ZONE UTC:  2026-08-23 07:00:00
```

A stamp of `07:00Z` was stored as `15:00` and read back as `15:00Z` — eight hours in the
future, silently. The whole delete/restore round trip stayed green, because the value is only
ever compared against itself. **Any raw write of a `Date` into a Prisma `DateTime` column needs
this cast.** Today `delete.ts` is the only one; a test pins it against the real clock rather
than against another copy of itself.

- [x] **Step 2: `restorePage(viewer, pageId)`**

Requires `MANAGE_SPACE`. The asymmetry with delete's `EDIT` is deliberate: an editor cannot undo
their own delete, and the refusal says who can.

**This step's stated premise was wrong, and the correction is worth more than the step.** It
said to clear `deletedAt` "only if the path is still free — something else may have been created
there in the meantime, and the unique index will refuse". **That state cannot exist.**
`@@unique([spaceId, path])` is total: it knows nothing about `deletedAt`, so a soft-deleted row
goes on holding its path, and both `createPage` and `movePage` read deleted rows deliberately
and refuse with `path-occupied-by-deleted`. Task 6 rejected "move the deleted page's path
aside" *precisely because* this step promises to put a page back where it was. The check was
implemented anyway — it is one query, and it is the difference between a sentence and a `P2002`
if a Phase 3 importer ever reaches `Page` directly, or if that index is ever made partial on
`deletedAt IS NULL` — but it is an **equivalent mutant**: deleting it entirely leaves the whole
suite green, and that was reported rather than papered over with a test that pins the wrong
thing.

The restore failure that is real, and is tested, is **`ancestor-deleted`**: restoring `a/b/c`
while `a/b` is still deleted is refused, naming the shallowest deleted ancestor. Otherwise
`buildTree` promotes the parentless node to a **root**, and it surfaces as a bogus top-level
module.

**Restore is all-or-nothing over the set one delete took.** Delete stamps every row with a
single `deletedAt` and skips rows that already had one; restore matches that stamp. So a
descendant deleted earlier and separately stays deleted — that is a complete restore of a
different set, not a partial one. Within the set: one transaction, `deletedAt: stamp` as a write
predicate, and a count check. A half-restored subtree is exactly the URL-reachable,
rail-invisible state the subtree rule exists to prevent, and no success message could honestly
describe it.

- [x] **Step 3: Tests**

A deleted page 404s for everyone including an admin, disappears from the nav rail and the
landing counts, and keeps its versions. Descendants go with it. Restore brings back the
subtree. Restore into an occupied path fails with a readable message and changes nothing.

---

## Task 13: Audit wiring, including the Phase 1 debt ✅

**Files:**
- Create: `src/lib/audit/log.ts`, `tests/integration/audit.test.ts`
- Modify: `src/lib/pages/repo.ts`, and — consolidating necessarily touches all five existing
  call sites — `create.ts`, `publish.ts`, `move.ts`, `delete.ts`, plus the guard registration in
  `src/lib/pages/visible.test.ts`

- [x] **Step 1: One `writeAudit` helper, taking the transaction client**

Every mutation in this phase already calls it; this task makes it consistent and tests it
rather than adding it. `AuditClient` is structural, so the five mutations keep passing their
**transaction** client while the access audit passes `db`.

Guarded by a sweep of its own: no module outside `src/lib/audit/log.ts` may touch the
`auditLog` delegate. With a companion test proving the sweep's pattern can see the one file
that does — **a pattern that matches nothing looks exactly like a clean codebase**, which is
the same failure this project's soft-delete guard hit four times.

**Consolidating surfaced a real inconsistency, now fixed.** `page.publish` recorded
`{ from, to }` for a **status** transition while `page.move` recorded `{ from, to }` for a
**path** transition — one key name meaning two things, so `detail->>'from'` was not queryable
across actions. Worse, `move` already named its other pairs `fromSlug`/`toSlug` and
`fromParentId`/`toParentId`, so the bare names were inconsistent with its own scheme. Renamed
to `fromStatus`/`toStatus` and `fromPath`/`toPath`. Cheap now — there are zero audit rows
anywhere and the phase is unreleased — and it would have needed a migration story later.

- [x] **Step 2: Pay off `needsAccessAudit`**

Phase 1 shipped `needsAccessAudit` with tests and no call site, marked `TODO(phase-2)` in
`repo.ts` and recorded as an **accepted risk, not an oversight**: for all of Phase 1, a super
admin reading a `MEMBERS` space they do not belong to left no trace. Wire it now.

It must not slow or fail a read. Write the row on a path that cannot throw into the render —
a failed audit write must not turn a successful read into an error page — but do **not** make
it fire-and-forget in a way that loses rows silently. Log the failure loudly if it happens.

**Those two constraints pull against each other and are met by two mechanisms with two
different jobs**, deliberately not one restated twice (see the "a predicate stated twice is
untestable" finding):

- `after()` from `next/server` is the **latency** mechanism: the write is scheduled after the
  response, so no render awaits a database write mid-stream. It also runs when a render ends in
  `notFound()` or a redirect, which matters — a super admin who resolved the space and then
  missed the page still read the space. Outside a request scope `after()` throws (E468), so
  tests and scripts fall through to an awaited inline write, and that fallback is what makes the
  behaviour observable to a test at all.
- A `try/catch` in the writer is the **resilience** mechanism, and it is the one that fires on a
  real failure. The error line carries the whole row — actor, space, key, visibility — so a lost
  audit is *reconstructable* from logs rather than merely known about.

**Dedupe is per request, per (actor, space).** One page view resolves the space two or three
times (layout, page read, bug context); three identical rows a millisecond apart add no
information and make any rate-based reading of the table meaningless. It stays per *page view*,
so how much a super admin read is still visible. The key is marked **before** the write is
attempted, so a failure is not retried or double-logged inside one request.

**The row carries exactly `{ key, visibility, by: "super-admin" }`**, asserted with `toEqual` —
a later leak arrives as an extra key, which `toMatchObject` would wave through. The page is
deliberately absent: it is genuinely unknown at space-resolution time, and a `pageId` populated
on some renders and null on others is worse than none.

**No seeded path exercises this audit**, and that is worth stating rather than discovering in
Task 14. `efcorporates@gmail.com` is seeded as an **ADMIN member of `engineering`**, so
`needsAccessAudit` is correctly `false` for every seeded combination. The integration tests
cover it against a real database, including the per-request boundary; **e2e and smoke
deliberately do not**, because the alternative is a third seeded space whose only purpose is
this one path, and the `2 spaces / 7 pages` baseline is asserted by the smoke test and dozens
of assertions. The benign corollary: e2e and smoke runs will never accumulate audit rows.

- [x] **Step 3: Tests**

A super admin reading a members-only space they do not belong to writes exactly one row. A
member reading their own space writes none. A super admin reading an `ALL_STAFF` space writes
none.

---

## Task 14: End-to-end coverage of authoring ✅

**Files:**
- Create: `e2e/authoring.spec.ts`
- Modify: `prisma/seed.ts` if a fixture is needed

The suite must stay green from a cold start, and the seed is **idempotent** — re-running it
publishes a version only when content actually differs. Anything this task adds to the seed
must preserve that.

- [x] Create a page, write Markdown, watch it autosave, publish it, read it as a member.
- [x] Preview matches the published output for the same source.
- [x] Two browser contexts on one page: the second save shows the conflict banner naming the
      first editor; Load theirs replaces the text; Keep mine wins.

      **Two identities are available after all.** Task 7 reported "two browser profiles are not
      available, and two tabs share a cookie jar" — true of the browser-automation tooling it
      used for a manual check, **not** of Playwright. `browser.newContext()` is an isolated
      storage partition in the same process, so two contexts hold two different session cookies
      and the server resolves two different people. No scripted second actor needed.
- [x] Move a page; the old URL **308s** to the new one (spec §14 said 301; Task 11 corrected
      the spec, and this bullet still said 301).
- [x] Delete a page; it 404s and leaves the nav rail.
- [x] A `VIEWER` cannot reach `/edit/[pageId]` by URL, and is refused by
      `PUT /api/drafts`, `POST publish` and `POST /api/preview`.

      **The "sees no edit affordance" half was unfalsifiable when written**, and saying so is
      more useful than a green test: there was no reader-to-editor affordance for *anyone*, so
      the absence was universal rather than role-dependent. The seed also has no VIEWER-role
      user. Task 14b adds the affordance; the assertion becomes meaningful there.
- [ ] No editor route scrolls horizontally — the guard that has caught three regressions in
      three different shapes.
- [x] **Pin the redirect lookup's position in the request.** With a dormant `Redirect` sitting
      over a live published page, assert the page renders (200) rather than redirecting away
      from it. Task 11 measured the hoisted-lookup mutation passing the entire vitest suite —
      it is a route property and only an HTTP-level check can catch it.
- [x] **Close the guard's real gap.** It found a fifth shape immediately: a page **title** is
      painted from `Page.title` into `.doc > h1` and repeated as the last breadcrumb, both
      *outside* `.body`, so Task 8's `.body :is(h1…h6)` fix never reached them. Measured at
      1280px with a 300-character title: **4,321px** of overflow, `.doc h1` reporting a 5,295px
      `scrollWidth` inside a 694px box. `min-width: 0` on `.doc` keeps the grid *track* honest
      and does nothing about inline content overflowing the box. No document content could ever
      have exercised it — a title arrives from a text input, not from Markdown.

      Note also what the **editor** overflow loop can and cannot see: `.ed-preview` is
      `overflow: auto` by design, so with all three `doc.css` guards stripped both editor routes
      still measure 0 while the reader shows 2,609px. The editor loop pins the chrome — top bar,
      the split grid's `minmax(0, 1fr)`, CodeMirror's line wrapping — and can never pin `.body`.
      The reader-side injection probe is the load-bearing one.
- [x] **Fix the suite's own leak.** `reader.spec.ts` inserted a real `BugReport` and never
      deleted it — one row per run, forever. It broke nothing, which is why nothing failed; it
      simply made "run the suite twice and compare counts" impossible to pass. Cleanup is now
      **asserted**: `beforeAll` snapshots the dev-database counts and `afterAll` requires them
      unchanged. Add a DOM-injection probe to the reader spec: append an
      `h2`, a `p` and a `pre` each carrying a 300-character unbreakable token, assert zero
      overflow, remove them. Task 8 found a 4,660px reader overflow from a long heading that
      this suite had been green over for the whole of Phase 1, because it only measures seeded
      content. Injecting hostile content writes nothing to the database and tests the class
      the suite claims to test.

---

## Task 14b: Reaching authoring from the product

**Found by Task 14, and it is a scope gap rather than a nit.** `movePage`, `deletePage` and
`restorePage` are library functions with no route and no UI, and `/edit/[pageId]` is unreachable
from the reader — an editor would have to know a page's cuid. So this phase's deliverable, "an
editor creates, drafts, previews and publishes pages in the browser… move and delete with
redirects", is only half true: creating and publishing are reachable (Task 9 added the route and
the button for exactly this reason), moving, deleting and *re-editing* are not.

This lands **before** Task 15, because the smoke test has to exercise move and delete over HTTP.

**Files:**
- Create: `src/app/api/pages/[pageId]/move/route.ts`,
  `src/app/api/pages/[pageId]/delete/route.ts`,
  `src/app/api/pages/[pageId]/restore/route.ts` + their integration tests
- Create: a page-actions component for the editor (move / delete), and a restore affordance for
  an admin
- Modify: the reader route or `PageInfoCard` — an **Edit this page** link, rendered only for a
  viewer with `EDIT`

- [ ] **Step 1: The three routes**

Thin translations of the existing library functions, exactly as `publish/route.ts` is. Every
authorisation decision already lives in the module — do not re-decide anything here, and keep
404-not-403 rendered rather than re-derived. Reuse Task 5's body handling where a body exists.

- [ ] **Step 2: The Edit affordance**

Rendered only when `can(viewer, space, "EDIT")`. This is what makes Task 14's
"a `VIEWER` sees no edit affordance" assertion mean something, so add that test there too.

Note the reader is a server component and the permission is already resolved in its layout —
do not add a second query for it.

- [ ] **Step 3: Move and delete from the editor**

Move needs a target parent and a slug; delete needs a confirmation that names what else goes
with it — deleting a page takes its whole subtree, and an editor who is not told that will find
out afterwards. Restore is `MANAGE_SPACE`, so it belongs to an admin surface, not the editor's.

- [ ] **Step 4: Tests**

Integration tests per route, plus e2e: move a page **through the UI** and follow the 308;
delete a page with a child and see the confirmation name the child; a `VIEWER` sees no Edit
link. Clean up after yourself — the e2e suite asserts the dev-database counts are unchanged.

---

## Task 15: Extend the smoke test

Per the roadmap: *every later phase should extend the smoke test rather than replace it.*

**Files:**
- Modify: `scripts/smoke.sh`

- [ ] Add a cold-start authoring check: sign in as the editor, create a page over HTTP,
      save a draft, publish it, read it back, move it, follow the redirect, delete it, confirm
      404.
- [ ] Clean up everything it creates, the way the bug-report check already does. The dev
      database must be back to 2 spaces / 7 pages / 0 bug reports afterwards.
- [ ] Prove it can fail — break one expectation, confirm a non-zero exit, restore. The exit
      code is the contract, and `npm run smoke | tail` reports tail's status, not the
      script's.

---

## Phase 2 exit criteria

- [ ] `npm test`, `npm run test:e2e`, `npm run smoke` all pass
- [ ] `npm run typecheck && npm run build` clean
- [ ] `npm run plan:check` reports 0 drifted
- [ ] An editor creates, writes, previews, publishes and reads back a page in the browser
- [ ] Concurrent editing produces a conflict banner, and no save is silently lost in either
      direction
- [ ] A moved page's old URL 301s to the new one
- [ ] A deleted page 404s, leaves the nav, and can be restored by an admin with its history
- [ ] A `VIEWER` cannot create, edit, publish, move or delete, and cannot discover a space
      they may not read by attempting any of them
- [ ] A super admin's read of a members-only space they do not belong to writes an audit row
