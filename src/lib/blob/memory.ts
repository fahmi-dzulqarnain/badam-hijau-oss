import { randomUUID } from "node:crypto";
import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

/** Matches Graph's own session lifetime closely enough to be worth imitating. */
const SESSION_TTL_MS = 15 * 60 * 1000;

/** One open upload: which key it may write, when it lapses, and what has arrived so far. */
type Session = {
  key: string;
  /** The size declared at `beginUpload`. A chunk may not take the total past it. */
  size: number;
  expiresAt: number;
  /** Offset → bytes. A Map so a resent chunk replaces rather than duplicates. */
  received: Map<number, Uint8Array>;
};

export type ChunkResult =
  | { ok: true; complete: boolean }
  | { ok: false; reason: "unknown-session" | "expired" | "overflow" };

/**
 * In-memory store for tests, local development and `npm run smoke`.
 *
 * `beginUpload` returns a URL pointing at `/api/attachments/dev-upload/<token>`, because the
 * direct-upload path is only exercisable if the browser has somewhere real to PUT. That route
 * is registered ONLY when `BLOB_STORE=memory`, under the same discipline as the passwordless
 * test login — see `src/lib/blob/select.ts`.
 *
 * **A token, not the key**, and that is the whole point of the session table below. `store.ts`
 * documents `UploadSession` as "a write capability for ONE key, for a short time"; a URL
 * carrying the key honoured none of that. Any caller could write any key — and keys are
 * derivable, since the id is visible in `/api/attachments/<id>` and the hash is in this
 * repository — so replacing a specific attachment's bytes was one `curl`. It also could not
 * accept a resumable upload at all: chunks all named the same key and each overwrote the last,
 * so a >10MiB file arrived as its final chunk alone.
 *
 * State is per-instance and per-process, which is exactly why `select.ts` refuses this
 * implementation in production: two replicas would disagree, and a restart loses everything.
 */
export class MemoryBlobStore implements BlobStore {
  #objects = new Map<string, Uint8Array>();
  #sessions = new Map<string, Session>();
  #version = 0;

  constructor(private readonly origin: string) {}

  /**
   * `mimeType` is declared and ignored, and the declaration is not optional: TypeScript checks
   * call arity against a CLASS's own signature, not against the interface it implements, and
   * the tests call this on the concrete type. Narrowing the parameter list compiles the class
   * fine and then fails every call site with TS2554.
   */
  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    // Unguessable, so the URL is the capability. `randomUUID` rather than a counter: a
    // predictable token would put the key back under a caller's control by another route.
    const token = randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    this.#sessions.set(token, {
      key,
      size: sizeBytes,
      expiresAt: expiresAt.getTime(),
      received: new Map(),
    });
    return { uploadUrl: `${this.origin}/api/attachments/dev-upload/${token}`, expiresAt };
  }

  /**
   * Accepts one chunk of an open session. Not on `BlobStore`: the dev upload route calls it,
   * and nothing else may.
   *
   * The session, not the caller, decides which key is written — so there is no key on this
   * signature to get wrong, and the traversal guard the old route needed has nothing left to
   * guard. Assembly happens only once every declared byte has arrived, which is what lets the
   * fake accept a real chunked upload instead of keeping whichever chunk landed last.
   */
  async writeChunk(token: string, offset: number, bytes: Uint8Array): Promise<ChunkResult> {
    const session = this.#sessions.get(token);
    if (!session) return { ok: false, reason: "unknown-session" };
    if (Date.now() >= session.expiresAt) {
      this.#sessions.delete(token);
      return { ok: false, reason: "expired" };
    }
    if (offset < 0 || offset + bytes.byteLength > session.size) {
      return { ok: false, reason: "overflow" };
    }

    session.received.set(offset, bytes);

    const total = [...session.received.values()].reduce((sum, part) => sum + part.byteLength, 0);
    if (total < session.size) return { ok: true, complete: false };

    // Assembled in offset order, into a buffer of exactly the declared size. Gaps cannot
    // survive this: a missing range would leave `total` short and never reach here.
    const assembled = new Uint8Array(session.size);
    for (const [at, part] of session.received) assembled.set(part, at);
    await this.put(session.key, assembled);
    this.#sessions.delete(token);
    return { ok: true, complete: true };
  }

  /**
   * What a session still wants, in Graph's `nextExpectedRanges` shape, or null if there is no
   * such session. The transport's resume path reads this after a failed chunk.
   */
  nextExpectedRanges(token: string): string[] | null {
    const session = this.#sessions.get(token);
    if (!session || Date.now() >= session.expiresAt) return null;

    let at = 0;
    for (const [offset, part] of [...session.received].sort((a, b) => a[0] - b[0])) {
      if (offset > at) break;
      at = Math.max(at, offset + part.byteLength);
    }
    return at >= session.size ? [] : [`${at}-`];
  }

  /** Not on `BlobStore`: tests write bytes directly, without opening a session. */
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
    this.#sessions.clear();
  }

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    for (const key of this.#objects.keys()) {
      if (key.startsWith(prefix)) yield { key };
    }
  }
}
