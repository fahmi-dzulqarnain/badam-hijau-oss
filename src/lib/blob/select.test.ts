import { expect, test } from "vitest";
import { memoryStoreEnabled, resolveStoreKind } from "./select";

test("an unset BLOB_STORE refuses to boot rather than guessing", () => {
  // Neither default is safe. "memory" lets a deployment accept uploads and lose them on
  // restart; "graph" breaks every laptop and the smoke test. "Nobody can upload" is a loud
  // failure, which is the same direction ALLOWED_EMAIL_DOMAINS chose.
  expect(() => resolveStoreKind({})).toThrow(/BLOB_STORE/);
  expect(() => resolveStoreKind({ BLOB_STORE: "" })).toThrow(/BLOB_STORE/);
});

test("an unrecognised value is refused, not treated as one of the two", () => {
  expect(() => resolveStoreKind({ BLOB_STORE: "s3" })).toThrow(/BLOB_STORE/);
  expect(() => resolveStoreKind({ BLOB_STORE: "Memory" })).toThrow(/BLOB_STORE/);
});

test("both valid values resolve outside production", () => {
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "development" })).toBe("memory");
  expect(resolveStoreKind({ BLOB_STORE: "graph", NODE_ENV: "production" })).toBe("graph");
});

test("memory is refused in production unless explicitly overridden", () => {
  expect(() => resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "production" })).toThrow(
    /production/,
  );
  expect(
    resolveStoreKind({
      BLOB_STORE: "memory",
      NODE_ENV: "production",
      BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
    }),
  ).toBe("memory");
});

test("the override is an exact 1, like ALLOW_TEST_LOGIN", () => {
  for (const value of ["true", "yes", "0", " 1", ""]) {
    expect(
      () =>
        resolveStoreKind({
          BLOB_STORE: "memory",
          NODE_ENV: "production",
          BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION: value,
        }),
      value,
    ).toThrow(/production/);
  }
});

test("memoryStoreEnabled is false for graph and never throws", () => {
  // The dev upload route asks this on every request, including in a deployment where
  // BLOB_STORE is unset by mistake. It must answer "no", not crash the route.
  expect(memoryStoreEnabled({ BLOB_STORE: "graph" })).toBe(false);
  expect(memoryStoreEnabled({})).toBe(false);
  expect(memoryStoreEnabled({ BLOB_STORE: "memory", NODE_ENV: "test" })).toBe(true);
});
