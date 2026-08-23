import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { draftSaveInput, MAX_DRAFT_BODY_BYTES } from "@/lib/drafts/schema";
import { saveDraft } from "@/lib/drafts/repo";

/**
 * The draft autosave endpoint. Fires every couple of seconds per open editor, which is why
 * the size guards below matter more here than anywhere else in the application.
 *
 * This handler is a translation layer and nothing more: `saveDraft` owns the permission
 * rules, the conflict decision and the atomic write, and already returns a discriminated
 * result covering every outcome. Re-deriving any of that here would give the HTTP layer a
 * second, divergent copy of rules that are security properties — in particular the
 * 404-not-403 line, which is drawn in the repository and only *rendered* here.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to edit this page." },
      { status: 401 },
    );
  }

  // Reject on the DECLARED size, before `request.json()` buffers and parses the whole body.
  //
  // A MISSING header is its own rejection, and it has to come first: a chunked request omits
  // `Content-Length` entirely, `Number(null)` is 0, and a numeric-only cap therefore waves
  // every unbounded body straight through. 411 Length Required is the status that exists for
  // exactly this, and it tells a client something actionable — "declare your length" — where
  // a 413 would tell it to send less of a body it never measured.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }

  // The cap is in bytes because the header is in bytes. See `MAX_DRAFT_BODY_BYTES` for why
  // re-deriving it from any character count is wrong.
  const bytes = Number(declaredLength);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_DRAFT_BODY_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That draft is too large to save." },
      { status: 413 },
    );
  }

  const parsed = draftSaveInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", message: "That draft could not be read." },
      { status: 400 },
    );
  }

  const { pageId } = await params;
  const result = await saveDraft(viewer, pageId, parsed.data);

  if (result.ok) {
    // `updatedAt` serialises as an ISO string with millisecond precision (the column is
    // `TIMESTAMP(3)`), and it is exactly what the client must send back as `seen` on its next
    // save. Returning the request's own `seen` instead — or the row's `createdAt` — would
    // leave the client holding a timestamp the row does not have, and every subsequent save
    // would 409 with nothing to reconcile. `tests/integration/draft-route.test.ts` pins the
    // round trip rather than trusting this comment.
    //
    // 201 on the first save, 200 on every one after it, from the repository's own `created`
    // flag — which it learns from the write, not from a pre-read that could be stale.
    return NextResponse.json(result.draft, { status: result.created ? 201 : 200 });
  }

  switch (result.reason) {
    // Byte-identical to the answer for a page id that never existed, because it is the same
    // branch: a page in a space the caller cannot read must be indistinguishable from one
    // that is not there. The repository refuses to tell them apart, and this must not.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    // Safe to be specific: reaching this means the caller can already READ the page, so
    // "you cannot edit it" discloses nothing they did not already know.
    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: "You do not have permission to edit this page." },
        { status: 403 },
      );

    // Both texts, per spec §9. The banner cannot offer "load theirs" without theirs, and
    // cannot offer "keep mine" without mine having survived the refusal.
    //
    // `theirs` is NULL when the draft vanished between the failed write and the read that
    // describes it — a concurrent publish (Task 9) or page delete (Task 12) removed the row.
    // The key is still emitted rather than omitted, so a client can tell "no other draft"
    // from a truncated body, and the status stays 409: the save was refused, and refusing is
    // the point. What the client shows in that case is a banner with ONE action instead of
    // two — no "load theirs" to offer, so: "This page's draft was published or removed while
    // you were editing. Your text is below and has not been saved; copy it somewhere before
    // reloading." `mine` is what makes that promise keepable.
    case "conflict":
      return NextResponse.json(
        { error: "conflict", theirs: result.theirs, mine: result.mine },
        { status: 409 },
      );
  }
}
