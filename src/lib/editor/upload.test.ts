import { expect, test, vi } from "vitest";
import { CHUNK_BYTES, uploadAttachment } from "./upload";

function file(bytes: number, type = "image/png"): File {
  return new File([new Uint8Array(bytes)], "shot.png", { type });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

test("the chunk size is an exact multiple of Graph's 320KiB quantum", () => {
  // Graph rejects a non-final chunk that is not a multiple of 320KiB. 10MiB is 32 of them.
  expect(CHUNK_BYTES % (320 * 1024)).toBe(0);
});

test("a small file still goes through a resumable session", async () => {
  // Graph offers a simple PUT under 4MB, but that needs an APP TOKEN, and an app token must
  // never reach a browser. One code path, and the client holds no credential.
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(json({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" }));

  const result = await uploadAttachment(
    { pageId: "p", file: file(10) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result.ok).toBe(true);
  expect(fetchImpl.mock.calls[1]![0]).toBe("https://up/1");
});

test("a large file is chunked, with correct inclusive Content-Range on each part", async () => {
  const ranges: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") {
      ranges.push(new Headers(init?.headers).get("content-range")!);
      return new Response(null, { status: 202 });
    }
    return json({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" });
  });

  const size = CHUNK_BYTES + 1000;
  await uploadAttachment(
    { pageId: "p", file: file(size) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );

  expect(ranges).toEqual([
    `bytes 0-${CHUNK_BYTES - 1}/${size}`,
    `bytes ${CHUNK_BYTES}-${size - 1}/${size}`,
  ]);
});

test("progress is reported per chunk and ends at 1", async () => {
  const seen: number[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") return new Response(null, { status: 202 });
    return json({ id: "a1", url: "/api/attachments/a1", filename: "s.png", kind: "image" });
  });

  await uploadAttachment(
    { pageId: "p", file: file(CHUNK_BYTES * 2) },
    { fetchImpl: fetchImpl as unknown as typeof fetch, onProgress: (p) => seen.push(p) },
  );
  expect(seen.at(-1)).toBe(1);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test("a failed chunk is retried from nextExpectedRanges rather than restarted", async () => {
  // The reason video upload is survivable on a flaky connection. Restarting a 400MB upload
  // from zero is the difference between a retry and a lost afternoon.
  let attempts = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") {
      if (init?.method === "GET") {
        return json({ nextExpectedRanges: [`${CHUNK_BYTES}-`] });
      }
      attempts += 1;
      if (attempts === 2) return new Response(null, { status: 500 });
      return new Response(null, { status: 202 });
    }
    return json({ id: "a1", url: "/api/attachments/a1", filename: "s.png", kind: "image" });
  });

  const result = await uploadAttachment(
    { pageId: "p", file: file(CHUNK_BYTES * 2) },
    { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result.ok).toBe(true);
  // Queried the session for where to resume rather than starting over.
  expect(fetchImpl.mock.calls.some(([, init]) => (init as RequestInit)?.method === "GET")).toBe(true);
});

test("a rejected begin surfaces the server's message unchanged", async () => {
  const fetchImpl = vi.fn(async () =>
    json({ error: "unsupported-type", message: "application/x-msdownload cannot be attached." }, 415),
  );
  const result = await uploadAttachment(
    { pageId: "p", file: file(10) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result).toEqual({
    ok: false, message: "application/x-msdownload cannot be attached.",
  });
});

test("an abort signal stops the upload without committing", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/attachments") {
      controller.abort();
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    throw new Error("should not reach the upload");
  });

  const result = await uploadAttachment(
    { pageId: "p", file: file(10) },
    { fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal },
  );
  expect(result.ok).toBe(false);
});

test("a session that never advances gives up instead of spinning forever", async () => {
  // The consequence of treating `resumed === offset` as a retry rather than a stall: without
  // a bound, a store that keeps reporting the same nextExpectedRanges loops forever in a
  // browser behind a progress bar that never moves. One transient failure must still recover
  // — that is the test above — so this is bounded, not removed.
  let puts = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") {
      if (init?.method === "GET") return json({ nextExpectedRanges: ["0-"] });
      puts += 1;
      return new Response(null, { status: 500 });
    }
    return json({ id: "a1", url: "/api/attachments/a1", filename: "s.png", kind: "image" });
  });

  const result = await uploadAttachment(
    { pageId: "p", file: file(CHUNK_BYTES * 2) },
    { fetchImpl: fetchImpl as unknown as typeof fetch },
  );

  expect(result).toEqual({
    ok: false,
    message: "The upload stopped making progress. Try again.",
  });
  // Bounded, and the bound is small enough that a person is not left waiting.
  expect(puts).toBeLessThanOrEqual(5);
});
