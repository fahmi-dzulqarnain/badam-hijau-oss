import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";

/**
 * Turns `![alt](/api/attachments/<id>/video)` into a `<video>` element.
 *
 * Markdown cannot express a video, and the obvious remedy — allowing raw `<video>` through
 * the sanitiser — does not work here: `remarkRehype` runs with `allowDangerousHtml: false`, so
 * raw HTML is dropped before the sanitiser ever sees it. Making the schema matter would mean
 * enabling raw HTML and adding `rehype-raw`, which exposes the entire raw-HTML surface of
 * every existing document. That is a much larger change than one element is worth.
 *
 * So this runs AFTER sanitisation and constructs the element itself, exactly as
 * `extractMermaid` does for diagrams. The consequence is the useful part: `src` is
 * **reconstructed from the captured id**, never validated and passed through, so an
 * off-origin video is impossible by construction rather than by allowlist. The sanitiser is
 * not modified at all.
 *
 * Anchored at both ends, and the id class is deliberately narrow — cuid is lowercase
 * alphanumeric. A query string, a traversal segment or a scheme cannot match.
 */
const VIDEO_SRC = /^\/api\/attachments\/([a-z0-9]+)\/video$/;

export function attachmentVideo() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "img" || index === undefined || !parent) return;

      const src = node.properties?.src;
      if (typeof src !== "string") return;
      const match = src.match(VIDEO_SRC);
      if (!match) return;

      const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";

      parent.children[index] = {
        type: "element",
        tagName: "video",
        properties: {
          // Rebuilt from the capture. Whatever the document wrote, this is what ships.
          src: `/api/attachments/${match[1]}/video`,
          controls: true,
          preload: "metadata",
          // A video has no alt attribute, so the author's alt text becomes the accessible
          // name rather than being silently discarded.
          ...(alt ? { "aria-label": alt } : {}),
        },
        children: [],
      } satisfies Element;
    });
  };
}
