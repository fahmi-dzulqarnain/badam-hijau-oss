import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

/**
 * In-memory store for tests, local development and `npm run smoke`.
 *
 * `beginUpload` returns a URL pointing at `/api/attachments/dev-upload/<key>`, because the
 * direct-upload path is only exercisable if the browser has somewhere real to PUT. That route
 * is registered ONLY when `BLOB_STORE=memory`, under the same discipline as the passwordless
 * test login — see `src/lib/blob/select.ts`.
 *
 * State is per-instance and per-process, which is exactly why `select.ts` refuses this
 * implementation in production: two replicas would disagree, and a restart loses everything.
 */
export class MemoryBlobStore implements BlobStore {
  #objects = new Map<string, Uint8Array>();
  #version = 0;

  constructor(private readonly origin: string) {}

  /**
   * `sizeBytes` and `mimeType` are declared and ignored, and the declaration is not optional:
   * TypeScript checks call arity against a CLASS's own signature, not against the interface it
   * implements, and the tests call this on the concrete type. Narrowing it to `(key)` compiles
   * the class fine and then fails every call site with TS2554.
   */
  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    return {
      uploadUrl: `${this.origin}/api/attachments/dev-upload/${key}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  /** Not on `BlobStore`: the dev upload route calls it, and nothing else may. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(key, bytes);
    this.#version += 1;
  }

  async stat(key: string): Promise<BlobStat | null> {
    const bytes = this.#objects.get(key);
    if (!bytes) return null;
    return { sizeBytes: bytes.byteLength, eTag: `"${this.#version}"` };
  }

  async fetch(key: string, range?: BlobRange): Promise<BlobBody | null> {
    const bytes = this.#objects.get(key);
    if (!bytes) return null;

    // `end` is INCLUSIVE and `subarray` is exclusive, hence the +1. Clamped rather than
    // rejected: a player asking for more than exists should get what exists.
    const slice = range
      ? bytes.subarray(range.start, Math.min(range.end + 1, bytes.byteLength))
      : bytes;

    return {
      // COPIED into a fresh array rather than passed straight in. `subarray` yields a
      // `Uint8Array<ArrayBufferLike>`, and `BodyInit` in this lib.dom requires the narrower
      // `Uint8Array<ArrayBuffer>`, so `new Response(slice)` is a TS2345. The copy is
      // acceptable precisely because this is the fake — the Graph store streams instead, and
      // a copy there would defeat the point of never buffering a video.
      stream: new Response(new Uint8Array(slice)).body!,
      sizeBytes: slice.byteLength,
      totalBytes: bytes.byteLength,
      // The fake always honours a range and always knows its own length, which is exactly why
      // it cannot exercise the two cases a real upstream can produce. Those are covered in
      // `graph.test.ts` instead.
      partial: range !== undefined,
      eTag: `"${this.#version}"`,
    };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  /**
   * Not on `BlobStore`. Test isolation only: `select.ts` caches one store per process, so
   * this Map outlives `resetDb` and would carry bytes from one test into the next.
   */
  reset(): void {
    this.#objects.clear();
  }

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    for (const key of this.#objects.keys()) {
      if (key.startsWith(prefix)) yield { key };
    }
  }
}
