import "@/components/shell.css";
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
 * Both stylesheets load on both routes. That is deliberate rather than tolerated: every
 * selector in each file is prefixed (`np-`, `ed-`) and defined in exactly one place, so a
 * stylesheet that is present but unused cannot collide with anything. Splitting them per
 * route to avoid the few unused bytes is what would reintroduce the load-order hazard.
 */
export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
