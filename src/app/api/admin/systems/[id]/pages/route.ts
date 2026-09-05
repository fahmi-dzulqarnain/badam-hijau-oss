import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { listBlockingPages } from "@/lib/systems/admin";

/**
 * The pages that name one system — the **audited** half of Task 1's line, on its own endpoint.
 *
 * Task 1 drew the boundary in the schema: *"Showing the number needs no audit; showing the titles
 * does."* That is why this is a separate request rather than columns on the page's initial render.
 * The count ships with every row of `/admin/systems` and costs nothing; the titles are fetched only
 * when an admin asks for them, and `listBlockingPages` writes one `space.access` row per space that
 * produced a row while it does. Folding the two together would audit a page view of the catalogue
 * as though it were a read of every space in the installation, and noise is how an audit table
 * stops being read.
 *
 * **A `GET` that writes an audit row**, which is worth naming rather than leaving to be noticed:
 * the row records a *read*, so the method is honest about what the caller is doing, and the write
 * is `auditSpaceAccess`'s — off the response through `after()` where there is one, and unable to
 * throw either way. Every space read in the product has had this shape since Phase 1; this is the
 * first one behind an explicit control.
 *
 * The route reads no query string and takes nothing from the client but the id in the path, so
 * there is nothing here to validate — the module answers not-found for an id that names nothing,
 * with the same body a non-admin gets.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage systems." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const result = await listBlockingPages(viewer, id);

  if (!result.ok) {
    return NextResponse.json(
      { error: "not-found", message: "That page does not exist." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { key: result.key, pages: result.pages, truncated: result.truncated },
    { status: 200 },
  );
}
