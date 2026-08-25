import type { DocStatus, RelationType } from "@prisma/client";
import { isRetired } from "@/lib/pages/transition";
import { retiresInto } from "@/lib/lifecycle/relations";

/**
 * What a retired page's banner says — spec §6.4. Pure: rows in, a view model out, no database
 * and no JSX, so every decision below is unit-testable without either.
 *
 * §6.4: *"A page whose status is `SUPERSEDED`, `DEPRECATED`, `CLOSED`, `WITHDRAWN`, `REJECTED`
 * or `ARCHIVED` renders a banner above the body naming the replacement and the date it stopped
 * being in force. The body stays fully readable as history."*
 *
 * ## Which incoming relation counts as "the replacement", derived and not listed
 *
 * A relation names the replacement when its type **retires its target into the status this page
 * is actually in** — `retiresInto(type) === status`. So a `SUPERSEDED` page is explained by an
 * incoming `SUPERSEDES` and a `CLOSED` RFC by an incoming `DECIDES`, which is exactly §6.2's
 * inverse table, without this module holding a second copy of it.
 *
 * The two cases that derivation gets right and a list of "SUPERSEDES and DECIDES" would not:
 *
 * - **An incoming `AMENDS` is not a replacement.** An amendment modifies part of a document
 *   without replacing it (§6.2) and cascades nothing, so it cannot be why the page is retired.
 * - **A `DEPRECATED` ADR with an incoming `SUPERSEDES` names no replacement**, and that state is
 *   reachable: an ADR at `PROPOSED` may declare `supersedes:` before it is accepted (Task 6
 *   gates the cascade, not the relation), so the row can exist while the target was retired
 *   some other way. Nothing cascades into `DEPRECATED`, so the derivation declines to call that
 *   proposal a replacement — which is the truthful answer, because it never retired anything.
 *
 * A relation from a page that is not itself in force is still shown. An ADR at `PROPOSED` that
 * declares `supersedes:` an already-superseded page does say it supersedes it, and the reader
 * follows one link to see what state that page is in; hiding it would mean the banner
 * disagreeing with the relation the author published.
 *
 * ## The date, and why it is the replacement's publish date
 *
 * §6.4 asks for *"the date it stopped being in force"*, and **nothing in the schema records that
 * instant.** The three candidates and why two of them are wrong:
 *
 * - **The relation's `createdAt`** is wrong on the documented happy path. A relation row is
 *   written by the publish that *declares* it, which for an ADR is normally the `PROPOSED` one;
 *   the cascade fires later, on the publish that reaches `ACCEPTED`, and Task 7's `NOT` clause
 *   deliberately leaves the row's `createdAt` alone. So it dates the retirement to the day
 *   somebody first proposed it — weeks early, systematically, not in an edge case.
 * - **The retired page's own `publishedAt`** is wrong for exactly the pages a cascade retires.
 *   `applyCascade` writes the status and deliberately nothing else, so `publishedAt` still says
 *   when the page was last published *while it was in force* — the opposite of what the banner
 *   would be claiming. (It is right for a page an author retired by publishing it into a retired
 *   status, and that is where it stays: the meta row above the banner shows it, labelled
 *   "Published", which is what it is.)
 * - **The `page.cascade` audit row** is right for a cascade and absent for an author-retired
 *   page, so it needs a second source and a fallback; it would put the reader's hot path on the
 *   audit trail — the one table only `src/lib/audit/log.ts` may query, kept for compliance rather
 *   than for rendering — and would need JSON-detail matching to pick the row that produced the
 *   *current* status. If a phase ever wants a true retirement instant, the answer is a column
 *   written by the same statement that writes the status, not a query over the trail.
 *
 * **So the banner reports the date the replacement came into force, labelled as that** — the
 * replacement's `publishedAt`. For a cascade the two are the same instant by construction: the
 * cascade runs inside the replacement's own publish transaction, so on the day it happens this
 * date *is* the retirement date. It drifts only if the replacement is later republished, and the
 * label is what keeps that honest — "published 4 March" stays a true sentence about the
 * replacement, where "retired 4 March" would have become a false one about this page.
 *
 * Reported as drift rather than quietly satisfied: §6.4 asks for one date and this delivers the
 * nearest fact the schema holds, rather than a number that is wrong in one of the two ways a
 * page gets retired.
 *
 * ## A page retired with no incoming relation shows no date at all
 *
 * Reachable three ways, so it is a first-class branch and not a fallback: an author publishing a
 * page into a retired status directly, an `ARCHIVED` doc or runbook (neither may declare a
 * relation that retires anything), and a page whose superseding ADR later dropped the
 * `supersedes:` key — removal deletes the row and deliberately does not un-retire the target.
 *
 * That branch names no replacement and shows no date, because the only date to hand is the
 * page's own `publishedAt`, and it means the retirement instant for the first case and something
 * else entirely for the third. The two are indistinguishable without the audit trail, so the
 * banner says what it knows: the page is history, and nothing here names a replacement.
 */

/** §6.2's "Inverse shown as" column, which is the banner's and the incoming list's wording. */
const INVERSE_LABEL: Record<RelationType, string> = {
  SUPERSEDES: "Superseded by",
  DECIDES: "Decided by",
  AMENDS: "Amended by",
  RELATES_TO: "Related",
};

/** The forward reading of the same row, for "what does this page supersede". */
const FORWARD_LABEL: Record<RelationType, string> = {
  SUPERSEDES: "Supersedes",
  DECIDES: "Decides",
  AMENDS: "Amends",
  RELATES_TO: "Related",
};

export const inverseLabel = (type: RelationType): string => INVERSE_LABEL[type];
export const forwardLabel = (type: RelationType): string => FORWARD_LABEL[type];

/**
 * How the banner opens, per status. A sentence rather than the enum name, because the enum name
 * is already in the meta row and in the page-info card and neither of those has to read as
 * English.
 *
 * `Record<DocStatus, …>` covers every status and not only the retired six, so adding a status to
 * the enum fails to compile rather than rendering a page whose banner has no words. The
 * in-force entries are unreachable through `retirementNotice` and say so.
 */
const RETIRED_LEAD: Record<DocStatus, string> = {
  SUPERSEDED: "This document has been superseded.",
  DEPRECATED: "This document is deprecated.",
  CLOSED: "This proposal is closed.",
  WITHDRAWN: "This proposal was withdrawn.",
  REJECTED: "This document was rejected.",
  ARCHIVED: "This document is archived.",
  // Not retired: `isRetired` refuses these before the lead is ever read.
  DRAFT: "",
  IN_REVIEW: "",
  PROPOSED: "",
  ACCEPTED: "",
  CURRENT: "",
  NEEDS_REVIEW: "",
};

/** A page on the other end of a relation, as the reader needs it. */
export type RelatedPage = {
  id: string;
  spaceKey: string;
  path: string;
  title: string;
  status: DocStatus;
  publishedAt: Date | null;
  /**
   * Whether it can be linked at all. `getPublishedPage` requires a published version, so a
   * relation to a page that has never been published would be a link that 404s for everyone —
   * the same reason the nav rail and the breadcrumbs render unpublished pages as inert text.
   * Stated here as a field rather than re-derived in the component, because this is the third
   * link site to need the rule and the previous two each grew their own copy of it.
   */
  isLinkable: boolean;
};

export type PageRelation = { type: RelationType; page: RelatedPage };

/** What the banner renders. `null` means the page is in force and there is no banner. */
export type RetirementNotice = {
  status: DocStatus;
  /** The opening sentence, already in English. */
  lead: string;
  /**
   * The pages that retired this one, in the order the read returned them. Empty is a normal
   * outcome, not a failure — see "A page retired with no incoming relation", above.
   */
  replacements: PageRelation[];
};

/**
 * The relation types that could have retired a page into `status` — the derivation above, stated
 * **once**, here.
 *
 * It is what the inverse read filters on (`@@index([toId, type])` exists for that query), and it
 * is deliberately not re-applied to the rows that come back: a rule written on the query and
 * again on the result is the `resolveRedirect` mistake this project has recorded twice — mutating
 * away either copy leaves the suite green. So this function is unit-tested directly, and the
 * integration tests prove the query obeys it.
 *
 * Empty for every status nothing cascades into, which includes every status a document is in
 * force in — so `getPageRelations` skips the inverse query outright for a live page rather than
 * issuing one that can only return nothing.
 */
export function retiringTypes(status: DocStatus): RelationType[] {
  return (Object.keys(INVERSE_LABEL) as RelationType[]).filter(
    (type) => retiresInto(type) === status,
  );
}

/**
 * The banner for this page, or `null` if it is in force.
 *
 * `replacements` is what `retiringTypes` already selected — the relations that retired this page.
 * This function decides only whether there is a banner at all and what it opens with; it does not
 * re-filter, for the reason `retiringTypes` gives.
 */
export function retirementNotice(args: {
  status: DocStatus;
  replacements: readonly PageRelation[];
}): RetirementNotice | null {
  const { status } = args;
  if (!isRetired(status)) return null;

  return { status, lead: RETIRED_LEAD[status], replacements: [...args.replacements] };
}
