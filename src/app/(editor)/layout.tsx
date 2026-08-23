import "@/components/shell.css";
import "@/components/doc.css";
import "@/components/newpage.css";
import "@/components/editor.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The authoring shell. Stylesheets are imported here rather than from the route, following
 * the reader: Phase 1 measured a class computing differently on a hard load than on a soft
 * navigation when its stylesheet was pulled in from a page.
 *
 * No nav rail — an authoring route is not scoped to one space, and the rail needs a space
 * key. Task 7 hangs the editor off this same layout.
 *
 * All of them load on both routes. That is deliberate rather than tolerated: every selector
 * in `newpage.css` and `editor.css` is prefixed (`np-`, `ed-`) and defined in exactly one
 * place, so a stylesheet that is present but unused cannot collide with anything. Splitting
 * them per route to avoid the few unused bytes is what would reintroduce the load-order
 * hazard.
 *
 * `doc.css` is here because Task 8's preview pane renders the reader's HTML into the
 * reader's own `.body` class — an approximation of the reader's typography would reintroduce
 * by CSS exactly the preview/published divergence the server-rendered pipeline removes. It
 * is imported from the LAYOUT, never from the route, which is the whole rule: Phase 1
 * measured `.doc` computing a different `max-width` on a hard load than on a soft navigation
 * when a page route pulled its own stylesheet in. None of its selectors are defined
 * anywhere else in this bundle, so its presence here cannot change the `/new` route.
 */
export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
