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
      // An empty id is a real case, not a defensive check: an image-only heading such as
      // `## ![Architecture](a.png)` stringifies to "" because hast-util-to-string ignores
      // alt text. rehype-autolink-headings skips those, so collecting one would put a
      // blank row in the table of contents linking to `#`.
      if (typeof id !== "string" || id === "") return;

      // remark-gfm appends its own `<h2 class="sr-only" id="…footnote-label">Footnotes</h2>`
      // to any document with footnotes. It is a real h2 with an id, so without this it
      // becomes a phantom entry pointing at a visually hidden heading. The class is
      // machine-generated and unforgeable — the sanitiser strips `class` from author HTML.
      const classes = node.properties?.className;
      if (Array.isArray(classes) && classes.includes("sr-only")) return;

      const text = toString(node);
      if (text.trim() === "") return;

      options.headings.push({
        id,
        text,
        depth: node.tagName === "h2" ? 2 : 3,
      });
    });
  };
}
