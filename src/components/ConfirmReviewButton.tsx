"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The review-confirmation control — spec §12.
 *
 * ## Where it lives, and why not in `PageInfoCard`
 *
 * In the reader's `.meta` row, beside `Edit this page`, and **not** in the right rail. `doc.css`
 * hides `.rail-r` entirely below 1180px, so a control in `PageInfoCard` would simply not exist
 * for anyone on a laptop in a split window — the same shape as Phase 1's bug dialog, which was
 * rendered inside `.rail-l` and vanished with it below 860px, taking the user's typed text along.
 * `.meta` is hidden at no width. `PageInfoCard` keeps the **Last reviewed** date, which is a fact
 * and not an action, and the two are deliberately not two copies of one affordance: the rail says
 * when, this says confirm.
 *
 * ## And why on the page rather than on the landing list
 *
 * The space landing lists the pages that are due and links each one here; it does not carry a
 * button of its own. Confirming a review is a claim that the document is still correct, which is
 * a claim you can only make after reading it — a button on a list turns the whole cycle into
 * something that can be cleared without opening anything. It also keeps the affordance in one
 * place, which is a rule this project has had to learn twice.
 *
 * It POSTs to `/api/pages/[pageId]/review` and shows the endpoint's own sentence verbatim.
 * Nothing is re-decided here and nothing is worded here — in particular, whether this viewer may
 * confirm is `mayConfirmReview`'s answer, made on the server, and the control is simply not
 * rendered otherwise. The endpoint re-decides it anyway.
 */
export function ConfirmReviewButton({ pageId, title }: { pageId: string; title: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch(`/api/pages/${pageId}/review`, { method: "POST" });
    } catch {
      setPending(false);
      setError("Not confirmed — the browser could not reach the server.");
      return;
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      setPending(false);
      setError(
        typeof body?.message === "string"
          ? body.message
          : `Not confirmed — the server refused it (${response.status}).`,
      );
      return;
    }

    // The "Last reviewed" line in the rail beside this button is now stale, and so is the due
    // list on the space landing. `refresh()` re-renders the server components that own them
    // rather than this component trying to restate a date it does not own.
    router.refresh();
    setPending(false);
  };

  return (
    <>
      <button
        type="button"
        className="doc-review"
        onClick={() => void confirm()}
        disabled={pending}
        aria-label={`Confirm review of ${title}`}
      >
        {pending ? "Confirming…" : "Confirm review"}
      </button>
      {error ? (
        <p className="doc-review-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
