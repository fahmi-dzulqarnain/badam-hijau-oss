import { expect, test } from "vitest";
import { foldSystemKey } from "@/lib/systems/resolve";

/**
 * The one pure decision in `src/lib/systems/resolve.ts`.
 *
 * The resolution itself needs a catalogue and is tested through publish, in
 * `tests/integration/publish.test.ts`. What can be asserted without a database is the fold — and
 * it is asserted here rather than left to the integration test because it is a *decision* (fold
 * the author's case, rather than refuse a capital letter) and because one of its two properties
 * has no database case at all: `toLocaleLowerCase` cannot be distinguished from `toLowerCase` by
 * any test that runs in this repository's locale, so the difference has to be pinned on the
 * inputs where the two disagree.
 */

test("a system key is folded to lower case", () => {
  expect(foldSystemKey("Order-Hub")).toBe("order-hub");
  expect(foldSystemKey("ORDER-HUB")).toBe("order-hub");
  // Already folded: the common case must be the identity, or every key in the catalogue would
  // have to be re-checked against a transformation.
  expect(foldSystemKey("order-hub")).toBe("order-hub");
});

/**
 * Folding is **locale-independent**, which is the half a same-locale test cannot see.
 *
 * `"I".toLocaleLowerCase("tr")` is `"ı"` — a character `systems_key_shape` forbids — so a
 * deployment whose default locale is Turkish would resolve `systems: [store-IOS]` to a key no row
 * can hold, while every other deployment resolved it to `store-ios`. The same document would
 * publish in one place and be refused in the other, and nothing in the corpus or the suite would
 * say why.
 *
 * `String.prototype.toLowerCase` is specified as locale-independent, so this assertion is what
 * fails if the implementation ever picks up an argument or switches to the locale-sensitive form:
 * `toLocaleLowerCase("tr")` on the left-hand side gives `"ıos"` and not `"ios"`.
 */
test("folding does not depend on the ambient locale", () => {
  expect(foldSystemKey("IOS")).toBe("ios");
  expect(foldSystemKey("IOS")).not.toBe("IOS".toLocaleLowerCase("tr"));
});

/**
 * Folding is not trimming, and not cleaning up anything else.
 *
 * `systemsSchema` already refuses a key with leading or trailing whitespace, so this function has
 * no whitespace case to handle — and if it started trimming, that refusal would become
 * unreachable while the same string got two different treatments depending on which layer saw it
 * first. That is the `Space.key` shape: the same value normalised in several places by habit.
 *
 * A key that folds to something the CHECK forbids simply matches no row and is refused with the
 * unknown-system message, which is the honest answer — it names no system.
 */
test("folding changes nothing but case", () => {
  expect(foldSystemKey(" order-hub ")).toBe(" order-hub ");
  expect(foldSystemKey("hub core")).toBe("hub core");
  expect(foldSystemKey("hub_core")).toBe("hub_core");
  expect(foldSystemKey("")).toBe("");
});
