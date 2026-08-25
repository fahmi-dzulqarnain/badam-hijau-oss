import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { publishPage } from "@/lib/pages/publish";
import { pageHref } from "@/lib/pages/href";

/**
 * Publish.
 *
 * Like the autosave endpoint, this handler is a translation layer and nothing more:
 * `publishPage` owns the permission rules, the transition table, the transaction and the
 * 404-not-403 line, and already returns a discriminated result covering every outcome.
 * Re-deriving any of it here would give the HTTP layer a second, divergent copy of rules
 * that are security properties.
 *
 * **It reads no request body, and that is why there is no 411/413 dance here.** The draft and
 * preview endpoints cap on the declared `Content-Length` before parsing because a caller
 * hands them a whole Markdown document; publish takes its content from the draft row that is
 * already in the database. There is nothing to size, so there is nothing to guard — and
 * adding the guard anyway would suggest a body exists and can be sent, which is the opposite
 * of true: the status to publish into is derived, never accepted. Phase 3 now takes it from the
 * `status:` key of the draft's own frontmatter — which is still a row in the database, not a
 * field of this request.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to publish this page." },
      { status: 401 },
    );
  }

  const { pageId } = await params;
  const result = await publishPage(viewer, pageId);

  if (result.ok) {
    // `pageHref` builds the reader URL, rather than the client concatenating the space key
    // and the path. `Page.path` has no format constraint, so per-segment encoding is the
    // difference between a working link and a broken one — and this project has already had
    // three link sites, two of which grew their own divergent copy of that rule.
    return NextResponse.json(
      {
        pageId: result.page.id,
        title: result.page.title,
        status: result.page.status,
        versionId: result.page.versionId,
        href: pageHref(result.page.spaceKey, result.page.path),
        // **The relations this publish recorded and did not act on** — Phase 3 Task 11. A
        // cascade fires only on the publish that reaches `ACCEPTED`, so an ADR published at
        // `PROPOSED` carries a `supersedes:` that retires nothing yet, and until now nothing
        // said so: "I said it supersedes ADR-31 and ADR-31 is still current" reads as a bug.
        //
        // Mapped field by field, as the `invalid` branch below is, and for the same reason:
        // what crosses this boundary is stated here rather than inherited from whatever shape
        // the module that produced it happens to have. Always present, empty on almost every
        // publish — a key that appears on some replies and not others is indistinguishable from
        // one somebody forgot to plumb.
        dormant: result.page.dormant.map((cascade) => ({
          type: cascade.type,
          ref: cascade.ref,
          wouldRetireInto: cascade.wouldRetireInto,
        })),
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
        { error: "forbidden", message: "You do not have permission to publish this page." },
        { status: 403 },
      );

    // 422, not 400. The request was perfectly well formed — there is no body to malform —
    // and the refusal is about the state of the draft it names. A 400 would tell the client
    // to fix its request, when what needs fixing is the document.
    //
    // `field` and `code` travel with the sentence so the editor can put the message next to
    // the input it belongs to instead of in a generic banner, and so a future surface can
    // switch on the code without parsing English.
    //
    // **`errors` carries all of them and `key` names the frontmatter key at fault**, added by
    // Phase 3 Task 7 because frontmatter validation returns every error rather than the first:
    // a page with two mistyped keys should not take two publish attempts to fix. The top-level
    // `field`/`code`/`message` are `errors[0]` and are unchanged, so the editor keeps rendering
    // the one sentence it renders today — designing the surface that shows the rest, against
    // the line each `key` names, is Task 11's. Mapped field by field rather than serialised
    // whole: a relation refusal carries `type` and `ref` too, and what crosses this boundary
    // should be stated here rather than inherited from whichever module produced the error.
    case "invalid":
      return NextResponse.json(
        {
          error: "invalid",
          field: result.error.field,
          key: result.error.key,
          code: result.error.code,
          message: result.error.message,
          errors: result.errors.map((error) => ({
            field: error.field,
            key: error.key,
            code: error.code,
            message: error.message,
          })),
        },
        { status: 422 },
      );
  }
}
