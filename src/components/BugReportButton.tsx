"use client";

import { useState } from "react";
import type { BuildInfo } from "@/lib/version/build";
import { BugReportDialog } from "./BugReportDialog";

export function BugReportButton({
  build,
  className,
}: {
  build: BuildInfo;
  className: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Report bug
      </button>
      {open ? <BugReportDialog build={build} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
