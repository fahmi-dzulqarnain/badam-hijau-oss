import { expect, test } from "vitest";
import type { DocStatus, DocType } from "@prisma/client";
import {
  FIRST_PUBLISH,
  TRANSITION_TABLE,
  UNPUBLISHED,
  defaultPublishStatus,
  publishableStatuses,
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

test("a terminal status cannot be published forward, and says so", () => {
  // `SUPERSEDED` is a legal destination for an ADR and is not a key in its row: a superseded
  // decision stays readable and editable (spec §6.4) but is not published onward.
  const error = refused(
    validateTransition({ docType: "ADR", from: "SUPERSEDED", to: "ACCEPTED" }),
  );
  expect(error.code).toBe("illegal-transition");
  expect(error.message).toMatch(/cannot be published into another status/);
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

test("every doc type has a vocabulary and a first-publish status", () => {
  // Not ceremony: the table is a `Record<DocType, …>`, so this fails at compile time when a
  // doc type is added — and this test fails loudly if the new row is added empty.
  for (const docType of DOC_TYPES) {
    expect(Object.keys(TRANSITION_TABLE[docType]).length).toBeGreaterThan(0);
    expect(FIRST_PUBLISH[docType]).toBeDefined();
  }
});
