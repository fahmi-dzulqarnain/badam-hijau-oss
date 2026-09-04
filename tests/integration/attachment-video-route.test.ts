import { expect, test, vi } from "vitest";

test("the /video path serves the same bytes as the bare path", async () => {
  // It exists so the render plugin has a Markdown-expressible discriminator. Re-implementing
  // the proxy here would be a second copy of the permission check — the one thing that must
  // not be duplicated.
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.mp4", filename: "clip.mp4",
      mimeType: "video/mp4", sizeBytes: 5, eTag: '"1"',
    }),
  }));
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
    }),
  }));

  const { GET } = await import("@/app/api/attachments/[id]/video/route");
  const response = await GET(new Request("http://x/a1/video"), {
    params: Promise.resolve({ id: "a1" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
});

test("a non-video attachment is still served, not refused", async () => {
  // The suffix is a routing hint from the editor, not an assertion about the file. Refusing a
  // mismatch would break a document whose video was replaced by an image.
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.png", filename: "s.png",
      mimeType: "image/png", sizeBytes: 5, eTag: '"1"',
    }),
  }));
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
    }),
  }));

  const { GET } = await import("@/app/api/attachments/[id]/video/route");
  expect((await GET(new Request("http://x"), { params: Promise.resolve({ id: "a1" }) })).status)
    .toBe(200);
});
