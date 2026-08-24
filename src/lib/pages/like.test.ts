import { expect, test } from "vitest";
import { escapeLikeLiteral, subtreePattern } from "@/lib/pages/like";

/**
 * Pure tests for the escaping itself. They do not replace the integration tests in
 * `page-move.test.ts` and `page-delete.test.ts` that insert paths containing these characters
 * and watch Postgres agree — this file pins the string, those pin the meaning.
 *
 * Worth stating once here, because it is the reason this file exists at all: no slug can
 * contain `%`, `_` or `\` today, so every one of these cases is unreachable through the
 * product's own inputs. That is exactly what makes the escaping easy to delete and expensive
 * to miss — the day the slug character class changes, an unescaped `_` turns a subtree query
 * into a wildcard match over its siblings.
 */

test("a path with no metacharacters is returned unchanged", () => {
  expect(escapeLikeLiteral("architecture/mqtt-contracts")).toBe(
    "architecture/mqtt-contracts",
  );
});

test("the single-character wildcard is escaped", () => {
  // Unescaped, `a/b_c` also matches `a/bxc` — a different page, and its whole subtree.
  expect(escapeLikeLiteral("a/b_c")).toBe("a/b\\_c");
});

test("the any-run wildcard is escaped", () => {
  expect(escapeLikeLiteral("a/p%")).toBe("a/p\\%");
});

test("the escape character escapes itself", () => {
  // The under-match direction: left alone, the trailing backslash consumes the `/` that
  // follows it in the pattern and the page's own children stop matching — silently.
  expect(escapeLikeLiteral("probe/back\\")).toBe("probe/back\\\\");
});

test("every metacharacter in a path is escaped, not just the first", () => {
  expect(escapeLikeLiteral("a_b%c\\d_e")).toBe("a\\_b\\%c\\\\d\\_e");
});

test("subtreePattern appends a boundary slash and a wildcard to the escaped prefix", () => {
  expect(subtreePattern("a/b")).toBe("a/b/%");
  // The `/` is what keeps `architecture/mqtt-contracts-v2` out of
  // `architecture/mqtt-contracts`'s subtree, and it is appended after escaping so it stays a
  // literal separator rather than becoming the escaped character.
  expect(subtreePattern("probe/back\\")).toBe("probe/back\\\\/%");
});
