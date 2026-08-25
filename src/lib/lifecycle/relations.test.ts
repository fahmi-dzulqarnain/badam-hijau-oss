import { expect, test } from "vitest";
import type { DocStatus, DocType, RelationType } from "@prisma/client";
import { checkRelations, type RelationCheck, type RelationGuardClient } from "./relations";
import type { ResolvedRelation } from "./resolve";

/**
 * The guardrails that need no database — the doc-type rules and the cascade gate.
 *
 * The graph walk is the other half and lives in `tests/integration/relation-guardrails.test.ts`,
 * against a chain actually closed in Postgres. A cycle test that cannot loop is the shape this
 * project has already been caught by: Phase 1's tree-builder cycle tests could not detect a
 * cyclic result until they were mutation-tested.
 *
 * Every test here passes `noGraph`, so each one also asserts something the return value cannot
 * show: that no query was issued at all.
 */

/**
 * A client that fails the test if the graph is touched.
 *
 * Two properties ride on this, and neither is visible in a result object: an already-illegal
 * relation must not cost the publish transaction a round trip, and the three relation types that
 * cannot form a harmful loop must not be walked. `as unknown as` because a Prisma delegate is a
 * few dozen methods and this stub needs exactly one.
 */
const noGraph = {
  pageRelation: {
    findMany: () => {
      throw new Error("the relation graph must not be walked in this case");
    },
  },
} as unknown as RelationGuardClient;

/**
 * One resolved relation, as `resolveRelations` would hand it over.
 *
 * Every field defaults to something distinguishable — the id, the path and the ref are three
 * different strings — so an implementation that reported the wrong one cannot pass by
 * coincidence.
 */
function resolvedRelation(opts: {
  type: RelationType;
  docType: DocType;
  status?: DocStatus;
  ref?: string;
  id?: string;
}): ResolvedRelation {
  return {
    type: opts.type,
    ref: opts.ref ?? "decisions/adr-0030-topic-layout",
    page: {
      id: opts.id ?? "page-target",
      path: "decisions/adr-0030-topic-layout-moved",
      docType: opts.docType,
      status: opts.status ?? "ACCEPTED",
    },
  };
}

/** `checkRelations` with an ADR source that is publishing into `ACCEPTED`, unless overridden. */
function check(
  relations: ResolvedRelation[],
  source?: { docType?: DocType; publishingInto?: DocStatus },
): Promise<RelationCheck> {
  return checkRelations(noGraph, {
    source: {
      id: "page-source",
      docType: source?.docType ?? "ADR",
      publishingInto: source?.publishingInto ?? "ACCEPTED",
    },
    relations,
  });
}

/** Fails with the refusals rather than on a downstream `undefined`. */
function passed(result: RelationCheck) {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.relations;
}

function refusals(result: RelationCheck) {
  if (result.ok) throw new Error(`expected a refusal, passed: ${JSON.stringify(result)}`);
  return result.errors;
}

/** The single refusal for a one-problem input, failing if the module reported several. */
function theRefusal(result: RelationCheck) {
  const errors = refusals(result);
  expect(errors).toHaveLength(1);
  return errors[0]!;
}

const DOC_TYPES: readonly DocType[] = ["DOC", "RUNBOOK", "ADR", "RFC"];

// ---------------------------------------------------------------------------
// SUPERSEDES: the same doc type on both ends
// ---------------------------------------------------------------------------

test("SUPERSEDES at a page of another doc type is refused, and costs no query", async () => {
  // Reachable exactly as written: `RELATION_KEYS_BY_TYPE` stops a runbook *declaring*
  // `supersedes:`, and nothing there can stop an ADR pointing it at a runbook. This is that
  // half.
  const error = theRefusal(
    await check([resolvedRelation({ type: "SUPERSEDES", docType: "RUNBOOK" })]),
  );

  expect(error.code).toBe("not-same-doc-type");
  expect(error.key).toBe("supersedes");
  expect(error.type).toBe("SUPERSEDES");
  expect(error.field).toBe("markdown");
  expect(error.ref).toBe("decisions/adr-0030-topic-layout");
  expect(error.message).toContain("is a RUNBOOK and this page is an ADR");
  expect(error.message).toContain("`supersedes:` joins two pages of the same doc type");
  // Every refusal here says what to write instead; `related:` is the universal key.
  expect(error.message).toContain("Use `related:`");
});

test("SUPERSEDES is refused for every mismatched pair, in both directions", async () => {
  // The rule is a comparison, not a list of legal pairs, so it is asserted over the whole
  // product of doc types rather than over the two someone thought to write a case for.
  for (const sourceDocType of DOC_TYPES) {
    for (const targetDocType of DOC_TYPES) {
      // A matching pair is legal and goes on to the graph walk, which `noGraph` cannot serve;
      // it is covered in the integration file, against a real chain.
      if (sourceDocType === targetDocType) continue;
      const result = await check(
        [resolvedRelation({ type: "SUPERSEDES", docType: targetDocType })],
        { docType: sourceDocType },
      );
      expect(theRefusal(result).code).toBe("not-same-doc-type");
    }
  }
});

// ---------------------------------------------------------------------------
// AMENDS: the same rule, its own sentence, and the RFC
// ---------------------------------------------------------------------------

test("AMENDS across doc types is refused, with its own sentence", async () => {
  // The case the widening to the RFC buys: an RFC declaring `amends: <an ADR>` is a document
  // an author can really write, and this is what refuses it. Before the widening the rule
  // could only be exercised from a hand-built argument list.
  const error = theRefusal(
    await check([resolvedRelation({ type: "AMENDS", docType: "ADR" })], { docType: "RFC" }),
  );

  expect(error.code).toBe("not-same-doc-type");
  expect(error.key).toBe("amends");
  expect(error.message).toContain("is an ADR and this page is an RFC");
  expect(error.message).toContain("an amendment modifies a document of its own kind");
});

test("the AMENDS and SUPERSEDES refusals do not share a sentence", async () => {
  // Two guardrails, two reasons, two messages. They share a *kind* and an author fixing one is
  // doing something different from an author fixing the other: one is retiring a document, the
  // other is modifying one. A single templated sentence would be the tell that only one rule
  // was really written.
  const supersedes = theRefusal(
    await check([resolvedRelation({ type: "SUPERSEDES", docType: "RFC" })]),
  );
  const amends = theRefusal(
    await check([resolvedRelation({ type: "AMENDS", docType: "RFC" })]),
  );

  expect(supersedes.message).not.toEqual(amends.message);
  expect(supersedes.message).toContain("superseding retires the target");
  expect(amends.message).not.toContain("retires");
});

test("AMENDS between two pages of one type is legal, cascades nothing, and is not walked", async () => {
  // `noGraph` is the assertion: AMENDS fires no cascade, so a loop of amendments changes no
  // status and is a fair description of two documents that qualify one another. Walking it
  // would spend queries inside the publish transaction to answer a question with no
  // consequence.
  const relations = passed(
    await check([resolvedRelation({ type: "AMENDS", docType: "ADR" })]),
  );

  expect(relations).toHaveLength(1);
  expect(relations[0]?.cascade).toBeNull();
  // The resolved value is carried through untouched — this module judges, it does not rewrite.
  expect(relations[0]?.ref).toBe("decisions/adr-0030-topic-layout");
  expect(relations[0]?.page.id).toBe("page-target");
});

test("an RFC amending an RFC is legal", async () => {
  const relations = passed(
    await check([resolvedRelation({ type: "AMENDS", docType: "RFC" })], { docType: "RFC" }),
  );
  expect(relations[0]?.cascade).toBeNull();
});

// ---------------------------------------------------------------------------
// DECIDES: ADR → RFC, and only that
// ---------------------------------------------------------------------------

test("DECIDES from an ADR to an RFC is legal, cascades CLOSED, and is not walked", async () => {
  // Not walked, and that is derived rather than decided: a DECIDES cycle would need an RFC
  // that decides an ADR, which the rule below refuses — the loop is unrepresentable, not
  // unchecked.
  const relations = passed(
    await check([resolvedRelation({ type: "DECIDES", docType: "RFC" })]),
  );

  expect(relations[0]?.cascade).toBe("CLOSED");
});

test("DECIDES is refused at the wrong end, in either direction", async () => {
  // The source half and the target half of one guardrail. Both refusals, one code: which end
  // is wrong is in the sentence, and a second code would offer a distinction no author needs.
  const wrongTarget = theRefusal(
    await check([resolvedRelation({ type: "DECIDES", docType: "ADR" })]),
  );
  expect(wrongTarget.code).toBe("decides-needs-adr-to-rfc");
  expect(wrongTarget.key).toBe("decides");
  expect(wrongTarget.message).toContain("`decides:` is legal only from an ADR to an RFC");
  expect(wrongTarget.message).toContain("This page is an ADR and");

  // An RFC cannot declare `decides:` in frontmatter at all, so this arrives only through a
  // caller that is not the publish path — which is exactly why the rule is a comparison here
  // rather than an assumption about who called it.
  const wrongSource = theRefusal(
    await check([resolvedRelation({ type: "DECIDES", docType: "RFC" })], { docType: "RFC" }),
  );
  expect(wrongSource.code).toBe("decides-needs-adr-to-rfc");
  expect(wrongSource.message).toContain("This page is an RFC");
});

// ---------------------------------------------------------------------------
// RELATES_TO: constrains nothing, cascades nothing
// ---------------------------------------------------------------------------

test("RELATES_TO joins any two doc types and cascades nothing", async () => {
  // The escape hatch every other refusal points at. If this were constrained, those messages
  // would be advice that does not work.
  for (const sourceDocType of DOC_TYPES) {
    for (const targetDocType of DOC_TYPES) {
      const relations = passed(
        await check([resolvedRelation({ type: "RELATES_TO", docType: targetDocType })], {
          docType: sourceDocType,
        }),
      );
      expect(relations[0]?.cascade).toBeNull();
    }
  }
});

// ---------------------------------------------------------------------------
// The cascade gate: the status the page is being published INTO
// ---------------------------------------------------------------------------

test("a cascade does not fire when the publish does not reach ACCEPTED", async () => {
  // Spec §6.3: the source must reach ACCEPTED for a cascade to fire, so a draft cannot retire a
  // live decision. `PROPOSED` is not a hypothetical: it is where an ADR's first publish lands.
  for (const publishingInto of ["PROPOSED", "REJECTED", "DEPRECATED"] as DocStatus[]) {
    const relations = passed(
      await check([resolvedRelation({ type: "DECIDES", docType: "RFC" })], { publishingInto }),
    );
    expect(relations[0]?.cascade).toBeNull();
  }
});

test("the relation is still legal at PROPOSED — the cascade is gated, not the relation", async () => {
  // The argued half of the guardrail. An ADR's first publish lands at PROPOSED
  // (`FIRST_PUBLISH.ADR`), and a proposal that says which decision it would retire is the shape
  // a reviewer needs. Refusing it would mean adding `supersedes:` in a second edit at
  // acceptance time — the intent living in the author's head between two publishes, which is
  // the same objection §6.3 makes to maintaining status by hand in two places.
  const relations = passed(
    await check([resolvedRelation({ type: "DECIDES", docType: "RFC" })], {
      publishingInto: "PROPOSED",
    }),
  );

  expect(relations).toHaveLength(1);
  expect(relations[0]?.cascade).toBeNull();
});

test("the gate reads the destination status, not the target's own", async () => {
  // A target that is already ACCEPTED must not make the cascade fire while the source is only
  // PROPOSED. Two statuses in play and only one of them decides.
  const relations = passed(
    await check(
      [resolvedRelation({ type: "DECIDES", docType: "RFC", status: "ACCEPTED" })],
      { publishingInto: "PROPOSED" },
    ),
  );
  expect(relations[0]?.cascade).toBeNull();
});

// ---------------------------------------------------------------------------
// The error list
// ---------------------------------------------------------------------------

test("every illegal relation is reported, not only the first", async () => {
  const errors = refusals(
    await check([
      resolvedRelation({ type: "SUPERSEDES", docType: "DOC", ref: "handbook/joining" }),
      resolvedRelation({ type: "DECIDES", docType: "RUNBOOK", ref: "runbooks/paging" }),
      resolvedRelation({ type: "AMENDS", docType: "RFC", ref: "proposals/rfc-0004" }),
    ]),
  );

  expect(errors.map((e) => [e.key, e.code, e.ref])).toEqual([
    ["supersedes", "not-same-doc-type", "handbook/joining"],
    ["decides", "decides-needs-adr-to-rfc", "runbooks/paging"],
    ["amends", "not-same-doc-type", "proposals/rfc-0004"],
  ]);
});

test("legal and illegal relations in one call: the illegal one refuses the whole check", async () => {
  // No partial success. A publish that wrote three of four declared relations would leave the
  // frontmatter and the database disagreeing with no way to tell which is right.
  const result = await check([
    resolvedRelation({ type: "AMENDS", docType: "ADR" }),
    resolvedRelation({ type: "DECIDES", docType: "DOC", ref: "handbook/joining" }),
  ]);

  expect(result.ok).toBe(false);
  expect(refusals(result)).toHaveLength(1);
});

test("nothing declared passes with nothing in it", async () => {
  expect(await check([])).toEqual({ ok: true, relations: [] });
});
