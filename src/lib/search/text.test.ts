import { expect, test } from "vitest";
import { renderMarkdown } from "@/lib/markdown/render";
import { searchTextOf } from "@/lib/search/text";

/**
 * These tests are the construct table in `text.ts`, one row at a time, then the shapes that
 * break an implementation that scans lines instead of parsing them.
 *
 * They assert with `toBe` on the whole result wherever the document is small enough to write
 * out, rather than `toContain`. `toContain` is the wrong instrument for this module: almost
 * every judgement here is about something being **absent**, and a `toContain` suite passes
 * unchanged when a stripper starts leaking URLs, code and comments into the text.
 */

// ── The table, row by row ─────────────────────────────────────────────────────────────────

test("frontmatter contributes nothing", () => {
  const doc =
    "---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\nThe registry is append-only.\n";

  // Not "the keys are gone" — the values too. `supersedes: decisions/adr-0031` is why the row
  // exists: without this, every ADR that supersedes another matches a search for "decisions",
  // over a word no reader can see on the page.
  expect(searchTextOf(doc)).toBe("The registry is append-only.");
});

test("a heading contributes its text, at every level", () => {
  const doc = "# Topic registry\n\n## Context\n\n### Retention\n\n#### Naming\n";
  expect(searchTextOf(doc)).toBe("Topic registry\nContext\nRetention\nNaming");
});

test("headings stay in the text even though the trigger indexes them separately", () => {
  // Task 2 gives headings their own weight-B term from `collectHeadings`, which collects h2
  // and h3 only. If this module dropped headings on the grounds that they are indexed already,
  // an h1 and an h4 would be indexed by nothing at all — and a match in a section title would
  // have no text for `ts_headline` to draw a snippet from.
  const doc = "# Only an h1\n\n#### Only an h4\n";
  expect(searchTextOf(doc)).toBe("Only an h1\nOnly an h4");
});

test("paragraphs, blockquotes and list items contribute their text", () => {
  const doc = "First para.\n\n> Quoted prose.\n\n- one\n- two\n\n1. ordered\n";
  expect(searchTextOf(doc)).toBe("First para.\nQuoted prose.\none\ntwo\nordered");
});

test("emphasis, strong and strikethrough contribute their text, without their markers", () => {
  expect(searchTextOf("*soft* and **hard** and ~~struck~~\n")).toBe(
    "soft and hard and struck",
  );
});

test("inline code contributes its text, because it is a word inside a sentence", () => {
  // Dropping it would index a sentence with a hole in it and produce the snippet
  // "Call  before rendering." — and identifiers are the highest-value thing to search for in
  // an engineering corpus.
  expect(searchTextOf("Call `splitFrontmatter` before rendering.\n")).toBe(
    "Call splitFrontmatter before rendering.",
  );
});

test("a fenced code block contributes nothing, and leaves the prose around it whole", () => {
  const doc = "Before.\n\n```ts\nconst secretIdentifier = await db.page.findMany();\n```\n\nAfter.\n";
  expect(searchTextOf(doc)).toBe("Before.\nAfter.");
});

test("an indented code block contributes nothing either", () => {
  const doc = "Before.\n\n    const secretIdentifier = 1;\n\nAfter.\n";
  expect(searchTextOf(doc)).toBe("Before.\nAfter.");
});

test("a mermaid fence contributes nothing, labels included", () => {
  // It needs no special case: it is a fence. Asserted anyway because this codebase has them
  // (`src/lib/markdown/mermaid.ts`) and the label prose is a real, accepted loss — recovering
  // it would mean parsing Mermaid, which is the second grammar this module refuses to be.
  const doc =
    "Sequence below.\n\n```mermaid\ngraph TD\n  A[\"Cashier scans item\"] --> B[\"Total\"]\n```\n";
  const text = searchTextOf(doc);

  expect(text).toBe("Sequence below.");
  expect(text).not.toContain("graph");
  expect(text).not.toContain("Cashier");
});

test("a link contributes its text, never its URL", () => {
  expect(searchTextOf("See the [Runbook](https://intranet.example.com/ops) first.\n")).toBe(
    "See the Runbook first.",
  );
});

test("a link's title attribute is not text either", () => {
  expect(searchTextOf('See the [Runbook](https://x.example.com "Ops handbook") first.\n')).toBe(
    "See the Runbook first.",
  );
});

test("an image contributes its alt text, never its URL", () => {
  expect(searchTextOf("![Architecture of the nav rail](/img/rail-v2.png)\n")).toBe(
    "Architecture of the nav rail",
  );
});

test("a link reference definition contributes nothing, and its use contributes its text", () => {
  const doc = "See the [Runbook][ops].\n\n[ops]: https://intranet.example.com/ops\n";
  expect(searchTextOf(doc)).toBe("See the Runbook.");
});

test("a table contributes every cell's text", () => {
  const doc = "| Segment | Owner |\n| --- | --- |\n| outlet | Provisioning |\n";
  expect(searchTextOf(doc)).toBe("Segment Owner\noutlet Provisioning");
});

test("HTML contributes nothing, comments included", async () => {
  // Free, not a judgement call: the renderer runs `remarkRehype` with
  // `allowDangerousHtml: false`, so none of this reaches the page. A result whose only match
  // is invisible to the person who opens it looks like a bug.
  //
  // The `<span>` is the subtle half, and it is why this test asserts against the renderer
  // rather than against a string someone reasoned out. `After <span>inline</span>.` is three
  // mdast nodes — html, text, html — so dropping the html nodes still leaves "After inline.",
  // and that is exactly what the reader sees. "HTML contributes nothing" is a rule about a
  // *node*, not about everything between a pair of angle brackets.
  const doc =
    "Before.\n\n<!-- TODO: rewrite, the cutover date is wrong -->\n\n<div>Raw block</div>\n\nAfter <span>inline</span>.\n";
  const text = searchTextOf(doc);

  expect(text).toBe("Before.\nAfter inline.");
  expect(text).not.toContain("TODO");
  expect(text).not.toContain("cutover");
  expect(text).not.toContain("Raw block");

  // Measured, not asserted from memory: the words in the text are the words on the page.
  const { html } = await renderMarkdown(doc);
  expect(html).toBe("<p>Before.</p>\n<p>After inline.</p>");
});

test("a footnote definition contributes its text; its reference marker does not", () => {
  const doc = "Measured at 60k rows.[^m]\n\n[^m]: Measured on the shipped pipeline.\n";
  expect(searchTextOf(doc)).toBe("Measured at 60k rows.\nMeasured on the shipped pipeline.");
});

test("a thematic break contributes nothing", () => {
  expect(searchTextOf("Above.\n\n***\n\nBelow.\n")).toBe("Above.\nBelow.");
});

test("a hard line break contributes a line break", () => {
  expect(searchTextOf("One line  \nnext line\n")).toBe("One line\nnext line");
});

// ── The shapes that break a line scanner ──────────────────────────────────────────────────

test("a fence containing something that looks like a heading contributes nothing", () => {
  // A scanner that treats a leading `#` as a heading emits "Not a heading" — text the author
  // was deliberately showing a reader as a code sample.
  const doc = "Real prose.\n\n```md\n# Not a heading\n\nNot a paragraph either.\n```\n";
  const text = searchTextOf(doc);

  expect(text).toBe("Real prose.");
  expect(text).not.toContain("Not a heading");
});

test("a fence containing something that looks like frontmatter strips neither", () => {
  // The exact shape `frontmatter.ts` documents. The document has no frontmatter at all, and
  // the fence is a code sample: a `---` scanner strips metadata out of the sample, and a
  // `^---$` scanner deletes the prose above it as a block it thinks is frontmatter.
  const doc =
    "# Title\n\nHow to write one:\n\n````\n---\nstatus: NOT_FRONTMATTER\n---\n````\n\nThat is all.\n";
  const text = searchTextOf(doc);

  expect(text).toBe("Title\nHow to write one:\nThat is all.");
  expect(text).not.toContain("NOT_FRONTMATTER");
});

test("a document that opens with a code fence keeps everything after it", () => {
  const doc = "```sql\nSELECT 1;\n```\n\nThe query above is the health check.\n";
  expect(searchTextOf(doc)).toBe("The query above is the health check.");
});

test("a table cell containing an escaped pipe stays one cell", () => {
  // A line scanner splits on `|` and indexes half a word. The parser knows `\|` is content.
  const doc = "| Pattern | Meaning |\n| --- | --- |\n| a \\| b | either one |\n";
  expect(searchTextOf(doc)).toBe("Pattern Meaning\na | b either one");
});

test("a link whose text is itself a URL keeps that URL", () => {
  // Not an exception to 'URLs are not text' — a confirmation of it. The rule is about where a
  // string sits in the document, not about whether it looks like an address: here the URL is
  // on the screen, so it is what the reader read. Three ways of writing one, one answer.
  const explicit = searchTextOf("[https://example.com/x](https://example.com/x)\n");
  const autolink = searchTextOf("<https://example.com/x>\n");
  const literal = searchTextOf("https://example.com/x\n");

  expect(explicit).toBe("https://example.com/x");
  expect(autolink).toBe("https://example.com/x");
  expect(literal).toBe("https://example.com/x");
});

test("a setext heading is a heading, not a thematic break", () => {
  // `Deployment` over a line of `---`. An implementation that scans for `---` throws the
  // heading away with the rule it thinks it found.
  expect(searchTextOf("Deployment\n---\n\nProse under it.\n")).toBe(
    "Deployment\nProse under it.",
  );
});

test("a leading blank line does not make the block below it frontmatter", () => {
  // Inherited from `splitFrontmatter`, which inherits it from micromark: one blank line above
  // demotes the `---` to a thematic break plus a setext heading, so the keys are visible text
  // on the page — and therefore are text here.
  expect(searchTextOf("\n---\nstatus: ACCEPTED\n---\n\nBody.\n")).toBe(
    "status: ACCEPTED\nBody.",
  );
});

test("a second --- block further down the document is text, because the renderer renders it", async () => {
  // This pins the decision NOT to enable `remark-frontmatter` on the body pass.
  // `remark-frontmatter` only ever recognises the block a document opens with, so the reader
  // sees this one as a rule and a heading. Enabling it here would delete text off the page.
  const doc = "---\nstatus: ACCEPTED\n---\n\nBody.\n\n---\nnot: frontmatter\n---\n";

  expect(searchTextOf(doc)).toBe("Body.\nnot: frontmatter");

  const { html } = await renderMarkdown(doc);
  expect(html).toContain("not: frontmatter");
  expect(html).not.toContain("status: ACCEPTED");
});

// ── Degenerate documents ──────────────────────────────────────────────────────────────────

test("a document that is only frontmatter has no search text", () => {
  expect(searchTextOf("---\nstatus: ACCEPTED\n---\n")).toBe("");
});

test("a document that is only a diagram has no search text", () => {
  expect(searchTextOf("```mermaid\ngraph TD\nA --> B\n```\n")).toBe("");
});

test("empty and whitespace-only documents have no search text", () => {
  expect(searchTextOf("")).toBe("");
  expect(searchTextOf("   \n\n\t\n")).toBe("");
});

test("frontmatter that does not parse is still stripped, and the body is still indexed", () => {
  // `splitFrontmatter` reports `ok: false` here and this module reads `body` anyway, which is
  // the reason `body` is on both branches of `FrontmatterResult`. Publish refuses such a
  // document for its own reasons; indexing has no opinion, and must not leak the broken block.
  const doc = "---\nstatus: [unclosed\n---\n\nThe body is fine.\n";
  const text = searchTextOf(doc);

  expect(text).toBe("The body is fine.");
  expect(text).not.toContain("unclosed");
});

test("runs of blank lines and trailing space collapse", () => {
  expect(searchTextOf("One.\n\n\n\n\nTwo.   \n\n\n")).toBe("One.\nTwo.");
});

// ── The whole table at once ───────────────────────────────────────────────────────────────

test("a document using every construct reads as prose", () => {
  const doc = [
    "---",
    "status: ACCEPTED",
    "supersedes: decisions/adr-0031",
    "---",
    "",
    "# Topic registry",
    "",
    "Call `splitFrontmatter` first; see the [Runbook](https://intranet.example.com/ops).",
    "",
    "```ts",
    "# Not a heading",
    "const a = 1;",
    "```",
    "",
    "```mermaid",
    'graph TD',
    '  A["Cashier scans item"]',
    "```",
    "",
    "| Segment | Owner |",
    "| --- | --- |",
    "| a \\| b | Provisioning |",
    "",
    "![Architecture of the nav rail](/img/rail.png)",
    "",
    "<!-- TODO: rewrite this -->",
    "",
    "Deployment",
    "---",
    "",
    "> Quoted prose.[^m]",
    "",
    "[^m]: Measured, not guessed.",
    "",
    "[ops]: https://intranet.example.com/ops",
    "",
  ].join("\n");

  expect(searchTextOf(doc)).toBe(
    [
      "Topic registry",
      "Call splitFrontmatter first; see the Runbook.",
      "Segment Owner",
      "a | b Provisioning",
      "Architecture of the nav rail",
      "Deployment",
      "Quoted prose.",
      "Measured, not guessed.",
    ].join("\n"),
  );
});

test("nothing a document can contain makes it throw", () => {
  // Task 2 calls this inside the publish transaction. A throw there is a failed publish, and
  // no arrangement of characters is a reason to lose someone's work.
  const hostile = [
    "\u0000\u001b[31m",
    "```\n```\n```",
    "| | |\n|---|\n",
    "[](",
    "<<<>>>",
    "***",
    "- ".repeat(500),
    "#".repeat(200) + " x",
    "\\",
  ];
  for (const doc of hostile) expect(() => searchTextOf(doc)).not.toThrow();
});
