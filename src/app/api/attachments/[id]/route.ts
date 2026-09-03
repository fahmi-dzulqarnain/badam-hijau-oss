import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { readableAttachment, softDeleteAttachment } from "@/lib/attachments/repo";
import { blobStore } from "@/lib/blob/select";
import { contentDisposition } from "@/lib/attachments/policy";
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
  } catch {
    // 502, not 404: a Graph outage must not read as every attachment having been deleted.
    // The page itself still renders — this is one broken image, never a 500.
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
  headers.set("content-length", String(body.sizeBytes));
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${body.totalBytes}`);
  }

  return new NextResponse(withBody ? body.stream : null, {
    status: range ? 206 : 200,
    headers,
  });
}

function commonHeaders(attachment: ReadableAttachment, eTag: string | null): Headers {
  const headers = new Headers();
  // From Postgres, never from the store. The mime was validated once against the allowlist at
  // upload; letting the store decide would let a file's own metadata pick its interpretation.
  headers.set("content-type", attachment.mimeType);
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
  if (eTag) headers.set("etag", eTag);
  return headers;
}

/**
 * `Range`, or null to send everything, or "unsatisfiable" for 416.
 *
 * A syntactically invalid header is IGNORED rather than rejected, which RFC 9110 requires —
 * rejecting it would break a client that sent a range unit we do not implement. Only a
 * well-formed range that cannot be satisfied is a 416. `bytes=2-` is the form a video player
 * actually sends when seeking, so the open end resolves against the stored size.
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
    if (length === 0) return "unsatisfiable";
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
