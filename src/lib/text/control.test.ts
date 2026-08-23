import { expect, test } from "vitest";
import { stripControl } from "./control";

// Every control character here is written as an escape, never as a literal. Literal NULs and
// zero-width marks are invisible in a diff, survive copy-paste unpredictably, and this
// project has already had a shell command rejected for carrying one.
const NUL = "\u0000";
const ZWJ = "\u200d";
const RLE = "\u202b";
const PDF = "\u202c";
const C1 = "\u0085"; // NEL, in the C1 block

// Kills: not stripping NUL at all. This is the whole reason the function exists — Postgres
// rejects it with 22021 and the request is byte-identical on every retry.
test("removes NUL, the byte Postgres refuses", () => {
  expect(stripControl(`a${NUL}b`)).toBe("ab");
});

// Kills: dropping newline/tab/return from the allowlist. They carry meaning in a stack trace
// and in Markdown, and they are not what Postgres objects to.
test("keeps newline, tab and carriage return", () => {
  expect(stripControl("a\nb\tc\rd")).toBe("a\nb\tc\rd");
});

// Kills: widening the class to \p{C}. The wider class also matches \p{Cf}, and this project
// shipped exactly that once — the family emoji fell apart into four separate people while
// every NUL test kept passing.
test("leaves ZWJ emoji intact — the strip is Cc, never C", () => {
  const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`;
  expect(stripControl(family)).toBe(family);
  expect(stripControl(family).split(ZWJ)).toHaveLength(4);
});

// Kills: the same widening, in the other shape it damaged — right-to-left text losing the
// marks that give it direction.
test("leaves bidi marks intact, so right-to-left text keeps its direction", () => {
  const bidi = `${RLE}العربية${PDF}`;
  expect(stripControl(bidi)).toBe(bidi);
});

// Kills: matching only the C0 block (e.g. a hand-rolled [\x00-\x1F] range). C1 is part of Cc
// and Postgres is no happier about it.
test("removes the C1 control block as well as C0", () => {
  expect(stripControl(`a${C1}b`)).toBe("ab");
});

// Kills: a non-global regex. Without /g only the first match goes.
test("removes every occurrence, not just the first", () => {
  expect(stripControl(`${NUL}a${NUL}b${NUL}`)).toBe("ab");
});

test("leaves ordinary text untouched", () => {
  expect(stripControl("Hello, 世界 — ok?")).toBe("Hello, 世界 — ok?");
});
