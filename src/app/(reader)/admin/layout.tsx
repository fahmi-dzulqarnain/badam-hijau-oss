import Link from "next/link";
import "@/components/shell.css";
import "@/components/doc.css";
import { buildInfo } from "@/lib/version/build";
import {
  ADMIN_BUGS_PATH,
  ADMIN_GIT_PATH,
  ADMIN_SPACES_PATH,
  ADMIN_SYSTEMS_PATH,
} from "@/lib/pages/href";
import { TopBar } from "@/components/TopBar";

/**
 * The shell for `/admin/*` — Phase 7's four administration surfaces, spec §11, all four of them
 * built by Tasks 5 to 8.
 *
 * A layout and not the page, because that is where a stylesheet may be imported: Phase 1 measured
 * that a route importing its own CSS makes `.doc` compute `max-width: none` on a hard load and
 * `820px` on a soft navigation to the same route. `/search` and `/systems` say the same and are
 * the precedent this copies — an admin route is not inside a space, so it cannot borrow the space
 * layout's import. `/-/mirror` was the third such precedent and is now one of these children:
 * Task 7 absorbed it, and its own layout was deleted rather than moved, because this file already
 * does what it did for three siblings.
 *
 * **No nav rail**, for `/search`'s reason: `NavRail` names the pages of one space and takes a
 * space key, and these surfaces are about the installation. `.shell`'s grid goes with it; `.doc`
 * carries its own `min-width: 0` and its own overflow guards.
 *
 * **There is no `page.tsx` beside this file, and that is deliberate.** A layout without a page
 * creates no route, so `/admin` still resolves to `[space]` and a space keyed `admin` keeps its
 * landing page — see `ADMIN_SYSTEMS_PATH` in `src/lib/pages/href.ts` for the measured window. An
 * `/admin` index would be a fifth surface and would widen that window by one more path; Task 9 is
 * where a decision about one belongs, once there are four leaves to index.
 *
 * **`requireViewer` is each page's, not this layout's**, and the reason is stronger here than on
 * `/systems`: the refusal that matters on an admin route is `notFound()` for a signed-in
 * non-admin, and that answer comes from the module's own result. A redirect fired from this layout
 * would pre-empt the read that has to distinguish the two.
 *
 * ## The cross-links are here, and they are the affordance an `/admin` index would otherwise be
 *
 * Task 6 added the second leaf, Task 7 the third and Task 8 the fourth, and two surfaces with
 * nothing linking between them is how the second one gets found by nobody — this project has shipped a feature with no way
 * to reach it twice (`movePage`, `/search`), and Task 3 added `/systems` to the top bar in the task
 * that built it rather than discovering the gap a third time. An `/admin` index page would be the
 * obvious home for these links and is deliberately still not built: **a layout without a page creates no
 * route**, so `/admin` continues to resolve to `[space]` and a space keyed `admin` keeps its
 * landing page. Putting the nav in the layout buys the affordance at a cost of zero paths.
 *
 * It renders on the 200 only. A `notFound()` from one of these pages resolves to the root
 * `src/app/not-found.tsx`, which this layout does not wrap — which is what makes
 * `e2e/admin-systems.spec.ts`'s "the refusal is byte-identical to a URL nobody built a route for"
 * assertion hold, and is worth knowing before adding anything else here.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {/* No heading: `e2e/admin-systems.spec.ts` asserts on the page's own single `h1`, and a
          layout that grew one would be answering for the page below it. */}
      <nav className="adm-nav" aria-label="Administration">
        <Link href={ADMIN_SPACES_PATH}>Spaces</Link>
        <Link href={ADMIN_SYSTEMS_PATH}>Systems</Link>
        {/* Task 7. It is in the nav for every admin surface rather than only from a stuck page's
            history, which is where Phase 5's one affordance lived: an operator who wants to know
            whether the mirror is behind should not have to find a page that is. */}
        <Link href={ADMIN_GIT_PATH}>Git mirror</Link>
        {/* Task 8, and the fourth leaf. Phase 1 shipped the rail's Report bug button with nowhere
            for the reports to be read; this link is the other end of it, and it is in the nav for
            the same reason the mirror's is — a triage inbox nobody can find is an inbox that is
            always empty. */}
        <Link href={ADMIN_BUGS_PATH}>Bug reports</Link>
      </nav>
      {children}
    </>
  );
}
