"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
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
      {/* Portalled to the body deliberately. Rendered as a sibling of the trigger, the
          rail instance's overlay sits inside .rail-l — which is display:none below 860px,
          taking the open dialog and the user's typed text with it, since position:fixed
          does not escape a display:none ancestor. */}
      {open
        ? createPortal(
            <BugReportDialog build={build} onClose={() => setOpen(false)} />,
            document.body,
          )
        : null}
    </>
  );
}
