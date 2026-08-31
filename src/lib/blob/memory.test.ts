import { beforeEach, expect, test } from "vitest";
import { MemoryBlobStore } from "./memory";

let store: MemoryBlobStore;
beforeEach(() => {
  store = new MemoryBlobStore("http://localhost:3000");
});

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

test("a session's uploadUrl points at the dev upload route for that key", async () => {
  const session = await store.beginUpload("ab/abc.png", 5, "image/png");
  expect(session.uploadUrl).toBe("http://localhost:3000/api/attachments/_dev-upload/ab/abc.png");
  expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

test("stat is null before the bytes arrive, and reports size after", async () => {
  await store.beginUpload("ab/abc.png", 5, "image/png");
  expect(await store.stat("ab/abc.png")).toBeNull();

  await store.put("ab/abc.png", new TextEncoder().encode("hello"));
  expect(await store.stat("ab/abc.png")).toEqual({ sizeBytes: 5, eTag: '"1"' });
});

test("fetch returns the whole body when no range is asked for", async () => {
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k");
  expect(body).not.toBeNull();
  expect(body!.totalBytes).toBe(5);
  expect(body!.sizeBytes).toBe(5);
  expect(await read(body!.stream)).toBe("hello");
});

test("fetch honours an inclusive range, as HTTP defines it", async () => {
  // bytes=1-3 of "hello" is "ell" — three bytes, END INCLUSIVE. Getting this wrong by one
  // makes video seek subtly corrupt rather than broken, which is worse.
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k", { start: 1, end: 3 });
  expect(await read(body!.stream)).toBe("ell");
  expect(body!.sizeBytes).toBe(3);
  expect(body!.totalBytes).toBe(5);
});

test("a range beyond the end clamps rather than throwing", async () => {
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k", { start: 3, end: 99 });
  expect(await read(body!.stream)).toBe("lo");
});

test("fetch and stat are null for a key that was never written", async () => {
  expect(await store.fetch("nope")).toBeNull();
  expect(await store.stat("nope")).toBeNull();
});

test("delete removes the bytes and is idempotent", async () => {
  await store.put("k", new TextEncoder().encode("x"));
  await store.delete("k");
  await store.delete("k");
  expect(await store.stat("k")).toBeNull();
});

test("reset empties the store, because select.ts caches one instance per process", async () => {
  // `resetDb` truncates Postgres but knows nothing about this Map, so without reset() bytes
  // from one test are visible to the next — and a sweep test asserting "no orphans" would
  // pass or fail depending on file ordering.
  await store.put("k", new Uint8Array(1));
  store.reset();
  expect(await store.stat("k")).toBeNull();
});

test("list enumerates keys under a prefix, for the sweep's reverse-orphan pass", async () => {
  await store.put("ab/one.png", new Uint8Array(1));
  await store.put("ab/two.png", new Uint8Array(1));
  await store.put("cd/three.png", new Uint8Array(1));

  const keys: string[] = [];
  for await (const item of store.list("ab/")) keys.push(item.key);
  expect(keys.sort()).toEqual(["ab/one.png", "ab/two.png"]);
});
