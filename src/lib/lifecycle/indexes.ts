import type { DocStatus, DocType } from "@prisma/client";
import { UNPUBLISHED, publishableStatuses } from "@/lib/pages/transition";

/**
 * The generated indexes — spec §11: `/{space}/-/adrs` and `/{space}/-/rfcs`, filterable by
 * status.
 *
 * Pure: plain values in, plain values out, nothing imported from Prisma, so every rule here is
 * unit-testable without a database. The query lives in `src/lib/lifecycle/index-read.ts` and the
 * two routes are thin wrappers around one component; this module is the only place that knows
 * which doc types have an index, what it is called, and which statuses its filter offers.
 *
 * ## The `-/` prefix is reserved, not lucky
 *
 * `validateSlug` refuses any slug beginning with `-`, with `reserved-prefix` as its own error
 * code and its own test, and the refusal runs **before** every other slug rule and upstream of
 * both `createPage` and `movePage`. So no page can take the path `-/adrs` and shadow this route,
 * today or after any move. `-/deleted` already stands on the same guarantee; the comment in
 * `validateSlug` names `/{space}/-/adrs` specifically, because this is the route it was written
 * for.
 */

/**
 * One generated index: the URL segment under `-/`, and the words the page uses.
 *
 * `heading` is what the page is titled. `lead` is the sentence under it, which has to say what
 * the list contains — a reader arriving from the nav rail has not necessarily met the phrase
 * "architecture decision record". `noun` and `nounPlural` are interpolated into the empty
 * branches so those sentences read as English rather than as an enum name.
 */
export type DocIndex = {
  /** The segment after `-/`. Lowercase, no encoding needed, and part of the URL contract. */
  slug: string;
  heading: string;
  lead: string;
  noun: string;
  nounPlural: string;
};

/**
 * Which doc types get an index, keyed by doc type — and the two that do not are written out as
 * `null` rather than omitted.
 *
 * `Record<DocType, DocIndex | null>` rather than a partial: a doc type added to the enum without
 * a decision here **fails to compile**, which is the same reason `PUBLISHABLE_INTO` and
 * `RETIRED_LEAD` are total. Spec §11 names exactly two indexes, and the argument for the two
 * `null`s is not "nobody asked": a `DOC` or a `RUNBOOK` is a living page reached through the nav
 * rail, where an ADR and an RFC are records whose whole value is being enumerable — which is the
 * same split `terminalStatuses` draws, from the other side. If a phase ever wants
 * `/{space}/-/runbooks`, this is the one line it changes.
 */
export const DOC_INDEXES: Record<DocType, DocIndex | null> = {
  ADR: {
    slug: "adrs",
    heading: "Decision records",
    lead:
      "Every architecture decision record in this space, newest number last. A decision that " +
      "has been superseded or deprecated stays here and stays readable — that is what the " +
      "record is for.",
    noun: "decision record",
    nounPlural: "decision records",
  },
  RFC: {
    slug: "rfcs",
    heading: "Proposals",
    lead:
      "Every RFC in this space. A proposal that was closed, withdrawn or rejected stays here " +
      "with its status, because the argument is the thing worth keeping.",
    noun: "proposal",
    nounPlural: "proposals",
  },
  // No index, deliberately — see the docstring above.
  DOC: null,
  RUNBOOK: null,
};

/** The doc types that have an index. Derived, so it cannot disagree with the table above. */
export function indexedDocTypes(): DocType[] {
  return (Object.keys(DOC_INDEXES) as DocType[]).filter((type) => DOC_INDEXES[type] !== null);
}

/**
 * The route path of an index, optionally with a status filter applied.
 *
 * Every link to an index goes through here — the route's own `requireViewer` return path, the
 * filter links, and the nav rail — for the reason `pageHref` exists: this project has twice had a
 * link rule honoured by two sites and quietly dropped by the third. The space key is
 * percent-encoded per segment for the same reason `pageHref` does it; the slug and the status are
 * enum-derived and need none, and encoding them anyway would only hide a typo.
 */
export function indexHref(
  spaceKey: string,
  index: DocIndex,
  status?: DocStatus | null,
): string {
  const base = `/${encodeURIComponent(spaceKey)}/-/${index.slug}`;
  return status ? `${base}?status=${status}` : base;
}

/**
 * Every status a page of this doc type can **be in** — which is what a filter over existing rows
 * needs, and is *not* what `publishableStatuses` returns.
 *
 * The difference is exactly one status, and it is worth stating rather than leaving to be
 * rediscovered. `publishableStatuses(docType)` is the union of the *destinations* in
 * `PUBLISHABLE_INTO` — the statuses a publish can put a page **into**. `DRAFT` is an origin for
 * every doc type and a destination for none (spec §6.1), so it appears in no row's value and
 * `publishableStatuses` correctly excludes it. But every page that has never been published sits
 * at `DRAFT`, and those rows exist and are listed here, so the filter has to offer it.
 *
 * `UNPUBLISHED` rather than the literal `"DRAFT"`, so this is still derived from the vocabulary
 * module and not a second copy of one of its facts.
 *
 * **Task 9 Step 0 does not change this set, and checking that was the point of asking.** Step 0
 * gave each terminal status a row of its own listing only itself — `SUPERSEDED: ["SUPERSEDED"]`.
 * Every one of those statuses was already a destination of some *other* row (`ACCEPTED` lists
 * `SUPERSEDED` and `DEPRECATED`; `IN_REVIEW` lists `WITHDRAWN` and `REJECTED`), so the union was
 * unchanged by Step 0 and this filter would have offered all six either way. What Step 0 *did*
 * break, and what `terminalStatuses` had to be re-derived for, was the "has no row" reading of
 * terminality — a different question over the same table. Recorded here because "the vocabulary
 * changed, so the filter must have too" is the plausible wrong conclusion, and the honest answer
 * is that this derivation was already the right one.
 */
export function statusesInPlay(docType: DocType): readonly DocStatus[] {
  return [UNPUBLISHED, ...publishableStatuses(docType)];
}

/**
 * How many listed pages sit at a status this doc type's vocabulary does not define.
 *
 * Normally zero, and the index says nothing. It is not hypothetical: **the first render of this
 * page against the dev database found one.** `prisma/seed.ts` gives an unpublished page
 * `status: "CURRENT"` whatever its doc type, so the seeded ADR `adr-0043-prisma-migrations` sits
 * at `CURRENT` — a status `PUBLISHABLE_INTO.ADR` allows from nowhere and into nothing, and not the
 * `DRAFT` that `createPage` would have written. Reported rather than fixed here; the row is real
 * either way.
 *
 * The alternative designs were each worse in a way worth recording:
 *
 * - **Say nothing.** The filter bar's chips then do not add up to its own `All`, with no
 *   explanation — the arithmetic is visible on screen and the reason is not, which is how a
 *   reader learns to distrust the numbers rather than the data.
 * - **Offer a chip for it**, so every row has one. That needs `?status=` to accept a status the
 *   doc type cannot be in, which puts an illegal state into the URL contract and legitimises it.
 * - **Widen the vocabulary to `DocStatus`.** Then an ADR index offers `NEEDS_REVIEW` and the whole
 *   point of deriving the filter from `PUBLISHABLE_INTO` is gone.
 *
 * So the vocabulary stays the filter, and the leftover is *counted and named*. A number that
 * should be zero, printed when it is not, is how a data defect becomes visible instead of
 * arithmetic nobody can reconcile.
 */
export function offVocabularyCount(
  docType: DocType,
  counts: ReadonlyMap<DocStatus, number>,
): number {
  const known = new Set<DocStatus>(statusesInPlay(docType));
  let stray = 0;
  for (const [status, count] of counts) if (!known.has(status)) stray += count;
  return stray;
}

/**
 * What the `?status=` query string asked for.
 *
 * Three outcomes rather than two, because "no filter" and "a filter nobody can satisfy" must not
 * render the same page. A value that is not a status this doc type can be in is **named back to
 * the reader** over the full list, rather than silently ignored: a typo in a hand-edited URL that
 * quietly shows everything looks exactly like a broken filter, and this project has already
 * shipped one guard whose failure mode was indistinguishable from success.
 *
 * A repeated parameter (`?status=A&status=B`) arrives as an array, which is not a status either
 * and takes the same branch — with the raw text left out, because there is no single value to
 * quote back.
 */
export type StatusFilter =
  /** No `?status=` at all: every row of this doc type. */
  | { kind: "all" }
  /** A status this doc type can be in. */
  | { kind: "status"; status: DocStatus }
  /** Present and not a status of this doc type; `named` is the text to quote, if there is one. */
  | { kind: "unknown"; named: string | null };

/**
 * How much of an unrecognised value is quoted back.
 *
 * The longest status name is eleven characters, so this is generous for anything that could have
 * been meant — and it is a cap rather than the whole string because the value comes off a query
 * string, which is unbounded and reflected into the page. React escapes it and `doc.css` wraps
 * it, so neither injection nor overflow is the concern; painting ten kilobytes of somebody
 * else's text above the list is.
 */
export const MAX_ECHOED_STATUS = 40;

export function parseStatusFilter(
  docType: DocType,
  raw: string | string[] | undefined,
): StatusFilter {
  if (raw === undefined) return { kind: "all" };
  if (typeof raw !== "string") return { kind: "unknown", named: null };
  if (raw.length === 0) return { kind: "all" };

  const match = statusesInPlay(docType).find((status) => status === raw);
  if (match === undefined) {
    return {
      kind: "unknown",
      named:
        raw.length > MAX_ECHOED_STATUS ? `${raw.slice(0, MAX_ECHOED_STATUS)}…` : raw,
    };
  }
  return { kind: "status", status: match };
}

/** The status a query should filter on, or `null` for every row. */
export function filteredStatus(filter: StatusFilter): DocStatus | null {
  return filter.kind === "status" ? filter.status : null;
}
