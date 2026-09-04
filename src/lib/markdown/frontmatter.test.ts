import { expect, test } from "vitest";
import {
  MAX_FRONTMATTER_BYTES,
  MAX_FRONTMATTER_DEPTH,
  MAX_FRONTMATTER_ENTRIES,
  serializeFrontmatter,
  splitFrontmatter,
} from "./frontmatter";
import { renderMarkdown } from "./render";

/** The exact input from the plan's "A bug this phase inherits". */
const BUG_INPUT =
  "---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\n# Title\n\nBody.\n";

function frontmatterOf(text: string): Record<string, unknown> {
  const result = splitFrontmatter(text);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.frontmatter;
}

function bodyOf(text: string): string {
  return splitFrontmatter(text).body;
}

function errorOf(text: string) {
  const result = splitFrontmatter(text);
  if (result.ok) throw new Error("expected a rejection");
  return result.error;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

test("reads the keys and returns the body without the block", () => {
  const result = splitFrontmatter(BUG_INPUT);

  expect(result).toEqual({
    ok: true,
    frontmatter: { status: "ACCEPTED", supersedes: "decisions/adr-0031" },
    body: "\n# Title\n\nBody.\n",
  });
});

test("a document with no frontmatter is not an error", () => {
  const text = "# Title\n\nBody.\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

test("empty frontmatter is an empty object, not a failure", () => {
  // A template the author has not filled in yet. `yaml` parses this to `null`.
  expect(splitFrontmatter("---\n---\n\n# Title\n")).toEqual({
    ok: true,
    frontmatter: {},
    body: "\n# Title\n",
  });
});

test("frontmatter with no body leaves an empty body", () => {
  expect(splitFrontmatter("---\nstatus: DRAFT\n---\n")).toEqual({
    ok: true,
    frontmatter: { status: "DRAFT" },
    body: "",
  });
  expect(splitFrontmatter("---\nstatus: DRAFT\n---")).toEqual({
    ok: true,
    frontmatter: { status: "DRAFT" },
    body: "",
  });
});

test("`---` inside a fenced code block is not frontmatter", () => {
  // The case that breaks every regex implementation of this: an author showing a reader what
  // an ADR header looks like. Stripping it would delete content from the page.
  const text = "# Title\n\n```yaml\n---\nstatus: NOT_FRONTMATTER\n---\n```\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

test("a code fence opening the document is not frontmatter either", () => {
  const text = "```\n---\na: 1\n---\n```\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

test("`---` used as a real thematic break mid-document is left alone", () => {
  const text = "# Title\n\nBefore.\n\n---\n\nAfter.\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

test("a blank line above the `---` demotes it to a thematic break", () => {
  // Frontmatter is the first node or it is not frontmatter. Inherited from micromark rather
  // than restated here, which is the point of parsing instead of matching.
  const text = "\n---\na: 1\n---\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

test("CRLF line endings parse", () => {
  const text =
    "---\r\nstatus: ACCEPTED\r\nrelated:\r\n  - a\r\n  - b\r\n---\r\n\r\n# Title\r\n";
  expect(splitFrontmatter(text)).toEqual({
    ok: true,
    frontmatter: { status: "ACCEPTED", related: ["a", "b"] },
    body: "\r\n# Title\r\n",
  });
});

test("a setext h1 is a heading, not frontmatter", () => {
  const text = "Title\n---\n\nBody\n";
  expect(splitFrontmatter(text)).toEqual({ ok: true, frontmatter: {}, body: text });
});

// ---------------------------------------------------------------------------
// The stripper and the parser agree
// ---------------------------------------------------------------------------

/**
 * Every shape that has ever broken an implementation of this, run through both halves.
 *
 * The assertion is the invariant itself: rendering the **source** — where the pipeline does the
 * stripping — must produce byte-identical HTML to rendering the **body** the parser handed
 * back, where the stripping already happened. Anything the two halves disagree about shows up
 * here as different HTML, whichever direction the disagreement runs.
 */
const SHAPES: Record<string, string> = {
  "no frontmatter": "# Title\n\nSome prose.\n",
  "normal frontmatter": BUG_INPUT,
  "empty frontmatter": "---\n---\n\n# Title\n",
  "frontmatter only": "---\nstatus: DRAFT\n---\n",
  "frontmatter with no trailing newline": "---\nstatus: DRAFT\n---",
  "--- in a fenced code block": "# Title\n\n```yaml\n---\na: 1\n---\n```\n",
  "a code fence opening the document": "```\n---\na: 1\n---\n```\n",
  "--- as a thematic break": "# Title\n\nBefore.\n\n---\n\nAfter.\n",
  "frontmatter then a thematic break": "---\na: 1\n---\n\n---\n\n# Title\n",
  "a blank line above the ---": "\n---\na: 1\n---\n",
  "CRLF": "---\r\nstatus: ACCEPTED\r\n---\r\n\r\n# Title\r\n\r\nBody.\r\n",
  "a GFM table below frontmatter":
    "---\na: 1\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
  "a setext h1": "Title\n---\n\nBody\n",
  "malformed frontmatter": "---\nstatus: [unclosed\n---\n\n# Title\n",
  "a list at the top level": "---\n- a\n- b\n---\n\n# Title\n",
};

test.for(Object.entries(SHAPES))(
  "the renderer strips exactly what the parser consumes: %s",
  async ([, source]) => {
    const fromSource = await renderMarkdown(source);
    const fromBody = await renderMarkdown(bodyOf(source));

    expect(fromBody.html).toBe(fromSource.html);
    expect(fromBody.headings).toEqual(fromSource.headings);
  },
);

// ---------------------------------------------------------------------------
// Malformed input never throws
// ---------------------------------------------------------------------------

test("malformed YAML is a field error, not an exception", () => {
  // Autosave fires every two seconds; this is what "mid-keystroke" looks like on the wire.
  const error = errorOf("---\nstatus: [unclosed\n---\n\n# Title\n");

  expect(error.field).toBe("markdown");
  expect(error.code).toBe("frontmatter-unparseable");
  expect(error.message).toMatch(/not valid YAML/);
});

test("the unparseable message names a line in the document, not in the block", () => {
  // The YAML block starts on the document's line 2, so a `yaml` error reported at its line 2
  // is the document's line 3. Off by one here points the editor's cursor at the wrong row.
  const error = errorOf("---\nok: 1\nbad: [unclosed\n---\n\n# Title\n");
  expect(error.message).toMatch(/line 3\b/);
});

test("every stage of a half-typed key is survivable", () => {
  // Each prefix of a line an author is in the middle of typing. None may throw; the ones that
  // happen to be valid YAML are fine too — the point is the absence of an exception.
  const typing = "---\nsupersedes: decisions/adr-0031\n---\n\n# Title\n";
  for (let i = 0; i <= typing.length; i++) {
    expect(() => splitFrontmatter(typing.slice(0, i))).not.toThrow();
  }
});

test("duplicate keys are rejected rather than silently resolved", () => {
  // `supersedes:` twice is an author who believes both relations exist. YAML picks the last.
  expect(errorOf("---\na: 1\na: 2\n---\n").code).toBe("frontmatter-unparseable");
});

test("a top-level list or scalar is not frontmatter", () => {
  expect(errorOf("---\n- a\n- b\n---\n\n# T\n").code).toBe("frontmatter-not-a-map");
  expect(errorOf("---\njust a string\n---\n\n# T\n").code).toBe("frontmatter-not-a-map");
});

test("a rejection still carries the body", () => {
  // The body is previewable whether or not the metadata parsed, and the renderer strips the
  // broken block either way.
  const result = splitFrontmatter("---\nstatus: [unclosed\n---\n\n# Title\n");
  expect(result.ok).toBe(false);
  expect(result.body).toBe("\n# Title\n");
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

test("an oversized frontmatter block is rejected, counted in UTF-8 bytes", () => {
  // 6,000 CJK characters: 6,000 UTF-16 units, which is comfortably UNDER the limit by
  // `String.length`, and 18,000 bytes, which is over it. Phase 1's bug endpoint shipped
  // exactly this mistake once — a byte cap checked against a character count.
  const raw = `a: ${"桁".repeat(6_000)}`;
  expect(raw.length).toBeLessThan(MAX_FRONTMATTER_BYTES);
  expect(new TextEncoder().encode(raw).length).toBeGreaterThan(MAX_FRONTMATTER_BYTES);

  expect(errorOf(`---\n${raw}\n---\n`).code).toBe("frontmatter-too-large");
});

test("a large but legal frontmatter block is accepted", () => {
  const raw = `a: ${"x".repeat(MAX_FRONTMATTER_BYTES - 3)}`;
  expect(new TextEncoder().encode(raw).length).toBe(MAX_FRONTMATTER_BYTES);
  expect(frontmatterOf(`---\n${raw}\n---\n`)).toHaveProperty("a");
});

/** Frontmatter nested exactly `levels` collections deep: the root map, then flow maps. */
const nest = (levels: number) =>
  `---\na: ${"{a: ".repeat(levels - 1)}1${"}".repeat(levels - 1)}\n---\n`;

test("nesting deeper than the cap is rejected", () => {
  expect(frontmatterOf(nest(MAX_FRONTMATTER_DEPTH))).toBeTruthy();
  expect(errorOf(nest(MAX_FRONTMATTER_DEPTH + 1)).code).toBe("frontmatter-too-deep");
});

test("deep nesting parses cleanly, so the cap is the only guard", () => {
  // 200 levels produce no YAML error at all — the library will build whatever it is given,
  // and a walk without a depth budget would recurse all 200 of them.
  expect(errorOf(nest(200)).code).toBe("frontmatter-too-deep");
});

test("too many entries is rejected", () => {
  const keys = (n: number) =>
    `---\n${Array.from({ length: n }, (_, i) => `k${i}: 1`).join("\n")}\n---\n`;

  expect(Object.keys(frontmatterOf(keys(MAX_FRONTMATTER_ENTRIES)))).toHaveLength(
    MAX_FRONTMATTER_ENTRIES,
  );
  expect(errorOf(keys(MAX_FRONTMATTER_ENTRIES + 1)).code).toBe(
    "frontmatter-too-many-entries",
  );
});

test("list items count toward the entry cap, not only mapping keys", () => {
  // The hole a key-only count leaves open: this document has exactly ONE key and a depth of
  // two, so a cap that counted keys — or depth — would wave it through.
  const items = Array.from({ length: MAX_FRONTMATTER_ENTRIES }, (_, i) => i).join(",");
  const list = `---\nrelated: [${items}]\n---\n`;

  // One key plus MAX items is one over the budget.
  expect(errorOf(list).code).toBe("frontmatter-too-many-entries");
});

test("a YAML anchor bomb is rejected instead of expanding", () => {
  // Billion laughs. No syntax errors, tiny on the wire, and it only becomes enormous during
  // expansion — so the structural walk never gets a value to walk.
  const letters = "abcdefghij";
  const nine = (name: string) => Array(9).fill(`*${name}`).join(",");
  let bomb = "a: &a [x,x,x,x,x,x,x,x,x]\n";
  for (let i = 1; i < letters.length; i++) {
    bomb += `${letters[i]}: &${letters[i]} [${nine(letters[i - 1]!)}]\n`;
  }

  expect(errorOf(`---\n${bomb}---\n`).code).toBe("frontmatter-too-many-entries");
});

test("frontmatter that refers to itself is rejected, and does not hang", () => {
  // Two lines, no YAML errors, and the resulting JS object is self-referential —
  // `JSON.stringify` throws on it, so without this it would reach the `Json` column and turn
  // an input problem into a 500 on autosave.
  const result = splitFrontmatter("---\na: &anchor\n  b: *anchor\n---\n");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("frontmatter-cyclic");
});

test("a `__proto__` key does not reach Object.prototype", () => {
  const parsed = frontmatterOf("---\n__proto__:\n  polluted: yes\nstatus: DRAFT\n---\n");

  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(parsed.status).toBe("DRAFT");
});

// ---------------------------------------------------------------------------
// serializeFrontmatter — the writer, and the library behaviours it relies on
// ---------------------------------------------------------------------------

test("a written block is read back by the parser beside it, values intact", () => {
  // The property the whole file exists for, in one line: one grammar, both directions. Nothing
  // reads the mirror back in production, so this test is the only place the two halves meet.
  const block = serializeFrontmatter({ title: "Topic registry", status: "PROPOSED" });

  expect(block).toBe("---\ntitle: Topic registry\nstatus: PROPOSED\n---\n");
  expect(frontmatterOf(`${block}Body.\n`)).toEqual({
    title: "Topic registry",
    status: "PROPOSED",
  });
  expect(bodyOf(`${block}Body.\n`)).toBe("Body.\n");
});

test("keys are written in insertion order, not sorted", () => {
  // Kills: `sortMapEntries` turning on. The mirror's key order is a design decision about a
  // diff a human reads, and alphabetical would scatter its groups.
  expect(serializeFrontmatter({ zebra: 1, apple: 2, mango: 3 })).toBe(
    "---\nzebra: 1\napple: 2\nmango: 3\n---\n",
  );
});

test("an object met twice is written out in full, never as an anchor and an alias", () => {
  // Kills: dropping `aliasDuplicateObjects: false`. `yaml`'s default emits `&a1`/`*a1` here,
  // which is valid YAML that a naive reader chokes on — and, worse for a git mirror, makes the
  // output depend on object **identity** rather than value: the two calls below would then
  // disagree, and the mirror would produce a diff for content nobody changed.
  const shared = ["decisions/adr-0031"];
  const byIdentity = serializeFrontmatter({ supersedes: shared, related: shared });
  const byValue = serializeFrontmatter({
    supersedes: ["decisions/adr-0031"],
    related: ["decisions/adr-0031"],
  });

  expect(byIdentity).toBe(byValue);
  expect(byIdentity).toBe(
    "---\nsupersedes:\n  - decisions/adr-0031\nrelated:\n  - decisions/adr-0031\n---\n",
  );
  expect(byIdentity).not.toContain("&");
  expect(byIdentity).not.toContain("*");
});

test("a long scalar is written on one line, not folded", () => {
  // Kills: `lineWidth` back to its default of 80, which breaks a long value across continuation
  // lines. That round trips correctly and still costs: a one-character edit to a long title
  // re-flows every line after it, so the diff reports far more than changed.
  const long = `word ${"long ".repeat(40)}`.trim();
  const block = serializeFrontmatter({ title: long });

  expect(block.split("\n")).toHaveLength(4); // fence, one key, fence, and the trailing empty
  expect(frontmatterOf(`${block}Body.\n`).title).toBe(long);
});

test("a cyclic value is refused, not quietly written as an anchor", () => {
  // The honest cost of the option above: with aliases off, `yaml` recurses until the stack goes
  // instead of writing `&a1`. Nothing can hand one over from a row — Prisma writes the `Json`
  // column through `JSON.stringify`, which throws on a cycle, and `splitFrontmatter` rejects
  // `frontmatter-cyclic` at publish — so a throw is the honest report of a programming error.
  //
  // Kills the same mutant as the test above, from the other side: with the default, this call
  // succeeds and writes an anchor.
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;

  expect(() => serializeFrontmatter(cyclic as never)).toThrow();
});

test("the values that are nearly JSON, one row at a time", () => {
  // Library behaviours this module's callers rely on, so they get a test rather than a claim —
  // the same reason the `__proto__` case above has one. Only the first row is inside
  // `FrontmatterValue`; the others are pinned because a caller with a `Date` in hand would
  // otherwise discover the answer in a mirrored file.
  expect(serializeFrontmatter({ a: undefined, b: 1 })).toBe("---\nb: 1\n---\n");
  expect(serializeFrontmatter({ a: [undefined, 1] as never })).toBe(
    "---\na:\n  - null\n  - 1\n---\n",
  );

  const date = new Date("2026-08-26T09:00:00.000Z");
  const written = serializeFrontmatter({ at: date as never });
  expect(written).toBe("---\nat: 2026-08-26T09:00:00.000Z\n---\n");
  // A `Date` goes in and a **string** comes back: YAML 1.2's core schema has no timestamp tag.
  // That is why `mirrorDocumentOf` formats its own ISO string rather than passing the object.
  expect(frontmatterOf(`${written}Body.\n`).at).toBe("2026-08-26T09:00:00.000Z");
  expect(frontmatterOf(`${written}Body.\n`).at).not.toBeInstanceOf(Date);
});

test("an empty map is still a block, and reads back as empty frontmatter", () => {
  // Not a state the mirror can reach — its block always has nine keys — but the flow-collection
  // `{}` is what `yaml` writes here, and a fence wrapping nothing would be a broken file.
  expect(serializeFrontmatter({})).toBe("---\n{}\n---\n");
  expect(frontmatterOf(serializeFrontmatter({}))).toEqual({});
});
