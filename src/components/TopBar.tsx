import type { BuildInfo } from "@/lib/version/build";
import { BugReportButton } from "./BugReportButton";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
      {/* Only rendered below 860px, where the rail and its own button are hidden. */}
      <BugReportButton build={build} className="bugbtn-compact" />
    </header>
  );
}
