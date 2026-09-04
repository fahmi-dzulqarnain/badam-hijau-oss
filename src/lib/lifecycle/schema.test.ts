import { expect, test } from "vitest";
import type { DocType, RelationType } from "@prisma/client";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { MAX_PATH_BYTES } from "@/lib/pages/slug";
import { publishableStatuses, terminalStatuses } from "@/lib/pages/transition";
import {
  KEY_FOR_RELATION,
  MAX_RELATION_TARGETS,
  frontmatterKeys,
  validateFrontmatter,
  type FrontmatterKeyError,
  type ValidatedFrontmatter,
} from "./schema";

const DOC_TYPES: DocType[] = ["DOC", "ADR", "RFC", "RUNBOOK"];

const NO_RELATIONS: Record<RelationType, string[]> = {
  SUPERSEDES: [],
  DECIDES: [],
  AMENDS: [],
  RELATES_TO: [],
};

/** Narrows to the accepted value, failing with the errors if it was refused. */
function accepted(
  docType: DocType,
  frontmatter: Record<string, unknown>,
): ValidatedFrontmatter {
  const result = validateFrontmatter({ docType, frontmatter });
  if (!result.ok) {
    throw new Error(`expected acceptance, got ${JSON.stringify(result.errors)}`);
  }
  return result.frontmatter;
}

/** Narrows to the refusal, failing with the accepted value if there was not one. */
function refused(
  docType: DocType,
  frontmatter: Record<string, unknown>,
): FrontmatterKeyError[] {
  const result = validateFrontmatter({ docType, frontmatter });
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.frontmatter)}`);
  }
  return result.errors;
}

/** The single refusal for a one-problem input, failing if the module reported several. */
function theRefusal(docType: DocType, frontmatter: Record<string, unknown>) {
  const errors = refused(docType, frontmatter);
  expect(errors).toHaveLength(1);
  return errors[0]!;
}

/** From document text, the way the publish path will compose the two halves. */
function validateDocument(docType: DocType, text: string) {
  const split = splitFrontmatter(text);
  if (!split.ok) throw new Error(`split failed: ${split.error.code}`);
  return validateFrontmatter({ docType, frontmatter: split.frontmatter });
}

// ---------------------------------------------------------------------------
// Unknown keys — the reason the schema is strict rather than permissive
// ---------------------------------------------------------------------------

test("a typo'd relation key is refused, not dropped, and the typo is named", () => {
  // The motivating case: one character. A permissive schema ignores this line and the author
  // believes ADR-0031 is retired for the rest of its life.
  const error = theRefusal("ADR", { supersedez: "decisions/adr-0031" });

  expect(error.code).toBe("unknown-key");
  expect(error.key).toBe("supersedez");
  expect(error.field).toBe("markdown");
  expect(error.message).toContain("`supersedez` is not a frontmatter key");
  expect(error.message).toContain("Did you mean `supersedes`?");
});

test("an unknown key is refused for every doc type, including ones with no relations", () => {
  for (const docType of DOC_TYPES) {
    const error = theRefusal(docType, { autor: "aisyah" });
    expect(error.code).toBe("unknown-key");
    expect(error.key).toBe("autor");
    // The message names what this type does accept, so the author does not have to guess.
    expect(error.message).toContain(frontmatterKeys(docType).join(", "));
  }
});

test("several unknown keys are all reported, not just the first", () => {
  const errors = refused("ADR", { supersedez: "a", ammends: "b", status: "ACCEPTED" });
  expect(errors.map((e) => e.key)).toEqual(["supersedez", "ammends"]);
});

test("a key with no near neighbour gets no suggestion", () => {
  const error = theRefusal("ADR", { owner: "platform-team" });
  expect(error.message).not.toContain("Did you mean");
});

test("a key with a null value is still refused", () => {
  // `supersedez:` with nothing after it parses to `null`. Treating a null value as "the author
  // declared nothing" would be right for a known key and catastrophic here: it is exactly the
  // shape a mistyped key in a template takes, and dropping it restores the silent loss.
  expect(theRefusal("ADR", { supersedez: null }).code).toBe("unknown-key");
});

// ---------------------------------------------------------------------------
// Per-doc-type keys, not one shared schema
// ---------------------------------------------------------------------------

test("a runbook declaring `decides:` is refused, and told which types may", () => {
  const error = theRefusal("RUNBOOK", { decides: "proposals/rfc-0004" });

  expect(error.code).toBe("key-not-for-doc-type");
  expect(error.key).toBe("decides");
  expect(error.message).toContain("not a key a RUNBOOK page can declare");
  expect(error.message).toContain("only ADR");
});

test("`supersedes` and `decides` are ADR-only; `status`, `systems`, `related` are universal", () => {
  for (const docType of DOC_TYPES) {
    const keys = frontmatterKeys(docType);
    expect(keys).toContain("status");
    expect(keys).toContain("systems");
    expect(keys).toContain("related");

    for (const adrOnly of ["supersedes", "decides"]) {
      expect(keys.includes(adrOnly)).toBe(docType === "ADR");
    }
  }
});

test("`amends` is accepted exactly where the vocabulary has a terminal status", () => {
  // Phase 3 Task 6's decision, asserted as the equivalence rather than as two rows. `amends`
  // is for a document that must not be rewritten in place — which is a document whose
  // vocabulary can put it somewhere it never publishes out of again. A DOC and a RUNBOOK
  // always have a way back to CURRENT, so they are edited instead, and their version history
  // is the amendment.
  //
  // Written this way so that a vocabulary change moves the key table with it: give a runbook a
  // terminal status and this fails until `RELATION_KEYS_BY_TYPE` follows.
  for (const docType of DOC_TYPES) {
    expect(frontmatterKeys(docType).includes("amends")).toBe(
      terminalStatuses(docType).length > 0,
    );
  }
  // Not vacuous in either direction: the equivalence would also hold if no type had `amends`
  // and none had a terminal status.
  expect(frontmatterKeys("RFC")).toContain("amends");
  expect(frontmatterKeys("RUNBOOK")).not.toContain("amends");
});

test("an RFC may declare `amends`, and a DOC may not", () => {
  // The reachable case the widening buys: an RFC amending an RFC validates here, and Task 6's
  // same-doc-type guardrail is what refuses an RFC amending an ADR. Before the widening the
  // guardrail could only be exercised from a hand-built argument list.
  expect(accepted("RFC", { amends: "proposals/rfc-0004" }).relations.AMENDS).toEqual([
    "proposals/rfc-0004",
  ]);

  const error = theRefusal("DOC", { amends: "handbook/onboarding" });
  expect(error.code).toBe("key-not-for-doc-type");
  expect(error.key).toBe("amends");
  expect(error.message).toContain("only ADR, RFC");
});

test("`supersedes` is accepted exactly where the vocabulary can reach SUPERSEDED", () => {
  // The table is not a preference. `supersedes: X` cascades X to SUPERSEDED (spec §6.3) and
  // SUPERSEDES is same-type only, so a type whose vocabulary has no SUPERSEDED could only ever
  // declare a cascade `PUBLISHABLE_INTO` forbids. Asserted as an equivalence rather than a row,
  // so a Phase 3 vocabulary change has to move the key table with it.
  for (const docType of DOC_TYPES) {
    expect(frontmatterKeys(docType).includes("supersedes")).toBe(
      publishableStatuses(docType).includes("SUPERSEDED"),
    );
  }
});

test("a doc type that cannot declare a relation reports it as empty, never absent", () => {
  // Task 7 removes relations the frontmatter no longer declares, so "declared nothing" and
  // "cannot declare it" must be the same value. An `undefined` here would start meaning
  // "leave the rows alone".
  const runbook = accepted("RUNBOOK", { related: "runbooks/paging" });
  expect(runbook.relations).toEqual({ ...NO_RELATIONS, RELATES_TO: ["runbooks/paging"] });
  expect(Object.keys(runbook.relations).sort()).toEqual(
    Object.keys(KEY_FOR_RELATION).sort(),
  );
});

test("every relation type has a frontmatter key that declares it", () => {
  // Compile-time already: `KEY_FOR_RELATION` is a `Record<RelationType, RelationKey>`. Pinned
  // at runtime too, because a relation nothing can declare is a feature no author can reach.
  expect(Object.values(KEY_FOR_RELATION).sort()).toEqual([
    "amends",
    "decides",
    "related",
    "supersedes",
  ]);
  for (const key of Object.values(KEY_FOR_RELATION)) {
    expect(frontmatterKeys("ADR")).toContain(key);
  }
});

// ---------------------------------------------------------------------------
// status — from the vocabulary, not from a list written here
// ---------------------------------------------------------------------------

test("every status in a doc type's vocabulary is accepted for that type", () => {
  for (const docType of DOC_TYPES) {
    for (const status of publishableStatuses(docType)) {
      expect(accepted(docType, { status }).status).toBe(status);
    }
  }
});

test("a status from another doc type's vocabulary is refused", () => {
  // CURRENT is legal for a DOC and a RUNBOOK and appears in no ADR row. A schema carrying its
  // own flat list of DocStatus values would accept it here.
  const error = theRefusal("ADR", { status: "CURRENT" });
  expect(error.code).toBe("invalid-status");
  expect(error.key).toBe("status");
  expect(error.message).toContain("not a status a ADR can be published into");
  expect(error.message).toContain("PROPOSED, ACCEPTED, REJECTED, SUPERSEDED, DEPRECATED");
});

test("no doc type accepts `status: DRAFT`", () => {
  // DRAFT is an origin for every type and a destination for none (spec §6.1), so requesting it
  // is never legal — and it falls out of the vocabulary rather than being special-cased here.
  for (const docType of DOC_TYPES) {
    expect(theRefusal(docType, { status: "DRAFT" }).code).toBe("invalid-status");
  }
});

test("every status any type accepts is refused by at least one other type", () => {
  // The property that a single shared status list cannot have: if the schema were not per-type,
  // this would be vacuously false for every status.
  for (const docType of DOC_TYPES) {
    for (const status of publishableStatuses(docType)) {
      const others = DOC_TYPES.filter((t) => !publishableStatuses(t).includes(status));
      for (const other of others) {
        expect(theRefusal(other, { status }).code).toBe("invalid-status");
      }
    }
  }
});

test("a made-up status is refused, and a non-string status says so differently", () => {
  expect(theRefusal("ADR", { status: "MOSTLY_FINE" }).code).toBe("invalid-status");
  expect(theRefusal("ADR", { status: true }).message).toContain(
    "must be a status written as text",
  );
});

test("no status requested is `null`, not a default", () => {
  // Which status a publish lands on when frontmatter is silent is `defaultPublishStatus`'s
  // answer, and it needs the status the page is in now. This module must not guess it.
  expect(accepted("ADR", {}).status).toBeNull();
  expect(accepted("ADR", { status: null }).status).toBeNull();
});

// ---------------------------------------------------------------------------
// Non-finite numbers — YAML accepts them, JSON.stringify turns them into null
// ---------------------------------------------------------------------------

test(".nan, .inf and -.inf are refused wherever they appear", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    // Proof of what makes this the module's problem rather than nobody's: the value survives
    // parsing and then changes on the way to the `Json` column.
    expect(JSON.parse(JSON.stringify({ v: value })).v).toBeNull();

    const error = theRefusal("ADR", { systems: [value] });
    expect(error.code).toBe("non-finite-number");
    expect(error.key).toBe("systems");
    expect(error.message).toContain("cannot be stored");
  }
});

test("a non-finite number is refused straight out of YAML, not just as a JS value", () => {
  // The path that actually happens: an author writes `.nan`, `yaml` gives back a JS NaN.
  const result = validateDocument("ADR", "---\nstatus: .nan\n---\n\n# Title\n");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.map((e) => e.code)).toEqual(["non-finite-number"]);
  expect(result.errors[0].key).toBe("status");
});

test("a non-finite number nested inside a list is found", () => {
  const error = theRefusal("ADR", { related: [".inf placeholder", Number.NaN] });
  expect(error.code).toBe("non-finite-number");
  expect(error.key).toBe("related");
});

test("a non-finite key reports once, not also as a type error for the same key", () => {
  // Two sentences about one problem, the second less accurate than the first.
  expect(refused("ADR", { status: Number.NaN })).toHaveLength(1);
});

test("a non-finite value does not hide an unrelated key's problem", () => {
  const errors = refused("ADR", { status: Number.NaN, supersedez: "a" });
  expect(errors.map((e) => e.code).sort()).toEqual(["non-finite-number", "unknown-key"]);
});

test("finite numbers are not swept up by the non-finite check", () => {
  // The guard must refuse `.nan`, not "numbers". A number under a string-valued key is a type
  // error and has to read as one.
  const error = theRefusal("ADR", { supersedes: 31 });
  expect(error.code).toBe("invalid-relation");
  expect(error.message).toContain("must be a page path written as text");
});

// ---------------------------------------------------------------------------
// Relation targets
// ---------------------------------------------------------------------------

test("a scalar target and a list of one are the same accepted value", () => {
  const scalar = accepted("ADR", { supersedes: "decisions/adr-0031" });
  const list = accepted("ADR", { supersedes: ["decisions/adr-0031"] });

  expect(scalar.relations.SUPERSEDES).toEqual(["decisions/adr-0031"]);
  expect(scalar).toEqual(list);
});

test("the accepted value is not what the author typed", () => {
  // Task 1 Step 2: the draft holds what the author typed, the version holds what validation
  // accepted, and they are not the same value. Normalisation is where they part.
  const text = "---\nsupersedes: decisions/adr-0031\n---\n\n# Title\n";
  const split = splitFrontmatter(text);
  if (!split.ok) throw new Error("split failed");

  expect(split.frontmatter).toEqual({ supersedes: "decisions/adr-0031" });
  expect(accepted("ADR", split.frontmatter)).toEqual({
    status: null,
    systems: [],
    relations: { ...NO_RELATIONS, SUPERSEDES: ["decisions/adr-0031"] },
  });
});

test("all four relation keys land on their relation type", () => {
  expect(
    accepted("ADR", {
      supersedes: "decisions/adr-0031",
      amends: ["decisions/adr-0020", "decisions/adr-0021"],
      decides: "proposals/rfc-0004",
      related: "runbooks/paging",
    }).relations,
  ).toEqual({
    SUPERSEDES: ["decisions/adr-0031"],
    AMENDS: ["decisions/adr-0020", "decisions/adr-0021"],
    DECIDES: ["proposals/rfc-0004"],
    RELATES_TO: ["runbooks/paging"],
  });
});

test("an empty key is `[]`, so a template an author has not filled in validates", () => {
  // Task 4's templates ship the keys present and empty. If `supersedes:` with nothing after it
  // were a type error, the product would ship a template that cannot be published.
  const result = validateDocument(
    "ADR",
    "---\nstatus: PROPOSED\nsystems:\nsupersedes:\namends:\ndecides:\nrelated:\n---\n\n# Title\n",
  );
  expect(result).toEqual({
    ok: true,
    frontmatter: { status: "PROPOSED", systems: [], relations: NO_RELATIONS },
  });
});

test("an empty or whitespace-padded target is refused rather than trimmed", () => {
  // `slug.ts` settled this: trimming silently accepts a value the author never typed.
  expect(theRefusal("ADR", { supersedes: [""] }).message).toContain("entry 1 is empty");
  expect(theRefusal("ADR", { supersedes: " decisions/adr-0031 " }).message).toContain(
    "leading or trailing whitespace",
  );
});

test("a target longer than a page path can be is refused", () => {
  const tooLong = "a".repeat(MAX_PATH_BYTES + 1);
  const error = theRefusal("ADR", { supersedes: tooLong });
  expect(error.code).toBe("invalid-relation");
  expect(error.message).toContain(`${MAX_PATH_BYTES} bytes`);
  expect(accepted("ADR", { supersedes: "a".repeat(MAX_PATH_BYTES) }).relations.SUPERSEDES)
    .toHaveLength(1);
});

test("the target cap bounds the work one publish can ask for", () => {
  // MAX_FRONTMATTER_ENTRIES is 200 and does not bound this: each target costs Task 5 a
  // resolution query, Task 6 a cycle walk and Task 8 a row lock, inside one transaction.
  const targets = Array.from({ length: MAX_RELATION_TARGETS }, (_, i) => `decisions/adr-${i}`);
  expect(accepted("ADR", { related: targets }).relations.RELATES_TO).toHaveLength(
    MAX_RELATION_TARGETS,
  );

  const error = theRefusal("ADR", { related: [...targets, "decisions/adr-extra"] });
  expect(error.code).toBe("invalid-relation");
  expect(error.message).toContain(`more than ${MAX_RELATION_TARGETS} targets`);
});

test("a nested structure under a relation key is refused", () => {
  expect(theRefusal("ADR", { supersedes: { path: "decisions/adr-0031" } }).message).toContain(
    "must be a page path written as text",
  );
});

test("the offending entry is numbered from one", () => {
  const error = theRefusal("ADR", { amends: ["decisions/adr-0020", ""] });
  expect(error.message).toContain("`amends` entry 2");
});

// ---------------------------------------------------------------------------
// systems — accepted, shape-checked, catalogue-unvalidated until Phase 7
// ---------------------------------------------------------------------------

test("`systems:` is accepted and carried through, for every doc type", () => {
  // Spec §7 tells authors to write this and Phase 7 owns the catalogue. Rejecting the key
  // would block documented usage; ignoring it would lose data the author meant, invisibly.
  for (const docType of DOC_TYPES) {
    expect(accepted(docType, { systems: ["order-hub", "kiosk-bridge", "store-ios"] }).systems)
      .toEqual(["order-hub", "kiosk-bridge", "store-ios"]);
  }
});

test("an unrecognised system key is accepted — Phase 7 owns the catalogue", () => {
  // Deliberate, and the one thing about `systems` that is deferred rather than absent.
  expect(accepted("ADR", { systems: "not-a-real-system" }).systems).toEqual([
    "not-a-real-system",
  ]);
});

test("`systems:` is still shape-checked, so the passthrough cannot smuggle rubbish", () => {
  expect(theRefusal("ADR", { systems: [""] }).code).toBe("invalid-systems");
  expect(theRefusal("ADR", { systems: [{ key: "order-hub" }] }).message).toContain(
    "must be a system key written as text",
  );
  expect(theRefusal("ADR", { systems: " order-hub" }).code).toBe("invalid-systems");
});

// ---------------------------------------------------------------------------
// Composition with the parser, and things it already refuses
// ---------------------------------------------------------------------------

test("a document with no frontmatter validates as nothing declared", () => {
  expect(validateDocument("DOC", "# Title\n\nBody.\n")).toEqual({
    ok: true,
    frontmatter: { status: null, systems: [], relations: NO_RELATIONS },
  });
});

test("a duplicate key never reaches this module", () => {
  // Task 2 refuses it as `frontmatter-unparseable` — `yaml` reports "Map keys must be unique".
  // A repeated `supersedes:` is an author who believes both relations exist, so failing is
  // right; a second duplicate check here would be dead code that looks like a guard.
  const split = splitFrontmatter(
    "---\nsupersedes: decisions/adr-0031\nsupersedes: decisions/adr-0032\n---\n",
  );
  expect(split.ok).toBe(false);
  if (split.ok) return;
  expect(split.error.code).toBe("frontmatter-unparseable");
});

test("the plan's ADR header validates end to end", () => {
  expect(
    validateDocument(
      "ADR",
      "---\nstatus: ACCEPTED\nsupersedes: decisions/adr-0031\n---\n\n# Title\n",
    ),
  ).toEqual({
    ok: true,
    frontmatter: {
      status: "ACCEPTED",
      systems: [],
      relations: { ...NO_RELATIONS, SUPERSEDES: ["decisions/adr-0031"] },
    },
  });
});

test("every error carries a key, and every message names it", () => {
  // `field: "markdown"` alone can only underline the whole editor pane. The promise this
  // module makes to Task 11 is that it can point at a line.
  const inputs: [DocType, Record<string, unknown>][] = [
    ["ADR", { supersedez: "a" }],
    ["RUNBOOK", { decides: "a" }],
    ["ADR", { status: "CURRENT" }],
    ["ADR", { supersedes: [""] }],
    ["ADR", { systems: [1] }],
    ["ADR", { related: Number.NaN }],
  ];

  for (const [docType, frontmatter] of inputs) {
    for (const error of refused(docType, frontmatter)) {
      expect(error.field).toBe("markdown");
      expect(error.key).not.toBeNull();
      expect(error.message).toContain(`\`${error.key}\``);
      expect(error.message.endsWith(".")).toBe(true);
    }
  }
});
