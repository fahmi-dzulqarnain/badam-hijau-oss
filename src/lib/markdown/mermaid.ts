import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { Element, Root } from "hast";

/**
 * Replaces a ```mermaid fence with <div class="mermaid-source">…</div> before the
 * highlighter runs, so Shiki never sees a language it cannot parse. The client-side
 * renderer added in Phase 4 hydrates these nodes.
 */
export function extractMermaid() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || index === undefined || !parent) return;

      const code = node.children.find(
        (child): child is Element =>
          child.type === "element" && child.tagName === "code",
      );
      if (!code) return;

      const classes = code.properties?.className;
      const isMermaid =
        Array.isArray(classes) &&
        classes.some((c) => String(c).toLowerCase() === "language-mermaid");
      if (!isMermaid) return;

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["mermaid-source"] },
        children: [{ type: "text", value: toString(code) }],
      } satisfies Element;
    });
  };
}
