"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { dateTimeFormat } from "@/lib/format";
import type { RetentionReport } from "@/lib/git/retention";

/**
 * `/admin/git`'s two operator actions — spec §10, Phase 7 Task 7, and the two debts Phase 5
 * deferred here.
 *
 * ## Nothing here decides anything
 *
 * `AdminSystems`'s and `AdminSpaces`'s rule. Which jobs are old enough to sweep, which states are
 * eligible, which versions predate the mirror and how many of them one press may queue are all
 * server answers; this component shows a count, posts, renders what it is told, and calls
 * `router.refresh()`. There is no `days` input and no page picker — see `retention.ts` for why the
 * window is a deployment setting and not a number typed into a browser.
 *
 * ## The count comes first, and the answer is what happened rather than what was predicted
 *
 * Both actions are described by an integer the operator can read before pressing anything: *this
 * many finished jobs are older than the window*, *this many published versions carry no commit*.
 * That is the prediction half Task 1 asked for and Tasks 5 and 6 both applied — a refusal or a
 * consequence is visible before the button, not after it. What comes back is the number the server
 * actually wrote or deleted, which may differ by whatever the worker did meanwhile, and the
 * sentence says the second rather than repeating the first.
 *
 * ## `clears` is false for nothing here, and that is a deliberate difference
 *
 * Tasks 5 and 6 each shipped a defect where a *listing* control cleared the sentence an admin was
 * acting on — "Which pages?" after a refused delete, "Members" after a widened space. Both were
 * found by walking the loop in order rather than by asserting each step. There is no listing
 * control on this surface: both buttons are mutations, and a mutation replacing the previous
 * mutation's sentence is right, because the state it described is gone. The lesson still applies
 * and is why `e2e/admin-git.spec.ts` walks count → press → count instead of asserting each alone.
 */

type Feedback = { message: string } | null;

/** Ids for the per-section pending and feedback state. Two sections, two constants, no strings. */
const SWEEP = "sweep";

export function AdminGit({ retention }: { retention: RetentionReport }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  /**
   * One request, one place the failure shapes are handled — `AdminSpaces`'s `send`, minus the
   * field-error branch these two endpoints cannot produce: neither takes a body, so there is no
   * field for a `422` to be about.
   */
  const send = async (id: string, url: string): Promise<Record<string, unknown> | null> => {
    setPending(id);
    setFeedback((all) => ({ ...all, [id]: null }));

    let response: Response;
    try {
      response = await fetch(url, { method: "POST" });
    } catch {
      setPending(null);
      setFeedback((all) => ({
        ...all,
        [id]: { message: "Nothing happened — the browser could not reach the server." },
      }));
      return null;
    }

    const body: unknown = await response.json().catch(() => null);
    const parsed = (body ?? {}) as Record<string, unknown>;
    setPending(null);

    if (response.ok) return parsed;

    setFeedback((all) => ({
      ...all,
      [id]: {
        // The server's own sentence, verbatim. The fallback is for a status with no body at all.
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : `Nothing happened — the server refused it (${response.status}).`,
      },
    }));
    return null;
  };

  const sweep = async () => {
    const result = await send(SWEEP, "/api/admin/git/retention");
    if (result === null) return;
    const deleted = Number(result.deleted ?? 0);
    const remaining = Number(result.remaining ?? 0);
    const days = Number(result.retentionDays ?? retention.retentionDays);
    setFeedback((all) => ({
      ...all,
      [SWEEP]: {
        message:
          `${count(deleted, "finished job", "finished jobs")} deleted — everything that had been ` +
          `finished for more than ${count(days, "day", "days")}. ` +
          `${count(remaining, "finished job remains", "finished jobs remain")}, all inside the ` +
          "window. Failures and queued changes were not touched.",
      },
    }));
    router.refresh();
  };

  return (
    <section className="git-ops">
      <h2>Finished jobs</h2>

      <p className="git-lead">
        A job stays in the queue after it succeeds, deliberately: without the row,{" "}
        <em>the change was mirrored</em> and <em>nothing was ever queued</em> look identical. The
        cost is that the table only grows, and this is where an operator empties the part of it
        that is old enough to have stopped answering questions.
      </p>

      <p className="git-counts">
        <span className="git-figure">{retention.finished}</span> finished{" "}
        {retention.finished === 1 ? "job" : "jobs"} in the queue,{" "}
        <span className="git-figure">{retention.sweepable}</span> of them finished more than{" "}
        {count(retention.retentionDays, "day", "days")} ago.
        {retention.oldestFinishedAt === null
          ? " Nothing has finished yet."
          : ` The oldest finished ${dateTimeFormat.format(retention.oldestFinishedAt)}.`}
      </p>

      <p className="adm-note">
        {/*
          What retention is NOT for, on the surface and not only in the module — Phase 5 measured
          that 60,000 finished rows cost the worker's claim query four buffers to seek past,
          because `state` leads its index. An operator who believed this made the mirror faster
          would sweep it on the wrong schedule for the wrong reason.
        */}
        This is about size, not speed: the worker&rsquo;s queue query steps past finished rows on
        an index and does not slow down as they accumulate. Nothing that has failed is ever swept —
        a failed job is what holds its page&rsquo;s later changes back, and deleting it would let
        them apply over a change that never happened.
      </p>

      <p className="adm-actions">
        <button
          className="adm-btn adm-primary"
          type="button"
          onClick={sweep}
          disabled={pending !== null || retention.sweepable === 0}
        >
          {retention.sweepable === 0
            ? "Nothing to sweep"
            : `Sweep ${count(retention.sweepable, "finished job", "finished jobs")}`}
        </button>
      </p>

      <Message feedback={feedback[SWEEP]} />
    </section>
  );
}

/** `n thing` or `n things`, with both words given rather than an `s` appended — the pluralisation
 * fix that landed on `page/pages` and left `draft` singular beside it. */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What just happened. `role="alert"`, `AdminSpaces`'s `Message` — the same element for the same
 * kind of sentence, so a reader who has used one admin page has used this one. */
function Message({ feedback }: { feedback?: Feedback }) {
  if (!feedback) return null;
  return (
    <p className="adm-message" role="alert">
      {feedback.message}
    </p>
  );
}
