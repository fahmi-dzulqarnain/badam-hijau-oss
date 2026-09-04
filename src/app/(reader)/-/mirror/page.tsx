import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { listMirrorFailures } from "@/lib/git/failures";
import { MIRROR_FAILURES_PATH } from "@/lib/pages/href";
import { MirrorFailures } from "@/components/MirrorFailures";

/**
 * `/-/mirror` — the mirror jobs that gave up, for a super admin. Spec §10: *"persistent failures
 * surface on an admin page rather than only in logs."*
 *
 * ## Why it is here and not under a space, and not at `/admin`
 *
 * `src/lib/pages/href.ts`'s `MIRROR_FAILURES_PATH` carries the argument in full. The short of it:
 * a wedged mirror is a property of the mirror and not of a space, so `/{space}/-/mirror` would
 * have to either hide failures or paint one space's heading over another space's pages; a
 * top-level static segment shadows any space whose key matches it, and `Space.key` has no
 * validation anywhere; so the segment chosen is the one character the product **already** declares
 * reserved (`validateSlug` refuses a leading `-`, with its own error code and its own test), which
 * makes the Phase 7 fix one rule rather than a growing list of English words. `/admin` is Phase
 * 6's and is not squatted on here.
 *
 * ## The collision, measured rather than reasoned about
 *
 * `/-/mirror` matches this route **and** `[space]/[...path]` with `space = "-"` and
 * `path = ["mirror"]`. Next resolves a static segment ahead of a dynamic one, and Task 7 measured
 * that for `-/history`; the new question here is what happens when a space genuinely *is* keyed
 * `-`, because at this depth the shadowed thing is a space rather than a page path no product
 * surface can create.
 *
 * Measured against a real `next build` and `next start` on the test database, with a space keyed
 * `-` holding a published page at `welcome`:
 *
 * - `routes-manifest.json` lists `^/\-/mirror(?:/)?$` **before** `^/([^/]+?)/(.+?)(?:/)?$`.
 * - `/-/mirror` answered `200` with `<h1>Mirror failures</h1>` — this route, not the space's page.
 * - `/-/welcome` answered `200` with the space's own page, so the shadow is one URL wide and does
 *   not swallow the space.
 * - `/-` answered `200` with the space landing page, because `[space]` is what matches one
 *   segment.
 *
 * So the collision is real, it is exactly one path deep, and it costs a space keyed `-` the
 * ability to hold a page at `mirror`. That is the same debt `/search` already carries and it is
 * recorded here rather than implied.
 *
 * ## The refusal is not-found, not forbidden
 *
 * `listMirrorFailures` refuses a viewer who is not a super admin and this renders `notFound()` —
 * indistinguishable from a route that does not exist, which is the project's answer everywhere
 * (spec §8, and `e2e/reader.spec.ts`'s "a non-member gets not-found rather than forbidden"). A
 * `403` would tell an ordinary member that a mirror-failures page exists.
 *
 * **Two guards, and they refuse different people.** `requireViewer` sends a signed-out visitor to
 * sign in; the module's `isSuperAdmin` check 404s a signed-in one who is not an admin. Deleting
 * either changes a different answer, which is what `tests/integration/git-failures.test.ts` and
 * `e2e/mirror.spec.ts` assert separately — a refusal that survives deleting the guard it names is
 * a test of the other guard.
 */
export default async function MirrorFailuresRoute() {
  const viewer = await requireViewer(MIRROR_FAILURES_PATH);

  const result = await listMirrorFailures(viewer);
  if (!result.ok) notFound();

  return <MirrorFailures report={result.report} />;
}
