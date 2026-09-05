import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { visiblePage } from "@/lib/pages/visible";

/**
 * The soft-delete guard.
 *
 * A missing `deletedAt` filter is invisible until a deleted page reappears in someone's nav
 * rail, so the filter cannot be left to reviewer attention. This file fails when a query on
 * `Page` exists anywhere in `src/` without a soft-delete test behind it.
 *
 * This guard has been too narrow **four times**, each time silently, and the widening history
 * is the useful part:
 *
 * 1. It enumerated one module's exports. `saveDraft` in `src/lib/drafts/repo.ts` queries
 *    `Page` from a different module and was invisible. → became a filesystem sweep.
 * 2. The sweep matched `db.page.*`. `createPage` does every query as `tx.page.*` inside an
 *    interactive transaction and contains **zero** `db.page.` tokens. → matches both.
 * 3. A fence-level lesson from the same family: a bin reported only as a count is where
 *    staleness hides.
 * 4. `resolveRedirect` queries **`Redirect`** and reaches `Page` only through a relation
 *    filter, so no `page` delegate token appears anywhere. The sweep could not see it at all;
 *    only the per-module enumeration caught it, and that works solely because it happens to
 *    live in an already-registered module. A *new* module doing relation-filtered `Page` reads
 *    would have been invisible to both halves.
 *
 * So the sweep now matches **any Prisma delegate call**, not just `page`. Every module in
 * `src/` that talks to the database must be registered — those that cannot reach a `Page` row
 * declare `reachesPage: false` with a reason, which is one line and makes the claim reviewable
 * instead of absent.
 *
 * The generalisation, stated once for whoever writes the next guard: **name the thing you are
 * protecting, not the syntax you expect it to be written in.**
 */

const SRC = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = join(SRC, "..");

/**
 * Any Prisma delegate call, on any model, through either the client or a transaction client —
 * **or a raw statement**.
 *
 * Deliberately not `page`-specific: a query on `Redirect`, `PageVersion` or `PageDraft` can
 * reach `Page` rows through a relation filter without ever naming the `page` delegate, and
 * one already did.
 *
 * The raw alternative is the **fifth** widening, found by Task 8 rather than by a bug: a
 * `$queryRaw`/`$executeRaw` reads and writes `Page` rows while naming no delegate at all, so a
 * module whose only database access is raw SQL was invisible here. Every such module today
 * (`create`, `move`, `delete`, `publish`) also makes a delegate call and so was registered by
 * accident, which is the shape this guard has been caught in four times before. Task 8's
 * `lockPagesForCascade` is a raw `SELECT … FOR UPDATE` on `Page`, so this time the category
 * was closed before it hid anything.
 *
 * The two alternatives end differently, which is not an oversight: a delegate call is always
 * `(`-terminated, while `$queryRaw` is a **tagged template** and is followed by a backtick or a
 * type argument. Requiring `(` after both — the first version of this pattern — matched no raw
 * statement in the codebase, and the test below is why that lasted one run instead of a phase.
 *
 * **`new PrismaClient` is the sixth widening**, and Phase 5 Task 6 is what needed it. Both
 * alternatives above are anchored on the *names* `db` and `tx`, so a module that constructs its
 * own client and calls it anything else is invisible to them — and `src/lib/git/worker.ts` does
 * exactly that: its working-tree advisory lock has to live on a pinned connection, so it makes a
 * one-connection client called `holder` and runs `pg_advisory_lock` on it. That module happens to
 * make ordinary `db.` calls too and so would have been registered **by accident**, which is the
 * shape this guard has now been caught in five times. Naming the client construction closes the
 * category instead of the instance. It also pulls `src/lib/db.ts` into the registry, which is
 * right: the module that owns the connection is the one place a reader looks for it.
 */
const PRISMA_QUERY =
  /\b(?:db|tx)\.(?:[a-z]\w*\.[a-z]\w*\(|\$(?:query|execute)Raw(?:Unsafe)?\b)|\bnew PrismaClient\b/;

function sweepForPrismaQueries(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sweepForPrismaQueries(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      if (PRISMA_QUERY.test(readFileSync(full, "utf8"))) found.push(relative(ROOT, full));
    }
  }
  return found;
}

/**
 * Every module that queries `Page`, with the exported readers each one owns.
 *
 * `covered` means "a test somewhere proves this excludes soft-deleted rows".
 * `exempt` means "this does not read Page rows, and here is why" — listed rather than omitted,
 * because an omission reads as an oversight.
 */
type Registration =
  /** Reads `Page` rows, so every exported reader needs a soft-delete test. */
  | { load: () => Promise<Record<string, unknown>>; covered: string[]; exempt: string[] }
  /** Queries the database but cannot reach a `Page` row, directly or through a relation. */
  | { reachesPage: false; why: string };

const MODULES: Record<string, Registration> = {
  "src/lib/attachments/sweep.ts": {
    reachesPage: false,
    why:
      "Queries `Attachment` alone, by its own `state`, `deletedAt` and `createdAt`. No `Page` " +
      "row is read, selected or filtered — not through a delegate and not through a relation " +
      "filter, which is the shape this guard was widened for the fourth time. Its deletes are " +
      "never conditioned on page visibility, deliberately: retention is not a permission " +
      "question, and `readableAttachment` in repo.ts is what is registered for the read path " +
      "that IS one.",
  },
  "src/lib/attachments/repo.ts": {
    load: () => import("@/lib/attachments/repo"),
    // Soft-delete tests: tests/integration/attachments-repo.test.ts —
    //   `readableAttachment` reaches `Page` ONLY through a relation filter — no `page`
    //   delegate token appears anywhere in the module. Exactly the shape widening #4 was
    //   written for. "SOFT-DELETING THE PAGE hides its attachments, and restoring it brings
    //   them back" covers it: soft-deleting the page hides the attachment, and undoing that
    //   brings it back.
    //   `beginUpload`, `commitUpload` and `softDeleteAttachment` each restate their own
    //   `visiblePage()` on their own query, covered respectively by "beginUpload answers
    //   not-found for an unreadable page", "commitUpload re-checks EDIT rather than trusting
    //   beginUpload's check", and "a VIEWER cannot soft-delete, and the refusal does not
    //   disturb the row" (the last of which also pins that `updateMany` puts the predicate in
    //   the write, not a read the write then trusts).
    covered: ["readableAttachment", "beginUpload", "commitUpload", "softDeleteAttachment"],
    exempt: [],
  },
  "src/lib/pages/repo.ts": {
    load: () => import("@/lib/pages/repo"),
    // Soft-delete tests: tests/integration/pages-repo.test.ts —
    //   `resolveRedirect` is the odd one here: it queries `Redirect`, not `Page`, so the
    //   filesystem sweep below cannot see it at all — no `db.page.*` token appears in it.
    //   What catches it is the per-module enumeration: it is an export of a registered
    //   module, so the next test fails until it is listed. That is worth saying out loud,
    //   because it is the fourth time in this project the sweep has been too narrow, and
    //   this time the narrowness is by design — a query that reaches `Page` only through a
    //   relation filter (`toPage: visiblePage(...)`) is invisible to any regex looking for
    //   the delegate. Its soft-delete test is "a redirect to a soft-deleted page 404s
    //   instead of delivering the reader to it".
    covered: [
      "getPublishedPage",
      "listSpacePages",
      "listRecentlyPublished",
      "resolveRedirect",
    ],
    // Queries Space, which has no `deletedAt`.
    exempt: ["getReadableSpaceByKey"],
  },
  "src/lib/pages/create.ts": {
    load: () => import("@/lib/pages/create"),
    // Soft-delete tests: tests/integration/page-create.test.ts —
    //   "a soft-deleted parent cannot be used as a parent" covers the parent lookup, which
    //   carries `visiblePage()` like every other read here;
    //   "a path held by a soft-deleted page is refused, naming it" covers the collision
    //   check, which deliberately does NOT — the unique index does not know about
    //   `deletedAt`, so a filtered check would pass and the insert would fail. Registered as
    //   `covered` rather than `exempt` because both halves are pinned by a test; the second
    //   one pins the *absence* of the filter, which is the part a future reader would
    //   otherwise "fix".
    covered: ["createPage"],
    // Queries Space, which has no `deletedAt`.
    exempt: ["listEditableSpaces"],
  },
  "src/lib/pages/editable.ts": {
    load: () => import("@/lib/pages/editable"),
    // Soft-delete tests: tests/integration/page-editable.test.ts —
    //   "a soft-deleted page is not editable, and reads as not-found" covers the read, and
    //   "a super admin still cannot open a soft-deleted page" pins that the permission
    //   bypass is not also a soft-delete bypass. The two predicates are independent and the
    //   one viewer who skips the first must not skip the second.
    //
    //   `canEditPage` is the preview endpoint's authorisation and carries the same two
    //   predicates on its own query rather than borrowing them:
    //   "a soft-deleted page cannot be previewed either" covers the soft-delete filter, and
    //   "canEditPage and getPageForEditing refuse the same viewers for the same reasons"
    //   pins the two answers together so the cheap read cannot quietly become the permissive
    //   one.
    covered: ["getPageForEditing", "canEditPage"],
    exempt: [],
  },
  "src/lib/pages/publish.ts": {
    load: () => import("@/lib/pages/publish"),
    // Soft-delete tests: tests/integration/publish.test.ts —
    //   "a soft-deleted page cannot be published, and reads as not-found" covers the
    //   authorisation read, and "a super admin's publish is not also a soft-delete bypass"
    //   pins that the permission bypass is not also a soft-delete bypass.
    //
    //   The module has a SECOND page query, and it is a write: the `updateMany` that moves
    //   `publishedVersionId` carries `visiblePage()` as a write predicate, so a soft delete
    //   committing mid-transaction matches nothing and the publish rolls back. Covered by
    //   "a soft delete landing mid-publish rolls the whole transaction back", which stages
    //   the interleaving with a held row lock — a filter on a write is invisible to any test
    //   that cannot arrange for the row to change underneath it.
    //
    //   Task 7 added a THIRD and FOURTH query, both writes on `PageRelation` and both keyed
    //   on `fromId` — the page this publish has already authorised under `visiblePage()` and
    //   locked. Neither carries a soft-delete filter on the *target*, in either direction, and
    //   both absences are deliberate and pinned:
    //     the insert cannot reach a deleted page because every `toId` came from
    //     `resolveRelations`, whose own queries carry `visiblePage()` and `readableSpace` and
    //     which is registered separately above. Covered here by "a relation naming a
    //     soft-deleted page is refused, and the publish writes nothing", which fails if that
    //     resolution ever stops filtering — a deleted target would become a stored relation
    //     and Task 8's cascade would go on to set a status on it;
    //     the delete deliberately does not filter the target, because a relation pointing at a
    //     page that has since been deleted must still be removable by an author who drops the
    //     key — otherwise the frontmatter could never be brought back into agreement with the
    //     database. Covered by "a relation to a page that was deleted afterwards can still be
    //     removed by republishing without it".
    //   Restating `visiblePage()` on either write would be the `resolveRedirect` mistake: a
    //   predicate stated twice is a predicate neither statement can be tested for.
    //
    //   Task 8 added a FIFTH and SIXTH, both about the cascade, and one of them is the reason
    //   the sweep pattern above grew a raw alternative:
    //     `lockPagesForCascade` is a raw `SELECT … FOR UPDATE` on `Page` and deliberately does
    //     NOT filter `deletedAt`. It takes locks and reads statuses; a target soft-deleted
    //     while this transaction waited is caught by the write below rather than by a second
    //     copy of the filter here. Pinned by "a soft delete of the cascade target landing
    //     mid-publish rolls the whole transaction back", which fails if the *write* stops
    //     filtering — the locking read alone would happily hand back the deleted row;
    //     `applyCascade`'s `updateMany` carries `visiblePage()` as a write predicate, plus
    //     `spaceId` as a shape constraint rather than a permission predicate — the cascade's
    //     authorization is the `PUBLISH` check already made on the source's space, argued in
    //     full at `applyCascade`, and restating it here is what could not be tested. The same
    //     staged test covers the filter; "a relation naming a page in another space is refused,
    //     and that page is not cascaded" covers the space bound from the resolution side.
    covered: ["publishPage"],
    exempt: [],
  },
  "src/lib/pages/move.ts": {
    load: () => import("@/lib/pages/move"),
    // Soft-delete tests: tests/integration/page-move.test.ts. This module has five page
    // queries and they do not all carry the filter, which is the point of listing them:
    //   "a soft-deleted page cannot be moved, and reads as not-found" and "a super admin's
    //   move is not also a soft-delete bypass" cover the authorisation read and the re-read
    //   under the lock;
    //   "a soft-deleted page cannot be used as a parent" covers the parent lookup;
    //   "a move onto a path held by a soft-deleted page names it and points at restore"
    //   covers the collision check, which deliberately does NOT filter — the unique index
    //   does not know about `deletedAt`, so a filtered check would pass and the rewrite
    //   would fail;
    //   "a soft-deleted descendant is rewritten with the subtree" and "a subtree with a
    //   soft-deleted descendant can move away and back" cover the subtree read, which also
    //   deliberately does not filter: a stranded soft-deleted row holds a path its parent no
    //   longer has, and moving the subtree back collides with it.
    //
    //   The module also has a page *write*: the `updateMany` that moves `parentId` and `slug`
    //   carries `visiblePage()` as a write predicate, so a soft delete committing
    //   mid-transaction matches nothing and the move rolls back. Covered by "a soft delete
    //   landing mid-move rolls the whole transaction back", which stages the interleaving
    //   with a held row lock — a filter on a write is invisible to any test that cannot
    //   arrange for the row to change underneath it.
    covered: ["movePage"],
    exempt: [],
  },
  "src/lib/pages/delete.ts": {
    load: () => import("@/lib/pages/delete"),
    // Soft-delete tests: tests/integration/page-delete.test.ts. This module is the one place
    // in the codebase whose job is to *write* the predicate every other query reads, so its
    // queries split cleanly into two groups and both need naming.
    //
    // `deletePage`'s reads all carry `visiblePage()` and each has a test:
    //   "a super admin cannot delete an already-deleted page" covers the authorisation read
    //   and the re-read under the lock, and pins that the permission bypass is not also a
    //   soft-delete bypass;
    //   "deleting a root page writes no redirect, and its URL 404s" covers the surviving-parent
    //   read from the other side — a deleted parent is not a surviving one, so the branch a
    //   missing `visiblePage()` would take is the branch that writes redirects to a page that
    //   404s.
    //   The subtree read deliberately does NOT filter, in both functions: it has to see
    //   deleted rows to know which ones it is *not* responsible for. Covered by "a descendant
    //   deleted earlier and separately is not restored with the subtree", which fails in both
    //   directions — filtered out, the earlier row is re-stamped and resurrected.
    //
    // `restorePage` is the one reader in Phase 2 that is looking **for** a soft-deleted row, so
    // its page reads carry `readableSpace` and deliberately not `visiblePage()`. Registered as
    // `covered` rather than `exempt` because the absence is pinned rather than merely allowed:
    //   "restore brings back the whole subtree, where it was" fails outright if the read
    //   excludes deleted rows — there would be nothing to restore;
    //   "restoring a page that is not deleted says so rather than reporting a miss" pins the
    //   explicit `deletedAt === null` branch that replaces the filter;
    //   "restoring under a still-deleted ancestor is refused" covers the ancestor read, which
    //   inverts the filter (`deletedAt: { not: null }`) for the same reason;
    //   "a stranger cannot delete or restore" pins that dropping the soft-delete filter did not
    //   take the permission predicate with it.
    //
    // `listDeletedPages` (Task 14b) is the third function here whose job is to return
    // soft-deleted rows, and the only one that returns *nothing else*. Its page query carries
    // `readableSpace` and inverts the filter to `deletedAt: { not: null }`:
    //   "the deleted list holds only deleted pages" fails in both directions — dropped, every
    //   live page in the space appears in the restore list, which is a titles listing wearing
    //   the wrong label; inverted to `deletedAt: null`, the list is empty and there is nothing
    //   to restore;
    //   "an editor cannot list deleted pages, and is told who can" pins that inverting the
    //   soft-delete filter did not take the permission predicate with it — the same pairing
    //   `restorePage` needs, because these two are one screen and one authorisation;
    //   "a stranger cannot list deleted pages" pins the space-level not-found, which is what
    //   stops the list leaking titles out of a space the caller cannot read.
    covered: ["deletePage", "restorePage", "listDeletedPages"],
    exempt: [],
  },
  "src/lib/pages/review.ts": {
    load: () => import("@/lib/pages/review"),
    // Soft-delete tests: tests/integration/review.test.ts. Phase 7 Task 4's due-for-review list
    // and spec §12's confirmation. THREE page queries, and they do not all carry the same things
    // — which is why they are listed rather than the module:
    //   `listDueForReview`'s `findMany` and its `count` share ONE `dueScope()` call, which owns
    //   `visiblePage()`, `readableSpace` as the `space` relation filter, the published-page bound
    //   and §12's staleness `OR`. One builder, deliberately, and it is the divergence
    //   `src/lib/systems/read.ts` argued for against `index-read.ts`: with the filter dropped
    //   from the aggregate alone, the list is right and the "N pages are due" line beside it
    //   counts pages nobody can open. Covered by "a soft-deleted page is not due for review,
    //   having been", which fails in both directions because its first half is the non-vacuity
    //   companion, and by "two viewers, two spaces, two different due lists" for the permission
    //   predicate — a discrimination and not an absence, because a viewer with no readable space
    //   gets an empty list from an unfiltered query too;
    //   `confirmReview` makes a read and a WRITE, and both carry `visiblePage()`. That is two
    //   statements of one filter, which is the `resolveRedirect` shape — so both were mutated,
    //   and the finding is recorded here because the obvious test does not separate them:
    //     the write's is covered by "a soft delete landing mid-confirm writes nothing and reads
    //     as not-found", staged with a held row lock, because a predicate on an `updateMany` is
    //     invisible to any test that cannot change the row underneath it;
    //     the read's is NOT covered by "a soft-deleted page cannot be confirmed, and reads as
    //     not-found" — measured, that test stays green with the read's filter deleted, because
    //     the write's predicate then produces the identical answer. What separates them is §8:
    //     without the filter the deleted row is read, `mayConfirmReview` runs against it, and a
    //     non-owner is told **forbidden** — a soft-deleted page answering a question about
    //     itself. "a soft-deleted page reads as not-found even for a viewer who could not confirm
    //     it" is the test that kills it, and it is the only one that does.
    //
    //   `readableSpace` is restated on the write as well, and that one **is** an equivalent
    //   mutant: deleting it leaves the whole file green, because the read already refused every
    //   viewer it would refuse. Reported in the module rather than pinned by a manufactured test,
    //   per this project's rule, and kept for consistency with `publish.ts`, `move.ts` and
    //   `delete.ts`, which all restate both predicates on their writes.
    //
    //   No query here filters on `ownerId`, and that absence is deliberate: ownership is a
    //   permission question answered in memory by `mayConfirmReview`, on a row the queries above
    //   have already bounded. A `where` clause on `ownerId` would make the refusal untestable by
    //   turning it into a not-found.
    covered: ["listDueForReview", "confirmReview"],
    // Pure. `reviewIntervalMonths` reads a literal environment, `reviewCutoff` is date
    // arithmetic, and `mayConfirmReview` compares an owner id and calls `can()` — none of them
    // touches the database, and all three are exported because they are asserted directly in
    // src/lib/pages/review.test.ts.
    exempt: ["reviewIntervalMonths", "reviewCutoff", "mayConfirmReview"],
  },
  "src/lib/pages/history.ts": {
    load: () => import("@/lib/pages/history"),
    // Soft-delete tests: tests/integration/page-history.test.ts. Phase 5 Task 7's version
    // history. Three queries, and only the first one names `Page` — which is the point of
    // listing them rather than the module:
    //   the page read carries `visiblePage()` at the top level and `readableSpace` as its
    //   `space` relation filter, and both are covered: "a soft-deleted page has no history, and
    //   reads as not-found" is the soft-delete test, and "a non-member cannot read the history of
    //   a page in a space they cannot read" is the permission one. The second is a
    //   discrimination rather than an absence — the same viewer reads one space and not the
    //   other, and the readable page's rows are counted — because an absence assertion made by a
    //   viewer who can see nothing is near-vacuous, which is what Phase 4's non-member search
    //   turned out to be;
    //   the version read and the `GitJob` aggregate carry **no** predicate of either kind, and
    //   both absences are deliberate: they are keyed on the `pageId` the read above authorised,
    //   in the same function, with nothing caller-supplied in between. A `page: visiblePage(...)`
    //   on either could be deleted with the whole suite green — the `resolveRedirect` shape,
    //   measured twice in this project — so a second copy would make neither testable. What is
    //   pinned instead is that removing the copy that exists changes the answer.
    //
    //   The `GitJob` aggregate is also the reason this module is not `reachesPage: false` on the
    //   strength of its last two queries: it reads rows *about* a page for a reader, so the
    //   question "which pages may this viewer learn the mirror state of" has to be answered
    //   somewhere, and it is answered once, above, by the page read.
    covered: ["listPageVersions"],
    // Pure: folds a `groupBy` result into two numbers. Queries nothing.
    exempt: ["mirrorQueueOf"],
  },
  "src/lib/drafts/repo.ts": {
    load: () => import("@/lib/drafts/repo"),
    // Soft-delete tests: tests/integration/drafts-repo.test.ts
    covered: ["saveDraft"],
    exempt: [],
  },
  "src/lib/lifecycle/resolve.ts": {
    load: () => import("@/lib/lifecycle/resolve"),
    // Soft-delete tests: tests/integration/relation-resolve.test.ts. Three page-reaching
    // queries, and they do not all filter the same way — which is the reason for listing them
    // rather than the module:
    //   `findLive` carries `visiblePage()`, covered by "a reference to a soft-deleted page is
    //   refused" — dropped, a deleted page resolves as a live relation target and Task 8's
    //   cascade would go on to set a status on it;
    //   `findViaRedirect` reaches `Page` only through `toPage: visiblePage(...)` — the shape
    //   the sweep below cannot see at all, and the fourth reason it was widened — covered by
    //   "a redirect to a soft-deleted page does not resolve";
    //   `findDeleted` deliberately does NOT filter: it inverts to `deletedAt: { not: null }`,
    //   because its whole job is to find the deleted row that explains why the other two
    //   missed. Covered by "a reference to a soft-deleted page is refused", which fails in
    //   both directions — inverted the wrong way it reports every live page as deleted — and
    //   by "a stranger cannot tell a deleted page from a missing one", which pins that the
    //   inverted filter did not take the permission predicate with it. That pairing is the
    //   same one `restorePage` and `listDeletedPages` need, and for the same reason: a query
    //   looking for deleted rows is the one place a specific refusal could leak.
    covered: ["resolveRelations"],
    exempt: [],
  },
  "src/lib/lifecycle/read.ts": {
    load: () => import("@/lib/lifecycle/read"),
    // Soft-delete tests: tests/integration/relations-read.test.ts. Task 9's two reads query
    // `PageRelation` and reach `Page` only through a relation filter — `to: visiblePage(...)`
    // and `from: visiblePage(...)` — which is the shape the sweep below cannot see at all and
    // the fourth reason it was widened. Registered here rather than trusted to the sweep:
    //   "a relation to a soft-deleted page is not rendered in either direction" covers both
    //   filters, and it has to name both because they are two separate `visiblePage()` calls on
    //   two different relation fields — dropping one leaves the other's test green;
    //   "a relation to a page in a space the viewer cannot read is absent" covers the
    //   permission predicate, in both directions, and it is why these queries carry NO
    //   `spaceId` shape constraint: scoping them to the page's own space would make
    //   `readableSpace` unfalsifiable here, since the viewer can necessarily read the space of
    //   the page they are reading. See the module docstring.
    covered: ["getPageRelations"],
    exempt: [],
  },
  "src/lib/lifecycle/index-read.ts": {
    load: () => import("@/lib/lifecycle/index-read"),
    // Soft-delete tests: tests/integration/doc-index.test.ts. Task 10's index has TWO page
    // queries and they must agree, which is the reason for listing them rather than the module:
    //   the `findMany` that renders the list carries `visiblePage()`, covered by "a soft-deleted
    //   ADR is absent from the list and from the counts";
    //   the `groupBy` that produces the filter counts carries its own `visiblePage()` — the
    //   same test covers it, and it has to assert both halves because they are two separate
    //   calls: with the filter dropped from the aggregate alone, the list is right and the
    //   `ACCEPTED 3` chip beside it counts a page nobody can open.
    //
    //   Neither page query carries `readableSpace`, and that absence is deliberate and pinned
    //   rather than merely allowed. The predicate is stated once, on the space read above them —
    //   see the module docstring for the argument, which is `resolveRedirect`'s: both page
    //   queries are bounded by `spaceId` to the space verified three lines earlier, so a copy of
    //   the predicate on either of them could be deleted with the whole suite green. Covered by
    //   "a stranger cannot list a space's ADRs, and cannot tell it from an empty space", which
    //   fails the moment the one predicate that exists is removed.
    covered: ["listDocTypePages"],
    exempt: [],
  },
  "src/lib/search/reindex.ts": {
    load: () => import("@/lib/search/reindex"),
    // Soft-delete tests: tests/integration/search-vector.test.ts. Phase 4 Task 2's backfill. It
    // reads `PageVersion` and reaches `Page` only through the `page_search_vector_from_version`
    // trigger — no `Page` row is named anywhere in the module, which is the shape this sweep was
    // widened for and a shape it still cannot see on its own.
    //
    // It carries **no** `visiblePage()` and the absence is pinned rather than merely allowed:
    //   "the reindex covers a soft-deleted page's version too" fails outright if a filter is
    //   added — a page soft-deleted before the backfill would come back from Task 12's restore
    //   searchable by title and nothing else, with nothing saying so. That is the same direction
    //   `move.ts`'s subtree read and `delete.ts`'s subtree read both go, and for the same
    //   reason: a soft-deleted row is a row that is coming back.
    //
    // It also carries no permission predicate. There is no viewer: it is a whole-corpus
    // maintenance pass, it returns two integers and names no page, and the readability question
    // is asked once, at query time, in Task 3.
    covered: ["reindexSearchText"],
    exempt: [],
  },
  "src/lib/search/query.ts": {
    load: () => import("@/lib/search/query"),
    // Soft-delete tests: tests/integration/search-query.test.ts. Phase 4 Task 3's query, and it
    // is the shape this sweep was widened for twice over: the page read is a `$queryRaw`, so no
    // `page` delegate token appears anywhere in the module, and the only delegate call it makes
    // is on `Space`.
    //
    // The soft-delete filter is `p."deletedAt" IS NULL`, written out in SQL rather than composed
    // from `visiblePage()` — which does not compose into raw SQL. That restatement is safe in a
    // way `readableSpace`'s would not be: one column compared to one value, with no branch the
    // two spellings could disagree about. `readableSpace` is a top-level `OR` over a relation, so
    // the space filter is *derived* from it — `db.space.findMany` under the real predicate, ids
    // bound into `spaceId = ANY(...)` — rather than retyped. See the module docstring.
    //
    // Covered by "a soft-deleted page disappears from results, having been in them", which fails
    // in both directions: the "before" half is the non-vacuity companion, so a filter that
    // excluded everything would fail it too. The permission predicate has its own test, "a
    // non-member does not find a page whose text certainly matches", and it is the one the plan
    // singles out — a page whose text certainly matches, in a space the viewer cannot read.
    covered: ["search"],
    // Pure string splitting on the `ts_headline` delimiters. Exported for its own unit
    // assertions — an unbalanced delimiter must not lose text — and it queries nothing.
    exempt: ["segmentsOf"],
  },

  // Query the database but cannot reach a Page row. Declared rather than omitted: an omission
  // reads as an oversight, and this claim is the sort a reviewer can check in one line.
  "src/lib/lifecycle/relations.ts": {
    reachesPage: false,
    why:
      "walks the supersede graph over PageRelation and selects `toId` — no Page row, directly " +
      "or through a relation filter. It is blind to page state on purpose, and the absence is " +
      "pinned rather than merely allowed: tests/integration/relation-guardrails.test.ts, 'a " +
      "cycle through a soft-deleted page is still refused'. Filtering the walk to live pages " +
      "would need a join to `Page` and would admit exactly the cycles that matter — a " +
      "soft-deleted page can be restored, relations are only checked at publish time, and a " +
      "loop hidden behind one would never be looked at again. Every page it reads about was " +
      "already resolved through `resolveRelations`' readable queries, or is joined to the " +
      "source page by relation rows a publish in that space wrote; no page identity leaves " +
      "the module.",
  },
  "src/lib/git/enqueue.ts": {
    reachesPage: false,
    why:
      "writes GitJob and reads nothing. Phase 5 Task 4: the one delegate call is " +
      "`tx.gitJob.createMany`, on a client its caller supplies, and every column of every row " +
      "is a value the caller already read under its own lock — a `pageId` and a `path` are " +
      "passed in, never looked up. There is no `Page` query to filter, directly or through a " +
      "relation, so the module is registered here rather than as `covered`. " +
      "That absence is the design and not an accident, and the reason is `restorePage`: it " +
      "enqueues for pages whose `deletedAt` was set a statement ago, so it is the one caller " +
      "in this codebase for which a soft-delete filter would be the bug rather than the " +
      "guard — a version of this module that read `Page` would need a deliberately " +
      "`deletedAt`-blind query, the argument for it, and a test, exactly as `restorePage`, " +
      "`listDeletedPages` and `findDeleted` each carry one. Reading nothing is what makes all " +
      "three unnecessary. The insert does take a foreign-key `KEY SHARE` lock on the `Page` " +
      "row, which is not a read: it returns no column and applies no predicate, and the row it " +
      "names is the row the caller has already authorised and written.",
  },
  "src/lib/systems/resolve.ts": {
    reachesPage: false,
    why:
      "reads System and writes PageSystem, and reaches no Page row — Phase 7 Task 2. Three " +
      "statements: one `tx.system.findMany` on `key`, plus a `tx.system.findMany` for the " +
      "catalogue listing on the refusal path, and `tx.pageSystem.deleteMany`/`createMany` keyed " +
      "on the `pageId` its caller passes in. No `Page` row is read, selected or filtered — not " +
      "through a delegate and not through a `page:` relation filter, which is the shape this " +
      "guard was widened for the fourth time. The page id is never looked up: `publishPage` has " +
      "already authorised that row under `visiblePage({ space: readableSpace(viewer) })` and " +
      "locked it, and a `visiblePage()` restated on these writes would be the `resolveRedirect` " +
      "mistake — a predicate stated twice with neither copy testable. That absence is also why " +
      "a soft delete arriving mid-publish still rolls these rows back: the predicate lives on " +
      "the `Page` `updateMany` above the call, whose zero row count throws. Same registration " +
      "and same argument as `src/lib/git/enqueue.ts`, including the FK `KEY SHARE` locks the " +
      "insert takes on the `Page` and `System` rows — which are not reads: they return no " +
      "column and apply no predicate. `System` itself has no `deletedAt`, no `spaceId` and no " +
      "`visibility` (spec §7: systems carry no permissions of their own), so there is no " +
      "permission predicate to state either.",
  },
  "src/lib/spaces/admin.ts": {
    load: () => import("@/lib/spaces/admin"),
    // Soft-delete tests: tests/integration/spaces-admin.test.ts. Phase 7 Task 6's `/admin/spaces`,
    // and the registration is `src/lib/systems/admin.ts`'s shape — **this module reads `Page` rows
    // with NO soft-delete filter, deliberately**, so what is registered is the *absence*.
    //
    //   `listSpacesForAdmin` and `updateSpace` both reach `Page` through a `_count` on the
    //   relation. No `page` delegate token appears anywhere in the module, which is the shape
    //   widening #4 was written for — and a `_count` is easy to read past, because it looks like a
    //   number rather than like a query.
    //
    //   `visiblePage()` on that count would be WRONG, not merely redundant, and the two exports
    //   need it wrong for the same reason. The count is what refuses a key rename, and the rule it
    //   enforces is "this space has published URLs and mirror files under this key". A soft delete
    //   undoes neither: the URL was shared, the file was written, and `restorePage` brings both
    //   back. Filtering would let a space whose every page had been deleted be renamed, stranding
    //   `content/<old-key>/` the moment one of them was restored. Covered by "a soft-deleted page
    //   still counts, and still refuses a rename", which asserts the refusal AND that the count in
    //   the sentence equals the row's, with a live page in the same assertion as the non-vacuity
    //   companion.
    //
    //   `readableSpace` is absent from the whole module and would be inert AND wrong — the
    //   `resolveRedirect` shape (`readableSpaceWhere` answers `{}` for the only viewer that gets
    //   past the gate), and wrong because an installation's administration that cannot see a
    //   `MEMBERS` space nobody added the admin to is a surface with a blind spot over a space
    //   nobody could then administer. `can(viewer, space, "MANAGE_SPACE")` is not the alternative
    //   either, and here it is *circular*: the membership rows this module writes are what `can()`
    //   reads, so a space with no ADMIN — which `createSpace` produces every time — would be one
    //   nobody could ever add a member to.
    //
    //   The permission predicate for the whole module is `refuseNonAdmin` in
    //   `src/lib/admin/gate.ts`, swept for in `src/lib/admin/gate.test.ts` and mutation-verified in
    //   both directions by "a space ADMIN is refused by every entry point, and the super admin is
    //   not" — the discriminating viewer is an ADMIN of a real space, not a stranger.
    //
    //   The audit line is the container versus what is inside it: the space list writes nothing,
    //   and naming the people in a private space writes `space.access`. Covered by "listing the
    //   members audits a MEMBERS space and not an ALL_STAFF one", a discrimination between two
    //   spaces read by one viewer rather than an absence.
    covered: ["listSpacesForAdmin", "updateSpace"],
    // `Space`, `SpaceMembership` and `User` only. None has a `deletedAt`; membership IS the
    // permission predicate rather than something filtered by one, and `listSpaceMembers` states
    // its own audit rather than its own filter.
    exempt: [
      "createSpace",
      "listSpaceMembers",
      "addSpaceMember",
      "setSpaceMemberRole",
      "removeSpaceMember",
    ],
  },
  "src/lib/systems/admin.ts": {
    load: () => import("@/lib/systems/admin"),
    // Soft-delete tests: tests/integration/systems-admin.test.ts. Phase 7 Task 5's `/admin/systems`,
    // and the entry here is a different shape from every other one in this file: **this module
    // reads `Page` rows with NO soft-delete filter, deliberately**, so what is registered is the
    // *absence* — the same standing as `src/lib/git/worker.ts` above.
    //
    //   `listBlockingPages` reaches `Page` through a `page:` relation filter on `PageSystem` — no
    //   `page` delegate token appears anywhere in the module, which is the shape widening #4 was
    //   written for. It carries neither `visiblePage()` nor `readableSpace`, and both absences
    //   change what it returns rather than being conveniences:
    //     `visiblePage()` would be WRONG here. `PageSystem.pageId` cascades from `Page` and this
    //     product has no hard delete, so a soft-deleted page keeps its facet row and keeps
    //     blocking `PageSystem.systemId`'s `Restrict`. Hiding it would make this list name fewer
    //     pages than the refusal counts — an admin hunting a blocker that had been filtered out of
    //     their view. Covered by "a soft-deleted page still blocks, is listed, and is flagged",
    //     which asserts the flag AND that the list's length equals the refusal's count, with a
    //     live page in the same assertion as the non-vacuity companion.
    //     `readableSpace` would be inert AND wrong: inert because `readableSpaceWhere` answers
    //     `{}` for a super admin, which is the only viewer that reaches the query (the
    //     `resolveRedirect` shape — a filter no test can be written against), and wrong because a
    //     page in a space this admin is not a member of blocks the delete exactly as hard as one
    //     they can read.
    //
    //   The permission predicate for the whole module is `refuseNonAdmin` in
    //   `src/lib/admin/gate.ts`, stated once for every `/admin` surface there will be and swept
    //   for in `src/lib/admin/gate.test.ts`. It is mutation-verified in both directions by "a
    //   space ADMIN is refused by every entry point, and the super admin is not" — the
    //   discriminating viewer is an ADMIN of a real space, not a stranger, because a member of
    //   nothing is refused by any predicate at all.
    //
    //   The cross-boundary read is audited and the count is not, which is Task 1's line:
    //   "showing the number needs no audit; showing the titles does". Covered by "listing the
    //   blocking pages audits the spaces it read; the count alone audits nothing" — a
    //   discrimination between two calls by one viewer, not an absence.
    covered: ["listBlockingPages"],
    // `System` alone. That table has no `deletedAt`, no `spaceId` and no `visibility` — §7 makes
    // a system global and permissionless — so there is neither a soft-delete filter nor a space
    // predicate to state, which is the same claim `src/lib/systems/resolve.ts` is registered on.
    // `deleteSystem` reads `PageSystem` for a count on its refusal path and touches no `Page`
    // column; the rows it counts are the ones the foreign key already refused over.
    exempt: ["listSystemsForAdmin", "createSystem", "updateSystem", "deleteSystem"],
  },
  "src/lib/systems/read.ts": {
    load: () => import("@/lib/systems/read"),
    // Soft-delete tests: tests/integration/systems-read.test.ts. Phase 7 Task 3's two reads, and
    // this is the first module in the project whose page query is **not** bounded to one space —
    // §7's system page aggregates across every space the viewer can read, by design — so what is
    // registered here is a different shape from every entry above it.
    //
    // `getSystemDocumentation` makes TWO page queries: the `findMany` behind the list and the
    // `groupBy` behind the counts. Both get their `where` from one `pageScope()` call rather than
    // each stating the predicates again, which is deliberate and is the one place this module
    // diverges from `index-read.ts`: that module's registration has to say its two halves are
    // asserted separately because "with the filter dropped from the aggregate alone, the list is
    // right and the chip beside it counts a page nobody can open". One builder makes that
    // divergence unrepresentable — there is exactly one place either predicate can be deleted.
    //
    //   `visiblePage()` owns the top level of that scope, covered by "a soft-deleted page
    //   disappears from a system's page, having been on it" — which fails in both directions,
    //   because its first half is the non-vacuity companion.
    //
    //   `readableSpace` is nested as the `space` relation filter and is NOT derived the way
    //   `src/lib/search/query.ts` derives it; that derivation is a raw-SQL workaround with a
    //   stated cause, and these queries are Prisma. Covered by "two viewers, one URL, two
    //   different lists", which is a **discrimination and not an absence**: both viewers see
    //   something, neither sees the other's page, and the assertion is on the titles rather than
    //   on a count of zero. Phase 4's non-member search was near-vacuous until it became one.
    //
    //   `publishedVersionId: { not: null }` is the third exclusion and the state it excludes is
    //   unreachable from the product — `PageSystem` rows only exist because a publish wrote them,
    //   and nothing unsets the column. It is reachable from the SCHEMA:
    //   `Page_publishedVersionId_fkey` is `ON DELETE SET NULL`, so deleting the version row nulls
    //   it while the facet rows survive. Covered by "a page whose published version has gone is
    //   not listed", which constructs exactly that row shape with a direct write and says so.
    //
    // `listSystems` is `exempt`: it reads `System` and nothing else. That table has no
    // `deletedAt`, no `spaceId` and no `visibility` — §7 makes a system global and
    // permissionless — so there is neither a soft-delete filter nor a permission predicate to
    // state, which is the same claim `src/lib/systems/resolve.ts` is registered on.
    covered: ["getSystemDocumentation"],
    exempt: ["listSystems"],
  },
  "src/lib/git/worker.ts": {
    load: () => import("@/lib/git/worker"),
    // Soft-delete tests: tests/integration/git-worker.test.ts —
    //   Registered as `covered` rather than `reachesPage: false` because it does reach a `Page`
    //   row: `loadVersion` selects `page: { select: { docType: true } }` through a relation, the
    //   shape this guard was too narrow to see the fourth time it was widened. And it reaches it
    //   with **no soft-delete filter, deliberately** — so what is pinned here is the *absence*,
    //   the same way `createPage`'s collision check is, and for a stronger reason: adding the
    //   filter would break a test rather than merely be redundant.
    //
    //   "a page soft-deleted before the drain still has its publish mirrored, then removed" is
    //   that test. A page can be published and deleted before the worker ever runs; the `PUBLISH`
    //   job's version then belongs to a page whose `deletedAt` is set, and a filtered read would
    //   fail it — leaving the `DELETE` job behind it removing a file that was never written and
    //   the version permanently unmirrored. `restorePage`, `listDeletedPages` and `findDeleted`
    //   each carry a deliberately blind query for the same family of reason; this is the fourth.
    //   The write side has the same blindness and the same test: the sha is recorded for a
    //   version whose page is soft-deleted, and "a restore puts the file back" walks the whole
    //   delete-then-restore sequence.
    //
    //   The other exported functions are the drain's own pieces, each with its own test in that
    //   file: the claim (a second worker cannot take a claimed job), the reclaim (an abandoned
    //   job becomes claimable; one past its attempts is FAILED), the finish (a reclaimed job's
    //   worker writes nothing), and the tree lock (a second worker blocks, and reports `busy`
    //   when it will not wait). None of them names a `Page` row, but they are listed rather than
    //   exempted because they are the same module's exports and an `exempt` list that grows is an
    //   `exempt` list nobody re-reads.
    covered: [
      "drainMirrorJobs",
      "claimNextJob",
      "reclaimAbandonedJobs",
      "finishJob",
      "withMirrorLock",
    ],
    // Pure: configuration read from a literal environment, and the retry curve. Neither queries
    // anything.
    exempt: ["workerConfigFromEnv", "backoffMs"],
  },
  "src/lib/git/failures.ts": {
    load: () => import("@/lib/git/failures"),
    // Soft-delete tests: tests/integration/git-failures.test.ts. Phase 5 Task 8's super-admin
    // list of jobs that gave up. Registered as `covered` because it does reach a `Page` row —
    // `page: { select: { title, path, deletedAt, space: … } }` through a relation, the shape this
    // guard was blind to the fourth time it was widened.
    //
    // And it reaches it with **no `visiblePage()` and no `readableSpace()`**, both deliberately,
    // so what is pinned here is the *absence* — the same shape as `createPage`'s collision check
    // and `worker.ts`'s version read, and for the stronger reason: adding either filter would
    // break a test rather than merely be redundant.
    //
    //   "a failed DELETE job for a soft-deleted page is listed, with the page marked deleted" is
    //   the soft-delete test. A `DELETE` job's page is soft-deleted *by definition*, so a
    //   `deletedAt: null` filter would hide every failure of the one job kind that guarantees
    //   one — and would hide a `PUBLISH` or `MOVE` failure for a page deleted since, while that
    //   job went on blocking the page's queue for ever. `restorePage`, `listDeletedPages`,
    //   `findDeleted` and the worker each carry a deliberately blind query; this is the fifth.
    //
    //   The permission absence has its own test rather than sharing that one: "a member of a
    //   space is refused, and reads not-found" is the mutation target for the `isSuperAdmin`
    //   guard, and it is a **discrimination** and not an absence — the same fixture that refuses
    //   the member is read by the super admin in the assertion above it, so "refused" cannot be
    //   confused with "there was nothing to show", which is how Phase 4's non-member search was
    //   nearly vacuous.
    covered: ["listMirrorFailures"],
    exempt: [],
  },
  "src/lib/audit/log.ts": {
    reachesPage: false,
    why:
      "writes AuditLog and reads nothing. The one delegate call is `tx.auditLog.create`, on a " +
      "client its caller supplies; the `pageId` it records is passed in by the mutation that " +
      "already read the row under `visiblePage()`, never looked up here. A soft-delete filter " +
      "would have nothing to filter — and it must NOT acquire one: `page.delete` and " +
      "`page.restore` audit rows are about pages that are soft-deleted at the moment they are " +
      "written, so a filter here would drop exactly the rows the trail exists for.",
  },
  "src/lib/db.ts": {
    reachesPage: false,
    why:
      "constructs the Prisma client and makes no query at all. It is here because the sweep now " +
      "names `new PrismaClient` as well as `db.`/`tx.` calls — a module that owns a connection is " +
      "a module a reader should find in this list, and the alternative that catches it is what " +
      "catches a client under any other variable name.",
  },
  "src/lib/auth/config.ts": { reachesPage: false, why: "queries User only, to resolve a sign-in" },
  "src/lib/users/upsert.ts": { reachesPage: false, why: "upserts User from an OIDC profile" },
  "src/lib/users/viewer.ts": { reachesPage: false, why: "reads User and its memberships" },
  "src/lib/bugs/create.ts": {
    reachesPage: false,
    why:
      "writes BugReport. It resolves a pageId from a route path, but through " +
      "src/lib/bugs/context.ts, which is registered separately if it ever queries directly.",
  },
};

test("every module that queries the database is registered in this guard", () => {
  const found = sweepForPrismaQueries(SRC).sort();
  expect(
    found,
    "this module queries Prisma but is not registered above — add it with soft-delete tests, " +
      "or declare `reachesPage: false` with the reason",
  ).toEqual(Object.keys(MODULES).sort());
});

/** Only the Page-reading registrations carry per-export coverage. */
const PAGE_MODULES = Object.entries(MODULES).filter(
  (e): e is [string, Extract<Registration, { load: unknown }>] => "load" in e[1],
);

test.each(PAGE_MODULES)(
  "%s: every exported reader has a soft-delete test",
  async (_path, mod) => {
    const loaded = await mod.load();
    const exported = Object.keys(loaded).filter((k) => typeof loaded[k] === "function");
    const uncovered = exported.filter(
      (k) => !mod.covered.includes(k) && !mod.exempt.includes(k),
    );
    expect(uncovered, "add a soft-delete test for these, then list them in `covered`").toEqual(
      [],
    );
  },
);

/**
 * The inverse: the guard above is only trustworthy while the names in it are real exports. A
 * renamed query would otherwise leave a stale name covering nothing and the new name
 * unlisted — and the first half of that mistake is silent.
 */
test.each(PAGE_MODULES)(
  "%s: every name listed in the guard is still exported",
  async (_path, mod) => {
    const loaded = await mod.load();
    const exported = new Set(Object.keys(loaded).filter((k) => typeof loaded[k] === "function"));
    const stale = [...mod.covered, ...mod.exempt].filter((k) => !exported.has(k));
    expect(stale, "these are listed but no longer exported — rename or drop them").toEqual([]);
  },
);

/**
 * The companion every sweep in this project is now required to have: **a pattern that matches
 * nothing looks exactly like a clean codebase.** The test above passes trivially if the regex is
 * wrong, and the raw alternative is the half no registered module would prove on its own — every
 * file that makes a raw call also makes a delegate call, so the first alternative would match it
 * either way. Both halves are exercised here against literal source lines.
 */
test("the sweep pattern can see a delegate call, a raw statement and a constructed client", () => {
  expect(PRISMA_QUERY.test('await tx.page.updateMany({ where: visiblePage() })')).toBe(true);
  expect(PRISMA_QUERY.test("const rows = await tx.$queryRaw<Row[]>`SELECT 1`")).toBe(true);
  expect(PRISMA_QUERY.test("await db.$executeRaw`UPDATE \"Page\" SET x = 1`")).toBe(true);
  // The client-construction alternative, which is the only one that can see a module whose
  // client is not called `db` or `tx` — the shape `src/lib/git/worker.ts` needs for its
  // session-scoped advisory lock.
  expect(PRISMA_QUERY.test("const holder = new PrismaClient({ datasourceUrl: url })")).toBe(true);
  // Not a database call: the guard must not start demanding registration for every method on
  // anything named `db` or `tx`.
  expect(PRISMA_QUERY.test("await tx.$disconnect()")).toBe(false);
  expect(PRISMA_QUERY.test("import { PrismaClient } from \"@prisma/client\"")).toBe(false);
});

test("visiblePage excludes soft-deleted rows and nests its extra conditions", () => {
  expect(visiblePage()).toEqual({ AND: [{ deletedAt: null }] });
  expect(visiblePage({ spaceId: "s1" }, { path: "a/b" })).toEqual({
    AND: [{ deletedAt: null }, { spaceId: "s1" }, { path: "a/b" }],
  });
});

test("visiblePage cannot have its predicate displaced by a caller's own AND", () => {
  // The hazard `readableSpace` documents, restated for this predicate: an extra condition
  // carrying its own top-level `AND` is nested, never merged, so it cannot overwrite the
  // `deletedAt` clause. The spread form — `{ ...visiblePage(), AND: [...] }` — is what
  // would, and no signature can prevent that; only the docstring and this expectation can.
  const where = visiblePage({ AND: [{ path: "a/b" }] });
  expect(where.AND).toEqual([{ deletedAt: null }, { AND: [{ path: "a/b" }] }]);
});

test("visiblePage returns a fresh object each call", () => {
  const a = visiblePage();
  const b = visiblePage();
  expect(a).not.toBe(b);
  expect(a.AND).not.toBe(b.AND);
});
