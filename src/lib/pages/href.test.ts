import { expect, test } from "vitest";
import { MIRROR_FAILURES_PATH, pageHistoryHref, pageHref } from "./href";
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

/**
 * The failures page's address, and the two halves of the argument for it.
 *
 * The path is asserted as a literal because two files name it and the route directory has to
 * agree with the constant — a mismatch is a 404 nothing else in the suite would catch.
 */
test("the mirror failures page lives under the same reserved segment, one level up", () => {
  expect(MIRROR_FAILURES_PATH).toBe("/-/mirror");
  // It is built from the same `RESERVED` constant as the history URL, so the two cannot drift
  // into disagreeing about which character the product reserves.
  expect(pageHistoryHref("engineering", "welcome").split("/")[2]).toBe(
    MIRROR_FAILURES_PATH.split("/")[1],
  );
});

/**
 * The honest limit of that reservation, pinned so it is not read as stronger than it is.
 *
 * `validateSlug` refuses a leading `-`, which is what stops a **page** shadowing `/{space}/-/…`.
 * A **space key** is a bare `String @unique` with no validation anywhere, so `-` protects the
 * top-level route by convention and not by a guard — the collision was measured against a real
 * `next start` with a space actually keyed `-`, and the static route wins. This test says which
 * of the two guarantees exists, so a future reader does not assume the wrong one.
 */
test("the reserved segment binds slugs, and nothing today binds space keys", () => {
  expect(validateSlug("-mirror").ok).toBe(false);
  expect(validateSlug("mirror").ok).toBe(true);
});
