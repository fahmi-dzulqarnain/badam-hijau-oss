import "@/components/shell.css";
import "@/components/doc.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The shell for `/admin/*` — Phase 7's four administration surfaces, spec §11.
 *
 * A layout and not the page, because that is where a stylesheet may be imported: Phase 1 measured
 * that a route importing its own CSS makes `.doc` compute `max-width: none` on a hard load and
 * `820px` on a soft navigation to the same route. `/search`, `/-/mirror` and `/systems` all say
 * the same and are the precedent this copies — an admin route is not inside a space, so it cannot
 * borrow the space layout's import.
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
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
