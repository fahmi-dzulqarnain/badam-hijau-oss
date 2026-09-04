import "@/components/shell.css";
import "@/components/doc.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The shell for `/-/mirror`.
 *
 * A layout and not the page, because that is where a stylesheet may be imported: Phase 1 measured
 * that a route importing its own CSS makes `.doc` compute `max-width: none` on a hard load and
 * `820px` on a soft navigation to the same route. `/search`'s layout says the same and is the
 * precedent this copies — this route is not inside a space either, so it cannot borrow the space
 * layout's import.
 *
 * **No nav rail**, for `/search`'s reason: `NavRail` names the pages of one space and takes a
 * space key, and a failure list spans every space there is. `.shell`'s grid goes with it; `.doc`
 * carries its own `min-width: 0` and its own overflow guards.
 *
 * `requireViewer` is the page's and not this layout's — again `/search`'s rule. This layout
 * renders nothing that depends on who is asking, and a redirect fired here would pre-empt the
 * page's own read, which is the thing that has to decide between a viewer and a 404.
 */
export default function MirrorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
