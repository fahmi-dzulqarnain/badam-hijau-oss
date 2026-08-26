import { headingsOf } from "@/lib/markdown/render";
import { searchTextOf } from "@/lib/search/text";

/**
 * The two columns a published version stores for the search index, from one document.
 *
 * ## Why the application computes these at all
 *
 * §13 asks for a `tsvector` "derived from … body text stripped of Markdown syntax", "maintained
 * by a trigger created in a raw SQL migration". A plpgsql trigger cannot run remark, so the two
 * halves of that sentence are split: **the application strips, the trigger weights.** This
 * function is the strip, `PageVersion.searchText`/`searchHeadings` are where it lands, and the
 * trigger in `20260826…_search_vector` builds the weighted vector from those columns plus
 * `Page.title` whenever the `Page` row changes.
 *
 * The rejected alternative — a regex strip in SQL — fails on the input class `searchTextOf`
 * documents: a regular expression cannot see a fenced code block, so code, link URLs and table
 * pipes would all leak into the index as noise and into `ts_headline` as the page description.
 *
 * ## Where each one goes, and at which weight
 *
 * | Field | Column | Weight | Why there |
 * |---|---|---|---|
 * | title | `Page.title` | `A` | Already on `Page`; publish copies the version's title onto it. |
 * | headings | `PageVersion.searchHeadings` | `B` | A property of the published text. |
 * | body | `PageVersion.searchText` | `C` | A property of the published text. |
 *
 * The title is **not** returned here, deliberately: it is a column the trigger already has on
 * the row it is firing for, and a copy of it on the version's search columns would be a second
 * place the same words live — the one thing this whole arrangement exists to avoid.
 *
 * ## Both fields can legitimately be the empty string
 *
 * A page whose entire content is one Mermaid diagram has no prose: publish refuses an empty
 * *body*, but a body that is only a diagram is not empty. `searchTextOf` returns `""` for it and
 * `headingsOf` returns `[]`, and that is an answer rather than a failure — which is why both
 * columns are `NOT NULL DEFAULT ''` rather than nullable. `NULL` would have to mean "not
 * computed", and nothing may ever be in that state: a published version with an uncomputed
 * strip is a page that silently does not exist to search.
 *
 * ## Headings are counted twice, on purpose
 *
 * `searchTextOf` keeps heading text in the body text, so a heading's words land at `B` here and
 * again at `C`. That is Task 1's decision and its reasons are in that docstring: `collectHeadings`
 * takes h2 and h3 only, so dropping headings from the body would leave an h1 or an h4 indexed by
 * **nothing**, and would leave `ts_headline` with no text to draw a snippet from when the match
 * is in a section title. The effect is a small extra rank push on a heading lexeme. If it ever
 * has to go, it goes in the **trigger** — not in the strip.
 */
export type SearchFields = {
  /** The body prose, Markdown stripped. Weight `C`. */
  searchText: string;
  /** The h2/h3 text, one per line. Weight `B`. */
  searchHeadings: string;
};

/**
 * Reads a document twice, and that is cheaper than the alternative.
 *
 * The two halves need different trees — `searchTextOf` walks mdast, `headingsOf` needs hast with
 * ids on it — so one pass would mean one of them re-deriving what the other already knows. That
 * is the re-derivation both modules exist to refuse. Measured on the shipped pipeline: 0.6ms for
 * the headings and well under that for the strip, against 4.8ms for a full `renderMarkdown`,
 * which is what the publish transaction would otherwise pay while holding a row lock.
 *
 * Newline-separated rather than joined with a space, so a heading is a line: nothing downstream
 * splits on it today — Postgres tokenises whitespace identically either way — but a heading list
 * that has lost its boundaries cannot get them back, and this column is the only stored record
 * of the document's section titles.
 */
export async function searchFieldsOf(markdown: string): Promise<SearchFields> {
  const headings = await headingsOf(markdown);
  return {
    searchText: searchTextOf(markdown),
    searchHeadings: headings.map((heading) => heading.text).join("\n"),
  };
}
