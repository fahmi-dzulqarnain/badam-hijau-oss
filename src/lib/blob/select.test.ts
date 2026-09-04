import { expect, test } from "vitest";
import { devUploadEnabled, memoryStoreEnabled, resolveStoreKind } from "./select";

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

test("memory is refused under any NODE_ENV that is not a known dev one", () => {
  // An ALLOWLIST, not `!== "production"`. Next only DEFAULTS NODE_ENV, so an explicitly set
  // value survives — `NODE_ENV=staging next start` warns and proceeds. Under the inverted
  // guard that combination silently accepted `memory` in a genuinely deployed process.
  //
  // The cast is the point, not a workaround: `@types/node` declares NODE_ENV as
  // `"development" | "production" | "test"`, and the runtime accepts any string at all. The
  // gap between the type and reality is precisely where the bug lived, so the test has to
  // reach past the type to reproduce it.
  for (const NODE_ENV of ["staging", "prod", "Production", "", "qa"]) {
    const env = { BLOB_STORE: "memory", NODE_ENV } as Partial<NodeJS.ProcessEnv>;
    expect(() => resolveStoreKind(env), NODE_ENV).toThrow(/BLOB_STORE="memory"/);
  }
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "development" })).toBe("memory");
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "test" })).toBe("memory");
});

test("devUploadEnabled needs BOTH an exact 1 and the memory store", () => {
  // The route this gates is the only unauthenticated write in the application. Gating it on
  // the memory store alone made it ON by default wherever NODE_ENV was not exactly
  // "production" — the inverse of ALLOW_TEST_LOGIN's discipline. Neither flag alone opens it.
  const dev = { NODE_ENV: "development" } as const;
  expect(devUploadEnabled({ ...dev, BLOB_STORE: "memory", ALLOW_DEV_UPLOAD: "1" })).toBe(true);

  expect(devUploadEnabled({ ...dev, BLOB_STORE: "memory" })).toBe(false);
  expect(devUploadEnabled({ ...dev, BLOB_STORE: "graph", ALLOW_DEV_UPLOAD: "1" })).toBe(false);
  expect(devUploadEnabled({ ALLOW_DEV_UPLOAD: "1" })).toBe(false);
});

test("devUploadEnabled is an exact 1, like ALLOW_TEST_LOGIN, and never throws", () => {
  const base = { NODE_ENV: "development", BLOB_STORE: "memory" } as const;
  for (const value of ["true", "yes", "on", "0", "", " 1", "1 "]) {
    expect(devUploadEnabled({ ...base, ALLOW_DEV_UPLOAD: value }), value).toBe(false);
  }
  // Called on every request to the route, including where BLOB_STORE is missing entirely.
  expect(() => devUploadEnabled({})).not.toThrow();
  expect(() => devUploadEnabled({ BLOB_STORE: "nonsense", ALLOW_DEV_UPLOAD: "1" })).not.toThrow();
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
