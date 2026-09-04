import { z } from "zod";
import type { DocStatus, DocType, RelationType } from "@prisma/client";
import type { Frontmatter } from "@/lib/markdown/frontmatter";
import { MAX_PATH_BYTES } from "@/lib/pages/slug";
import { publishableStatuses } from "@/lib/pages/transition";

/**
 * What frontmatter is allowed to say, per doc type.
 *
 * Pure: a plain object in (whatever `splitFrontmatter` accepted), plain values out. The three
 * Prisma imports are `import type` and erased at compile time — `Record<DocType, …>` below is
 * what makes a new doc type fail to compile rather than silently accept nothing.
 *
 * ## Strict, not permissive, and that is the whole design
 *
 * An unknown key is **refused**, never dropped. The motivating case is one character:
 *
 *     supersedez: decisions/adr-0031
 *
 * A permissive schema ignores that line. The author believes they have retired ADR-0031; the
 * publish transaction creates no relation, fires no cascade, and says nothing. The old decision
 * stays `ACCEPTED` and two documents now claim to be in force. Nothing downstream can detect
 * it, because there is nothing to detect — the key was thrown away before anyone looked. So the
 * cost of strictness (an author who has to fix a typo) is paid once and visibly, and the cost of
 * permissiveness is paid silently and forever.
 *
 * ## Per doc type, not one shared schema
 *
 * A runbook declaring `decides:` is a mistake worth naming, not a field to ignore. One shared
 * schema cannot name it: it would have to accept `decides` for everything, and a runbook that
 * "decides" an RFC would then reach Task 6's guardrails to be refused there — one phase later,
 * with a message about relation legality rather than about the key the author typed.
 *
 * The per-type table is below and two of its three columns are *derived* rather than asserted;
 * see `RELATION_KEYS_BY_TYPE`.
 *
 * ## It does not throw
 *
 * Every rejection is a `FrontmatterKeyError` carrying the offending key, so the editor can say
 * which line is wrong. Same asymmetry as everything else in the authoring path: a draft accepts
 * what publish refuses, and autosave never fails because frontmatter is mid-keystroke.
 */

/**
 * Most relation targets one key may name.
 *
 * The upstream caps do not bound this. `MAX_FRONTMATTER_ENTRIES` is 200 across the whole
 * block, so `supersedes:` with 200 entries passes it, and the entry cap cannot see the
 * difference between 200 list items and 200 units of work inside one transaction.
 *
 * **Two thirds of the original reasoning here has gone stale, and it is corrected rather than
 * left to be trusted.** It used to say every target costs a resolution query, a cycle walk and a
 * row lock. Resolution batches — three queries regardless of count — and the cycle walk batches
 * within a walk *and* shares one 200-page budget across the whole call, so both are independent
 * of the target count. What remains is **row locks**, which genuinely do not batch and are held
 * for the rest of the publish transaction.
 *
 * (The correction reached this phase's plan and PROGRESS.md when it was found, and did not reach
 * this comment for three tasks. Correcting a plan is not correcting the code comment that says
 * the same thing.)
 *
 * 20 is far past any real document: the largest plausible case is one ADR retiring a handful of
 * predecessors at once.
 */
export const MAX_RELATION_TARGETS = 20;

/** A frontmatter key that declares a relation. */
export type RelationKey = "supersedes" | "amends" | "decides" | "related";

/**
 * Every `RelationType`, and the frontmatter key that declares it.
 *
 * Written in this direction on purpose: `Record<RelationType, RelationKey>` is exhaustive, so
 * adding a member to the enum without giving it a key fails to compile instead of shipping a
 * relation type no author can ever declare. The inverse lookup is never needed — the assembly
 * below iterates this map — so there is no second copy to keep in step.
 *
 * Exported for Task 5 (resolving a target) and Task 7 (upserting the rows).
 *
 * It also said "and Phase 5's git mirror, which has to write the keys back out as YAML", and
 * Phase 5 Task 1 decided otherwise: `src/lib/git/document.ts` writes `PageVersion.frontmatter`
 * **verbatim**, so the mirrored file carries `SUPERSEDES` and not `supersedes`. Reshaping it
 * would mean the mirror knowing the column's shape, which is a second place to keep in step with
 * this module and a silent drop for any key it did not expect. Corrected here rather than left to
 * be trusted — a stale measurement in a comment is the one a reader meets first.
 */
export const KEY_FOR_RELATION = {
  SUPERSEDES: "supersedes",
  DECIDES: "decides",
  AMENDS: "amends",
  RELATES_TO: "related",
} as const satisfies Record<RelationType, RelationKey>;

/**
 * Which relation keys each doc type may declare.
 *
 * Two of these are derived from rules stated elsewhere, and saying which is which matters more
 * than the table:
 *
 * - **`supersedes` is ADR-only, and that is derived from the vocabulary, not chosen here.** The
 *   cascade for `supersedes: X` sets X to `SUPERSEDED` (spec §6.3), and §6.3 also requires
 *   `SUPERSEDES` to be between two pages of the *same* doc type. `SUPERSEDED` appears in
 *   exactly one type's vocabulary — the ADR's — so for any other type the key could only ever
 *   name a cascade `PUBLISHABLE_INTO` forbids. Accepting it would be accepting a key that
 *   cannot succeed. `schema.test.ts` asserts the equivalence rather than the row, so a Phase 3
 *   vocabulary change moves this table with it.
 *
 * - **`decides` is ADR-only because spec §6.3 says so**: *"`DECIDES` is only legal from `ADR`
 *   to `RFC`"*. That is a constraint on the *source*, which is what this table is about; the
 *   target half is Task 6's, and the `CLOSED` cascade it implies is reachable only in the RFC
 *   vocabulary, so the two halves agree.
 *
 * - **`amends` is for the ADR and the RFC, derived from which types hold records.** This was the
 *   one cell with no derivation behind it, and it was ADR-only on the explicit ground that
 *   `AMENDS` fires no cascade (§6.3 lists two, and this is not one of them) so nothing
 *   validated it — accepting it more widely would have been accepting a key nothing checks.
 *   Task 6 wrote that guardrail (`AMENDS` is legal only between two pages of the same doc type,
 *   `src/lib/lifecycle/relations.ts`), which removed the reason, so the row moved in the same
 *   change rather than a table entry going in on its own.
 *
 *   The derivation: `AMENDS` is the relation for a document that must not be rewritten in
 *   place — you do not edit an accepted decision, you publish another one that amends it. Those
 *   are exactly the doc types whose vocabulary has a **terminal status**, one they can be
 *   published into and never out of: the ADR and the RFC. A `DOC` and a `RUNBOOK` have none —
 *   `ARCHIVED` publishes back into `CURRENT` — because they are living pages, and "I amended it"
 *   is what their version history already says. `schema.test.ts` asserts that equivalence
 *   against `terminalStatuses`, not the row, so a vocabulary change moves this table with it.
 *
 * - **`related` is universal.** `RELATES_TO` is non-directional and has no cascade, so it
 *   cannot retire anything or contradict a vocabulary.
 */
const RELATION_KEYS_BY_TYPE: Record<DocType, readonly RelationKey[]> = {
  DOC: ["related"],
  RUNBOOK: ["related"],
  RFC: ["related", "amends"],
  ADR: ["related", "supersedes", "amends", "decides"],
};

/**
 * Every key a page of this type may declare, in the order a template should print them.
 *
 * Exported because Task 4's templates must open with exactly these — an author should see the
 * shape rather than discover it from a validation error — and because the refusal messages
 * below list them.
 */
export function frontmatterKeys(docType: DocType): readonly string[] {
  return ["status", "systems", ...RELATION_KEYS_BY_TYPE[docType]];
}

/** Every key known to *any* doc type — what separates a typo from a misplaced key. */
const ALL_KEYS: readonly string[] = [
  ...new Set((["DOC", "RUNBOOK", "ADR", "RFC"] as const).flatMap(frontmatterKeys)),
];

/** Which doc types accept `key`, for the "you wrote a real key in the wrong document" message. */
function docTypesAccepting(key: string): DocType[] {
  return (["ADR", "RFC", "DOC", "RUNBOOK"] as const).filter((t) =>
    frontmatterKeys(t).includes(key),
  );
}

export type FrontmatterSchemaErrorCode =
  /** A key no doc type has, usually a typo. */
  | "unknown-key"
  /** A real key, on a doc type that does not take it. */
  | "key-not-for-doc-type"
  | "invalid-status"
  | "invalid-relation"
  | "invalid-systems"
  /** `.nan` or `.inf`, anywhere in the structure. See `findNonFinite`. */
  | "non-finite-number";

/**
 * `FieldError` from `src/lib/pages/slug.ts` — same three fields, same "return, never throw"
 * contract — **plus `key`**, and the addition is the point of this type.
 *
 * `field` is `markdown` because that is the box the author types in: frontmatter has no input
 * of its own. Which means `field` alone can only underline the whole editor pane, and "your
 * frontmatter is wrong, somewhere in these six lines" is not a message anyone can act on. `key`
 * is what lets Task 11 point at the offending line.
 *
 * It carries a key rather than a line number because the parsed frontmatter has no positions:
 * `splitFrontmatter` returns a plain object, and threading `yaml`'s `Document` through to get
 * offsets would make every consumer of frontmatter carry a CST. A key is enough — the editor
 * can find `^key:` in the first few lines of the document, and unlike a line number it stays
 * correct if the author reorders them.
 *
 * A parallel type rather than a widened `FieldError`, for the same reason
 * `FrontmatterFieldError` in `src/lib/markdown/frontmatter.ts` is one: the codes are this
 * module's, and a shared code union would let a caller switch on a slug error it can never see.
 */
export type FrontmatterKeyError = {
  field: "markdown";
  /** The frontmatter key at fault. `null` only when the fault is not attributable to one. */
  key: string | null;
  code: FrontmatterSchemaErrorCode;
  message: string;
};

/**
 * What validation accepted — deliberately **not** what the author typed.
 *
 * This is the value the publish path stores in `PageVersion.frontmatter` while `PageDraft`
 * keeps the raw text, which is the distinction Task 1 Step 2 asked to be pinned. Normalisation
 * is why they differ: `supersedes: decisions/adr-0031` is one scalar in the draft and a
 * one-element array here.
 *
 * `relations` is keyed by `RelationType` and **always carries all four keys**, empty where
 * nothing was declared. Task 7 has to remove relations the frontmatter no longer declares, so
 * "declared nothing" and "did not mention the key" must be the same value — otherwise
 * `undefined` starts meaning "leave the existing rows alone" and the frontmatter and the
 * database can disagree with no way to tell which is right. A doc type that cannot declare a
 * key gets `[]` for it, so a runbook removes zero relations, correctly.
 */
export type ValidatedFrontmatter = {
  /** The status the author asked to publish into, or `null` for "no request". */
  status: DocStatus | null;
  /** System keys, shape-checked only. See the note on `systemsSchema`. */
  systems: string[];
  /** Space-relative page paths, per relation type. Unresolved — Task 5 resolves them. */
  relations: Record<RelationType, string[]>;
};

export type FrontmatterValidation =
  | { ok: true; frontmatter: ValidatedFrontmatter }
  /**
   * **All** the errors, not the first. A slug is one input and gets one message; frontmatter is
   * a handful of keys the author wrote in one pass, and fixing them one publish-attempt at a
   * time is a bad loop. Non-empty by construction.
   */
  | { ok: false; errors: [FrontmatterKeyError, ...FrontmatterKeyError[]] };

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * One space-relative page path, unresolved.
 *
 * Shape only: whether the path names a page that exists, is readable, or is in this space is
 * Task 5's, and it needs a database. What is checkable here is what could never name a page at
 * all — and doing it here means the author hears about it from the editor rather than from a
 * resolution failure four steps into the publish transaction.
 *
 * Not trimmed, refused instead. `src/lib/pages/slug.ts` settled that: trimming silently accepts
 * a value the author never typed. YAML already strips a plain scalar's surrounding spaces, so
 * this only fires on a deliberately quoted `"  a/b  "` — where taking the author at their word
 * and refusing is both cheaper and more honest than guessing.
 */
const pageRef = z
  .string({ error: "must be a page path written as text" })
  .refine((s) => s.length > 0, {
    error: "is empty; a relation names a space-relative page path, like decisions/adr-0031",
  })
  .refine((s) => s === s.trim(), {
    error: "has leading or trailing whitespace; write the path exactly as it appears in the URL",
  })
  // `MAX_PATH_BYTES` from `slug.ts`, not a number of its own: that constant is the length
  // `validatePath` allows a `Page.path` to be, so anything longer cannot name a page in any
  // space and is a guaranteed miss rather than a lookup worth doing.
  .refine((s) => utf8Length(s) <= MAX_PATH_BYTES, {
    error: `is longer than the ${MAX_PATH_BYTES} bytes a page path can be, so it names no page`,
  });

/**
 * A key that takes one value or a list of them, normalised to a list.
 *
 * `preprocess` rather than a union, and it earns its place three times: the spec writes
 * `supersedes: ADR-0031` as a scalar and `systems: [a, b]` as a list, so both have to work; the
 * normalised output means Task 7 never branches on arity; and `null` — which is what
 * `supersedes:` with nothing after it parses to, i.e. every template key an author has not
 * filled in yet — becomes `[]` rather than a type error. That last one is load-bearing for Task
 * 4: its templates ship the keys empty, and they have to validate.
 *
 * A union would also report a scalar failure as a nested `invalid_union` with two sets of
 * issues and no usable path, which is the opposite of a message naming the offending key.
 */
function listOf(item: z.ZodType<string>, max: number | null): z.ZodType<string[] | undefined> {
  const array = max === null
    ? z.array(item)
    : z.array(item).max(max, {
        error: `lists more than ${max} targets; that is more relations than one page declares`,
      });
  return z
    .preprocess(
      (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]),
      array,
    )
    .optional() as z.ZodType<string[] | undefined>;
}

const relationTargets = listOf(pageRef, MAX_RELATION_TARGETS);

/**
 * `systems:` — **accepted, shape-checked, and not validated against a catalogue**, because
 * there is no catalogue to validate against until Phase 7.
 *
 * The three options and why this one:
 *
 * - **Reject the key.** Spec §7 tells authors to write `systems: [order-hub, store-ios]`, and Task
 *   4's ADR template prints it. Rejecting it would mean the product ships a template that
 *   cannot be published — and would refuse the one thing the spec documents about this key.
 * - **Ignore it.** The failure mode this whole module exists to prevent, on a key we *know* is
 *   coming: the author writes their systems, publish drops them, and the page ships with an
 *   empty facet that nobody can tell apart from a page that declared nothing. Phase 7 then
 *   arrives to find that every page written in between has to be re-edited, with no record of
 *   what was lost.
 * - **Accept and store it.** The declaration is preserved in `PageVersion.frontmatter`, so
 *   Phase 7 can populate `PageSystem` from data that already exists instead of asking authors
 *   to type it again.
 *
 * **This is not a hole in "reject unknown keys".** `systems` is a *known* key, in the table
 * above for every doc type, with a validator that is deferred rather than absent — the deferred
 * half is only *which* system keys exist. What is checked here is everything Phase 3 can know:
 * that it is text or a list of text, non-empty, and JSON-safe (`findNonFinite`, below, is the
 * reason that last one is not vacuous).
 *
 * TODO(phase-7): validate each key against the systems catalogue and write `PageSystem` rows.
 *
 * No count cap, unlike `relationTargets`, and the asymmetry is deliberate rather than an
 * oversight: a relation target costs a query, a cycle walk and a row lock inside the publish
 * transaction, while a system key costs nothing at all in Phase 3. The 16KB block cap and the
 * 200-entry cap are the bounds until Phase 7 has per-system work to protect.
 */
const systemsSchema = listOf(
  z
    .string({ error: "must be a system key written as text, like order-hub" })
    .refine((s) => s.length > 0, { error: "is empty" })
    .refine((s) => s === s.trim(), { error: "has leading or trailing whitespace" }),
  null,
);

/**
 * `status:` — constrained by the doc type's **vocabulary**, imported, never by a list written
 * here.
 *
 * `publishableStatuses` derives it from `PUBLISHABLE_INTO`. A list typed out in this file would
 * be a second source of truth, which spec §6.3 warns against in as many words, and it would
 * fail in the worst direction: a status this schema accepted but the vocabulary forbade would
 * pass validation and then be refused by `validateTransition` several steps later, with a
 * message about transitions rather than about the key the author typed.
 *
 * This checks *membership*, not the transition. Whether an `ACCEPTED` ADR may go to `PROPOSED`
 * depends on the status the page is in now, which is a database row, so `validateTransition`
 * still runs at publish. The two questions are different and both are asked.
 *
 * `z.enum` is not used because the legal set is computed per doc type at call time — which is
 * the entire point — and because a refine can name the alternatives in the message.
 */
function statusSchema(docType: DocType): z.ZodType<DocStatus | null | undefined> {
  const legal = publishableStatuses(docType);
  return z
    .string({ error: "must be a status written as text" })
    .refine((s) => (legal as readonly string[]).includes(s), {
      error: `is not a status a ${docType} can be published into; use one of ${legal.join(", ")}`,
    })
    .transform((s) => s as DocStatus)
    .nullish();
}

/** What `safeParse` gives back, once. One cast, in one place, justified by the shape above. */
type ParsedFrontmatter = {
  status?: DocStatus | null;
  systems?: string[];
} & Partial<Record<RelationKey, string[]>>;

function schemaFor(docType: DocType): z.ZodType {
  const shape: Record<string, z.ZodType> = {
    status: statusSchema(docType),
    systems: systemsSchema,
  };
  for (const key of RELATION_KEYS_BY_TYPE[docType]) shape[key] = relationTargets;
  // `strictObject`, not `object`: `z.object` *strips* unknown keys, which is precisely the
  // silent drop this module exists to refuse. One word between the two behaviours.
  return z.strictObject(shape);
}

/** Built once per doc type at module load; `zod` schemas are stateless after construction. */
const SCHEMAS: Record<DocType, z.ZodType> = {
  DOC: schemaFor("DOC"),
  RUNBOOK: schemaFor("RUNBOOK"),
  ADR: schemaFor("ADR"),
  RFC: schemaFor("RFC"),
};

/**
 * The first non-finite number in the structure, as the top-level key it sits under.
 *
 * YAML 1.2's core schema admits `.nan`, `.inf` and `-.inf`, and `JSON.stringify` turns every
 * one of them into `null`. So without this check the value that reaches `PageVersion.frontmatter`
 * is not the value that was validated — silently, with no error anywhere, and `null` is a
 * perfectly plausible thing to find in a `Json` column. That is the same class as Task 2's
 * cyclic anchor: a value that survives parsing and then changes meaning on the way to storage.
 *
 * Asked as a precondition over the whole structure rather than key by key, because it is a
 * property of the **destination** — the `Json` column — and not of any one key's meaning. Which
 * means it cannot be reopened by adding a key: today no key's schema admits a number at all, so
 * `status: .nan` is doubly refused, but the day Phase 7 relaxes `systems` into richer values,
 * or any key takes a number, the guarantee is already in place rather than needing to be
 * remembered. Its observable effect today is the message: "`.nan` is not a value that can be
 * stored" is the truth, where "status must be one of PROPOSED, ACCEPTED, …" would be a guess
 * about what the author meant.
 *
 * Safe to recurse: the input comes from `splitFrontmatter`, which guarantees acyclic and
 * depth-bounded (`MAX_FRONTMATTER_DEPTH`).
 */
function findNonFinite(value: unknown, key: string): string[] {
  if (typeof value === "number") return Number.isFinite(value) ? [] : [key];
  if (value === null || typeof value !== "object") return [];
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.flatMap((child) => findNonFinite(child, key));
}

/** Levenshtein distance, capped implicitly by the tiny inputs (frontmatter key names). */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The nearest key within two edits, or `null`. Two edits catches the transpositions and the
 * one-character slips that are the whole reason this module is strict; three starts suggesting
 * `amends` for `depends`. */
function nearestKey(typo: string, candidates: readonly string[]): string | null {
  if (typo.length < 3) return null;
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(typo.toLowerCase(), candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The message for a key no doc type accepts, or accepts only on another doc type. */
function unknownKeyError(key: string, docType: DocType): FrontmatterKeyError {
  const accepted = frontmatterKeys(docType);
  const elsewhere = docTypesAccepting(key);

  if (elsewhere.length > 0) {
    return {
      field: "markdown",
      key,
      code: "key-not-for-doc-type",
      message:
        `\`${key}\` is not a key a ${docType} page can declare — only ${elsewhere.join(", ")}. ` +
        `A ${docType} accepts: ${accepted.join(", ")}.`,
    };
  }

  // A near miss on a key that exists *somewhere* is the most useful sentence available: the
  // author's typo is real, and the reason it is still refused is the doc type, not the spelling.
  const nearbyElsewhere = nearestKey(key, ALL_KEYS);
  const suggestion = nearestKey(key, accepted);
  const hint =
    suggestion !== null
      ? ` Did you mean \`${suggestion}\`?`
      : nearbyElsewhere !== null
        ? ` Did you mean \`${nearbyElsewhere}\`? Only ` +
          `${docTypesAccepting(nearbyElsewhere).join(", ")} can declare it.`
        : "";

  return {
    field: "markdown",
    key,
    code: "unknown-key",
    message:
      `\`${key}\` is not a frontmatter key.${hint} ` +
      `A ${docType} accepts: ${accepted.join(", ")}. Unknown keys are refused rather than ` +
      "ignored, because a dropped relation looks exactly like one that was never written.",
  };
}

function codeForKey(key: string): FrontmatterSchemaErrorCode {
  if (key === "status") return "invalid-status";
  if (key === "systems") return "invalid-systems";
  return "invalid-relation";
}

/**
 * Validates already-parsed frontmatter against its doc type's schema.
 *
 * Takes the object `splitFrontmatter` produced rather than the document text: the two halves
 * compose at the call site, and this one stays testable with a literal.
 */
export function validateFrontmatter(args: {
  docType: DocType;
  frontmatter: Frontmatter;
}): FrontmatterValidation {
  const { docType, frontmatter } = args;
  const errors: FrontmatterKeyError[] = [];

  // The storability precondition, before the schema. A key with a non-finite value gets this
  // answer and not also the schema's, because they are one problem and the schema's sentence
  // would be the less accurate of the two.
  const nonFinite = new Set(
    Object.entries(frontmatter).flatMap(([key, value]) => findNonFinite(value, key)),
  );
  for (const key of nonFinite) {
    errors.push({
      field: "markdown",
      key,
      code: "non-finite-number",
      message:
        `\`${key}\` contains \`.nan\`, \`.inf\` or \`-.inf\`. YAML accepts those but they ` +
        "cannot be stored, and would be silently turned into `null` on the way to the " +
        "database. Write a real value.",
    });
  }

  const result = SCHEMAS[docType].safeParse(frontmatter);

  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) errors.push(unknownKeyError(key, docType));
        continue;
      }
      const [key, index] = issue.path;
      if (typeof key !== "string" || nonFinite.has(key)) continue;
      const subject =
        typeof index === "number" ? `\`${key}\` entry ${index + 1}` : `\`${key}\``;
      errors.push({
        field: "markdown",
        key,
        code: codeForKey(key),
        message: `${subject} ${issue.message}.`,
      });
    }
  }

  const [first, ...rest] = errors;
  if (first !== undefined) return { ok: false, errors: [first, ...rest] };

  // Reached only when `safeParse` succeeded: `errors` is empty and the non-finite scan found
  // nothing, so there is a `data` to read.
  const parsed = (result.success ? result.data : {}) as ParsedFrontmatter;

  const relations = {} as Record<RelationType, string[]>;
  for (const [type, key] of Object.entries(KEY_FOR_RELATION) as [
    RelationType,
    RelationKey,
  ][]) {
    // A key this doc type cannot declare is `[]`, not absent — see `ValidatedFrontmatter`.
    //
    // The `includes` is **redundant today and deliberately kept**: a key absent from this
    // type's schema is absent from `parsed` too, so `?? []` alone gives the same answer, and
    // deleting the check passes the whole suite. It states the invariant the `??` only happens
    // to satisfy — that what a type may *declare* decides what it *reports* — rather than
    // leaving it to be inferred from `schemaFor`. Reported as an equivalent mutant rather than
    // pinned by a test that would have to reach inside the module to construct the difference.
    relations[type] = RELATION_KEYS_BY_TYPE[docType].includes(key) ? (parsed[key] ?? []) : [];
  }

  return {
    ok: true,
    frontmatter: {
      status: parsed.status ?? null,
      systems: parsed.systems ?? [],
      relations,
    },
  };
}
