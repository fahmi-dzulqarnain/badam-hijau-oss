import { expect, test, vi } from "vitest";

const params = { params: Promise.resolve({ id: "a1" }) };

async function route() {
  return import("@/app/api/attachments/[id]/route");
}

function mockStore(overrides: Record<string, unknown> = {}) {
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
      ...overrides,
    }),
  }));
}

function mockReadable(mimeType = "image/png") {
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.png", filename: "shot.png",
      mimeType, sizeBytes: 5, eTag: '"1"',
    }),
  }));
}

test("401 without a session", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => null }));
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(401);
});

test("404 when the predicate refuses, byte-identical to a missing id", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({ readableAttachment: async () => null }));
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(404);
});

test("200 streams the bytes with the stored type, nosniff, and a PRIVATE immutable cache", async () => {
  vi.resetModules();
  mockReadable();
  mockStore();
  const response = await (await route()).GET(new Request("http://x/a1"), params);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("hello");
  // The type comes from Postgres, never from the store: the mime was validated once at
  // upload, and this is what makes never seeing the bytes safe.
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  // `private` is a permission boundary. `public` would let a shared corporate proxy cache a
  // members-only screenshot and hand it to a non-member.
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("content-disposition")).toBe('inline; filename="shot.png"');
});

test("an SVG downloads instead of rendering", async () => {
  vi.resetModules();
  mockReadable("image/svg+xml");
  mockStore();
  const response = await (await route()).GET(new Request("http://x/a1"), params);
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
});

test("a Range request gets 206 with a correct Content-Range", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async (_key: string, range?: { start: number; end: number }) => {
        expect(range).toEqual({ start: 1, end: 3 });
        return { stream: new Response("ell").body!, sizeBytes: 3, totalBytes: 5, eTag: '"1"' };
      },
    }),
  }));

  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=1-3" } }), params,
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
  expect(response.headers.get("content-length")).toBe("3");
});

test("an open-ended range resolves against the stored size", async () => {
  // `bytes=2-` is what a video player actually sends when seeking.
  vi.resetModules();
  mockReadable("video/mp4");
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async (_key: string, range?: { start: number; end: number }) => {
        expect(range).toEqual({ start: 2, end: 4 });
        return { stream: new Response("llo").body!, sizeBytes: 3, totalBytes: 5, eTag: '"1"' };
      },
    }),
  }));
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=2-" } }), params,
  );
  expect(response.status).toBe(206);
});

test("416 for a range that starts past the end", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  mockStore();
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=99-100" } }), params,
  );
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */5");
});

test("an unparseable Range is IGNORED, not rejected", async () => {
  // RFC 9110: a syntactically invalid Range is ignored and the whole representation sent.
  vi.resetModules();
  mockReadable();
  mockStore();
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "furlongs=1-2" } }), params,
  );
  expect(response.status).toBe(200);
});

test("HEAD answers with the headers and no body", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  mockStore();
  const response = await (await route()).HEAD(new Request("http://x/a1", { method: "HEAD" }), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("5");
  expect(await response.text()).toBe("");
});

test("502 when the store throws, so an outage does not read as deletion", async () => {
  vi.resetModules();
  mockReadable();
  mockStore({ fetch: async () => { throw new Error("503"); } });
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(502);
});

test("404 when the row exists but the store has no bytes", async () => {
  vi.resetModules();
  mockReadable();
  mockStore({ fetch: async () => null });
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(404);
});
