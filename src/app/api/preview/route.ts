import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { canEditPage } from "@/lib/pages/editable";
import { previewInput } from "@/lib/preview/schema";
import { MAX_DRAFT_BODY_BYTES } from "@/lib/drafts/schema";
import { renderMarkdown } from "@/lib/markdown/render";

/**
 * Server-rendered preview.
 *
 * **It calls `renderMarkdown` — the function the reader calls, with no arguments the reader
 * does not pass.** That is the entire point of the route, not an implementation detail. A
 * client-side approximation, a second unified pipeline, or the same pipeline with one extra
 * option would each let the preview and the published page disagree, which is the one thing
 * a preview exists to rule out. If a future change needs an option here that the reader does
 * not use, the answer is to change the reader too or to not make the change — never to fork
 * the pipeline.
 *
 * Two consequences worth naming rather than discovering:
 *
 * - The response is sanitised HTML because `renderMarkdown` sanitises. The editor drops it
 *   in with `dangerouslySetInnerHTML`, exactly as the reader route does, and that is safe
 *   for exactly the same reason and no other. `rehype-sanitize` running before `rehype-slug`
 *   is load-bearing on both surfaces.
 * - It is not cheap. Every call parses, sanitises and syntax-highlights a whole document,
 *   and it fires on the same two-second tick as autosave. That is affordable because the
 *   caller debounces and never has two in flight, and because the alternative — a cheaper,
 *   different renderer — is the thing being ruled out.
 */
export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to preview this page." },
      { status: 401 },
    );
  }

  // Task 5's body handling, for Task 5's reasons — this endpoint carries the same Markdown
  // document on the same two-second cadence, so it inherits the same failure modes.
  //
  // A MISSING header is its own rejection and has to come first: a chunked request omits
  // `Content-Length` entirely, `Number(null)` is 0, and a numeric-only cap therefore waves
  // every unbounded body straight through.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }

  // The cap is in BYTES because the header is in bytes, and it is the draft endpoint's own
  // constant rather than a second number that happens to match today. The body carried here
  // is the same document the next autosave will PUT, so a preview limit below the save limit
  // would make the largest saveable documents unpreviewable, and one above it would let this
  // route render text that can never be published. They are one limit; it is imported.
  const bytes = Number(declaredLength);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_DRAFT_BODY_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That document is too large to preview." },
      { status: 413 },
    );
  }

  const parsed = previewInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", message: "That preview request could not be read." },
      { status: 400 },
    );
  }

  // Authorised per request, never once per open tab: this is a POST from a page that may
  // have been sitting open since before the viewer's membership was revoked.
  const access = await canEditPage(viewer, parsed.data.pageId);
  if (!access.ok) {
    // Byte-identical to the answer for a page id that never existed, because it is the same
    // branch. Tasks 4, 6 and 7 all draw this line in the same place and the four must not
    // diverge: a 403 on a page a stranger cannot read confirms the page is real.
    if (access.reason === "not-found") {
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );
    }
    // Safe to be specific: reaching this means the caller can already READ the page.
    return NextResponse.json(
      { error: "forbidden", message: "You do not have permission to edit this page." },
      { status: 403 },
    );
  }

  const { html } = await renderMarkdown(parsed.data.markdown);
  // Headings are deliberately not returned. The reader builds its table of contents from
  // them; the preview pane has no rail to put one in, and shipping a field with no consumer
  // is how a second, divergent shape of the reader's output gets started.
  return NextResponse.json({ html }, { status: 200 });
}
