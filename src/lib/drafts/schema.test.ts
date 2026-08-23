import { expect, test } from "vitest";
import { draftSaveInput, MAX_DRAFT_BODY_BYTES, TITLE_MAX_LENGTH } from "./schema";

const valid = {
  title: "MQTT contracts",
  markdown: "## Topics\n\nOne namespace.",
  seen: null,
};

test("accepts a minimal save with no prior draft", () => {
  const parsed = draftSaveInput.parse(valid);
  expect(parsed.title).toBe("MQTT contracts");
  expect(parsed.markdown).toBe("## Topics\n\nOne namespace.");
  expect(parsed.seen).toBeNull();
});

/**
 * Kills a schema that types `seen` as a string and hands it to `decideSave` unparsed:
 * `"2026-…".getTime` is not a function, and the endpoint 500s on every second save.
 */
test("parses seen into a Date carrying the same millisecond", () => {
  const iso = "2026-08-23T10:00:00.123Z";
  const parsed = draftSaveInput.parse({ ...valid, seen: iso });
  expect(parsed.seen).toBeInstanceOf(Date);
  expect(parsed.seen?.toISOString()).toBe(iso);
});

/**
 * A missing key is a broken client, not a claim that no draft exists. Reading it as `null`
 * would send `decideSave` down the create path against a draft the client never saw — the
 * exact overwrite the conflict contract refuses.
 */
test("a missing seen is rejected, not read as null", () => {
  const { seen: _seen, ...withoutSeen } = valid;
  expect(draftSaveInput.safeParse(withoutSeen).success).toBe(false);
});

test("rejects a seen that is not a timestamp", () => {
  expect(draftSaveInput.safeParse({ ...valid, seen: "yesterday" }).success).toBe(false);
  expect(draftSaveInput.safeParse({ ...valid, seen: 1_767_000_000_000 }).success).toBe(false);
});

test("strips NUL, which Postgres refuses and which no retry can clear", () => {
  const parsed = draftSaveInput.parse({
    ...valid,
    markdown: "before\u0000after",
    title: "ti\u0000tle",
  });
  expect(parsed.markdown).toBe("beforeafter");
  expect(parsed.title).toBe("title");
});

test("keeps newline, tab and carriage return, which are Markdown structure", () => {
  const parsed = draftSaveInput.parse({
    ...valid,
    markdown: "| a\t| b |\r\n| - | - |\n",
  });
  expect(parsed.markdown).toBe("| a\t| b |\r\n| - | - |\n");
});

/**
 * The mis-sized-fix guard. `\p{C}` is the tempting one-character widening of `\p{Cc}` and it
 * also matches `\p{Cf}` — the zero-width joiner that fuses an emoji sequence into one glyph,
 * and the bidi marks that hold a right-to-left run together. Phase 1 shipped that widening
 * once: the NUL it was aimed at genuinely disappeared, and so did every family emoji.
 *
 * Kills: `/\p{C}/gu` in `stripControl`. The strip is silent, so nothing else would fail.
 */
test("leaves ZWJ emoji and bidi marks intact — the strip is Cc, never C", () => {
  // U+200D ZERO WIDTH JOINER holds this four-person family together; without it the text
  // renders as four separate people.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  // U+202B RIGHT-TO-LEFT EMBEDDING and U+202C POP DIRECTIONAL FORMATTING.
  const bidi = "\u202Bالعربية\u202C";

  const parsed = draftSaveInput.parse({
    ...valid,
    title: `${family} ${bidi}`,
    markdown: `The ${family} lives here, and so does ${bidi}.`,
  });

  expect(parsed.title).toBe(`${family} ${bidi}`);
  expect(parsed.title).toContain("\u200D");
  expect(parsed.markdown).toContain("\u200D");
  expect(parsed.markdown).toContain("\u202B");
  expect(parsed.markdown).toContain("\u202C");
});

/**
 * An editor who clears the title to retype it must not have autosave start failing. A draft
 * with no title is a work in progress; publish is where a title becomes mandatory.
 */
test("accepts an empty title and an empty body without normalising them", () => {
  const parsed = draftSaveInput.parse({ title: "  Draft ", markdown: "", seen: null });
  expect(parsed.title).toBe("  Draft ");
  expect(parsed.markdown).toBe("");
});

test("caps the title so it cannot fill a breadcrumb", () => {
  expect(
    draftSaveInput.safeParse({ ...valid, title: "x".repeat(TITLE_MAX_LENGTH) }).success,
  ).toBe(true);
  expect(
    draftSaveInput.safeParse({ ...valid, title: "x".repeat(TITLE_MAX_LENGTH + 1) }).success,
  ).toBe(false);
});

/**
 * The Phase 1 measurement, restated as an assertion rather than a comment: the byte cap has
 * to admit a document whose character count is a third of it. Kills a cap re-derived from
 * `markdown.length` — which would reject this body at ~349,000 characters while the header
 * it is compared against reads 1,048,575 bytes.
 */
test("the byte cap admits a full-size document in a three-bytes-per-character script", () => {
  const cjk = "字".repeat(300_000);
  expect(new TextEncoder().encode(cjk).length).toBe(900_000);
  expect(new TextEncoder().encode(cjk).length).toBeLessThan(MAX_DRAFT_BODY_BYTES);
  expect(draftSaveInput.safeParse({ ...valid, markdown: cjk }).success).toBe(true);
});

test("ignores client-supplied keys rather than passing them to the repository", () => {
  const parsed = draftSaveInput.parse({
    ...valid,
    pageId: "forged",
    updatedById: "forged",
    baseVersionId: "forged",
  }) as Record<string, unknown>;

  expect(Object.keys(parsed).sort()).toEqual(["markdown", "seen", "title"]);
});
