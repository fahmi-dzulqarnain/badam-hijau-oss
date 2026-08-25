import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { parseDocument } from "yaml";

/**
 * Frontmatter: finding it, and reading it.
 *
 * ## Why this module exists at all
 *
 * Before it, the render pipeline had no idea frontmatter was a thing. A document opening with
 * `---` produced a `<hr>`, then a `<h2>` whose text was the concatenated keys, then a junk
 * entry in the table of contents pointing at it. Nothing wrote frontmatter, so nothing ever
 * showed it; Phase 3 makes every ADR write it, on the reader, in the preview pane and in the
 * published version at once.
 *
 * ## The one rule this module exists to keep
 *
 * **The renderer strips exactly what this parser consumes.** They are not two implementations
 * that happen to agree — `FRONTMATTER_MATTER` below is the single declaration of what counts
 * as frontmatter, `src/lib/markdown/render.ts` imports it, and both sides hand it to the same
 * `remark-frontmatter` extension. So the block grammar is not written twice, and cannot drift.
 *
 * That is why `splitFrontmatter` parses instead of matching a regular expression. A regex
 * anchored on `^---$` has no idea what a fenced code block is, and this document
 *
 * ```
 * # Title
 *
 * ```yaml
 * ---
 * status: NOT_FRONTMATTER
 * ---
 * ```
 * ```
 *
 * is the shape it gets wrong: it would strip metadata out of a code sample the author is
 * deliberately showing to a reader, and the renderer — which knows what a code fence is —
 * would keep rendering it. The two halves would disagree on a real document.
 *
 * ## It does not throw
 *
 * Autosave fires every two seconds and an author mid-keystroke produces malformed YAML
 * constantly. Every rejection here is a `FrontmatterFieldError` the editor can render and the
 * publish path can refuse — the same asymmetry Phase 2 settled for the title, where a draft
 * accepts what publish rejects. A parse that throws turns "I am still typing" into "your work
 * stopped saving", which is the exact failure the whole conflict contract exists to prevent.
 *
 * ## What it deliberately does not do
 *
 * No key is validated here — not their names, not their types, not whether `supersedes` names
 * a page that exists. That is Task 3's zod schema per doc type, and this module has to stay
 * usable by anything that just wants the body. What it does guarantee to that schema is a
 * plain, finite, acyclic object.
 */

/**
 * What `remark-frontmatter` is told to recognise, declared **once** and imported by the
 * renderer. Do not inline it at either site.
 *
 * YAML only. `remark-frontmatter` also understands TOML (`+++`), and enabling it would be a
 * one-word change that quietly breaks the invariant above: the renderer would strip a `+++`
 * block that this parser cannot read, so a document's metadata would vanish from the page
 * while `splitFrontmatter` reported none. One format, both halves.
 */
export const FRONTMATTER_MATTER = ["yaml"] as const;

/**
 * Largest frontmatter block accepted, in **UTF-8 bytes** of the block's contents, fences
 * excluded.
 *
 * Bytes rather than `String.length`, and the difference is not academic: Phase 1's bug
 * endpoint shipped a cap derived from character counts and it was ~2.4x loose on CJK text,
 * because JavaScript counts UTF-16 units while everything downstream — `Content-Length`,
 * Postgres, the wire — counts UTF-8.
 *
 * 16KB is enormous for what frontmatter is (a status, a handful of space-relative page paths,
 * a list of system names) and small next to `MAX_DRAFT_BODY_BYTES`, which is the only bound
 * this input otherwise has: without this cap a one-megabyte document could be one megabyte of
 * YAML. It is checked **before** the parse, so the oversized structure is never built.
 */
export const MAX_FRONTMATTER_BYTES = 16_384;

/**
 * Deepest nesting of maps and sequences accepted. A map of scalars is depth 1; a map of
 * sequences of scalars is depth 2; a map of sequences of maps is depth 3.
 *
 * Nothing the spec asks frontmatter to carry exceeds 3, so 6 is double the headroom of the
 * deepest real shape. 200 levels of `a:\n  b:\n    b:` parses without a single YAML error —
 * measured — so the cap, not the library, is the guard.
 */
export const MAX_FRONTMATTER_DEPTH = 6;

/**
 * Total entries accepted across the whole structure: every mapping key **and** every sequence
 * item, summed at every level.
 *
 * Counting only mapping keys is the wrong unit and leaves the obvious hole open — a
 * hundred-thousand-element sequence has no keys at all and a depth of 2, so it would sail past
 * both of the other caps. Same lesson as the byte cap above: count the thing that actually
 * grows.
 *
 * 200 is roughly twenty times the largest plausible ADR header.
 */
export const MAX_FRONTMATTER_ENTRIES = 200;

/** Why frontmatter was rejected. Callers switch on this; `message` is what a human reads. */
export type FrontmatterErrorCode =
  | "frontmatter-unparseable"
  | "frontmatter-not-a-map"
  | "frontmatter-too-large"
  | "frontmatter-too-deep"
  | "frontmatter-too-many-entries"
  | "frontmatter-cyclic";

/**
 * Attached to a field, never thrown — structurally the `FieldError` of `src/lib/pages/slug.ts`
 * and the `PublishFieldError` of `src/lib/pages/publish.ts`, narrowed to the codes this module
 * can produce.
 *
 * The field is `markdown` because that is the box the author is typing in. Frontmatter has no
 * input of its own: it is the first few lines of the document body, and telling someone their
 * `status` key is wrong is only actionable if it points at the editor pane they can fix it in.
 */
export type FrontmatterFieldError = {
  field: "markdown";
  code: FrontmatterErrorCode;
  message: string;
};

/** Parsed frontmatter: a plain object, guaranteed finite and acyclic. Values are unvalidated. */
export type Frontmatter = Record<string, unknown>;

/**
 * `body` is present on **both** branches, deliberately. A document whose frontmatter is
 * mid-keystroke still has a body worth previewing, and the renderer will strip the broken
 * block either way — so a caller that only wants prose never has to care whether the metadata
 * parsed.
 */
export type FrontmatterResult =
  | { ok: true; frontmatter: Frontmatter; body: string }
  | { ok: false; error: FrontmatterFieldError; body: string };

const reject = (
  code: FrontmatterErrorCode,
  message: string,
  body: string,
): FrontmatterResult => ({ ok: false, error: { field: "markdown", code, message }, body });

/**
 * The same parser the renderer runs, minus everything that cannot change where a frontmatter
 * block starts and ends. `remark-gfm` is not here on purpose: it adds inline and table
 * constructs, none of which participate in the block grammar that decides what is frontmatter
 * and what is a thematic break. The claim is not taken on trust — `frontmatter.test.ts`
 * asserts the split against `renderMarkdown`'s own output over every shape that has ever
 * broken an implementation of this, a GFM table included.
 *
 * Built once at module load. `unified` freezes a processor on first use and it is stateless
 * afterwards, so rebuilding it per call would only cost.
 */
const parser = unified().use(remarkParse).use(remarkFrontmatter, [...FRONTMATTER_MATTER]);

/** What a structural walk can find wrong. */
type WalkFailure = "cyclic" | "too-deep" | "too-many-entries";

/**
 * Depth-first over the parsed value, bounding depth and total entries.
 *
 * `ancestors` is the path from the root, not a global seen-set, and it is unwound in a
 * `finally` — so a value referenced twice by two different anchors is walked twice (bounded by
 * the entry budget) while a value that reaches *itself* is caught. That distinction is the
 * whole reason this is not a plain recursive count: YAML anchors make genuine cycles trivially
 * easy to write —
 *
 *     a: &anchor
 *       b: *anchor
 *
 * — two lines, no YAML errors at all, and the resulting JS object is self-referential.
 * `JSON.stringify` throws on it, which means without this check a four-word document would
 * reach the `Json` column of `PageDraft` and turn a bad-input problem into a 500 on autosave.
 * A naive recursive walk would not even get that far; it would blow the stack first.
 */
function walk(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  counter: { entries: number },
): WalkFailure | null {
  if (value === null || typeof value !== "object") return null;
  if (ancestors.has(value)) return "cyclic";
  if (depth > MAX_FRONTMATTER_DEPTH) return "too-deep";

  ancestors.add(value);
  try {
    // `Object.values` reads own enumerable properties. That includes a literal `__proto__`
    // key, which `yaml` defines as an own property rather than assigning it — so it cannot
    // reach `Object.prototype`, and it is counted and walked like any other key here.
    const children = Array.isArray(value) ? value : Object.values(value);
    counter.entries += children.length;
    if (counter.entries > MAX_FRONTMATTER_ENTRIES) return "too-many-entries";

    for (const child of children) {
      const failure = walk(child, depth + 1, ancestors, counter);
      if (failure !== null) return failure;
    }
  } finally {
    ancestors.delete(value);
  }
  return null;
}

/**
 * Splits a Markdown document into its frontmatter and its body.
 *
 * Pure: text in, values out, nothing imported from Prisma and nothing thrown. A document with
 * no frontmatter is not an error — it is `{}` and the whole text as body, which is what every
 * page written before Phase 3 is.
 */
export function splitFrontmatter(text: string): FrontmatterResult {
  const tree = parser.parse(text);
  const first = tree.children[0];

  // Frontmatter is the FIRST node or it is not frontmatter. A single blank line above it
  // demotes the `---` to a thematic break — measured — and this branch inherits that judgement
  // from micromark rather than restating it, which is the point of parsing.
  if (first?.type !== "yaml" || first.position?.end.offset === undefined) {
    return { ok: true, frontmatter: {}, body: text };
  }

  // Everything after the closing `---`, minus the line ending that terminates that fence line.
  // Only that one break is removed: any blank line the author left between the frontmatter and
  // their first heading is theirs, and Markdown does not care either way.
  const body = text.slice(first.position.end.offset).replace(/^\r?\n/, "");

  const raw = first.value;
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > MAX_FRONTMATTER_BYTES) {
    return reject(
      "frontmatter-too-large",
      `The frontmatter block is ${bytes} bytes, over the ${MAX_FRONTMATTER_BYTES}-byte limit. ` +
        "Frontmatter holds a page's metadata; put prose in the body.",
      body,
    );
  }

  // `parseDocument` rather than `parse`: it collects syntax errors instead of throwing on the
  // first, and each one carries a line and column, which is the difference between "your
  // frontmatter is broken" and a message the author can act on.
  const doc = parseDocument(raw);
  const [syntaxError] = doc.errors;
  if (syntaxError !== undefined) {
    // `linePos` is relative to the YAML block; the block always starts at line 1 of the
    // document, so its first line is the document's line 2. Hence the +1.
    const line = syntaxError.linePos?.[0];
    const where = line === undefined ? "" : ` (line ${line.line + 1}, column ${line.col})`;
    return reject(
      "frontmatter-unparseable",
      `The frontmatter is not valid YAML${where}: ${syntaxError.message.split("\n")[0]}`,
      body,
    );
  }

  let value: unknown;
  try {
    value = doc.toJS();
  } catch {
    // The one thing `toJS` throws for: `maxAliasCount` (100 by default) tripped while expanding
    // anchors. A billion-laughs expansion produces no syntax errors at all and only becomes
    // enormous during expansion, so it cannot be caught by the walk below — the walk never
    // gets a value. It is an entry-count failure detected early, and reported as one.
    return reject(
      "frontmatter-too-many-entries",
      "The frontmatter expands to too much data. Repeated YAML anchors (`&name` and `*name`) " +
        "multiply out; write the values in full instead.",
      body,
    );
  }

  // `---\n---` is empty frontmatter, and `yaml` gives back `null` for it. That is not a
  // failure: it is a template the author has not filled in yet.
  if (value === null || value === undefined) return { ok: true, frontmatter: {}, body };

  if (typeof value !== "object" || Array.isArray(value)) {
    return reject(
      "frontmatter-not-a-map",
      "Frontmatter must be a set of `key: value` lines, not a list or a bare value.",
      body,
    );
  }

  const failure = walk(value, 1, new Set(), { entries: 0 });
  if (failure === "cyclic") {
    return reject(
      "frontmatter-cyclic",
      "The frontmatter refers to itself through a YAML anchor. Write the value in full instead.",
      body,
    );
  }
  if (failure === "too-deep") {
    return reject(
      "frontmatter-too-deep",
      `The frontmatter nests more than ${MAX_FRONTMATTER_DEPTH} levels deep.`,
      body,
    );
  }
  if (failure === "too-many-entries") {
    return reject(
      "frontmatter-too-many-entries",
      `The frontmatter has more than ${MAX_FRONTMATTER_ENTRIES} entries, counting every key ` +
        "and every list item at every level.",
      body,
    );
  }

  return { ok: true, frontmatter: value as Frontmatter, body };
}
