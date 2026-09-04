import type { DocStatus, DocType } from "@prisma/client";
import { FIRST_PUBLISH, publishableStatuses } from "@/lib/pages/transition";
import type { SearchQuery, SearchResult } from "@/lib/search/query";

/**
 * The URL half of `/search` — spec §11's route and §13's filters.
 *
 * **A search is a link a person can send**, so the query and every filter live in the query
 * string and nowhere else: the route reads them off `searchParams`, this module turns them into
 * a `SearchQuery`, and the same module builds every link back out. There is no client state to
 * disagree with the address bar, which is what makes a result set shareable and the back button
 * work — both of which are behaviour, not decoration, and both of which a `useState` filter bar
 * would silently take away.
 *
 * Pure: plain values in, plain values out. The only imports are the vocabulary table and two
 * `import type`s, so every rule below is unit-testable without a database — which matters because
 * these are the rules a route cannot assert about itself.
 *
 * ## Why the parameter names live in one object
 *
 * `PARAM` is read by the parser, by `searchHref`, and by the form's `name=` attributes. A form
 * input named `type` and a parser reading `docType` is a filter that silently stops working, and
 * it is the kind of disagreement that only shows up when someone tries the product — this
 * project has watched a link rule be honoured by two sites and dropped by the third twice.
 *
 * ## `system` is absent, not disabled
 *
 * §13 lists a `system` filter and Phase 7 owns the systems catalogue, so there is nothing to
 * filter on. This module offers no `system` parameter and the route renders no control for it: a
 * disabled control advertises a feature that does not exist, and a greyed-out select is a support
 * question rather than an explanation. When Phase 7 lands the catalogue, the parameter, the
 * option list and the `SearchQuery` field arrive together.
 */

/** The route. One string, so a link cannot be built against a path the route does not serve. */
export const SEARCH_PATH = "/search";

/**
 * The query-string contract. Read by the parser, by `searchHref` and by the form's `name=`
 * attributes — see the module docstring for why that is one object and not three literals.
 *
 * `type` rather than `docType` in the URL because a URL is read by people, and the value it
 * carries (`ADR`, `RUNBOOK`) already says which kind of type is meant.
 */
export const PARAM = {
  q: "q",
  space: "space",
  docType: "type",
  status: "status",
} as const;

/**
 * How much of an unrecognised filter value is quoted back to the reader.
 *
 * The longest status name is eleven characters, so this is generous for anything that could have
 * been meant. It is a cap for the reason `MAX_ECHOED_STATUS` is one: the value comes off a query
 * string, which is unbounded and reflected into the page. React escapes it and `doc.css` wraps
 * it, so neither injection nor overflow is the concern here — painting a kilobyte of somebody
 * else's text above the results is.
 */
export const MAX_ECHOED_FILTER = 40;

/**
 * How much of the query itself is quoted back in a sentence — "No page matches “…”".
 *
 * Longer than a filter value because a real query can legitimately be a phrase, and shorter than
 * the input's own contents because the sentence has to stay a sentence. The input keeps the whole
 * string (it is `value=`, inside a box that scrolls), so nothing is lost: this bounds the prose.
 */
export const MAX_ECHOED_QUERY = 80;

/**
 * Every doc type, derived from a table that is `Record<DocType, …>` rather than typed out here.
 *
 * `FIRST_PUBLISH` is total over `DocType` — that is what its type is for — so a doc type added to
 * the enum without a vocabulary fails to compile *there* and appears in this filter for free. A
 * list written out here would agree on the day it was written and then silently stop offering the
 * fifth doc type, which is the failure `statusesInPlay` was built to avoid on the index.
 */
export const DOC_TYPES: readonly DocType[] = Object.keys(FIRST_PUBLISH) as DocType[];

/**
 * Every status the filter offers: the union of each doc type's publish destinations.
 *
 * **`DRAFT` is deliberately not in it, and the reason is that it could only ever return nothing.**
 * `search()` excludes any page without a published version, and §6.1 makes `DRAFT` a destination
 * for no publish — so a published page is never at `DRAFT`, and a chip for it would be a control
 * whose only possible answer is "no results". The same argument the other way round is why
 * `statusesInPlay` on the generated index *does* offer it: that index lists unpublished pages, and
 * this one cannot.
 *
 * Derived through `publishableStatuses` for the reason that function exists — a list of statuses
 * typed out beside the vocabulary table is a second source of truth that disagrees silently. A
 * page carrying a status outside this union is unfilterable here and still findable; saying how
 * many such rows exist would need an aggregate over `Page`, and this route deliberately makes one
 * database call.
 */
export const SEARCHABLE_STATUSES: readonly DocStatus[] = (() => {
  const union: DocStatus[] = [];
  for (const docType of DOC_TYPES) {
    for (const status of publishableStatuses(docType)) {
      if (!union.includes(status)) union.push(status);
    }
  }
  return union;
})();

/**
 * What one filter parameter asked for — three outcomes, not two, for the reason
 * `parseStatusFilter` on the generated index has three: "no filter" and "a filter nobody can
 * satisfy" must not render the same page. A value that is not one of the offered options is
 * **named back** over unfiltered results rather than silently ignored, because a typo in a
 * hand-edited or truncated URL that quietly shows everything looks exactly like a broken filter.
 *
 * A repeated parameter (`?type=ADR&type=RFC`) arrives as an array, is not a single value, and
 * takes the same branch with nothing to quote.
 */
export type FilterChoice<T extends string> =
  /** Absent, or present and empty — which is what an unset `<select>` submits. */
  | { kind: "any" }
  | { kind: "one"; value: T }
  | { kind: "unknown"; named: string | null };

/** As Next hands the query string over: `searchParams` is a plain object, not `URLSearchParams`. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/** Everything `/search` reads off its URL. */
export type ParsedSearch = {
  /**
   * Raw, as typed, with only the surrounding whitespace of an empty box removed by `search()`
   * itself. Quotes and `-exclusions` are `websearch_to_tsquery`'s job — §13 names it precisely so
   * that what a person types is not pre-chewed by a caller.
   */
  q: string;
  /**
   * A space **key**, and any non-empty string is a legal one: `Space.key` has no enumerable
   * vocabulary here, and `search()` answers an unknown key and an unreadable key identically —
   * no hits — which is §8's 404-not-403 rule applied to a filter. So there is no `unknown` branch
   * to reach except a repeated parameter.
   */
  space: FilterChoice<string>;
  docType: FilterChoice<DocType>;
  status: FilterChoice<DocStatus>;
};

/** One parameter, read as a single string. `undefined` and `""` are both "no filter". */
function rawValue(raw: RawSearchParams, name: string): string | string[] | undefined {
  return raw[name];
}

function parseChoice<T extends string>(
  allowed: readonly T[],
  raw: string | string[] | undefined,
): FilterChoice<T> {
  if (raw === undefined) return { kind: "any" };
  if (typeof raw !== "string") return { kind: "unknown", named: null };
  if (raw === "") return { kind: "any" };

  const match = allowed.find((option) => option === raw);
  if (match === undefined) return { kind: "unknown", named: echo(raw, MAX_ECHOED_FILTER) };
  return { kind: "one", value: match };
}

/**
 * A filter with no enumerable vocabulary — the space key. Anything non-empty is passed through to
 * `search()`, which is the only thing that can answer whether it names a space this viewer reads.
 */
function parseFreeChoice(raw: string | string[] | undefined): FilterChoice<string> {
  if (raw === undefined) return { kind: "any" };
  if (typeof raw !== "string") return { kind: "unknown", named: null };
  if (raw === "") return { kind: "any" };
  return { kind: "one", value: raw };
}

/** Quoted-back text, capped. Ellipsis so a truncated value does not read as the whole one. */
export function echo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function parseSearchParams(raw: RawSearchParams): ParsedSearch {
  const q = rawValue(raw, PARAM.q);
  return {
    // A repeated `?q=a&q=b` is an array and there is no sensible single query in it; an empty
    // string is what the box submits when nothing was typed, and both land on `empty-query`.
    q: typeof q === "string" ? q : "",
    space: parseFreeChoice(rawValue(raw, PARAM.space)),
    docType: parseChoice(DOC_TYPES, rawValue(raw, PARAM.docType)),
    status: parseChoice(SEARCHABLE_STATUSES, rawValue(raw, PARAM.status)),
  };
}

/**
 * The `SearchQuery` a parsed URL asks for — the **applied** state, and the only thing the route
 * hands to `search()`.
 *
 * An `unknown` filter is dropped rather than passed through, which is what makes the sentence
 * naming it back honest: the results really are unfiltered. It is also the one place that decision
 * is taken, so `searchHref` can be built from this and cannot carry a filter the results do not
 * reflect.
 */
export function searchQueryOf(parsed: ParsedSearch): SearchQuery {
  return {
    q: parsed.q,
    ...(parsed.space.kind === "one" ? { spaceKey: parsed.space.value } : {}),
    ...(parsed.docType.kind === "one" ? { docType: parsed.docType.value } : {}),
    ...(parsed.status.kind === "one" ? { status: parsed.status.value } : {}),
  };
}

/** A filter that was asked for and could not be honoured, ready to be named back. */
export type UnknownFilter = {
  /** The words the sentence uses, not the parameter name. */
  label: string;
  /** The text to quote, or `null` when the parameter was repeated and there is no single value. */
  named: string | null;
};

/**
 * Every filter the URL asked for that the results do not reflect.
 *
 * Named back rather than silently ignored, for the reason the generated index names its own: a
 * filter that quietly shows everything is indistinguishable from a broken one, and this project
 * has already shipped one guard whose failure mode looked like success.
 */
export function unknownFilters(parsed: ParsedSearch): UnknownFilter[] {
  const out: UnknownFilter[] = [];
  if (parsed.space.kind === "unknown") out.push({ label: "space", named: parsed.space.named });
  if (parsed.docType.kind === "unknown") {
    out.push({ label: "doc type", named: parsed.docType.named });
  }
  if (parsed.status.kind === "unknown") out.push({ label: "status", named: parsed.status.named });
  return out;
}

/** A change to one part of a search. `null` clears that filter; an absent key leaves it alone. */
export type SearchPatch = {
  q?: string;
  spaceKey?: string | null;
  docType?: DocType | null;
  status?: DocStatus | null;
};

/**
 * The URL for a search — **the only place one is built**, and the reason a filtered result set
 * stays shareable.
 *
 * Built from the applied `SearchQuery` rather than from the raw parameters, so a link cannot carry
 * a filter the page it came from was not applying. Every filter in that query goes into the query
 * string: drop any one of these lines and the product still works, still filters, still looks
 * right — and the URL in the address bar stops describing what is on screen, so sending it to a
 * colleague sends them a different search. That is why this is a function with its own tests and
 * not four template literals at four call sites.
 *
 * Percent-encoding is `URLSearchParams`', which is the right one for a query string — `+` for a
 * space and `%26` for an ampersand — and is not `pageHref`'s per-segment `encodeURIComponent`,
 * because that one is encoding a path.
 */
export function searchHref(query: SearchQuery, patch: SearchPatch = {}): string {
  const next = {
    q: patch.q ?? query.q,
    spaceKey: patch.spaceKey === undefined ? query.spaceKey : (patch.spaceKey ?? undefined),
    docType: patch.docType === undefined ? query.docType : (patch.docType ?? undefined),
    status: patch.status === undefined ? query.status : (patch.status ?? undefined),
  };

  const params = new URLSearchParams();
  if (next.q !== "") params.set(PARAM.q, next.q);
  if (next.spaceKey !== undefined) params.set(PARAM.space, next.spaceKey);
  if (next.docType !== undefined) params.set(PARAM.docType, next.docType);
  if (next.status !== undefined) params.set(PARAM.status, next.status);

  const queryString = params.toString();
  return queryString === "" ? SEARCH_PATH : `${SEARCH_PATH}?${queryString}`;
}

/** True when any filter is applied — what "clear the filters" needs to know to offer itself. */
export function hasFilters(query: SearchQuery): boolean {
  return (
    query.spaceKey !== undefined || query.docType !== undefined || query.status !== undefined
  );
}

/** The `SearchQuery` with every filter cleared and the words kept. */
export const CLEARED: SearchPatch = { spaceKey: null, docType: null, status: null };

/**
 * The reasons `search()` can decline to search. Derived from its own return type, so a fourth
 * reason added in `lib/search` widens this union and the route's exhaustive switch stops
 * compiling — rather than falling into whichever branch was written last.
 */
export type NoSearchReason = Extract<SearchResult, { ok: false }>["reason"];

/**
 * **Three outcomes, not two** — the plan's bullet, as a value the route switches on.
 *
 * A person who typed nothing, a person whose input contained no searchable word, and a person
 * whose real query matched nothing are owed three different sentences. Collapsing any pair of
 * them tells somebody their query was fine when it was not, or that nothing matched when nothing
 * was ever looked for:
 *
 * | Outcome | What happened | The lie if it is collapsed |
 * |---|---|---|
 * | `empty-query` | nothing typed; no database work at all | "No results" for a search nobody ran |
 * | `no-terms` | `...`, `-only`, `'` — reduced to an empty `tsquery` | "No results for `...`", as though `...` had been looked for |
 * | `no-hits` | a real query, nothing matched | — |
 * | `hits` | — | — |
 *
 * The first two come out of `lib/search`, which is where they can be known: `no-terms` is
 * `websearch_to_tsquery` returning an empty query, and no caller can predict that from the text.
 * This function is only the join, and it is a pure function so that the join has a test.
 */
export type SearchOutcome = NoSearchReason | "no-hits" | "hits";

export function outcomeOf(result: SearchResult): SearchOutcome {
  if (!result.ok) return result.reason;
  return result.hits.length === 0 ? "no-hits" : "hits";
}
