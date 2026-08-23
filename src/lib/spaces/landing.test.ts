import { expect, test } from "vitest";
import { summariseModules } from "./landing";
import type { TreeNode } from "@/lib/pages/tree";

function node(over: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    parentId: null,
    slug: over.id,
    path: over.id,
    title: over.id,
    status: "CURRENT",
    docType: "DOC",
    publishedVersionId: "v",
    children: [],
    ...over,
  };
}

test("counts published and draft descendants per module", () => {
  const modules = summariseModules([
    node({
      id: "decisions",
      title: "Decisions",
      children: [
        node({ id: "adr-1", parentId: "decisions" }),
        node({ id: "adr-2", parentId: "decisions" }),
        node({ id: "adr-3", parentId: "decisions", publishedVersionId: null }),
      ],
    }),
  ]);

  expect(modules).toEqual([
    { id: "decisions", title: "Decisions", path: "decisions", pageCount: 2, draftCount: 1 },
  ]);
});

test("counts nested descendants at any depth", () => {
  const modules = summariseModules([
    node({
      id: "a",
      children: [node({ id: "b", parentId: "a", children: [node({ id: "c", parentId: "b" })] })],
    }),
  ]);
  expect(modules[0]?.pageCount).toBe(2);
});

test("a module with no children reports zero, not one", () => {
  expect(summariseModules([node({ id: "empty" })])[0]?.pageCount).toBe(0);
});

test("an empty tree produces no modules", () => {
  expect(summariseModules([])).toEqual([]);
});
