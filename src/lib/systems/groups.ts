import type { DocStatus, DocType } from "@prisma/client";
import { isRetired, publishableStatuses } from "@/lib/pages/transition";

/**
 * How `/systems/[key]` divides the documentation that names a system — spec §7: *"a generated
 * page per system listing the documentation that affects it, grouped by doc type: ADRs affecting
 * it, its runbooks, open RFCs."*
 *
 * Pure, like `src/lib/lifecycle/indexes.ts` and for the same reason: this module is the only
 * place that knows which groups exist, what they are called, and which statuses each one shows,
 * so all of that is unit-testable without a database. `src/lib/systems/read.ts` is the rows.
 *
 * ## `DOC` gets a group, and §7's list of three is why it needs an argument
 *
 * §7 names ADRs, runbooks and open RFCs. `DocType` has a fourth value, and `resolveSystems`
 * accepts `systems:` on a page of **any** doc type — deliberately, and with no gate anywhere in
 * publish. So a `DOC` can declare a system today, the row lands in `PageSystem`, and a page that
 * rendered only §7's three groups would drop it silently.
 *
 * That is the exact failure this phase has already refused twice from other directions: Task 1
 * chose `Restrict` because "cascade does not drop a facet; it manufactures a lie", and Task 2
 * refuses an unknown key because a dropped one "looks exactly like one that was never written".
 * A reader who declares `systems: [order-hub]` on a `DOC`, publishes, and finds their page on no
 * system page has met the same lie by the third route. Either the group exists or publish refuses
 * the key for a `DOC` — and refusing would be a new authoring rule invented on a read surface.
 *
 * So the record below is **total over `DocType`**, the same construction `DOC_INDEXES`,
 * `PUBLISHABLE_INTO` and `RETIRED_LEAD` use: a doc type added to the enum without a decision here
 * fails to compile.
 *
 * ## "Open RFCs" is a status filter, so the heading says what it excludes
 *
 * §7 says "open RFCs" in passing and does not define open. It is derived, not transcribed:
 * **open is not retired** (§6.4's question — is this document in force *now*), which for the RFC
 * vocabulary leaves `IN_REVIEW` and `ACCEPTED`.
 *
 * `terminalStatuses("RFC")` returns the same three names today and is the wrong derivation. It
 * asks whether a document can ever be in force *again*, and the two questions come apart on
 * `ARCHIVED` — retired but not terminal, because a `DOC` or a `RUNBOOK` publishes `ARCHIVED →
 * CURRENT`. `ARCHIVED` is not in the RFC vocabulary today, so the two agree by accident; if a
 * phase ever adds it, `isRetired` keeps an archived RFC out of "open" and `terminalStatuses`
 * would let it in. Deriving from the question actually being asked is what makes that a
 * non-event.
 *
 * And the group **says so on the page**. A heading reading "RFCs" over a list that quietly hides
 * the closed ones is the same class of lie as a dropped facet, so the blurb below is assembled
 * from the two derived lists rather than typed out — a vocabulary change moves the sentence with
 * it — and `read.ts` counts the excluded rows so the page can say how many are missing rather
 * than only that some might be.
 *
 * ## The asymmetry with `ADR` is §7's, and it is deliberate
 *
 * A `SUPERSEDED` ADR is listed and a `CLOSED` RFC is not. That is not an oversight in the spec:
 * §6.4 keeps a retired decision readable *as history* and that history is exactly what a system
 * page is for, while an RFC that closed is a proposal that ended and is not documentation of the
 * system as it stands. The ADR blurb says the first half out loud, because a reader who sees a
 * deprecated decision in the list should know it is there on purpose.
 */

/**
 * The RFC statuses "open" means, derived from the vocabulary rather than listed.
 *
 * `publishableStatuses("RFC")` is every status an RFC can be published into — `DRAFT` is in no
 * row's value, so an unpublished RFC is not a case here — and `isRetired` is §6.4's own question.
 * The two lists below partition it, which is what `groups.test.ts` asserts, with the non-vacuity
 * companion both halves need: an equivalence over two derived sets passes hardest when both
 * derivations break together.
 */
export const OPEN_RFC_STATUSES: readonly DocStatus[] = publishableStatuses("RFC").filter(
  (status) => !isRetired(status),
);

/** The other half of that partition: what the "Open RFCs" group leaves out, and names. */
export const CLOSED_RFC_STATUSES: readonly DocStatus[] = publishableStatuses("RFC").filter(
  (status) => isRetired(status),
);

/** English for a list of status names, so the derived sentences read as sentences. */
function listed(statuses: readonly DocStatus[]): string {
  if (statuses.length === 0) return "none";
  if (statuses.length === 1) return statuses[0] as string;
  return `${statuses.slice(0, -1).join(", ")} and ${statuses[statuses.length - 1]}`;
}

export type SystemGroup = {
  /** The `<h2>`. */
  heading: string;
  /** The sentence under it. For `RFC` it is derived, so it cannot go stale. */
  blurb: string;
  /**
   * The statuses this group lists, or `null` for "every status this doc type can hold".
   *
   * `null` rather than a spelled-out vocabulary, because "no status filter" and "a filter that
   * happens to name every status" are different claims and only the first one stays true when a
   * vocabulary grows. `read.ts` turns this into the query's own filter.
   */
  statuses: readonly DocStatus[] | null;
  /** Empty unless `statuses` is a filter. What the page reports as not listed. */
  excluded: readonly DocStatus[];
  /** Singular and plural, for the count sentences. */
  noun: string;
  nounPlural: string;
};

/**
 * Total over `DocType`, so a fifth doc type cannot be added without deciding what a system page
 * does with it.
 */
export const SYSTEM_GROUPS: Record<DocType, SystemGroup> = {
  ADR: {
    heading: "Decisions",
    blurb:
      "Every decision record that names this system, at any status. A superseded or deprecated " +
      "decision stays in this list and stays readable — §6.4 keeps it as history, and the " +
      "history of a system is what this page is for.",
    statuses: null,
    excluded: [],
    noun: "decision record",
    nounPlural: "decision records",
  },
  RUNBOOK: {
    heading: "Runbooks",
    blurb: "Operational runbooks that name this system, at any status.",
    statuses: null,
    excluded: [],
    noun: "runbook",
    nounPlural: "runbooks",
  },
  RFC: {
    heading: "Open RFCs",
    blurb:
      `Proposals still under consideration — RFCs at ${listed(OPEN_RFC_STATUSES)}. An RFC at ` +
      `${listed(CLOSED_RFC_STATUSES)} is not listed here, because §7 asks this group for the ` +
      "open ones; the count below says how many are being left out.",
    statuses: OPEN_RFC_STATUSES,
    excluded: CLOSED_RFC_STATUSES,
    noun: "open RFC",
    nounPlural: "open RFCs",
  },
  DOC: {
    heading: "Other documentation",
    blurb:
      "Pages that name this system without being a decision, a runbook or a proposal. §7's " +
      "three groups do not include this one, and it exists because publish accepts `systems:` " +
      "on any doc type — a facet a page can declare and that appears nowhere is the same lie " +
      "this phase already refused twice.",
    statuses: null,
    excluded: [],
    noun: "page",
    nounPlural: "pages",
  },
};

/**
 * The order the groups are rendered in — §7's own order, with the group §7 does not name last.
 *
 * A separate array rather than relying on the record's key order, because object key order is a
 * language rule rather than a decision and this is a decision. `groups.test.ts` asserts it covers
 * every key exactly once, so the two cannot drift.
 */
export const SYSTEM_GROUP_ORDER: readonly DocType[] = ["ADR", "RUNBOOK", "RFC", "DOC"];

/** Whether a row of this doc type and status belongs in its group's list, or is excluded from it. */
export function isListedInGroup(docType: DocType, status: DocStatus): boolean {
  const statuses = SYSTEM_GROUPS[docType].statuses;
  return statuses === null || statuses.includes(status);
}
