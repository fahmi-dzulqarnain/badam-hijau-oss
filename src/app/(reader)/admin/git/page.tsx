import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { listMirrorFailures } from "@/lib/git/failures";
import { finishedJobsReport } from "@/lib/git/retention";
import { ADMIN_GIT_PATH } from "@/lib/pages/href";
import { AdminGit } from "@/components/AdminGit";
import { MirrorFailures } from "@/components/MirrorFailures";

/**
 * `/admin/git` — the git mirror's administration surface, spec §10 and §11's `/admin/*`, Phase 7
 * Task 7.
 *
 * ## It absorbed `/-/mirror`; it did not sit down beside it
 *
 * Phase 5 Task 8 shipped the failures list at `/-/mirror` and said so in its own docstring: *"Phase
 * 7 owns `/admin` and will fold this in."* This is that fold, and it is a **move**. Two surfaces
 * for one thing is how one of them goes stale, and the stale one is always the one nothing links
 * to. The old URL is now a 404 — `src/lib/pages/href.ts`'s {@link ADMIN_GIT_PATH} carries the
 * argument for that over a redirect, and the short of it is that a redirect is a route that
 * answers *everybody*, on a surface whose refusal is not-found precisely so that it does not.
 *
 * What moved with it: the list itself (`listMirrorFailures`, unchanged in what it selects), the
 * `MirrorFailures` component, the credential redaction at **both** ends, and the one affordance
 * that reaches it — the version-history page's stuck notice, which is generated from the constant
 * and therefore moved in the same commit. What did not move: `/-/mirror`'s own layout, because
 * `src/app/(reader)/admin/layout.tsx` already imports the stylesheets and paints the top bar for
 * three sibling surfaces, and a second layout saying the same thing is the duplication this move
 * exists to remove.
 *
 * ## Thin, exactly as the two admin routes beside it
 *
 * `requireViewer` sends a signed-out visitor to sign in; the modules decide everything else; a
 * refusal renders `notFound()`. **Two guards refusing two different people**, each separately
 * killable — delete the redirect and a signed-out visitor gets a crash instead of a sign-in page;
 * delete `refuseNonAdmin` and every signed-in person reads every space's page titles out of the
 * queue. `tests/integration/git-failures.test.ts` and `e2e/admin-git.spec.ts` assert them
 * separately, because a refusal that survives deleting the guard it names is a test of the other
 * guard.
 *
 * The refusal is `notFound()` and never a `403`: `src/lib/admin/gate.ts` carries the argument, and
 * this surface is the one Phase 5 wrote it down for first — a job list names pages in every space
 * there is.
 *
 * ## The route collision, and this leaf is free
 *
 * `/admin/git` is **fully static**, so `routes-manifest.json` puts it in `staticRoutes` and adds
 * nothing to `dynamicRoutes`: Task 5's measured shape, one more path lost by a space keyed `admin`
 * and its landing page untouched. The move is net **zero**, because deleting
 * `src/app/(reader)/-/mirror` gave the `-` segment back — it is no longer in
 * `RESERVED_TOP_LEVEL_SEGMENTS` at all, and `src/lib/spaces/key.test.ts`'s sweep is what enforces
 * that rather than this sentence.
 */
export default async function AdminGitPage() {
  const viewer = await requireViewer(ADMIN_GIT_PATH);

  /*
   * Two reads, one refusal each, awaited together because they are independent queries on one
   * connection pool rather than a sequence. Each states the permission for itself
   * through `refuseNonAdmin` — a page that checked once and then called two unguarded modules
   * would be the "guarded by call ordering" shape this project's rule names, and the two modules
   * are reachable from their own endpoints anyway.
   */
  const [failures, retention] = await Promise.all([
    listMirrorFailures(viewer),
    finishedJobsReport(viewer),
  ]);
  if (!failures.ok || !retention.ok) notFound();

  return (
    <main className="doc">
      <h1>Git mirror</h1>
      <p className="sys-lead">
        Spec §10&rsquo;s mirror: every publish, move, delete and restore is queued as a job, and a
        worker commits it to the content repository. The site does not depend on any of it — a page
        is published in Postgres whether or not its commit ever lands, so everything on this page
        is about the <em>copy</em>.
      </p>

      <AdminGit retention={retention.report} />

      <MirrorFailures report={failures.report} />
    </main>
  );
}
