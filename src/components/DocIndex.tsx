import type { Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { DocStatus, DocType } from "@prisma/client";
import { requireViewer } from "@/lib/auth/viewer";
import { getReadableSpaceByKey } from "@/lib/pages/repo";
import { pageHref } from "@/lib/pages/href";
import { dateFormat } from "@/lib/format";
import {
  DOC_INDEXES,
  filteredStatus,
  indexHref,
  offVocabularyCount,
  parseStatusFilter,
  statusesInPlay,
  type DocIndex as DocIndexMeta,
  type StatusFilter,
} from "@/lib/lifecycle/indexes";
import { listDocTypePages, type DocIndexRow } from "@/lib/lifecycle/index-read";

/**
 * A generated index — spec §11's `/{space}/-/adrs` and `/{space}/-/rfcs`.
 *
 * **One component for both routes, and the two `page.tsx` files are four lines each.** They differ
 * by a `docType` and nothing else, so a second copy of this body would be two surfaces that agree
 * on the day they are written — and this project has twice watched a link rule be honoured by two
 * sites and dropped by the third. Everything that could differ between the two indexes (the URL
 * segment, the heading, the sentences, the status vocabulary) is data in
 * `src/lib/lifecycle/indexes.ts`.
 *
 * ## Permissions, and why an unreadable space 404s
 *
 * `getReadableSpaceByKey` answers "may this viewer read the space", which is what turns an
 * unknown key and an unreadable space into the same 404 (spec §8) — a status code must not tell a
 * stranger that `finance` exists. `listDocTypePages` re-resolves the space under the same
 * predicate rather than trusting this call, so the query is safe called from anywhere; that is the
 * one permission predicate in the module and its docstring argues where it sits.
 *
 * This route is otherwise exactly as permissive as the reader: an index of a space's ADRs is a
 * list of titles the nav rail already shows to the same audience, so there is no second
 * permission to check and deliberately no `EDIT` or `MANAGE_SPACE` gate. Unlike `-/deleted`, whose
 * whole point is a permission asymmetry.
 *
 * ## Unpublished ADRs are listed, as inert text
 *
 * Argued at `IndexRow` below. In short: the nav rail already shows a draft to anyone who can read
 * the space, so hiding it here would make the index disagree with the tree beside it — and
 * *linking* it would 404 for everyone.
 */

/** The `?status=` value, as Next hands search params over. */
type RawStatus = string | string[] | undefined;

export async function DocIndex({
  spaceKey,
  docType,
  status: rawStatus,
}: {
  spaceKey: string;
  docType: DocType;
  status: RawStatus;
}) {
  const meta = DOC_INDEXES[docType];
  // Unreachable: the only two callers are the two routes, each passing a doc type that has an
  // index, and `DOC_INDEXES` is total over `DocType` so a new one cannot arrive unnoticed.
  // Rendered as a 404 rather than asserted away, because "cannot happen" is how a 500 ships.
  if (!meta) notFound();

  const viewer = await requireViewer(indexHref(spaceKey, meta));

  // Cache hit: the space layout resolved the same space with the same viewer in this render.
  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) notFound();

  const filter = parseStatusFilter(docType, rawStatus);
  const result = await listDocTypePages(viewer, {
    spaceId: space.id,
    docType,
    status: filteredStatus(filter),
  });

  // `not-found` cannot be reached here — the read above already answered it — but it is rendered
  // rather than assumed away, for the same reason `-/deleted` does it.
  if (!result.ok) notFound();

  const { rows, counts, total, matched, truncated } = result.listing;
  // Should be zero. Printed below when it is not — see `offVocabularyCount`.
  const stray = offVocabularyCount(docType, counts);

  return (
    <main className="doc">
      <h1>{meta.heading}</h1>
      <p className="idx-lead">{meta.lead}</p>

      {total === 0 ? (
        /*
         * "A space with no ADRs renders an explanation, not an empty list." No filter bar
         * either: a status filter over nothing is a row of zeroes, which reads as a broken page
         * rather than as an empty one.
         */
        <p className="idx-empty">
          Nothing in {space.name} is {aOrAn(meta.noun)} yet. {capitalise(meta.nounPlural)} are
          created like any other page and get their own template, so this list fills itself in as
          they are published.
        </p>
      ) : (
        <>
          <StatusFilterBar
            spaceKey={space.key}
            meta={meta}
            docType={docType}
            filter={filter}
            counts={counts}
            total={total}
          />

          {stray > 0 ? (
            /*
             * A number that should be zero, printed because it is not. The chips are the doc
             * type's vocabulary, so a page at a status the vocabulary does not define has no chip
             * and the chips stop adding up to `All` — which is visible on screen whether or not
             * anything explains it. This is the explanation. The first render of this page against
             * the dev database printed this sentence, and it was right to: `prisma/seed.ts` writes
             * `CURRENT` onto an unpublished ADR.
             */
            <p className="idx-note">
              {stray === 1
                ? `One ${meta.noun} is at a status the ${docType} lifecycle does not define, so it has no filter above.`
                : `${stray} ${meta.nounPlural} are at a status the ${docType} lifecycle does not define, so they have no filter above.`}
            </p>
          ) : null}

          {filter.kind === "unknown" ? (
            /*
             * Named back rather than silently ignored. `filter.named` is text off a query
             * string — React escapes it, `parseStatusFilter` caps its length, and `.idx-note`
             * carries the overflow guard, which are three different problems and three
             * different mechanisms.
             */
            <p className="idx-note">
              {filter.named === null
                ? `The status filter was not a single value, so every ${meta.noun} is listed.`
                : `“${filter.named}” is not a status ${aOrAn(meta.noun)} can be in, so every ${meta.noun} is listed.`}
            </p>
          ) : null}

          {rows.length === 0 ? (
            /*
             * The second empty branch, and it exists because the first sentence would be a lie
             * here: this space *does* hold ADRs, just none at the status asked for. Telling the
             * two apart is what the aggregate in `listDocTypePages` is for.
             */
            <p className="idx-empty">
              No {meta.noun} in {space.name} is at {statusLabel(filter)}.{" "}
              <Link href={indexHref(space.key, meta) as Route}>
                Show all {total} {total === 1 ? meta.noun : meta.nounPlural}
              </Link>
              .
            </p>
          ) : (
            <>
              <ul className="idx-list">
                {rows.map((row) => (
                  <IndexRow key={row.id} spaceKey={space.key} row={row} />
                ))}
              </ul>
              {truncated ? (
                <p className="idx-note">
                  Showing the first {rows.length} of {matched}. This index is not paginated yet.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </main>
  );
}

/**
 * The status filter — spec §11, and **derived from the vocabulary rather than from a list typed
 * out here**.
 *
 * `statusesInPlay(docType)` reads `PUBLISHABLE_INTO` through `publishableStatuses`, so a Phase 3
 * vocabulary change moves this bar with it. A hardcoded list is the failure the step names: it
 * agrees with the table on the day it is written and then silently stops offering a status the
 * lifecycle grew. The counts come from the aggregate, so a status no page has reached shows `0`
 * rather than being quietly dropped — which keeps the bar a picture of the *vocabulary* rather
 * than of the current rows.
 *
 * Every entry is a link, including the zero ones: clicking it lands on the "none at this status"
 * branch, which is a truthful page and names the way back. `aria-current="page"` marks the active
 * filter, because colour is the only other thing distinguishing it.
 */
function StatusFilterBar({
  spaceKey,
  meta,
  docType,
  filter,
  counts,
  total,
}: {
  spaceKey: string;
  meta: DocIndexMeta;
  docType: DocType;
  filter: StatusFilter;
  counts: ReadonlyMap<DocStatus, number>;
  total: number;
}) {
  const active = filteredStatus(filter);
  return (
    <nav className="idx-filter" aria-label={`Filter ${meta.nounPlural} by status`}>
      <Link
        className="idx-chip"
        href={indexHref(spaceKey, meta) as Route}
        aria-current={active === null ? "page" : undefined}
      >
        All <span className="idx-n">{total}</span>
      </Link>
      {statusesInPlay(docType).map((status) => (
        <Link
          key={status}
          className="idx-chip"
          href={indexHref(spaceKey, meta, status) as Route}
          aria-current={active === status ? "page" : undefined}
        >
          {status} <span className="idx-n">{counts.get(status) ?? 0}</span>
        </Link>
      ))}
    </nav>
  );
}

/**
 * One page in the index.
 *
 * ## `title` and `path` are user-typed text painted outside `.body`
 *
 * The horizontal-overflow class has bitten **six** times now — paragraphs, images, the mermaid
 * placeholder, `.body` headings, the page title itself, and Task 9's banner — and every one was
 * an unbreakable token in a string a person typed. Both strings on this row are that shape. The
 * guard is in `doc.css` on `.idx-row`, `.idx-title` and `.idx-path`; this component's job is to
 * keep each string inside an element that carries the guard rather than interpolating it into a
 * neighbouring text node.
 *
 * ## An unpublished page is listed, and it is not a link
 *
 * The decision, and both halves of it have an argument:
 *
 * - **Listed.** An ADR that has never been published sits at `DRAFT` and is invisible to
 *   `getPublishedPage` — but it is *not* invisible to the space: `listSpacePages` has no
 *   published filter, so the nav rail already shows it, by title, with a `Draft` tag, to
 *   everybody who can read the space. An index that omitted it would disagree with the tree
 *   rendered beside it on the same screen, which is the exact defect Phase 1 fixed in the
 *   breadcrumbs — they derived labels from the path string and disagreed with the rail. And it
 *   would make "is there an ADR about this yet" answerable wrongly: a decision being drafted is
 *   the single most useful thing this list can tell a reader who is about to write one. There is
 *   no permission argument for hiding it either, because the audience is identical.
 * - **Not linked.** `getPublishedPage` requires a published version, so the link would 404 for
 *   everyone. Inert text, exactly as the nav rail, the breadcrumbs and the relation list render
 *   an unpublished page — the fourth site to need that rule, and it comes from `isLinkable` for
 *   the reason the previous three each grew their own copy.
 *
 * The `DRAFT` status is in `statusesInPlay`, so the filter can single these out, and the count
 * beside it is honest about how many there are.
 */
function IndexRow({ spaceKey, row }: { spaceKey: string; row: DocIndexRow }) {
  return (
    <li className="idx-row">
      <span className="idx-status">{row.status}</span>
      {row.isLinkable ? (
        <Link className="idx-title" href={pageHref(spaceKey, row.path)}>
          {row.title}
        </Link>
      ) : (
        <span className="idx-title idx-inert">
          {row.title}
          <span className="tag-draft">Draft</span>
        </span>
      )}
      <code className="idx-path">{row.path}</code>
      <span className="idx-when">
        {row.publishedAt ? `published ${dateFormat.format(row.publishedAt)}` : "not published"}
      </span>
    </li>
  );
}

/** The status the empty branch is explaining. `unknown` never reaches it — it renders the list. */
function statusLabel(filter: StatusFilter): string {
  return filter.kind === "status" ? filter.status : "that status";
}

/** "a decision record" / "an RFC". The nouns are data, so the article has to be derived. */
function aOrAn(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
