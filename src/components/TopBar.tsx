import Link from "next/link";
import type { Route } from "next";
import type { BuildInfo } from "@/lib/version/build";
import { BugReportButton } from "./BugReportButton";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
      {/*
        The one affordance that reaches search. Phase 4 built `/search` and nothing linked to it —
        the same defect as Phase 2's `movePage`, which shipped as a library function with no way
        to call it, and which cost a whole extra task to close. It lives here rather than in the
        nav rail because `NavRail` takes one space key and a search spans every space the viewer
        can read, and because all three layouts that render this bar sit behind `requireViewer`.
      */}
      <Link className="topbar-search" href={"/search" as Route}>
        Search
      </Link>

      {/* Only rendered below 860px, where the rail and its own button are hidden. */}
      <BugReportButton build={build} className="bugbtn-compact" />
    </header>
  );
}
