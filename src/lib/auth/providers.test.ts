import { afterEach, expect, test, vi } from "vitest";

/**
 * `testLoginEnabled` is unit-tested next door, but the flag being *parsed* correctly and the
 * provider being *registered* correctly are two different claims, and only the second one
 * stands between a deployment and a passwordless login that inherits a super admin's
 * memberships. Playwright cannot make this check: `webServer.env` sets ALLOW_TEST_LOGIN=1,
 * so every E2E run exercises the flag-on case.
 *
 * The providers array is not exported, so it is observed the way a browser sees it — through
 * the endpoint. `vi.resetModules()` is load-bearing: the config reads the flag once at import
 * time, so a cached module would answer for the previous test's environment.
 */
async function registeredProviderIds(): Promise<string[]> {
  const { handlers } = await import("./config");
  const response = await handlers.GET(
    new Request("http://localhost/api/auth/providers") as never,
  );
  return Object.keys((await (response as Response).json()) as Record<string, unknown>);
}

const original = process.env.ALLOW_TEST_LOGIN;
afterEach(() => {
  vi.doUnmock("./test-login");
  if (original === undefined) delete process.env.ALLOW_TEST_LOGIN;
  else process.env.ALLOW_TEST_LOGIN = original;
});

test("the test-login provider is NOT registered when the flag is off", async () => {
  // The flag is stubbed at the module rather than through the environment, because
  // `config.ts` imports the Prisma client and **importing Prisma loads `.env` into
  // `process.env`** — which sets ALLOW_TEST_LOGIN=1 back again, after the test deleted it
  // and before the config reads it. Measured, not assumed. Any test that clears an env var
  // that also lives in `.env` and then touches Prisma has the same hole.
  vi.resetModules();
  vi.doMock("./test-login", () => ({ testLoginEnabled: () => false }));

  const ids = await registeredProviderIds();
  expect(ids).not.toContain("test-login");
  expect(ids).toContain("company");
});

test('the test-login provider is NOT registered for a truthy-looking "true"', async () => {
  // Genuine end to end of parse-then-wire: dotenv does not overwrite a variable that is
  // already set, so this value survives the Prisma import above.
  vi.resetModules();
  process.env.ALLOW_TEST_LOGIN = "true";

  const ids = await registeredProviderIds();
  expect(ids).not.toContain("test-login");
  expect(ids).toContain("company");
});

test('the test-login provider IS registered for an exact "1"', async () => {
  vi.resetModules();
  process.env.ALLOW_TEST_LOGIN = "1";

  expect(await registeredProviderIds()).toEqual(
    expect.arrayContaining(["company", "test-login"]),
  );
});
