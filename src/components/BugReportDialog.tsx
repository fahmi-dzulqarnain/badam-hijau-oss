"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { BuildInfo } from "@/lib/version/build";

type State = "editing" | "sending" | "sent" | "failed";

export function BugReportDialog({
  build,
  onClose,
}: {
  build: BuildInfo;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const [summary, setSummary] = useState("");
  const [expected, setExpected] = useState("");
  const [state, setState] = useState<State>("editing");

  // Escape closes. Deliberately not a focus trap — more than an alpha needs — but a dialog
  // that cannot be dismissed from the keyboard is worse than one that is merely imperfect.
  // Gated on state so Escape cannot unmount mid-submit: the row would still be created, the
  // user would never see "Thanks", and the natural next move is to file it twice.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state !== "sending") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, state]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");

    // Only what the client alone knows. Which space, page and version this route refers to
    // is resolved on the server, so a reporter cannot attach context from a space they
    // cannot read.
    const response = await fetch("/api/bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary,
        expected: expected || null,
        routePath: pathname,
        appVersion: build.version,
        gitSha: build.gitSha,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      }),
    }).catch(() => null);

    setState(response?.ok ? "sent" : "failed");
  }

  return (
    <div className="bugdim">
      <div className="bugcard" role="dialog" aria-label="Report a bug">
        {state === "sent" ? (
          <>
            <h2>Thanks</h2>
            <p className="bughint">Logged against {build.label}.</p>
            <div className="bugactions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>Report a bug</h2>
            <p className="bughint">
              The page you are on, your browser, the window size and the build are attached
              automatically.
            </p>

            <label htmlFor="bug-summary">What happened?</label>
            <textarea
              id="bug-summary"
              required
              autoFocus
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />

            <label htmlFor="bug-expected">What did you expect?</label>
            <textarea
              id="bug-expected"
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            />

            {state === "failed" ? (
              <p className="bugerror" role="alert">
                That did not send. Try again in a moment.
              </p>
            ) : null}

            <div className="bugactions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={state === "sending" || summary.trim() === ""}
              >
                {state === "sending" ? "Sending" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
