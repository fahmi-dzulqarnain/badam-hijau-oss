/**
 * Everything about a client-side Mermaid render that can be decided without a DOM.
 *
 * The component in `src/components/DocBody.tsx` is the only caller. It exists as its own module
 * for the reason `src/lib/editor/*` exists beside `Editor.tsx`: the decisions here are the ones
 * worth pinning with tests, and a `useEffect` is not a place a test can reach — this project runs
 * vitest in the `node` environment and has no component-rendering harness.
 *
 * **Nothing in this file imports Mermaid at runtime.** `MermaidConfig` is a type-only import, so
 * it is erased at compile time; the library itself is reached through a dynamic `import()` in the
 * component, and `scripts/check-diagram-bundle.ts` asserts against `next build`'s own output that
 * it stays out of every route's eager client bundle. It is 83 MB unpacked, measured on
 * `mermaid@11.17.2`.
 */
import type { MermaidConfig } from "mermaid";

/**
 * **Stated explicitly, and pinned by the test beside this file.**
 *
 * The plan says to set this rather than inherit it, and gives the reason: a dependency upgrade
 * must not be able to change it under us. The plan also says the default is `"loose"` — **that is
 * wrong, measured on `mermaid@11.17.2`**, whose `defaultConfig` carries `"securityLevel":
 * "strict"` (`node_modules/mermaid/dist/chunks/mermaid.core/chunk-DU6HZSFF.mjs`). Reported as
 * plan drift; the instruction survives its wrong reason, because "pin it" is exactly the defence
 * against a default that moves, whichever way it currently points.
 *
 * **What it actually buys, measured rather than assumed.** Mermaid's `sanitizeText` runs DOMPurify
 * over every label at *every* security level, so a label containing `<script>` loses it whatever
 * this says. What `strict` and `loose` genuinely disagree about is **interaction**, and the mutation
 * run pinned exactly which part:
 *
 * - `formatUrl` reads `if (config.securityLevel !== "loose") return sanitizeUrl(url);`, so
 *   `click A href "javascript:alert(1)"` reaches the reader as a live `<a xlink:href>` under
 *   `loose` and as an anchor with no href at all under `strict`. **This is the assertion in
 *   `e2e/diagrams.spec.ts` that dies when this constant is mutated** — verified: setting `"loose"`
 *   failed it with `a document-supplied URL survived as javascript:alert(1)`, while the
 *   hostile-*label* test stayed green, which is the plan's expectation corrected by measurement.
 * - `setClickFun` also opens `if (getConfig().securityLevel !== "loose") return;`, but the listener
 *   it would register is attached only by the `bindFunctions` that `mermaid.render` returns — and
 *   `DocBody` never calls it. That barrier is independent of this constant, so it cannot be the
 *   mutant-killing assertion; it is asserted anyway.
 *
 * Which is why the hostile-label case and the hostile-click case are two tests rather than one.
 */
export const MERMAID_SECURITY_LEVEL = "strict" as const;

/**
 * The design tokens a diagram is painted from, read off `:root` by the component.
 *
 * Declared here as a list so the component cannot read one this module does not use, and so the
 * test can state the mapping. Every name is a real custom property in `src/app/globals.css`, and
 * every one of them is redefined under `prefers-color-scheme: dark` — which is the whole reason
 * this indirection exists rather than a table of hex codes.
 */
export const DIAGRAM_TOKENS = [
  "--ground",
  "--surface",
  "--surface-2",
  "--ink",
  "--ink-2",
  "--line",
  "--line-strong",
  "--accent",
  "--accent-wash",
] as const;

export type DiagramTokenName = (typeof DIAGRAM_TOKENS)[number];

export type DiagramTokens = Record<DiagramTokenName, string> & {
  /**
   * The resolved font stack, taken from `getComputedStyle(document.body).fontFamily` and **not**
   * from the `--sans` custom property: `--sans` is itself `var(--font-plex-sans), …`, and a
   * `themeVariables` value reaches Mermaid as a string it puts straight into an SVG `<style>`
   * block, where an unresolvable `var()` would silently fall back to the browser default.
   */
  fontFamily: string;
};

/**
 * Whether a colour is dark enough that Mermaid should derive its shades downward.
 *
 * `darkMode` is not decoration: Mermaid's base theme branches on it when it computes the values
 * the caller did **not** supply — `rowOdd`/`rowEven` are `lighten(mainBkg, 75)` in light mode and
 * `darken(mainBkg, 5)` in dark. Getting it wrong makes a table row in a diagram the same colour as
 * its background.
 *
 * Derived from the **token**, not from `matchMedia`, and that is the point. `globals.css` has three
 * ways to be dark — the media query, `:root[data-theme="dark"]`, and (one day) a toggle — so a
 * `prefers-color-scheme` read would be a second, independent opinion about the theme that can
 * disagree with the colours actually on the page. The luminance of `--ground` cannot disagree with
 * itself.
 *
 * Returns `false` for anything it cannot parse, which is the light default the rest of the file
 * assumes; `--ground` is authored as a six-digit hex in `globals.css`, and `rgb()` is accepted
 * because that is what a browser hands back for a custom property in some engines.
 */
export function isDarkColor(color: string): boolean {
  const rgb = parseColor(color);
  if (!rgb) return false;
  // Rec. 709 luma on the raw channels. Deliberately not the sRGB-linearised WCAG formula: the
  // question here is "which way should Mermaid mix", not a contrast ratio, and the two agree on
  // every colour in this palette (`#0F1513` → 20, `#F7F9F6` → 248).
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luma < 128;
}

function parseColor(color: string): [number, number, number] | null {
  const text = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    // `!` because the pattern matched: group 1 is not optional and cannot be absent here.
    const digits = hex[1]!;
    const wide =
      digits.length === 3
        ? digits
            .split("")
            .map((c) => c + c)
            .join("")
        : digits;

    return [
      parseInt(wide.slice(0, 2), 16),
      parseInt(wide.slice(2, 4), 16),
      parseInt(wide.slice(4, 6), 16),
    ];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (fn) return [Number(fn[1]!), Number(fn[2]!), Number(fn[3]!)];
  return null;
}

/**
 * The whole Mermaid configuration, as one value, from the page's own design tokens.
 *
 * **The theme decision.** Shiki's trick does not transfer. Code highlighting ships *both* palettes
 * and lets CSS choose — `globals.css` overrides `--shiki-dark` under the media query — because a
 * highlighted token is an element with a colour. Mermaid is the opposite: `themeVariables` are run
 * through colour arithmetic (`lighten`, `darken`, `invert`) while the SVG is being generated, and
 * the results are baked into a `<style>` block inside it. A `var(--ink)` handed in here is a string
 * those functions cannot do arithmetic on, so there is no CSS-variable form of a Mermaid theme and
 * no way for one rendered SVG to answer to both palettes.
 *
 * So a diagram is rendered **for the palette in force at the moment it renders**, and the component
 * re-renders every diagram on the page when `prefers-color-scheme` changes — from the sources it
 * kept, which is the other reason it keeps them. That is the only correct answer available: the
 * alternative, rendering once with light defaults, is the unreadable dark-page diagram the task
 * names.
 *
 * `theme: "base"` and not `"neutral"` or `"dark"`: `base` is the only built-in theme documented as
 * the one to customise, and the others ignore most of what is passed here.
 *
 * **One diagram type does not answer to this, and it is left alone deliberately.** A C4 diagram's
 * shape fills come from `config.c4.person_bg_color` and its forty siblings — `#08427B` for a person,
 * `#1168BD` for a system, grey for anything external — not from `themeVariables`, and they are
 * written with `!important`. Measured on the seeded `architecture/mqtt-contracts` page: the person is
 * C4 blue with white label text on both palettes. That is left as it is, because those colours *are*
 * the C4 notation — person, system, container and external each have their own, and repainting all
 * of them one accent green would delete the encoding the notation exists for. They are mid-to-dark
 * blues with white captions, so they are legible either way; the diagram's background, its edge
 * labels and its title still come from the tokens below.
 */
export function mermaidConfig(tokens: DiagramTokens): MermaidConfig {
  const darkMode = isDarkColor(tokens["--ground"]);

  return {
    // Mermaid's own scan of `.mermaid` elements, off. Our nodes carry `mermaid-source` and would
    // not match it anyway — this is pinned so that stays a fact about our markup rather than a
    // coincidence, and because `startOnLoad` also decides whether importing the module has a side
    // effect on the document.
    startOnLoad: false,
    securityLevel: MERMAID_SECURITY_LEVEL,
    /**
     * **Load-bearing for "an error in place, not a broken page".** Left off, a malformed diagram
     * makes Mermaid paint its own error graphic — into the temporary element `render()` created,
     * which for a throwing render is a `<div>` it appended to `document.body` and may not remove.
     * With this on, `render()` simply throws and the component owns what the reader sees.
     */
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: {
      darkMode,
      fontFamily: tokens.fontFamily,
      fontSize: "13.5px",

      background: tokens["--ground"],
      mainBkg: tokens["--accent-wash"],
      primaryColor: tokens["--accent-wash"],
      primaryTextColor: tokens["--ink"],
      primaryBorderColor: tokens["--accent"],
      secondaryColor: tokens["--surface-2"],
      secondaryTextColor: tokens["--ink"],
      secondaryBorderColor: tokens["--line-strong"],
      tertiaryColor: tokens["--surface"],
      tertiaryTextColor: tokens["--ink-2"],
      tertiaryBorderColor: tokens["--line"],

      lineColor: tokens["--line-strong"],
      textColor: tokens["--ink"],
      titleColor: tokens["--ink"],
      nodeBorder: tokens["--accent"],
      nodeTextColor: tokens["--ink"],
      clusterBkg: tokens["--surface-2"],
      clusterBorder: tokens["--line-strong"],
      // An edge label sits on top of the edge it names; without a fill matching the page it is
      // painted over the line and neither is readable.
      edgeLabelBackground: tokens["--ground"],
    },
  };
}

/** The longest error text a reader is shown in place of a diagram. */
export const DIAGRAM_ERROR_MAX = 240;

/**
 * What §14's "inline error" says.
 *
 * Mermaid's parse errors are the useful kind — `Parse error on line 3: … Expecting 'SEMI', got
 * 'NODE_STRING'` — and an author looking at their own document is exactly who needs them, so the
 * message is shown rather than swallowed. It is **trimmed to its first line and capped**, because
 * the rest is an expected-token list that runs to several hundred characters and would bury the
 * code block underneath it.
 *
 * A non-`Error` throw and an empty message both land on the generic sentence: something has to be
 * said, and "" beside a code block reads as a rendering bug rather than a diagram that does not
 * parse.
 */
export function diagramErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const firstLine = raw.split("\n", 1)[0]!.trim();
  if (firstLine === "") return "This diagram could not be rendered.";
  const capped =
    firstLine.length > DIAGRAM_ERROR_MAX
      ? `${firstLine.slice(0, DIAGRAM_ERROR_MAX - 1)}…`
      : firstLine;
  return `Diagram error: ${capped}`;
}
