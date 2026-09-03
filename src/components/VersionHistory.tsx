import Link from "next/link";
import { dateTimeFormat } from "@/lib/format";
import { pageHref } from "@/lib/pages/href";
import type { PageHistory } from "@/lib/pages/history";
import { CONTENT_COMMIT_LABEL, NOT_MIRRORED } from "@/lib/version/labels";
import { Sha } from "./Provenance";

/**
 * The version history list — spec §10's "links to version history".
 *
 * ## A component and not the route's own markup
 *
 * `-/deleted` renders its list inline and this one does not, and the reason is testability
 * rather than reuse. A route is an async Server Component that reads the database, so nothing
 * short of Playwright can render it — and Playwright's browsers are not installed on this
 * machine, which would have left the hostile-content and wording assertions on this surface
 * unwritten. A pure component that takes a `PageHistory` renders under vitest with
 * `renderToStaticMarkup`, so a 300-character title, a null sha and a wedged mirror are all
 * assertable without a browser. `VersionHistory.test.tsx` is the first test in this project to
 * server-render a component; it works because `next/link` degrades to a plain `<a>` outside a
 * Next request.
 *
 * ## Every string on this page that came out of the database is user-controlled
 *
 * The page title, each version's title and each author's name. Titles are typed by an author and
 * names come from the OIDC profile — the same shape as Phase 4's search results, where "it is
 * only my own text" stopped being an argument, since a space's other members read it too. React
 * escapes the text; `doc.css`'s `.ver-*` rules are what keep it inside its box, and the
 * horizontal-overflow guard in `e2e/history.spec.ts` is what proves that — this being the
 * seventh shape of a class that has only ever been caught by being shown a new one.
 */
export function VersionHistory({
  spaceKey,
  history,
}: {
  spaceKey: string;
  history: PageHistory;
}) {
  const { page, rows, total, truncated, mirror } = history;

  /*
   * Explained only when there is something to explain. A note about what an absent sha means,
   * rendered under a list where every row has one, is the kind of standing disclaimer readers
   * learn to skip — and it would also be the only sentence on the page that could not be wrong.
   */
  const anyUnmirrored = rows.some((row) => row.gitSha === null);

  return (
    <main className="doc">
      <h1>Version history</h1>

      <p className="ver-lead">
        Every published version of{" "}
        {/* Inert text when the page has never been published, for the same reason the nav rail
            and the breadcrumbs render an unpublished ancestor as text: the reader route requires
            a published version, so the link would 404 for everyone. */}
        {page.isLinkable ? (
          <Link className="ver-page" href={pageHref(spaceKey, page.path)}>
            {page.title}
          </Link>
        ) : (
          <span className="ver-page">{page.title}</span>
        )}
        , newest first. The {CONTENT_COMMIT_LABEL.toLowerCase()} is where that version&rsquo;s
        Markdown is mirrored in the content repository, which is a different repository from the
        application build in the sidebar.
      </p>

      {/*
        The mirror queue, said once and about the page — see `MirrorQueue` for why it cannot
        honestly be said per version. `failed` outranks `queued` rather than being listed beside
        it: a failed job blocks every later job for this page, so anything queued behind it is
        queued *because* of the failure, and two sentences would invite the reader to wait.
      */}
      {mirror.failed > 0 ? (
        <p className="ver-stuck">
          This page&rsquo;s mirror is stuck. A change to the content repository has failed
          permanently, and nothing published after it will be mirrored until an administrator
          clears it — so a version below with no {CONTENT_COMMIT_LABEL.toLowerCase()} may never
          get one. The page itself is unaffected: everything here is published and readable.
        </p>
      ) : mirror.queued > 0 ? (
        <p className="ver-queued">
          {mirror.queued === 1
            ? "One change to this page is"
            : `${mirror.queued} changes to this page are`}{" "}
          still queued for the content repository, so the newest version may not have a{" "}
          {CONTENT_COMMIT_LABEL.toLowerCase()} yet.
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="ver-empty">
          {page.title} has never been published, so it has no versions yet.
        </p>
      ) : (
        <ol className="ver-list">
          {rows.map((row) => (
            <li key={row.id}>
              <div className="ver-row">
                <div className="ver-what">
                  <span className="ver-when">{dateTimeFormat.format(row.createdAt)}</span>
                  <span className="ver-who">{row.authorName}</span>
                  <span className="ver-status">{row.status}</span>
                  {row.isPublished ? (
                    <span className="ver-current">published now</span>
                  ) : null}
                  {row.renamedTo === null ? null : (
                    <span className="ver-renamed">titled &ldquo;{row.renamedTo}&rdquo;</span>
                  )}
                </div>
                <div className="ver-where">
                  {row.gitSha === null ? (
                    <span className="ver-none">{NOT_MIRRORED}</span>
                  ) : (
                    <Sha value={row.gitSha} />
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {anyUnmirrored ? (
        <p className="ver-note">
          &ldquo;{NOT_MIRRORED}&rdquo; means there is no commit for that version. Every version
          published before this site mirrored to git carries none, and a version published moments
          ago may still be on its way.
        </p>
      ) : null}

      {truncated ? (
        <p className="ver-note">
          Showing the {rows.length} most recent of {total} versions.
        </p>
      ) : null}
    </main>
  );
}
