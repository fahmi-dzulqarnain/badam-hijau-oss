import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { movePage } from "@/lib/pages/move";
import { MAX_MOVE_BODY_BYTES, movePageInput } from "@/lib/pages/move-schema";
import { pageHref } from "@/lib/pages/href";

/**
 * Move a page — rename it, reparent it, or both.
 *
 * Like `publish/route.ts`, this handler is a translation layer and nothing more: `movePage`
 * owns the permission rules, the cycle check, the occupancy check, the advisory lock, the
 * one-statement subtree rewrite, the redirects and the 404-not-403 line, and already returns
 * a discriminated result covering every outcome. Re-deriving any of it here would give the
 * HTTP layer a second, divergent copy of rules that are security properties — and there is
 * no version of "check it again at the edge" that is cheaper than the one query the module
 * already makes before it takes a lock.
 *
 * **It has a body, unlike publish, so Task 5's size handling applies** — with its own cap.
 * See `MAX_MOVE_BODY_BYTES` for why this endpoint does not import the draft endpoint's.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to move this page." },
      { status: 401 },
    );
  }

  // Reject on the DECLARED size, before `request.json()` buffers and parses anything.
  //
  // A MISSING header is its own rejection and has to come first: a chunked request omits
  // `Content-Length` entirely, `Number(null)` is 0, and a numeric-only cap therefore waves
  // every unbounded body straight through. Task 5 found this on the draft endpoint; the rule
  // is the same wherever a body exists, not a property of that one route.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }

  const bytes = Number(declaredLength);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_MOVE_BODY_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That move request is too large to read." },
      { status: 413 },
    );
  }

  const parsed = movePageInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", message: "That move request could not be read." },
      { status: 400 },
    );
  }

  const { pageId } = await params;
  const result = await movePage(viewer, pageId, parsed.data);

  if (result.ok) {
    // `pageHref` builds the reader URL rather than the client concatenating the space key and
    // the path. `Page.path` has no format constraint, so per-segment encoding is the
    // difference between a working link and a broken one.
    //
    // `rewritten` travels with it because it is the only number that distinguishes a rename
    // from a reorganisation, and the surface that asked for the move is the one place a
    // person can be told "that moved 40 pages" while it still means something to them.
    return NextResponse.json(
      {
        pageId: result.page.id,
        path: result.page.path,
        previousPath: result.page.previousPath,
        rewritten: result.page.rewritten,
        redirects: result.page.redirects,
        href: pageHref(result.page.spaceKey, result.page.path),
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // Byte-identical to the answer for a page id that never existed, because it is the same
    // branch: a page in a space the caller cannot read must be indistinguishable from one
    // that is not there.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    // Safe to be specific: reaching this means the caller can already READ the page.
    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: "You do not have permission to move this page." },
        { status: 403 },
      );

    // 422, not 400. The request was well formed — a 400 above is what a malformed one gets —
    // and the refusal is about the tree it describes: an occupied path, a cycle, a no-op, a
    // slug that breaks a rule. Every one of those is something the person can fix, and
    // `field` and `code` travel with the sentence so the form can render it against the
    // input it belongs to rather than in a generic banner.
    case "invalid":
      return NextResponse.json(
        {
          error: "invalid",
          field: result.error.field,
          code: result.error.code,
          message: result.error.message,
        },
        { status: 422 },
      );
  }
}
