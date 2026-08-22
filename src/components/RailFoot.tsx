import type { BuildInfo } from "@/lib/version/build";
import { BugReportButton } from "./BugReportButton";

export function RailFoot({ build }: { build: BuildInfo }) {
  return (
    <div className="rail-foot">
      <BugReportButton build={build} className="bugbtn" />
      <span className="build">
        {build.label} &middot; <span className="build-channel">{build.channel}</span>
      </span>
    </div>
  );
}
