import { expect, test } from "vitest";
import {
  dormantNotice,
  frontmatterKeyLine,
  placeErrors,
  publishOutcome,
  readFrontmatterStatus,
  setFrontmatterStatus,
  type PublishError,
} from "./publish";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";

/**
 * The editor's publish surface, unit-tested without a browser — which is the whole reason Task 7
 * pulled `state`, `save` and `scheduler` out of the component and the reason this joined them.
 *
 * The load-bearing claim in this file is that the line scanner agrees with the real parser about
 * what frontmatter is. It is not asserted by hand: `agreesWithTheParser` below runs
 * `splitFrontmatter` — the same declaration the renderer strips with — over every shape and
 * compares. A scanner that drifted from it would point a message at a line the author did not
 * write, which is worse than pointing at nothing.
 */

/** Every document shape that has ever broken a hand-written frontmatter scanner. */
const SHAPES: Record<string, string> = {
  plain: "---\nstatus: PROPOSED\n---\n\n# Topics\n",
  noFrontmatter: "# Topics\n\nEvery topic is namespaced.\n",
  leadingBlankLine: "\n---\nstatus: PROPOSED\n---\n\n# Topics\n",
  openingCodeFence: "```\n---\nstatus: PROPOSED\n---\n```\n",
  setextHeading: "Topics\n---\n\nEvery topic is namespaced.\n",
  unterminated: "---\nstatus: PROPOSED\n\n# Topics\n",
  fourDashes: "----\nstatus: PROPOSED\n----\n\n# Topics\n",
  indentedFence: " ---\nstatus: PROPOSED\n---\n\n# Topics\n",
  dotsAsClose: "---\nstatus: PROPOSED\n...\n\n# Topics\n",
  fenceTrailingSpace: "--- \nstatus: PROPOSED\n--- \n\n# Topics\n",
  crlf: "---\r\nstatus: PROPOSED\r\n---\r\n\r\n# Topics\r\n",
  empty: "",
  onlyFence: "---\n---\n",
};

/** Whether the real parser found a frontmatter block, which is the only authority here. */
function parserSeesFrontmatter(markdown: string): boolean {
  const split = splitFrontmatter(markdown);
  return split.ok ? Object.keys(split.frontmatter).length > 0 : true;
}

test("the scanner finds a status line exactly where the parser finds frontmatter", () => {
  for (const [name, markdown] of Object.entries(SHAPES)) {
    const found = frontmatterKeyLine(markdown, "status") !== null;
    // `onlyFence` is real frontmatter with no keys in it, so the parser says nothing is
    // declared and the scanner correctly finds no line: the two agree that there is no
    // `status:` to point at, which is what this comparison is about.
    expect(found, `${name}`).toBe(parserSeesFrontmatter(markdown) && name !== "onlyFence");
  }
});

test("the three shapes a line scanner guesses wrong all answer null", () => {
  // PROGRESS records these by name. Every one of them has something other than `---` on line 1,
  // and every implementation that `trimStart()`s or scans for the first `---` gets all three
  // wrong — pointing an error message at a line inside the author's prose.
  expect(frontmatterKeyLine(SHAPES.leadingBlankLine!, "status")).toBeNull();
  expect(frontmatterKeyLine(SHAPES.openingCodeFence!, "status")).toBeNull();
  expect(frontmatterKeyLine(SHAPES.setextHeading!, "status")).toBeNull();
});

test("an unterminated block is not frontmatter, so it has no line to point at", () => {
  expect(frontmatterKeyLine(SHAPES.unterminated!, "status")).toBeNull();
});

test("the line is 1-based and names the right key among several", () => {
  const markdown = [
    "---",
    "status: PROPOSED",
    "systems: [order-hub]",
    "supersedes: decisions/adr-0030",
    "---",
    "",
    "# Topics",
    "supersedes: not-a-key-down-here",
    "",
  ].join("\n");

  expect(frontmatterKeyLine(markdown, "status")).toBe(2);
  expect(frontmatterKeyLine(markdown, "systems")).toBe(3);
  // Line 4, not line 8: the body's lookalike is outside the block and must never be pointed at.
  expect(frontmatterKeyLine(markdown, "supersedes")).toBe(4);
  expect(frontmatterKeyLine(markdown, "decides")).toBeNull();
});

test("a key nested under another is not the top-level key", () => {
  const markdown = "---\nsystems:\n  status: PROPOSED\n---\n\nBody.\n";
  expect(frontmatterKeyLine(markdown, "status")).toBeNull();
  expect(frontmatterKeyLine(markdown, "systems")).toBe(2);
});

/* ------------------------------------------------------------------- reading the status ---- */

test("the declared status is read verbatim, quotes and padding aside", () => {
  expect(readFrontmatterStatus("---\nstatus: ACCEPTED\n---\n\nBody.\n")).toBe("ACCEPTED");
  expect(readFrontmatterStatus('---\nstatus: "ACCEPTED"\n---\n\nBody.\n')).toBe("ACCEPTED");
  expect(readFrontmatterStatus("---\nstatus:    ACCEPTED   \n---\n\nBody.\n")).toBe("ACCEPTED");
  expect(readFrontmatterStatus("---\r\nstatus: ACCEPTED\r\n---\r\n\r\nBody.\r\n")).toBe("ACCEPTED");
});

test("a key with nothing after it is not declared, which is how every template ships", () => {
  expect(readFrontmatterStatus("---\nstatus:\n---\n\nBody.\n")).toBeNull();
  expect(readFrontmatterStatus("---\nstatus:   \n---\n\nBody.\n")).toBeNull();
  expect(readFrontmatterStatus("---\nsystems: [order-hub]\n---\n\nBody.\n")).toBeNull();
  expect(readFrontmatterStatus("# Topics\n")).toBeNull();
});

test("a status that is not a status is still read, and not corrected", () => {
  // The picker shows what the document says, including when what it says is wrong. A control
  // that silently displayed something other than the text under it would be the worse failure,
  // and `publishPage` refuses this with a sentence naming the key.
  expect(readFrontmatterStatus("---\nstatus: banana\n---\n\nBody.\n")).toBe("banana");
});

/* ------------------------------------------------------------------- writing the status ---- */

/** What the real parser makes of a document, so a write can be checked rather than eyeballed. */
function declaredStatus(markdown: string): unknown {
  const split = splitFrontmatter(markdown);
  if (!split.ok) throw new Error(`unparseable after the write: ${split.error.message}`);
  return split.frontmatter["status"];
}

test("setting the status rewrites the declared value and nothing else", () => {
  const before = "---\nstatus: PROPOSED\nsystems: [order-hub]\n---\n\n# Topics\n";
  const after = setFrontmatterStatus(before, "ACCEPTED");

  expect(declaredStatus(after)).toBe("ACCEPTED");
  expect(after).toBe("---\nstatus: ACCEPTED\nsystems: [order-hub]\n---\n\n# Topics\n");
});

test("setting the status fills a template's empty key", () => {
  const before = "---\nstatus:\nsupersedes:\n---\n\n# Topics\n";
  const after = setFrontmatterStatus(before, "PROPOSED");

  expect(declaredStatus(after)).toBe("PROPOSED");
  // The other key is left exactly as the author has it: empty, and still theirs to fill in.
  expect(splitFrontmatter(after).ok).toBe(true);
  expect(after).toContain("supersedes:\n");
});

test("setting the status on a block without one inserts it first", () => {
  const after = setFrontmatterStatus("---\nsystems: [order-hub]\n---\n\n# Topics\n", "CURRENT");

  expect(declaredStatus(after)).toBe("CURRENT");
  expect(after).toBe("---\nstatus: CURRENT\nsystems: [order-hub]\n---\n\n# Topics\n");
});

test("setting the status on a document with no frontmatter creates a block above it", () => {
  const before = "# Topics\n\nEvery topic is namespaced.\n";
  const after = setFrontmatterStatus(before, "CURRENT");

  expect(declaredStatus(after)).toBe("CURRENT");
  // Nothing is deleted. The whole of the author's document is still under the block, which is
  // the property that makes this safe to do to text somebody is in the middle of writing.
  expect(after.endsWith(before)).toBe(true);
  // The parser's body is the author's document with the blank line the block was written with
  // still in front of it — `splitFrontmatter` strips only the line ending that terminates the
  // closing fence, and any blank line after it is the author's. It renders identically.
  expect(splitFrontmatter(after).body).toBe(`\n${before}`);
});

test("the three shapes that are not frontmatter get a block, and keep their text", () => {
  // A leading blank line, an opening code fence and a setext heading all look like frontmatter
  // to a careless scanner. Writing INTO them would corrupt a code sample or a heading; each one
  // gets a block of its own above it instead, and every character survives.
  for (const name of ["leadingBlankLine", "openingCodeFence", "setextHeading"] as const) {
    const before = SHAPES[name]!;
    const after = setFrontmatterStatus(before, "CURRENT");
    expect(declaredStatus(after), name).toBe("CURRENT");
    expect(after.endsWith(before), name).toBe(true);
  }
});

test("a CRLF document keeps its line endings", () => {
  const after = setFrontmatterStatus("---\r\nstatus: PROPOSED\r\n---\r\n\r\n# Topics\r\n", "ACCEPTED");
  expect(declaredStatus(after)).toBe("ACCEPTED");
  expect(after).toContain("status: ACCEPTED\r\n");
  expect(after).not.toContain("status: ACCEPTED\n---");
});

test("setting the status twice is the same as setting it once", () => {
  const once = setFrontmatterStatus("# Topics\n", "CURRENT");
  expect(setFrontmatterStatus(once, "CURRENT")).toBe(once);
  // And the second block is never created — the write finds the one it made.
  expect(setFrontmatterStatus(once, "ARCHIVED").split("---").length).toBe(once.split("---").length);
});

/* ------------------------------------------------------------------- placing the errors ---- */

const error = (over: Partial<PublishError>): PublishError => ({
  field: "markdown",
  key: null,
  code: "invalid-relation",
  message: "something is wrong",
  ...over,
});

const DOCUMENT = "---\nstatus: PROPOSED\nsupersedes: decisions/adr-0030\n---\n\n# Topics\n";

test("every error is placed, not only the first", () => {
  // The plan's question, answered: `errors`, not `error`. Two mistyped keys fixed one publish
  // attempt at a time is two round trips to learn two things the server knew on the first.
  const placed = placeErrors(DOCUMENT, [
    error({ key: "status", code: "invalid-status" }),
    error({ key: "supersedes", code: "not-found" }),
  ]);

  expect(placed).toHaveLength(2);
  expect(placed[0]?.placement).toEqual({ kind: "line", line: 2, key: "status" });
  expect(placed[1]?.placement).toEqual({ kind: "line", line: 3, key: "supersedes" });
  // The sentence is carried through untouched: it is the server's, written for the person who
  // has to act on it, and a second copy here would be a worse one.
  expect(placed[0]?.message).toBe("something is wrong");
});

test("a title error goes to the title input, not to a line", () => {
  const [placed] = placeErrors(DOCUMENT, [
    error({ field: "title", code: "title-empty", message: "Give the page a title" }),
  ]);
  expect(placed?.placement).toEqual({ kind: "title" });
});

test("a transition refusal is placed against the status line", () => {
  // `validateTransition` reports `field: "status"` and no key, because it is about a page rather
  // than a document. In this editor the status IS a document line, so it belongs there.
  const [placed] = placeErrors(DOCUMENT, [
    error({ field: "status", key: null, code: "illegal-transition" }),
  ]);
  expect(placed?.placement).toEqual({ kind: "line", line: 2, key: "status" });
});

test("a named key that is not in the document falls back to the key, never to a wrong line", () => {
  const [placed] = placeErrors("# Topics\n", [
    error({ field: "status", key: null, code: "illegal-transition" }),
  ]);
  expect(placed?.placement).toEqual({ kind: "key", key: "status" });
});

test("a refusal with no key at all is placed against the document", () => {
  const [placed] = placeErrors(DOCUMENT, [
    error({ code: "body-empty", message: "This draft is only frontmatter" }),
  ]);
  expect(placed?.placement).toEqual({ kind: "document" });
});

/* ------------------------------------------------------------------------ the outcome ------ */

test("a 200 with an href is a publish, and carries the dormant list", () => {
  const outcome = publishOutcome({
    status: 200,
    body: {
      href: "/engineering/decisions/adr-0031",
      status: "PROPOSED",
      dormant: [
        { type: "SUPERSEDES", key: "supersedes", ref: "decisions/adr-0030", wouldRetireInto: "SUPERSEDED" },
      ],
    },
    markdown: DOCUMENT,
  });

  expect(outcome).toEqual({
    type: "published",
    href: "/engineering/decisions/adr-0031",
    status: "PROPOSED",
    dormant: [
      { key: "supersedes", ref: "decisions/adr-0030", wouldRetireInto: "SUPERSEDED" },
    ],
  });
});

test("a 200 with no usable href is a failure, not a silent success", () => {
  // Navigating nowhere and saying "published" would leave the author believing a page exists
  // that they cannot reach.
  const outcome = publishOutcome({ status: 200, body: { status: "CURRENT" }, markdown: "" });
  expect(outcome.type).toBe("failed");
  expect(outcome.type === "failed" && outcome.message.length).toBeGreaterThan(0);
});

test("a partial dormant entry is dropped rather than rendered with a hole in it", () => {
  const outcome = publishOutcome({
    status: 200,
    body: {
      href: "/engineering/x",
      status: "PROPOSED",
      dormant: [{ key: "supersedes" }, null, "supersedes"],
    },
    markdown: "",
  });
  expect(outcome.type === "published" && outcome.dormant).toEqual([]);
});

test("a 422 is a refusal with every error placed", () => {
  const outcome = publishOutcome({
    status: 422,
    body: {
      error: "invalid",
      field: "markdown",
      key: "supersedes",
      code: "not-found",
      message: "`decisions/adr-0030` names no page in this space.",
      errors: [
        {
          field: "markdown",
          key: "supersedes",
          code: "not-found",
          message: "`decisions/adr-0030` names no page in this space.",
        },
      ],
    },
    markdown: DOCUMENT,
  });

  expect(outcome.type).toBe("refused");
  expect(outcome.type === "refused" && outcome.errors[0]?.placement).toEqual({
    kind: "line",
    line: 3,
    key: "supersedes",
  });
});

test("a 422 that carries only the singular error is still placed", () => {
  // Defence against a server a deploy behind, and against the shape this endpoint had before
  // Task 7 made the errors plural. Dropping the message would leave a blank banner, which is
  // indistinguishable from a publish that worked.
  const outcome = publishOutcome({
    status: 422,
    body: { field: "markdown", key: "status", code: "invalid-status", message: "Not a status." },
    markdown: DOCUMENT,
  });

  expect(outcome.type).toBe("refused");
  expect(outcome.type === "refused" && outcome.errors).toHaveLength(1);
});

test("every other status is a failure carrying a sentence", () => {
  for (const status of [401, 403, 404, 409, 500]) {
    const outcome = publishOutcome({
      status,
      body: { message: "That page does not exist." },
      markdown: "",
    });
    expect(outcome.type, `${status}`).toBe("failed");
    expect(outcome.type === "failed" && outcome.message).toBe("That page does not exist.");
  }
});

test("a failure with no readable body still says something", () => {
  const outcome = publishOutcome({ status: 500, body: null, markdown: "" });
  expect(outcome.type === "failed" && outcome.message).toContain("500");
});

/* ------------------------------------------------------------------------ the notice ------- */

test("nothing dormant is no notice at all", () => {
  expect(dormantNotice([], "ACCEPTED")).toBeNull();
});

test("the notice names the key, the reference, the status it landed on and the one it waits for", () => {
  // The four facts that turn "I said it supersedes ADR-30 and ADR-30 is still current" from a
  // bug report into an explanation. Every one of them comes from the server.
  const notice = dormantNotice(
    [{ key: "supersedes", ref: "decisions/adr-0030", wouldRetireInto: "SUPERSEDED" }],
    "PROPOSED",
  );

  expect(notice?.lead).toContain("PROPOSED");
  expect(notice?.items).toHaveLength(1);
  expect(notice?.items[0]).toContain("supersedes: decisions/adr-0030");
  expect(notice?.items[0]).toContain("SUPERSEDED");
  expect(notice?.items[0]).toContain("unchanged");
});

test("several dormant declarations get one line each", () => {
  const notice = dormantNotice(
    [
      { key: "supersedes", ref: "decisions/adr-0030", wouldRetireInto: "SUPERSEDED" },
      { key: "decides", ref: "proposals/rfc-0004", wouldRetireInto: "CLOSED" },
    ],
    "PROPOSED",
  );

  expect(notice?.items).toHaveLength(2);
  expect(notice?.items[1]).toContain("CLOSED");
  // Plural, because a sentence that says "1 declarations" is the tell nobody proofread it —
  // and this project has already shipped a pluralisation fix that left the word beside it
  // singular.
  expect(notice?.lead).toContain("2 declarations");
});
