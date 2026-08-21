import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";

export function wrapTables() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || index === undefined || !parent) return;
      if (
        parent.type === "element" &&
        Array.isArray(parent.properties?.className) &&
        parent.properties.className.includes("table-scroll")
      ) {
        return;
      }

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"] },
        children: [node],
      } satisfies Element;
    });
  };
}
