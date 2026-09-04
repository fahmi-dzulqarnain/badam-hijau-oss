/**
 * Browser-side upload transport: begin, chunk straight to the store, commit.
 *
 * The bytes never touch this application on the way in. `POST /api/attachments` returns a
 * pre-authenticated session URL and the browser writes to it directly, which is what keeps a
 * 400MB screen recording out of Next.js's heap. The only capability the client ever holds is
 * *write to this one item, for about fifteen minutes*.
 */

/**
 * 10MiB — exactly 32 × 320KiB.
 *
 * Graph rejects a non-final chunk whose length is not a multiple of 320KiB, so this is not a
 * tuning knob to round off. Larger chunks mean fewer round trips and a coarser resume point.
 */
export const CHUNK_BYTES = 10 * 1024 * 1024;

export type UploadedAttachment = {
  id: string;
  url: string;
  filename: string;
  kind: "image" | "video" | "file";
};

export type UploadResult =
  | { ok: true; attachment: UploadedAttachment }
  | { ok: false; message: string };

export type UploadOptions = {
  fetchImpl?: typeof fetch;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export async function uploadAttachment(
  { pageId, file }: { pageId: string; file: File },
  { fetchImpl = fetch, onProgress, signal }: UploadOptions = {},
): Promise<UploadResult> {
  const begun = await fetchImpl("/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pageId,
      filename: file.name,
      // A browser leaves `type` empty for an unrecognised extension. Sending the empty string
      // is correct: the server's allowlist rejects it with a message about the type, which is
      // the true reason, rather than this guessing one.
      mimeType: file.type,
      sizeBytes: file.size,
    }),
    signal,
  });

  if (!begun.ok) {
    // The server's own wording, unchanged. It knows the cap and the allowlist; restating them
    // here would be a second copy that drifts.
    const body = await begun.json().catch(() => null);
    return { ok: false, message: body?.message ?? "That file could not be attached." };
  }

  const { attachmentId, uploadUrl } = (await begun.json()) as {
    attachmentId: string;
    uploadUrl: string;
  };

  /**
   * Consecutive attempts that moved the offset nowhere.
   *
   * Necessary because `resumed === offset` is treated as a retry rather than a stall — the
   * ordinary outcome when a chunk simply was not accepted. Without a bound, a session that
   * keeps reporting the same `nextExpectedRanges` spins forever, in a browser, behind a
   * progress bar that never moves. Bounded rather than removed: the retry is the whole point
   * of asking the session where it got to, and one transient 500 must not lose a 400MB upload.
   */
  let stalled = 0;
  const MAX_STALLED = 5;

  let offset = 0;
  while (offset < file.size) {
    if (signal?.aborted) return { ok: false, message: "Upload cancelled." };

    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const response = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        // INCLUSIVE end, and the total after the slash — the form Graph requires.
        "content-range": `bytes ${offset}-${end - 1}/${file.size}`,
      },
      body: file.slice(offset, end),
      signal,
    });

    if (response.ok) {
      offset = end;
      stalled = 0;
      onProgress?.(offset / file.size);
      continue;
    }

    // Ask the session where it actually got to rather than assuming this chunk was lost.
    // Restarting a large upload from zero is the failure this whole branch exists to avoid.
    const resumed = await resumeOffset(fetchImpl, uploadUrl, signal);
    // `resumed === offset` is the ORDINARY case, not a stall: the chunk that just 500'd was
    // never accepted, so the session still wants exactly what it wanted before. Retrying from
    // the same offset is a retry; only a session that regressed BEHIND where we already are —
    // which would mean the store lost bytes it had previously confirmed — is unrecoverable.
    if (resumed === null || resumed < offset) {
      return { ok: false, message: "The upload was interrupted. Try again." };
    }
    if (resumed === offset) {
      stalled += 1;
      if (stalled >= MAX_STALLED) {
        return { ok: false, message: "The upload stopped making progress. Try again." };
      }
    } else {
      stalled = 0;
    }
    offset = resumed;
    onProgress?.(offset / file.size);
  }

  const committed = await fetchImpl(`/api/attachments/${attachmentId}/commit`, {
    method: "POST",
    signal,
  });
  if (!committed.ok) {
    const body = await committed.json().catch(() => null);
    return { ok: false, message: body?.message ?? "The upload could not be finished." };
  }

  return { ok: true, attachment: (await committed.json()) as UploadedAttachment };
}

/** The first byte the session still wants, from `nextExpectedRanges`. */
async function resumeOffset(
  fetchImpl: typeof fetch,
  uploadUrl: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const response = await fetchImpl(uploadUrl, { method: "GET", signal }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as
    | { nextExpectedRanges?: string[] }
    | null;
  const first = body?.nextExpectedRanges?.[0];
  if (!first) return null;
  const start = Number(first.split("-")[0]);
  return Number.isInteger(start) ? start : null;
}
