import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { beginUpload } from "@/lib/attachments/repo";
import { beginUploadInput, MAX_UPLOAD_BYTES } from "@/lib/attachments/schema";
import { isAllowedMime } from "@/lib/attachments/policy";

/**
 * Begin an upload. A translation layer and nothing more: `beginUpload` owns the permission
 * rules and the 404-not-403 line, and returns a discriminated result covering every outcome.
 *
 * The body is FOUR SMALL FIELDS, not the file. The `Content-Length` guard below is bounding a
 * few hundred bytes of JSON; the real size limit is `sizeBytes`, checked before any upload
 * session exists so a rejected file never reaches the store.
 */

/** Generous for four fields, and small enough that no body is buffered to reject one. */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to attach a file." },
      { status: 401 },
    );
  }

  // A missing header is its own rejection and must come first: a chunked request omits it,
  // `Number(null)` is 0, and a numeric-only cap lets an unbounded body through.
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declared);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That request is too large." },
      { status: 413 },
    );
  }

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = beginUploadInput.safeParse(raw);
  if (!parsed.success) {
    // The two rejections a person can act on get their own status and their own message. An
    // unsupported type and an oversized file are both "invalid" to zod, and both are useless
    // to a user as a bare 400.
    if (typeof raw?.mimeType === "string" && !isAllowedMime(raw.mimeType)) {
      return NextResponse.json(
        { error: "unsupported-type", message: `${raw.mimeType} cannot be attached.` },
        { status: 415 },
      );
    }
    // An empty file is its own rejection. `sizeBytes` is `.positive()`, so zero fails zod and
    // would otherwise fall through to the generic "could not be read" — which tells someone
    // who just dragged in an empty file nothing about why. Rare, but the generic message is
    // actively misleading here.
    if (raw?.sizeBytes === 0) {
      return NextResponse.json(
        { error: "empty", message: "That file is empty." },
        { status: 400 },
      );
    }
    if (typeof raw?.sizeBytes === "number" && raw.sizeBytes > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: "too-large",
          message: `That file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1_048_576)}MB limit.`,
        },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { error: "invalid", message: "That upload could not be read." },
      { status: 400 },
    );
  }

  const result = await beginUpload(viewer, parsed.data);
  if (result.ok) {
    return NextResponse.json(
      {
        attachmentId: result.attachmentId,
        uploadUrl: result.uploadUrl,
        expiresAt: result.expiresAt.toISOString(),
      },
      { status: 201 },
    );
  }

  switch (result.reason) {
    // Byte-identical to a page id that never existed — same branch, deliberately.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page could not be found." },
        { status: 404 },
      );
    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: "You cannot edit this page." },
        { status: 403 },
      );
    case "store-unavailable":
      return NextResponse.json(
        {
          error: "store-unavailable",
          message: "File storage is not responding. Your text is saved — try the file again.",
        },
        { status: 503 },
      );
  }
}
