import { expect, test } from "vitest";
import { buildInfo } from "@/lib/version/build";
import {
  BUILD_LABEL,
  CONTENT_COMMIT_LABEL,
  NOT_MIRRORED,
  SHA_DISPLAY_LENGTH,
  shortSha,
} from "@/lib/version/labels";

/**
 * The labelling contract for the two shas a reader can see at once.
 *
 * Every assertion here is about the **pair**, which is the whole reason the strings are a module:
 * "the content sha is labelled" is not the property that was broken. What was broken is that the
 * label it had — `Commit` — was equally good as a name for the *other* value on the page, so a
 * reader comparing two never-agreeing shas would conclude the mirror was broken. That is
 * unassertable while each string is a literal in its own component, and it is what these tests
 * fail on.
 */

/** A real 40-character git object name. */
const SHA = "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d";

test("the two shas are labelled with different words, and neither contains the other", () => {
  expect(CONTENT_COMMIT_LABEL).not.toBe(BUILD_LABEL);
  // Substring and not merely inequality: `Commit` and `Build commit` are two different strings
  // and would still leave a reader deciding which "commit" they were looking at.
  expect(CONTENT_COMMIT_LABEL.toLowerCase()).not.toContain(BUILD_LABEL.toLowerCase());
  expect(BUILD_LABEL.toLowerCase()).not.toContain(CONTENT_COMMIT_LABEL.toLowerCase());
});

test("the content sha's label names the repository it belongs to", () => {
  // The failure this replaces, named so the mutation is obvious: the label may not be a bare
  // word that the application build could answer to just as well.
  expect(CONTENT_COMMIT_LABEL).not.toBe("Commit");
  expect(CONTENT_COMMIT_LABEL.toLowerCase()).toContain("content");
});

test("neither label is a value — a label that looked like a sha would be no label", () => {
  for (const label of [CONTENT_COMMIT_LABEL, BUILD_LABEL]) {
    expect(label).not.toMatch(/^[0-9a-f]+$/i);
  }
});

/*
 * The non-vacuity companion the assertions above need.
 *
 * "The two labels are distinguishable" passes just as well when one of them names something the
 * product never shows. `buildInfo()` is the value `BUILD_LABEL` is a label *for*, so this is what
 * fails if the build string ever stops being a version-plus-sha — at which point the whole
 * ambiguity these labels answer would have changed shape and the words would need re-deciding
 * rather than merely keeping.
 */
test("the build label is a label for a real, sha-shaped build string", () => {
  const build = buildInfo({ GIT_SHA: "df0ef11abc" });
  expect(build.label).toBe("0.1.0+df0ef11");
  expect(build.label).toMatch(/\+[0-9a-f]{7}$/);
});

test("a version with no sha says so, and does not promise one", () => {
  expect(NOT_MIRRORED).not.toBe("");
  // The `yet` is the assertion. A `FAILED` job's version will not be mirrored later, and this
  // string is shown for it too — see `NOT_MIRRORED`'s docstring and `listPageVersions`, which is
  // where the three reasons for a null sha are actually told apart.
  expect(NOT_MIRRORED).not.toMatch(/\byet\b/);
  // Not an error, either: an unmirrored version is the expected state for everything published
  // before Phase 5.
  expect(NOT_MIRRORED).not.toMatch(/error|fail/i);
});

test("a 40-character sha is displayed short, and the short form is a prefix of it", () => {
  expect(SHA).toHaveLength(40);
  expect(shortSha(SHA)).toHaveLength(SHA_DISPLAY_LENGTH);
  expect(SHA.startsWith(shortSha(SHA))).toBe(true);
});

test("the displayed length is short enough to be the point of shortening it", () => {
  // The bound that matters is "much shorter than 40", not the exact number — a display form
  // creeping back towards the full object name would re-open the overflow class silently.
  expect(SHA_DISPLAY_LENGTH).toBeLessThan(20);
  // And long enough to be a sha rather than a decoration.
  expect(SHA_DISPLAY_LENGTH).toBeGreaterThan(6);
});

test("shortening is total: a short, empty or odd value is returned rather than thrown on", () => {
  // `gitSha` is a `String?` written by the worker from `git rev-parse HEAD`. A reader surface
  // that threw on an unexpected value would turn a cosmetic surprise into a 500.
  expect(shortSha("")).toBe("");
  expect(shortSha("abc")).toBe("abc");
  expect(shortSha("0000000000000000000000000000000000000000")).toBe("0000000000");
});
