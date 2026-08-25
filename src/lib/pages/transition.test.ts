import { expect, test } from "vitest";
import type { DocStatus, DocType } from "@prisma/client";
import {
  FIRST_PUBLISH,
  RETIRED_STATUSES,
  TRANSITION_TABLE,
  UNPUBLISHED,
  defaultPublishStatus,
  isRetired,
  publishDestinations,
  publishableStatuses,
  terminalStatuses,
  validateTransition,
} from "@/lib/pages/transition";

const DOC_TYPES: DocType[] = ["DOC", "ADR", "RFC", "RUNBOOK"];

/** Narrows to the refusal, failing with the actual result if it is not one. */
function refused(result: ReturnType<typeof validateTransition>) {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.error;
}

test("a first publish enters the doc type's vocabulary and never stays at DRAFT", () => {
  for (const docType of DOC_TYPES) {
    const target = defaultPublishStatus(docType, "DRAFT");
    expect(target).not.toBe(UNPUBLISHED);
    expect(target).toBe(FIRST_PUBLISH[docType]);
    expect(validateTransition({ docType, from: "DRAFT", to: target }).ok).toBe(true);
  }
});

test("a doc or a runbook publishes into CURRENT", () => {
  expect(defaultPublishStatus("DOC", "DRAFT")).toBe("CURRENT");
  expect(defaultPublishStatus("RUNBOOK", "DRAFT")).toBe("CURRENT");
  expect(validateTransition({ docType: "DOC", from: "DRAFT", to: "CURRENT" })).toEqual({
    ok: true,
    status: "CURRENT",
  });
});

test("republishing keeps the status it already had, for every publishable origin", () => {
  // The self-transition is the common case — an editor fixing a typo — and a table that
  // omitted it would make the SECOND publish of every page an illegal one.
  for (const docType of DOC_TYPES) {
    for (const from of Object.keys(TRANSITION_TABLE[docType]) as DocStatus[]) {
      if (from === UNPUBLISHED) continue;
      expect(defaultPublishStatus(docType, from)).toBe(from);
      expect(validateTransition({ docType, from, to: from }).ok).toBe(true);
    }
  }
});

/**
 * The rule this task was asked for by name. Kills a table that lets `ACCEPTED` list
 * `PROPOSED` or `DRAFT` among its destinations, and kills a `validateTransition` that only
 * consults the destination and not the origin.
 */
test("an ACCEPTED ADR cannot be published back to DRAFT or to PROPOSED", () => {
  const toDraft = refused(
    validateTransition({ docType: "ADR", from: "ACCEPTED", to: "DRAFT" }),
  );
  expect(toDraft.code).toBe("draft-is-not-a-destination");
  expect(toDraft.field).toBe("status");
  expect(toDraft.message).toMatch(/cannot return a page to Draft/i);

  const toProposed = refused(
    validateTransition({ docType: "ADR", from: "ACCEPTED", to: "PROPOSED" }),
  );
  expect(toProposed.code).toBe("illegal-transition");
  // The sentence has to name the states, or the editor is told "no" and nothing else.
  expect(toProposed.message).toContain("ACCEPTED");
  expect(toProposed.message).toContain("PROPOSED");
});

/**
 * A property of the whole table, not of the rows someone remembered to check. Spec §6.1:
 * `DRAFT` is legal as an origin for every type and as a destination for none.
 */
test("DRAFT is an origin in every vocabulary and a destination in none", () => {
  for (const docType of DOC_TYPES) {
    const row = TRANSITION_TABLE[docType];
    expect(Object.keys(row)).toContain(UNPUBLISHED);
    for (const [from, destinations] of Object.entries(row)) {
      expect(destinations, `${docType} at ${from} lists DRAFT`).not.toContain(UNPUBLISHED);
      // And the refusal does not depend on the table being right about it.
      expect(
        validateTransition({ docType, from: from as DocStatus, to: "DRAFT" }).ok,
      ).toBe(false);
    }
  }
});

test("a status outside the doc type's vocabulary is refused, with both states named", () => {
  // `ARCHIVED` belongs to DOC and RUNBOOK; an ADR has no business there.
  const error = refused(
    validateTransition({ docType: "ADR", from: "PROPOSED", to: "ARCHIVED" }),
  );
  expect(error.code).toBe("illegal-transition");
  expect(error.message).toContain("PROPOSED");
  expect(error.message).toContain("ARCHIVED");
});

/**
 * Task 9 Step 0. This test replaces one that asserted the *stronger* rule — that a `SUPERSEDED`
 * ADR could not be published at all — which is what made §6.4's "remains editable so it can be
 * annotated" a promise the vocabulary broke. Both halves are here, because the whole point is
 * that only one of the two directions is now legal.
 */
test("a terminal status publishes into itself and into nothing else", () => {
  // Legal: an editor annotating a superseded decision — a note pointing at its replacement —
  // has somewhere to publish it. Without this row the draft could be typed and never landed.
  expect(validateTransition({ docType: "ADR", from: "SUPERSEDED", to: "SUPERSEDED" })).toEqual({
    ok: true,
    status: "SUPERSEDED",
  });
  // Illegal, and this is what keeps "terminal" meaning something: no page climbs back out of a
  // retirement into being in force again.
  const error = refused(
    validateTransition({ docType: "ADR", from: "SUPERSEDED", to: "ACCEPTED" }),
  );
  expect(error.code).toBe("illegal-transition");
  expect(error.message).toContain("SUPERSEDED");
  expect(error.message).toContain("ACCEPTED");

  // Every terminal status of every type, so this is a property of the table rather than of the
  // one row that was easy to write a case for.
  for (const docType of DOC_TYPES) {
    for (const from of terminalStatuses(docType)) {
      expect(validateTransition({ docType, from, to: from }).ok).toBe(true);
      for (const to of publishableStatuses(docType)) {
        if (to === from) continue;
        expect(
          validateTransition({ docType, from, to }).ok,
          `${docType}: ${from} → ${to} must stay illegal`,
        ).toBe(false);
      }
    }
  }
});

/**
 * The mutation this pins: adding the self-transition rows *without* re-deriving
 * `terminalStatuses`. The old derivation was "has no row of its own", and Step 0 gives every
 * terminal status a row — so the old reading returns nothing for ADR and RFC and
 * `frontmatterKeys` stops offering `amends` to either.
 *
 * Measured: that mutation makes `schema.test.ts`'s equivalence assertion pass **vacuously**,
 * both sides empty, and is caught only by the non-vacuity line beside it. This test is the one
 * that names the actual property, so the failure says what broke rather than which key went
 * missing three modules away.
 */
test("terminal statuses survive Step 0's self-transition rows", () => {
  expect(terminalStatuses("ADR")).toEqual(["REJECTED", "SUPERSEDED", "DEPRECATED"]);
  expect(terminalStatuses("RFC")).toEqual(["WITHDRAWN", "REJECTED", "CLOSED"]);
  // Unchanged, and the contrast is the point: `ARCHIVED` publishes back into `CURRENT`, so a
  // doc and a runbook are living pages with no terminal status at all.
  expect(terminalStatuses("DOC")).toEqual([]);
  expect(terminalStatuses("RUNBOOK")).toEqual([]);
});

/**
 * Spec §6.4's list, transcribed once — the same treatment `publishableStatuses` gets against
 * §6.1, and for the same reason: this is the one place the spec's own sentence is written out.
 */
test("the retired statuses are exactly spec §6.4's six", () => {
  expect([...RETIRED_STATUSES].sort()).toEqual(
    ["ARCHIVED", "CLOSED", "DEPRECATED", "REJECTED", "SUPERSEDED", "WITHDRAWN"].sort(),
  );
  for (const status of RETIRED_STATUSES) expect(isRetired(status)).toBe(true);
  // Not vacuous: the statuses a document is in force in are not retired.
  for (const status of ["DRAFT", "PROPOSED", "ACCEPTED", "IN_REVIEW", "CURRENT", "NEEDS_REVIEW"] as DocStatus[]) {
    expect(isRetired(status)).toBe(false);
  }
});

/**
 * The derivable half of the rule above, and the half that would otherwise rot: a vocabulary
 * change that adds a way to retire a document must not leave the banner behind. `ARCHIVED` is
 * the one member with no terminal status behind it, which is why the implication runs this way
 * and not as an equality.
 */
test("every terminal status is a retired status", () => {
  for (const docType of DOC_TYPES) {
    for (const status of terminalStatuses(docType)) {
      expect(isRetired(status), `${docType}'s ${status} would get no banner`).toBe(true);
    }
  }
  // And `ARCHIVED` is retired without being terminal, which is what stops this test from being
  // mistaken for the definition.
  expect(isRetired("ARCHIVED")).toBe(true);
  expect(terminalStatuses("DOC")).not.toContain("ARCHIVED");
});

test("an RFC's first publish is IN_REVIEW, not the DRAFT its vocabulary starts at", () => {
  // Spec §6.1 writes the RFC vocabulary as `DRAFT → IN_REVIEW → …`, and that leading DRAFT
  // is the same DRAFT every unpublished page sits at. Taking it literally would publish an
  // RFC into the one status that means "never published".
  expect(FIRST_PUBLISH.RFC).toBe("IN_REVIEW");
  expect(validateTransition({ docType: "RFC", from: "DRAFT", to: "IN_REVIEW" }).ok).toBe(
    true,
  );
  expect(validateTransition({ docType: "RFC", from: "DRAFT", to: "ACCEPTED" }).ok).toBe(
    false,
  );
});

test("the derived vocabulary is exactly spec §6.1's, per doc type", () => {
  // Written out here rather than derived, deliberately: this is the one place the spec's own
  // table is transcribed, so a change to `PUBLISHABLE_INTO` has to be a change to the spec's
  // reading too. Everything else — Phase 3's frontmatter schema, Task 10's status filter —
  // derives from `publishableStatuses` so no third copy can drift.
  expect(publishableStatuses("ADR")).toEqual([
    "PROPOSED",
    "ACCEPTED",
    "REJECTED",
    "SUPERSEDED",
    "DEPRECATED",
  ]);
  expect(publishableStatuses("RFC")).toEqual([
    "IN_REVIEW",
    "ACCEPTED",
    "WITHDRAWN",
    "REJECTED",
    "CLOSED",
  ]);
  for (const docType of ["DOC", "RUNBOOK"] as const) {
    expect(publishableStatuses(docType)).toEqual(["CURRENT", "NEEDS_REVIEW", "ARCHIVED"]);
  }
});

test("the derived vocabulary agrees with validateTransition, and excludes DRAFT", () => {
  for (const docType of DOC_TYPES) {
    const vocabulary = publishableStatuses(docType);
    expect(vocabulary).not.toContain(UNPUBLISHED);
    expect(vocabulary.length).toBeGreaterThan(0);

    // The property that makes it safe for a caller to treat this as "the legal statuses":
    // every member is reachable from somewhere, and nothing outside it is reachable at all.
    for (const status of vocabulary) {
      const origins = Object.keys(TRANSITION_TABLE[docType]) as DocStatus[];
      expect(
        origins.some((from) => validateTransition({ docType, from, to: status }).ok),
      ).toBe(true);
    }
    for (const [from, destinations] of Object.entries(TRANSITION_TABLE[docType])) {
      for (const to of destinations ?? []) {
        expect(vocabulary, `${docType} ${from} → ${to}`).toContain(to);
      }
    }
  }
});

/**
 * Task 11's status picker offers `publishDestinations`, so the property that matters is that the
 * menu and the refusal cannot disagree: **every** offered status publishes, and every status the
 * table does not offer is refused.
 *
 * Asserted over the whole table rather than over the ADR row someone thought to check, and in
 * both directions. Kills a picker fed `publishableStatuses` — the whole vocabulary — which offers
 * an `ACCEPTED` ADR a `PROPOSED` it will be refused for; kills one that returns the enum; and
 * kills one that drops the self-transition, which is the common case of republishing a typo fix.
 */
test("every status the picker offers is publishable, and every one it withholds is refused", () => {
  for (const docType of DOC_TYPES) {
    const everyStatus = publishableStatuses(docType);
    for (const from of Object.keys(TRANSITION_TABLE[docType]) as DocStatus[]) {
      const offered = publishDestinations(docType, from);

      for (const to of offered) {
        expect(validateTransition({ docType, from, to }), `${docType} ${from} → ${to}`).toEqual({
          ok: true,
          status: to,
        });
      }
      for (const to of everyStatus) {
        if (offered.includes(to)) continue;
        expect(
          validateTransition({ docType, from, to }).ok,
          `${docType} ${from} → ${to} is offered and refused`,
        ).toBe(false);
      }

      // Non-vacuity, the companion this project has learned to write beside every "for every
      // member" assertion: a `publishDestinations` returning `[]` satisfies both loops above.
      // Every publishable origin can at least republish itself.
      if (from !== UNPUBLISHED) expect(offered).toContain(from);
      expect(offered.length).toBeGreaterThan(0);
    }
  }
});

test("the picker never offers DRAFT, from any status of any doc type", () => {
  for (const docType of DOC_TYPES) {
    for (const from of Object.keys(TRANSITION_TABLE[docType]) as DocStatus[]) {
      expect(publishDestinations(docType, from)).not.toContain(UNPUBLISHED);
    }
  }
});

test("a status with no row is an empty menu, not a throw", () => {
  // `DOC` has no `PROPOSED` row. A cascade cannot produce that combination today, but a picker
  // that threw here would take the whole editor down rather than offering nothing.
  expect(publishDestinations("DOC", "PROPOSED")).toEqual([]);
});

test("every doc type has a vocabulary and a first-publish status", () => {
  // Not ceremony: the table is a `Record<DocType, …>`, so this fails at compile time when a
  // doc type is added — and this test fails loudly if the new row is added empty.
  for (const docType of DOC_TYPES) {
    expect(Object.keys(TRANSITION_TABLE[docType]).length).toBeGreaterThan(0);
    expect(FIRST_PUBLISH[docType]).toBeDefined();
  }
});
