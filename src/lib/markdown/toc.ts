import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { Root } from "hast";

export type Heading = { id: string; text: string; depth: 2 | 3 };

/**
 * Collects h2 and h3 into the array it is given. h1 is excluded: the page title is the
 * document's only h1 and is rendered outside the body.
 */
export function collectHeadings(options: { headings: Heading[] }) {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const id = node.properties?.id;
      if (typeof id !== "string") return;
      options.headings.push({
        id,
        text: toString(node),
        depth: node.tagName === "h2" ? 2 : 3,
      });
    });
  };
}
