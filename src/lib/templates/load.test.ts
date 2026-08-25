import type { DocType } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { allTemplates, templateFor } from "@/lib/templates/load";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { renderMarkdown } from "@/lib/markdown/render";
import { frontmatterKeys, validateFrontmatter } from "@/lib/lifecycle/schema";

/**
 * The templates, checked against the schemas that will refuse them.
 *
 * The bug this file exists to make impossible: shipping a template that cannot be published.
 * It is entirely preventable and would be discovered by an author, on their first ADR, as a
 * validation error against text the product wrote for them.
 *
 * Every test here iterates `DOC_TYPES` rather than naming a type, so a fifth doc type arrives
 * with four failing tests instead of three passing ones and a gap.
 */

const DOC_TYPES: readonly DocType[] = ["DOC", "RUNBOOK", "ADR", "RFC"];

/**
 * `splitFrontmatter`, with the failure branch turned into a readable assertion.
 *
 * Going through the real splitter rather than slicing on `---` is the point: it is the same
 * function the publish path runs, so "the template's frontmatter is valid" means valid to the
 * thing that will judge it, not to a second parser written to agree with the template.
 */
function split(docType: DocType) {
  const result = splitFrontmatter(templateFor(docType));
  if (!result.ok) {
    throw new Error(`${docType} template frontmatter did not parse: ${result.error.message}`);
  }
  return result;
}

describe.each(DOC_TYPES)("%s template", (docType) => {
  test("parses as frontmatter plus a body", () => {
    const { frontmatter, body } = split(docType);
    expect(Object.keys(frontmatter).length).toBeGreaterThan(0);
    expect(body.trimStart()).toMatch(/^## /);
  });

  /**
   * The whole point of the file. `validateFrontmatter` is what publish runs, so a template
   * that fails here is a template no author can publish without first deleting the header the
   * product gave them.
   */
  test("its frontmatter passes its own doc type's schema", () => {
    const { frontmatter } = split(docType);
    const validated = validateFrontmatter({ docType, frontmatter });

    // Asserted through the error list rather than through `ok`, so a failure prints the key
    // and the sentence instead of `expected false to be true`.
    expect(validated.ok ? [] : validated.errors).toEqual([]);
  });

  /**
   * Declared, and declaring nothing. Both halves matter: the keys are present so the author
   * sees the shape rather than discovering it from a validation error, and every value is
   * empty so nothing the product invented is published under the author's name.
   *
   * `frontmatterKeys` is imported, not restated. That is what makes a key added to
   * `RELATION_KEYS_BY_TYPE` fail here until the template gains it — the alternative, a list
   * typed out in this file, is a second source of truth that agrees on the day it is written
   * and never again.
   */
  test("declares exactly the keys its type accepts, in order, all empty", () => {
    const { frontmatter } = split(docType);
    expect(Object.keys(frontmatter)).toEqual([...frontmatterKeys(docType)]);
    expect(Object.values(frontmatter)).toEqual(frontmatterKeys(docType).map(() => null));
  });

  /**
   * The normalised value publish would store. `null` for a known key means "declared
   * nothing" — the behaviour Task 3 made load-bearing for these templates — so an unfilled
   * template asks for no status, no systems and no relations, and the first publish uses the
   * type's entry state.
   */
  test("validates to a request for nothing", () => {
    const { frontmatter } = split(docType);
    const validated = validateFrontmatter({ docType, frontmatter });
    if (!validated.ok) throw new Error("validated above");

    expect(validated.frontmatter.status).toBeNull();
    expect(validated.frontmatter.systems).toEqual([]);
    expect(validated.frontmatter.relations).toEqual({
      SUPERSEDES: [],
      DECIDES: [],
      AMENDS: [],
      RELATES_TO: [],
    });
  });

  /**
   * Task 2's fix, held against real template text rather than against a fixture written to
   * suit it. Before that fix this exact input produced `<hr>` followed by an `<h2>` whose id
   * was every key concatenated, plus a junk entry in the table of contents — so the assertion
   * is on all three of those, not just on the absence of the keys.
   */
  test("renders with no frontmatter in the body and no junk heading", async () => {
    const { html, headings } = await renderMarkdown(templateFor(docType));

    for (const key of frontmatterKeys(docType)) {
      expect(html).not.toContain(`${key}:`);
    }
    expect(html).not.toContain("<hr>");
    expect(headings.every((h) => h.depth === 2)).toBe(true);
    expect(headings.length).toBeGreaterThanOrEqual(2);

    // The first body heading really did survive, so "nothing leaked" is not passing because
    // nothing rendered at all.
    const { body } = split(docType);
    const firstHeading = body.trimStart().slice(3).split("\n")[0];
    expect(headings[0]?.text).toBe(firstHeading);
  });

  /**
   * No `# ` heading, deliberately. The reader paints the page title from `Page.title` outside
   * `.body`, and the seeded pages all start at `##` — a template with an h1 would put the
   * title on screen twice on every new page, and the duplicate would be the one that ends up
   * in the table of contents.
   */
  test("starts its headings at level two, leaving the title to Page.title", () => {
    expect(split(docType).body).not.toMatch(/^# /m);
  });
});

test("every doc type has a template, and no two share one", () => {
  const templates = allTemplates();
  expect(Object.keys(templates).sort()).toEqual([...DOC_TYPES].sort());
  // Distinct strings, so `createPage` cannot pass the per-type test below by handing out the
  // same document four times.
  expect(new Set(Object.values(templates)).size).toBe(DOC_TYPES.length);
  for (const text of Object.values(templates)) expect(text.length).toBeGreaterThan(200);
});

/**
 * The tax of holding the documents in template literals rather than in `.md` files: an edit
 * can put invisible damage into text that still compiles. These are the three shapes that
 * would reach an author's editor pane unnoticed.
 */
test.each(DOC_TYPES)("%s template is clean text", (docType) => {
  const text = templateFor(docType);
  expect(text).not.toContain("\r");
  // Exactly one trailing newline: none and the author's first keystroke lands against the
  // last word of the template, several and the pane opens scrolled past blank lines.
  expect(text.endsWith("\n") && !text.endsWith("\n\n")).toBe(true);
  expect(text.split("\n").filter((line) => /\s$/.test(line))).toEqual([]);
});
