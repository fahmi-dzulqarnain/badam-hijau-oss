import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { confirmReview } from "@/lib/pages/review";
import { pageHref } from "@/lib/pages/href";

/**
 * Confirm that a page has been reviewed — spec §12.
 *
 * Like `restore/route.ts`, this handler is a translation layer and nothing more: `confirmReview`
 * owns the permission rule, the write predicate, the audit row and the discriminated result. It
 * reads no body, for the same reason restore reads none — there is nothing to say beyond "this
 * page, now", and the timestamp is the server's.
 *
 * **`POST` and not `PUT`, and the difference is real here.** A confirm is not idempotent: each
 * one moves `reviewedAt` to a new instant and writes an audit row, which is exactly the record
 * §12's list depends on. A `PUT` would advertise that repeating it changes nothing.
 *
 * The 403's sentence is the module's own, verbatim, for the reason restore's is: that `EDIT` is
 * not sufficient here is the one thing about this endpoint nobody can guess, and the only
 * explanation that exists should not acquire a second, worse copy at the route.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to confirm a review." },
      { status: 401 },
    );
  }

  const { pageId } = await params;
  const result = await confirmReview(viewer, pageId);

  if (result.ok) {
    return NextResponse.json(
      {
        pageId: result.page.id,
        reviewedAt: result.reviewedAt.toISOString(),
        href: pageHref(result.page.spaceKey, result.page.path),
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // Byte-identical to the answer for a page id that never existed, which is what stops the
    // status code telling a stranger that a page in a space they cannot read exists.
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
  }
}
