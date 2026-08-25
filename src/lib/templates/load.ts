import type { DocType } from "@prisma/client";
import { ADR_TEMPLATE } from "./adr";
import { DOC_TEMPLATE } from "./doc";
import { RFC_TEMPLATE } from "./rfc";
import { RUNBOOK_TEMPLATE } from "./runbook";

/**
 * The starting markdown for a new page, one module per doc type.
 *
 * Pure: strings in, a string out. Nothing is read at runtime, so there is no environment in
 * which this behaves differently — which is the entire point of the shape it has, and the
 * paragraphs below are the reason it is not the shape the plan asked for.
 *
 * ## The plan asked for `src/lib/templates/{adr,rfc,runbook,doc}.md`, and it cannot work
 *
 * **`.md` files are not importable.** TypeScript will not resolve `import adr from "./adr.md"`,
 * so a `.md` template has to be *read* at runtime, and it has to be read from a path that
 * survives `next build`. Three ways were tried against a real build served on port 5106, with
 * `src/lib/templates/*.md` moved out of the tree to stand in for a deployment that ships
 * `.next` without `src/`:
 *
 * | How | Result |
 * |---|---|
 * | `readFileSync(join(process.cwd(), "src/lib/templates/adr.md"))` | `ENOENT`. Nothing traces `src/` into the output. Works in a checkout, which is what makes it dangerous. |
 * | `readFileSync(SOURCES[docType])`, URLs hoisted into a `const` | **Build fails**: *"Static analysis determined that this filesystem access causes the whole project to be traced"*, then `Failed to collect page data for /new`. |
 * | `readFileSync(new URL("./adr.md", import.meta.url), "utf8")` at module load | **Build fails** in a later phase: `Failed to collect configuration for /new`, caused by `TypeError: The "path" argument must be of type string or an instance of URL. Received an instance of URL` — a cross-realm `URL` in the sandbox Next evaluates route modules in. `fileURLToPath` rejects the same value for the same reason. |
 * | the same expression, read **lazily** inside a function | Builds. Works from an **API route**: with the `.md` files deleted, `/api/probe` returned the file's contents, because Turbopack recognises `new URL(<literal>, import.meta.url)` as an asset reference and emits `.next/server/assets/adr.<hash>.md`. **Fails from a Server Component**: the identical call in a `page.tsx` threw `The "path" argument must be of type string or an instance of Buffer or URL. Received an instance of URL`, and the build output shows why — in the RSC/SSR layer the asset is emitted to `.next/static/media/adr.<hash>.md` and the reference is rewritten to the **browser** URL `/_next/static/media/adr.<hash>.md`. |
 *
 * That last row is the one that decided this. `templateFor` is called by `createPage`, which is
 * called by the server action in `src/app/(editor)/new/page.tsx` — the RSC layer, the half that
 * fails. And it fails *only* there: the same code passes vitest, passes `next build`, and works
 * from an API route, so every cheap check is green. A template that works in the test suite and
 * throws in production is precisely the failure this was warned about, and it is not a bug that
 * could be fixed here — the asset is a URL for the browser to fetch, and there is no file at
 * that path for the server to open.
 *
 * ## Why not a loader
 *
 * A `.md`-to-string loader would inline the text at bundle time and so be layer-independent.
 * It needs a `turbopack.rules` entry with a webpack loader (and the dependency that provides
 * it) for `next dev`/`next build`, a Vite-side equivalent for vitest, and a
 * `declare module "*.md"` for `tsc`. Three mechanisms across two toolchains for four short
 * documents, and if one of them is wrong the templates are missing in exactly one environment
 * — the same failure this is trying to leave behind. Not worth it at this size. If Phase 6
 * makes templates editable content in the database, none of this machinery would survive
 * anyway.
 *
 * ## What is kept, and what is given up
 *
 * The plan's decision was that templates are *"Markdown files in the repo, versioned and
 * reviewed like code, beside the zod schema that validates what they produce"*, as against
 * making them editable content with an admin surface. All of that is intact: four files beside
 * `src/lib/lifecycle/schema.ts`, one per doc type, each holding nothing but its document, so a
 * template change is a one-file diff that reads like a document.
 *
 * What is given up is the `.md` extension, and with it Markdown highlighting in an editor and
 * the small tax that a literal backtick in a template must be escaped — which TypeScript
 * reports at compile time rather than leaving to be discovered. Reported as drift on the plan
 * rather than worked around silently.
 */

/**
 * `Record<DocType, string>` is what makes a fifth doc type fail to compile rather than silently
 * start every page of it on an empty document.
 */
const TEMPLATES: Record<DocType, string> = {
  DOC: DOC_TEMPLATE,
  RUNBOOK: RUNBOOK_TEMPLATE,
  ADR: ADR_TEMPLATE,
  RFC: RFC_TEMPLATE,
};

/**
 * The markdown a new page of this type starts on.
 *
 * Used at **create** time — the text is written into `PageDraft.markdown` — and deliberately
 * not rendered as an editor placeholder. A placeholder disappears on the first keystroke and
 * leaves an empty document behind; worse, it means the draft row and what the author is
 * looking at disagree, so closing the tab loses the shape they thought they had.
 */
export function templateFor(docType: DocType): string {
  return TEMPLATES[docType];
}

/** Every doc type's template, for the tests that must check all four and not just the one. */
export function allTemplates(): Readonly<Record<DocType, string>> {
  return TEMPLATES;
}
