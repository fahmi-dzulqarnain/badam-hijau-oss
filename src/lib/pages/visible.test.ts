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
 * It began as an enumeration of one module's exports, which had a blind spot large enough to
 * matter: `saveDraft` in `src/lib/drafts/repo.ts` queries `Page` and was completely invisible
 * to it. Phase 2 adds page queries in at least four more places, several in new modules. So
 * the outer guard is now a **filesystem sweep** — a new module that queries `Page` fails this
 * file until someone registers it and says where its tests are.
 */

const SRC = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = join(SRC, "..");

/**
 * Any Prisma read or write against the Page model.
 *
 * `tx.` as well as `db.`: Task 6 does its collision check and its insert inside an
 * interactive transaction, where the delegate is the transaction client and a `db.`-only
 * sweep sees nothing. Tasks 10 and 12 are both transactional too, so the blind spot would
 * have swallowed the move and the delete — the same "a guard scoped too narrowly stops
 * covering as soon as the thing it guards moves" failure this sweep already exists for.
 */
const PAGE_QUERY = /\b(?:db|tx)\.page\.\w+/;

function sweepForPageQueries(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sweepForPageQueries(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      if (PAGE_QUERY.test(readFileSync(full, "utf8"))) found.push(relative(ROOT, full));
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
const MODULES: Record<
  string,
  { load: () => Promise<Record<string, unknown>>; covered: string[]; exempt: string[] }
> = {
  "src/lib/pages/repo.ts": {
    load: () => import("@/lib/pages/repo"),
    // Soft-delete tests: tests/integration/pages-repo.test.ts
    covered: ["getPublishedPage", "listSpacePages", "listRecentlyPublished"],
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
  "src/lib/drafts/repo.ts": {
    load: () => import("@/lib/drafts/repo"),
    // Soft-delete tests: tests/integration/drafts-repo.test.ts
    covered: ["saveDraft"],
    exempt: [],
  },
};

test("every module that queries Page is registered in this guard", () => {
  const found = sweepForPageQueries(SRC).sort();
  expect(
    found,
    "a module queries Page but is not registered above — add it, with soft-delete tests",
  ).toEqual(Object.keys(MODULES).sort());
});

test.each(Object.entries(MODULES))(
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
test.each(Object.entries(MODULES))(
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
