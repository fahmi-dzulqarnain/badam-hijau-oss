import { expect, test } from "vitest";
import { searchFieldsOf } from "@/lib/search/fields";
import { headingsOf, renderMarkdown } from "@/lib/markdown/render";

/**
 * The two columns a published version stores for the index.
 *
 * `text.test.ts` already pins the strip construct by construct, so this file does not repeat it.
 * What it pins is the pair: that the headings come from the *same* extraction the table of
 * contents uses, that both fields tolerate a document with no prose in it, and the overlap
 * between them that Task 1 chose on purpose.
 */

const DOC = [
  "---",
  "status: ACCEPTED",
  "---",
  "",
  "# Kiosk telemetry",
  "",
  "Intro prose about pumps.",
  "",
  "## Namespace",
  "",
  "Every message uses `acme/{outlet}`.",
  "",
  "### Retention",
  "",
  "Kept for ninety days.",
  "",
  "```ts",
  "const retentionDays = 90;",
  "```",
  "",
  "#### Exceptions",
  "",
  "None yet.",
  "",
].join("\n");

test("headings are the h2/h3 text, one per line", async () => {
  const fields = await searchFieldsOf(DOC);
  expect(fields.searchHeadings).toBe("Namespace\nRetention");
});

/**
 * The equivalence that makes `headingsOf` safe to have written at all — and its non-vacuity
 * companion beside it, because two derivations that both return `[]` agree perfectly.
 *
 * `headingsOf` and `renderMarkdown` share one processor prefix, so this cannot drift by
 * construction rather than by convention. It is asserted anyway: "by construction" is a claim
 * about the code as it stands, and the cheapest way for a later reader to break it is to add a
 * plugin to one of the two and not the other.
 */
test("the indexed headings are the table of contents", async () => {
  const rendered = await renderMarkdown(DOC);
  const extracted = await headingsOf(DOC);

  expect(extracted).toEqual(rendered.headings);
  expect(extracted.length).toBeGreaterThan(0);
});

/**
 * The h1 and the h4 are the reason `searchTextOf` keeps headings in the body text.
 *
 * `collectHeadings` takes h2 and h3 only, so "Kiosk telemetry" and "Exceptions" appear in no
 * weight-B term at all. If the strip dropped headings to avoid double-counting, those two would
 * be indexed by *nothing* — which is the hole Task 1 declined to open, and this is the assertion
 * that would notice it being opened.
 */
test("an h1 and an h4 reach the index through the body text, not the heading text", async () => {
  const fields = await searchFieldsOf(DOC);

  expect(fields.searchHeadings).not.toContain("Kiosk telemetry");
  expect(fields.searchHeadings).not.toContain("Exceptions");
  expect(fields.searchText).toContain("Kiosk telemetry");
  expect(fields.searchText).toContain("Exceptions");
});

/**
 * The deliberate overlap, stated as a test so it cannot be "fixed" by accident.
 *
 * An h2's words are in both columns, so they are weighted `B` and again `C`. Task 2's plan flags
 * the extra rank push it produces and says where the fix belongs if it ever has to go: the
 * trigger, not the strip.
 */
test("an h2's words are in both columns, on purpose", async () => {
  const fields = await searchFieldsOf(DOC);

  expect(fields.searchHeadings).toContain("Namespace");
  expect(fields.searchText).toContain("Namespace");
});

/**
 * The case the plan singled out, and the reason both columns are `NOT NULL DEFAULT ''` rather
 * than nullable: a page whose entire content is one Mermaid diagram.
 *
 * Publish refuses an empty *body*; this body is not empty, it just has no prose. `""` is the
 * answer, not a failed strip, and nothing downstream may read it as one.
 */
test("a page that is only a Mermaid diagram strips to two empty strings", async () => {
  const fields = await searchFieldsOf(
    ["```mermaid", "C4Context", '  Person(cashier, "Cashier")', "```", ""].join("\n"),
  );

  expect(fields).toEqual({ searchText: "", searchHeadings: "" });
});

/** Frontmatter is metadata: it reaches neither column. */
test("frontmatter is in neither column", async () => {
  const fields = await searchFieldsOf(
    ["---", "supersedes: decisions/adr-0031", "---", "", "Body prose.", ""].join("\n"),
  );

  expect(fields.searchText).toBe("Body prose.");
  expect(fields.searchHeadings).toBe("");
});
