import { describe, expect, test } from "vitest";
import { isAllowedSignIn, parseAllowedDomains } from "./gate";

const allowed = ["company.example", "contractors.company.example"];

describe("isAllowedSignIn", () => {
  test("admits a listed domain", () => {
    expect(isAllowedSignIn({ email: "aisyah@company.example" }, allowed)).toBe(true);
  });

  test("rejects an unlisted domain", () => {
    expect(isAllowedSignIn({ email: "stranger@gmail.com" }, allowed)).toBe(false);
  });

  test("fails closed when the allowlist is empty", () => {
    expect(isAllowedSignIn({ email: "aisyah@company.example" }, [])).toBe(false);
  });

  test("rejects an explicitly unverified email", () => {
    expect(
      isAllowedSignIn({ email: "root@company.example", emailVerified: false }, allowed),
    ).toBe(false);
  });

  test("accepts a provider that omits email_verified", () => {
    expect(
      isAllowedSignIn({ email: "root@company.example", emailVerified: undefined }, allowed),
    ).toBe(true);
  });

  test("matches domain and email case-insensitively", () => {
    expect(isAllowedSignIn({ email: "Aisyah@Company.Example" }, allowed)).toBe(true);
  });

  test("rejects a missing or blank email", () => {
    expect(isAllowedSignIn({ email: null }, allowed)).toBe(false);
    expect(isAllowedSignIn({ email: "   " }, allowed)).toBe(false);
  });

  test("rejects a value with no domain part", () => {
    expect(isAllowedSignIn({ email: "notanemail" }, allowed)).toBe(false);
  });

  test("does not match a domain by suffix", () => {
    expect(isAllowedSignIn({ email: "x@evilcompany.example" }, allowed)).toBe(false);
  });
});

describe("parseAllowedDomains", () => {
  test("trims, lowercases and drops empties", () => {
    expect(parseAllowedDomains(" Company.Example , ,contractors.co ")).toEqual([
      "company.example",
      "contractors.co",
    ]);
  });

  test("an unset variable yields an empty list, which denies everyone", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
  });
});
