"use client";

import type { BuildInfo } from "@/lib/version/build";

export function BugReportDialog({ onClose }: { build: BuildInfo; onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Report a bug">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
