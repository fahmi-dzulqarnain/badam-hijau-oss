import type { Route } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth/viewer";
import { pageHref } from "@/lib/pages/href";
import { dateFormat } from "@/lib/format";
import { search, type SearchHit, type SearchQuery, type SnippetSegment } from "@/lib/search/query";
import {
  CLEARED,
  DOC_TYPES,
  MAX_ECHOED_FILTER,
  MAX_ECHOED_QUERY,
  PARAM,
  SEARCHABLE_STATUSES,
  SEARCH_PATH,
  echo,
  hasFilters,
  outcomeOf,
  parseSearchParams,
  searchHref,
  searchQueryOf,
  unknownFilters,
  type RawSearchParams,
} from "@/lib/search/params";

/**
 * `/search` — spec §11's route and §13's search, across every space the viewer can read.
 *
 * ## The URL is the state
 *
 * The query and all three filters are read off `searchParams` and nothing else, so **a search is
 * a link a person can send**: the address bar always describes what is on screen, the back button
 * walks back through real searches, and a filtered result set pasted into a chat reproduces
 * itself for anyone with the same access. A filter bar holding its own client state would look
 * identical and take all three away. `src/lib/search/params.ts` owns the parsing and the link
 * building, so both have unit tests; every link out of this file goes through `searchHref`.
 *
 * The form is a plain `method="get"`, which is why it needs no client component and no JavaScript
 * — the browser builds the URL, and the URL is the whole interface. Its consequence is visible and
 * accepted: submitting with nothing chosen writes `?q=x&type=&status=`, and the parser reads an
 * empty value as "no filter" precisely so that the normal URL is not full of sentences about
 * filters nobody asked for.
 *
 * ## One database call, and it is the seam
 *
 * `search()` is the only read on this route (§13: *"search lives behind `lib/search` with a
 * narrow interface"*), and the route makes no query of its own. That is what shapes two decisions
 * a reader might otherwise read as omissions:
 *
 * - **The space filter has no menu.** Offering one means enumerating the viewer's readable
 *   spaces, which is a second query. Instead every result names its space as a link that narrows
 *   to it, and the narrowed page offers the way back — so the filter is reachable from the only
 *   place it is ever useful, without a query and without a list that goes stale.
 * - **Nothing counts the pages a filter excluded.** The generated index can afford an aggregate
 *   beside its list; a cross-space search cannot without a second scan of the same index.
 *
 * ## The `system` filter is absent, not disabled
 *
 * §13 lists it and Phase 7 owns the systems catalogue, so there is nothing to filter on. There is
 * no control and no greyed-out select: a disabled control advertises a feature that does not
 * exist, and a reader cannot tell "not built" from "broken" by looking at one.
 *
 * ## Snippets are text nodes, and there is no markup to render
 *
 * `search()` returns `{ text, match }[]` — the `ts_headline` delimiters are parsed away inside
 * `lib/search`, deliberately, so this route never holds a string that could be markup. The
 * matched runs are wrapped in a `<mark>` element; there is no `dangerouslySetInnerHTML` on this
 * route and there is nothing for one to render.
 *
 * ## Overflow — the class that has bitten six times
 *
 * Every result carries a title, a path and a snippet: three user-typed strings painted **outside**
 * `.body`, which is exactly the shape that widened the reader by 4,321px before `.doc > h1` was
 * fixed. The guards are the `.q-*` rules at the bottom of `doc.css`; this file's job is to keep
 * each string inside an element that carries one, rather than interpolating it into a neighbouring
 * text node.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const parsed = parseSearchParams(await searchParams);
  const query = searchQueryOf(parsed);

  // Signing in returns to this exact search, filters included — the same URL that makes it
  // shareable is the one worth coming back to.
  const viewer = await requireViewer(searchHref(query));

  const result = await search(viewer, query);
  // Three outcomes, not two, and the decision is taken once, in a pure function with its own
  // tests. Everything below reads it; nothing below re-derives it.
  const outcome = outcomeOf(result);
  // A projection of the answer, not a second copy of the decision above: the branch is chosen by
  // `outcome`, and these are the rows that branch renders.
  const hits = result.ok ? result.hits : [];
  const truncated = result.ok && result.truncated;

  const quoted = echo(parsed.q, MAX_ECHOED_QUERY);
  const unknown = unknownFilters(parsed);

  return (
    <main className="doc">
      <h1>Search</h1>
      <p className="q-lead">
        Every page in the spaces you can read, by title, heading and body text. A document that
        has been superseded or archived stays in these results with its status showing, and ranks
        below a live one.
      </p>

      <form className="q-form" method="get" action={SEARCH_PATH}>
        {/*
          `type="search"`, and the label is the `aria-label`: the heading above already says
          "Search", and a second visible copy of that word beside the box is noise. The
          placeholder is a hint and not the label, because a placeholder disappears exactly when
          a person needs it.
        */}
        <input
          className="q-input"
          type="search"
          name={PARAM.q}
          defaultValue={parsed.q}
          aria-label="Words to search for"
          placeholder="topic registry, “exact phrase”, -excluded"
        />
        <label className="q-pick">
          <span className="q-k">Type</span>
          {/*
            `defaultValue` is the *applied* filter, so a value the vocabulary does not know shows
            as "Any" — which is what the results are, and what the sentence below says. A control
            that displayed the rejected value would contradict both.
          */}
          <select name={PARAM.docType} defaultValue={query.docType ?? ""}>
            <option value="">Any</option>
            {DOC_TYPES.map((docType) => (
              <option key={docType} value={docType}>
                {docType}
              </option>
            ))}
          </select>
        </label>
        <label className="q-pick">
          <span className="q-k">Status</span>
          <select name={PARAM.status} defaultValue={query.status ?? ""}>
            <option value="">Any</option>
            {SEARCHABLE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        {/*
          The space filter has no menu — see the module docstring — so it rides through the form
          as a hidden field. Without this, pressing Search inside a space-narrowed result set
          would silently widen it back to every space, which is the same class of defect as a
          filter that vanishes from the URL.
        */}
        {query.spaceKey === undefined ? null : (
          <input type="hidden" name={PARAM.space} value={query.spaceKey} />
        )}
        <button className="q-go" type="submit">
          Search
        </button>
      </form>

      {query.spaceKey === undefined ? null : (
        <p className="q-note">
          {/* Capped for display, for the reason `MAX_ECHOED_FILTER` exists: this is text off a
              query string, painted above the results. The hidden field above carries the whole
              value, because that is what the search is actually filtering on. */}
          Narrowed to the space <code className="q-key">
            {echo(query.spaceKey, MAX_ECHOED_FILTER)}
          </code>.{" "}
          <Link href={searchHref(query, { spaceKey: null }) as Route}>Search every space</Link>
        </p>
      )}

      {/*
        A filter that was asked for and not applied is named back, rather than silently ignored:
        a filter that quietly shows everything is indistinguishable from a broken one. `named` is
        capped in the parser and escaped by React, and `.q-note` carries the overflow guard —
        three different problems and three different mechanisms.
      */}
      {unknown.map((filter) => (
        <p className="q-note" key={filter.label}>
          {filter.named === null
            ? `The ${filter.label} filter was not a single value, so it was not applied.`
            : `“${filter.named}” is not a ${filter.label} a page can have, so the ${filter.label} filter was not applied.`}
        </p>
      ))}

      {/*
        **Three outcomes, three sentences.** Nothing typed, nothing searchable in what was typed,
        and a real search that found nothing are three different things to be told, and any two of
        them collapsed into one tells a person their query was fine when it was not — or that
        nothing matched when nothing was ever looked for.
      */}
      {outcome === "empty-query" ? (
        <p className="q-empty">
          Nothing typed yet. A word or two is enough; a phrase in double quotes matches the
          phrase, and a word with a minus in front of it is excluded.
        </p>
      ) : outcome === "no-terms" ? (
        <p className="q-empty">
          There is nothing to search for in “{quoted}”. Punctuation on its own, and an exclusion
          with nothing to exclude it from, leave no word to look up — this is not a search that
          found nothing, it is a search that was never made. Add a word.
        </p>
      ) : outcome === "no-hits" ? (
        <p className="q-empty">
          No page matches “{quoted}”.
          {hasFilters(query) ? (
            <>
              {" "}
              The filters above are narrowing it —{" "}
              <Link href={searchHref(query, CLEARED) as Route}>search without them</Link>.
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p className="q-count">
            {truncated
              ? `The best ${hits.length} matches for “${quoted}”, in rank order.`
              : hits.length === 1
                ? `One page matches “${quoted}”.`
                : `${hits.length} pages match “${quoted}”.`}
          </p>
          <ul className="q-list">
            {hits.map((hit) => (
              <Hit key={hit.pageId} hit={hit} query={query} />
            ))}
          </ul>
          {truncated ? (
            <p className="q-note">
              More pages match than this page shows. Search is not paginated yet — add a word, or
              narrow it with the filters above.
            </p>
          ) : null}
        </>
      )}
    </main>
  );
}

/**
 * One result.
 *
 * Every hit is published — `search()` filters on `publishedVersionId IS NOT NULL` — so the title
 * is always a link, unlike the nav rail's and the index's inert drafts. There is no such thing as
 * an unlinkable row here, and a branch for one would be untestable.
 *
 * **The status is shown on every row, retired or not**, which is §6.4: a person searching for a
 * decision needs to see that it was superseded, not to have it hidden. The demotion in the
 * ranking is the other half of that promise and lives in `RETIRED_RANK_FACTOR`; `isRetired`
 * arrives on the hit already derived, so this component does not re-test the status against a
 * list of names.
 *
 * The space name is a link that narrows the search to that space, which is the space filter's
 * only control — see the route docstring for why there is no menu. It goes through `searchHref`,
 * carrying the words and the other filters, so following it is still the search you were doing.
 */
function Hit({ hit, query }: { hit: SearchHit; query: SearchQuery }) {
  return (
    <li className="q-row">
      <p className="q-head">
        <span className={hit.isRetired ? "q-status q-retired" : "q-status"}>{hit.status}</span>
        <Link className="q-title" href={pageHref(hit.spaceKey, hit.path)}>
          {hit.title}
        </Link>
      </p>
      <Snippet segments={hit.snippet} />
      <p className="q-meta">
        <Link className="q-space" href={searchHref(query, { spaceKey: hit.spaceKey }) as Route}>
          {hit.spaceName}
        </Link>
        <span className="q-type">{hit.docType}</span>
        {/*
          `publishedAt` is a separate nullable column from `publishedVersionId` with nothing tying
          the two together, so a published page can genuinely have no timestamp. Nothing is
          rendered in that case: "not published" would be a lie about a row this query only
          returns *because* it is published.
        */}
        {hit.publishedAt === null ? null : (
          <span className="q-when">{dateFormat.format(hit.publishedAt)}</span>
        )}
        {/* Last, because `.q-path` takes a line of its own — a path is the string most likely to
            be one unbreakable token. */}
        <code className="q-path">{hit.path}</code>
      </p>
    </li>
  );
}

/**
 * The passage, as text nodes.
 *
 * `search()` hands over `{ text, match }[]`; the matched runs get a `<mark>` and the rest get a
 * plain node. There is no delimiter left in the strings to parse and no markup to render, which
 * is the point of the seam returning runs rather than a marked-up string — the temptation to
 * reach for `dangerouslySetInnerHTML` to bold a match never arises, because there is nothing to
 * pass to it.
 *
 * Index keys, which is correct here rather than lazy: the array is rebuilt from the query on every
 * render, is never reordered, and has no identity beyond its position.
 *
 * **An empty array is an answer, not a failure.** `searchText` is legitimately `""` for a page
 * whose whole content is one Mermaid diagram, and `ts_headline` over `''` returns `''`. Such a
 * page is findable by its title, and the row still carries its title, path and space; saying so
 * beats a blank gap that reads as a broken snippet.
 */
function Snippet({ segments }: { segments: SnippetSegment[] }) {
  if (segments.length === 0) {
    return <p className="q-snippet q-nosnippet">This page has no body text to quote.</p>;
  }
  return (
    <p className="q-snippet">
      {segments.map((segment, at) =>
        segment.match ? (
          <mark key={at}>{segment.text}</mark>
        ) : (
          <span key={at}>{segment.text}</span>
        ),
      )}
    </p>
  );
}
