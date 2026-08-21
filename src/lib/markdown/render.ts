import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeShiki from "@shikijs/rehype";
import rehypeStringify from "rehype-stringify";
import { collectHeadings, type Heading } from "./toc";
import { extractMermaid } from "./mermaid";
import { wrapTables } from "./wrap";

export type RenderedDoc = { html: string; headings: Heading[] };

const schema: Options = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./]],
  },
};

export async function renderMarkdown(markdown: string): Promise<RenderedDoc> {
  const headings: Heading[] = [];

  const file = await unified()
    .use(remarkParse)
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
      fallbackLanguage: "text",
    })
    .use(rehypeStringify)
    .process(markdown);

  return { html: String(file), headings };
}
