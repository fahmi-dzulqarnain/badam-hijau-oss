import Link from "next/link";
import { dateTimeFormat } from "@/lib/format";
import { pageHistoryHref } from "@/lib/pages/href";
import type { MirrorFailure, MirrorReport } from "@/lib/git/failures";

/**
 * The failed-jobs list — spec §10's *"persistent failures surface on an admin page"*.
 *
 * **A `<section>` and not the page.** Phase 5 shipped it as the whole of `/-/mirror`, with its own
 * `<h1>`; Phase 7 Task 7 moved it under `/admin/git`, which is *the git mirror* rather than *its
 * failures* and carries two operator actions beside this list. So the page owns the `h1` and this
 * owns an `h2` — one `h1` per page is what `e2e/admin-systems.spec.ts` and its siblings assert on,
 * and a component that kept its own would have made this page the only admin surface with two.
 *
 * ## A component and not the route's own markup, for Phase 5 Task 7's reason
 *
 * A route is an async Server Component that reads the database, so nothing short of a browser can
 * render one. A pure component taking a {@link MirrorReport} renders under vitest with
 * `renderToStaticMarkup` — which is how the thing this task is mostly about, the **words**, gets
 * executable evidence rather than a Playwright assertion that only runs when the browsers are
 * installed. `e2e/admin-git.spec.ts` carries the overflow *measurement*, which needs a layout
 * engine.
 *
 * ## Everything painted here came from somewhere a person types
 *
 * A page title (300 characters of anything), a `Page.path` and a `Space.key` — the last of which
 * has **no validation anywhere** (`src/lib/git/paths.ts` measured it) — plus `GitJob.lastError`,
 * which is git's stderr and therefore arbitrary bytes from a subprocess. React escapes all of it;
 * `doc.css`'s `.mir-*` rules keep it inside its box. That is the eighth shape of the overflow
 * class, and the error is a new one even for this project: an unbroken JSON argv line, hundreds of
 * characters with no space in it.
 *
 * The credential redaction is **not** here, and that is deliberate. It belongs where the value is
 * read (`listMirrorFailures`) rather than where it is painted, so that a second surface added
 * later — a JSON endpoint, a CLI, an export — cannot get the raw column by not knowing about this
 * component. A component that redacted would be a sanitiser one call site deep.
 *
 * ## Why the "does not cover" section is always rendered
 *
 * Every other explanatory note in this codebase is conditional — `VersionHistory` renders its
 * unmirrored note only when a row has no sha, on the argument that a standing disclaimer is one
 * readers learn to skip. This one is unconditional, and the exception has a reason: those notes
 * explain something *on the screen*, and this one explains what is **not** on it. It is needed
 * most in exactly the state where a conditional version would be hidden — an empty list, which
 * without it reads as "the mirror is fine" and is nothing of the kind.
 */
export function MirrorFailures({ report }: { report: MirrorReport }) {
  const { failures, truncated, retrying } = report;

  return (
    <section className="mir-failures">
      <h2>Mirror failures</h2>

      <p className="mir-lead">
        Changes the content repository refused, which the worker has stopped retrying. A failure
        holds up every later change to the <em>same page</em> and no other, so a page listed here
        has stopped mirroring altogether until somebody clears it. The site itself is unaffected:
        every one of these pages is published and readable, and the mirror is a copy.
      </p>

      {failures.length === 0 ? (
        /*
         * "Nothing has given up" and not "the mirror is healthy". The list is one state of several
         * and the section below says which — an empty-state sentence that made a completeness
         * claim would be the exact failure Step 2 of this task is about, in the one place a reader
         * is most inclined to believe it.
         */
        <p className="mir-empty">No mirror job has given up.</p>
      ) : (
        <>
          <p className="mir-count">
            {failures.length === 1
              ? "One page has stopped mirroring."
              : `${failures.length} pages have stopped mirroring.`}{" "}
            {/* At most one job per page can reach FAILED — Task 6's barrier means no later job for
                a page is claimable once one fails — so a count of failures is a count of pages,
                and saying "pages" is true rather than convenient. */}
            Each is stuck at its oldest unfinished change.
          </p>
          <ul className="mir-list">
            {failures.map((failure) => (
              <li key={failure.id}>
                <Failure failure={failure} />
              </li>
            ))}
          </ul>
          {truncated ? (
            <p className="mir-note">
              Showing the {failures.length} most recently attempted. There are more.
            </p>
          ) : null}
        </>
      )}

      <section className="mir-gap">
        <h3>What this list does not cover</h3>
        <ul>
          <li>
            <strong>Pages published before the mirror existed.</strong> They carry no commit and
            were never queued, so they are not failures and cannot appear here. This is the
            mirror&rsquo;s queue, not a reconciliation — nothing compares the repository against
            the database, so &ldquo;no failures&rdquo; is not &ldquo;every page is mirrored&rdquo;.
          </li>
          <li>
            <strong>Changes that will be tried again.</strong> A change the repository refuses
            keeps its place and retries with backoff, and reaches this list only once it has used
            every attempt — a git host being down is not an incident.{" "}
            {retrying === 0
              ? "Nothing is waiting to be retried right now."
              : retrying === 1
                ? "One change is waiting to be retried right now."
                : `${retrying} changes are waiting to be retried right now.`}
          </li>
          <li>
            <strong>Changes queued behind a failure.</strong> They are counted on the failure
            blocking them rather than listed on their own, because a page&rsquo;s queue is stuck at
            one job and listing the rest would be listing one problem many times.
          </li>
          <li>
            <strong>A run that never started.</strong> If the working tree is not a repository, or
            the database cannot be reached, the worker claims no job and therefore fails none — it
            exits non-zero and says why, and this list stays exactly as it was. An empty list means
            nothing has given up; it does not mean the mirror has run.
          </li>
        </ul>
      </section>
    </section>
  );
}

/** One failure. Split out so the row's own conditionals stay readable, not for reuse. */
function Failure({ failure }: { failure: MirrorFailure }) {
  return (
    <div className="mir-row">
      <div className="mir-what">
        {/* The four kinds are the four mutations, and they are what an operator acts on
            differently: a stuck DELETE leaves a file that should be gone, a stuck PUBLISH leaves
            one that is stale. */}
        <span className="mir-kind">{failure.kind}</span>
        {/* Version history and not the page: it is where this page's queue state and its versions'
            shas already are, and it answers for an unpublished page where the reader route 404s.
            A soft-deleted page has no history either, so that one is plain text. */}
        {failure.pageDeleted ? (
          <span className="mir-title">{failure.pageTitle}</span>
        ) : (
          <Link
            className="mir-title"
            href={pageHistoryHref(failure.pageSpaceKey, failure.pagePath)}
          >
            {failure.pageTitle}
          </Link>
        )}
        {failure.pageDeleted ? (
          <span className="mir-flag">page deleted</span>
        ) : null}
      </div>

      <div className="mir-where">
        {/* The address as the job captured it, which is where the file was going — not where the
            page is now. The two differ for a page moved since, and the job is about the former. */}
        <code className="mir-file">
          {failure.spaceKey}/{failure.path}.md
        </code>
        {failure.fromPath === null ? null : (
          <code className="mir-file mir-from">
            from {failure.spaceKey}/{failure.fromPath}.md
          </code>
        )}
      </div>

      <div className="mir-when">
        <span>
          Gave up after {failure.attempts}{" "}
          {failure.attempts === 1 ? "attempt" : "attempts"}
        </span>
        {/* `updatedAt` is defined by the schema as "when it was last attempted", and it is here
            because an attempt count with no timestamp cannot tell a job failing now from one that
            gave up last week. `createdAt` is beside it for the other half of that question. */}
        <span>last tried {dateTimeFormat.format(failure.lastAttemptAt)}</span>
        <span>queued {dateTimeFormat.format(failure.queuedAt)}</span>
      </div>

      {failure.blocked > 0 ? (
        <p className="mir-blocked">
          {/*
            "changes to this page", not "later changes": the count is every unfinished job for
            this page, which in any state the worker can produce *is* every later one — the
            barrier means a job cannot be claimed while an earlier one is unfinished, so nothing
            older than this failure can still be waiting. Saying "later" would make the sentence a
            claim about ordering that the query does not make, and a hand-edited row would turn it
            into a false one. Found by an e2e fixture that produced exactly such a row.
          */}
          {failure.blocked === 1
            ? "One change to this page is"
            : `${failure.blocked} changes to this page are`}{" "}
          queued behind this and will not be applied until it is cleared.
        </p>
      ) : null}

      {failure.lastError === null ? (
        /* A `FAILED` job with no error text is not impossible — a row edited by hand, or a future
           failure path that forgets to write one — and a row that simply showed nothing there
           would read as an empty error rather than as a missing one. */
        <p className="mir-err mir-err-none">git said nothing that was recorded.</p>
      ) : (
        <p className="mir-err">{failure.lastError}</p>
      )}
    </div>
  );
}
