import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { deletePage } from "@/lib/pages/delete";
import { pageHref } from "@/lib/pages/href";

/**
 * Soft-delete a page and its subtree.
 *
 * Like `publish/route.ts`, this handler is a translation layer and nothing more: `deletePage`
 * owns the permission rule (`EDIT`), the advisory lock, the one-statement subtree stamp, the
 * redirects to the nearest surviving ancestor and the 404-not-403 line, and already returns a
 * discriminated result covering every outcome.
 *
 * **It reads no request body, so there is no 411/413 dance** — the same reason publish has
 * none. There is nothing to send: the page is named by the URL and the scope is the page's
 * own subtree, which the module computes. Accepting a body would suggest some part of that is
 * negotiable, and none of it is.
 *
 * **POST, not DELETE.** The route is `…/delete` and the verb is POST because this is a soft
 * delete of one named resource plus a subtree the caller does not enumerate, and because
 * `restore` is its exact counterpart at `…/restore` — a pair of POSTs reads as a pair, where
 * `DELETE /api/pages/{id}` and `POST /api/pages/{id}/restore` would not. Nothing here is
 * idempotent in the way DELETE promises either: a second call is `not-found`, because the row
 * it would take is already gone.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to delete this page." },
      { status: 401 },
    );
  }

  const { pageId } = await params;
  const result = await deletePage(viewer, pageId);

  if (result.ok) {
    // `redirectTo` is a path or an explicit null — a deleted root page has no surviving
    // ancestor and `Redirect.toPageId` is not nullable, so there is genuinely nowhere to
    // send its old URL. It is rendered as `null` rather than omitted so a client can tell
    // "no ancestor" from a truncated body, and as a *href* beside it so the surface that
    // asked for the delete can offer somewhere to go next without concatenating a URL.
    return NextResponse.json(
      {
        pageId: result.page.id,
        path: result.page.path,
        deleted: result.page.deleted,
        redirects: result.page.redirects,
        redirectTo: result.page.redirectTo,
        redirectHref:
          result.page.redirectTo === null
            ? null
            : pageHref(result.page.spaceKey, result.page.redirectTo),
        spaceHref: `/${encodeURIComponent(result.page.spaceKey)}`,
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // Byte-identical to the answer for a page id that never existed, because it is the same
    // branch — and here it is also the answer for a page that is *already* deleted, which is
    // the same statement about the world: there is no such live page.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    // Safe to be specific: reaching this means the caller can already READ the page.
    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: "You do not have permission to delete this page." },
        { status: 403 },
      );
  }
}
