import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { readableAttachment, softDeleteAttachment } from "@/lib/attachments/repo";
import { blobStore } from "@/lib/blob/select";
import { contentDisposition, isInlineMime } from "@/lib/attachments/policy";
import type { ReadableAttachment } from "@/lib/attachments/repo";

/**
 * The read side of the asymmetry: bytes go through the application so that the same
 * `visiblePage`/`readableSpace` predicates that govern a page read govern its files.
 *
 * The bytes are STREAMED, never buffered. Buffering a 512MB video is 512MB of heap per
 * concurrent viewer, and `<video>` would still work — until two people watched at once.
 */

const YEAR = 31_536_000;

async function serve(request: Request, id: string, withBody: boolean) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to view this file." },
      { status: 401 },
    );
  }

  const attachment = await readableAttachment(viewer, id);
  // One answer for absent, soft-deleted, PENDING, page-deleted and unreadable-space. A
  // distinguishable 403 would confirm the file exists, which is the leak §8 closes.
  if (!attachment) {
    return NextResponse.json(
      { error: "not-found", message: "That file could not be found." },
      { status: 404 },
    );
  }

  const range = parseRange(request.headers.get("range"), attachment.sizeBytes);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${attachment.sizeBytes}`, "accept-ranges": "bytes" },
    });
  }

  let body;
  try {
    body = await blobStore().fetch(attachment.drivePath, range ?? undefined);
  } catch (error) {
    // 502, not 404: a Graph outage must not read as every attachment having been deleted.
    // The page itself still renders — this is one broken image, never a 500.
    //
    // Logged because a Graph outage, an expired client secret and an unset BLOB_STORE all
    // produce this same opaque status, and without a trace there is nothing on the floor to
    // tell them apart. The id and the error only — no bytes, no drive path.
    console.error(`[attachments] store unavailable for ${attachment.id}:`, error);
    return NextResponse.json(
      { error: "store-unavailable", message: "File storage is not responding." },
      { status: 502 },
    );
  }
  if (!body) {
    return NextResponse.json(
      { error: "not-found", message: "That file could not be found." },
      { status: 404 },
    );
  }

  const headers = commonHeaders(attachment, body.eTag);

  // Declared only when the store actually declared one. A missing upstream `Content-Length`
  // used to arrive here as `0`, which then went on the wire in front of a full body.
  if (body.sizeBytes !== null) headers.set("content-length", String(body.sizeBytes));

  // `body.partial`, NOT `range`. Asking for a range does not oblige the upstream to honour
  // it: Graph redirects `/content` to a pre-authenticated CDN URL that may answer 200 with
  // the whole object. Labelling that 206 emitted a `Content-Range` the body contradicted —
  // a player would write whole-object bytes at the range's offset and corrupt the file. When
  // the range was ignored, serve the full representation and say so.
  if (range && body.partial) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${body.totalBytes}`);
  }

  return new NextResponse(withBody ? body.stream : null, {
    status: range && body.partial ? 206 : 200,
    headers,
  });
}

function commonHeaders(attachment: ReadableAttachment, eTag: string | null): Headers {
  const headers = new Headers();
  // From Postgres, never from the store. The mime was validated once against the allowlist at
  // upload; letting the store decide would let a file's own metadata pick its interpretation.
  //
  // And only for a type meant to render. `text/html` and `image/svg+xml` are no longer
  // uploadable — the library is also readable through SharePoint's own UI, which applies none
  // of these headers, so an executable format had to be refused at the point that governs both
  // readers rather than served carefully by this one. This branch is still what protects a row
  // written before that refusal, and the reasoning it was built on stands: for a genuinely
  // executable type `nosniff` is no help at all, since it stops a browser GUESSING a different
  // type rather than declining the declared one. Serving every non-inline type as an opaque
  // stream removes the dependency on `Content-Disposition: attachment` being the single thing
  // honoured; the disposition still names the file.
  headers.set(
    "content-type",
    isInlineMime(attachment.mimeType) ? attachment.mimeType : "application/octet-stream",
  );
  // Load-bearing: the application never sees the bytes, so a file declared `image/png` may
  // contain anything. `nosniff` is what stops a browser deciding it is HTML and running it.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", contentDisposition(attachment.mimeType, attachment.filename));
  headers.set("accept-ranges", "bytes");
  // `private` is a permission boundary, not a hint: `public` lets a shared proxy cache a
  // members-only screenshot and serve it to a non-member. `immutable` is honest because bytes
  // never change for an id — a replacement is a new attachment.
  //
  // The trade, recorded in spec §7.4: revocation applies to new fetches, not to bytes already
  // in a browser cache.
  headers.set("cache-control", `private, max-age=${YEAR}, immutable`);
  headers.set("vary", "Cookie");
  // Validated, not trusted. `Headers.set` throws on an invalid value, and this runs OUTSIDE
  // the try that produces the 502 — so a malformed upstream ETag would surface as an
  // unhandled 500 rather than the route's own error. Dropping it is always safe: nothing
  // consumes it, since no conditional handling exists.
  if (eTag && /^(W\/)?"[\x21\x23-\x7E]*"$/.test(eTag)) headers.set("etag", eTag);
  return headers;
}

/**
 * `Range`, or null to send everything, or "unsatisfiable" for 416.
 *
 * A syntactically invalid header is IGNORED rather than rejected, which RFC 9110 requires —
 * rejecting it would break a client that sent a range unit we do not implement. Only a
 * well-formed range that cannot be satisfied is a 416. `bytes=2-` is the form a video player
 * actually sends when seeking, so the open end resolves against the stored size.
 *
 * Two conforming choices this makes implicitly, stated so they read as decisions:
 *
 * - **A multi-range header is ignored, not partially served.** `bytes=1-2, 4-4` fails this
 *   regex and falls through to a full 200. RFC 9110 §14.2 does not require multipart/byteranges
 *   support, and answering the whole representation is explicitly permitted. Serving only the
 *   first sub-range would also conform and is strictly more surprising.
 * - **An over-long range clamps to a 206, not a 200.** `bytes=0-99` on a 5-byte object answers
 *   `206` with `Content-Range: bytes 0-4/5`, even though the clamped range is the whole object.
 *   Also permitted, and it keeps every satisfiable range on one code path.
 *
 * Measured, and the reason `bytes=-0` is separated out: a suffix length of zero is unsatisfiable
 * by definition, while `bytes=0-0` is an ordinary one-byte request. They must not collapse.
 */
function parseRange(
  header: string | null,
  totalBytes: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // A suffix range — `bytes=-500` means the LAST 500 bytes, not the first.
  if (rawStart === "") {
    const length = Number(rawEnd);
    // `totalBytes === 0` is the only input in this parser that can yield a negative offset:
    // it would return `{ start: 0, end: -1 }`, which reaches the wire as
    // `Content-Range: bytes 0--1/0`. Unreachable today only because `sizeBytes` is
    // `.positive()` two modules away and `commitUpload` refuses a mismatch — an invariant
    // this function neither states nor enforces, so it enforces it here.
    if (length === 0 || totalBytes === 0) return "unsatisfiable";
    return { start: Math.max(0, totalBytes - length), end: totalBytes - 1 };
  }

  const start = Number(rawStart);
  if (start >= totalBytes) return "unsatisfiable";
  const end = rawEnd === "" ? totalBytes - 1 : Math.min(Number(rawEnd), totalBytes - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, (await params).id, true);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, (await params).id, false);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to remove this file." },
      { status: 401 },
    );
  }

  const result = await softDeleteAttachment(viewer, (await params).id);
  if (result.ok) return new NextResponse(null, { status: 204 });
  return NextResponse.json(
    { error: "not-found", message: "That file could not be found." },
    { status: 404 },
  );
}
