import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeShiki from "@shikijs/rehype";
import rehypeStringify from "rehype-stringify";
import { collectHeadings, type Heading } from "./toc";
import { FRONTMATTER_MATTER } from "./frontmatter";
import { extractMermaid } from "./mermaid";
import { wrapTables } from "./wrap";

export type RenderedDoc = { html: string; headings: Heading[] };

const schema: Options = {
  ...defaultSchema,
  // clobberPrefix defaults to "user-content-", but remark-gfm ALREADY prefixes footnote
  // ids and their hrefs. Sanitising then prefixes the ids a second time while leaving the
  // hrefs untouched, so every footnote link and backref dangles. Emptying it loses
  // nothing: the sanitiser runs before rehype-slug, so heading ids are never prefixed
  // anyway, and footnote ids are the only ids it currently touches.
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    // Byte-identical to hast-util-sanitize 5's current default. Kept as an explicit pin
    // against an upstream widening, not as a change — and it is what forces the `Options`
    // annotation above.
    code: [["className", /^language-./]],
  },
};

/**
 * Everything up to and including the step that gives a heading its id.
 *
 * Extracted because Phase 4 needs the **heading list** without the page — the publish
 * transaction stores it as the weight-B half of the search vector — and the one thing that
 * must not happen is a second pipeline that agrees with this one on the day it is written.
 * `headingsOf` below appends `collectHeadings` to exactly this processor, so the headings in
 * the search index and the headings in the table of contents are the same list **by
 * construction**, in the frontmatter-and-parser sense `splitFrontmatter` already argues for.
 *
 * The split is here and not lower because everything after `rehypeSlug` is about producing
 * HTML: autolinking, Mermaid extraction, table wrapping and syntax highlighting cannot move a
 * heading, change its text or change its id. Everything above can — `remarkFrontmatter` decides
 * whether the opening `---` block is metadata or a setext `<h2>`, `remarkGfm` decides whether a
 * footnote section exists, `rehypeSanitize` strips author-supplied ids and classes, and
 * `rehypeSlug` is what puts the id there in the first place. `collectHeadings` reads the id and
 * the class, so it has to sit downstream of both.
 *
 * A fresh processor each call, as `renderMarkdown` already built one: `unified` freezes on first
 * use, and `collectHeadings` is configured with the array it fills.
 */
function documentProcessor() {
  return unified()
    .use(remarkParse)
    // Frontmatter becomes its own mdast node, which `remarkRehype` then drops. Without this
    // the leading `---` is a thematic break, the keys below it are a setext `<h2>` whose id
    // is the keys concatenated, and `collectHeadings` puts that id in the table of contents.
    // Measured on the shipped code before this line existed; see `frontmatter.ts`.
    //
    // The matter list is IMPORTED, not spelled out. It is the same declaration
    // `splitFrontmatter` parses with, so what this pipeline removes and what that function
    // reads cannot drift apart — and the preview pane, the reader and the published version
    // all go through here, so there is one answer for all three.
    .use(remarkFrontmatter, [...FRONTMATTER_MATTER])
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    // Sanitise first, then add our own ids — otherwise sanitising rewrites them.
    .use(rehypeSanitize, schema)
    .use(rehypeSlug);
}

/**
 * The table of contents of a document, without rendering it.
 *
 * Phase 4's search vector weights heading words at `B`, and a plpgsql trigger cannot run
 * remark — so the publish transaction stores the heading text on `PageVersion` and the trigger
 * reads the column. This is what produces that text.
 *
 * **h2 and h3 only**, because that is what `collectHeadings` collects and this function does
 * not re-derive it. An h1 or an h4 is therefore indexed only through the body text, at weight
 * `C` — which is exactly why `searchTextOf` keeps headings in the body text rather than
 * punching holes in it; see its docstring.
 *
 * `.run()` rather than `.process()`: there is no compiler on this processor and no HTML is
 * wanted. Running the transformers is the whole job, and it skips `rehypeShiki` — 12 grammars
 * and the slowest step in the pipeline — which the publish transaction would otherwise pay for
 * while holding a row lock.
 */
export async function headingsOf(markdown: string): Promise<Heading[]> {
  const headings: Heading[] = [];
  const processor = documentProcessor().use(collectHeadings, { headings });
  await processor.run(processor.parse(markdown));
  return headings;
}

export async function renderMarkdown(markdown: string): Promise<RenderedDoc> {
  const headings: Heading[] = [];

  const file = await documentProcessor()
    .use(collectHeadings, { headings })
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(extractMermaid)
    .use(wrapTables)
    .use(rehypeShiki, {
      themes: { light: "github-light", dark: "github-dark" },
      // Without this, Shiki loads all 346 bundled grammars: 4.2s and +80MB on the first
      // render in a process. An unlisted language degrades to `fallbackLanguage` rather
      // than throwing, which the "unknown code language" test already covers.
      langs: [
        "ts", "tsx", "js", "jsx", "json", "yaml",
        "bash", "sql", "swift", "prisma", "md", "dockerfile",
      ],
      fallbackLanguage: "text",
    })
    .use(rehypeStringify)
    .process(markdown);

  return { html: String(file), headings };
}
