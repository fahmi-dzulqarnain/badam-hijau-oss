import "@/components/shell.css";
import "@/components/newpage.css";
import { buildInfo } from "@/lib/version/build";
import { TopBar } from "@/components/TopBar";

/**
 * The authoring shell. Stylesheets are imported here rather than from the route, following
 * the reader: Phase 1 measured a class computing differently on a hard load than on a soft
 * navigation when its stylesheet was pulled in from a page.
 *
 * No nav rail — an authoring route is not scoped to one space, and the rail needs a space
 * key. Task 7 hangs the editor off this same layout.
 */
export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopBar build={buildInfo()} />
      {children}
    </>
  );
}
