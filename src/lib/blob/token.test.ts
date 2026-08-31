import { beforeEach, expect, test, vi } from "vitest";
import { GraphToken } from "./token";

const config = {
  tenantId: "t", clientId: "c", clientSecret: "s",
};

function tokenResponse(value: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: value, expires_in: expiresIn }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
});

test("the first call fetches and the second is cached", async () => {
  fetchMock.mockResolvedValue(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  expect(await token.value()).toBe("abc");
  expect(await token.value()).toBe("abc");
  // App-only tokens have no user in them, so ONE cached token serves every request in the
  // process. Refetching per request is a rate limit waiting to happen.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a token near expiry is refetched early", async () => {
  // 60s of skew, so a token is never used in the window where it might already be rejected.
  fetchMock.mockResolvedValueOnce(tokenResponse("first", 30));
  fetchMock.mockResolvedValueOnce(tokenResponse("second", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  expect(await token.value()).toBe("first");
  expect(await token.value()).toBe("second");
});

test("concurrent callers share one in-flight request", async () => {
  // Without this, a page with twelve images cold-starts twelve identical token requests.
  fetchMock.mockResolvedValue(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  await Promise.all([token.value(), token.value(), token.value()]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a failed token request does not poison the cache", async () => {
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
  fetchMock.mockResolvedValueOnce(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  await expect(token.value()).rejects.toThrow(/token/i);
  // A rejected promise left in the cache would make every later call fail forever — the
  // failure mode where one blip takes the feature down until a restart.
  expect(await token.value()).toBe("abc");
});

test("the secret is never in the error message", async () => {
  // The token endpoint can echo request parameters in a failure body, and this message
  // reaches logs. So the message carries the STATUS only, never the response body.
  const secret = "super-secret-value";
  fetchMock.mockResolvedValue(new Response(`bad client_secret=${secret}`, { status: 400 }));
  const token = new GraphToken({ ...config, clientSecret: secret }, fetchMock as unknown as typeof fetch);

  const error = await token.value().then(() => null, (e: Error) => e);
  expect(error).not.toBeNull();
  expect(error!.message).toContain("400");
  expect(error!.message).not.toContain(secret);
});
