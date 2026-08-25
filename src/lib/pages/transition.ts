import type { DocStatus, DocType } from "@prisma/client";

/**
 * The status transition rule, as a table.
 *
 * Pure: plain values in, plain values out. The two Prisma imports are `import type` and are
 * erased at compile time, so nothing here loads a database client — but they are not
 * decoration either. `Record<DocType, …>` fails to compile when a doc type is added without
 * a vocabulary, which is exactly the mistake Phase 3 is about to be in a position to make.
 *
 * **Phase 2 deliberately implements only what it enforces**, per spec §6.1: a page may
 * publish into its type's vocabulary, and a page already in that vocabulary may not fall
 * back out of it. Phase 3 owns the rest of the lifecycle — the frontmatter that *requests* a
 * status, and the cascades that a transition fires (§6.3). It extends `PUBLISHABLE_INTO`
 * below rather than rewriting `publishPage`, which is the whole reason this is a table.
 */

/**
 * `DRAFT` is where a page sits until its first publish, whatever its doc type — spec §6.1:
 * *"`DRAFT` is therefore legal as an origin state for every type and as a destination for
 * none."* It appears as a key in every row below and in no row's value, and
 * `draftIsNeverADestination` in the tests pins that property over the whole table rather
 * than over the two rows someone remembered to check.
 */
export const UNPUBLISHED: DocStatus = "DRAFT";

/**
 * Where a first publish lands, per doc type. Spec §6.1 gives these as the head of each
 * vocabulary: *"an ADR to `PROPOSED` or `ACCEPTED`, a runbook to `CURRENT`."*
 *
 * `RFC` is the one that needs an argument. Its vocabulary begins `DRAFT → IN_REVIEW`, and
 * that `DRAFT` is the same `DRAFT` every unpublished page already sits at — so taking it as
 * the entry state would make the first publish of an RFC a transition into the state the
 * spec says is a destination for none, and would leave a published RFC indistinguishable
 * from one that has never been published. `IN_REVIEW` is the first state an RFC can be
 * *in* once it is readable, so that is where publishing puts it.
 */
export const FIRST_PUBLISH: Record<DocType, DocStatus> = {
  DOC: "CURRENT",
  RUNBOOK: "CURRENT",
  ADR: "PROPOSED",
  RFC: "IN_REVIEW",
};

/**
 * Legal publish destinations, keyed by doc type and then by the status the page is in now.
 *
 * Every row lists its own status as a legal destination, because **republishing is the
 * common case**: an editor fixing a typo in a `CURRENT` runbook publishes it again and it
 * stays `CURRENT`. Omitting the self-transition would make the second publish of every page
 * an illegal one.
 *
 * An origin absent from a row is a page whose lifecycle has ended for publishing purposes —
 * a `SUPERSEDED` ADR, a `CLOSED` RFC. Those are still editable (spec §6.4 keeps a retired
 * document readable and annotatable) but they are not published *forward* into anything, and
 * an absent key is refused by `validateTransition` with a sentence rather than by an
 * exception.
 */
const PUBLISHABLE_INTO: Record<
  DocType,
  Partial<Record<DocStatus, readonly DocStatus[]>>
> = {
  // Spec §6.1: `CURRENT` → `NEEDS_REVIEW` → `ARCHIVED`.
  DOC: {
    DRAFT: ["CURRENT"],
    CURRENT: ["CURRENT", "NEEDS_REVIEW", "ARCHIVED"],
    NEEDS_REVIEW: ["NEEDS_REVIEW", "CURRENT", "ARCHIVED"],
    ARCHIVED: ["ARCHIVED", "CURRENT"],
  },
  RUNBOOK: {
    DRAFT: ["CURRENT"],
    CURRENT: ["CURRENT", "NEEDS_REVIEW", "ARCHIVED"],
    NEEDS_REVIEW: ["NEEDS_REVIEW", "CURRENT", "ARCHIVED"],
    ARCHIVED: ["ARCHIVED", "CURRENT"],
  },
  // Spec §6.1: `PROPOSED` → `ACCEPTED` → `SUPERSEDED` / `DEPRECATED`; or `REJECTED`.
  //
  // `ACCEPTED` does NOT list `PROPOSED`, and that omission is the rule this task was asked
  // to enforce: a decision that has been accepted does not quietly become a proposal again,
  // and it never becomes a `DRAFT` — which no row anywhere allows.
  ADR: {
    DRAFT: ["PROPOSED", "ACCEPTED"],
    PROPOSED: ["PROPOSED", "ACCEPTED", "REJECTED"],
    ACCEPTED: ["ACCEPTED", "SUPERSEDED", "DEPRECATED"],
  },
  // Spec §6.1: `DRAFT` → `IN_REVIEW` → `ACCEPTED` → `CLOSED`; or `WITHDRAWN` / `REJECTED`.
  RFC: {
    DRAFT: ["IN_REVIEW"],
    IN_REVIEW: ["IN_REVIEW", "ACCEPTED", "WITHDRAWN", "REJECTED"],
    ACCEPTED: ["ACCEPTED", "CLOSED"],
  },
};

/**
 * Where a publish lands when nothing asked for a particular status — which in Phase 2 is
 * every publish, because the frontmatter that carries a requested status is Phase 3's.
 *
 * A first publish enters the type's vocabulary; a republish stays where it is. Both are the
 * answer the editor expects from a button labelled "Publish", and neither is a silent
 * lifecycle change.
 */
export function defaultPublishStatus(docType: DocType, from: DocStatus): DocStatus {
  return from === UNPUBLISHED ? FIRST_PUBLISH[docType] : from;
}

/**
 * Every status a page of this type may be **published into**: the union of every destination
 * in its row, deduped, in the order the table first mentions them — which comes out
 * lifecycle-ordered, because the table is written in lifecycle order.
 *
 * Derived from `PUBLISHABLE_INTO` rather than written out a second time, and that is the whole
 * point of it existing. Spec §6.3 — *"status is never maintained by hand in two places"* — is
 * about the data, but the same argument applies to the vocabulary itself: a list of statuses
 * typed out beside the table is a second source of truth that can disagree with it silently.
 * Two callers need this list and neither may grow its own copy:
 *
 * - **Phase 3 Task 3**, to decide whether a frontmatter `status:` key names something this
 *   doc type could ever be published into.
 * - **Phase 3 Task 10**, whose generated ADR and RFC indexes filter by status.
 *
 * `DRAFT` is in no row's value, so it appears in no vocabulary — which is exactly right for
 * this question. Spec §6.1 makes `DRAFT` an origin for every type and a destination for none,
 * so a page cannot be published *into* it and frontmatter cannot ask for it.
 */
export function publishableStatuses(docType: DocType): readonly DocStatus[] {
  const statuses: DocStatus[] = [];
  for (const destinations of Object.values(PUBLISHABLE_INTO[docType])) {
    for (const status of destinations ?? []) {
      if (!statuses.includes(status)) statuses.push(status);
    }
  }
  return statuses;
}

/**
 * The statuses a page of this type can be published **into** and never **out of** — the
 * absorbing states of its vocabulary.
 *
 * Derived from `PUBLISHABLE_INTO`, like `publishableStatuses` and for the same reason: it is a
 * property of the table, and a list typed out beside it is a second source of truth that agrees
 * on the day it is written. A status is terminal when it appears as somebody's destination and
 * has no row of its own — which is exactly how `validateTransition` already treats it, refusing
 * every publish with *"cannot be published into another status"*.
 *
 * It comes out empty for `DOC` and `RUNBOOK` and non-empty for `ADR` and `RFC`, and that split
 * is the answer to a question the vocabulary is otherwise silent on: **which doc types hold
 * records rather than living pages.** A doc and a runbook always have a way back to `CURRENT`,
 * so they are edited in place; an ADR that has been superseded, deprecated or rejected, and an
 * RFC that has been closed, withdrawn or rejected, are finished — the document stays readable
 * as history (§6.4) and the only way to change what it says is to publish another document that
 * says so.
 *
 * Which is why `src/lib/lifecycle/relations.ts` uses it to decide who may declare `amends:`,
 * asserted there as an equivalence rather than as a row. Nothing else needs it yet; when
 * something wants "is this document final", this is the question to ask rather than a list of
 * status names to match against.
 */
export function terminalStatuses(docType: DocType): readonly DocStatus[] {
  const row = PUBLISHABLE_INTO[docType];
  return publishableStatuses(docType).filter((status) => row[status] === undefined);
}

export type TransitionErrorCode = "draft-is-not-a-destination" | "illegal-transition";

/** Attached to a field so the caller renders it in place, never thrown. */
export type TransitionError = {
  field: "status";
  code: TransitionErrorCode;
  message: string;
};

export type TransitionResult =
  | { ok: true; status: DocStatus }
  | { ok: false; error: TransitionError };

/**
 * Whether a publish may move a page of `docType` from `from` to `to`.
 *
 * The `DRAFT` destination is refused by its own branch rather than by falling out of the
 * table. It falls out of the table too — `DRAFT` is in no row's value — but a page reverting
 * to `DRAFT` is the one transition that would make a published page vanish from the reader
 * while leaving `publishedVersionId` set, so it earns a sentence that says that rather than
 * the generic one.
 */
export function validateTransition(args: {
  docType: DocType;
  from: DocStatus;
  to: DocStatus;
}): TransitionResult {
  const { docType, from, to } = args;

  if (to === UNPUBLISHED) {
    return {
      ok: false,
      error: {
        field: "status",
        code: "draft-is-not-a-destination",
        message:
          "Publishing cannot return a page to Draft. Delete the page, or move it to a " +
          "retired status such as Archived.",
      },
    };
  }

  const allowed = PUBLISHABLE_INTO[docType][from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: {
        field: "status",
        code: "illegal-transition",
        message:
          allowed.length === 0
            ? `A ${docType} at ${from} cannot be published into another status.`
            : `A ${docType} at ${from} can only be published into ${allowed.join(", ")} — not ${to}.`,
      },
    };
  }

  return { ok: true, status: to };
}

/**
 * The whole table, exposed for the test that asserts a property *of the table* rather than
 * of the four or five rows anyone thinks to write a case for. Read-only by convention; the
 * tests do not mutate it and nothing else imports it.
 */
export const TRANSITION_TABLE = PUBLISHABLE_INTO;
