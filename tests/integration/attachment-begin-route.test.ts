import { expect, test, vi } from "vitest";
import type { Viewer } from "@/lib/authz/types";

/**
 * Every test here mocks `@/lib/auth/viewer` and re-imports the route dynamically, following
 * `draft-route.test.ts`'s discipline rather than the plan fence's original shape (a single
 * static `import { POST }` at the top, with `vi.doMock` called per-test but never followed by
 * a fresh import). `vi.doMock` is not hoisted and only takes effect for modules resolved AFTER
 * it runs — a statically-imported `POST` is already bound to the real `loadViewer` by the time
 * any test body executes, so that shape mocks nothing and every request falls through to
 * next-auth's real `auth()`, which throws outside a request scope. Caught by running the
 * fence's own tests: all seven failed with the same "headers was called outside a request
 * scope" error, not the statuses under test.
 */
const asEditor: Viewer = { id: "u1", isSuperAdmin: false, memberships: [] };

function request(body: unknown, headers: Record<string, string> = {}): Request {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(payload.length), ...headers },
    body: payload,
  });
}

/**
 * Loads the route bound to a given viewer. `doUnmock` matters for the same reason it does in
 * `draft-route.test.ts`: `resetModules` clears the module registry but leaves the MOCK
 * registry standing, so a repo stub left behind by one test would otherwise apply silently to
 * the next.
 */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doUnmock("@/lib/attachments/repo");
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/attachments/route")).POST;
}

test("401 without a session", async () => {
  const POST = await routeAs(null);
  expect((await POST(request({}))).status).toBe(401);
});

test("411 when Content-Length is absent, before the body is parsed", async () => {
  // `Number(null)` is 0, so a numeric-only cap waves an unbounded body through. Same
  // reasoning as the drafts route, and the same status.
  const POST = await routeAs(asEditor);
  const stripped = new Request("http://localhost/api/attachments", { method: "POST", body: "{}" });
  stripped.headers.delete("content-length");
  expect((await POST(stripped)).status).toBe(411);
});

test("415 for a mime off the allowlist, and no session is minted", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  const begin = vi.fn();
  vi.doMock("@/lib/attachments/repo", () => ({ beginUpload: begin }));
  const { POST } = await import("@/app/api/attachments/route");

  const response = await POST(
    request({ pageId: "p", filename: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 1 }),
  );
  expect(response.status).toBe(415);
  expect(begin).not.toHaveBeenCalled();
});

test("415 for an SVG, which is the refusal a person will actually meet", async () => {
  // The `.exe` above proves the route's rejection path; this proves the policy the rejection
  // now exists for. `application/x-msdownload` was never plausible as an attachment — an SVG
  // diagram is, so it is the type someone will drag in and the one whose refusal has to be a
  // clean 415 with a message rather than a 500 or a silent nothing.
  //
  // Both executable types are checked, because they were dropped together and for one reason:
  // the bytes land in a SharePoint library whose own web UI serves them with none of this
  // application's headers, so refusing the upload is the only gate that governs both readers.
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  // The stub RESOLVES rather than returning `undefined`, and that is about the failure message
  // rather than about this test passing. Put either type back on the allowlist and the route
  // gets past the 415 and calls this — a bare `vi.fn()` then hands it `undefined` and the
  // mutant dies on `Cannot read properties of undefined`, which reads as "something broke".
  // With a plausible result it dies on `expected 201 to be 415`, which names the policy that
  // changed. Same reasoning as the git worker's claim mutant, which was made to fail as an
  // assertion instead of hanging.
  const begin = vi.fn(async () => ({
    ok: true as const,
    attachmentId: "a1",
    uploadUrl: "http://localhost/api/attachments/dev-upload/tok",
    expiresAt: new Date("2026-09-04T00:00:00.000Z"),
  }));
  vi.doMock("@/lib/attachments/repo", () => ({ beginUpload: begin }));
  const { POST } = await import("@/app/api/attachments/route");

  for (const [filename, mimeType] of [
    ["diagram.svg", "image/svg+xml"],
    ["page.html", "text/html"],
  ]) {
    const response = await POST(request({ pageId: "p", filename, mimeType, sizeBytes: 1 }));
    expect(response.status, mimeType).toBe(415);
    expect((await response.json()).message, mimeType).toContain(mimeType);
  }
  expect(begin, "no session may be minted for a type that cannot be stored").not.toHaveBeenCalled();
});

test("413 for a size over the cap, with the cap in the message", async () => {
  const POST = await routeAs(asEditor);
  const response = await POST(
    request({ pageId: "p", filename: "a.png", mimeType: "image/png", sizeBytes: 999_999_999_9 }),
  );
  expect(response.status).toBe(413);
  expect((await response.json()).message).toMatch(/\d/);
});

test("404 and 403 come from the repository, not from the route", async () => {
  for (const [reason, status] of [["not-found", 404], ["forbidden", 403]] as const) {
    vi.resetModules();
    vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
    vi.doMock("@/lib/attachments/repo", () => ({
      beginUpload: async () => ({ ok: false, reason }),
    }));
    const { POST: handler } = await import("@/app/api/attachments/route");
    expect((await handler(request(valid()))).status).toBe(status);
  }
});

test("503 when the store is unavailable, and the message says retry", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  vi.doMock("@/lib/attachments/repo", () => ({
    beginUpload: async () => ({ ok: false, reason: "store-unavailable" }),
  }));
  const { POST: handler } = await import("@/app/api/attachments/route");
  const response = await handler(request(valid()));
  expect(response.status).toBe(503);
  expect((await response.json()).message).toMatch(/again/i);
});

test("201 returns the session, and never the app token", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  vi.doMock("@/lib/attachments/repo", () => ({
    beginUpload: async () => ({
      ok: true, attachmentId: "a1",
      uploadUrl: "https://upload/1", expiresAt: new Date("2026-08-26T10:00:00Z"),
    }),
  }));
  const { POST: handler } = await import("@/app/api/attachments/route");
  const response = await handler(request(valid()));

  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body).toEqual({
    attachmentId: "a1", uploadUrl: "https://upload/1",
    expiresAt: "2026-08-26T10:00:00.000Z",
  });
  // The session URL is pre-authenticated; an app token must never leave the server.
  expect(JSON.stringify(body)).not.toMatch(/bearer|access_token/i);
});

function valid() {
  return { pageId: "p", filename: "a.png", mimeType: "image/png", sizeBytes: 10 };
}

test("an empty file says so, instead of the generic unreadable message", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  const { POST: handler } = await import("@/app/api/attachments/route");

  const response = await handler(
    request({ pageId: "p", filename: "empty.png", mimeType: "image/png", sizeBytes: 0 }),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).message).toBe("That file is empty.");
});
