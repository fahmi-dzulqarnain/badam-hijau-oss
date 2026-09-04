import { expect, test, vi } from "vitest";
import { GraphBlobStore } from "./graph";

function store(fetchImpl: typeof fetch) {
  return new GraphBlobStore(
    { tenantId: "t", clientId: "c", clientSecret: "s", driveId: "d" },
    { value: async () => "TOKEN" },
    fetchImpl,
  );
}

test("beginUpload asks for a session and returns its url and expiry", async () => {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as string, init));
    return new Response(
      JSON.stringify({ uploadUrl: "https://upload/1", expirationDateTime: "2026-08-26T10:00:00Z" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const session = await store(fetchImpl as unknown as typeof fetch).beginUpload(
    "ab/abc.png", 5, "image/png",
  );
  expect(session.uploadUrl).toBe("https://upload/1");
  expect(session.expiresAt.toISOString()).toBe("2026-08-26T10:00:00.000Z");
  expect(calls[0]!.url).toContain("/drives/d/root:/ab/abc.png:/createUploadSession");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer TOKEN");
});

test("stat returns null on 404 and size on 200", async () => {
  const missing = vi.fn(async () => new Response("", { status: 404 }));
  expect(await store(missing as unknown as typeof fetch).stat("k")).toBeNull();

  const found = vi.fn(
    async () =>
      new Response(JSON.stringify({ size: 42, eTag: '"abc"' }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
  );
  expect(await store(found as unknown as typeof fetch).stat("k")).toEqual({
    sizeBytes: 42, eTag: '"abc"',
  });
});

test("fetch forwards a Range and reads totalBytes from Content-Range", async () => {
  // A 206 carries Content-Length for the SLICE. The total is only in Content-Range, and the
  // proxy needs it to build its own Content-Range header. Reading Content-Length as the total
  // is the bug this test exists for.
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-3");
      return new Response("ell", {
        status: 206,
        headers: { "content-range": "bytes 1-3/5", "content-length": "3", etag: '"abc"' },
      });
    },
  );

  const body = await store(fetchImpl as unknown as typeof fetch).fetch("k", { start: 1, end: 3 });
  expect(body!.sizeBytes).toBe(3);
  expect(body!.totalBytes).toBe(5);
});

test("fetch returns null on 404 rather than throwing", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
  expect(await store(fetchImpl as unknown as typeof fetch).fetch("k")).toBeNull();
});

test("a 5xx from Graph throws, so the route can answer 502 rather than 404", async () => {
  // The distinction matters: 404 says "no such attachment" and 502 says "the store is down".
  // Collapsing them makes an outage look like deletion.
  const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
  await expect(store(fetchImpl as unknown as typeof fetch).fetch("k")).rejects.toThrow(/503/);
});

test("delete treats 404 as success", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
  await expect(store(fetchImpl as unknown as typeof fetch).delete("k")).resolves.toBeUndefined();
});

test("a 200 answer to a RANGED request is reported as not partial", async () => {
  // Graph redirects /content to a pre-authenticated CDN URL that is under no obligation to
  // honour Range. The store must report what the upstream DID, or the proxy labels a whole
  // object 206 and emits a Content-Range its body contradicts.
  const fetchImpl = vi.fn(async () => new Response("hello", { status: 200, headers: { "content-length": "5" } }));
  const body = await store(fetchImpl as unknown as typeof fetch).fetch("k", { start: 1, end: 3 });
  expect(body!.partial).toBe(false);
  expect(body!.sizeBytes).toBe(5);
});

test("a 206 is reported as partial", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response("ell", {
        status: 206,
        headers: { "content-range": "bytes 1-3/5", "content-length": "3" },
      }),
  );
  const body = await store(fetchImpl as unknown as typeof fetch).fetch("k", { start: 1, end: 3 });
  expect(body!.partial).toBe(true);
});

test("a missing Content-Length stays null rather than becoming zero", async () => {
  // A chunked or transfer-compressed upstream sends none. `?? 0` turned "did not say" into
  // "zero bytes", which the proxy then declared on the wire in front of a full body.
  const fetchImpl = vi.fn(async () => {
    const response = new Response("hello", { status: 200 });
    response.headers.delete("content-length");
    return response;
  });
  const body = await store(fetchImpl as unknown as typeof fetch).fetch("k");
  expect(body!.sizeBytes).toBeNull();
  expect(body!.totalBytes).toBe(0);
});
