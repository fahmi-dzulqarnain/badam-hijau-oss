import { expect, test } from "vitest";
import type { DocStatus, RelationType } from "@prisma/client";
import { RETIRED_STATUSES, isRetired, publishableStatuses } from "@/lib/pages/transition";
import { retiresInto } from "@/lib/lifecycle/relations";
import {
  forwardLabel,
  inverseLabel,
  retirementNotice,
  retiringTypes,
  type PageRelation,
} from "@/lib/lifecycle/retired";

const RELATION_TYPES: RelationType[] = ["SUPERSEDES", "DECIDES", "AMENDS", "RELATES_TO"];

const IN_FORCE: DocStatus[] = [
  "DRAFT",
  "PROPOSED",
  "ACCEPTED",
  "IN_REVIEW",
  "CURRENT",
  "NEEDS_REVIEW",
];

const relation = (type: RelationType, title = "ADR-0032 MQTT contracts"): PageRelation => ({
  type,
  page: {
    id: "p-32",
    spaceKey: "engineering",
    path: "decisions/adr-0032-mqtt-contracts",
    title,
    status: "ACCEPTED",
    publishedAt: new Date("2026-03-04T09:00:00Z"),
    isLinkable: true,
  },
});

/* -------------------------------------------------------------------------- */
/* Which relation explains a retirement                                       */
/* -------------------------------------------------------------------------- */

test("a SUPERSEDED page is explained by SUPERSEDES, and a CLOSED one by DECIDES", () => {
  expect(retiringTypes("SUPERSEDED")).toEqual(["SUPERSEDES"]);
  expect(retiringTypes("CLOSED")).toEqual(["DECIDES"]);
});

/**
 * The derivation's whole value: these four statuses are retired and **no** relation type
 * cascades into them, so no incoming relation can be called the replacement. A list of
 * "SUPERSEDES and DECIDES" would have named a proposal that never retired anything.
 *
 * `DEPRECATED` with an incoming `SUPERSEDES` is reachable, which is why it matters: an ADR at
 * `PROPOSED` may declare `supersedes:` before it is accepted (Task 6 gates the cascade, not the
 * relation), so the row can exist over a page that was retired some other way.
 */
test("nothing retires a page into DEPRECATED, REJECTED, WITHDRAWN or ARCHIVED", () => {
  for (const status of ["DEPRECATED", "REJECTED", "WITHDRAWN", "ARCHIVED"] as DocStatus[]) {
    expect(isRetired(status), `${status} should still get a banner`).toBe(true);
    expect(retiringTypes(status), `${status} has no cascading relation type`).toEqual([]);
  }
});

test("a status a document is in force in has no retiring relation type", () => {
  // Which is what lets the read skip the inverse query entirely on the hot path.
  for (const status of IN_FORCE) expect(retiringTypes(status)).toEqual([]);
});

/**
 * The property behind the two tables, asserted rather than restated: `retiringTypes` is exactly
 * the inverse of `retiresInto`. Kills a version that hardcoded the two cascading types — a fifth
 * relation type would then be missing from the banner with nothing failing.
 */
test("retiringTypes is the inverse of retiresInto, over every type and status", () => {
  const statuses = [...new Set([...IN_FORCE, ...publishableStatuses("ADR"), ...publishableStatuses("RFC"), ...publishableStatuses("DOC")])];
  for (const status of statuses) {
    const expected = RELATION_TYPES.filter((type) => retiresInto(type) === status);
    expect(retiringTypes(status), status).toEqual(expected);
  }
  // Not vacuous: the two types that cascade nothing appear in no status's list at all.
  for (const type of ["AMENDS", "RELATES_TO"] as RelationType[]) {
    expect(retiresInto(type)).toBeNull();
    for (const status of statuses) expect(retiringTypes(status)).not.toContain(type);
  }
});

/* -------------------------------------------------------------------------- */
/* The notice                                                                 */
/* -------------------------------------------------------------------------- */

test("a page in force gets no banner, whatever points at it", () => {
  for (const status of IN_FORCE) {
    expect(
      retirementNotice({ status, replacements: [relation("SUPERSEDES")] }),
      `${status} must not render a retired banner`,
    ).toBeNull();
  }
});

test("every retired status gets a banner with a sentence in it", () => {
  for (const status of RETIRED_STATUSES) {
    const notice = retirementNotice({ status, replacements: [] });
    expect(notice, status).not.toBeNull();
    // A status added to `RETIRED_STATUSES` with no lead would render a banner with no words.
    expect(notice?.lead.length, `${status} has no lead sentence`).toBeGreaterThan(0);
    expect(notice?.status).toBe(status);
  }
});

test("a retired page with nothing pointing at it names no replacement", () => {
  // Reachable three ways — an author retiring the page directly, an ARCHIVED doc, and a
  // replacement that dropped its `supersedes:` key without un-retiring this page. All three
  // arrive here, and the banner is expected to render.
  const notice = retirementNotice({ status: "ARCHIVED", replacements: [] });
  expect(notice?.replacements).toEqual([]);
  expect(notice?.lead).toMatch(/archived/i);
});

test("the replacements are passed through, not re-filtered", () => {
  // The type filter lives on the query, once (`retiringTypes`). Restating it here is the
  // `resolveRedirect` mistake: two copies and neither testable. So a caller handing this an
  // AMENDS row gets it back — and the integration test is what proves the query never does.
  const rows = [relation("SUPERSEDES"), relation("AMENDS", "ADR-0033 Retention")];
  expect(retirementNotice({ status: "SUPERSEDED", replacements: rows })?.replacements).toEqual(
    rows,
  );
});

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** Spec §6.2's "Inverse shown as" column, transcribed once. */
test("the inverse labels are spec §6.2's", () => {
  expect(inverseLabel("SUPERSEDES")).toBe("Superseded by");
  expect(inverseLabel("DECIDES")).toBe("Decided by");
  expect(inverseLabel("AMENDS")).toBe("Amended by");
  expect(inverseLabel("RELATES_TO")).toBe("Related");
});

test("every relation type reads differently in each direction, except the non-directional one", () => {
  for (const type of RELATION_TYPES) {
    expect(forwardLabel(type).length).toBeGreaterThan(0);
    expect(inverseLabel(type).length).toBeGreaterThan(0);
  }
  // `RELATES_TO` is non-directional (§6.2), so one word serves both; the other three must not
  // read the same in both directions, or the banner would say "Supersedes" on the page that was
  // superseded.
  expect(forwardLabel("RELATES_TO")).toBe(inverseLabel("RELATES_TO"));
  for (const type of ["SUPERSEDES", "DECIDES", "AMENDS"] as RelationType[]) {
    expect(forwardLabel(type)).not.toBe(inverseLabel(type));
  }
});
