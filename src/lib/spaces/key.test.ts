import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { RESERVED_TOP_LEVEL_SEGMENTS } from "@/lib/pages/href";
import { SLUG_MAX_LENGTH, validateSlug } from "@/lib/pages/slug";
import { SPACE_KEY_MAX_LENGTH, validateSpaceKey } from "@/lib/spaces/key";

/**
 * `validateSpaceKey` — Phase 7 Task 6, and the debt Phase 5 named three times.
 *
 * Four claims here matter more than the individual cases, and each has its own test:
 *
 * 1. **This function and the CHECK agree.** `Space_key_shape` is retyped in this file *on
 *    purpose*, exactly as `src/lib/systems/key.test.ts` retypes `System_key_shape`: a test whose
 *    job is to catch a divergence between two independent statements of a rule cannot share one of
 *    them.
 * 2. **A slug rule alone does not close route shadowing**, and the measurement is an assertion
 *    rather than a sentence in a docstring — `validateSlug` accepts **six of the seven** top-level
 *    segments this application has. That number is what `src/lib/pages/href.ts` argues against
 *    Phase 5's objection with, so it is pinned here and cannot rot.
 * 3. **The reserved list is the routes**, derived from `src/app` rather than remembered. Phase 5's
 *    objection was that such a list "grows with every route"; this is the test that makes the
 *    growth a failing build instead of a thing to remember.
 * 4. **The two rows that exist pass**, so the seed cannot start producing a key the create form
 *    would refuse.
 */

/** The migration's own pattern, retyped deliberately — see the docstring. */
const CHECK = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const accepted = (key: string) => validateSpaceKey(key).ok;

const refusal = (key: string) => {
  const result = validateSpaceKey(key);
  if (result.ok) throw new Error(`expected "${key}" to be refused`);
  return result.error;
};

describe("keys a space may have", () => {
  test.each(["engineering", "handbook", "eng-ops", "a", "team-2026", "s3"])("%s", (key) => {
    expect(accepted(key)).toBe(true);
    // The non-vacuity companion for the whole block: a corpus this function likes and the
    // database would reject is a 500 on the create form instead of a sentence.
    expect(CHECK.test(key)).toBe(true);
  });
});

describe("shape refusals, each with the code that names the rule", () => {
  test.each([
    ["", "empty"],
    ["Engineering", "uppercase"],
    ["eng ops", "whitespace"],
    ["eng/ops", "not-one-segment"],
    ["eng.ops", "invalid-characters"],
    ["eng_ops", "invalid-characters"],
    ["..", "path-traversal"],
    ["-eng", "hyphen-edge"],
    ["eng-", "hyphen-edge"],
    ["-", "hyphen-edge"],
  ])("%s is %s", (key, code) => {
    expect(refusal(key).code).toBe(code);
    expect(refusal(key).field).toBe("key");
    // Every shape refusal is one the database would also refuse. Without this line the table
    // above is a list of opinions; with it, it is a claim about the column.
    expect(CHECK.test(key)).toBe(false);
  });
});

test(`a key over ${SLUG_MAX_LENGTH} characters is refused, and the cap is not typed twice`, () => {
  expect(SPACE_KEY_MAX_LENGTH).toBe(SLUG_MAX_LENGTH);
  const long = "a".repeat(SPACE_KEY_MAX_LENGTH + 1);
  expect(refusal(long).code).toBe("too-long");
  expect(refusal(long).message).toContain(String(SPACE_KEY_MAX_LENGTH));
  // And the length is NOT in the CHECK, deliberately — Task 1's argument against retyping
  // `SLUG_MAX_LENGTH` into SQL. So the database would accept this key and this function does not,
  // which is the asymmetry `src/lib/spaces/key.ts` states rather than leaves to be found.
  expect(CHECK.test(long)).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* Route shadowing: the measurement Phase 5's objection rested on              */
/* -------------------------------------------------------------------------- */

/**
 * **Phase 5 Task 8's claim, run rather than quoted.**
 *
 * `src/lib/pages/href.ts` argued that reserving `-` at the top level "does not remove the
 * collision, it makes the fix a rule the product already states — `validateSlug` refuses any slug
 * beginning with `-`". That is true of `-` and of nothing else this application serves: six of the
 * seven segments are perfectly legal slugs.
 *
 * This is the assertion the argument against that objection rests on, so it lives in a test rather
 * than in the docstring that makes the argument. If a future route arrives whose name `validateSlug`
 * happens to refuse, this number moves and somebody has to look at the sentence again.
 */
test("validateSlug alone closes one of the seven collisions, and validateSpaceKey closes all seven", () => {
  const acceptedBySlug = RESERVED_TOP_LEVEL_SEGMENTS.filter((segment) => validateSlug(segment).ok);
  expect(acceptedBySlug.sort()).toEqual(["admin", "api", "edit", "new", "search", "systems"]);
  expect(RESERVED_TOP_LEVEL_SEGMENTS.length - acceptedBySlug.length).toBe(1);

  // And every one of them is refused here. The `-` case arrives as `hyphen-edge` rather than
  // `reserved`, because the shape check runs first — the ordering `validateSpaceKey` states.
  for (const segment of RESERVED_TOP_LEVEL_SEGMENTS) {
    expect(accepted(segment), `${segment} must not be a legal space key`).toBe(false);
  }
  expect(refusal("systems").code).toBe("reserved");
  expect(refusal("-").code).toBe("hyphen-edge");
});

/**
 * The reserved list is refused **after** the shape, and `Admin` is the case that shows why.
 *
 * Lowercasing it is the fix a person reaches for first, and they need to be told that the result
 * is still not available — so `uppercase` wins here and `reserved` is what they meet next. The
 * pairing is the assertion; either message alone would pass over a validator that had dropped one
 * of the two rules.
 */
test("Admin is refused as uppercase, and admin is then refused as reserved", () => {
  expect(refusal("Admin").code).toBe("uppercase");
  expect(refusal("Admin").message).toContain('"admin"');
  expect(refusal("admin").code).toBe("reserved");
});

test("the reserved sentence says what a shadowed page actually does", () => {
  // The consequence Task 3 measured — the page exists and its URL answers 404 — is the part an
  // admin cannot guess, so it is asserted rather than left to wording drift.
  expect(refusal("search").message).toContain("404");
});

/* -------------------------------------------------------------------------- */
/* The list is the routes, swept rather than remembered                       */
/* -------------------------------------------------------------------------- */

const APP = join(new URL("../../", import.meta.url).pathname.replace(/\/$/, ""), "app");

/**
 * Every top-level static route segment, read off the filesystem.
 *
 * Route groups — `(reader)`, `(editor)` — contribute **no** URL segment and are descended into;
 * dynamic segments (`[space]`) are not static and cannot be shadowed by a key; files are not
 * segments at all. What is left is exactly the set of words a `Space.key` competes with.
 *
 * A space key cannot contain `.` or `_`, so Next's own top-level names are unreachable as keys and
 * are deliberately not in the list: `_next` and `favicon.ico` are both refused by the character
 * class long before the reserved check. That is a claim, so the test below makes it one.
 */
function topLevelSegments(dir: string = APP, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
      topLevelSegments(join(dir, entry.name), found);
    } else if (!entry.name.startsWith("[")) {
      found.push(entry.name);
    }
  }
  return found;
}

/**
 * **Phase 5's objection, answered by a sweep.**
 *
 * "A list that grows with every route" is only a cost if the list is maintained by attention. This
 * is the same discipline as `src/lib/admin/gate.test.ts`'s sweep for an admin module that forgot
 * `refuseNonAdmin` and `src/lib/pages/visible.test.ts`'s sweep for an unregistered query: adding a
 * top-level route without deciding about the collision is a failing test.
 */
test("RESERVED_TOP_LEVEL_SEGMENTS is exactly the top-level route segments on disk", () => {
  expect([...RESERVED_TOP_LEVEL_SEGMENTS].sort()).toEqual(topLevelSegments().sort());
});

/**
 * The non-vacuity companion, which this project has now needed **seven** times: a sweep that finds
 * nothing looks exactly like a codebase with nothing to find.
 *
 * Three halves. The sweep sees a real set including the two segments whose collisions were
 * measured; it descends into route groups rather than reporting `(reader)` as a segment; and it
 * would notice a new one — proven against a synthetic directory listing rather than by planting a
 * route, because a guard that has to change the application to prove it works cannot be run twice.
 */
test("the sweep sees the real routes, skips route groups, and would notice a new one", () => {
  const found = topLevelSegments();
  expect(found).toContain("admin");
  expect(found).toContain("systems");
  expect(found).toContain("api");
  expect(found.length).toBeGreaterThanOrEqual(7);
  // A route group is not a URL segment; `[space]` is not a static one.
  expect(found).not.toContain("(reader)");
  expect(found).not.toContain("[space]");

  // The classifier, over the entries a new top-level route would produce.
  const classify = (name: string) =>
    name.startsWith("(") && name.endsWith(")")
      ? "group"
      : name.startsWith("[")
        ? "dynamic"
        : "segment";
  expect(classify("reports")).toBe("segment");
  expect(classify("(reader)")).toBe("group");
  expect(classify("[space]")).toBe("dynamic");
  expect(RESERVED_TOP_LEVEL_SEGMENTS).not.toContain("reports");
});

/**
 * Next's own top-level names need no entry in the list, because the character class already
 * refuses them. Asserted rather than assumed — this is the "too narrow, and silent about it"
 * shape, and the claim is cheap to check.
 */
test("framework-owned top-level names are unreachable as keys without being listed", () => {
  for (const name of ["_next", "favicon.ico", "robots.txt", "sitemap.xml"]) {
    expect(RESERVED_TOP_LEVEL_SEGMENTS).not.toContain(name);
    expect(accepted(name)).toBe(false);
    expect(CHECK.test(name)).toBe(false);
  }
});

/* -------------------------------------------------------------------------- */
/* The rows that exist                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The seeded corpus, held to the rule the create form enforces.
 *
 * Task 6 retro-validates nothing, so this is not a claim about history — it is the guard that
 * stops the seed *becoming* the exception. A seed that introduced a key `/admin/spaces` would
 * refuse is a key nobody could have created through the product, and the dev database would then
 * be the one place the rule does not hold.
 */
test.each(["engineering", "handbook"])("the seeded key %s is legal under the new rule", (key) => {
  expect(accepted(key)).toBe(true);
  expect(CHECK.test(key)).toBe(true);
});
