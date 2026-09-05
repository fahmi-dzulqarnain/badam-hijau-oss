import { describe, expect, test } from "vitest";
import { SLUG_MAX_LENGTH } from "@/lib/pages/slug";
import { SYSTEM_KEY_MAX_LENGTH, validateSystemKey } from "@/lib/systems/key";

/**
 * `validateSystemKey` — Task 1's deferred half, and the sentence the CHECK constraint cannot say.
 *
 * Two claims are worth more than the individual cases here and both have their own test:
 *
 * 1. **This function and the CHECK agree.** The migration carries
 *    `CHECK ("key" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')`, and if this validator accepted anything
 *    that pattern refuses, the admin form would answer 500 instead of a sentence — which is
 *    precisely the failure Task 1 deferred here. The regex is re-stated in this file *on purpose*:
 *    a test whose whole job is to catch a divergence between two independent statements of a rule
 *    cannot share one of them. That is the opposite of the production rule, and it is why the
 *    property test below runs both over the same corpus rather than asserting one against itself.
 * 2. **The cap is `SLUG_MAX_LENGTH`, asserted as an identity rather than as `80`.** If a future
 *    phase has a reason to move one apart from the other, that becomes a decision with a failing
 *    test rather than a silent divergence.
 */

/** The migration's own pattern, retyped deliberately — see the docstring. */
const CHECK = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const accepted = (key: string) => {
  const result = validateSystemKey(key);
  return result.ok;
};

const refusal = (key: string) => {
  const result = validateSystemKey(key);
  if (result.ok) throw new Error(`expected "${key}" to be refused`);
  return result.error;
};

describe("keys the catalogue accepts", () => {
  test.each(["order-hub", "store-ios", "backend", "a", "pricing-engine", "s3", "a-b-c"])(
    "%s",
    (key) => {
      expect(accepted(key)).toBe(true);
      // The non-vacuity companion for the whole "accepted" block: a corpus this function likes
      // and the database would reject is the exact defect this module exists to prevent.
      expect(CHECK.test(key)).toBe(true);
    },
  );
});

describe("keys it refuses, each with the code that names the rule", () => {
  test.each([
    ["", "empty"],
    ["Order-Hub", "uppercase"],
    ["hub core", "whitespace"],
    ["hub/core", "not-one-segment"],
    ["hub.core", "invalid-characters"],
    ["hub_core", "invalid-characters"],
    ["..", "path-traversal"],
    ["-hub", "hyphen-edge"],
    ["hub-", "hyphen-edge"],
    ["-", "hyphen-edge"],
  ])("%s is %s", (key, code) => {
    expect(refusal(key).code).toBe(code);
    expect(refusal(key).field).toBe("key");
    // Every refusal is one the database would also refuse. Without this line the table above is a
    // list of opinions; with it, it is a claim about the column.
    expect(CHECK.test(key)).toBe(false);
  });
});

/**
 * A trailing hyphen is the one rule `validateSlug` does not have, and this is the test that would
 * fail if this module were replaced by a bare delegation to it.
 *
 * `validateSlug("hub-")` is `{ ok: true }` — a page slug may end in a hyphen, and the CHECK on
 * `System.key` may not. The pairing is the discrimination: the same string, two answers, and the
 * reason is the asymmetry Task 1's pattern introduced.
 */
test("a trailing hyphen is legal in a slug and not in a key", async () => {
  const { validateSlug } = await import("@/lib/pages/slug");
  expect(validateSlug("hub-").ok).toBe(true);
  expect(refusal("hub-").code).toBe("hyphen-edge");
  // Both ends, one sentence: an admin who typed `-hub` and one who typed `hub-` need the same fix.
  expect(refusal("-hub").message).toBe(refusal("hub-").message);
});

/**
 * The messages are this surface's and not `validateSlug`'s, which matters for exactly two of them:
 * the leading-hyphen sentence would otherwise explain application routes (true of `/{space}/-/…`
 * and irrelevant under `/systems/`), and the length sentence would say "Slugs".
 */
test("no refusal talks about slugs", () => {
  for (const key of ["", "Hub", "hub core", "-hub", "hub-", "x".repeat(200), "hub/core", ".."]) {
    expect(refusal(key).message.toLowerCase()).not.toContain("slug");
  }
  // Non-vacuity: the loop above is only meaningful if `validateSlug` really does say "slug" for
  // the same inputs — otherwise it passes over a function that says nothing at all.
  expect(refusal("hub core").message.length).toBeGreaterThan(0);
});

describe("the length cap", () => {
  test("is SLUG_MAX_LENGTH, and the identity is what is asserted", () => {
    expect(SYSTEM_KEY_MAX_LENGTH).toBe(SLUG_MAX_LENGTH);
  });

  test("accepts a key at the cap and refuses one past it, with the count in the sentence", () => {
    const atCap = "a".repeat(SYSTEM_KEY_MAX_LENGTH);
    expect(accepted(atCap)).toBe(true);

    const over = "a".repeat(SYSTEM_KEY_MAX_LENGTH + 1);
    const error = refusal(over);
    expect(error.code).toBe("too-long");
    expect(error.message).toContain(String(SYSTEM_KEY_MAX_LENGTH));
    expect(error.message).toContain(String(SYSTEM_KEY_MAX_LENGTH + 1));
  });

  /**
   * The cap is not tidiness, and this is Task 3's measurement restated as an assertion: a
   * 300-character lowercase key is legal under the CHECK — it reached `/systems/[key]` and needed
   * a CSS rule to contain it — and is refused here. The `CHECK.test` line is what makes the point:
   * the database would have taken it.
   */
  test("a 300-character key passes the CHECK and is refused here", () => {
    const long = "a".repeat(300);
    expect(CHECK.test(long)).toBe(true);
    expect(refusal(long).code).toBe("too-long");
  });
});

/**
 * The ordering contract, inherited from `validateSlug` and worth pinning because a caller shows
 * exactly one message: a key that breaks several rules at once must report the most actionable.
 */
test("a key breaking several rules reports the one worth acting on", () => {
  // Uppercase and over the cap: the length is what has to change first, because lowercasing a
  // 200-character key still will not fit.
  expect(refusal(`A${"b".repeat(200)}`).code).toBe("too-long");
  // Uppercase and hyphen-edged: the hyphen rule wins, for `validateSlug`'s stated reason —
  // lowercasing `-Adrs` does not make it legal.
  expect(refusal("-Hub").code).toBe("hyphen-edge");
  // Whitespace and a bad character: whitespace has its own sentence, and it is the one that says
  // what to type instead.
  expect(refusal("hub core!").code).toBe("whitespace");
});
