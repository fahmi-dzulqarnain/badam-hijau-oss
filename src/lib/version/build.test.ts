import { expect, test } from "vitest";
import { buildInfo } from "./build";

test("shortens the git sha to seven characters", () => {
  const info = buildInfo({ GIT_SHA: "df0ef11a9c4e5b6d7f8091a2b3c4d5e6f7081920" });
  expect(info.gitSha).toBe("df0ef11");
  expect(info.label).toBe(`${info.version}+df0ef11`);
});

test("falls back to a dev label when no sha is provided", () => {
  expect(buildInfo({}).label).toMatch(/\+dev$/);
  expect(buildInfo({}).gitSha).toBeNull();
});

test("treats a blank sha as absent", () => {
  expect(buildInfo({ GIT_SHA: "   " }).gitSha).toBeNull();
});

test("reports the package version", () => {
  expect(buildInfo({}).version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("is always marked alpha in this phase", () => {
  expect(buildInfo({}).channel).toBe("alpha");
});

test("reads the ambient environment when called with no argument", () => {
  // Every other test passes an explicit env, so without this the default parameter is
  // never exercised — someone could change it to `{}` and no test would notice, and the
  // production path is precisely the one that relies on it.
  const previous = process.env.GIT_SHA;
  process.env.GIT_SHA = "abcdef1234567";
  try {
    expect(buildInfo().gitSha).toBe("abcdef1");
  } finally {
    if (previous === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = previous;
  }
});
