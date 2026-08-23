import { expect, test } from "vitest";
import * as repo from "@/lib/pages/repo";
import { visiblePage } from "@/lib/pages/visible";

/**
 * Every exported page reader must be listed here with a soft-delete test below. Adding a
 * query without adding its test fails this, which is the point: a missing `deletedAt` filter
 * is invisible until a deleted page reappears in someone's nav rail.
 *
 * `getReadableSpaceByKey` queries Space, not Page, so it is listed as deliberately exempt
 * rather than omitted — an omission reads as an oversight.
 *
 * The soft-delete tests themselves live in `tests/integration/pages-repo.test.ts`, because
 * proving a row is excluded needs a real database and a real deleted row. This file owns
 * only the enumeration: which functions are required to have one.
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

/**
 * The inverse of the guard above: it can only be trusted while the names in COVERED are
 * real exports. A renamed query would otherwise leave a stale name covering nothing and the
 * new name unlisted — and the first half of that mistake would be silent.
 */
test("every name in COVERED and EXEMPT is still an export of the module", () => {
  const exported = new Set(
    Object.keys(repo).filter((k) => typeof (repo as never)[k] === "function"),
  );
  const stale = [...COVERED, ...EXEMPT].filter((k) => !exported.has(k));
  expect(stale, "these are listed but no longer exported — rename or drop them").toEqual([]);
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
