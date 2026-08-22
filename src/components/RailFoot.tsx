"use client";

import { useState } from "react";
import type { BuildInfo } from "@/lib/version/build";
import { BugReportDialog } from "./BugReportDialog";

export function RailFoot({ build }: { build: BuildInfo }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rail-foot">
      <button type="button" className="bugbtn" onClick={() => setOpen(true)}>
        Report bug
      </button>
      <span className="build">
        {build.label} &middot; <span className="build-channel">{build.channel}</span>
      </span>
      {open ? <BugReportDialog build={build} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
