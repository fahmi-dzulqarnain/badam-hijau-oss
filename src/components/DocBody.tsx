"use client";

import { useEffect, useRef } from "react";
import {
  DIAGRAM_TOKENS,
  diagramErrorMessage,
  mermaidConfig,
  type DiagramTokens,
} from "@/lib/diagrams/config";

/**
 * The rendered document, plus the one thing the server cannot do: turn a ```mermaid fence into a
 * diagram (spec §12).
 *
 * **Why this owns the `<div className="body">` rather than sitting beside it.** The alternative —
 * a client component rendered as a sibling that reaches for the body with
 * `document.querySelector` — would be a component whose scope is "the whole page", and the editor's
 * preview pane puts a *second* `.body` on screen at the same time. Owning the element means the
 * search for diagrams is bounded by a ref, so the two surfaces cannot hydrate each other's
 * diagrams. It costs nothing on the wire: `html` was already a prop of a `dangerouslySetInnerHTML`
 * element in the RSC payload before this component existed.
 *
 * `dangerouslySetInnerHTML` is safe here for exactly the reason it was safe in the route:
 * `renderMarkdown` sanitises. Nothing below widens that — see the note on `paint`.
 */
export function DocBody({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  /**
   * **Find the diagrams, and only then reach for Mermaid.**
   *
   * The early return is the whole bundle argument at runtime: Mermaid is 83 MB unpacked, the
   * `import()` below is the only reference to it in this application, and it is under a branch that
   * a page with no fence never takes. `scripts/check-diagram-bundle.ts` asserts the static half
   * against `next build`'s own output.
   *
   * Keyed on `html` and not on nothing: the editor's preview pane re-renders this component with
   * new markup every couple of seconds while somebody types, and each new document is a new set of
   * diagrams. The reader passes a string that never changes.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const nodes = Array.from(host.querySelectorAll<HTMLElement>(".mermaid-source"));
    if (nodes.length === 0) return;

    /**
     * **The source, read once, before anything is written back.**
     *
     * `textContent` is the read the plan's landmine is about. The pipeline escaped the fence's
     * text so that it was inert *as part of the document*; reading it here decodes it again, so
     * what Mermaid receives for a hostile label is the literal `</div><script>alert(1)</script>`.
     * That is correct and unavoidable — it is the diagram source the author wrote — and it is why
     * `securityLevel` is pinned rather than inherited. **The escaping protected the document; it
     * did not sanitise the diagram source.**
     *
     * Read once and kept, rather than re-read per attempt, for two reasons: the element's children
     * are replaced by the render, so a second read would find the SVG; and a theme change has to
     * re-render from the same sources, which is what makes them state rather than a local.
     */
    const jobs = nodes.map((element) => ({ element, source: element.textContent ?? "" }));

    /**
     * Which draw is the current one, in the shape `Editor.tsx`'s preview ticket already uses. Two
     * `prefers-color-scheme` flips in quick succession start two async draws over the same
     * elements, and without this the slower one paints last.
     */
    let ticket = 0;

    const draw = async () => {
      const mine = ++ticket;
      const stale = () => mine !== ticket;

      // The 83 MB, behind a branch. `.default` because Mermaid's ESM entry point is a default
      // export; there is no named `render`.
      const mermaid = (await import("mermaid")).default;
      if (stale()) return;

      mermaid.initialize(mermaidConfig(readDiagramTokens()));

      for (const job of jobs) {
        // Sequential and not `Promise.all`: `mermaid.render` measures text by appending a
        // temporary element to the document and reading its box, and concurrent renders of
        // different diagrams have historically measured each other's.
        try {
          const { svg } = await mermaid.render(nextDiagramId(), job.source);
          if (stale()) return;
          paint(job.element, svg);
        } catch (error) {
          if (stale()) return;
          // **Per diagram, not per page.** §14: a malformed diagram renders as a code block with
          // an inline error and the rest of the page is unaffected. The `catch` is inside the
          // loop, so diagram three failing leaves diagrams one, two and four alone — and the
          // article around all of them was server-rendered and was never at risk.
          failInPlace(job.element, job.source, diagramErrorMessage(error));
        }
      }
    };

    void draw();

    /**
     * **A viewer who switches theme after a diagram has rendered.**
     *
     * `themeVariables` are baked into the SVG as concrete colours while it is generated — Mermaid
     * does colour arithmetic on them — so there is no CSS-variable form of a Mermaid theme and a
     * rendered diagram cannot answer to both palettes the way Shiki's dual-theme output does. The
     * only correct answer is to render it again, which is affordable precisely because the sources
     * were kept and the module is already loaded.
     *
     * `prefers-color-scheme` is the only switch a viewer has: `globals.css` reads
     * `:root[data-theme]` as well, but nothing in this application sets it, so watching for it
     * would be a control with no operator — and `isDarkColor` reads the resolved `--ground`, so
     * the day something does set it, one line here is the whole change.
     */
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onThemeChange = () => void draw();
    media.addEventListener("change", onThemeChange);

    return () => {
      // Abandons any draw in flight: the elements are about to be replaced by React.
      ticket += 1;
      media.removeEventListener("change", onThemeChange);
    };
  }, [html]);

  return <div className="body" ref={hostRef} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Unique per render across the whole page, because Mermaid resolves the id it is given with
 * `document.getElementById` while it measures — two diagrams sharing one id measure the same box.
 * A module-level counter and not a `useId`: the editor's preview pane draws the same document
 * repeatedly, and each pass needs ids the previous pass is not still holding.
 */
let diagramSeq = 0;
function nextDiagramId(): string {
  diagramSeq += 1;
  return `mermaid-svg-${diagramSeq}`;
}

/**
 * The design tokens, resolved off `:root`.
 *
 * `getComputedStyle` and not a hardcoded palette, so the diagram is painted from the same
 * declarations as the prose beside it — including under `prefers-color-scheme: dark`, where every
 * one of these is redefined.
 *
 * The font stack comes from `document.body` and not from `--sans`, deliberately: `--sans` is
 * `var(--font-plex-sans), …`, and Mermaid puts a `themeVariables` string straight into an SVG
 * `<style>` block where an unresolvable `var()` silently becomes the browser default.
 */
function readDiagramTokens(): DiagramTokens {
  const root = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(
    DIAGRAM_TOKENS.map((name) => [name, root.getPropertyValue(name).trim()]),
  ) as Record<(typeof DIAGRAM_TOKENS)[number], string>;

  return { ...tokens, fontFamily: getComputedStyle(document.body).fontFamily };
}

/**
 * The rendered SVG, in place of the source.
 *
 * **`innerHTML` here is the *output*, never the source**, and that distinction is the plan's rule
 * rather than a reading of it: the source travels from `textContent` into `mermaid.render` as a
 * string and — on failure — back out through `textContent`, so it is never parsed as markup at any
 * point. What goes through `innerHTML` is the SVG Mermaid returns, which is the mechanism
 * `mermaid.run` itself uses, and whose label text Mermaid has already put through DOMPurify.
 *
 * `mermaid-ready` rather than replacing the class: `doc.css` styles `.mermaid-source` as the
 * unhydrated placeholder — a dashed box showing the source text, which is what a reader with no
 * JavaScript still gets — and `.mermaid-source.mermaid-ready` overrides it by specificity. Keeping
 * both classes is what makes the placeholder the graceful-degradation case rather than a flash.
 */
function paint(element: HTMLElement, svg: string): void {
  element.classList.remove("mermaid-failed");
  element.classList.add("mermaid-ready");
  element.innerHTML = svg;
}

/**
 * §14: *"Renders as a code block with an inline error, rest of page unaffected."*
 *
 * Built node by node with `textContent`, and that is load-bearing rather than tidy: this is the one
 * place the raw diagram source is put back into the document, and the source of a *failed* diagram
 * is the likeliest source in the product to be hostile. `textContent` cannot produce an element;
 * `innerHTML` here would take the plan's landmine — `A["</div><script>…"]` — and write it into the
 * page as markup, closing `.mermaid-source` and the document's own `div` on the way out.
 *
 * The message goes **above** the code block: it is the reason the code is being shown.
 */
function failInPlace(element: HTMLElement, source: string, message: string): void {
  const note = document.createElement("p");
  note.className = "mermaid-error";
  note.textContent = message;

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.append(code);

  element.classList.remove("mermaid-ready");
  element.classList.add("mermaid-failed");
  element.replaceChildren(note, pre);
}
