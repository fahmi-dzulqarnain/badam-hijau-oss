import { expect, test } from "vitest";
import type { DocType } from "@prisma/client";
import {
  CLOSED_RFC_STATUSES,
  OPEN_RFC_STATUSES,
  SYSTEM_GROUPS,
  SYSTEM_GROUP_ORDER,
  isListedInGroup,
} from "@/lib/systems/groups";
import { RETIRED_STATUSES, publishableStatuses, terminalStatuses } from "@/lib/pages/transition";

/**
 * The pure half of `/systems/[key]`: which groups exist, and what "open RFCs" means.
 *
 * §7 says "open RFCs" in passing and never defines open, so the definition is a decision this
 * task takes — and a decision with no test is a habit.
 */

test("open RFCs are the ones §6.4 does not call retired, and the two halves partition the vocabulary", () => {
  const vocabulary = publishableStatuses("RFC");

  // The transcription: what the derivation actually comes out as today, so a change to it is
  // visible in a diff rather than only in a downstream list.
  expect([...OPEN_RFC_STATUSES]).toEqual(["IN_REVIEW", "ACCEPTED"]);
  expect([...CLOSED_RFC_STATUSES]).toEqual(["WITHDRAWN", "REJECTED", "CLOSED"]);
  // And they are `RETIRED_STATUSES`' own answer, not a second list that agrees with it today.
  for (const status of CLOSED_RFC_STATUSES) expect(RETIRED_STATUSES.has(status)).toBe(true);
  for (const status of OPEN_RFC_STATUSES) expect(RETIRED_STATUSES.has(status)).toBe(false);

  // The partition, which is the property the code depends on: every publishable RFC status is in
  // exactly one half, so no status can be silently absent from both the list and the excluded
  // count.
  expect([...OPEN_RFC_STATUSES, ...CLOSED_RFC_STATUSES].sort()).toEqual([...vocabulary].sort());
  for (const status of OPEN_RFC_STATUSES) expect(CLOSED_RFC_STATUSES).not.toContain(status);

  // The non-vacuity companion both halves need. An equivalence over two derived sets passes
  // hardest when both derivations break together — Phase 3 measured that exact failure on
  // `terminalStatuses` — so this line is what fails if the vocabulary is emptied.
  expect(OPEN_RFC_STATUSES.length).toBeGreaterThan(0);
  expect(CLOSED_RFC_STATUSES.length).toBeGreaterThan(0);
});

test("`isRetired` and `terminalStatuses` agree for RFC today, and the derivation is the first one", () => {
  // They coincide, which is why picking between them needs an argument rather than a measurement.
  expect([...CLOSED_RFC_STATUSES].sort()).toEqual([...terminalStatuses("RFC")].sort());

  // And here is where they come apart, in the vocabulary that has both: `ARCHIVED` is retired
  // (§6.4) and not terminal (a DOC publishes `ARCHIVED → CURRENT`). It is not in the RFC
  // vocabulary today, so the two agree by accident — this line is what makes the accident
  // visible, and it fails the day someone adds `ARCHIVED` to the RFC row without revisiting
  // `groups.ts`.
  expect(RETIRED_STATUSES.has("ARCHIVED")).toBe(true);
  expect(terminalStatuses("DOC")).not.toContain("ARCHIVED");
  expect(publishableStatuses("RFC")).not.toContain("ARCHIVED");
});

test("the RFC group's heading and blurb both say what is excluded", () => {
  const rfc = SYSTEM_GROUPS.RFC;
  expect(rfc.heading).toBe("Open RFCs");
  // Derived, not typed: every excluded status is named in the sentence a reader sees. A heading
  // that says "Open" over a list quietly hiding closed proposals is the same class of lie this
  // phase already refused twice, and this is the assertion that stops it becoming one when the
  // vocabulary grows.
  for (const status of CLOSED_RFC_STATUSES) expect(rfc.blurb).toContain(status);
  for (const status of OPEN_RFC_STATUSES) expect(rfc.blurb).toContain(status);
  expect(rfc.excluded).toEqual(CLOSED_RFC_STATUSES);
});

test("every doc type has a group, exactly once, and only RFC filters by status", () => {
  const keys = Object.keys(SYSTEM_GROUPS) as DocType[];
  // The order array and the record cannot drift: `Record<DocType, …>` makes the record total at
  // compile time, and this makes the array cover it at run time.
  expect([...SYSTEM_GROUP_ORDER].sort()).toEqual([...keys].sort());
  expect(SYSTEM_GROUP_ORDER.length).toBe(new Set(SYSTEM_GROUP_ORDER).size);
  // §7's own order, with the group §7 does not name last.
  expect([...SYSTEM_GROUP_ORDER]).toEqual(["ADR", "RUNBOOK", "RFC", "DOC"]);

  for (const docType of keys) {
    const group = SYSTEM_GROUPS[docType];
    if (docType === "RFC") expect(group.statuses).not.toBeNull();
    else expect(group.statuses).toBeNull();
    // A group with no status filter excludes nothing, and one with a filter names what it
    // excludes. Neither half is allowed to be empty by accident.
    expect(group.excluded.length === 0).toBe(group.statuses === null);
  }
});

test("`isListedInGroup` is the same rule the query filter is built from", () => {
  // An ADR stays in the list at every status, retired ones included — §6.4 keeps a superseded
  // decision readable, and a system's history is what the page is for.
  expect(isListedInGroup("ADR", "SUPERSEDED")).toBe(true);
  expect(isListedInGroup("ADR", "ACCEPTED")).toBe(true);
  expect(isListedInGroup("RUNBOOK", "ARCHIVED")).toBe(true);
  expect(isListedInGroup("DOC", "ARCHIVED")).toBe(true);

  // An RFC does not.
  expect(isListedInGroup("RFC", "IN_REVIEW")).toBe(true);
  expect(isListedInGroup("RFC", "ACCEPTED")).toBe(true);
  expect(isListedInGroup("RFC", "CLOSED")).toBe(false);
  expect(isListedInGroup("RFC", "WITHDRAWN")).toBe(false);
  expect(isListedInGroup("RFC", "REJECTED")).toBe(false);
});
