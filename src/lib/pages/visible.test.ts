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
 * Any Prisma delegate call, on any model, through either the client or a transaction client.
 *
 * Deliberately not `page`-specific: a query on `Redirect`, `PageVersion` or `PageDraft` can
 * reach `Page` rows through a relation filter without ever naming the `page` delegate, and
 * one already did.
 */
const PRISMA_QUERY = /\b(?:db|tx)\.[a-z]\w*\.[a-z]\w*\(/;

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
