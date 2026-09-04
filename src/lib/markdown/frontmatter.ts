import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import { parseDocument, stringify } from "yaml";

/**
 * Frontmatter: finding it, reading it, and writing one.
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
 * ## The writer lives here too, for the same reason
 *
 * `serializeFrontmatter` is Phase 5's, and it is in this file rather than in `src/lib/git/`
 * because it writes the block this module's parser has to be able to read. `---` is the fence
 * `remark-frontmatter` matches for `FRONTMATTER_MATTER`, and a writer in another module would be
 * a second, invisible declaration of that grammar — the exact thing the paragraph above says
 * this module exists to prevent, arriving from the other direction. Nothing reads the mirror
 * back in production (Phase 5 is deliberately write-only), so a test is the only place the two
 * halves are ever compared; keeping them in one file is what makes that comparison a property
 * of the code rather than of the test.
 *
 * ## `splitFrontmatter` does not throw; `serializeFrontmatter` can
 *
 * Autosave fires every two seconds and an author mid-keystroke produces malformed YAML
 * constantly. Every rejection here is a `FrontmatterFieldError` the editor can render and the
 * publish path can refuse — the same asymmetry Phase 2 settled for the title, where a draft
 * accepts what publish rejects. A parse that throws turns "I am still typing" into "your work
 * stopped saving", which is the exact failure the whole conflict contract exists to prevent.
 *
 * The writer is the opposite, and deliberately: its input is not a person typing, it is values
 * this application already stored, so anything it cannot write is a programming error and a
 * throw is the honest report. `FrontmatterValue` is what it accepts; see its note for what the
 * `yaml` serializer does with the four things that are *nearly* JSON.
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

/**
 * What `serializeFrontmatter` accepts: JSON, and nothing that merely resembles it.
 *
 * The type is written out rather than taken from Prisma so that this module stays free of that
 * import, and it is deliberately wider in one place only — an object's values may be
 * `undefined`, because `Prisma.JsonValue`'s object member has optional properties and a seam
 * that could not accept the column it exists to serialise would be useless. The `Json` column is
 * the source of every value this ever writes.
 *
 * **Four things are nearly JSON, and `yaml@2.9.0` treats them four different ways.** Measured,
 * because a serializer's edge cases are exactly what a caller assumes rather than checks:
 *
 * | Value | What is written | Read back as |
 * |---|---|---|
 * | `undefined` as an object's value | nothing — **the key is dropped** | absent |
 * | `undefined` inside an array | `null` | `null` |
 * | a `Date` | an unquoted ISO 8601 timestamp | a **string** (YAML 1.2's core schema has no timestamp tag) |
 * | `NaN`, `Infinity` | `.nan`, `.inf` | `NaN`, `Infinity` |
 *
 * Only the first is in this type, and it matches `JSON.stringify`, so the column and the block
 * agree. A `Date` is excluded because a value that comes back a different type than it went in
 * is a round trip that quietly is not one: a caller with a timestamp formats it itself, which is
 * why `mirrorDocumentOf` writes `publishedAt` as a string. Non-finite numbers are excluded by
 * `validateFrontmatter` before anything is stored (`non-finite-number`), and a function or a
 * `Map` makes `stringify` throw outright (`Tag not resolved for Function value`).
 *
 * The type cannot express "acyclic", and a cycle is the one input that fails badly: with
 * `aliasDuplicateObjects` off — see below — `stringify` recurses until the stack goes, where the
 * default would have written an anchor. Nothing can hand one over from a row: Prisma writes the
 * column through `JSON.stringify`, which throws on a cycle, and `splitFrontmatter` rejects
 * `frontmatter-cyclic` at publish before that.
 */
export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | readonly FrontmatterValue[]
  | { readonly [key: string]: FrontmatterValue | undefined };

/**
 * How the block is written. Three options, none of them a default worth inheriting.
 *
 * **`aliasDuplicateObjects: false`** is the one that matters. `yaml` emits an anchor and an
 * alias for any object it meets twice — measured: `{ x: shared, y: shared }` writes
 * `x: &a1 [a, b]` and `y: *a1`, while the structurally identical `{ x: [a,b], y: [a,b] }` writes
 * both out in full. Two consequences, and both are disqualifying for a git mirror. The output
 * would depend on **object identity rather than value**, so two runs over equal data could
 * differ and produce a diff for content that did not change; and an anchor, while perfectly
 * valid YAML, is a shape a naive reader of the mirror will choke on. Validated frontmatter is
 * JSON-shaped and can legitimately repeat a value — `relations` carries four keys and three of
 * them are usually the same empty list — so this is a live case, not a hypothetical.
 *
 * **`lineWidth: 0`** disables line folding. The default (80) breaks a long scalar across
 * continuation lines, which round trips correctly but re-flows every line after the edit when a
 * title changes by one character. One key per line means one changed line in the diff, and this
 * block exists to be read as a diff.
 *
 * **`sortMapEntries: false`** is already the default; it is stated because `mirrorDocumentOf`'s
 * key order is a design decision documented at length there, and a library default flipping
 * would silently overrule it.
 *
 * Not set, and checked: no `%YAML` directive is emitted, so the block's first line is the first
 * key. Block scalars stay enabled (`blockQuote`), which is what turns a title containing a
 * newline into an indented `|-` literal instead of a folded double-quoted string.
 */
const SERIALIZE_OPTIONS = {
  aliasDuplicateObjects: false,
  lineWidth: 0,
  sortMapEntries: false,
} as const;

/**
 * The inverse of `splitFrontmatter`: values in, a `---`-fenced YAML block out, newline-terminated
 * and ready to have a body appended to it.
 *
 * Pure, and it builds no strings by concatenation except the two fences. That is the whole point
 * of using the serializer: a title of `Registry\nstatus: ACCEPTED` is written as an indented
 * block literal, so the second line is part of the title's value and **not** a second key. A
 * template-string implementation of this function would inject one.
 *
 * The fences are the only literal `---` this application writes, and they are here rather than
 * at the mirror's call site so that the writer and the parser of this grammar sit in one file.
 *
 * Throws only for a value outside `FrontmatterValue` — see that type. It cannot be made to
 * produce a block that reads back as something else by any *string* it is given.
 */
export function serializeFrontmatter(
  frontmatter: Readonly<Record<string, FrontmatterValue | undefined>>,
): string {
  // `stringify` always terminates its output with a newline, so the closing fence starts its own
  // line without one being added here.
  return `---\n${stringify(frontmatter, SERIALIZE_OPTIONS)}---\n`;
}
