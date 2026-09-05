import "@/components/shell.css";
import "@/components/doc.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The shell for `/systems` and `/systems/[key]` — spec §11's other cross-space route.
 *
 * **A layout and not the pages, because that is where a stylesheet may be imported.** Phase 1
 * measured what a route importing its own CSS does: `.doc` computed `max-width: none` on a hard
 * load and `820px` on a soft navigation to the same route. `/search`'s layout exists for exactly
 * this and this is the third to need it — a system page is not inside a space, so it cannot
 * borrow the space layout's copy.
 *
 * One layout for both routes, which is what makes the catalogue and a system page look like two
 * views of one thing rather than two surfaces that happen to agree today.
 *
 * **No nav rail**, for `/search`'s reason: `NavRail` names the pages of *one* space and takes a
 * space key, and these routes span every space the viewer can read. `.shell`'s grid goes with it
 * — a single column needs no track, and `.doc` carries its own `min-width: 0` and its own
 * overflow guards.
 *
 * `requireViewer` is each page's, not this layout's: a redirect from a layout would fire on a
 * route whose own read is about to do it properly, and the two pages have different return paths
 * to come back to after signing in.
 */
export default function SystemsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
