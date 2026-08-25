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

export async function renderMarkdown(markdown: string): Promise<RenderedDoc> {
  const headings: Heading[] = [];

  const file = await unified()
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
    .use(rehypeSlug)
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
