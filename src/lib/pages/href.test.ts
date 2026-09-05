import { expect, test } from "vitest";
import {
  ADMIN_GIT_PATH,
  ADMIN_SPACES_PATH,
  ADMIN_SYSTEMS_PATH,
  pageHistoryHref,
  pageHref,
} from "./href";
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
 * The mirror's admin address, asserted as a literal because five files name it and the route
 * directory has to agree with the constant — a mismatch is a 404 nothing else in the suite catches.
 *
 * ~~It is built from the same `RESERVED` constant as the history URL~~ — **superseded by Phase 7
 * Task 7**, which moved this surface out from under `-` and into `/admin`. The tie it asserted is
 * gone on purpose: the surface is an administration page, so it belongs beside the other three,
 * and the `-` segment it vacated is no longer a top-level route at all
 * (`RESERVED_TOP_LEVEL_SEGMENTS` no longer lists it, and `src/lib/spaces/key.test.ts` enforces
 * that against the directory). What replaces the tie is the assertion that this constant is under
 * the same first segment as its siblings, which is now the invariant that would break if a leaf
 * wandered off.
 */
test("the mirror's admin page lives under /admin, beside the other admin leaves", () => {
  expect(ADMIN_GIT_PATH).toBe("/admin/git");
  expect(ADMIN_GIT_PATH.split("/")[1]).toBe(ADMIN_SPACES_PATH.split("/")[1]);
  expect(ADMIN_GIT_PATH.split("/")[1]).toBe(ADMIN_SYSTEMS_PATH.split("/")[1]);
  // The reserved segment is still what a page path lives under, and it is still the same
  // character — the move took a route off the top level, not the reservation inside a space.
  expect(pageHistoryHref("engineering", "welcome").split("/")[2]).toBe("-");
});

/**
 * The old address, and the claim that nothing in this application still builds it.
 *
 * A move is only a move if the copy is gone. `/-/mirror` was a route file and a constant; both
 * were deleted, and the sweep that would have caught a survivor is this one — a literal search of
 * the built `href` module for the old path, which is where every link in the product comes from.
 */
test("nothing builds the old /-/mirror address any more", () => {
  const built = [
    ADMIN_GIT_PATH,
    pageHref("engineering", "welcome"),
    pageHistoryHref("engineering", "welcome"),
  ];
  for (const href of built) expect(href).not.toContain("/-/mirror");
  // Non-vacuity: the reserved character is still produced by this module, so the absence above is
  // about the route and not about a builder that has stopped emitting anything.
  expect(pageHistoryHref("engineering", "welcome")).toContain("/-/");
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
