import { expect, test } from "vitest";
import { pageHref } from "./href";

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
