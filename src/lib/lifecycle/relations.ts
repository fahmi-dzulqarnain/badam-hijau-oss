import type { DocStatus, DocType, Prisma, RelationType } from "@prisma/client";
import { KEY_FOR_RELATION, type RelationKey } from "@/lib/lifecycle/schema";
import type { ResolvedRelation } from "@/lib/lifecycle/resolve";

/**
 * Whether the relations an author declared are **legal** — spec §6.3's guardrails.
 *
 * Task 5 answered *which page does this name?* and deliberately answered nothing else. This
 * answers *may these two pages be joined this way, and does publishing fire a cascade?* Its
 * input is `resolveRelations`'s output, which already carries the target's `docType` and
 * `status`, so no page is read again here.
 *
 * ## Self-reference is not here
 *
 * It is Task 5's, for all four relation types, checked on the **resolved** page — and that is
 * the only place it can be checked correctly: a reference to this page's own *pre-move* path
 * resolves, through the redirect, back to this page, and a path-string comparison would happily
 * write that as a relation to itself. `resolveRelations` refuses it there.
 *
 * Restating it here would be the failure this project has recorded twice: a predicate stated in
 * two places is a predicate neither statement can be tested for — mutate away either copy and
 * the suite stays green. So it is **subsumed, not omitted**, and this sentence is the record.
 *
 * ## The four guardrails, and where each comes from
 *
 * - **`SUPERSEDES` only between two pages of the same doc type** (§6.3). Not a preference: the
 *   cascade sets the target to `SUPERSEDED`, and `SUPERSEDED` appears in exactly one doc type's
 *   vocabulary, so a cross-type supersede could only ever ask for a transition
 *   `PUBLISHABLE_INTO` forbids. `RELATION_KEYS_BY_TYPE` already stops a runbook *declaring*
 *   `supersedes:`; this stops an ADR pointing it at a runbook, which is the half a table of
 *   keys cannot see.
 *
 * - **`DECIDES` only from an `ADR` to an `RFC`** (§6.3). The one directional rule, and the
 *   direction is the content: an ADR records a decision, an RFC is the proposal it decides.
 *
 * - **A supersede chain may not loop.** See `walkSupersedeChain`.
 *
 * - **A cascade fires only when the source reaches `ACCEPTED`** (§6.3), so a draft cannot
 *   retire a live decision. See `cascadeFor` — this is a gate on the *cascade*, not a refusal
 *   of the relation, and the distinction is argued there.
 *
 * ## `AMENDS`: widened to the RFC, with the guardrail in the same change
 *
 * Task 3 made `amends` ADR-only and flagged it as the one cell in its table with no derivation
 * behind it, on the explicit ground that **no guardrail existed** for `AMENDS` — so accepting
 * it more widely would have been accepting a relation key nothing validates. This task writes
 * the guardrail, which dissolves that premise, so keeping the conclusion would be keeping a
 * decision after its argument is gone. Both halves are in this change:
 *
 * - The guardrail: **`AMENDS` is legal only between two pages of the same doc type.** Not
 *   borrowed from `SUPERSEDES` — an amendment modifies a document of its own kind, and an ADR
 *   "amending" a runbook is either an edit to the runbook or a `related:` link. It has its own
 *   row in `END_RULE`, its own sentence and its own test.
 *
 * - The table: `amends` is available to the **ADR and the RFC**, and to neither of the other
 *   two, derived rather than chosen. `AMENDS` is the relation for a document that must not be
 *   rewritten in place — you do not edit an accepted decision, you write another one that
 *   amends it. Which doc types are those? Exactly the ones whose vocabulary has a **terminal
 *   status**, one they can be published into and never out of: the ADR (`SUPERSEDED`,
 *   `DEPRECATED`, `REJECTED`) and the RFC (`CLOSED`, `WITHDRAWN`, `REJECTED`). A `DOC` and a
 *   `RUNBOOK` have none — `ARCHIVED` publishes back into `CURRENT` — because they are living
 *   pages that are edited, and "I amended it" is what their version history already says.
 *   `terminalStatuses` in `transition.ts` is where that is computed, and `schema.test.ts`
 *   asserts the equivalence rather than the row, so a vocabulary change moves the key table
 *   with it.
 *
 * Widening costs no unvalidated surface: with the guardrail in place, `amends` on an RFC can
 * name only another RFC; `AMENDS` fires no cascade, so it retires nothing, contradicts no
 * vocabulary and takes no lock in Task 8. What it *buys* is the case that makes the
 * same-doc-type rule reachable from a real document rather than only from a hand-built
 * argument list — an RFC declaring `amends: decisions/adr-0031` is refused here.
 *
 * ## What it still does not judge
 *
 * **Whether the cascade's own transition is legal.** A cascade that fires sets `SUPERSEDED` or
 * `CLOSED` on the target, and `PUBLISHABLE_INTO` may forbid that from the status the target is
 * in now — a `PROPOSED` ADR cannot go to `SUPERSEDED`. That is Task 8's, named in the plan's
 * landmines ("validate the cascade's target transition through the same table"), and it is left
 * there rather than answered twice: this module says *whether a cascade is eligible to fire*,
 * `validateTransition` says *whether it may land*, and stating the second here would make
 * neither statement testable. `CheckedRelation.cascade` is the whole handover.
 *
 * Also not here: the upsert (Task 7), the cascade write and its authorization (Task 8), and the
 * lock ordering that cascade needs.
 */

/**
 * Whatever can read `PageRelation`. Structural, and named `tx` in every signature below for the
 * same two reasons `RelationClient` is: the publish path passes its **transaction** client, so
 * the chain is walked against the snapshot the relation row commits into rather than against
 * one taken before the transaction opened — and the soft-delete sweep in
 * `src/lib/pages/visible.test.ts` matches `db.`/`tx.` delegate calls, so a parameter named
 * `client` would make a module that queries the database invisible to it.
 */
export type RelationGuardClient = Pick<Prisma.TransactionClient, "pageRelation">;

/**
 * How far the supersede walk may travel before it gives up — counted in **pages reached**, not
 * in queries or in depth, because it is the pages that make the work: a chain 200 long and a
 * fan-out 200 wide cost the same and both have to be bounded.
 *
 * Two different failures need two different mechanisms, and conflating them is how a cycle
 * check becomes a hang:
 *
 * - A chain that **loops** is caught by the visited set, which is also what makes the walk
 *   terminate at all. Without it the walk revisits the loop forever.
 * - A chain that is pathologically long and **acyclic** terminates on its own, but only after
 *   one round trip per level — inside the publish transaction, holding its row lock. That is
 *   the lock-duration problem `MAX_RELATION_TARGETS` was capped for, arriving by a route the
 *   entry cap cannot see, so it gets its own bound and its own refusal.
 *
 * 200 is far past any real history: a supersede chain is a document lineage, and the longest
 * plausible one is a handful of ADRs deep. It is a shared budget for the whole check rather
 * than per reference, so 20 declared targets cannot multiply it by 20.
 *
 * On exhaustion the publish is **refused**, not admitted unverified. A refusal is loud and says
 * what it could not do; admitting the edge would write the cycle this guardrail exists to
 * refuse and tell nobody, which is the same fail-open/fail-closed choice `ALLOWED_EMAIL_DOMAINS`
 * already settled on this project.
 */
export const MAX_SUPERSEDE_WALK = 200;

export type RelationGuardCode =
  /** `SUPERSEDES` or `AMENDS` between two different doc types. */
  | "not-same-doc-type"
  /** `DECIDES` from something other than an ADR, or at something other than an RFC. */
  | "decides-needs-adr-to-rfc"
  /** The target already supersedes this page, directly or through a chain. */
  | "supersede-cycle"
  /** The chain is longer than `MAX_SUPERSEDE_WALK`, so a loop could not be ruled out. */
  | "chain-too-long";

/**
 * The same six fields `RelationRefusal` carries, and a parallel type for the same reason it is
 * one: the codes are this module's, and a shared union would let a caller switch on a code it
 * can never see. `field: "markdown"` because frontmatter has no input of its own, and `key` is
 * what lets the editor point at the offending line.
 */
export type RelationGuardError = {
  field: "markdown";
  key: RelationKey;
  type: RelationType;
  /** The reference as the author wrote it, so the message can quote their own line. */
  ref: string;
  code: RelationGuardCode;
  message: string;
};

/** A legal relation, with the cascade Task 8 must apply — or `null` for "no cascade". */
export type CheckedRelation = ResolvedRelation & {
  /**
   * The status Task 8 sets on `page` in this transaction, or `null`.
   *
   * `null` covers three different situations on purpose — the relation type cascades nothing,
   * or it does but the source is not reaching `ACCEPTED` — because the *action* is the same in
   * all of them: write the relation, touch no other page's status. Task 8 needs one branch, not
   * three.
   */
  cascade: DocStatus | null;
};

export type RelationCheck =
  | { ok: true; relations: CheckedRelation[] }
  /**
   * **Every** illegal relation, not the first — the same choice `validateFrontmatter` and
   * `resolveRelations` made, for the same reason: these were declared in one pass and fixing
   * them one publish attempt at a time is a bad loop. Non-empty by construction.
   */
  | { ok: false; errors: [RelationGuardError, ...RelationGuardError[]] };

/**
 * Which pairs of doc types each relation type may join, and **why**, in one exhaustive table.
 *
 * `Record<RelationType, EndRule>` is what makes a fifth relation type fail to compile rather
 * than arrive unconstrained — which is precisely how `AMENDS` came to have no guardrail: it was
 * added to the enum and to a key table, and nothing anywhere had to state what it means.
 *
 * `because` is in the table rather than in the message builder so that each rule owns its own
 * sentence. `SUPERSEDES` and `AMENDS` share a *kind* and share no *message*: they are refused
 * for different reasons and an author fixing one is doing something different from an author
 * fixing the other.
 */
type EndRule =
  | { kind: "same-doc-type"; because: string }
  | { kind: "from-to"; from: DocType; to: DocType; because: string }
  | { kind: "unconstrained" };

const END_RULE: Record<RelationType, EndRule> = {
  SUPERSEDES: {
    kind: "same-doc-type",
    because:
      "superseding retires the target and puts this page in its place, so the two have to be " +
      "the same kind of document — and only one vocabulary has a Superseded status to be " +
      "retired into",
  },
  AMENDS: {
    kind: "same-doc-type",
    because:
      "an amendment modifies a document of its own kind: an ADR amends an ADR, an RFC amends " +
      "an RFC. Changing a document of another kind is an edit to that document, not a relation",
  },
  DECIDES: {
    kind: "from-to",
    from: "ADR",
    to: "RFC",
    because:
      "an ADR is where a decision is recorded and an RFC is the proposal it decides; the " +
      "reverse would have a proposal deciding a decision",
  },
  // Non-directional, cascades nothing, and constrains nothing. A relation between any two pages
  // in a space is exactly what it is for — it is what the other three refusals point at.
  RELATES_TO: { kind: "unconstrained" },
};

/**
 * The status each relation type cascades its target into, or `null` for the ones that cascade
 * nothing. Spec §6.3 lists two, and this table lists four so that a new relation type has to
 * say which it is.
 */
const CASCADE_INTO: Record<RelationType, DocStatus | null> = {
  SUPERSEDES: "SUPERSEDED",
  DECIDES: "CLOSED",
  AMENDS: null,
  RELATES_TO: null,
};

/**
 * The status this relation type retires its target into, or `null` for the two that retire
 * nothing. The read-side view of `CASCADE_INTO`, exported for Task 9.
 *
 * The banner needs it to answer a question no list of relation types would answer correctly:
 * **which incoming relation explains why this page is retired?** A `SUPERSEDED` page is
 * explained by an incoming `SUPERSEDES`, a `CLOSED` RFC by an incoming `DECIDES` — and a
 * `DEPRECATED` ADR by neither, even when a proposal declaring `supersedes:` it exists, because
 * nothing cascades into `DEPRECATED`. `src/lib/lifecycle/retired.ts` derives that by comparing
 * this against the page's status rather than by naming the two types, which is the same
 * derivation `walksTheGraph` makes above and for the same reason: a fifth relation type must
 * change one table, not find every list that forgot it.
 *
 * A function and not the table, so a caller cannot hold a reference to the object every guardrail
 * in this module reads.
 */
export function retiresInto(type: RelationType): DocStatus | null {
  return CASCADE_INTO[type];
}

/**
 * Spec §6.3: *"the source page must reach `ACCEPTED` for a cascade to fire, so a draft cannot
 * retire a live decision."*
 */
const CASCADE_REQUIRES: DocStatus = "ACCEPTED";

/**
 * Whether adding this relation could close a loop that matters — and therefore whether the
 * stored graph has to be walked.
 *
 * Derived from the two tables above rather than written as a third list, because both halves of
 * the derivation are load-bearing and a list would hide them:
 *
 * - A relation type can loop at all only if it may join two pages of the **same** doc type.
 *   `DECIDES` is `ADR → RFC`, so a `DECIDES` cycle would need an RFC that decides an ADR, and
 *   the rule above already refuses that. The loop is unrepresentable rather than unchecked.
 * - A loop only *matters* if the type **cascades**. Two ADRs that amend each other are two
 *   documents that qualify one another, which is a fair description of a pair of amendments and
 *   changes no status. Two ADRs that supersede each other are two documents each retiring the
 *   other, and after the cascade neither is in force.
 *
 * So today this is `SUPERSEDES` and nothing else, and the tests pin that by proving no query is
 * issued for the other three.
 */
function walksTheGraph(type: RelationType): boolean {
  return END_RULE[type].kind === "same-doc-type" && CASCADE_INTO[type] !== null;
}

const guard = (
  relation: ResolvedRelation,
  code: RelationGuardCode,
  message: string,
): RelationGuardError => ({
  field: "markdown",
  key: KEY_FOR_RELATION[relation.type],
  type: relation.type,
  ref: relation.ref,
  code,
  message,
});

/**
 * How a doc type reads in a sentence written for an author. `ADR` and `RFC` are read out as
 * letters, so they take "an"; `DOC` and `RUNBOOK` are read as words and take "a".
 *
 * **Exported for `publish.ts`'s cascade refusal**, which names the target's doc type in the same
 * kind of sentence. Copying four characters would have been the smaller diff and the wrong one:
 * this project has twice recorded that a rule honoured in two places gets quietly dropped by the
 * third site to be written, and the first draft of that refusal already read "a ADR". The other
 * site that gets it wrong is `validateTransition`'s own message, which is §6.1's text and not
 * this task's to rewrite — reported rather than changed.
 */
export const article = (docType: DocType): string =>
  docType === "ADR" || docType === "RFC" ? `an ${docType}` : `a ${docType}`;

/**
 * The doc-type rule for one relation, or `null` if it passes.
 *
 * Pure, and reached for every relation before any query — which is also why a refused relation
 * costs the publish transaction nothing: there is no point walking a graph for an edge that is
 * already illegal, and a test pins that no query happens.
 */
function endsError(
  relation: ResolvedRelation,
  sourceDocType: DocType,
): RelationGuardError | null {
  const rule = END_RULE[relation.type];
  const key = KEY_FOR_RELATION[relation.type];
  const target = relation.page.docType;

  if (rule.kind === "unconstrained") return null;

  if (rule.kind === "same-doc-type") {
    if (target === sourceDocType) return null;
    return guard(
      relation,
      "not-same-doc-type",
      `\`${relation.ref}\` is ${article(target)} and this page is ${article(sourceDocType)}. ` +
        `\`${key}:\` joins two pages of the same doc type, because ${rule.because}. ` +
        "Use `related:` for a link between documents of different kinds.",
    );
  }

  if (sourceDocType === rule.from && target === rule.to) return null;

  // One message for both ends. Which end is wrong is in the sentence — the reader is told what
  // this page is and what the target is — and splitting it into two codes would offer a caller
  // a distinction no author needs.
  return guard(
    relation,
    "decides-needs-adr-to-rfc",
    `\`${key}:\` is legal only from ${article(rule.from)} to ${article(rule.to)}. This page ` +
      `is ${article(sourceDocType)} and \`${relation.ref}\` is ${article(target)}, because ` +
      `${rule.because}. Use \`related:\` for any other pairing.`,
  );
}

/**
 * Whether the cascade for this relation fires on **this** publish.
 *
 * The `ACCEPTED` precondition is read against the status the page is **being published into**,
 * not the one it is in now: publish decides the destination (`defaultPublishStatus`, or the
 * frontmatter's `status:`), and asking about the current status would fire a cascade one publish
 * late — the publish that *accepts* an ADR is exactly the one that must retire what it
 * supersedes.
 *
 * **And it gates the cascade rather than refusing the relation**, which is the part worth
 * arguing. An ADR's first publish lands at `PROPOSED` (`FIRST_PUBLISH.ADR`), and a proposal
 * saying "this would retire ADR-0030" is the normal, useful shape of a decision under review —
 * it is what a reviewer needs to see. Refusing it would mean the declaration cannot be
 * published until the moment it is accepted, so the author would have to add `supersedes:` in a
 * second edit at acceptance time: the intent would live in the author's head between the two
 * publishes, and §6.3's *"status is never maintained by hand in two places"* is the same
 * objection. So the relation row is written at `PROPOSED`, Task 9 can show it, and the cascade
 * fires on the publish that reaches `ACCEPTED`.
 *
 * Nothing here refuses a `PROPOSED` publish, and nothing here tells the author their cascade is
 * dormant. Saying so in the editor is Task 11's, and it needs this flag, not a rule of its own.
 */
function cascadeFor(type: RelationType, publishingInto: DocStatus): DocStatus | null {
  const status = CASCADE_INTO[type];
  if (status === null) return null;
  return publishingInto === CASCADE_REQUIRES ? status : null;
}

type WalkOutcome = "clear" | "cycle" | "budget-exhausted";

/**
 * Whether `from` already reaches `back` by following **stored** `SUPERSEDES` rows.
 *
 * Walked over `PageRelation`, never over the frontmatter — the frontmatter describes exactly one
 * edge, the one being added, and every page in the chain behind it was written by a different
 * publish, possibly by a different author, and is only in the database. A check written against
 * the declaration would be checking one edge against itself.
 *
 * ## Why walking from the target is the whole answer
 *
 * The edge under consideration is `source → target`. It closes a loop if and only if `target`
 * already reaches `source`, so the walk starts at the target and looks for the source. That is
 * complete even when a publish declares several `supersedes:` targets at once, because **every
 * new edge leaves the same page**: a cycle made only of new edges would need two different
 * sources, and one publish has one. So existing rows plus one new edge is the only shape a new
 * cycle can take, and this walk sees all of it.
 *
 * ## Two mechanisms, two failures
 *
 * The `visited` set is what detects the loop **and** what makes the walk terminate — those are
 * the same fact, which is why removing it does not merely lose a check, it hangs. Phase 1's
 * `buildTree` carries the same set for the same reason, and its cycle tests could not detect a
 * cyclic result until they were mutation-tested; the tests here are built the other way round,
 * from a chain actually closed in the database.
 *
 * The `budget` is a different failure: a very long **acyclic** chain terminates on its own, but
 * one round trip per level, inside the publish transaction. When the budget runs out the walk
 * stops and says so — `budget-exhausted`, never `clear` — and the caller refuses the publish
 * rather than writing an edge it could not verify.
 *
 * A cycle found on the same round as the exhaustion is reported as a cycle: the target check
 * runs before the budget is charged, so the more specific answer wins.
 *
 * ## Breadth-first, one query per level
 *
 * `fromId IN (frontier)` rather than one query per page: the levels are what cost round trips,
 * and `@@unique([fromId, toId, type])` puts `fromId` first in a btree, so the query is an index
 * scan. `type` is filtered in SQL — without it a `related:` link back to this page, which is
 * legal between any two pages and cheap to write, would read as a supersede cycle.
 *
 * ## The one query in this project with no permission predicate, and the argument for it
 *
 * Every query in Phases 1–2 states its own, and the rule that settled how — from
 * `resolveRedirect` — is *state it once, on the thing whose readability is the question, and let
 * the other filters carry shape constraints with their own tests.* Here nothing's readability is
 * the question: the walk returns no row, names no page, and its only observable is a boolean
 * about the caller's **own** page — whether the target the caller already resolved, through
 * queries that did carry `readableSpace`, comes back to the page they are publishing. There is
 * no answer here that a caller could not get by reading their own frontmatter.
 *
 * Nor can the walk leave the space: a relation is written only from a resolved reference, and
 * `resolveRelations` refuses a cross-space one syntactically, so every row it can traverse joins
 * two pages of one space. If a later phase allows cross-space relations, this is the paragraph
 * to come back to — the shape to add then is a space filter on `from`, not a viewer, because the
 * question would still not be "may this person read that page".
 *
 * ## It reads no `Page` row, deliberately
 *
 * Only `PageRelation.toId`, so the walk is blind to whether a page in the chain is
 * soft-deleted — and that is the correct blindness rather than a missing filter. A soft-deleted
 * page can be restored; a cycle hidden behind one would be admitted now and never looked at
 * again, because relations are only ever checked at publish time. The graph is refused as
 * stored. Registered in `src/lib/pages/visible.test.ts` as `reachesPage: false`, with the test
 * that pins the absence named there.
 */
async function walkSupersedeChain(
  tx: RelationGuardClient,
  args: { from: string; back: string; budget: { left: number } },
): Promise<WalkOutcome> {
  const { from, back, budget } = args;
  const visited = new Set<string>([from]);
  let frontier = [from];

  while (frontier.length > 0) {
    const rows = await tx.pageRelation.findMany({
      where: { fromId: { in: frontier }, type: "SUPERSEDES" },
      // Explicit select, never `include`. `toId` is all a reachability question needs.
      select: { toId: true },
    });

    const next: string[] = [];
    for (const { toId } of rows) {
      if (toId === back) return "cycle";
      if (visited.has(toId)) continue;
      visited.add(toId);
      next.push(toId);
    }

    budget.left -= next.length;
    if (budget.left < 0) return "budget-exhausted";

    frontier = next;
  }

  return "clear";
}

/**
 * Applies every guardrail to a resolved relation list.
 *
 * `args.source` is the page being published: its id, its doc type, and the status this publish
 * will set on it. Passed in rather than re-read, exactly as `resolveRelations` takes it — the
 * caller has already authorised and locked that row, and re-reading it inside the transaction
 * would be a second snapshot of a value the publish itself owns.
 *
 * Order matters and is not an implementation detail: the doc-type rules are pure and run first,
 * so an illegal relation is refused without spending a query, and the graph is walked only for
 * the relations that could still be written.
 */
export async function checkRelations(
  tx: RelationGuardClient,
  args: {
    source: { id: string; docType: DocType; publishingInto: DocStatus };
    relations: readonly ResolvedRelation[];
  },
): Promise<RelationCheck> {
  const { source } = args;
  const relations: CheckedRelation[] = [];
  const errors: RelationGuardError[] = [];

  // One budget for the call, not one per reference: 20 declared targets must not be able to
  // buy 20 walks. Shared, so the transaction's exposure is `MAX_SUPERSEDE_WALK` whatever the
  // frontmatter says.
  const budget = { left: MAX_SUPERSEDE_WALK };

  for (const relation of args.relations) {
    const endsFailure = endsError(relation, source.docType);
    if (endsFailure !== null) {
      errors.push(endsFailure);
      continue;
    }

    if (walksTheGraph(relation.type)) {
      // Walked whether or not the cascade fires. The row is written either way (Task 7), so the
      // *graph* gains the edge either way — and a cycle admitted by a `PROPOSED` publish would
      // already be stored by the time the accepting publish refused it.
      const outcome = await walkSupersedeChain(tx, {
        from: relation.page.id,
        back: source.id,
        budget,
      });

      if (outcome === "cycle") {
        errors.push(
          guard(
            relation,
            "supersede-cycle",
            `\`${relation.ref}\` already supersedes this page — directly, or through a chain ` +
              "of pages that ends here. Adding this would close the loop, and every document " +
              "in it would retire the next, leaving none of them in force. Point " +
              "`supersedes:` at the page this one replaces, or retire the existing chain first.",
          ),
        );
        continue;
      }

      if (outcome === "budget-exhausted") {
        errors.push(
          guard(
            relation,
            "chain-too-long",
            `\`${relation.ref}\` sits in a chain of more than ${MAX_SUPERSEDE_WALK} superseded ` +
              "pages, which is further than this check will walk while a publish is open, so " +
              "it cannot rule out a loop. A lineage that long is a sign the relations are " +
              "wrong rather than that the history is long: report it rather than working " +
              "around it.",
          ),
        );
        continue;
      }
    }

    relations.push({
      ...relation,
      cascade: cascadeFor(relation.type, source.publishingInto),
    });
  }

  const [first, ...rest] = errors;
  if (first !== undefined) return { ok: false, errors: [first, ...rest] };

  return { ok: true, relations };
}
