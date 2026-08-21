import { expect, test } from "vitest";
import { buildTree, type PageRow, type TreeNode } from "./tree";

function row(over: Partial<PageRow> & { id: string }): PageRow {
  return {
    parentId: null,
    slug: over.id,
    path: over.id,
    title: over.id,
    status: "CURRENT",
    docType: "DOC",
    publishedVersionId: "v",
    ...over,
  };
}

test("nests children under their parent, preserving input order", () => {
  const tree = buildTree([
    row({ id: "architecture" }),
    row({ id: "c4", parentId: "architecture" }),
    row({ id: "mqtt", parentId: "architecture" }),
    row({ id: "runbooks" }),
  ]);

  expect(tree.map((n) => n.id)).toEqual(["architecture", "runbooks"]);
  expect(tree[0]?.children.map((n) => n.id)).toEqual(["c4", "mqtt"]);
  expect(tree[1]?.children).toEqual([]);
});

test("nests to arbitrary depth", () => {
  const tree = buildTree([
    row({ id: "a" }),
    row({ id: "b", parentId: "a" }),
    row({ id: "c", parentId: "b" }),
  ]);
  expect(tree[0]?.children[0]?.children[0]?.id).toBe("c");
});

test("a row whose parent is missing is treated as top level rather than dropped", () => {
  const tree = buildTree([row({ id: "orphan", parentId: "gone" })]);
  expect(tree.map((n) => n.id)).toEqual(["orphan"]);
});

test("a parent appearing after its child still nests correctly", () => {
  const tree = buildTree([row({ id: "child", parentId: "parent" }), row({ id: "parent" })]);
  expect(tree.map((n) => n.id)).toEqual(["parent"]);
  expect(tree[0]?.children.map((n) => n.id)).toEqual(["child"]);
});

test("an empty input produces an empty tree", () => {
  expect(buildTree([])).toEqual([]);
});

/**
 * Collects every occurrence. Throws if a node repeats on its own ancestor path (a live
 * cycle) or is reached twice by different paths (a duplicate) — either would hang or
 * double-count a recursive consumer such as Task 13's summariseModules.
 */
function collectIds(tree: TreeNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: TreeNode, path: Set<string>) => {
    if (path.has(node.id)) throw new Error(`cycle: ${node.id} is its own ancestor`);
    ids.push(node.id);
    const next = new Set(path).add(node.id);
    for (const child of node.children) visit(child, next);
  };
  for (const root of tree) visit(root, new Set());
  return ids.sort();
}

test("a parentId cycle still yields every row, reachable and finite", () => {
  const tree = buildTree([
    row({ id: "a", parentId: "b" }),
    row({ id: "b", parentId: "a" }),
  ]);

  // The bug this guards: a naive build attaches both to each other, leaves no roots, and
  // returns [] - the navigation rail vanishes with nothing logged.
  expect(tree.length).toBeGreaterThan(0);
  expect(collectIds(tree)).toEqual(["a", "b"]);
});

test("a three-node cycle mixed with a real subtree keeps both", () => {
  const tree = buildTree([
    row({ id: "root" }),
    row({ id: "leaf", parentId: "root" }),
    row({ id: "x", parentId: "z" }),
    row({ id: "y", parentId: "x" }),
    row({ id: "z", parentId: "y" }),
  ]);

  expect(collectIds(tree)).toEqual(["leaf", "root", "x", "y", "z"]);
  expect(tree.find((n) => n.id === "root")?.children.map((n) => n.id)).toEqual(["leaf"]);
});

test("a page that is its own parent becomes a childless root", () => {
  const tree = buildTree([row({ id: "self", parentId: "self" })]);
  expect(tree.map((n) => n.id)).toEqual(["self"]);
  expect(tree[0]?.children).toEqual([]);
});

test("a subtree hanging below a cycle keeps its shape", () => {
  const tree = buildTree([
    row({ id: "a", parentId: "b" }),
    row({ id: "b", parentId: "a" }),
    row({ id: "c", parentId: "a" }),
    row({ id: "d", parentId: "c" }),
  ]);

  expect(collectIds(tree)).toEqual(["a", "b", "c", "d"]);
  expect(tree).toHaveLength(1);
});
