import type { DocStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { writeAudit } from "@/lib/audit/log";
import { visiblePage } from "@/lib/pages/visible";
import { defaultPublishStatus, validateTransition } from "@/lib/pages/transition";
import { stripControl } from "@/lib/text/control";
import type { Viewer } from "@/lib/authz/types";

/** The fields a rejection can be attached to, so the editor renders it in place. */
export type PublishField = "title" | "markdown" | "status";

export type PublishErrorCode =
  | "title-empty"
  | "draft-empty"
  | "no-draft"
  | "draft-is-not-a-destination"
  | "illegal-transition";

export type PublishFieldError = {
  field: PublishField;
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
  /** Something about the draft or the transition. Always attached to a field, never thrown. */
  | { ok: false; reason: "invalid"; error: PublishFieldError };

const invalid = (error: PublishFieldError): PublishResult => ({
  ok: false,
  reason: "invalid",
  error,
});

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
 * Publishes a page: spec §9 steps 1–3 and 7, all or nothing, in one transaction.
 *
 * ## What this deliberately does not do
 *
 * Spec §9 is eight steps and this implements four of them. The rest belong to later phases
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
     * republish stays where it is. Phase 3 supplies this from validated frontmatter.
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
        select: { id: true, path: true, docType: true, status: true },
      });
      if (!page) return { ok: false, reason: "not-found" };

      // TODO(phase-3): spec §9 step 1 also validates frontmatter against the doc type's
      // template schema (zod). Phase 3 defines the templates; Phase 2 validates the title,
      // the emptiness of the body and the status transition it knows about.

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
          code: "draft-empty",
          message:
            "There is nothing in this draft to publish. Write something first, or delete " +
            "the page.",
        });
      }

      const requested = options.status ?? defaultPublishStatus(page.docType, page.status);
      const transition = validateTransition({
        docType: page.docType,
        from: page.status,
        to: requested,
      });
      if (!transition.ok) return invalid(transition.error);
      const status = transition.status;

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
          // TODO(phase-3): `frontmatter` is left at its `{}` default until Phase 3 parses
          // and validates it. Writing the draft's raw frontmatter through unvalidated would
          // put unchecked data on the row the reader trusts.
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

      // TODO(phase-3): spec §9 step 4 — upsert the `PageRelation` rows declared in
      // frontmatter (`supersedes:`, `decides:`), with the guardrails in §6.2.

      // TODO(phase-3): spec §9 step 5 — apply the lifecycle cascades of §6.3. A published
      // ADR that supersedes another sets that ADR to `SUPERSEDED` in THIS transaction, so
      // the two sides can never disagree.

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
          from: page.status,
          to: status,
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
