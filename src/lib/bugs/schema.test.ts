import { expect, test } from "vitest";
import { bugReportInput } from "./schema";

const valid = {
  summary: "The TOC jumps to the wrong heading",
  routePath: "/engineering/decisions/adr-0042-mqtt-topic-naming",
  appVersion: "0.1.0",
  userAgent: "Mozilla/5.0",
  viewport: "1440x900",
};

test("accepts a minimal report", () => {
  expect(bugReportInput.parse(valid).summary).toBe(valid.summary);
});

test("rejects an empty summary", () => {
  expect(bugReportInput.safeParse({ ...valid, summary: "   " }).success).toBe(false);
});

test("caps the summary so a paste cannot fill the column", () => {
  const long = "x".repeat(5001);
  expect(bugReportInput.safeParse({ ...valid, summary: long }).success).toBe(false);
});

test("optional fields default to null rather than undefined", () => {
  const parsed = bugReportInput.parse(valid);
  expect(parsed.expected).toBeNull();
  expect(parsed.consoleError).toBeNull();
});

test("silently ignores client-supplied page context", () => {
  // The client must not be able to attach these. Zod strips unknown keys by default, so
  // this asserts the schema is not accidentally widened to passthrough later.
  const parsed = bugReportInput.parse({
    ...valid,
    pageId: "forged",
    spaceId: "forged",
    versionId: "forged",
  }) as Record<string, unknown>;

  expect(parsed.pageId).toBeUndefined();
  expect(parsed.spaceId).toBeUndefined();
  expect(parsed.versionId).toBeUndefined();
});

test("rejects a report with no route path", () => {
  const { routePath, ...withoutRoute } = valid;
  expect(bugReportInput.safeParse(withoutRoute).success).toBe(false);
});

test("strips a NUL byte, which Postgres would reject outright", () => {
  const parsed = bugReportInput.parse({ ...valid, summary: "before\0after" });
  expect(parsed.summary).toBe("beforeafter");
});

test("keeps newlines and tabs, which carry meaning in a pasted trace", () => {
  const parsed = bugReportInput.parse({ ...valid, summary: "line one\n\tindented" });
  expect(parsed.summary).toBe("line one\n\tindented");
});

test("keeps a zero-width joiner, so emoji sequences survive", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  expect(bugReportInput.parse({ ...valid, summary: family }).summary).toBe(family);
});

test("keeps bidi marks, so right-to-left text keeps its direction", () => {
  const mixed = "\u200F" + "سعر: 5" + "\u200E";
  expect(bugReportInput.parse({ ...valid, summary: mixed }).summary).toBe(mixed);
});
