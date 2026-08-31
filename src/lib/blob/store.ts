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
  /** Bytes in THIS response: the range length, or the whole object. */
  sizeBytes: number;
  /** Bytes in the whole object, which `Content-Range` needs even for a partial response. */
  totalBytes: number;
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
