import { expect, test } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { wrapTables } from "./wrap";
import { renderMarkdown } from "./render";

test("renders headings with stable ids and collects them for the table of contents", async () => {
  const { html, headings } = await renderMarkdown(
    "## Context\n\nSome prose.\n\n### Topic structure\n\n## Decision\n",
  );

  expect(headings).toEqual([
    { id: "context", text: "Context", depth: 2 },
    { id: "topic-structure", text: "Topic structure", depth: 3 },
    { id: "decision", text: "Decision", depth: 2 },
  ]);
  expect(html).toContain('id="context"');
  expect(html).not.toContain("user-content-");
});

test("does not collect h1, because the page title is the h1", async () => {
  const { headings } = await renderMarkdown("# Page title\n\n## Real section\n");
  expect(headings.map((h) => h.id)).toEqual(["real-section"]);
});

test("strips script tags and event handlers", async () => {
  const { html } = await renderMarkdown(
    'Text <script>alert(1)</script> more\n\n<img src="x" onerror="alert(1)">\n',
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).toContain("Text");
});

test("renders GFM tables", async () => {
  const { html } = await renderMarkdown(
    "| Segment | Owner |\n| --- | --- |\n| outlet | Provisioning |\n",
  );
  expect(html).toContain("<table>");
  expect(html).toContain("Provisioning");
});

test("highlights fenced code with Shiki", async () => {
  const { html } = await renderMarkdown('```ts\nconst a: number = 1;\n```\n');
  expect(html).toContain('class="shiki');
  expect(html).toContain("--shiki-dark");
});

test("extracts mermaid blocks instead of highlighting them", async () => {
  const source = "C4Context\n  Person(u, \"Cashier\")\n";
  const { html } = await renderMarkdown("```mermaid\n" + source + "```\n");

  expect(html).toContain('class="mermaid-source"');
  expect(html).not.toContain("language-mermaid");
  expect(html).toContain("C4Context");
});

test("an unknown code language does not throw", async () => {
  await expect(
    renderMarkdown("```notalanguage\nsomething\n```\n"),
  ).resolves.toBeTruthy();
});

test("wraps tables in a horizontal scroll container", async () => {
  const { html } = await renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  expect(html).toContain('<div class="table-scroll"><table>');
});

test("wrapTables is idempotent when applied twice to one tree", async () => {
  const html = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(wrapTables)
      .use(wrapTables)
      .use(rehypeStringify)
      .process("| A |\n| --- |\n| 1 |\n"),
  );
  expect(html.match(/table-scroll/g)).toHaveLength(1);
});

test("every internal anchor has a matching id", async () => {
  const { html } = await renderMarkdown(
    "Text[^1] and more[^two]\n\n[^1]: first\n\n[^two]: second\n",
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);

  expect(hrefs.length).toBeGreaterThan(0);
  expect(hrefs.filter((href) => !ids.includes(href))).toEqual([]);
});

test("the generated footnotes heading is not a table of contents entry", async () => {
  const { headings } = await renderMarkdown(
    "## Real section\n\nText[^1]\n\n[^1]: note\n",
  );
  expect(headings.map((h) => h.text)).toEqual(["Real section"]);
});

test("a heading with no text yields no table of contents entry", async () => {
  const { headings } = await renderMarkdown(
    "## ![Architecture](a.png)\n\n## Real\n",
  );
  expect(headings.map((h) => h.text)).toEqual(["Real"]);
});
