import { expect, test } from "vitest";
import type { DocStatus, DocType } from "@prisma/client";
import {
  DOC_INDEXES,
  MAX_ECHOED_STATUS,
  filteredStatus,
  indexHref,
  indexedDocTypes,
  offVocabularyCount,
  parseStatusFilter,
  statusesInPlay,
} from "@/lib/lifecycle/indexes";
import { TRANSITION_TABLE, UNPUBLISHED, publishableStatuses } from "@/lib/pages/transition";
import { validateSlug } from "@/lib/pages/slug";

/**
 * The pure half of Task 10: which doc types have an index, what its URL is, and which statuses
 * its filter offers. No database, because none of these questions is about rows.
 */

/* -------------------------------------------------------------------------- */
/* Which doc types have an index                                              */
/* -------------------------------------------------------------------------- */

test("spec §11's two indexes exist, at the URLs it names, and no others", () => {
  expect(indexedDocTypes()).toEqual(["ADR", "RFC"]);
  expect(DOC_INDEXES.ADR?.slug).toBe("adrs");
  expect(DOC_INDEXES.RFC?.slug).toBe("rfcs");
  expect(DOC_INDEXES.DOC).toBeNull();
  expect(DOC_INDEXES.RUNBOOK).toBeNull();
});

test("every index has words for all four of its sentences", () => {
  // The empty branches interpolate `noun` and `nounPlural`, and a blank one renders "Nothing in
  // Engineering is a  yet." — a sentence no test that only checks the heading would catch.
  for (const docType of indexedDocTypes()) {
    const meta = DOC_INDEXES[docType]!;
    for (const [key, value] of Object.entries(meta)) {
      expect(value.length, `${docType}.${key} is empty`).toBeGreaterThan(0);
    }
  }
});

/**
 * The reason the `-/` prefix is safe, made executable rather than asserted in a comment.
 *
 * A page could only shadow `/{space}/-/adrs` by holding a first path segment of `-`, and
 * `validateSlug` refuses that with its own error code — before every other rule except emptiness,
 * and upstream of both `createPage` and `movePage`. This test fails if that refusal is ever
 * relaxed, which is the failure that would silently make these two routes shadowable.
 */
test("no page can shadow an index route: the `-` segment is a reserved slug", () => {
  const refusal = validateSlug("-");
  expect(refusal.ok).toBe(false);
  expect(refusal.ok === false && refusal.error.code).toBe("reserved-prefix");

  // And the whole family, since the route is `-/{slug}` and a slug of `-adrs` is the same trap
  // one character along.
  for (const docType of indexedDocTypes()) {
    const shadow = validateSlug(`-${DOC_INDEXES[docType]!.slug}`);
    expect(shadow.ok === false && shadow.error.code).toBe("reserved-prefix");
  }
});

/* -------------------------------------------------------------------------- */
/* The status vocabulary the filter offers                                    */
/* -------------------------------------------------------------------------- */

/**
 * The derivation, asserted as an equivalence over the transition table — **with the non-vacuity
 * companion beside it**, which is the lesson Task 9 Step 0 paid for: an equivalence assertion over
 * two derived sets passes hardest exactly when both derivations break together, and this one would
 * go vacuously true if `TRANSITION_TABLE` were ever read as empty.
 *
 * The property: a page of this doc type can be **in** any status that the table names, whether as
 * an origin (a key) or as a destination (a value). Nothing else is reachable, because `status` is
 * written by `createPage` (always `DRAFT`) and by publishes and cascades validated through this
 * same table.
 */
test.each(["ADR", "RFC", "DOC", "RUNBOOK"] as DocType[])(
  "%s: the filter offers exactly the statuses the vocabulary lets a page be in",
  (docType) => {
    const row = TRANSITION_TABLE[docType];
    const fromTable = new Set<DocStatus>();
    for (const [origin, destinations] of Object.entries(row)) {
      fromTable.add(origin as DocStatus);
      for (const destination of destinations ?? []) fromTable.add(destination);
    }

    // Non-vacuity, first: both sides must be non-empty, or the equivalence below proves nothing.
    expect(fromTable.size).toBeGreaterThan(2);
    expect(statusesInPlay(docType).length).toBeGreaterThan(2);

    expect([...statusesInPlay(docType)].sort()).toEqual([...fromTable].sort());
  },
);

/**
 * The difference between the two derivations, stated as a test rather than only in a docstring,
 * because "filter by status from the vocabulary" invites reaching for the function that already
 * exists — and it is the wrong one by exactly one status.
 */
test("statusesInPlay is publishableStatuses plus DRAFT, and DRAFT is the whole difference", () => {
  for (const docType of ["ADR", "RFC", "DOC", "RUNBOOK"] as DocType[]) {
    const publishable = publishableStatuses(docType);
    expect(publishable).not.toContain(UNPUBLISHED);
    expect(statusesInPlay(docType)).toContain(UNPUBLISHED);
    expect([...statusesInPlay(docType)]).toEqual([UNPUBLISHED, ...publishable]);
  }
});

test("an ADR's filter offers its own vocabulary and not another type's", () => {
  // `CURRENT` and `NEEDS_REVIEW` are real `DocStatus` values that no ADR can ever hold, so a
  // filter built from the enum rather than from the vocabulary would offer them.
  expect(statusesInPlay("ADR")).not.toContain("CURRENT");
  expect(statusesInPlay("ADR")).not.toContain("NEEDS_REVIEW");
  expect(statusesInPlay("ADR")).toContain("SUPERSEDED");
  expect(statusesInPlay("RFC")).toContain("CLOSED");
  expect(statusesInPlay("RFC")).not.toContain("PROPOSED");
});

/* -------------------------------------------------------------------------- */
/* Rows the vocabulary does not admit                                         */
/* -------------------------------------------------------------------------- */

test("a page at a status the doc type cannot be in is counted as off-vocabulary", () => {
  // Not hypothetical: `prisma/seed.ts` writes `status: "CURRENT"` onto an unpublished page
  // whatever its doc type, so the seeded ADR `adr-0043-prisma-migrations` is exactly this row.
  // Reported as drift; this is the count that makes it visible instead of showing up as chips
  // that do not add up to their own `All`.
  const counts = new Map<DocStatus, number>([
    ["ACCEPTED", 1],
    ["CURRENT", 1],
  ]);
  expect(offVocabularyCount("ADR", counts)).toBe(1);
  // The same histogram is entirely in-vocabulary for a DOC.
  expect(offVocabularyCount("DOC", new Map<DocStatus, number>([["CURRENT", 1]]))).toBe(0);
});

test("a histogram of nothing but legal statuses counts zero, at any size", () => {
  for (const docType of ["ADR", "RFC", "DOC", "RUNBOOK"] as DocType[]) {
    const counts = new Map<DocStatus, number>(
      statusesInPlay(docType).map((status, i) => [status, i + 1]),
    );
    // Non-vacuity: a function that ignored its input would also return 0 here, so assert the
    // histogram was worth summing.
    expect(counts.size).toBeGreaterThan(2);
    expect(offVocabularyCount(docType, counts)).toBe(0);
  }
});

/* -------------------------------------------------------------------------- */
/* Reading the query string                                                   */
/* -------------------------------------------------------------------------- */

test("no ?status= is every row, and so is an empty one", () => {
  expect(parseStatusFilter("ADR", undefined)).toEqual({ kind: "all" });
  expect(parseStatusFilter("ADR", "")).toEqual({ kind: "all" });
  expect(filteredStatus({ kind: "all" })).toBeNull();
});

test("a status in the doc type's vocabulary filters, and DRAFT is one of them", () => {
  expect(parseStatusFilter("ADR", "ACCEPTED")).toEqual({ kind: "status", status: "ACCEPTED" });
  // The decision this task took about unpublished pages, in one line: they are listed, so the
  // filter has to be able to ask for them.
  expect(parseStatusFilter("ADR", "DRAFT")).toEqual({ kind: "status", status: "DRAFT" });
});

test("a status from another doc type's vocabulary is unknown, not accepted", () => {
  // The mutation this pins: filtering against `DocStatus` at large, or against
  // `publishableStatuses` of the wrong type, would accept this and return an always-empty list.
  expect(parseStatusFilter("ADR", "CURRENT")).toEqual({ kind: "unknown", named: "CURRENT" });
  expect(parseStatusFilter("RFC", "PROPOSED")).toEqual({ kind: "unknown", named: "PROPOSED" });
});

test("matching is exact: case, whitespace and prefixes are all unknown", () => {
  for (const raw of ["accepted", " ACCEPTED", "ACCEPTED ", "ACCEPT", "ACCEPTEDX"]) {
    expect(parseStatusFilter("ADR", raw).kind, raw).toBe("unknown");
  }
});

test("a repeated ?status= names nothing, because there is no single value to quote", () => {
  expect(parseStatusFilter("ADR", ["ACCEPTED", "REJECTED"])).toEqual({
    kind: "unknown",
    named: null,
  });
});

test("an over-long value is echoed back capped, not whole", () => {
  const hostile = "x".repeat(400);
  const filter = parseStatusFilter("ADR", hostile);
  expect(filter.kind).toBe("unknown");
  const named = filter.kind === "unknown" ? filter.named : null;
  expect(named).toBe(`${"x".repeat(MAX_ECHOED_STATUS)}…`);
  expect(named!.length).toBeLessThan(hostile.length);
});

/* -------------------------------------------------------------------------- */
/* The URLs                                                                   */
/* -------------------------------------------------------------------------- */

test("an index href encodes the space key and carries the status", () => {
  const adrs = DOC_INDEXES.ADR!;
  expect(indexHref("engineering", adrs)).toBe("/engineering/-/adrs");
  expect(indexHref("engineering", adrs, "ACCEPTED")).toBe("/engineering/-/adrs?status=ACCEPTED");
  expect(indexHref("engineering", adrs, null)).toBe("/engineering/-/adrs");
  // A space key is user-chosen text, and `pageHref` exists because `Page.path` had the same
  // problem: a key with a `#` or a space in it silently produces a broken link.
  expect(indexHref("a b#c", adrs)).toBe("/a%20b%23c/-/adrs");
});
