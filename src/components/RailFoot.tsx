import type { BuildInfo } from "@/lib/version/build";
import { BUILD_LABEL } from "@/lib/version/labels";
import { BugReportButton } from "./BugReportButton";

/**
 * The nav rail's foot: report a bug, and which build served this page.
 *
 * **The build string is labelled, and that is Task 7's other half.** It used to paint
 * `0.1.0+df0ef11 · alpha` bare, on a reader page that also shows a content-repository commit —
 * two shas of two different repositories, one of them named and the other left for the reader to
 * guess at. `src/lib/version/labels.ts` owns both words so the pair can be asserted in one place;
 * see its docstring for why that is a module and not two literals.
 */
export function RailFoot({ build }: { build: BuildInfo }) {
  return (
    <div className="rail-foot">
      <BugReportButton build={build} className="bugbtn" />
      <span className="build">
        {BUILD_LABEL} {build.label} &middot;{" "}
        <span className="build-channel">{build.channel}</span>
      </span>
    </div>
  );
}
