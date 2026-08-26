import { afterEach, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

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
 *
 * **The request is a `NextRequest`, and that is the fix for a real flake rather than a
 * detail.** It used to be a plain `Request` behind an `as never` cast. next-auth wraps every
 * incoming request through `reqWithEnvURL`, which is a no-op when `AUTH_URL` is unset and
 * destructures `req.nextUrl` when it is set — and a plain `Request` has no `nextUrl`, so the
 * handler threw `TypeError: Cannot destructure property 'href' of 'req.nextUrl'`.
 *
 * That made these three tests pass or fail on **file scheduling**. `.env.test` did not define
 * `AUTH_URL`, but importing Prisma loads `.env` into `process.env` (the same trap the first
 * test below documents for ALLOW_TEST_LOGIN), and `.env` does define it. So whether `AUTH_URL`
 * was set by the time these ran depended on whether some other file in the same worker had
 * imported Prisma first. Measured: the same commit gave 827/827 on one run and 824/827 on the
 * next two, with no change in between.
 *
 * A `NextRequest` is also what the App Router actually hands a route handler, so this raises
 * fidelity rather than working around anything: the test now exercises the same wrapping
 * production does, and the cast is gone because the type finally matches.
 *
 * Note the throw was **synchronous** — `handlers.GET(...)` threw before returning a promise —
 * so a `rejects.toThrow` assertion would not have caught it either.
 */
async function registeredProviderIds(): Promise<string[]> {
  const { handlers } = await import("./config");
  const response = await handlers.GET(new NextRequest("http://localhost/api/auth/providers"));
  return Object.keys((await response.json()) as Record<string, unknown>);
}

const originalFlag = process.env.ALLOW_TEST_LOGIN;
const originalAuthUrl = process.env.AUTH_URL;

function restore(name: "ALLOW_TEST_LOGIN" | "AUTH_URL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  vi.doUnmock("./test-login");
  restore("ALLOW_TEST_LOGIN", originalFlag);
  restore("AUTH_URL", originalAuthUrl);
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

test("the endpoint answers with AUTH_URL set, which is every deployment", async () => {
  // The regression guard for the flake described in this file's docstring, and the reason it
  // cannot come back silently. The three tests above do not set `AUTH_URL`, so on their own
  // they would go back to passing or failing on whatever else loaded first. This one sets it
  // explicitly, so reverting `registeredProviderIds` to a plain `Request` fails HERE,
  // deterministically, on every run and in every file order.
  //
  // `AUTH_URL` is set in every deployed environment — it is what pins the OIDC redirect_uri
  // against a forwarded Host header — so the configuration this asserts is the normal one,
  // not an edge case.
  vi.resetModules();
  process.env.AUTH_URL = "http://localhost:3000";
  process.env.ALLOW_TEST_LOGIN = "1";

  expect(await registeredProviderIds()).toEqual(
    expect.arrayContaining(["company", "test-login"]),
  );
});

test("the endpoint answers with AUTH_URL absent, which is how the test env used to be", async () => {
  // The other half of the pair. Deleting the variable here is safe where deleting
  // ALLOW_TEST_LOGIN is not, and the asymmetry is worth stating: `reqWithEnvURL` reads
  // `AUTH_URL` at REQUEST time, after every import has run, so a reload of `.env` cannot
  // undo this deletion before it matters. `testLoginEnabled` is read at module IMPORT time,
  // which is exactly why the first test has to stub the module instead.
  vi.resetModules();
  delete process.env.AUTH_URL;
  process.env.ALLOW_TEST_LOGIN = "1";

  expect(await registeredProviderIds()).toEqual(
    expect.arrayContaining(["company", "test-login"]),
  );
});
