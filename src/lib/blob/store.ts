/**
 * What the application needs from an object store, and nothing more.
 *
 * The seam exists for a reason that is not speculative generality: a real SharePoint tenant is
 * not reproducible in CI or on a laptop, and `npm run smoke` must run from nothing. An
 * in-memory implementation is therefore mandatory, and this is the interface those tests
 * already need. It survived a total change of backend — S3 to SharePoint — which is reasonable
 * evidence it is drawn in the right place.
 *
 * Note what is absent: any method that takes file BYTES on the way in. Uploads bypass the
 * application entirely; `beginUpload` returns a URL the browser writes to directly.
 */

/** A write capability for ONE key, for a short time. It confers no read and no other write. */
export type UploadSession = { uploadUrl: string; expiresAt: Date };

export type BlobStat = { sizeBytes: number; eTag: string | null };

/** Byte offsets, both INCLUSIVE — as HTTP `Range` defines them, not as `slice` does. */
export type BlobRange = { start: number; end: number };

export type BlobBody = {
  stream: ReadableStream<Uint8Array>;
  /**
   * Bytes in THIS response, or **null when the store did not say**.
   *
   * Null is a real answer, not an error: an upstream may respond chunked or
   * transfer-compressed and send no `Content-Length` at all. Synthesising a `0` there and
   * putting it on the wire declares a length the body then contradicts, which truncates a
   * well-behaved client and desynchronises a proxy's framing.
   */
  sizeBytes: number | null;
  /** Bytes in the whole object, which `Content-Range` needs even for a partial response. */
  totalBytes: number;
  /**
   * Whether the store actually returned a PARTIAL response, rather than whether one was asked
   * for. Load-bearing: asking for a range does not oblige an upstream to honour it, and Graph
   * redirects `/content` to a pre-authenticated CDN URL that may answer 200 with the whole
   * object. A caller that infers `206` from its own request instead of from this flag emits a
   * `Content-Range` its body contradicts.
   */
  partial: boolean;
  eTag: string | null;
};

export interface BlobStore {
  beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession>;
  stat(key: string): Promise<BlobStat | null>;
  /** Null when the key does not exist. A range beyond the end CLAMPS; it does not throw. */
  fetch(key: string, range?: BlobRange): Promise<BlobBody | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** For the sweep's reverse-orphan pass — drive items with no row. */
  list(prefix: string): AsyncIterable<{ key: string }>;
}
