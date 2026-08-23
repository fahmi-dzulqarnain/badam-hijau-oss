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

## Task 1: Schema for drafts, redirects, audit and soft delete

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a migration under `prisma/migrations/`

- [ ] **Step 1: Add `deletedAt` to `Page`**

```prisma
  deletedAt          DateTime?
```

and an index that matches how it will be queried — every read filters on it alongside the
space:

```prisma
  @@index([spaceId, deletedAt])
```

- [ ] **Step 2: Add the three new models**

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

- [ ] **Step 3: Add the back-relations to `Page`, `PageVersion`, `Space` and `User`**

Prisma requires both sides. Missing one fails `prisma validate` with a clear message, so let
it tell you rather than guessing the names.

- [ ] **Step 4: Migrate**

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

## Task 2: The soft-delete predicate, and a test that notices a query without it

This task is the reason soft delete is affordable. Adding `deletedAt: null` to four queries
is trivial; *keeping* it on every query added over the next four phases is not, and the
failure is silent — a deleted page quietly reappears in a nav rail or a search result.

**Files:**
- Create: `src/lib/pages/visible.ts`, `src/lib/pages/visible.test.ts`
- Modify: `src/lib/pages/repo.ts`
- Modify: `tests/integration/pages-repo.test.ts`

- [ ] **Step 1: Write the predicate, in the same shape as `readableSpace`**

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

- [ ] **Step 2: Apply it to all four queries in `repo.ts`**

`getPublishedPage`, `listSpacePages`, `listRecentlyPublished`, and — indirectly —
`getReadableSpaceByKey`, which queries `Space` and therefore does not need it. Say so in a
comment there, or the next reader will wonder whether it was forgotten.

- [ ] **Step 3: The guard test**

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

- [ ] **Step 4: One integration test per covered query**

Soft-delete a seeded page, then assert it is absent from each. For `getPublishedPage`, assert
`null` rather than a thrown error — the reader route turns that into the same 404 an
unreadable page gets, and the two must stay indistinguishable.

---

## Task 3: Slug and path rules

Pure module, no database. Everything here is a rule the rest of the phase depends on, and all
of it is cheap to test exhaustively.

**Files:**
- Create: `src/lib/pages/slug.ts`, `src/lib/pages/slug.test.ts`

- [ ] **Step 1: `validateSlug(slug)`**

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

- [ ] **Step 2: `childPath(parentPath, slug)`**

Returns `slug` when `parentPath` is null, else `${parentPath}/${slug}`. Phase 1's seed got
this wrong once by deriving from the parent's **slug** rather than its **path**, which is
silently correct two levels deep and wrong at three. Test the three-level case explicitly.

- [ ] **Step 3: `descendantPaths(oldPrefix, newPrefix, path)`**

The pure half of the move: given a path, return what it becomes. Test that
`architecture/mqtt-contracts` moving to `platform/mqtt-contracts` takes
`architecture/mqtt-contracts/topic-registry` with it, and that
`architecture/mqtt-contracts-v2` — a **prefix that is not a path boundary** — is left alone.
That off-by-one is the whole reason this is a tested function rather than a string
concatenation inline in the move.

---

## Task 4: Draft repository and the conflict contract

**Files:**
- Create: `src/lib/drafts/repo.ts`, `src/lib/drafts/conflict.ts`, `src/lib/drafts/conflict.test.ts`
- Create: `tests/integration/drafts-repo.test.ts`

The conflict rule from spec §9, stated precisely because everything else depends on it:
*every save sends the `updatedAt` it last saw; a mismatch returns 409 with the other editor's
name, their timestamp, and both texts; a save is never silently discarded and never silently
overwrites.*

- [ ] **Step 1: The pure decision, separated from the database**

```ts
export type SaveDecision =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "conflict" };

/**
 * `seen` is the `updatedAt` the client last received; `current` is what the row holds now.
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
  if (args.current === null) return { kind: "create" };
  if (args.seen === null) return { kind: "conflict" };
  return args.current.getTime() === args.seen.getTime()
    ? { kind: "update" }
    : { kind: "conflict" };
}
```

Note the third line. A client that sends no `seen` while a draft **does** exist is not a
first save — it is a client that lost track, and the safe answer is a conflict, not an
overwrite. Test that case explicitly; it is the one a naive implementation gets wrong.

- [ ] **Step 2: `saveDraft(viewer, pageId, input)`**

Permission first: `can(viewer, space, "EDIT")`, and a viewer who cannot **read** the space
gets the same `null`/404 an unreadable page gets — never a 403, which would confirm the page
exists. Then apply `decideSave`. On conflict, return the other editor's name, their
`updatedAt`, and both texts, so the API layer does not need a second query to build the 409.

Use an atomic `updateMany` with `updatedAt` in the `where` rather than read-then-write:
two saves arriving together must not both read the same `updatedAt` and both decide "update".
The row count tells you which one lost.

- [ ] **Step 3: Integration tests**

Cover: create; update with the correct `seen`; conflict with a stale `seen`; conflict with a
missing `seen` against an existing draft; a viewer with only `VIEWER` role rejected; a
non-member getting the not-found shape rather than a permission error; and **two concurrent
saves where exactly one wins** — run them with `Promise.all` and assert one succeeded and one
conflicted, rather than asserting on timing.

---

## Task 5: The draft autosave endpoint

**Files:**
- Create: `src/app/api/drafts/[pageId]/route.ts`
- Create: `tests/integration/draft-route.test.ts`

- [ ] **Step 1: `PUT` handler**

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

- [ ] **Step 2: The 409 body**

```ts
{
  error: "conflict",
  theirs: { title, markdown, updatedAt, editorName },
  mine:   { title, markdown },
}
```

Both texts, per the spec. The banner cannot offer "load theirs" without theirs, and cannot
offer "keep mine" without having kept mine somewhere the reload will not destroy.

- [ ] **Step 3: Tests**

201/200 on create and update, 409 on stale, 411 on missing length, 413 on oversized, 404 for
a page in an unreadable space, and a round-trip proving the returned `updatedAt` is what the
next save must send.

---

## Task 6: Creating a page

**Files:**
- Create: `src/app/(editor)/new/page.tsx`, `src/lib/pages/create.ts`
- Create: `tests/integration/page-create.test.ts`

- [ ] **Step 1: `createPage(viewer, { spaceId, parentId, slug, title, docType })`**

In one transaction: validate the slug (Task 3), resolve the parent's path, build the child
path, **reject an occupied path up front** with a field-level message, create the `Page` with
`status: DRAFT` and no `publishedVersionId`, create its `PageDraft`, and write an `AuditLog`
row.

A page created this way is a draft: Phase 1 already renders those as inert text in the nav
rail and 404s them in the reader, so a half-written page is invisible to readers from the
moment it exists. That behaviour is load-bearing here, not incidental.

- [ ] **Step 2: The form**

Space (only spaces where `can(viewer, space, "EDIT")`), optional parent, title, slug
prefilled from the title but editable, doc type. On submit, redirect to `/edit/[pageId]`.

- [ ] **Step 3: Tests**

Slug rejections surface as field errors, not a 500. An occupied path is rejected with a
message naming the conflict. A viewer without `EDIT` in the target space cannot create, and
cannot discover the space exists by trying.

---

## Task 7: The editor

**Files:**
- Create: `src/app/(editor)/edit/[pageId]/page.tsx`, `src/components/Editor.tsx`,
  `src/components/editor.css`
- Modify: `package.json`

- [ ] **Step 1: Install CodeMirror 6**

```bash
npm install codemirror @codemirror/lang-markdown @codemirror/state @codemirror/view
```

- [ ] **Step 2: The client component**

A controlled CodeMirror instance is the part most likely to go wrong. Two rules:

- **Do not recreate the `EditorView` on every render.** Build it once in an effect keyed on
  the page id and dispatch transactions for external changes ("load theirs"). Recreating it
  loses the cursor, the undo history and the scroll position on every autosave tick.
- **Do not round-trip the document through React state on every keystroke.** Keep the text in
  the view and read it when the debounce fires. Autosave every 2 s (spec §9), and also on
  blur, so a closed tab does not lose the last two seconds.

Show save state — `Saving…` / `Saved 14:22` / `Unsaved changes` — and never leave it blank
after a failure; a silent failure that looks like an idle editor is how work gets lost.

- [ ] **Step 3: The conflict banner**

On 409, show the other editor's name and timestamp, with **Keep mine** and **Load theirs**.
Keep mine re-sends with their `updatedAt` as `seen`, so it is an explicit overwrite of a
version the user has been shown. Load theirs dispatches their text into the view. Do not
auto-resolve, and do not dismiss the banner on the next keystroke.

- [ ] **Step 4: Manual verification**

Two browser profiles, same page. Type in both. Confirm: the second save conflicts, the banner
names the first editor, Load theirs replaces the text, Keep mine wins, and no save is lost in
either direction.

---

## Task 8: Server-rendered preview

**Files:**
- Create: `src/app/api/preview/route.ts`
- Modify: `src/components/Editor.tsx`

- [ ] **Step 1: `POST` returning rendered HTML**

Call `renderMarkdown` from Phase 1 — the same function the reader uses, not a copy. The whole
value of this route is that preview and published output cannot disagree.

Requires `EDIT` on the page's space. The route renders arbitrary caller-supplied Markdown, so
without that check it is an open HTML-rendering endpoint for anyone with a session.

- [ ] **Step 2: Wire it in**

Debounced, same 2 s tick as autosave, rendered beside the editor. Reuse `.doc .body` so the
preview inherits the reader's typography, and confirm the preview pane cannot scroll the page
horizontally — the Playwright guard covers reader routes, and this adds a new one.

---

## Task 9: Publishing

**Files:**
- Create: `src/lib/pages/publish.ts`, `src/lib/pages/transition.ts`,
  `src/lib/pages/transition.test.ts`
- Create: `tests/integration/publish.test.ts`

- [ ] **Step 1: The status transition rule, as a pure function**

Phase 3 owns the full per-doc-type vocabularies. Phase 2 needs only: a page may publish into
`CURRENT`, and an already-`ACCEPTED` ADR may not silently revert to `DRAFT`. Write it as a
table so Phase 3 extends the table rather than rewriting the caller.

- [ ] **Step 2: The transaction**

Steps 1–3 and 7 of spec §9, all or nothing, in one `db.$transaction`:

1. Validate the transition and that the draft is not empty.
2. Insert `PageVersion` with the draft's title, markdown and the publisher as author.
3. Update `Page`: `title`, `status`, `publishedVersionId`, `publishedAt`.
4. Delete the `PageDraft` — the published version is now the source, and a draft identical to
   what is published is a confusing thing to reopen.
5. Write `AuditLog`.

Steps 4, 5, 6 and 8 of the spec belong to Phases 3–6 and are **not** stubbed. Leave a
`TODO(phase-N)` at each point so the sequence stays discoverable from the code, the way
Phase 1 marked the audit wiring point.

- [ ] **Step 3: Tests**

Publishing makes the page readable by a member (end to end through `getPublishedPage`, not by
inspecting rows). The draft is gone afterwards. An illegal transition is rejected and
**nothing is written** — assert the version count is unchanged, which is the assertion that
actually tests atomicity. A `VIEWER` cannot publish. Publishing twice in a row from a deleted
draft fails cleanly rather than writing an empty version.

---

## Task 10: Moving a page — the landmine

Re-read the landmine section at the top of this document before starting.

**Files:**
- Create: `src/lib/pages/move.ts`
- Create: `tests/integration/page-move.test.ts`

- [ ] **Step 1: `movePage(viewer, pageId, { newParentId, newSlug })`**

In one transaction, in this order:

1. `pg_advisory_xact_lock` on a hash of the space id.
2. Resolve the new path. **Reject a cycle** — a page cannot move under its own descendant.
   Compute this from the path prefix, not by walking parents, which is a loop waiting to
   happen on data that already has a cycle.
3. Reject an occupied target path up front.
4. One `$executeRaw` rewriting the subtree.
5. Insert a `Redirect` for every old path, and delete any `Redirect` whose `fromPath` equals a
   path now occupied — otherwise moving A→B then B→A leaves a redirect pointing at a live
   page and reads bounce.
6. `AuditLog`.

- [ ] **Step 2: The statement**

```sql
UPDATE "Page"
   SET path = $1 || substring(path from char_length($2) + 1)
 WHERE "spaceId" = $3
   AND ("path" = $2 OR "path" LIKE $4 ESCAPE '\')
```

**`$4` is the old prefix with `%`, `_` and `\` escaped, then `/%` appended.** Slugs allow `-`
and digits but a future rule change could allow `_`, and `_` is a single-character wildcard in
`LIKE`: unescaped, moving `a_b` would drag `axb` along with it. The `ESCAPE` clause and the
escaping are one decision, not two.

- [ ] **Step 3: Tests, including the two shapes the probe distinguished**

- A subtree move rewrites every descendant, verified three levels deep.
- A sibling **swap** is rejected up front rather than attempted — assert the error, and assert
  both paths are unchanged.
- A move onto an occupied path is rejected with both paths intact.
- A page cannot move under its own descendant.
- `a/b_c` is not dragged along when `a/b` moves, and `mqtt-contracts-v2` is not dragged when
  `mqtt-contracts` moves.
- Two concurrent moves in one space serialise: run with `Promise.all`, assert both complete
  and the tree is consistent, rather than asserting on order.

---

## Task 11: Redirects in the reader

**Files:**
- Modify: `src/app/(reader)/[space]/[...path]/page.tsx`, `src/lib/pages/repo.ts`
- Modify: `tests/integration/pages-repo.test.ts`

- [ ] **Step 1: `resolveRedirect(viewer, spaceId, path)`**

On a read miss, look up `(spaceId, fromPath)`. Return the target only when the viewer may read
the space **and** the target is not soft-deleted — a redirect must not become a way to learn
that a page exists somewhere you cannot read, and it must not deliver you to a deleted page.

- [ ] **Step 2: 301, one hop only**

Spec §14: *old path resolves via `Redirect`, 301 to the new path*. Resolve exactly one hop. A
chain is a bug in the move (step 5 above prevents it), and following chains turns that bug
into an infinite loop in production instead of a wrong answer in a test.

- [ ] **Step 3: Tests**

Old path 301s to the new one. A redirect into an unreadable space 404s rather than revealing
the target. A redirect to a soft-deleted page 404s. No redirect chain is followed.

---

## Task 12: Soft delete and restore

**Files:**
- Create: `src/lib/pages/delete.ts`
- Create: `tests/integration/page-delete.test.ts`

- [ ] **Step 1: `deletePage(viewer, pageId)`**

Requires `EDIT`. Sets `deletedAt` on the page **and every descendant** in one statement —
leaving children visible under a deleted parent produces pages reachable by URL with a broken
breadcrumb. Writes a `Redirect` from the deleted path to the parent, so an existing link lands
somewhere useful rather than on a 404. `AuditLog`.

- [ ] **Step 2: `restorePage(viewer, pageId)`**

Requires `ADMIN`. Clears `deletedAt` on the page and its descendants — but **only if the path
is still free**. Something else may have been created there in the meantime, and the unique
index will refuse; catching that as a clear message beats surfacing a constraint violation.

- [ ] **Step 3: Tests**

A deleted page 404s for everyone including an admin, disappears from the nav rail and the
landing counts, and keeps its versions. Descendants go with it. Restore brings back the
subtree. Restore into an occupied path fails with a readable message and changes nothing.

---

## Task 13: Audit wiring, including the Phase 1 debt

**Files:**
- Create: `src/lib/audit/log.ts`, `tests/integration/audit.test.ts`
- Modify: `src/lib/pages/repo.ts`

- [ ] **Step 1: One `writeAudit` helper, taking the transaction client**

Every mutation in this phase already calls it; this task makes it consistent and tests it
rather than adding it.

- [ ] **Step 2: Pay off `needsAccessAudit`**

Phase 1 shipped `needsAccessAudit` with tests and no call site, marked `TODO(phase-2)` in
`repo.ts` and recorded as an **accepted risk, not an oversight**: for all of Phase 1, a super
admin reading a `MEMBERS` space they do not belong to left no trace. Wire it now.

It must not slow or fail a read. Write the row on a path that cannot throw into the render —
a failed audit write must not turn a successful read into an error page — but do **not** make
it fire-and-forget in a way that loses rows silently. Log the failure loudly if it happens.

- [ ] **Step 3: Tests**

A super admin reading a members-only space they do not belong to writes exactly one row. A
member reading their own space writes none. A super admin reading an `ALL_STAFF` space writes
none.

---

## Task 14: End-to-end coverage of authoring

**Files:**
- Create: `e2e/authoring.spec.ts`
- Modify: `prisma/seed.ts` if a fixture is needed

The suite must stay green from a cold start, and the seed is **idempotent** — re-running it
publishes a version only when content actually differs. Anything this task adds to the seed
must preserve that.

- [ ] Create a page, write Markdown, watch it autosave, publish it, read it as a member.
- [ ] Preview matches the published output for the same source.
- [ ] Two browser contexts on one page: the second save shows the conflict banner naming the
      first editor; Load theirs replaces the text; Keep mine wins.
- [ ] Move a page; the old URL 301s to the new one.
- [ ] Delete a page; it 404s and leaves the nav rail.
- [ ] A `VIEWER` sees no edit affordance and cannot reach `/edit/[pageId]` by URL.
- [ ] No editor route scrolls horizontally — the guard that has caught three regressions in
      three different shapes.

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
