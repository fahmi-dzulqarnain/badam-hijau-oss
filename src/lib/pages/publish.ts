import type { DocStatus, DocType, Prisma, RelationType } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { writeAudit } from "@/lib/audit/log";
import { visiblePage } from "@/lib/pages/visible";
import { defaultPublishStatus, validateTransition } from "@/lib/pages/transition";
import { stripControl } from "@/lib/text/control";
import { splitFrontmatter, type FrontmatterErrorCode } from "@/lib/markdown/frontmatter";
import { enqueueMirrorJobs } from "@/lib/git/enqueue";
import { searchFieldsOf } from "@/lib/search/fields";
import {
  KEY_FOR_RELATION,
  validateFrontmatter,
  type FrontmatterSchemaErrorCode,
  type RelationKey,
  type ValidatedFrontmatter,
} from "@/lib/lifecycle/schema";
import { resolveRelations, type RelationRefusalCode } from "@/lib/lifecycle/resolve";
import {
  replaceSystems,
  resolveSystems,
  type SystemRefusalCode,
} from "@/lib/systems/resolve";
import {
  article,
  checkRelations,
  dormantCascade,
  type CheckedRelation,
  type RelationGuardCode,
} from "@/lib/lifecycle/relations";
import type { Viewer } from "@/lib/authz/types";

/** The fields a rejection can be attached to, so the editor renders it in place. */
export type PublishField = "title" | "markdown" | "status";

/**
 * Every reason a publish can be refused with a field error.
 *
 * The five unions are **imported, not restated**. Frontmatter validation, schema validation,
 * reference resolution, the relation guardrails and — Phase 7 Task 2 — systems resolution each
 * own their own codes and each has its own module and tests; a copy of those names here would be
 * a second list that agrees on the day it is written. It also means a caller that switches on a code is switching on the same
 * value the module that produced it exported — Task 11's editor surface, and Phase 4's search
 * indexer, both need that.
 */
export type PublishErrorCode =
  | "title-empty"
  | "draft-empty"
  /**
   * The draft is not empty and its **body** is: frontmatter, and nothing under it.
   *
   * Task 7 found this and handed it to Task 11 as "refuse, or warn". It is a refusal, and it is
   * a **second code beside `draft-empty` rather than a widening of it**, which is the part the
   * plan flagged as a Phase 2 rule with its own message and test.
   *
   * *Refuse, not warn.* The reader is handed a title over a blank page — before Task 2 that
   * block rendered as visible garbage, so at least something was there; now it renders as
   * nothing, and nothing is indistinguishable from a rendering bug. There is also no mechanism
   * for a warning that is not a new one: publish is a single round trip with a boolean outcome,
   * so "warn" means either a message nobody has to read or a confirm-and-resend handshake with a
   * "yes I meant it" flag — a second control path for a document nobody wants to publish. The
   * shape Phase 2 settled — *a draft accepts what publish refuses* — already covers this: the
   * author keeps the draft, keeps every character, and is told what is missing.
   *
   * *Beside `draft-empty`, not instead of it.* They are two different situations and the useful
   * sentence differs: one is "you have written nothing", the other is "you have written only
   * metadata". Rewriting `draft-empty` to measure `split.body` would have made the whole-document
   * case unreachable and retired a Phase 2 message that is still correct for it. Both are
   * reachable and both are tested — the order below is what decides which one an entirely blank
   * draft gets, and it gets `draft-empty`.
   */
  | "body-empty"
  | "no-draft"
  | "draft-is-not-a-destination"
  | "illegal-transition"
  /**
   * This module's own, and the only code Task 8 adds: a declared relation would cascade a
   * status onto its target that the target's vocabulary cannot reach from where it is.
   *
   * Native here rather than imported, because the rule is this module's. `checkRelations`
   * decides *whether a cascade is eligible to fire* and says in as many words that whether it
   * may **land** is not its question; `validateTransition` answers that against
   * `PUBLISHABLE_INTO`. Only the transaction that holds the target's row lock can ask it about
   * the status the target is actually in, so the code belongs where the lock is.
   */
  | "cascade-illegal-transition"
  /** `src/lib/markdown/frontmatter.ts` — the block did not parse, or breached a cap. */
  | FrontmatterErrorCode
  /** `src/lib/lifecycle/schema.ts` — it parsed and the doc type does not accept it. */
  | FrontmatterSchemaErrorCode
  /** `src/lib/lifecycle/resolve.ts` — a relation names no page this viewer can relate to. */
  | RelationRefusalCode
  /** `src/lib/lifecycle/relations.ts` — the relation is legal to write and illegal to mean. */
  | RelationGuardCode
  /**
   * `src/lib/systems/resolve.ts` — a declared `systems:` key names nothing in the catalogue.
   *
   * The refusal, rather than an accept-and-report, is argued at length in that module: it is the
   * same rule Task 1 chose when it made `PageSystem.systemId` `onDelete: Restrict`, and the
   * corpus measurement that makes it affordable — no page in the seed or the dev database
   * declares a system at all — is recorded there too.
   */
  | SystemRefusalCode;

export type PublishFieldError = {
  field: PublishField;
  /**
   * The frontmatter key at fault, or `null` when the fault is not attributable to one.
   *
   * Carried because `field` alone cannot deliver what the plan promised: frontmatter has no
   * input of its own — it is the first few lines of the one textarea — so `field: "markdown"`
   * can only underline the whole pane, and "your frontmatter is wrong, somewhere in these six
   * lines" is not a message anyone can act on. `FrontmatterKeyError` and `RelationRefusal`
   * both already carry it; dropping it at this boundary would throw away the only thing that
   * lets Task 11 point at the offending line.
   */
  key: string | null;
  code: PublishErrorCode;
  message: string;
};

/**
 * A relation this publish **wrote** and did **not** act on — Task 11's dormant cascade.
 *
 * Not an error and not a warning that could have been avoided: publishing a proposal that says
 * what it would retire is the shape a reviewer needs, and `cascadeFor` argues at length why the
 * relation is written at `PROPOSED` rather than deferred to a second edit at acceptance time.
 * What was missing was anyone *saying so*. It travels on the **success** result for that reason:
 * the publish happened, the row exists, and this is an account of what it did rather than a
 * reason it did not.
 *
 * `ref` is the author's own line, so the sentence can quote what they typed rather than the
 * target's current path — which a move may since have changed.
 */
export type DormantCascade = {
  type: RelationType;
  /**
   * The frontmatter key that declared it — `supersedes`, `decides`.
   *
   * Carried rather than derived by the reader, because `KEY_FOR_RELATION` lives in
   * `src/lib/lifecycle/schema.ts` beside `zod` and the whole per-doc-type table, and the reader
   * here is a client component. Re-deriving it there would put a second copy of the one map
   * that exists to have no second copy — the same argument `article` settled when the cascade
   * refusal needed a four-character helper.
   */
  key: RelationKey;
  /** Verbatim what the author wrote in the frontmatter. */
  ref: string;
  /** Where the target would go once this page reaches the status the cascade is gated on. */
  wouldRetireInto: DocStatus;
};

export type PublishedPage = {
  id: string;
  path: string;
  spaceKey: string;
  title: string;
  status: DocStatus;
  publishedAt: Date;
  versionId: string;
  /**
   * Empty on almost every publish, and **always present** — the reason `accessDetail` and
   * `RelationDiff` give for their own always-present fields: a key that appears on some results
   * and not others cannot be told from a key somebody forgot to plumb.
   */
  dormant: DormantCascade[];
};

export type PublishResult =
  | { ok: true; page: PublishedPage }
  /**
   * The page does not exist, is soft-deleted, or sits in a space this viewer cannot read —
   * one answer for all three, and never a 403, which would confirm the page is real. Tasks
   * 4, 6, 7 and 8 all draw this line in the same place and the five must not diverge.
   *
   * It is also the answer when the page is soft-deleted *during* the transaction; see the
   * write predicate on the page update below.
   */
  | { ok: false; reason: "not-found" }
  /**
   * Readable but not publishable — a `VIEWER` in the space, or anyone in an `ALL_STAFF`
   * space they do not belong to. Safe to be specific: they can already see the page.
   */
  | { ok: false; reason: "forbidden" }
  /**
   * Something about the draft, its frontmatter, its relations or the transition. Always
   * attached to a field, never thrown.
   *
   * **`error` and `errors` both, and that is Task 7's answer to a question the plan gives to
   * Task 11.** Three of the four modules this now calls return *every* error rather than the
   * first — frontmatter is several keys written in one pass, and fixing them one publish
   * attempt at a time is a bad loop — while this result carried a single `error`. The choices
   * were: take `errors[0]` and drop the rest, or make the field plural and change every
   * consumer.
   *
   * Neither, because both give something up. `error` stays exactly what it was, so the route,
   * the editor and every existing test keep working and no surface had to be redesigned by the
   * task that happens to have plumbed the errors; `errors` carries all of them, non-empty by
   * construction, with `errors[0] === error` as an invariant a test pins. Nothing is dropped
   * and nothing is broken, and Task 11's actual decision — which of them the *editor renders*,
   * and against which line — is untouched and still open.
   */
  | {
      ok: false;
      reason: "invalid";
      /** The first of `errors`. Kept for every caller written before frontmatter existed. */
      error: PublishFieldError;
      errors: [PublishFieldError, ...PublishFieldError[]];
    };

const invalid = (error: PublishFieldError): PublishResult => ({
  ok: false,
  reason: "invalid",
  error,
  errors: [error],
});

/**
 * The same refusal from a module that reports all of its errors at once.
 *
 * Takes a non-empty tuple rather than an array, so "there is at least one error" is checked by
 * the compiler at each of the three call sites instead of by a runtime guard that would need a
 * branch no test could reach. `FrontmatterKeyError`, `RelationRefusal` and `RelationGuardError`
 * are all structurally `PublishFieldError` already — same four fields, and their code unions are
 * members of `PublishErrorCode` — so nothing is mapped or rewritten on the way through. The
 * extra fields the relation errors carry (`type`, `ref`) travel with them harmlessly; they are
 * exactly what a future surface would want and inventing a narrowing here would discard them.
 */
const invalidAll = (
  all: readonly [PublishFieldError, ...PublishFieldError[]],
): PublishResult => {
  const [first, ...rest] = all;
  return { ok: false, reason: "invalid", error: first, errors: [first, ...rest] };
};

/**
 * Thrown to abort the transaction when the page stops being publishable *after* the version
 * row has been inserted — the only mid-write abort in this module. Rolling back is the point:
 * see the write predicate on the page update.
 *
 * A sentinel class rather than a bare `Error` so the catch below cannot swallow a genuine
 * database failure and report it as a missing page.
 */
class PageNoLongerPublishable extends Error {}

/** What the locked read of the draft returns. */
type LockedDraft = { title: string; markdown: string };

/**
 * Whatever can write `PageRelation`. Structural and named `tx` for the two reasons
 * `RelationClient` and `RelationGuardClient` are: the caller passes its **transaction**
 * client, and the sweep in `src/lib/pages/visible.test.ts` matches `db.`/`tx.` delegate calls,
 * so a parameter named anything else would hide two writes from it.
 */
type RelationWriteClient = Pick<Prisma.TransactionClient, "pageRelation">;

/**
 * One relation edge leaving the page being published, as the audit trail records it.
 *
 * `toId`, not the reference the author wrote and not the target's path. The reference is a path
 * that resolves differently over time — through a redirect, or not at all once a later move
 * replaces it — and the path itself moves; the id is what the row held and the only thing that
 * still names the same page a year later. It is also the only field an added and a removed entry
 * can share: a removed row has no reference, because the frontmatter that declared it is gone.
 */
type RelationEdge = { type: RelationType; toId: string };

/**
 * What one publish did to this page's relation rows — Task 8's fourth decision.
 *
 * ## A removed relation IS audited, and so is an added one
 *
 * Task 7 recorded that a deleted `PageRelation` row leaves no trace, called it reconstructible
 * from the version chain's stored frontmatter, and handed the judgement here. Two things
 * decided it:
 *
 * - **"Reconstructible" is weaker than it sounds.** `PageVersion.frontmatter` stores the
 *   *references* validation accepted — `decisions/adr-0031` — not the edges that were written.
 *   Recovering an edge from them means re-resolving that path *as it would have resolved then*,
 *   through `Redirect` rows a later move may have replaced and a later delete may have removed.
 *   So the version chain reconstructs the author's **intent**, and the audit question is about a
 *   **write**. They are not the same object, and only one of them is what Task 9's banner reads.
 * - **Removal has a consequence nothing else records.** Dropping `supersedes:` deletes the row
 *   and deliberately does *not* un-retire the target — reversing a cascade is a decision no
 *   phase has taken, and inventing one here would be a second place a status is maintained. So
 *   after a removal the target is `SUPERSEDED` with nothing left saying what superseded it, and
 *   this row is the only account of how it got there.
 *
 * **Both directions, not only removal**, because a trail that records deletions and not
 * insertions reads as though relations only ever disappear, and the diff costs one query either
 * way. **Always present, even when both are empty**, for the reason `accessDetail` gives for its
 * own fields: a key that appears on some rows and not others cannot be told from a key somebody
 * forgot to plumb.
 *
 * ## Not its own audit action
 *
 * One row per mutation is this project's audit envelope, and a relation change is not a mutation
 * of its own — it is part of the publish, by the same actor, in the same transaction, and it is
 * meaningless without the version it accompanied. So it travels in `page.publish`'s `detail`.
 * The **cascade** is the opposite case and gets its own row: it changes a *different page*, and
 * `AuditLog` is indexed by `pageId` precisely so "what happened to this page" can be answered
 * without reading every other page's rows.
 */
type RelationDiff = { added: RelationEdge[]; removed: RelationEdge[] };

/**
 * `type` and `toId` as one string, so a `Set` or a `Map` can key on an edge.
 *
 * NUL as the separator, written as an **escape** rather than as the literal byte it was until
 * Task 8: a literal control character is invisible in a diff, and — measured on this file — it
 * also made `rg` classify the whole module as binary and skip it silently, which is the exact
 * failure mode PROGRESS's tooling-trap section is about. It cannot occur in a `RelationType` or
 * a cuid, so no pair can collide by concatenation.
 */
const edgeKey = (edge: RelationEdge): string => `${edge.type}\u0000${edge.toId}`;

/**
 * Makes the `PageRelation` rows leaving this page **exactly** the ones the frontmatter
 * declares — spec §9 step 4.
 *
 * ## Removal is half the job, and it is the half that gets forgotten
 *
 * An author who deletes `supersedes:` and republishes is saying the relation was wrong.
 * Leaving the row would make the frontmatter and the database disagree with no way to tell
 * which is right — and the database is what Task 9's banner reads, so the page would keep
 * claiming to retire something the document no longer mentions.
 *
 * Task 3 made this safe to do unconditionally on purpose: `ValidatedFrontmatter.relations`
 * always carries all four `RelationType` keys, empty where nothing was declared, so "declared
 * nothing" and "did not mention the key" are the same value. `undefined` never has to mean
 * "leave the rows alone", and a doc type that cannot declare `supersedes:` at all removes zero
 * relations, correctly, without a special case.
 *
 * ## Delete-then-insert, not delete-all-then-insert-all
 *
 * The `NOT` on the delete is what makes republishing unchanged frontmatter **idempotent
 * without churn**: a row that is still declared is not touched, so its `createdAt` keeps
 * saying when the relation was first asserted rather than when it was last republished. Task 9
 * shows that date on a retired page's banner ("superseded on…"), so re-stamping it on every
 * typo fix would be a visible lie. Deleting everything and reinserting would pass a row-count
 * test and fail that one, which is why the test pins the timestamp.
 *
 * `skipDuplicates` covers the other side: `@@unique([fromId, toId, type])` makes the insert a
 * no-op for a row that survived the delete.
 *
 * ## Deduplicated here, deliberately not there
 *
 * `resolveRelations` returns two entries for two references that resolve to the same page — a
 * `related:` naming both a page's current path and its pre-move path is the real case — and
 * says in as many words that collapsing them is the *upsert's* problem. So it is collapsed
 * here, before the `NOT` list is built, rather than left to `ON CONFLICT`: a duplicate that
 * reached the delete's `NOT` would be harmless, and one that reached `createMany` would rely on
 * a Postgres subtlety about speculative insertion within a single statement. One `Map` is
 * cheaper than that argument.
 *
 * ## No permission predicate, and the reason is not the same as the walk's
 *
 * Both statements are keyed on `fromId` — the page this publish has already authorised, locked
 * and is writing a version for. They name no other page's readability: every `toId` came from
 * `resolveRelations`, whose three queries each carried `readableSpace` and `visiblePage`, so an
 * unreadable or soft-deleted target never reaches here. Restating that here would be the
 * `resolveRedirect` mistake — a predicate stated twice is a predicate neither statement can be
 * tested for.
 *
 * The delete deliberately does **not** filter the target either, and that direction matters:
 * a relation pointing at a page that has since been soft-deleted must still be removable by
 * an author who drops the key, or the frontmatter could never be brought back into agreement
 * with the database.
 *
 * ## It takes no lock order, which is why Task 8's ordering rule is still Task 8's
 *
 * The insert takes a foreign-key `KEY SHARE` lock on each target `Page` row, which conflicts
 * with `FOR UPDATE` and not with the `FOR NO KEY UPDATE` the page update above takes. So two
 * publishes declaring relations to each other's pages do not deadlock on these statements —
 * the hazard the plan flags arrives with Task 8's cascade, which *updates* the target's status
 * and therefore has to lock by ascending page id.
 */
async function replaceRelations(
  tx: RelationWriteClient,
  args: { fromId: string; relations: readonly CheckedRelation[] },
): Promise<RelationDiff> {
  const { fromId } = args;

  const byEdge = new Map<string, RelationEdge>();
  for (const relation of args.relations) {
    byEdge.set(edgeKey({ type: relation.type, toId: relation.page.id }), {
      toId: relation.page.id,
      type: relation.type,
    });
  }
  const declared = [...byEdge.values()];

  // Read for the **record**, not for the write — Task 8's audit decision, see `RelationDiff`.
  //
  // The two statements below are unchanged and still key on `NOT` and `skipDuplicates`, because
  // that is what leaves an unchanged row's `createdAt` alone. Rewriting them to delete the
  // `removed` list and insert the `added` one would make this diff load-bearing for
  // correctness, and "republishing unchanged relations touches neither the row nor its
  // createdAt" would then be testing the diff rather than the statements.
  //
  // No permission predicate and no soft-delete filter, for the same reasons the two writes
  // below carry none: it is keyed on `fromId`, the page this publish has already authorised and
  // locked. It must be able to see a row pointing at a soft-deleted page, or removing one would
  // go unrecorded — which is the case "a relation to a page deleted afterwards can still be
  // removed by republishing without it".
  const before = await tx.pageRelation.findMany({
    where: { fromId },
    // Explicit select, never `include`.
    select: { toId: true, type: true },
  });

  const declaredKeys = new Set(declared.map(edgeKey));
  const beforeKeys = new Set(before.map(edgeKey));
  const diff: RelationDiff = {
    added: declared.filter((edge) => !beforeKeys.has(edgeKey(edge))),
    removed: before.filter((edge) => !declaredKeys.has(edgeKey(edge))),
  };

  // Everything this page declared last time and does not declare now. With nothing declared
  // there is no `NOT` to write and every row leaving this page goes.
  await tx.pageRelation.deleteMany({
    where: declared.length === 0 ? { fromId } : { fromId, NOT: { OR: declared } },
  });

  if (declared.length > 0) {
    await tx.pageRelation.createMany({
      data: declared.map((edge) => ({ fromId, toId: edge.toId, type: edge.type })),
      skipDuplicates: true,
    });
  }

  return diff;
}

/** A `Page` row read under `FOR UPDATE`, for the cascade. */
type LockedPage = { id: string; path: string; docType: DocType; status: DocStatus };

/**
 * A checked relation that **does** cascade, narrowed by the compiler rather than re-tested.
 *
 * `CheckedRelation.cascade` is nullable and the predicate that reads it is stated exactly once,
 * at the `filter` in `publishPage`, as a type guard. So `planCascades` has no null branch to
 * carry — which matters because a branch no test can reach is a branch nobody can trust, and
 * "the relation does not cascade" is unreachable inside a function only reached for ones that do.
 */
type CascadingRelation = CheckedRelation & { cascade: DocStatus };

/** A cascade that has been decided and may now be written. */
type PendingCascade = {
  target: LockedPage;
  /** Where the target lands. Validated through `PUBLISHABLE_INTO`, never assumed. */
  to: DocStatus;
  /** Which declaration caused it — for the audit row, and for a refusal's message. */
  type: RelationType;
  ref: string;
};

/**
 * Whatever can lock and update `Page` rows. Structural, and named `tx` for the reason every
 * other client type here is: the soft-delete sweep in `src/lib/pages/visible.test.ts` matches
 * `db.`/`tx.` calls, and Task 8 widened it to raw statements as well — the locking read below is
 * a `tx.$queryRaw`, which no delegate pattern can see. That was the fifth time a guard in this
 * project could not see a whole category, and the first time the category was found before it
 * hid anything.
 *
 * `auditLog` is here only so `writeAudit` can be handed the same client — this module never
 * touches that delegate itself, which `tests/integration/audit.test.ts` sweeps for.
 */
type CascadeClient = Pick<Prisma.TransactionClient, "page" | "$queryRaw" | "auditLog">;

/**
 * Locks every `Page` row this transaction will write, in ascending id order, and returns them.
 *
 * ## The order *is* the function
 *
 * Publish wrote exactly one `Page` row until now — its own — so no ordering question could
 * arise, which is what Task 7 measured and recorded. A cascade writes a second one, and two
 * ADRs superseding each other concurrently is the case: publish A wants rows A and B, publish B
 * wants rows B and A, and in opposite orders that is a deadlock — Postgres kills one of them
 * with a 40P01 that no branch here has an honest answer for. **Ascending page id**, and
 * **including the publishing page's own row**, because A's own row is B's target and B's own row
 * is A's target; ordering only the targets among themselves would leave exactly that cycle open.
 *
 * One statement rather than one per row, so there is no window between two locks for a competing
 * transaction to slot into. `ORDER BY … FOR UPDATE` locks in sorted order rather than in
 * whatever order the plan reads the heap in, because `LockRows` sits **above** `Sort` in the
 * plan — checked with `EXPLAIN` on this statement, not assumed.
 *
 * `COLLATE "C"` makes that order byte order. Without it the sort follows the database's
 * collation, so two deployments with different locales could lock in different orders — a
 * property that is invisible in every test and arrives in production as a deadlock. Ids are
 * cuids, so byte order is also what a JavaScript `.sort()` gives, which is what lets a test say
 * which row is taken first.
 *
 * ## What it does not filter, and what it does not read
 *
 * **No `deletedAt` filter.** A target soft-deleted between resolution and this lock is caught by
 * the *write* predicate instead — `visiblePage()` on the cascade's `updateMany`, which matches
 * nothing and aborts the transaction — exactly as the page update catches a soft delete of the
 * publishing page. Stating it here as well would be one rule in two places, and the copy that
 * is a write predicate is the one that cannot be raced.
 *
 * **No permission predicate.** The argument is the cascade write's, and it is made there rather
 * than twice.
 *
 * The publishing page's own row is locked and its columns are deliberately **unused**: the
 * status this publish lands on was decided from the row read under the draft lock. It is in the
 * list for the ordering and for nothing else, which is why the caller looks up targets by id
 * rather than iterating what comes back.
 */
async function lockPagesForCascade(
  tx: CascadeClient,
  ids: readonly string[],
): Promise<Map<string, LockedPage>> {
  const rows = await tx.$queryRaw<LockedPage[]>`
    SELECT "id", "path", "docType", "status"
      FROM "Page"
     WHERE "id" = ANY(${[...ids]})
     ORDER BY "id" COLLATE "C"
       FOR UPDATE`;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Decides every cascade this publish will apply — spec §9 step 5, the *decision* half.
 *
 * Called with the rows already locked, and **before anything is written**, for the reason this
 * whole module is ordered the way it is: a refusal inside `$transaction` is a `return`, and
 * returning commits. A cascade found illegal after the version insert could only abort by
 * throwing a field error through a sentinel, and this task's refusal is an *expected* outcome,
 * not an exceptional one.
 *
 * ## Three outcomes, and the middle one is the landmine
 *
 * `checkRelations` says whether a cascade is **eligible** — the type cascades and this publish
 * reaches `ACCEPTED` — and says in as many words that whether it may **land** is not its
 * question. It lands, or does not, according to `PUBLISHABLE_INTO`:
 *
 * - **Nothing to do.** The target is *already* at the cascade status. Not a transition and not a
 *   refusal: no write, and no audit row, because nothing changed. This case is not an oddity —
 *   it is what **every republish of an accepted ADR** looks like, and treating it as a
 *   transition would ask `PUBLISHABLE_INTO` for `SUPERSEDED → SUPERSEDED`, which is terminal and
 *   therefore forbidden. An ADR that superseded another could then never be republished again:
 *   a typo fix would be refused for a cascade that had already happened.
 * - **A legal transition.** Validated through `validateTransition`, so the cascade cannot set a
 *   status the vocabulary forbids. §6.3's *"status is never maintained by hand in two places"*
 *   is precisely about this: the cascade is the second place, and it asks the same table.
 * - **A transition the vocabulary forbids** — the case Task 6 refused to decide and left here.
 *   An ADR at `PROPOSED` cannot reach `SUPERSEDED`; nor can one at `DRAFT`, or at a terminal
 *   status of its own.
 *
 * ## That last case refuses the whole publish, and does not skip the cascade
 *
 * Both options were open and this is the argument for refusing:
 *
 * - **Skipping is the divergence §6.3 exists to prevent.** It would write a `SUPERSEDES` row
 *   from an `ACCEPTED` ADR and leave the target at `PROPOSED`. Task 9 derives "superseded by X"
 *   from the row and the retired banner from the *status*, so the reader would be shown a page
 *   that both is and is not superseded. One action, both sides — or neither.
 * - **A skipped cascade is lost, not deferred.** Cascades fire from the *source's* publish.
 *   Nothing re-runs them when the target's status later changes, so a cascade skipped once is
 *   skipped for good unless a human happens to republish the source. Silence about a write that
 *   will never happen is the worst of the available outcomes.
 * - **The refusal is about something the author can fix, and it says which.** "This ADR
 *   supersedes a proposal that was never accepted" is a real objection to the *document*: you
 *   cannot retire a decision that was never in force. `related:`, or rejecting the proposal, or
 *   accepting it first, are all one edit away — and publishing at `PROPOSED` is not blocked at
 *   all, because no cascade is eligible there.
 * - **It keeps one authority for the vocabulary.** If refusing turns out to be too strict — an
 *   ADR that decides an `IN_REVIEW` RFC is the case most likely to bite — the fix is a row in
 *   `PUBLISHABLE_INTO`, which is where §6.1 says the vocabulary lives. Skipping would instead
 *   make the cascade a place where the vocabulary is quietly not enforced, and no table change
 *   would ever be requested.
 *
 * ## At most one cascade per target, derived rather than asserted
 *
 * The map is keyed by target id and cannot lose an entry: only `SUPERSEDES` and `DECIDES`
 * cascade, `SUPERSEDES` requires the target to share the source's doc type, and `DECIDES`
 * requires the target to be an `RFC` and the source an `ADR`. So one page cannot be the target
 * of both from one publish — an ADR's `SUPERSEDES` target is an ADR and its `DECIDES` target is
 * an RFC. Same shape as walking only `SUPERSEDES` for cycles: the collision is
 * *unrepresentable*, not merely unlikely.
 */
function planCascades(
  locked: Map<string, LockedPage>,
  relations: readonly CascadingRelation[],
): { pending: PendingCascade[]; errors: PublishFieldError[] } {
  const pending: PendingCascade[] = [];
  const errors: PublishFieldError[] = [];

  for (const relation of relations) {
    const target = locked.get(relation.page.id);
    if (target === undefined) {
      // The row was in the lock list and did not come back, so it was **hard**-deleted between
      // resolution and the lock. Unreachable through the product — nothing hard-deletes a
      // `Page`, Task 12 is a soft delete — and kept as a throw rather than a `!` because the
      // alternative is a `TypeError` with a worse message on a state that should be loud. It is
      // the same event the page update's zero row count reports, so it gets the same answer
      // rather than a second one.
      throw new PageNoLongerPublishable(
        `Cascade target ${relation.page.id} vanished mid-transaction`,
      );
    }

    // Already there: not a transition, so not validated as one. See the docstring — this is
    // every republish of an accepted ADR, and `SUPERSEDED → SUPERSEDED` is forbidden.
    if (target.status === relation.cascade) continue;

    // Through the same table `publishPage` used for its own transition. The status is the one
    // read **under the lock**, not the one `resolveRelations` saw, so a publish that accepted
    // the target while this transaction waited is taken into account; `docType` is read under
    // the lock too, so the whole question is asked of one snapshot.
    const transition = validateTransition({
      docType: target.docType,
      from: target.status,
      to: relation.cascade,
    });

    if (!transition.ok) {
      // `field: "markdown"` and the relation's own key, NOT the transition error's
      // `field: "status"`: the status control belongs to the page being published and this
      // fault is in a frontmatter line. The transition module's sentence is not reused either —
      // it says "cannot be published into", and the target is not being published.
      errors.push({
        field: "markdown",
        key: KEY_FOR_RELATION[relation.type],
        code: "cascade-illegal-transition",
        message:
          `\`${relation.ref}\` is at ${target.status}, and publishing this page would move it ` +
          `to ${relation.cascade}, which ${article(target.docType)} at ${target.status} cannot ` +
          "reach. A document can only be retired from a status it was actually in force in — " +
          `so accept \`${relation.ref}\` first, or retire it on its own page, or use ` +
          "`related:` to point at it without retiring it.",
      });
      continue;
    }

    pending.push({
      target,
      to: transition.status,
      type: relation.type,
      ref: relation.ref,
    });
  }

  return { pending, errors };
}

/**
 * Writes one cascade and audits it — spec §9 step 5's write half, plus step 7 for the far side.
 *
 * ## Authorization: nothing beyond what publishing this page already required, and why
 *
 * This is Task 8's second decision, and the honest answer is that **no additional permission
 * check belongs here — a second one could not be tested, because no viewer can reach this line
 * for whom it would answer differently.** The chain:
 *
 * - `publishPage` has already required `PUBLISH` on the **source page's space**.
 * - Every cascade target came from `resolveRelations`, whose queries each carry `readableSpace`
 *   and `visiblePage` and are each scoped to `source.spaceId`; and a reference naming another
 *   space is refused syntactically as `cross-space`. So in Phase 3 the target is **always in the
 *   source's space** — two independent mechanisms say so.
 * - The target's space therefore *is* the source's space, so `can(viewer, targetSpace, "EDIT")`
 *   is the same call on the same space as the check already made. Stating it again is the
 *   `resolveRedirect` mistake this project has recorded twice: a predicate written in two places
 *   is a predicate neither copy can be tested for.
 *
 * **Same-space is what makes that safe, and it is exactly what a later phase will widen.** If
 * cross-space relations are ever allowed, this argument collapses and the question becomes real:
 * may publishing in space A retire a page in space B, and on whose authority? So this write
 * carries `spaceId: page.spaceId` as a **shape** constraint — not a permission predicate, the
 * split PROGRESS insists on — and it fails *closed*: a phase that widens resolution without
 * revisiting this line gets a cascade that matches no row, a `PageNoLongerPublishable`, and a
 * rolled-back publish. Loud, rather than a silent write across a space boundary.
 *
 * ## A cascade is never a way to discover that a page exists
 *
 * The plan's hard constraint, and it is delivered upstream rather than here: an unreadable or
 * missing target is refused by `resolveRelations` with one shared `not-found` sentence, so no
 * cascade is ever *computed* for a page the viewer cannot read. There is nothing left here to
 * disclose — every id this function sees names a page the viewer resolved through a readable
 * query, in a space they hold `PUBLISH` on.
 *
 * ## `visiblePage()` on the write, for the reason the page update carries it
 *
 * Not a restatement of resolution's filter: that one was evaluated before the lock and answers
 * "was this a live page then". This is a **write predicate**, and it answers "is it still one" —
 * so a soft delete committing while this transaction waited on the lock matches nothing, the
 * count is zero, and the whole publish rolls back rather than setting a status on a page Task 12
 * promises is invisible.
 *
 * ## The audit row is the target's, not the source's
 *
 * `pageId` is the **target**. `AuditLog` is indexed by `pageId` precisely so "what happened to
 * this page" is answerable, and a page whose status changed with no row of its own would be a
 * page whose history says nothing happened. `actorId` is the publisher, who did cause it, and
 * `detail.byPageId`/`byVersionId` are what join this row back to the publish that fired it.
 *
 * `fromStatus`/`toStatus` rather than bare `from`/`to`, because `page.move` records a **path**
 * transition under those names and one key must not mean two things — the same reason
 * `page.publish` names them that way. `path` is stored for the reason every page audit stores
 * it: the target can be moved afterwards, and then nothing on the row says where it was.
 */
async function applyCascade(
  tx: CascadeClient,
  args: {
    cascade: PendingCascade;
    viewer: Viewer;
    /**
     * The page being published, as it was read **under the draft lock**.
     *
     * One space id, taken from here rather than from the pre-lock authorisation read. They
     * cannot differ — nothing moves a page between spaces — and two parameters holding one
     * value is how they start to.
     */
    source: { id: string; path: string; spaceId: string };
    versionId: string;
  },
): Promise<void> {
  const { cascade, source } = args;

  const cascaded = await tx.page.updateMany({
    // `visiblePage` owns the top level; `spaceId` is a shape constraint and not a permission
    // predicate. Neither helper is spread.
    where: visiblePage({ id: cascade.target.id, spaceId: source.spaceId }),
    // The status and nothing else. The target's `publishedVersionId` and `publishedAt` are
    // untouched on purpose: no new version of the target was authored, and inventing one would
    // put a version in its history that nobody wrote. Its last published `PageVersion.status`
    // therefore keeps saying what the target was when it was last published, and `Page.status`
    // says what it is now — which is the direction §6.3 asks for, since the page's status is
    // what the reader and Task 9's banner read.
    data: { status: cascade.to },
  });

  if (cascaded.count !== 1) {
    throw new PageNoLongerPublishable(
      `Cascade target ${cascade.target.id} stopped being writable mid-transaction`,
    );
  }

  await writeAudit(tx, {
    actorId: args.viewer.id,
    action: "page.cascade",
    // The target is in the source's space — that is what Phase 3 guarantees, and what makes
    // this cascade need no permission check of its own.
    spaceId: source.spaceId,
    pageId: cascade.target.id,
    detail: {
      path: cascade.target.path,
      fromStatus: cascade.target.status,
      toStatus: cascade.to,
      // Which relation retired it, so `SUPERSEDED` and `CLOSED` are distinguishable by cause.
      relation: cascade.type,
      byPageId: source.id,
      byPagePath: source.path,
      byVersionId: args.versionId,
    },
  });
}

/**
 * Publishes a page: spec §9 steps 1–5 and 7, all or nothing, in one transaction.
 *
 * ## Where the decisions happen, and why not where the plan draws step 4
 *
 * Spec §9 lists "upsert declared `PageRelation` rows" as step 4, after the version and the page
 * update, and the rows are written there. But **resolving and checking** those relations happens
 * before any row is written, above the version insert, and that is not a liberty — it is the
 * only shape that can refuse them.
 *
 * A refusal inside `db.$transaction` is a `return`, and returning **commits**. So a relation
 * refused after the version insert, the page update and the draft delete would have to abort by
 * throwing, and the only way to carry a field error out through a throw is to wrap it in a
 * sentinel and unwrap it in the catch — a second control path for the case that is *expected*,
 * not exceptional. Deciding first keeps this module's existing invariant intact instead: every
 * rejection returns before a single row is written, and `PageNoLongerPublishable` stays the one
 * mid-write abort there is. `publish.test.ts` asserts the whole snapshot on every refusal path
 * rather than the message, because a test that only checks the message passes against a
 * transaction that half-committed.
 *
 * The reads still happen **inside** the transaction, on `tx`, and that matters as much: a
 * reference resolved outside it would be resolved against a different snapshot than the one the
 * relation row commits into, and the supersede chain would be walked against a graph that could
 * have changed underneath.
 *
 * ## What this deliberately does not do
 *
 * Spec §9 is eight steps and this implements six of them. The rest belong to later phases
 * and are marked `TODO(phase-N)` **at the point in the sequence where they go**, so the
 * order stays discoverable from the code — the way Phase 1 marked its audit wiring point in
 * `repo.ts`. They are not stubbed. An empty function named `applyRelations` that a future
 * phase will "fill in" reads as done, and the next person to touch this would have to prove
 * it was not.
 *
 * ## Concurrency: what publish serialises against, and what it deliberately does not
 *
 * Tasks 6 and 10 take `pg_advisory_xact_lock(hashtext(spaceId))` because they mutate
 * `Page.path`, and the unique index on `(spaceId, path)` is a space-wide shared resource.
 * **Publish does not touch `path`**, so it takes no space lock: doing so would serialise
 * every publish in a space against every other publish, every create and every move, for a
 * resource none of them share.
 *
 * What publish must serialise against is everything that writes *this page's draft*, and
 * there are exactly two such things: another publish of the same page, and an autosave of
 * the same page. Both are keyed by `pageId`, so the lock is per-page — and the natural
 * per-page lock is the draft row itself, which is why the first statement in the transaction
 * is a `SELECT … FOR UPDATE` on `PageDraft`.
 *
 * That one lock closes both races, and it closes the second one — which is the dangerous
 * one — without asking `saveDraft` to change at all:
 *
 * - **Publish versus publish.** The second publish blocks on the lock. When the first
 *   commits, its `DELETE` is visible, and Postgres re-evaluates the locking read against the
 *   new row version: no rows. The second publish answers `no-draft` and writes nothing.
 *   Without the lock, both would read the same draft under MVCC and insert two identical
 *   `PageVersion` rows, one of which nothing points at and both of which appear in history.
 * - **Publish versus autosave.** This is the data-loss one. The draft is read *under* the
 *   lock, so no autosave can land between the read and the `DELETE` — which is precisely the
 *   interleaving that would publish stale text and then destroy the newer text on its way
 *   out, telling the editor "Saved" a second earlier. An autosave already in flight blocks
 *   on the same row, and when it unblocks its own `WHERE "updatedAt" = …` predicate no
 *   longer matches a row that exists, so it becomes the 409 with `theirs: null` that Task 5
 *   already specified and Task 7 already renders. An autosave that got there *first*
 *   commits, and publish then reads the newer text and publishes that.
 *
 * A soft delete arriving mid-transaction is handled by a write predicate rather than by a
 * second lock — see the page update.
 *
 * **Task 8's cascade adds the one thing this page-scoped reasoning did not cover: a second
 * `Page` row.** A publish that retires another page writes to a row another publish may be
 * writing to at the same time, and two ADRs superseding each other concurrently want the same
 * two rows in opposite orders. That is the only ordering hazard in this module and it is closed
 * by one statement — see `lockPagesForCascade`, which takes every row this transaction will
 * write, this page's own included, in ascending id order before anything is written. The draft
 * lock above is per-page and cannot join that cycle: two publishes of different pages hold
 * different draft rows, and nothing else in the codebase locks a `PageDraft` row at all.
 *
 * ## `vanished` is real from here on
 *
 * Deleting the draft is what makes `decideSave`'s `vanished` branch reachable: every editor
 * with this page open is now holding a `seen` for a row that does not exist. `saveDraft`
 * answers `vanished` and writes nothing, which is the only answer that does not silently
 * resurrect pre-publish text over the version that just went out.
 * `tests/integration/publish.test.ts` walks that whole sequence — open, publish, autosave
 * with the stale `seen` — rather than trusting this paragraph.
 */
export async function publishPage(
  viewer: Viewer,
  pageId: string,
  options: {
    /**
     * The status to publish into. Omitted by every caller in Phase 2, which is why
     * `defaultPublishStatus` exists: a first publish enters the doc type's vocabulary and a
     * republish stays where it is.
     *
     * **Phase 3 fills it from the frontmatter's `status:` when nothing is passed**, which is
     * what the Phase 2 note here promised, and the precedence is stated where it is applied
     * below. No product caller passes it: the route reads no body, so this parameter is what a
     * test, the seed and the e2e helper use to drive a publish by hand.
     */
    status?: DocStatus;
  } = {},
): Promise<PublishResult> {
  // Authorisation first, outside the transaction and before any lock: the cheapest refusal
  // path should not open a transaction, and an unauthorised caller should never take a row
  // lock on someone else's draft. Only what `can()` needs plus the space key the caller
  // needs to build a reader URL — `canEditPage` reads the same shape for the same reason.
  //
  // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage` owns
  // the top level and `readableSpace` is passed whole as the `space` relation filter.
  // Explicit `select`, never `include`.
  const authorised = await db.page.findFirst({
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    select: { id: true, space: { select: { id: true, key: true, visibility: true } } },
  });
  if (!authorised) return { ok: false, reason: "not-found" };

  // `PUBLISH`, not `EDIT`. They resolve to the same roles today and they are not the same
  // question: spec §8 lists them separately, and an approval gate (a v1 non-goal) would
  // split them here and nowhere else.
  if (!can(viewer, authorised.space, "PUBLISH")) return { ok: false, reason: "forbidden" };

  const spaceKey = authorised.space.key;

  try {
    return await db.$transaction(async (tx): Promise<PublishResult> => {
      // The lock, and the read of the text being published, in one statement. See the
      // concurrency note above for why this row and not the space.
      //
      // Raw, because Prisma has no `FOR UPDATE`. A `findUnique` here would take no lock at
      // all, read the row under MVCC, and reintroduce both races.
      const locked = await tx.$queryRaw<LockedDraft[]>`
        SELECT "title", "markdown"
          FROM "PageDraft"
         WHERE "pageId" = ${pageId}
           FOR UPDATE`;

      const draft = locked[0];
      if (locked.length === 0 || draft === undefined) {
        // Either the page never had a draft, or a publish that got here first deleted it.
        // Nothing has been written at this point, so returning is a clean no-op — which is
        // the whole of "publishing twice in a row fails cleanly rather than writing an
        // empty version".
        return invalid({
          field: "markdown",
          key: null,
          code: "no-draft",
          message:
            "There is nothing to publish: this page has no draft. It may have been " +
            "published already — reload to see the current version.",
        });
      }

      // Read AFTER the lock, so the transition is validated against the status as of the
      // lock rather than as of the authorisation read above. At READ COMMITTED each
      // statement takes a fresh snapshot, so this sees anything that committed while we were
      // waiting. It restates both predicates rather than trusting the earlier read: this
      // module's queries are never guarded by call ordering.
      const page = await tx.page.findFirst({
        where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
        // `spaceId` is read here rather than taken from the authorisation read above, for the
        // same reason `status` is: this query is the one that ran under the lock. Relation
        // resolution is scoped to it, and no query below trusts the pre-lock snapshot.
        select: { id: true, path: true, spaceId: true, docType: true, status: true },
      });
      if (!page) return { ok: false, reason: "not-found" };

      // Spec §9 step 1, the frontmatter half. Two modules and two different failures.
      //
      // The block is found and parsed by the same declaration the renderer strips with, so the
      // keys validated here are exactly the ones that will not appear in the published body.
      // A failure here is the document not being *readable* as frontmatter — malformed YAML, a
      // breached cap, a cyclic anchor — and it has no key to attach to.
      //
      // Note which text this reads: `draft.markdown`, taken under the lock. Not
      // `PageDraft.frontmatter`, which nothing writes — the author's frontmatter is the first
      // few lines of the one textarea they type in, and a second copy in a column would be a
      // second source of truth for the same characters.
      const split = splitFrontmatter(draft.markdown);
      if (!split.ok) {
        return invalid({
          field: split.error.field,
          key: null,
          code: split.error.code,
          message: split.error.message,
        });
      }

      // And the half that needs a doc type: which keys this page may declare, and what their
      // values may be. Every error, not the first — see `PublishResult`'s `errors`.
      const validated = validateFrontmatter({
        docType: page.docType,
        frontmatter: split.frontmatter,
      });
      if (!validated.ok) return invalidAll(validated.errors);
      const frontmatter: ValidatedFrontmatter = validated.frontmatter;

      // Stripped BEFORE the emptiness test, exactly as `createPage` does it: a title of
      // nothing but control characters is an empty title, and storing it would give the page
      // a blank breadcrumb and a blank nav entry. `stripControl` is imported, never copied.
      const title = stripControl(draft.title).trim();
      if (title.length === 0) {
        // Task 5 allows an empty title at autosave on purpose — an editor clearing the field
        // to retype it must not have saving start failing mid-keystroke. Publish is where
        // that stops being acceptable, and it is a field error rather than a 500 because the
        // person can fix it in the box it names.
        return invalid({
          field: "title",
          key: null,
          code: "title-empty",
          message: "Give the page a title before publishing it — it is what readers see " +
            "in the nav rail, the breadcrumbs and search results.",
        });
      }
      // No upper bound checked here, deliberately. `TITLE_MAX_LENGTH` is enforced by
      // `draftSaveInput` on the way in, which is the only way a title reaches the row, and a
      // second copy of the rule here would be a branch no test could reach through the API.

      // The body is tested for emptiness on a trimmed copy and stored UNTRIMMED and
      // UNSTRIPPED. That asymmetry is deliberate: the preview pane rendered exactly these
      // bytes through `renderMarkdown`, so normalising them on the way into `PageVersion`
      // would make the published page differ from the preview that was approved — the one
      // divergence the preview exists to rule out. (A NUL cannot be in the row: Postgres
      // rejects it, which is why the autosave endpoint strips on the way in.)
      if (draft.markdown.trim().length === 0) {
        return invalid({
          field: "markdown",
          key: null,
          code: "draft-empty",
          message:
            "There is nothing in this draft to publish. Write something first, or delete " +
            "the page.",
        });
      }

      // And the case the whole-document test cannot see: a draft that is **only** frontmatter.
      // `split.body` is what the renderer will be given — the same declaration strips it — so
      // this measures the text a reader would actually get, which is empty for
      // `---\nstatus: ACCEPTED\n---`. See `body-empty` for why this is a refusal, and why it is
      // a second code rather than a rewrite of the one above.
      //
      // Trimmed for the comparison and never for storage, exactly as the check above is: the
      // preview pane rendered these bytes and the version must hold the same ones.
      if (split.body.trim().length === 0) {
        return invalid({
          field: "markdown",
          key: null,
          code: "body-empty",
          message:
            "This draft is only frontmatter, so the published page would be a title over a " +
            "blank page. Write the document below the closing `---`.",
        });
      }

      // Spec §9 step 1, the status half — and the frontmatter is now one of its three sources.
      //
      // Precedence: an explicit request from the caller, then the `status:` the author
      // declared, then the doc type's default. The middle term is the new one and it is not
      // optional politeness: `validateFrontmatter` has just accepted that key, and this row's
      // `frontmatter` column is about to record it, so ignoring it would publish a version
      // whose stored frontmatter says `ACCEPTED` over a page whose status says `PROPOSED` —
      // §6.3's "status is never maintained by hand in two places" broken by the one write that
      // is supposed to enforce it. It is also what makes a cascade reachable from a document
      // rather than only from a test's `options.status`.
      //
      // Membership and transition are different questions and both are asked. Task 3 checked
      // that the key names a status this doc type can ever be published into;
      // `validateTransition` checks whether it may be reached from the status the page is in
      // now, which is a row and cannot be known without one.
      const requested =
        options.status ?? frontmatter.status ?? defaultPublishStatus(page.docType, page.status);
      const transition = validateTransition({
        docType: page.docType,
        from: page.status,
        to: requested,
      });
      if (!transition.ok) return invalid({ ...transition.error, key: null });
      const status = transition.status;

      // Spec §9 step 4's *decisions*. Its writes are further down, where the spec puts them;
      // see the docstring for why the two halves are separated — a relation refused after the
      // version insert could only abort by throwing.
      //
      // `tx`, not `db`: resolved against the snapshot the relation row commits into. The
      // source is the row read under the lock, and neither call trusts it — every query in
      // both modules states its own permission predicate against `source.spaceId`.
      const resolution = await resolveRelations(tx, viewer, {
        source: { id: page.id, spaceId: page.spaceId, spaceKey },
        relations: frontmatter.relations,
      });
      if (!resolution.ok) return invalidAll(resolution.errors);

      // `status`, not `page.status`: the guardrail's `ACCEPTED` precondition is about the
      // status this publish is *landing on*. Asking about the current one would fire every
      // cascade a publish late — the publish that accepts an ADR is exactly the one that must
      // retire what it supersedes.
      const checked = await checkRelations(tx, {
        source: { id: page.id, docType: page.docType, publishingInto: status },
        relations: resolution.relations,
      });
      if (!checked.ok) return invalidAll(checked.errors);

      // Spec §9 step 3's *decisions* — which catalogue rows the author's `systems:` keys name.
      // Its write is further down, at the point in the sequence the spec puts it, next to the
      // `Page` update.
      //
      // **Placed here, between the relation checks and the cascade locks, and both boundaries
      // are deliberate.** Above the locks, so a `systems:` typo refuses before this transaction
      // takes `FOR UPDATE` on another page's row — a refusal that has locked something is a
      // refusal that made another publish wait. Below the relation modules, so a document with
      // both a bad reference and a bad system key reports the reference first: that is the error
      // with a cascade behind it, and each module returns all of *its* errors, so whichever runs
      // first is the one the author sees.
      //
      // `tx`, not `db`. Phase 5 Task 4 established the pattern and measured the trap, and for
      // publish specifically the `db` mistake does not commit silently — it **times out on a
      // lock**, because this transaction is holding `FOR UPDATE` on the draft row and is about to
      // update `Page` columns under a unique index. `resolveSystems` only reads `System`, which
      // nothing here locks, so its own mutant is quiet; `replaceSystems` below is the one that
      // hangs, which is why its test is shaped for that rather than for an assertion.
      const systems = await resolveSystems(tx, { declared: frontmatter.systems });
      if (!systems.ok) return invalidAll(systems.errors);

      // Spec §9 step 5's *decisions*, and the last thing that can refuse. Its writes are at the
      // point in the sequence the spec puts them, below the relation upsert.
      //
      // The locks come first and the decision is taken against the rows they hold: a target's
      // status can change while this transaction waits, and validating the cascade against the
      // status `resolveRelations` saw would decide from a snapshot the write no longer matches.
      //
      // Nothing is locked when nothing cascades, which is deliberate rather than an
      // optimisation: publish then writes exactly one `Page` row, as it did before Task 8, and
      // there is no ordering question to answer. The lock list includes this page's **own** id
      // whenever there is one to answer — see `lockPagesForCascade`.
      const cascading = checked.relations.filter(
        (relation): relation is CascadingRelation => relation.cascade !== null,
      );
      const pendingCascades: PendingCascade[] = [];
      if (cascading.length > 0) {
        const locked = await lockPagesForCascade(tx, [
          page.id,
          ...new Set(cascading.map((relation) => relation.page.id)),
        ]);
        const planned = planCascades(locked, cascading);
        const [firstCascadeError, ...restCascadeErrors] = planned.errors;
        if (firstCascadeError !== undefined) {
          return invalidAll([firstCascadeError, ...restCascadeErrors]);
        }
        pendingCascades.push(...planned.pending);
      }

      // Everything above this line is a read or a decision, and every rejection above
      // returns before a single row is written. That ordering is the cheap half of
      // atomicity; the transaction is the other half, and the page update below is the one
      // place a failure can arrive after a write.

      // Spec §9 step 6's *application* half, computed here and stored on the row below.
      //
      // §13 asks for a vector "derived from … body text stripped of Markdown syntax",
      // "maintained by a trigger created in a raw SQL migration", and those two clauses cannot
      // both be satisfied in plpgsql: a trigger cannot run remark. So the split is the one
      // Phase 4 settled — the application strips, the trigger weights. `searchFieldsOf` produces
      // the two text columns; the `Page` write below moves `publishedVersionId`, and the
      // `page_search_vector_refresh` trigger builds the weighted vector from them.
      //
      // **`draft.markdown`, the same bytes the row stores**, not `split.body` and not a trimmed
      // copy. `searchFieldsOf` runs `splitFrontmatter` itself, so handing it the body would be
      // splitting twice and would differ the moment the two disagreed; and the version column
      // and its strip must describe the same characters or the snippet quotes text the page does
      // not contain.
      //
      // Inside the transaction and after the lock, because that is where the text it describes
      // is read. It costs about 0.6ms — `headingsOf` deliberately stops before `rehypeShiki`,
      // which is the pipeline's slow step and cannot change a heading.
      //
      // Both fields can legitimately come back `""`: a page whose whole body is one Mermaid
      // diagram has no prose and no headings. Publish has already refused an empty *body* two
      // checks above, and a body that is only a diagram is not empty. Nothing here treats `""`
      // as a failure, and nothing may: the columns are `NOT NULL DEFAULT ''` for that reason.
      const searchFields = await searchFieldsOf(draft.markdown);

      // Spec §9 step 2.
      const version = await tx.pageVersion.create({
        data: {
          pageId: page.id,
          title,
          markdown: draft.markdown,
          searchText: searchFields.searchText,
          searchHeadings: searchFields.searchHeadings,
          status,
          // The publisher, not the last person to autosave. It is the byline the reader
          // shows and the authorship the git mirror will commit under.
          authorId: viewer.id,
          // What validation **accepted**, never what the author typed — the distinction Task 1
          // Step 2 asked to be pinned, and `publish.test.ts` pins it by asserting the two are
          // not the same value. `supersedes: decisions/adr-0031` is one scalar in the draft and
          // a one-element array here; a key left empty in the template is `null` there and `[]`
          // here; `relations` carries all four types whether or not the doc type can declare
          // them. This is the row the reader, Phase 5's git mirror and Phase 7's `PageSystem`
          // backfill all read, so it holds the normalised value rather than one each of them
          // would have to re-derive.
          frontmatter,
        },
        select: { id: true },
      });

      const publishedAt = new Date();

      // Spec §9 step 3.
      //
      // `updateMany`, not `update`, so the write carries a predicate — and the predicate is
      // the reason: `visiblePage()` means a soft delete that commits while this transaction
      // is running (Task 12) matches nothing here, and this publish rolls back rather than
      // setting `publishedVersionId` on a deleted page and handing the reader a version of a
      // page that no longer exists. `readableSpace` is restated for the same reason it is on
      // every other query in this module.
      //
      // A row count of zero is therefore not an impossibility to assert away; it is a race
      // this cannot commit through, and the only way out of a transaction that has already
      // written is to throw.
      const updated = await tx.page.updateMany({
        where: visiblePage({ id: page.id, space: readableSpace(viewer) }),
        data: {
          title,
          status,
          publishedVersionId: version.id,
          // Both columns, together. "Published" means `publishedVersionId`, and
          // `publishedAt` is what the reader orders "Recently published" by; a query
          // filtering on either one alone is a Phase 1 lesson written down twice.
          publishedAt,
        },
      });
      if (updated.count !== 1) {
        throw new PageNoLongerPublishable(
          `Page ${page.id} stopped being publishable mid-transaction`,
        );
      }

      // Spec §9 step 3's other half: the page's `PageSystem` rows become exactly the systems the
      // frontmatter declares. Resolved above; this is the write, and it is a **re-resolve** and
      // not an accumulation — a version that drops a system drops the row, argued in full at
      // `replaceSystems`.
      //
      // Immediately after the `Page` update because that is where §9 puts step 3, and inside this
      // transaction because a facet that outlived a rolled-back publish would put the system's
      // page and the document's own text permanently at odds.
      await replaceSystems(tx, { pageId: page.id, systemIds: systems.systemIds });

      // Deleting the draft is NOT one of spec §9's eight steps — the spec does not mention
      // it. It is this plan's decision, and its reason is that a draft identical to what is
      // published is a confusing thing to reopen.
      //
      // This is the statement that makes `decideSave`'s `vanished` branch reachable. It is
      // safe to delete unconditionally *because of the lock taken at the top*: no autosave
      // can have landed since the read, so nothing is being discarded that the editor was
      // told had been saved.
      await tx.pageDraft.delete({ where: { pageId: page.id }, select: { pageId: true } });

      // Spec §9 step 4. Resolved and checked above; this is the write, and it is a *replace*
      // rather than an upsert — see `replaceRelations` for why removal is half the job. The diff
      // it returns is for the audit row below and for nothing else.
      const relationDiff = await replaceRelations(tx, {
        fromId: page.id,
        relations: checked.relations,
      });

      // Spec §9 step 5 — the lifecycle cascades of §6.3, in THIS transaction, so the two sides
      // can never disagree. Decided above under the locks; this is only the write and its audit
      // row. Each one is a `PageNoLongerPublishable` away from rolling the whole publish back,
      // which is what "one action, both sides" has to mean when the second side can be raced.
      for (const cascade of pendingCascades) {
        await applyCascade(tx, {
          cascade,
          viewer,
          source: { id: page.id, path: page.path, spaceId: page.spaceId },
          versionId: version.id,
        });
      }

      // Spec §9 step 6 — the search vector — has already happened, twice over, and there is
      // deliberately no statement here.
      //
      // The `Page` update above moved `publishedVersionId` and `title`, which fired
      // `page_search_vector_refresh` BEFORE that row was written; the vector was built from the
      // version this transaction had just inserted. An explicit refresh at this point would be a
      // second place the index is maintained, and the first one to fall behind would do it
      // silently — every failure of search reads to a user as "that page does not exist".
      //
      // The step is called out rather than deleted because the spec numbers it, and a reader
      // walking §9 against this function would otherwise find six steps where there are seven.

      // Spec §9 step 7.
      await writeAudit(tx, {
        actorId: viewer.id,
        action: "page.publish",
        spaceId: authorised.space.id,
        pageId: page.id,
        // `from` and `to` both, and the path as it stood: Task 10 can move the page
        // afterwards, at which point the row no longer says where it was published.
        detail: {
          path: page.path,
          versionId: version.id,
          title,
          // `fromStatus`/`toStatus`, not `from`/`to`: `page.move` records a *path* transition
          // under those bare names, so one key would mean two things and `detail->>'from'`
          // would not be queryable across actions.
          fromStatus: page.status,
          toStatus: status,
          // Task 8's audit decision, argued at `RelationDiff`: both directions, always present
          // even when both are empty, and edges rather than the references that produced them.
          relations: relationDiff,
          // **And deliberately no `systems` diff beside it**, which is a decision rather than an
          // omission, because the two halves of `RelationDiff`'s argument both fail here.
          // "Reconstructible from the version chain" was too weak for relations because
          // recovering an edge means re-resolving a *path* as it would have resolved then,
          // through `Redirect` rows a later move may have replaced; a system key resolves
          // through one lookup against a closed catalogue with no time-dependent hop, and
          // `PageVersion.frontmatter` already stores the folded keys. And "removal has a
          // consequence nothing else records" was the deciding half: dropping `supersedes:`
          // leaves the target `SUPERSEDED` with nothing saying why, whereas dropping a system
          // fires no cascade and changes no other row. What is left is that a `System.key`
          // renamed by Task 5 would make an old version's stored keys unresolvable — and that
          // rename is Task 5's own audited mutation, on the row that changed.
          // What this publish did to *other* pages, so the source's own history says a cascade
          // happened without having to be joined to the target's rows. The rows those cascades
          // wrote are the far side of the same event and carry the reverse pointer.
          cascaded: pendingCascades.map((cascade) => ({
            pageId: cascade.target.id,
            path: cascade.target.path,
            fromStatus: cascade.target.status,
            toStatus: cascade.to,
            relation: cascade.type,
          })),
        },
      });

      // Spec §9 step 8, and the spec is explicit that the job "is committed with it": a
      // published version with no queued job is not a state this system can reach. The test for
      // that is that a **forced enqueue failure rolls this publish back**, which is exactly what
      // happens — nothing here catches, so the transaction goes.
      //
      // **That is not a contradiction of "git is never on the critical path", and the two
      // sentences are about different steps.** This is one `INSERT` into the same Postgres, in
      // this transaction; it cannot fail for anything a git host does, because no git host is
      // involved. The clone, the commit, the **push** and every retry happen in Task 6's worker,
      // in another process, and none of them can delay or fail a publish. Deleting either
      // sentence because it seems to contradict the other is the mistake both are written
      // against; `src/lib/git/enqueue.ts` carries the long form.
      //
      // `tx`, never `db`: an enqueue on `db` inside a `$transaction` runs on another connection
      // and commits independently, which would leave a job for a version this transaction may
      // still roll back — and every test would stay green.
      //
      // Every value is captured, none is joined at drain time. `page.path` is the path read
      // under the lock, which is where this version's file belongs even if a move rewrites the
      // column a millisecond later; `version.id` is the row just inserted and just pointed at.
      // `spaceKey` comes from the authorisation read, and nothing renames a `Space` in this
      // product — Phase 7 owns space administration, and the schema records that the captured
      // key is the correct one anyway, because it names the directory the file is actually in.
      await enqueueMirrorJobs(tx, {
        kind: "PUBLISH",
        spaceKey,
        targets: [
          {
            id: page.id,
            path: page.path,
            // Nothing moved; `fromPath` is a `MOVE`'s column.
            fromPath: null,
            publishedVersionId: version.id,
          },
        ],
      });

      // What this publish wrote and deliberately did not act on. Derived from the checked
      // relations by `dormantCascade`, which owns the rule — this loop only carries the answer
      // out, so the `ACCEPTED` gate stays stated in exactly one place.
      const dormant: DormantCascade[] = [];
      for (const relation of checked.relations) {
        const wouldRetireInto = dormantCascade(relation);
        if (wouldRetireInto === null) continue;
        dormant.push({
          type: relation.type,
          key: KEY_FOR_RELATION[relation.type],
          ref: relation.ref,
          wouldRetireInto,
        });
      }

      return {
        ok: true,
        page: {
          id: page.id,
          path: page.path,
          spaceKey,
          title,
          status,
          publishedAt,
          versionId: version.id,
          dormant,
        },
      };
    });
  } catch (error) {
    // The only mid-write abort. The transaction has rolled back — no version, no draft
    // deletion, no audit row — and the honest answer is the same one an already-deleted page
    // gets, because that is what happened.
    if (error instanceof PageNoLongerPublishable) return { ok: false, reason: "not-found" };
    throw error;
  }
}
