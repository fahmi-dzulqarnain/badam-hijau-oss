import { expect, test } from "vitest";
import { summariseModules } from "./landing";
import type { TreeNode } from "@/lib/pages/tree";

function node(over: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    parentId: null,
    // `slug`, `path` and `title` all defaulted to `over.id`, which made three distinct
    // fields indistinguishable: a summary reading `module.slug` where it means
    // `module.path` — every module link pointing at a wrong URL — passed the whole suite.
    // Each default is now distinct from the other two.
    slug: `${over.id}-slug`,
    path: `docs/${over.id}`,
    title: `${over.id} title`,
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
    {
      id: "decisions",
      title: "Decisions",
      path: "docs/decisions",
      isDraft: false,
      pageCount: 2,
      draftCount: 1,
    },
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

test("counts a draft nested below the top level, not just an immediate child", () => {
  const modules = summariseModules([
    node({
      id: "a",
      children: [
        node({
          id: "b",
          parentId: "a",
          children: [node({ id: "c", parentId: "b", publishedVersionId: null })],
        }),
      ],
    }),
  ]);
  expect(modules[0]?.draftCount).toBe(1);
  expect(modules[0]?.pageCount).toBe(1);
});

test("a module with no children reports zero, not one", () => {
  expect(summariseModules([node({ id: "empty" })])[0]?.pageCount).toBe(0);
});

test("summarises every module, not just the first", () => {
  const modules = summariseModules([
    node({ id: "architecture" }),
    node({ id: "decisions" }),
    node({ id: "runbooks" }),
  ]);
  expect(modules.map((m) => m.id)).toEqual(["architecture", "decisions", "runbooks"]);
});

test("the link path comes from `path`, not `slug`", () => {
  const modules = summariseModules([
    node({
      id: "topic-registry",
      slug: "topic-registry",
      path: "architecture/mqtt-contracts/topic-registry",
    }),
  ]);
  expect(modules[0]?.path).toBe("architecture/mqtt-contracts/topic-registry");
});

test("a module with no published version of its own is flagged as a draft", () => {
  expect(summariseModules([node({ id: "wip", publishedVersionId: null })])[0]?.isDraft).toBe(
    true,
  );
});

test("a published module is not a draft merely because a child is", () => {
  const modules = summariseModules([
    node({
      id: "decisions",
      children: [node({ id: "adr-1", parentId: "decisions", publishedVersionId: null })],
    }),
  ]);
  expect(modules[0]?.isDraft).toBe(false);
  expect(modules[0]?.draftCount).toBe(1);
});
