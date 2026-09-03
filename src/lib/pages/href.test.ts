import { expect, test } from "vitest";
import { pageHistoryHref, pageHref } from "./href";
import { validateSlug } from "./slug";

test("keeps the separators of a multi-segment path and encodes nothing else", () => {
  expect(pageHref("engineering", "architecture/mqtt-contracts/topic-registry")).toBe(
    "/engineering/architecture/mqtt-contracts/topic-registry",
  );
});

test("a space key with no path gives the space root", () => {
  expect(pageHref("engineering")).toBe("/engineering");
});

test("encodes a `#` inside a segment, which would otherwise start a fragment", () => {
  expect(pageHref("engineering", "adr/c#-migration")).toBe(
    "/engineering/adr/c%23-migration",
  );
});

test("encodes a `?` inside a segment, which would otherwise start a query string", () => {
  expect(pageHref("engineering", "faq/why?")).toBe("/engineering/faq/why%3F");
});

test("encodes a space inside a segment", () => {
  expect(pageHref("engineering", "notes/design notes")).toBe(
    "/engineering/notes/design%20notes",
  );
});

test("encodes the space key too", () => {
  expect(pageHref("odd key#1", "welcome")).toBe("/odd%20key%231/welcome");
});

test("encodes every segment, not just the first", () => {
  expect(pageHref("s", "a b/c d/e f")).toBe("/s/a%20b/c%20d/e%20f");
});

test("a single-segment path is not split apart", () => {
  expect(pageHref("handbook", "welcome")).toBe("/handbook/welcome");
});

/* -------------------------------------------------------------------------- */
/* Version history (Task 7)                                                   */
/* -------------------------------------------------------------------------- */

test("a page's history lives under the reserved segment", () => {
  expect(pageHistoryHref("engineering", "architecture/mqtt-contracts")).toBe(
    "/engineering/-/history/architecture/mqtt-contracts",
  );
});

test("the history URL encodes the page path per segment, like the page URL", () => {
  expect(pageHistoryHref("engineering", "adr/c#-migration/why?")).toBe(
    "/engineering/-/history/adr/c%23-migration/why%3F",
  );
});

test("the history URL encodes the space key too", () => {
  expect(pageHistoryHref("odd key#1", "welcome")).toBe(
    "/odd%20key%231/-/history/welcome",
  );
});

/**
 * The two builders agree about the path, which is what makes the history URL derivable from a
 * page URL by a reader as well as by the code. It also pins the thing that would break silently:
 * one builder gaining an encoding rule the other does not.
 */
test("the history URL is the page URL with the reserved segment spliced in", () => {
  const path = "a b/c#d/e?f";
  const page = pageHref("engineering", path);
  expect(pageHistoryHref("engineering", path)).toBe(
    page.replace("/engineering/", "/engineering/-/history/"),
  );
});

/**
 * The guarantee the route stands on, stated where the URL is built: no page path can begin with
 * `-`, so nothing a person creates can occupy this URL. `validateSlug` is what refuses it, with
 * its own error code and its own test; this asserts the two have not drifted apart.
 */
test("no slug can shadow the reserved segment", () => {
  expect(validateSlug("-history").ok).toBe(false);
  expect(validateSlug("-").ok).toBe(false);
  // The non-vacuity companion: a slug that is merely similar is fine, so the refusal above is
  // about the leading character and not about the word.
  expect(validateSlug("history").ok).toBe(true);
});
