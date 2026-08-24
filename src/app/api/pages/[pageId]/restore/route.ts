import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { restorePage } from "@/lib/pages/delete";
import { pageHref } from "@/lib/pages/href";

/**
 * Restore a soft-deleted page and the subtree the same delete took.
 *
 * Like `publish/route.ts`, this handler is a translation layer and nothing more: `restorePage`
 * owns the permission rule, the advisory lock, the ancestor check, the all-or-nothing write
 * predicate and the redirect reclaim, and already returns a discriminated result covering
 * every outcome. It reads no body, for the same reason delete reads none.
 *
 * **The permission is `MANAGE_SPACE`, not `EDIT`, and the 403 carries the module's own
 * sentence rather than this route's.** That asymmetry is deliberate — any editor can delete a
 * page, only a space admin can put one back — and it is the one `forbidden` in the codebase
 * that has a message, precisely because nobody can guess it. Re-wording it here would give
 * the one explanation that exists a second, worse copy; the fallback below is only for the
 * shape of the type, not for a case that occurs.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to restore this page." },
      { status: 401 },
    );
  }

  const { pageId } = await params;
  const result = await restorePage(viewer, pageId);

  if (result.ok) {
    return NextResponse.json(
      {
        pageId: result.page.id,
        path: result.page.path,
        restored: result.page.restored,
        redirectsCleared: result.page.redirectsCleared,
        href: pageHref(result.page.spaceKey, result.page.path),
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // Byte-identical to the answer for a page id that never existed. Note what it does NOT
    // cover here: an already-live page is `invalid`, not this — `restorePage` is the one
    // reader in the phase looking *for* a soft-deleted row, so "it is not deleted" is a
    // statement about a page the admin can see, and answering 404 would send them hunting.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: result.message },
        { status: 403 },
      );

    // 422, not 400: the request is well formed and there is no body to malform. The refusal
    // is about the state of the tree — the page is not deleted, or one of its ancestors still
    // is — and both are things an admin can act on, in that order. No `field`: restore has no
    // form, so `RestoreError` carries a code and a sentence and nothing to attach them to.
    case "invalid":
      return NextResponse.json(
        { error: "invalid", code: result.error.code, message: result.error.message },
        { status: 422 },
      );
  }
}
