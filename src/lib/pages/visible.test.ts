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
 */
const PRISMA_QUERY = /\b(?:db|tx)\.(?:[a-z]\w*\.[a-z]\w*\(|\$(?:query|execute)Raw(?:Unsafe)?\b)/;

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
test("the sweep pattern can see both a delegate call and a raw statement", () => {
  expect(PRISMA_QUERY.test('await tx.page.updateMany({ where: visiblePage() })')).toBe(true);
  expect(PRISMA_QUERY.test("const rows = await tx.$queryRaw<Row[]>`SELECT 1`")).toBe(true);
  expect(PRISMA_QUERY.test("await db.$executeRaw`UPDATE \"Page\" SET x = 1`")).toBe(true);
  // Not a database call: the guard must not start demanding registration for every method on
  // anything named `db` or `tx`.
  expect(PRISMA_QUERY.test("await tx.$disconnect()")).toBe(false);
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
