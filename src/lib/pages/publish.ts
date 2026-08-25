import type { DocStatus, Prisma, RelationType } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { writeAudit } from "@/lib/audit/log";
import { visiblePage } from "@/lib/pages/visible";
import { defaultPublishStatus, validateTransition } from "@/lib/pages/transition";
import { stripControl } from "@/lib/text/control";
import { splitFrontmatter, type FrontmatterErrorCode } from "@/lib/markdown/frontmatter";
import {
  validateFrontmatter,
  type FrontmatterSchemaErrorCode,
  type ValidatedFrontmatter,
} from "@/lib/lifecycle/schema";
import { resolveRelations, type RelationRefusalCode } from "@/lib/lifecycle/resolve";
import {
  checkRelations,
  type CheckedRelation,
  type RelationGuardCode,
} from "@/lib/lifecycle/relations";
import type { Viewer } from "@/lib/authz/types";

/** The fields a rejection can be attached to, so the editor renders it in place. */
export type PublishField = "title" | "markdown" | "status";

/**
 * Every reason a publish can be refused with a field error.
 *
 * The four unions are **imported, not restated**. Frontmatter validation, schema validation,
 * reference resolution and the relation guardrails each own their own codes and each has its
 * own module and tests; a copy of those names here would be a second list that agrees on the
 * day it is written. It also means a caller that switches on a code is switching on the same
 * value the module that produced it exported — Task 11's editor surface, and Phase 4's search
 * indexer, both need that.
 */
export type PublishErrorCode =
  | "title-empty"
  | "draft-empty"
  | "no-draft"
  | "draft-is-not-a-destination"
  | "illegal-transition"
  /** `src/lib/markdown/frontmatter.ts` — the block did not parse, or breached a cap. */
  | FrontmatterErrorCode
  /** `src/lib/lifecycle/schema.ts` — it parsed and the doc type does not accept it. */
  | FrontmatterSchemaErrorCode
  /** `src/lib/lifecycle/resolve.ts` — a relation names no page this viewer can relate to. */
  | RelationRefusalCode
  /** `src/lib/lifecycle/relations.ts` — the relation is legal to write and illegal to mean. */
  | RelationGuardCode;

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

export type PublishedPage = {
  id: string;
  path: string;
  spaceKey: string;
  title: string;
  status: DocStatus;
  publishedAt: Date;
  versionId: string;
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
): Promise<void> {
  const { fromId } = args;

  const byEdge = new Map<string, { toId: string; type: RelationType }>();
  for (const relation of args.relations) {
    byEdge.set(`${relation.type} ${relation.page.id}`, {
      toId: relation.page.id,
      type: relation.type,
    });
  }
  const declared = [...byEdge.values()];

  // Everything this page declared last time and does not declare now. With nothing declared
  // there is no `NOT` to write and every row leaving this page goes.
  await tx.pageRelation.deleteMany({
    where: declared.length === 0 ? { fromId } : { fromId, NOT: { OR: declared } },
  });

  if (declared.length === 0) return;
  await tx.pageRelation.createMany({
    data: declared.map((edge) => ({ fromId, toId: edge.toId, type: edge.type })),
    skipDuplicates: true,
  });
}

/**
 * Publishes a page: spec §9 steps 1–4 and 7, all or nothing, in one transaction.
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
 * Spec §9 is eight steps and this implements five of them. The rest belong to later phases
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

      // Everything above this line is a read or a decision, and every rejection above
      // returns before a single row is written. That ordering is the cheap half of
      // atomicity; the transaction is the other half, and the page update below is the one
      // place a failure can arrive after a write.

      // Spec §9 step 2.
      const version = await tx.pageVersion.create({
        data: {
          pageId: page.id,
          title,
          markdown: draft.markdown,
          status,
          // The publisher, not the last person to autosave. It is the byline the reader
          // shows and the authorship the git mirror will commit under.
          authorId: viewer.id,
          // What validation **accepted**, never what the author typed — the distinction Task 1
          // Step 2 asked to be pinned, and `publish.test.ts` pins it by asserting the two are
          // not the same value. `supersedes: decisions/adr-0031` is one scalar in the draft and
          // a one-element array here; a key left empty in the template is `null` there and `[]`
          // here; `relations` carries all four types whether or not the doc type can declare
          // them. This is the row the reader, Phase 5's git mirror and Phase 6's `PageSystem`
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

      // TODO(phase-6): spec §9 step 3 also replaces the page's `PageSystem` rows from the
      // declared `systems:` frontmatter. Phase 6 adds the model.

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
      // rather than an upsert — see `replaceRelations` for why removal is half the job.
      await replaceRelations(tx, { fromId: page.id, relations: checked.relations });

      // TODO(phase-3): spec §9 step 5 — apply the lifecycle cascades of §6.3. A published
      // ADR that supersedes another sets that ADR to `SUPERSEDED` in THIS transaction, so
      // the two sides can never disagree.
      //
      // The input is already here and computed: every `checked.relations` entry carries
      // `cascade`, the status Task 8 must set on `relation.page` — non-null only when this
      // publish is landing on `ACCEPTED` and the relation type cascades at all, so Task 8 needs
      // one branch rather than three. It is deliberately **not** acted on here: Task 8 owns the
      // authorization of a write to a page the publisher may not be able to edit, the
      // `PUBLISHABLE_INTO` check on the cascade's own transition, the ascending-page-id lock
      // order that write introduces, and the audit row for the other side.

      // TODO(phase-4): spec §9 step 6 — refresh the search vector for this page.

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
        },
      });

      // TODO(phase-5): spec §9 step 8 — enqueue a `GitJob`, committed with this transaction
      // and processed asynchronously. Publishing must work without it, which is the property
      // Phase 5 exists to prove rather than assert.

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
