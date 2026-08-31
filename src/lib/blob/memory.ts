import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

/**
 * In-memory store for tests, local development and `npm run smoke`.
 *
 * `beginUpload` returns a URL pointing at `/api/attachments/_dev-upload/<key>`, because the
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

  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    return {
      uploadUrl: `${this.origin}/api/attachments/_dev-upload/${key}`,
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
      stream: new Response(new Uint8Array(slice)).body!,
      sizeBytes: slice.byteLength,
      totalBytes: bytes.byteLength,
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
