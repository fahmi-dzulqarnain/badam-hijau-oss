"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BugStatus } from "@prisma/client";
import { dateTimeFormat } from "@/lib/format";
import { adminBugsHref, pageHref } from "@/lib/pages/href";
import type { AdminBugReport, BugStatusCounts } from "@/lib/bugs/admin";

/**
 * `/admin/bugs` — spec §18.2's triage inbox, Phase 7 Task 8, and the fourth admin surface.
 *
 * ## Nothing here decides anything
 *
 * `AdminSystems`'s, `AdminSpaces`'s and `AdminGit`'s rule. Which reports exist, what their
 * captured ids resolve to, whether a page is soft-deleted or gone, and whether a link would work
 * are all server answers on {@link AdminBugReport}; this component paints them, posts a status and
 * calls `router.refresh()`.
 *
 * ## The one thing it must not do, and it is a security line
 *
 * **`routePath` is never an `href`.** It is the only field on the row the *client* supplied, and
 * `src/lib/bugs/schema.ts` bounds it by a length and nothing else — so `javascript:…` is a
 * storable value and putting it in a link would be script execution in an administrator's
 * browser. It is rendered as text, always. The single link on this surface is built by `pageHref`
 * from the **resolved page's** space key and path, which came out of `Page` and not out of a
 * request body.
 *
 * ## Two ways a captured page can be missing, painted as two different sentences
 *
 * That is the whole of Step 2 reaching a reader. A **soft-deleted** page is recoverable — the row
 * is there, `restorePage` brings the URL and the mirror file back — and an **absent** one is not:
 * the id names nothing and is the last trace the page existed. Collapsing them into "gone" would
 * tell a triager to stop looking for a document that is one button away from being back.
 *
 * ## Overflow: this surface carries the class's worst shape so far
 *
 * Everything here except a status and two timestamps is text somebody typed or a machine pasted:
 * a 5000-character `summary`, a 5000-character `expected`, a 2000-character `routePath`, a
 * 1000-character `userAgent`, and a **5000-character `consoleError`** which is pasted console
 * output — line-oriented, and routinely carrying one line with no break opportunity in it at all.
 * `.rep-console` therefore pairs `pre-wrap` with `overflow-wrap: anywhere` exactly as `.mir-err`
 * does, and **no element carrying stored text is `flex: none`** — Task 3's ninth shape was a box
 * that could not shrink taking its basis from its content.
 */

type Feedback = { message: string } | null;

/** The three states §18.2 gives a report, in the order a triager moves through them. */
const STATUSES: readonly BugStatus[] = ["NEW", "TRIAGED", "CLOSED"];

const STATUS_LABEL: Record<BugStatus, string> = {
  NEW: "New",
  TRIAGED: "Triaged",
  CLOSED: "Closed",
};

export function AdminBugs({
  reports,
  truncated,
  counts,
  status,
}: {
  reports: AdminBugReport[];
  truncated: boolean;
  counts: BugStatusCounts;
  status: BugStatus | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  /**
   * One request, one place the failure shapes are handled — `AdminGit`'s `send`, and like it there
   * is no field-error branch: the body is one enum value, so there is no input for a `422` to sit
   * beside.
   */
  const triage = async (report: AdminBugReport, next: BugStatus) => {
    setPending(report.id);
    setFeedback((all) => ({ ...all, [report.id]: null }));

    let response: Response;
    try {
      response = await fetch(`/api/admin/bugs/${encodeURIComponent(report.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
    } catch {
      setPending(null);
      setFeedback((all) => ({
        ...all,
        [report.id]: { message: "Nothing happened — the browser could not reach the server." },
      }));
      return;
    }

    const body: unknown = await response.json().catch(() => null);
    const parsed = (body ?? {}) as Record<string, unknown>;
    setPending(null);

    if (!response.ok) {
      setFeedback((all) => ({
        ...all,
        [report.id]: {
          // The server's own sentence, verbatim. The fallback is for a status with no body at all.
          message:
            typeof parsed.message === "string"
              ? parsed.message
              : `Nothing happened — the server refused it (${response.status}).`,
        },
      }));
      return;
    }

    const from = String(parsed.previousStatus ?? report.status);
    setFeedback((all) => ({
      ...all,
      [report.id]: {
        message:
          `Moved from ${STATUS_LABEL[from as BugStatus] ?? from} to ${STATUS_LABEL[next]}. ` +
          "Who moved it, and what it was before, is on the audit trail — the status column itself " +
          "keeps only the latest answer.",
      },
    }));
    router.refresh();
  };

  const total = counts.NEW + counts.TRIAGED + counts.CLOSED;

  return (
    <>
      {/*
        The filter, as links rather than as a control: a filtered list is a different URL, so it is
        shareable, back-navigable and server-rendered with no JavaScript. The counts are over the
        WHOLE table and not over the filter, deliberately — a count that moved with the filter would
        leave a triager unable to see that anything else exists.
      */}
      <nav className="rep-filter" aria-label="Filter by status">
        <Link
          className={status === null ? "rep-tab rep-on" : "rep-tab"}
          href={adminBugsHref(null)}
          aria-current={status === null ? "page" : undefined}
        >
          All <span className="adm-refs">{total}</span>
        </Link>
        {STATUSES.map((value) => (
          <Link
            key={value}
            className={status === value ? "rep-tab rep-on" : "rep-tab"}
            href={adminBugsHref(value)}
            aria-current={status === value ? "page" : undefined}
          >
            {STATUS_LABEL[value]} <span className="adm-refs">{counts[value]}</span>
          </Link>
        ))}
      </nav>

      {reports.length === 0 ? (
        <p className="rep-empty">
          {status === null
            ? "Nobody has reported anything yet."
            : `No report is ${STATUS_LABEL[status].toLowerCase()}.`}
        </p>
      ) : (
        <ul className="rep-list">
          {reports.map((report) => (
            <li key={report.id}>
              <article className="rep-row">
                <p className="rep-head">
                  <span className={`rep-status rep-${report.status.toLowerCase()}`}>
                    {STATUS_LABEL[report.status]}
                  </span>
                  <span className="rep-summary">{report.summary}</span>
                </p>

                {report.expected === null ? null : (
                  <p className="rep-expected">
                    <span className="rep-label">Expected</span> {report.expected}
                  </p>
                )}

                <Captured report={report} />

                <p className="rep-who">
                  <span className="rep-name">{report.reporterName}</span>
                  <span className="adm-email">{report.reporterEmail}</span>
                  <span className="rep-when">{dateTimeFormat.format(report.createdAt)}</span>
                </p>

                <p className="rep-env">
                  <span className="rep-build">
                    {report.appVersion}
                    {report.gitSha === null ? "" : `+${report.gitSha}`}
                  </span>
                  <span className="rep-viewport">{report.viewport}</span>
                  <span className="rep-ua">{report.userAgent}</span>
                </p>

                {report.consoleError === null ? null : (
                  <pre className="rep-console">{report.consoleError}</pre>
                )}

                <p className="adm-actions">
                  {STATUSES.map((value) => (
                    <button
                      key={value}
                      className={value === report.status ? "adm-btn adm-primary" : "adm-btn"}
                      type="button"
                      onClick={() => void triage(report, value)}
                      /*
                       * The current status is not pressable — it is the state, not an action. The
                       * endpoint still accepts it and still writes an audit row, which is
                       * `mirror.sweep`'s standing (*"was this ever done"* is the question the row
                       * answers), and `tests/integration/bugs-admin.test.ts` is where that is
                       * driven from, because this control cannot produce it.
                       */
                      disabled={pending !== null || value === report.status}
                    >
                      {value === report.status ? STATUS_LABEL[value] : `Mark ${STATUS_LABEL[value].toLowerCase()}`}
                    </button>
                  ))}
                </p>

                <Message feedback={feedback[report.id]} />
              </article>
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className="adm-more">
          Only the most recent {reports.length} are listed. Filter by status to reach the rest.
        </p>
      ) : null}
    </>
  );
}

/**
 * Where the report came from — the route the reporter was on, and what its captured ids resolve to
 * **now**.
 *
 * The route is always shown, because it is the one durable breadcrumb: the schema gave up foreign
 * keys on the three ids precisely so that a report about a page that is gone still says where the
 * reporter was. It is text and never a link — see the component docstring.
 */
function Captured({ report }: { report: AdminBugReport }) {
  const { space, page } = report;

  return (
    <div className="rep-where">
      <p className="rep-route-line">
        <span className="rep-label">Route</span>
        <span className="rep-route">{report.routePath}</span>
        {report.versionId === null ? null : (
          /* Captured evidence, deliberately unresolved — a `PageVersion` cascades from its page,
             so its presence is the page's answer and a second query would be the untestable
             duplicate. It is here because it is what a triager pastes into a query. */
          <span className="rep-version">version {report.versionId}</span>
        )}
      </p>

      {page.kind === "found" ? (
        <p className="rep-page-line">
          <span className="rep-label">Page</span>
          {page.isLinkable ? (
            <Link className="rep-page" href={pageHref(page.spaceKey, page.path)}>
              {page.title}
            </Link>
          ) : (
            <span className="rep-page">{page.title}</span>
          )}
          <span className="rep-file">
            {page.spaceKey}/{page.path}
          </span>
          {page.deleted ? <span className="adm-deleted">Deleted</span> : null}
          {!page.deleted && !page.isLinkable ? (
            <span className="adm-deleted">Unpublished</span>
          ) : null}
        </p>
      ) : null}

      {page.kind === "absent" ? (
        <p className="rep-page-line rep-gone">
          <span className="rep-label">Page</span>
          <span className="rep-gone-text">
            No page with this id exists any more, so the route above is the only breadcrumb left.
          </span>
          <span className="rep-id">{page.pageId}</span>
        </p>
      ) : null}

      {page.kind === "found" && page.deleted ? (
        <p className="rep-note">
          This page is soft-deleted, not gone: the row is still there, and restoring it brings the
          page, its URL and this link back.
        </p>
      ) : null}

      {page.kind === "found" && !page.deleted && !page.isLinkable ? (
        <p className="rep-note">
          This page has no published version now, so there is no reader URL to link to. It had one
          when the report was filed — a report is only ever captured against a published page.
        </p>
      ) : null}

      {space.kind === "found" ? (
        <p className="rep-space-line">
          <span className="rep-label">Space</span>
          <span className="rep-space">{space.key}</span>
          <span className="rep-space-name">{space.name}</span>
        </p>
      ) : null}

      {space.kind === "absent" ? (
        <p className="rep-space-line rep-gone">
          <span className="rep-label">Space</span>
          <span className="rep-gone-text">No space with this id exists any more.</span>
          <span className="rep-id">{space.spaceId}</span>
        </p>
      ) : null}
    </div>
  );
}

/** What just happened. `role="alert"`, `AdminGit`'s `Message` — the same element for the same kind
 * of sentence, so a reader who has used one admin page has used this one. */
function Message({ feedback }: { feedback?: Feedback }) {
  if (!feedback) return null;
  return (
    <p className="adm-message" role="alert">
      {feedback.message}
    </p>
  );
}
