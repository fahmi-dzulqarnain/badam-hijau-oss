import { expect, test } from "vitest";
import type { Prisma } from "@prisma/client";
import { splitFrontmatter, type FrontmatterValue } from "@/lib/markdown/frontmatter";
import { mirrorDocumentOf, type MirroredVersion } from "@/lib/git/document";

/**
 * What the mirror writes for one published version.
 *
 * These tests parse the result with `splitFrontmatter` and assert on **whole values** with
 * `toBe`/`toEqual`, never `toContain`. That is the point of the round trip: a "the file contains
 * the title" assertion cannot fail on an injected key, because the injected text contains the
 * title too.
 *
 * One golden-bytes test carries the formatting decisions — key order, quoting, indentation,
 * where the fences sit — because those are the ones no structural assertion can see.
 */

/**
 * Every field a distinguishable value, per the project's fixture rule: `slug`, `path` and
 * `title` once all defaulted to the same string, and swapping two of them in the implementation
 * was invisible.
 *
 * `status` is `PROPOSED` while `declared.status` is `null`, which is realistic — an author who
 * declares no status publishes into the doc type's default — and it is also what makes the two
 * `status` keys in the block impossible to confuse for each other in a test.
 */
const VERSION: MirroredVersion = {
  versionId: "cv-topic-registry-7",
  title: "Topic registry",
  markdown:
    "---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\n# Topic registry\n\nThe registry is append-only.\n",
  frontmatter: {
    status: null,
    systems: ["store-hub"],
    relations: {
      SUPERSEDES: ["decisions/adr-0031"],
      DECIDES: [],
      AMENDS: [],
      RELATES_TO: [],
    },
  },
  status: "PROPOSED",
  publishedAt: new Date("2026-08-26T09:00:00.000Z"),
  author: { name: "Aisyah Rahman", email: "aisyah@example.com" },
  spaceKey: "engineering",
  path: "architecture/topic-registry",
  docType: "ADR",
};

/** The canonical block of a mirrored file, parsed back. Throws rather than returning a partial. */
function blockOf(version: MirroredVersion): Record<string, unknown> {
  const result = splitFrontmatter(mirrorDocumentOf(version));
  if (!result.ok) throw new Error(`the mirrored block did not parse: ${result.error.code}`);
  return result.frontmatter;
}

/** The body of a mirrored file, as the same parser recovers it. */
function bodyOf(version: MirroredVersion): string {
  return splitFrontmatter(mirrorDocumentOf(version)).body;
}

// ── The round trip ────────────────────────────────────────────────────────────────────────

test("a mirrored document parses back to exactly the row's values", () => {
  // Kills: any field mix-up in the assembly — `space: version.path`, `title: page.title`,
  // `publishedAt: new Date()` — and any key silently dropped by the serializer. `toEqual` on
  // the whole map is what makes that true; asserting key by key would pass with an extra key
  // present.
  expect(blockOf(VERSION)).toEqual({
    title: "Topic registry",
    space: "engineering",
    path: "architecture/topic-registry",
    docType: "ADR",
    status: "PROPOSED",
    version: "cv-topic-registry-7",
    author: { name: "Aisyah Rahman", email: "aisyah@example.com" },
    publishedAt: "2026-08-26T09:00:00.000Z",
    declared: {
      status: null,
      systems: ["store-hub"],
      relations: {
        SUPERSEDES: ["decisions/adr-0031"],
        DECIDES: [],
        AMENDS: [],
        RELATES_TO: [],
      },
    },
  });
});

test("the key order is the documented one, and it is not alphabetical", () => {
  // Kills: a reordered assembly, and `sortMapEntries` flipping in the serializer. Nothing else
  // in the suite can see this — every other assertion is on values — and the order is the whole
  // reason the block is readable as a diff. Alphabetical would put `author` first and interleave
  // the author's `declared` block with the application's own keys.
  expect(Object.keys(blockOf(VERSION))).toEqual([
    "title",
    "space",
    "path",
    "docType",
    "status",
    "version",
    "author",
    "publishedAt",
    "declared",
  ]);
});

test("the whole file, byte for byte", () => {
  // The formatting decisions, all in one place: the fences, one key per line, two-space
  // indentation, no anchors, an unquoted ISO timestamp, `[]` for an empty list, and the author's
  // own blank line between the closing fence and their heading.
  //
  // Kills: `lineWidth` back to its default of 80 (which folds a long scalar), an added blank
  // line after the closing fence, a `Date` passed to the serializer instead of an ISO string,
  // and any change to the block that the structural tests above would accept.
  expect(mirrorDocumentOf(VERSION)).toBe(
    [
      "---",
      "title: Topic registry",
      "space: engineering",
      "path: architecture/topic-registry",
      "docType: ADR",
      "status: PROPOSED",
      "version: cv-topic-registry-7",
      "author:",
      "  name: Aisyah Rahman",
      "  email: aisyah@example.com",
      "publishedAt: 2026-08-26T09:00:00.000Z",
      "declared:",
      "  status: null",
      "  systems:",
      "    - store-hub",
      "  relations:",
      "    SUPERSEDES:",
      "      - decisions/adr-0031",
      "    DECIDES: []",
      "    AMENDS: []",
      "    RELATES_TO: []",
      "---",
      "",
      "# Topic registry",
      "",
      "The registry is append-only.",
      "",
    ].join("\n"),
  );
});

test("the author's frontmatter is removed and the body is passed through byte for byte", () => {
  // Kills: writing `version.markdown` instead of the split body — which would produce a file
  // with two frontmatter blocks, the author's contradicting the canonical one.
  expect(bodyOf(VERSION)).toBe("\n# Topic registry\n\nThe registry is append-only.\n");
  expect(mirrorDocumentOf(VERSION)).not.toContain("supersedes: decisions/adr-0031");

  // Non-vacuity: the string it must not contain is really in the input.
  expect(VERSION.markdown).toContain("supersedes: decisions/adr-0031");
});

test("a document with no frontmatter keeps its whole body", () => {
  const markdown = "# Runbook\n\nRestart the pump controller.\n";
  expect(bodyOf({ ...VERSION, markdown })).toBe(markdown);
});

// ── The shapes that break a stripper which does not parse ─────────────────────────────────

test("a body whose first line is `---` keeps it", () => {
  // Two blocks butted together: only the first is frontmatter, and the renderer puts the second
  // on the page as a thematic break and a setext heading. Phase 4 measured that a stripper which
  // handles this wrongly is invisible with any prose in between, because `remark-frontmatter`
  // only ever matches at offset 0 — so the blocks have to touch for the two implementations to
  // part company.
  //
  // Kills: a second strip pass over the body, and any `^---$` scan that takes the *last* fence.
  const markdown = "---\nstatus: ACCEPTED\n---\n---\nnot: frontmatter\n---\n\nBody.\n";
  expect(bodyOf({ ...VERSION, markdown })).toBe("---\nnot: frontmatter\n---\n\nBody.\n");
  expect(blockOf({ ...VERSION, markdown }).status).toBe("PROPOSED");
});

test("a fenced code block that looks like frontmatter is left alone", () => {
  // The document `frontmatter.ts` documents: an author showing a reader what frontmatter looks
  // like. It has none of its own, so a regex stripper deletes metadata out of a code sample —
  // and the reader's renderer, which knows what a fence is, keeps rendering it.
  //
  // Kills: a regex or line-scanning strip in place of `splitFrontmatter`.
  const markdown =
    "# How to write one\n\n````\n---\nstatus: NOT_FRONTMATTER\n---\n````\n\nThat is all.\n";
  expect(bodyOf({ ...VERSION, markdown })).toBe(markdown);
  // Non-vacuity: the sample really does reach the mirrored file.
  expect(mirrorDocumentOf({ ...VERSION, markdown })).toContain("NOT_FRONTMATTER");
});

test("a setext heading over `---` is not mistaken for frontmatter", () => {
  // `Deployment` over a line of dashes is an h1. An implementation that skips to the first
  // `---` throws the heading away with the rule it thinks it found.
  const markdown = "Deployment\n---\n\nProse under it.\n";
  expect(bodyOf({ ...VERSION, markdown })).toBe(markdown);
});

test("stored frontmatter that no longer parses is still stripped", () => {
  // The reachable case is a cap being lowered after a version was published — publish validated
  // this text before storing it. `splitFrontmatter` slices the body from the parsed node's
  // offset before any cap or YAML error is evaluated, so `body` is right on both branches; the
  // failure this test exists to prevent is a mirrored file that carries the broken block under a
  // canonical one contradicting it.
  //
  // Kills: `if (!split.ok) return version.markdown` and any `split.ok ? body : markdown`.
  const markdown = "---\nstatus: [unclosed\n---\n\nThe body is fine.\n";

  // Non-vacuity: the input really does take the failure branch, so this is not a test about a
  // document that parses.
  const stored = splitFrontmatter(markdown);
  expect(stored.ok).toBe(false);

  expect(bodyOf({ ...VERSION, markdown })).toBe("\nThe body is fine.\n");
  expect(mirrorDocumentOf({ ...VERSION, markdown })).not.toContain("unclosed");
  expect(blockOf({ ...VERSION, markdown }).title).toBe("Topic registry");
});

test("a final newline is added when the document has none, and never a second", () => {
  // A text file without a trailing newline makes every later diff report its last line as
  // changed. Kills: dropping the newline, and adding one unconditionally.
  const without = mirrorDocumentOf({ ...VERSION, markdown: "No trailing newline." });
  expect(without.endsWith("No trailing newline.\n")).toBe(true);

  const with_ = mirrorDocumentOf({ ...VERSION, markdown: "One trailing newline.\n" });
  expect(with_.endsWith("One trailing newline.\n")).toBe(true);
  expect(with_.endsWith("\n\n")).toBe(false);
});

// ── Hostile titles ────────────────────────────────────────────────────────────────────────

/**
 * The title `e2e/search.spec.ts` and `e2e/lifecycle.spec.ts` both carry, reproduced exactly:
 * `HOSTILE` in `e2e/support.ts` is `"x".repeat(300)`, so this is a script tag followed by 250
 * `x` characters — an unbreakable token, which is a **layout** hazard rather than a YAML one.
 * 293 characters, under `TITLE_MAX_LENGTH`.
 *
 * The punctuation that actually stresses a serializer is a separate case below, because this one
 * does not have any.
 */
const HOSTILE_TITLE = `<img src=x onerror="document.title='pwned'">${"x".repeat(250)}`;

test("the hostile e2e title survives as one key with its exact value", () => {
  const parsed = blockOf({ ...VERSION, title: HOSTILE_TITLE });

  expect(parsed.title).toBe(HOSTILE_TITLE);
  expect(Object.keys(parsed)).toHaveLength(9);
});

test("a title of nothing but YAML punctuation survives as one key", () => {
  // Every character that means something to a YAML parser, ten times over: quotes, a colon, a
  // hash, an ampersand and an asterisk (anchor and alias), braces and brackets (flow
  // collections), a backslash, a pipe and a greater-than (block scalars).
  const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".repeat(9);
  const parsed = blockOf({ ...VERSION, title: punctuation });

  expect(parsed.title).toBe(punctuation);
  expect(Object.keys(parsed)).toHaveLength(9);
});

test("a newline in a title injects no second key", () => {
  // **The assertion that earns its keep.** `stripControl` keeps newline, tab and return, and
  // `publishPage` only trims the ends — so a stored title containing an interior newline is a
  // reachable value, not a hypothetical.
  //
  // Kills: a serializer built by string concatenation — `` `title: ${title}\n` `` — which writes
  // `status: ACCEPTED` at the start of its own line inside the block. The row's status is
  // `PROPOSED` precisely so that the injected key and the real one cannot be confused: a
  // concatenating implementation either reports `ACCEPTED` here or fails to parse at all on the
  // duplicate key. `yaml` writes an indented `|-` block literal instead, so the second line is
  // part of the title.
  const title = "Topic registry\nstatus: ACCEPTED";
  const parsed = blockOf({ ...VERSION, title });

  expect(parsed.title).toBe(title);
  expect(parsed.status).toBe("PROPOSED");
  expect(Object.keys(parsed)).toHaveLength(9);
});

test("a title that is exactly `status: ACCEPTED` is a title, not a key", () => {
  // The one-line version of the case above, and it kills a narrower mutant: an implementation
  // that escapes newlines but writes short scalars unquoted. `yaml` quotes this one.
  const parsed = blockOf({ ...VERSION, title: "status: ACCEPTED" });

  expect(parsed.title).toBe("status: ACCEPTED");
  expect(parsed.status).toBe("PROPOSED");
  expect(Object.keys(parsed)).toHaveLength(9);
});

test("a title containing a closing fence does not end the block early", () => {
  // The sharpest shape a title has, because the fences are the one thing this module writes by
  // concatenation. A `---` on a line of its own inside the block would terminate it, leaving the
  // rest of the canonical keys as body text — so this asserts the *body* as well as the title.
  //
  // Kills: a block-scalar writer that does not indent its content (measured: `yaml` indents by
  // two, so the title's `---` lines cannot be read as a fence).
  const title = "Topic\n---\nstatus: ACCEPTED\n---\nregistry";
  const version = { ...VERSION, title };

  expect(blockOf(version).title).toBe(title);
  expect(Object.keys(blockOf(version))).toHaveLength(9);
  expect(bodyOf(version)).toBe("\n# Topic registry\n\nThe registry is append-only.\n");
});

test("nothing a stored version can hold makes it throw", () => {
  // Task 4 enqueues inside the publish transaction and Task 6 calls this from the worker. A
  // throw in either place is an operational failure for a document that published fine.
  const hostile = [
    "",
    "---\n",
    "---\n---\n",
    "\u0000\u001b[31m",
    "```\n```\n```",
    "\\",
    "#".repeat(200),
  ];
  for (const markdown of hostile) {
    expect(() => mirrorDocumentOf({ ...VERSION, markdown })).not.toThrow();
    expect(() => mirrorDocumentOf({ ...VERSION, title: markdown })).not.toThrow();
  }
});

// ── Determinism ───────────────────────────────────────────────────────────────────────────

test("the same values produce byte-identical output", () => {
  expect(mirrorDocumentOf(VERSION)).toBe(mirrorDocumentOf(VERSION));
  expect(mirrorDocumentOf({ ...VERSION })).toBe(mirrorDocumentOf({ ...VERSION }));
});

test("two structurally equal versions mirror identically, whatever their object identity", () => {
  // Kills: dropping `aliasDuplicateObjects: false`. `yaml` emits `&a1`/`*a1` for any object it
  // meets twice, so with the default the shared-reference version below writes
  // `DECIDES: &a1 []` and `AMENDS: *a1` while the other writes both lists in full — the same
  // data, two different files, and a mirror that produces a diff for content nobody touched.
  //
  // `relations` is exactly where this bites: four keys, three of them usually the same empty
  // list, and `validateFrontmatter` builds them with separate literals today. That is a fact
  // about another module, which is what makes it worth pinning here.
  const shared: string[] = [];
  const identity = {
    ...VERSION,
    frontmatter: {
      status: null,
      systems: ["store-hub"],
      relations: {
        SUPERSEDES: ["decisions/adr-0031"],
        DECIDES: shared,
        AMENDS: shared,
        RELATES_TO: shared,
      },
    },
  };

  expect(mirrorDocumentOf(identity)).toBe(mirrorDocumentOf(VERSION));
  // Non-vacuity: the output really does contain the repeated value more than once, so this is
  // not two files that agree because neither says anything.
  expect(mirrorDocumentOf(identity)).toContain("DECIDES: []");
  expect(mirrorDocumentOf(identity)).toContain("AMENDS: []");
});

// ── The seam's contract ───────────────────────────────────────────────────────────────────

test("the frontmatter field accepts the `Json` column it exists to serialise", () => {
  // Type-only, and the assignment below is the assertion: `Prisma.JsonValue` is what a `select`
  // on `PageVersion.frontmatter` returns, and if `FrontmatterValue` stops accepting it, Task 4
  // has to cast at the call site — which is exactly where a wrong shape stops being visible.
  // `npm run typecheck` is what fails; the expectation keeps this from being an empty test.
  const fromColumn = { status: "ACCEPTED", relations: { SUPERSEDES: [] } } as Prisma.JsonValue;
  const accepted: FrontmatterValue = fromColumn;

  expect(blockOf({ ...VERSION, frontmatter: accepted }).declared).toEqual({
    status: "ACCEPTED",
    relations: { SUPERSEDES: [] },
  });
});
