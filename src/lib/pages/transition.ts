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
 *
 * ## The terminal statuses have a row of their own, and it lists only themselves
 *
 * Phase 3 Task 9 Step 0, and it is a correction rather than an addition. The paragraph above
 * said a retired page is "still editable" — and Task 8 measured that it was not, in the only
 * sense that matters: §6.1 gave the terminal statuses **no onward transition at all**, so an
 * annotation on a `SUPERSEDED` ADR could be drafted and never published, and a draft that
 * cannot become a version is not an annotation. §6.4 promised the opposite in as many words.
 * Latent since Phase 2 and routine in Phase 3, because a cascade puts pages into those
 * statuses without anyone choosing to.
 *
 * **Resolved in the spec (§6.4's correction note): a terminal status may publish into itself.**
 * `SUPERSEDED → SUPERSEDED` is legal; `SUPERSEDED → ACCEPTED` is not. "Terminal" keeps its
 * meaning — no page climbs back out of a retirement — while an editor can publish a correction
 * or a pointer to the replacement.
 *
 * Two consequences that a self-transition row is easy to add without noticing:
 *
 * - **`terminalStatuses` can no longer mean "has no row".** It now means "has no destination
 *   but itself", which is the property it always intended; see its docstring. Getting that
 *   wrong empties it for `ADR` and `RFC` and takes the `amends` key table in
 *   `src/lib/lifecycle/schema.ts` with it — a vocabulary widening quietly narrowing a
 *   frontmatter schema. **Measured rather than assumed:** with the rows added and the old
 *   derivation kept, the equivalence test in `schema.test.ts` goes *vacuously* true — both
 *   sides of it become empty — and what fails is the non-vacuity line beside it, the one
 *   asserting an RFC may declare `amends`. That line exists for exactly this, and it is the
 *   reason "assert the equivalence" was not enough on its own.
 * - **It must not reopen Task 8's no-op skip.** `planCascades` skips a target already at the
 *   cascade status because that is a no-op and not a transition, which is what lets an ADR that
 *   has superseded another ever be republished. Now that `SUPERSEDED → SUPERSEDED` validates,
 *   that skip looks removable and is not: the skip is what keeps the cascade from writing a
 *   status change and an audit row for a change that did not happen. Its test stays green.
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
    // Terminal, and each publishes into itself and nothing else — §6.4's annotation, above.
    REJECTED: ["REJECTED"],
    SUPERSEDED: ["SUPERSEDED"],
    DEPRECATED: ["DEPRECATED"],
  },
  // Spec §6.1: `DRAFT` → `IN_REVIEW` → `ACCEPTED` → `CLOSED`; or `WITHDRAWN` / `REJECTED`.
  RFC: {
    DRAFT: ["IN_REVIEW"],
    IN_REVIEW: ["IN_REVIEW", "ACCEPTED", "WITHDRAWN", "REJECTED"],
    ACCEPTED: ["ACCEPTED", "CLOSED"],
    // Terminal, as above.
    WITHDRAWN: ["WITHDRAWN"],
    REJECTED: ["REJECTED"],
    CLOSED: ["CLOSED"],
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
 * **leads nowhere but back to itself**.
 *
 * That last clause is Task 9 Step 0's, and the wording it replaced — "has no row of its own" —
 * is why this needs saying. Until Step 0 the terminal statuses had no row at all, so the two
 * readings agreed; Step 0 gives each of them a row listing only itself, and the old reading
 * would have returned **nothing** for `ADR` and `RFC`. Nothing would have failed: the `amends`
 * key table in `src/lib/lifecycle/schema.ts` derives from this function, so ADRs and RFCs would
 * quietly have stopped being allowed to declare `amends:` — a frontmatter key removed by a
 * vocabulary widening, with the equivalence test still passing because both sides went empty.
 * The self-transition is not an onward transition, and this is where that has to be stated.
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
  return publishableStatuses(docType).filter((status) => {
    const onward = row[status];
    // No row at all, or a row whose only destination is the status itself. Both are "cannot be
    // published forward"; only the second is reachable after Step 0.
    return onward === undefined || onward.every((to) => to === status);
  });
}

/**
 * The statuses that make a document **history** — spec §6.4's list, and the input to Task 9's
 * retired banner.
 *
 * *"A page whose status is `SUPERSEDED`, `DEPRECATED`, `CLOSED`, `WITHDRAWN`, `REJECTED` or
 * `ARCHIVED` renders a banner above the body naming the replacement and the date it stopped
 * being in force."*
 *
 * **Transcribed from the spec rather than derived from the table, and that is a decision with
 * an argument** — because deriving is this project's default and the derivation does not exist.
 * Five of these six are exactly `terminalStatuses`. The sixth, `ARCHIVED`, is not terminal: a
 * `DOC` or a `RUNBOOK` publishes `ARCHIVED → CURRENT` and comes back. So no property of
 * `PUBLISHABLE_INTO` separates the six from the rest — being **retired** is a question about
 * whether the document is in force *now*, and being **terminal** is a question about whether it
 * can ever be in force again. §6.4 asks the first and the table only answers the second.
 *
 * The derivation that nearly worked is worth recording, because it looks right: "a status whose
 * every destination sits at or before it in `publishableStatuses`" yields precisely these six.
 * It was rejected because it makes the *order of the rows* load-bearing — `publishableStatuses`
 * is lifecycle-ordered by convention, as its docstring says, and a future editor reordering a
 * row for readability would silently change which pages get a banner. A transcription that a
 * test binds to the spec's own sentence fails loudly instead.
 *
 * Two tests hold it in place (`transition.test.ts`): one transcribes §6.4's six names, and one
 * asserts that **every** terminal status of every doc type is in here — so a vocabulary change
 * that adds a way to retire a document cannot leave the banner behind. That second test is the
 * derivable half, and it is the half that would otherwise rot.
 *
 * A `Set` rather than an array: every caller asks "is this one of them", and an array invites a
 * second membership helper beside it.
 */
export const RETIRED_STATUSES: ReadonlySet<DocStatus> = new Set<DocStatus>([
  "SUPERSEDED",
  "DEPRECATED",
  "CLOSED",
  "WITHDRAWN",
  "REJECTED",
  "ARCHIVED",
]);

/** Whether this page is history — spec §6.4. Pure, and the banner's only gate. */
export function isRetired(status: DocStatus): boolean {
  return RETIRED_STATUSES.has(status);
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
