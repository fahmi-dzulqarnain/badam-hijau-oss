import { expect, test, vi } from "vitest";

/**
 * The dev upload route is the price of the upload/download asymmetry: the browser must PUT
 * somewhere real for the memory store to exercise the direct-upload path at all. That makes
 * it a write endpoint with no authentication, which is acceptable ONLY while it cannot exist
 * outside a memory-store process.
 *
 * Tested the way a browser sees it, and with `vi.resetModules()` because the route reads the
 * flag at import time — a cached module would answer for the previous test's environment.
 * Same reasoning as `src/lib/auth/providers.test.ts`, and the same trap: importing anything
 * that pulls in Prisma loads `.env` into `process.env`, so the flag is stubbed at the module
 * rather than through the environment.
 */
async function put(key: string, body: string): Promise<number> {
  const { PUT } = await import("@/app/api/attachments/_dev-upload/[...key]/route");
  const response = await PUT(new Request("http://localhost/x", { method: "PUT", body }), {
    params: Promise.resolve({ key: key.split("/") }),
  });
  return response.status;
}

test("the route 404s when the memory store is not selected", async () => {
  vi.resetModules();
  vi.doMock("@/lib/blob/select", () => ({ memoryStoreEnabled: () => false }));

  expect(await put("ab/abc.png", "hello")).toBe(404);
  vi.doUnmock("@/lib/blob/select");
});

test("the route accepts a PUT and the bytes are then readable", async () => {
  vi.resetModules();
  const { MemoryBlobStore } = await import("@/lib/blob/memory");
  const store = new MemoryBlobStore("http://localhost");
  vi.doMock("@/lib/blob/select", () => ({
    memoryStoreEnabled: () => true,
    memoryStore: () => store,
  }));

  expect(await put("ab/abc.png", "hello")).toBe(201);
  expect(await store.stat("ab/abc.png")).toMatchObject({ sizeBytes: 5 });
  vi.doUnmock("@/lib/blob/select");
});

test("a key that escapes its prefix is refused", async () => {
  // The key arrives as path segments. Postgres never sees it, but the memory store's Map
  // would happily hold `../../etc/passwd`, and the Graph store's path builder would not.
  // Refusing traversal here keeps the two stores' key spaces the same shape.
  vi.resetModules();
  const { MemoryBlobStore } = await import("@/lib/blob/memory");
  vi.doMock("@/lib/blob/select", () => ({
    memoryStoreEnabled: () => true,
    memoryStore: () => new MemoryBlobStore("http://localhost"),
  }));

  expect(await put("../etc/passwd", "x")).toBe(400);
  vi.doUnmock("@/lib/blob/select");
});
