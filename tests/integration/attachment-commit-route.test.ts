import { expect, test, vi } from "vitest";

function post(body = "{}"): Request {
  return new Request("http://localhost/api/attachments/a1/commit", { method: "POST", body });
}
const params = { params: Promise.resolve({ id: "a1" }) };

async function handler() {
  return (await import("@/app/api/attachments/[id]/commit/route")).POST;
}

test("401 without a session", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => null }));
  expect((await (await handler())(post(), params)).status).toBe(401);
});

test("the route ignores a driveItemId in the body", async () => {
  // The browser holds Graph's completion response and could report any item. The repository
  // stats by the key the application derived, and the route must not pass anything through.
  const commit = vi.fn(async () => ({ ok: true, attachment: attachment() }));
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({ commitUpload: commit }));

  await (await handler())(post(JSON.stringify({ driveItemId: "01ATTACKER" })), params);
  expect(commit).toHaveBeenCalledWith({ id: "u" }, "a1");
});

test("200 returns the reference the editor inserts, with the video path for a video", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    commitUpload: async () => ({
      ok: true,
      attachment: { ...attachment(), mimeType: "video/mp4", filename: "clip.mp4" },
    }),
  }));

  const body = await (await (await handler())(post(), params)).json();
  // `/video` is what the render plugin matches on to build a <video> element. An image gets
  // the bare URL.
  expect(body).toEqual({
    id: "a1", url: "/api/attachments/a1/video",
    filename: "clip.mp4", mimeType: "video/mp4", kind: "video",
  });
});

test("each failure reason gets its own status", async () => {
  for (const [reason, status] of [
    ["not-found", 404], ["not-uploaded", 409],
    ["size-mismatch", 400], ["store-unavailable", 503],
  ] as const) {
    vi.resetModules();
    vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
    vi.doMock("@/lib/attachments/repo", () => ({ commitUpload: async () => ({ ok: false, reason }) }));
    expect((await (await handler())(post(), params)).status, reason).toBe(status);
  }
});

function attachment() {
  return {
    id: "a1", drivePath: "a1/a1.png", filename: "shot.png",
    mimeType: "image/png", sizeBytes: 5, eTag: '"1"',
  };
}
