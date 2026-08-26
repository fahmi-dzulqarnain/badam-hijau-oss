import { expect, test } from "vitest";
import {
  DIAGRAM_ERROR_MAX,
  DIAGRAM_TOKENS,
  MERMAID_SECURITY_LEVEL,
  diagramErrorMessage,
  isDarkColor,
  mermaidConfig,
  type DiagramTokens,
} from "./config";

/**
 * The light palette from `src/app/globals.css`, verbatim, so a test about "what a diagram looks
 * like on a light page" is reading the colours the page actually has.
 */
const LIGHT: DiagramTokens = {
  "--ground": "#F7F9F6",
  "--surface": "#FFFFFF",
  "--surface-2": "#F1F5F0",
  "--ink": "#15201B",
  "--ink-2": "#4E5F56",
  "--line": "#DFE7DF",
  "--line-strong": "#C6D2C7",
  "--accent": "#2C6A4C",
  "--accent-wash": "#E8F1EA",
  fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif",
};

/** The dark palette from the same file, likewise verbatim. */
const DARK: DiagramTokens = {
  "--ground": "#0F1513",
  "--surface": "#151D19",
  "--surface-2": "#1B2521",
  "--ink": "#E5EBE6",
  "--ink-2": "#9EAEA4",
  "--line": "#26312C",
  "--line-strong": "#37473F",
  "--accent": "#7FC79D",
  "--accent-wash": "#18291F",
  fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif",
};

/**
 * **The security pin.** Two assertions, because they fail for different reasons: the first catches
 * the constant being edited, the second catches it being edited to something that is not `strict` —
 * `"sandbox"` would pass a "not loose" check while rendering every diagram inside an iframe.
 *
 * The plan calls this "the only thing standing between a dependency upgrade and a changed default".
 * It is not quite the only thing — `e2e/diagrams.spec.ts` drives a hostile `click … call` line
 * through a real browser, which is what proves the value reached Mermaid rather than merely being
 * spelled correctly here. This is the cheap half; that is the half that cannot be satisfied by a
 * config object nobody passes.
 */
test("the security level is strict, explicitly", () => {
  expect(MERMAID_SECURITY_LEVEL).toBe("strict");
  expect(mermaidConfig(LIGHT).securityLevel).toBe("strict");
});

test("mermaid is never allowed to scan the document by itself", () => {
  expect(mermaidConfig(LIGHT).startOnLoad).toBe(false);
});

/**
 * The error-in-place contract's other half. Without this, a throwing `render()` leaves Mermaid's
 * own error graphic in the document and the component's `catch` block paints beside it rather than
 * instead of it.
 */
test("mermaid renders no error graphic of its own", () => {
  expect(mermaidConfig(LIGHT).suppressErrorRendering).toBe(true);
});

test("every declared token reaches the theme variables", () => {
  // Not "the config mentions nine colours" — that would pass with the same token used nine times.
  // Every declared token must appear as some theme variable's value, which is what makes
  // DIAGRAM_TOKENS the list the component may read rather than a list beside the one it reads.
  const values = new Set(
    Object.values(mermaidConfig(LIGHT).themeVariables ?? {}).map((v) => String(v)),
  );
  for (const token of DIAGRAM_TOKENS) {
    expect(values, `${token} is declared but unused`).toContain(LIGHT[token]);
  }
});

test("the font stack comes from the page, not from mermaid", () => {
  expect(mermaidConfig(LIGHT).themeVariables?.fontFamily).toBe(LIGHT.fontFamily);
});

/**
 * The theme decision, asserted as a difference rather than as a value.
 *
 * A diagram is rendered for the palette in force when it renders, so the one thing that must be
 * true is that the two palettes produce two different configurations — including `darkMode`, which
 * is what Mermaid branches on for every shade it derives itself.
 */
test("a dark page and a light page produce different diagram themes", () => {
  const light = mermaidConfig(LIGHT).themeVariables!;
  const dark = mermaidConfig(DARK).themeVariables!;

  expect(light.darkMode).toBe(false);
  expect(dark.darkMode).toBe(true);
  expect(dark.textColor).not.toBe(light.textColor);
  expect(dark.background).not.toBe(light.background);
  expect(dark.mainBkg).not.toBe(light.mainBkg);
  expect(dark.lineColor).not.toBe(light.lineColor);
});

test("reads darkness from the ground colour", () => {
  expect(isDarkColor("#0F1513")).toBe(true);
  expect(isDarkColor("#F7F9F6")).toBe(false);
  // Three-digit hex and `rgb()` both occur in the wild: a browser may hand back either form for
  // a custom property, and `globals.css` is not the only stylesheet that could ever set `--ground`.
  expect(isDarkColor("#000")).toBe(true);
  expect(isDarkColor("#fff")).toBe(false);
  expect(isDarkColor("rgb(15, 21, 19)")).toBe(true);
  expect(isDarkColor("rgba(247, 249, 246, 0.9)")).toBe(false);
});

test("an unreadable ground colour falls back to the light palette", () => {
  // Light, not dark: a diagram rendered light on a light page is the status quo, and one rendered
  // dark on a light page is invisible ink. The fallback picks the failure that can be seen.
  expect(isDarkColor("")).toBe(false);
  expect(isDarkColor("color-mix(in oklab, red, blue)")).toBe(false);
});

test("luma weights green, which is what decides in this palette", () => {
  // `#2C6A4C` — the light palette's own accent — is a *dark* green: luma 91, well under the
  // threshold, and 76 of that 91 comes from the green channel alone. A naive `max(r,g,b) < 128`
  // would call it light, and `--ground` is the only token this is ever applied to precisely
  // because the accent is the colour whose darkness is not what the answer is about.
  expect(isDarkColor("#2C6A4C")).toBe(true);
  // The mid-grey either side of the threshold, so the comparison itself is pinned rather than
  // only the two palettes it is asked about.
  expect(isDarkColor("#7F7F7F")).toBe(true);
  expect(isDarkColor("#818181")).toBe(false);
});

test("a parse error keeps its first line and loses the expected-token list", () => {
  const error = new Error(
    "Parse error on line 2:\n...graph TD\nA[--> B\n-----^\nExpecting 'SQE', 'DOUBLECIRCLEEND'",
  );
  const message = diagramErrorMessage(error);
  expect(message).toBe("Diagram error: Parse error on line 2:");
  expect(message).not.toContain("Expecting");
});

test("a long first line is capped", () => {
  const message = diagramErrorMessage(new Error("z".repeat(400)));
  expect(message.length).toBeLessThanOrEqual(DIAGRAM_ERROR_MAX + "Diagram error: ".length);
  expect(message.endsWith("…")).toBe(true);
});

test("something has to be said even when the throw says nothing", () => {
  // A blank message beside a code block reads as a rendering bug rather than a diagram that does
  // not parse — and `throw "..."`, `throw {}` and `new Error("")` all arrive here.
  expect(diagramErrorMessage(new Error(""))).toBe("This diagram could not be rendered.");
  expect(diagramErrorMessage(new Error("   \n  "))).toBe("This diagram could not be rendered.");
  expect(diagramErrorMessage({ nope: true })).toBe("This diagram could not be rendered.");
  expect(diagramErrorMessage(undefined)).toBe("This diagram could not be rendered.");
  expect(diagramErrorMessage("a bare string throw")).toBe("Diagram error: a bare string throw");
});
