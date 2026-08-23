import { expect, test } from "vitest";
import { previewInput } from "@/lib/preview/schema";
import { stripControl } from "@/lib/text/control";

const parse = (value: unknown) => previewInput.safeParse(value);

test("a well-formed request parses to the page id and the text", () => {
  const result = parse({ pageId: "page-1", markdown: "# Topics\n\nOne broker." });
  expect(result.success && result.data).toEqual({
    pageId: "page-1",
    markdown: "# Topics\n\nOne broker.",
  });
});

/**
 * The rule that keeps the preview honest. The autosave endpoint stores the *stripped* text,
 * so the version that eventually publishes is the stripped text; a preview rendered from the
 * raw body would be showing output the reader can never produce.
 *
 * Every control character here is an **escape sequence**, never a literal — a literal NUL is
 * invisible in a diff, and this project has already had a shell command rejected for
 * carrying one.
 *
 * Kills: dropping the `.transform(stripControl)`, which is silent for every document anybody
 * would ever notice by eye.
 */
test("control characters are stripped, exactly as the save path strips them", () => {
  const raw = "Head\u0000er\u001b[31m\n\ttabbed\r\nline";
  const result = parse({ pageId: "page-1", markdown: raw });

  expect(result.success && result.data.markdown).toBe("Header[31m\n\ttabbed\r\nline");
  // Not merely "some stripping happened": the same function, so the two surfaces cannot
  // drift into two definitions of which characters survive.
  expect(result.success && result.data.markdown).toBe(stripControl(raw));
});

test("newline, tab and carriage return survive, because Markdown is made of them", () => {
  const raw = "- one\n- two\r\n\t- nested";
  const result = parse({ pageId: "p", markdown: raw });
  expect(result.success && result.data).toEqual({ pageId: "p", markdown: raw });
});

/**
 * `\p{Cc}`, never `\p{C}`. The wider class takes zero-width joiners and bidi marks with it: a
 * family emoji falls apart into three separate people and right-to-left text loses its
 * direction. Phase 1 shipped that version once.
 */
test("zero-width joiners and bidi marks are left alone", () => {
  const raw = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467} and \u202Bwritten right to left\u202C";
  const result = parse({ pageId: "p", markdown: raw });
  expect(result.success && result.data.markdown).toBe(raw);
});

test("an empty document is a legal thing to preview", () => {
  // Someone who selects all and deletes must see an empty preview, not an error banner.
  expect(parse({ pageId: "p", markdown: "" }).success).toBe(true);
});

test("a missing or empty pageId is refused, rather than rendering for nobody in particular", () => {
  // Without a page there is no space, and without a space there is no EDIT check — which
  // would make this an open Markdown-to-HTML service for anyone holding a session.
  expect(parse({ markdown: "hello" }).success).toBe(false);
  expect(parse({ pageId: "", markdown: "hello" }).success).toBe(false);
});

test("a missing markdown key is refused rather than read as an empty document", () => {
  // A broken client that omits the field is not the same as a person who cleared the editor,
  // and answering the first with an empty preview hides the bug.
  expect(parse({ pageId: "p" }).success).toBe(false);
});

test("non-string fields are refused", () => {
  expect(parse({ pageId: "p", markdown: 42 }).success).toBe(false);
  expect(parse({ pageId: { id: "p" }, markdown: "hello" }).success).toBe(false);
  expect(parse(null).success).toBe(false);
});
