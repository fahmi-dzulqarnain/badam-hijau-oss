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

test("frontmatter is stripped, and leaves nothing in the table of contents", async () => {
  // The exact input from the phase plan's "A bug this phase inherits". Before
  // `remark-frontmatter` was in the pipeline this produced, measured:
  //
  //   <hr>
  //   <h2 id="status-acceptedsupersedes-decisionsadr-0031">status: ACCEPTED
  //   supersedes: decisions/adr-0031</h2>
  //   <h1 id="title">…
  //
  // and a table of contents holding that id. The TOC half is a SEPARATE output from the HTML
  // and is asserted separately: `collectHeadings` runs inside the pipeline, so HTML that looks
  // right is not evidence the rail does.
  const { html, headings } = await renderMarkdown(
    "---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\n# Title\n\nBody.\n",
  );

  expect(html).not.toContain("<hr>");
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("ACCEPTED");
  expect(html).not.toContain("adr-0031");
  expect(html).toContain('<h1 id="title">');
  expect(headings).toEqual([]);
});

test("frontmatter does not disturb the headings below it", async () => {
  const { headings } = await renderMarkdown(
    "---\nstatus: ACCEPTED\n---\n\n## Context\n\n### Detail\n",
  );
  expect(headings).toEqual([
    { id: "context", text: "Context", depth: 2 },
    { id: "detail", text: "Detail", depth: 3 },
  ]);
});

test("`---` mid-document is still a thematic break", async () => {
  // Stripping frontmatter must not cost the author a horizontal rule they meant to write.
  const { html } = await renderMarkdown("Before.\n\n---\n\nAfter.\n");
  expect(html).toContain("<hr>");
});

test("`---` inside a fenced code block survives rendering", async () => {
  // The shape that catches a regex-based stripper: an author showing a reader what an ADR
  // header looks like. It is content, and it must reach the page.
  const { html } = await renderMarkdown(
    "# Title\n\n```yaml\n---\nstatus: NOT_FRONTMATTER\n---\n```\n",
  );
  expect(html).toContain("NOT_FRONTMATTER");
});

test("a /video attachment reference becomes a <video> element", async () => {
  const { html } = await renderMarkdown("![clip](/api/attachments/abc123/video)");
  expect(html).toContain('<video src="/api/attachments/abc123/video"');
  expect(html).toContain("controls");
  expect(html).not.toContain("<img");
});

test("an ordinary attachment reference stays an <img>", async () => {
  const { html } = await renderMarkdown("![shot](/api/attachments/abc123)");
  expect(html).toContain('<img src="/api/attachments/abc123"');
  expect(html).not.toContain("<video");
});

test("the alt text survives as an accessible label", async () => {
  const { html } = await renderMarkdown("![a demo](/api/attachments/abc123/video)");
  expect(html).toContain('aria-label="a demo"');
});

test("an off-origin src is never turned into a video, whatever it claims", async () => {
  // The src is RECONSTRUCTED from the captured id, not validated and passed through, so
  // there is no allowlist to get wrong.
  for (const src of [
    "https://evil.test/api/attachments/abc/video",
    "//evil.test/api/attachments/abc/video",
    "/api/attachments/../../evil/video",
    "/api/attachments/abc/video?x=1",
    "javascript:alert(1)//api/attachments/abc/video",
  ]) {
    const { html } = await renderMarkdown(`![x](${src})`);
    expect(html, src).not.toContain("<video");
  }
});

test("raw HTML is still dropped, sanitiser untouched", async () => {
  // The pipeline's posture is unchanged: `allowDangerousHtml` stays false, so this plugin
  // adds a video element WITHOUT opening the raw-HTML surface of every document.
  const { html } = await renderMarkdown('<video src="/api/attachments/abc/video"></video>');
  expect(html).not.toContain("<video");
  const script = await renderMarkdown("<script>alert(1)</script>");
  expect(script.html).not.toContain("<script");
});

test("a video reference inside a code fence is not transformed", async () => {
  const { html } = await renderMarkdown("```\n![x](/api/attachments/abc/video)\n```");
  expect(html).not.toContain("<video");
});
