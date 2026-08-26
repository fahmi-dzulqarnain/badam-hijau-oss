import { describe, expect, test } from "vitest";
import type { DocStatus, DocType } from "@prisma/client";
import { FIRST_PUBLISH, publishableStatuses, UNPUBLISHED } from "@/lib/pages/transition";
import type { SearchHit, SearchResult } from "@/lib/search/query";
import {
  CLEARED,
  DOC_TYPES,
  MAX_ECHOED_FILTER,
  PARAM,
  SEARCHABLE_STATUSES,
  SEARCH_PATH,
  hasFilters,
  outcomeOf,
  parseSearchParams,
  searchHref,
  searchQueryOf,
  unknownFilters,
} from "@/lib/search/params";

/**
 * The pure half of `/search` — the URL contract and the three-outcome mapping.
 *
 * Unit rather than integration, because none of it is a question about rows: whether a repeated
 * parameter is a filter, whether an unrecognised one is named back, whether a filtered search is
 * still a link a person can send, and whether the three no-result outcomes stay three. The route
 * itself is driven end to end, where a browser can be asked whether the link actually works.
 */

/* -------------------------------------------------------------------------- */
/* The options the filters offer are derived, not typed out                   */
/* -------------------------------------------------------------------------- */

test("every doc type is offered, derived from the vocabulary table", () => {
  // The point is the *derivation*: `FIRST_PUBLISH` is `Record<DocType, …>`, so this list cannot
  // fall behind the enum. Compared against the table rather than against a literal list, which
  // would be the second source of truth the derivation exists to avoid.
  expect([...DOC_TYPES].sort()).toEqual(Object.keys(FIRST_PUBLISH).sort());
  expect(DOC_TYPES.length).toBeGreaterThan(1);
});

test("the status filter offers every publishable status and never DRAFT", () => {
  const union = new Set<DocStatus>();
  for (const docType of DOC_TYPES) for (const s of publishableStatuses(docType)) union.add(s);

  expect([...SEARCHABLE_STATUSES].sort()).toEqual([...union].sort());
  // Non-vacuity: an empty union would satisfy the equivalence above and every assertion below.
  expect(SEARCHABLE_STATUSES).toContain("ACCEPTED");
  expect(SEARCHABLE_STATUSES).toContain("SUPERSEDED");

  // `search()` returns only published pages and no publish lands on DRAFT, so a DRAFT chip could
  // only ever answer "no results" — see the constant's docstring.
  expect(SEARCHABLE_STATUSES).not.toContain(UNPUBLISHED);
});

/* -------------------------------------------------------------------------- */
/* Reading the URL                                                            */
/* -------------------------------------------------------------------------- */

test("a query and three filters are read off the query string", () => {
  const parsed = parseSearchParams({
    [PARAM.q]: "topic registry",
    [PARAM.space]: "engineering",
    [PARAM.docType]: "ADR",
    [PARAM.status]: "SUPERSEDED",
  });

  expect(parsed.q).toBe("topic registry");
  expect(parsed.space).toEqual({ kind: "one", value: "engineering" });
  expect(parsed.docType).toEqual({ kind: "one", value: "ADR" });
  expect(parsed.status).toEqual({ kind: "one", value: "SUPERSEDED" });

  expect(searchQueryOf(parsed)).toEqual({
    q: "topic registry",
    spaceKey: "engineering",
    docType: "ADR",
    status: "SUPERSEDED",
  });
});

test("no parameters at all is an empty query with no filters", () => {
  const parsed = parseSearchParams({});
  expect(parsed.q).toBe("");
  expect(searchQueryOf(parsed)).toEqual({ q: "" });
  expect(hasFilters(searchQueryOf(parsed))).toBe(false);
});

test("an empty value is no filter, because that is what an unset select submits", () => {
  // A GET form submits every named control, so `?q=x&type=&status=&space=` is the *normal* URL
  // after pressing Search with nothing chosen. If empty read as "unknown", every such search
  // would open with three sentences explaining filters nobody asked for.
  const parsed = parseSearchParams({
    [PARAM.q]: "mqtt",
    [PARAM.space]: "",
    [PARAM.docType]: "",
    [PARAM.status]: "",
  });
  expect(searchQueryOf(parsed)).toEqual({ q: "mqtt" });
  expect(unknownFilters(parsed)).toEqual([]);
});

test("whitespace is left in the query, because only search() may decide it is empty", () => {
  // `search()` owns `empty-query`; trimming here would make two modules agree on what "nothing
  // typed" means, and only one of them would be tested.
  expect(parseSearchParams({ [PARAM.q]: "   " }).q).toBe("   ");
});

test("a repeated parameter is not a single value, and is named back with nothing to quote", () => {
  const parsed = parseSearchParams({
    [PARAM.q]: ["one", "two"],
    [PARAM.space]: ["engineering", "handbook"],
    [PARAM.docType]: ["ADR", "RFC"],
    [PARAM.status]: ["ACCEPTED", "CLOSED"],
  });

  expect(parsed.q).toBe("");
  expect(unknownFilters(parsed)).toEqual([
    { label: "space", named: null },
    { label: "doc type", named: null },
    { label: "status", named: null },
  ]);
  // And none of them reaches the query, so the sentence naming them back is true.
  expect(searchQueryOf(parsed)).toEqual({ q: "" });
});

test("a value outside the vocabulary is named back over unfiltered results", () => {
  const parsed = parseSearchParams({
    [PARAM.q]: "mqtt",
    [PARAM.docType]: "MEMO",
    [PARAM.status]: "PENDING",
  });

  expect(parsed.docType).toEqual({ kind: "unknown", named: "MEMO" });
  expect(parsed.status).toEqual({ kind: "unknown", named: "PENDING" });
  expect(unknownFilters(parsed)).toEqual([
    { label: "doc type", named: "MEMO" },
    { label: "status", named: "PENDING" },
  ]);
  // Unfiltered, which is what makes naming it back honest rather than decorative.
  expect(searchQueryOf(parsed)).toEqual({ q: "mqtt" });
});

test("an unrecognised value is capped before it is quoted back", () => {
  const hostile = "x".repeat(300);
  const parsed = parseSearchParams({ [PARAM.q]: "mqtt", [PARAM.status]: hostile });
  const [named] = unknownFilters(parsed);

  expect(named?.named).toBe(`${"x".repeat(MAX_ECHOED_FILTER)}…`);
  expect((named?.named ?? "").length).toBeLessThan(hostile.length);
});

test("any non-empty space key is passed through, because only search() can resolve one", () => {
  // An unreadable space and a space that does not exist give the same answer — no hits — which is
  // §8's 404-not-403 rule applied to a filter. Refusing an unknown key here would need a list of
  // space keys, which is a second database query this route deliberately does not make.
  const parsed = parseSearchParams({ [PARAM.q]: "mqtt", [PARAM.space]: "finance" });
  expect(searchQueryOf(parsed)).toEqual({ q: "mqtt", spaceKey: "finance" });
  expect(unknownFilters(parsed)).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Building the URL — a filtered search is a link a person can send           */
/* -------------------------------------------------------------------------- */

describe("searchHref", () => {
  test("carries the query and every applied filter", () => {
    const href = searchHref({
      q: "topic registry",
      spaceKey: "engineering",
      docType: "ADR",
      status: "SUPERSEDED",
    });

    // Parsing the href back is the assertion that matters: a filter dropped from this string is a
    // search that stops being shareable, and it looks identical on screen.
    const url = new URL(href, "https://example.invalid");
    expect(url.pathname).toBe(SEARCH_PATH);
    expect(url.searchParams.get(PARAM.q)).toBe("topic registry");
    expect(url.searchParams.get(PARAM.space)).toBe("engineering");
    expect(url.searchParams.get(PARAM.docType)).toBe("ADR");
    expect(url.searchParams.get(PARAM.status)).toBe("SUPERSEDED");
  });

  test("round-trips through the parser, so a link reproduces the search it came from", () => {
    const query = {
      q: "back-off & retry",
      spaceKey: "engineering",
      docType: "RFC" as DocType,
      status: "IN_REVIEW" as DocStatus,
    };
    const url = new URL(searchHref(query), "https://example.invalid");

    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams) raw[key] = value;
    expect(searchQueryOf(parseSearchParams(raw))).toEqual(query);
  });

  test("omits what is not set, so an unfiltered search is a clean URL", () => {
    expect(searchHref({ q: "" })).toBe(SEARCH_PATH);
    expect(searchHref({ q: "mqtt" })).toBe(`${SEARCH_PATH}?${PARAM.q}=mqtt`);
  });

  test("a patch narrows to a space and keeps everything else", () => {
    const href = searchHref({ q: "mqtt", docType: "ADR" }, { spaceKey: "handbook" });
    const url = new URL(href, "https://example.invalid");
    expect(url.searchParams.get(PARAM.space)).toBe("handbook");
    expect(url.searchParams.get(PARAM.docType)).toBe("ADR");
    expect(url.searchParams.get(PARAM.q)).toBe("mqtt");
  });

  test("a null clears one filter and leaves the rest", () => {
    const href = searchHref(
      { q: "mqtt", spaceKey: "engineering", docType: "ADR" },
      { spaceKey: null },
    );
    const url = new URL(href, "https://example.invalid");
    expect(url.searchParams.has(PARAM.space)).toBe(false);
    expect(url.searchParams.get(PARAM.docType)).toBe("ADR");
  });

  test("CLEARED drops every filter and keeps the words", () => {
    const href = searchHref(
      { q: "mqtt", spaceKey: "engineering", docType: "ADR", status: "ACCEPTED" },
      CLEARED,
    );
    expect(href).toBe(`${SEARCH_PATH}?${PARAM.q}=mqtt`);
  });

  test("encodes a query that would otherwise end the query string", () => {
    const url = new URL(
      searchHref({ q: "a&b=c #frag ?x", spaceKey: "eng ineering" }),
      "https://example.invalid",
    );
    expect(url.searchParams.get(PARAM.q)).toBe("a&b=c #frag ?x");
    expect(url.searchParams.get(PARAM.space)).toBe("eng ineering");
  });

  test("hasFilters is true for each filter alone and false for none", () => {
    expect(hasFilters({ q: "mqtt" })).toBe(false);
    expect(hasFilters({ q: "mqtt", spaceKey: "engineering" })).toBe(true);
    expect(hasFilters({ q: "mqtt", docType: "ADR" })).toBe(true);
    expect(hasFilters({ q: "mqtt", status: "ACCEPTED" })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Three outcomes, not two                                                    */
/* -------------------------------------------------------------------------- */

const hit = { pageId: "p1" } as unknown as SearchHit;

describe("outcomeOf", () => {
  test("distinguishes all four cases", () => {
    const cases: [SearchResult, string][] = [
      [{ ok: false, reason: "empty-query" }, "empty-query"],
      [{ ok: false, reason: "no-terms" }, "no-terms"],
      [{ ok: true, hits: [], truncated: false }, "no-hits"],
      [{ ok: true, hits: [hit], truncated: false }, "hits"],
    ];
    for (const [result, expected] of cases) expect(outcomeOf(result)).toBe(expected);
  });

  test("the three no-result outcomes are three distinct values", () => {
    // The mutation this kills: mapping `no-terms` onto `no-hits` — which reads as a tidy
    // simplification and tells a person who typed `...` that nothing matched, when nothing was
    // ever looked for. The route switches on this value, so collapsing any pair here silently
    // merges two sentences.
    const outcomes = new Set([
      outcomeOf({ ok: false, reason: "empty-query" }),
      outcomeOf({ ok: false, reason: "no-terms" }),
      outcomeOf({ ok: true, hits: [], truncated: false }),
    ]);
    expect(outcomes.size).toBe(3);
  });

  test("truncation does not change the outcome", () => {
    expect(outcomeOf({ ok: true, hits: [hit], truncated: true })).toBe("hits");
  });
});
