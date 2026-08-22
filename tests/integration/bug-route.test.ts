import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";

beforeEach(resetDb);

function post(body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/api/bugs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).length),
      ...headers,
    },
    body: payload,
  });
}

const valid = {
  summary: "probe",
  routePath: "/engineering",
  appVersion: "0.1.0",
  userAgent: "probe",
  viewport: "800x600",
};

test("rejects a body with no declared length", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({
    loadViewer: async () => ({ id: "u1", isSuperAdmin: false, memberships: [] }),
  }));
  const { POST } = await import("@/app/api/bugs/route");

  const request = new Request("http://localhost/api/bugs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(valid),
  });
  // Request() computes a length for a string body, so strip it to model a chunked send.
  request.headers.delete("content-length");

  expect((await POST(request)).status).toBe(411);
});

test("rejects an oversized declared length before reading the body", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({
    loadViewer: async () => ({ id: "u1", isSuperAdmin: false, memberships: [] }),
  }));
  const { POST } = await import("@/app/api/bugs/route");

  expect((await POST(post(valid, { "content-length": "99999999" }))).status).toBe(413);
});

test("rejects an unauthenticated report", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => null }));
  const { POST } = await import("@/app/api/bugs/route");

  expect((await POST(post(valid))).status).toBe(401);
});

test("rejects a blank summary", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({
    loadViewer: async () => ({ id: "u1", isSuperAdmin: false, memberships: [] }),
  }));
  const { POST } = await import("@/app/api/bugs/route");

  expect((await POST(post({ ...valid, summary: "   " }))).status).toBe(400);
});

test("stores a report for an authenticated reporter", async () => {
  const user = await db.user.create({
    data: { email: "reporter@example.com", name: "Reporter" },
  });

  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({
    loadViewer: async () => ({ id: user.id, isSuperAdmin: false, memberships: [] }),
  }));
  const { POST } = await import("@/app/api/bugs/route");

  const response = await POST(post(valid));
  expect(response.status).toBe(201);
  expect(await db.bugReport.count()).toBe(1);
});
