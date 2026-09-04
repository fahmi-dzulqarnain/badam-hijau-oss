import "@/components/shell.css";
import "@/components/doc.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The shell for `/search` — spec §11's cross-space route.
 *
 * **A layout and not the page, because that is where a stylesheet may be imported.** Phase 1
 * measured what a route importing its own CSS does: `.doc` computed `max-width: none` on a hard
 * load and `820px` on a soft navigation to the same route. The space layout imports these two
 * files for the same reason, and this is the second layout to need them — `/search` is not inside
 * a space, so it cannot borrow that one.
 *
 * **No nav rail, deliberately.** `NavRail` names the pages of *one* space and takes a space key;
 * a search spans every space the viewer can read, so there is no key to give it and no tree to
 * show. The results are the navigation. `.shell`'s grid is left out with it — a single column
 * needs no track, and `.doc` carries its own `min-width: 0` and its own overflow guards.
 *
 * `requireViewer` is the page's, not this layout's. The space layout resolves a viewer here
 * because it renders a rail out of that viewer's readable pages; this one renders nothing that
 * depends on who is asking, and a redirect from a layout would fire on a route whose own read is
 * about to do it properly.
 */
export default function SearchLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
