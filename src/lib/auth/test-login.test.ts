import { expect, test } from "vitest";
import { testLoginEnabled } from "./test-login";

test('enabled only by an exact "1"', () => {
  expect(testLoginEnabled({ ALLOW_TEST_LOGIN: "1" })).toBe(true);
});

test("disabled when unset — the default a deployment inherits", () => {
  expect(testLoginEnabled({})).toBe(false);
});

test("disabled for every other value, including truthy-looking ones", () => {
  for (const value of ["0", "", "false", "true", "yes", "on", " 1"]) {
    expect(testLoginEnabled({ ALLOW_TEST_LOGIN: value })).toBe(false);
  }
});
