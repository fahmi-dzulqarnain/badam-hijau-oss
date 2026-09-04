import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

/**
 * Markdown in, the prose a person would read aloud out.
 *
 * Pure: plain string in, plain string out. Nothing from Prisma, no database, nothing thrown.
 *
 * ## What this text is for, in order of priority
 *
 * Two things read it, and they pull in different directions:
 *
 * 1. **A person reads it in a search snippet.** Task 3 runs `ts_headline` over the stored
 *    text, so whatever comes out of here is what someone squints at to decide whether to
 *    click. A snippet is a promise about the page.
 * 2. **Postgres tokenises it** into the `tsvector` Task 2's trigger weights.
 *
 * Where the two disagree, **the snippet wins**. A choice that adds a few lexemes to the index
 * and turns a snippet into `const x = 1; }); import …` is the wrong choice, because every
 * failure of search reads to a user as "that page does not exist" and every bad snippet reads
 * as "this product is broken". Each row of the table below that goes against the index is
 * marked, so the trade is visible rather than inferred.
 *
 * ## Why it parses instead of stripping with a regular expression
 *
 * This is the same argument `src/lib/markdown/frontmatter.ts` makes, and it is the reason this
 * function exists as its own module rather than as a `replace()` chain at the publish site.
 * A regular expression cannot see a fenced code block, so it gets every one of these wrong:
 *
 * - a fence containing a line that looks like a heading — `# Not a heading` inside triple
 *   backticks is a code sample the author is deliberately showing, not a section title;
 * - a table cell containing an escaped pipe, `a \| b` — a line scanner splits it into two
 *   cells and indexes half a word;
 * - a link whose text is itself a URL — indistinguishable from a link whose text is prose
 *   unless you have parsed the two apart;
 * - a setext heading, `Deployment` over a line of `---` — which a `---` scanner reads as a
 *   thematic break and throws the heading away with it.
 *
 * The plan for Phase 4 rejected a SQL-side regex strip for exactly this reason, and Phase 3's
 * Task 2 measured a regex failing on this input class rather than assuming it would.
 *
 * ## Frontmatter is not indexed, and it cannot drift into the index
 *
 * `splitFrontmatter` runs first and only its `body` reaches the parser. That is not a
 * convention two functions keep: `splitFrontmatter` and `renderMarkdown` share one declaration
 * of what frontmatter is (`FRONTMATTER_MATTER`), so the text handed to the walk below is
 * *exactly* the text the reader's renderer turns into the article — by construction.
 *
 * Frontmatter is metadata, and `supersedes: decisions/adr-0031` matching a search for
 * "decisions" is noise: it puts a page in results over a word no reader can see on it. Note
 * that the metadata is not thereby unsearchable — it is the *typed columns* that carry it, and
 * Task 3's filters query those.
 *
 * `body` is read on **both** branches of `FrontmatterResult`, deliberately. A block that fails
 * a cap or a YAML parse is still stripped by the renderer, so its body is still the article;
 * publish refuses such a document for other reasons, and this function has no opinion.
 *
 * ## What each construct contributes
 *
 * | Construct | Contributes | Why |
 * |---|---|---|
 * | Frontmatter | nothing | Metadata. Above. |
 * | Heading, any level | its text | It is a section's name and the words a person searches. |
 * | Paragraph, blockquote, list item | its text | Prose. |
 * | Emphasis, strong, strikethrough | its text | Formatting, not content. |
 * | **Inline code** | **its text** | It is a word *inside a sentence*. See below. |
 * | **Fenced or indented code** | **nothing** | Program text, not prose. See below. |
 * | **A ```mermaid fence** | **nothing** | Diagram syntax. See below. |
 * | Link | its text, never its URL or title | `[Runbook](https://…)` is read as "Runbook". |
 * | Image | its alt text, never its URL or title | Alt text is what the page reads aloud. |
 * | Link reference definition | nothing | `[ref]: https://…` renders as nothing at all. |
 * | Table | every cell's text | A cell is prose; the pipes are the grid, not the content. |
 * | An HTML node, comments included | nothing | Invisible on the page. See below. |
 * | Footnote definition | its text | It is visible prose, at the bottom of the article. |
 * | Footnote reference | nothing | It renders as a marker, `[1]`. |
 * | Thematic break | nothing | It has no text. |
 * | Hard line break | a line break | It is a line break. |
 *
 * ### The rows that are judgements rather than readings
 *
 * **Inline code is in; fenced code is out**, and the split is not inconsistency. Inline code is
 * a token embedded in a sentence — "call `splitFrontmatter` before rendering" — so dropping it
 * indexes a sentence with a hole in it and produces the snippet "call  before rendering". It is
 * also the highest-value thing in this corpus to search for: identifiers, table names, env
 * vars, error codes. A fenced block is the opposite on both counts: removing it leaves the
 * prose around it whole, while keeping it fills the index with `const`, `await`, `});` — words
 * that match everything and mean nothing — and makes `ts_headline` hand back a fragment of
 * somebody's TypeScript as the description of the page.
 *
 * **A ```mermaid fence contributes nothing, and needs no special case** — it is a fence, and
 * fences are out. Called out anyway because this codebase has them (`src/lib/markdown/
 * mermaid.ts` lifts them out of the render pipeline) and the next reader will look here for
 * them. Its labels *do* contain prose, and losing `A["Cashier scans item"]` is a real cost;
 * it is accepted because recovering that prose means parsing Mermaid, which is a second
 * grammar — the exact thing this module refuses — and because the rest of the source
 * (`graph TD`, `-->`, `subgraph`, `classDef`) is noise in the index and gibberish in a snippet.
 *
 * **Headings are included here even though the trigger indexes them separately.** Task 2 gives
 * headings their own weight-B term from `collectHeadings`, so a heading's words are counted
 * twice, at B and at C. That is deliberate and it is not the duplication Task 2 warns about —
 * this does not re-derive the *heading list*, it declines to punch holes in the body text.
 * Removing them would cost two things: `collectHeadings` collects only h2 and h3, so an h1 or
 * an h4 would then be indexed by nothing at all; and a snippet drawn from a match in a section
 * title would have no text to be drawn from.
 *
 * **HTML — including comments — contributes nothing, and this one is free.** The renderer runs
 * `remarkRehype` with `allowDangerousHtml: false`, so raw HTML is dropped before it reaches the
 * page. Indexing it would make pages match words that are provably not on them. Comments are
 * the sharp end: `<!-- TODO: this is wrong, rewrite -->` is a note to self, usually stale, and
 * a search result whose only match is invisible to the person who opens it looks like a bug.
 *
 * Note the unit: it is the **node** that contributes nothing, not everything between a pair of
 * angle brackets. `After <span>inline</span>.` parses as html, text, html — so "After inline."
 * survives here, and "After inline." is precisely what the renderer puts on the page. Measured
 * against `renderMarkdown` in the test rather than reasoned about, because the plausible
 * intuition ("strip the tags and what they wrap") is the wrong one.
 *
 * ## What it does not do
 *
 * No control-character strip. `stripControl` already runs at the two boundaries where text
 * enters the system — the autosave endpoint and `createPage` — so the stored Markdown this
 * reads is already clean, and re-stating the rule here would be the same predicate in a third
 * place with the third copy never observably failing.
 */

/**
 * Nodes whose text stands on its own line.
 *
 * The separator is a newline rather than a blank line: it is the least that keeps two blocks
 * from being read as one sentence — a heading running into the paragraph under it — and any
 * more is bytes in a column stored per version for no gain, since HTML collapses both to a
 * single space anyway.
 *
 * `tableRow` is here so rows break; `tableCell` is not, because cells are joined with a space
 * below. Anything listed here that also lands next to another block just produces a run of
 * newlines, which `normalise` collapses.
 */
const BLOCK: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "footnoteDefinition",
]);

/**
 * The same parser the renderer runs, minus everything that cannot change what the text is.
 *
 * `remark-gfm` **is** here, unlike in `splitFrontmatter`'s parser, and for the mirror of that
 * function's reason: it does not matter to where a frontmatter block ends, and it matters
 * enormously here. Without it a GFM table is four lines of literal pipes, `~~struck~~` keeps
 * its tildes, and a bare `https://example.com` is not a link.
 *
 * `remark-frontmatter` is **not** here, and that is not an oversight either. This parser is
 * handed a body that `splitFrontmatter` has already taken the frontmatter off. A second `---`
 * block further down the document is a thematic break and a setext heading to the renderer,
 * because `remark-frontmatter` only ever recognises the block a document opens with — so
 * enabling it here would make this function strip text the reader can plainly see.
 *
 * Built once at module load; `unified` freezes a processor on first use and is stateless
 * after.
 */
const parser = unified().use(remarkParse).use(remarkGfm);

/** Depth-first over the parsed body, appending each node's contribution to `out`. */
function emit(node: Nodes, out: string[]): void {
  switch (node.type) {
    // ── Carries its own text ────────────────────────────────────────────────────────────
    case "text":
    case "inlineCode":
      out.push(node.value);
      return;

    case "image":
    case "imageReference":
      // `alt`, never `url` and never `title`. Alt text is the sentence a screen reader says
      // in place of the picture; a URL is an address.
      out.push(node.alt ?? "");
      return;

    // ── Carries text, but only through its children ─────────────────────────────────────
    case "link":
    case "linkReference":
      // The link's TEXT, never `node.url` or `node.title`. This is the whole judgement of the
      // row above: `[Runbook](https://intranet.example.com/ops)` is read aloud as "Runbook",
      // and a person searching "intranet" wants pages *about* the intranet, not the hundred
      // pages that happen to link to it.
      //
      // A link whose text is itself a URL therefore keeps that URL — an autolink, or GFM's
      // literal `https://example.com/x` — and that is right rather than an exception: the URL
      // is on the screen, so it is what the reader read. The rule is about position in the
      // document, not about whether a string looks like an address.
      for (const child of node.children) emit(child, out);
      return;

    // ── Carries nothing, and its children go with it ────────────────────────────────────
    case "code": // fenced or indented; a ```mermaid fence is one of these
    case "html": // raw HTML and HTML comments alike — the renderer drops both
    case "definition": // `[ref]: https://…` renders as nothing
    case "footnoteReference": // renders as a marker, not as prose
    case "thematicBreak":
      return;

    case "break":
      out.push("\n");
      return;

    default:
      // Every remaining node in mdast + GFM is a container whose text is its children's:
      // root, paragraph, heading, blockquote, list, listItem, emphasis, strong, delete,
      // footnoteDefinition, table, tableRow, tableCell.
      //
      // A node type this switch has never heard of falls here too, which is the safe way
      // round: an unknown *container* keeps the prose inside it, and an unknown *leaf* has no
      // children and so contributes nothing rather than dumping a raw `value` of unknown
      // syntax into the index.
      break;
  }

  if (!("children" in node)) return;

  const block = BLOCK.has(node.type);
  if (block) out.push("\n");
  for (const child of node.children) {
    emit(child, out);
    // Cells within a row, separated by a space and nothing more decorative: whatever goes
    // here is read by a person in a snippet, and a delimiter that is not in the document is a
    // character they then cannot find on the page.
    if (node.type === "tableRow") out.push(" ");
  }
  if (block) out.push("\n");
}

/**
 * Horizontal whitespace to single spaces, vertical whitespace to single newlines, trimmed.
 *
 * The walk above emits separators generously — every block opens and closes with a newline —
 * on the principle that it is easier to collapse runs than to work out at each site whether
 * one is needed.
 */
function normalise(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

/**
 * The plain text of a Markdown document, for indexing and for snippets.
 *
 * Returns `""` for a document with no prose in it — one that is only frontmatter, or only a
 * code fence. That is a legitimate answer, not a failure: publish already refuses a draft
 * whose body is empty, and a page whose entire content is one diagram genuinely has no words
 * to match.
 */
export function searchTextOf(markdown: string): string {
  const { body } = splitFrontmatter(markdown);
  const out: string[] = [];
  emit(parser.parse(body), out);
  return normalise(out.join(""));
}
