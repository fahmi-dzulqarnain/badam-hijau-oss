import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { ADMIN_SYSTEMS_PATH, SYSTEMS_PATH } from "@/lib/pages/href";
import { listSystemsForAdmin } from "@/lib/systems/admin";
import { AdminSystems } from "@/components/AdminSystems";

/**
 * `/admin/systems` — spec §7's *"admins manage the list"*, §11's `/admin/*`. Phase 7 Task 5.
 *
 * **The first `/admin` route in the product**, so what it does about permission is a pattern three
 * more tasks will copy, and it is deliberately thin: `requireViewer` sends a signed-out visitor to
 * sign in, `listSystemsForAdmin` decides everything else, and a refusal renders `notFound()`.
 *
 * ## Two guards, refusing two different people, and only one of them is here
 *
 * `requireViewer` refuses *nobody* — it redirects an unauthenticated visitor. The permission
 * predicate is `refuseNonAdmin` in `src/lib/admin/gate.ts`, stated once for every admin surface
 * there will be, and this route only translates its answer. That split is `/-/mirror`'s — Phase 5
 * Task 8's, now this route's sibling at `/admin/git` — and it is
 * what makes each guard separately killable: delete the redirect and a signed-out visitor gets a
 * crash instead of a sign-in page; delete the gate and every signed-in person reads the catalogue's
 * administration. `tests/integration/systems-admin.test.ts` and `e2e/admin-systems.spec.ts` assert
 * them separately.
 *
 * **The refusal is `notFound()` and not a 403.** §8's answer everywhere, and on an admin route it
 * is doing real work: a 403 from a route that is otherwise 404 tells an ordinary member that
 * `/admin/systems` exists. `src/lib/admin/gate.ts` carries the full argument.
 *
 * ## The route collision, measured rather than reasoned about
 *
 * `/admin/systems` is **fully static** — two literal segments, no dynamic one — which is what makes
 * its window narrower than `/systems/[key]`'s. Measured the way Phase 5 Task 8 and Task 3 both
 * measured theirs, against a real `next build` and `next start` with a space genuinely keyed
 * `admin` holding published pages at `systems`, `ordinary` and `deep/page`:
 *
 * | URL | Answer | What served it |
 * |---|---|---|
 * | `/admin` | 200 | the **space's** landing page — there is no `/admin/page.tsx`, so nothing shadows it |
 * | `/admin/systems` | 200 | this route, over the space's published page at `systems` |
 * | `/admin/ordinary` | 200 | the space's own page at depth one |
 * | `/admin/deep/page` | 200 | the space's own page at depth two |
 *
 * `routes-manifest.json` puts `^/admin/systems(?:/)?$` in **`staticRoutes`**, which is matched
 * ahead of every dynamic route, and adds **no** entry to `dynamicRoutes` — the contrast with
 * `/systems/[key]`, which sits in `dynamicRoutes` ahead of `/[space]` and therefore swallows every
 * depth-one path in a space keyed `systems`, 404ing rather than falling through. **So the window
 * here is exactly one path**, the `/-/mirror` shape rather than the `/systems` one (that
 * measurement stands; Task 7 has since moved the route it was taken on to `/admin/git`, which is
 * the same shape one segment along), and a space
 * keyed `admin` keeps its landing page and everything else it has.
 *
 * Tasks 6, 7 and 8 each add one more leaf and therefore one more path to that window. An `/admin`
 * index page would be the thing that also takes the landing page, which is why there is none yet —
 * see `src/app/(reader)/admin/layout.tsx`. No space is keyed `admin` today; Task 6 closes the
 * window going forward without retro-validating the two rows that exist.
 *
 * ## Overflow
 *
 * Every string on this page is typed by a person — a system's key, name, owning team, description
 * and repository URL by an admin, and behind the "which pages" control a title, path and space
 * name by an author. All of them are painted **outside** `.body`, the shape that widened the
 * reader by 4,321px before `.doc > h1` was fixed, and Task 3's ninth shape (`flex: none` defeating
 * `overflow-wrap`) was on this surface's sibling. `e2e/admin-systems.spec.ts` measures the class
 * with `HOSTILE` rather than with the seeded corpus.
 */
export default async function AdminSystemsPage() {
  const viewer = await requireViewer(ADMIN_SYSTEMS_PATH);

  const result = await listSystemsForAdmin(viewer);
  if (!result.ok) notFound();

  return (
    <main className="doc">
      <p className="sys-back">
        <Link href={SYSTEMS_PATH}>Systems</Link>
      </p>
      <h1>Manage systems</h1>
      <p className="sys-lead">
        The catalogue behind <code className="sys-code">systems:</code> frontmatter and every
        page under <code className="sys-code">/systems</code>. A key here is the token authors
        type, so it is matched against their documents — publish refuses a key this list does not
        have.
      </p>
      <AdminSystems systems={result.systems} />
    </main>
  );
}
