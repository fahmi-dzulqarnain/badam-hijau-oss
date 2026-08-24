"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * One row's Restore button.
 *
 * A client component per row rather than one form for the list, because the list is the thing
 * being changed: a successful restore removes this row and the rows below it, and a refused
 * one has to say why *next to the row it refused*. `restorePage` refuses a descendant whose
 * ancestor is still deleted, naming that ancestor, and a single shared banner would put that
 * sentence somewhere the admin has to work out which of five rows it belongs to.
 *
 * It POSTs to `/api/pages/[pageId]/restore` and shows the endpoint's own sentence verbatim.
 * Nothing is re-decided here, and nothing is worded here.
 */
export function RestoreButton({ pageId, title }: { pageId: string; title: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch(`/api/pages/${pageId}/restore`, { method: "POST" });
    } catch {
      setPending(false);
      setError("Not restored — the browser could not reach the server.");
      return;
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      setPending(false);
      setError(
        typeof body?.message === "string"
          ? body.message
          : `Not restored — the server refused it (${response.status}).`,
      );
      return;
    }

    // The list this button sits in is now stale, and so is the nav rail beside it — the page
    // is back in both. `refresh()` re-renders the server component that owns them rather than
    // this component trying to splice its own row out of a list it does not own.
    router.refresh();
    setPending(false);
  };

  return (
    <>
      <button
        type="button"
        className="del-restore"
        onClick={() => void restore()}
        disabled={pending}
        aria-label={`Restore ${title}`}
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
      {error ? (
        <p className="del-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
