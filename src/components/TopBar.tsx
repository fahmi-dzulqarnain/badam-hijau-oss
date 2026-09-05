import Link from "next/link";
import type { Route } from "next";
import type { BuildInfo } from "@/lib/version/build";
import { SYSTEMS_PATH } from "@/lib/pages/href";
import { BugReportButton } from "./BugReportButton";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
      {/*
        The affordances that reach the two cross-space routes. Phase 4 built `/search` and nothing
        linked to it — the same defect as Phase 2's `movePage`, which shipped as a library
        function with no way to call it and cost a whole extra task to close — so Phase 7 Task 3
        adds `/systems` here in the task that builds it rather than discovering the same gap for
        the third time.

        They live here rather than in the nav rail because `NavRail` takes one space key while
        both of these span every space the viewer can read, and because all four layouts that
        render this bar sit behind `requireViewer`.
      */}
      <nav className="topbar-nav" aria-label="Across spaces">
        <Link className="topbar-search" href={SYSTEMS_PATH}>
          Systems
        </Link>
        <Link className="topbar-search" href={"/search" as Route}>
          Search
        </Link>
      </nav>

      {/* Only rendered below 860px, where the rail and its own button are hidden. */}
      <BugReportButton build={build} className="bugbtn-compact" />
    </header>
  );
}
