import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { decideSave } from "@/lib/drafts/conflict";
import type { Viewer } from "@/lib/authz/types";

/** What the editor typed. The two fields the autosave endpoint sends and the 409 echoes. */
export type DraftText = { title: string; markdown: string };

/** The draft as it now stands, and the `updatedAt` the client must send with its next save. */
export type SavedDraft = DraftText & { updatedAt: Date };

/** The other editor's work, everything the 409 banner needs without a second query. */
export type OtherEdit = SavedDraft & { editorName: string };

export type SaveDraftInput = DraftText & {
  /**
   * The `updatedAt` the client last received, or `null` if it believes there is no draft.
   * `null` is a claim about the world, not an opt-out: see `decideSave`.
   */
  seen: Date | null;
};

export type SaveDraftResult =
  | { ok: true; created: boolean; draft: SavedDraft }
  /**
   * The page does not exist, is soft-deleted, or sits in a space this viewer cannot read —
   * one answer for all three. Never a 403: a permission error on a page a stranger cannot
   * read confirms that the page exists, which is the leak spec §8 exists to close.
   */
  | { ok: false; reason: "not-found" }
  /**
   * The viewer can read the page but not edit it — a `VIEWER` in the space, or anyone in an
   * `ALL_STAFF` space they do not belong to. Distinct from `not-found` on purpose: they can
   * already see the page, so saying "you cannot edit this" discloses nothing new.
   */
  | { ok: false; reason: "forbidden" }
  | {
      ok: false;
      reason: "conflict";
      /**
       * Null only when the draft disappeared while this save was in flight — published
       * (Task 9) or the page deleted (Task 12). There is then no "theirs" to offer, but the
       * save is still refused rather than silently recreated, and `mine` still carries the
       * text so nothing is discarded.
       */
      theirs: OtherEdit | null;
      mine: DraftText;
    };

/**
 * Saves a page's draft under the conflict contract of spec §9: every save sends the
 * `updatedAt` it last saw, a mismatch is refused with both texts, and a save is never
 * silently discarded nor silently applied over someone else's.
 *
 * The decision itself lives in `conflict.ts` and takes plain Dates, so every branch of it is
 * unit-tested without a database. This function owns only the permission check, the atomic
 * write, and turning a lost race back into that same decision.
 */
export async function saveDraft(
  viewer: Viewer,
  pageId: string,
  input: SaveDraftInput,
): Promise<SaveDraftResult> {
  // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage` owns
  // the top level and `readableSpace` is passed whole as the `space` relation filter.
  // Explicit `select`, never `include`.
  const page = await db.page.findFirst({
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    select: {
      id: true,
      publishedVersionId: true,
      space: { select: { id: true, visibility: true } },
      draft: { select: { updatedAt: true } },
    },
  });
  if (!page) return { ok: false, reason: "not-found" };

  if (!can(viewer, page.space, "EDIT")) return { ok: false, reason: "forbidden" };

  const current = page.draft?.updatedAt ?? null;
  const decision = decideSave({ current, seen: input.seen });

  if (decision.kind === "conflict") return conflictWith(viewer, pageId, input);

  if (decision.kind === "create") {
    try {
      const draft = await db.pageDraft.create({
        // No permission predicate is expressible on a create, so this is the one write in
        // the module that leans on the check above. It is keyed by the page id that check
        // just authorised, and a create against any other page is impossible.
        data: {
          pageId: page.id,
          title: input.title,
          markdown: input.markdown,
          // The version this draft departs from, recorded while it is still knowable. On a
          // never-published page it is null, which is the honest answer, not a placeholder.
          baseVersionId: page.publishedVersionId,
          updatedById: viewer.id,
        },
        select: { title: true, markdown: true, updatedAt: true },
      });
      return { ok: true, created: true, draft };
    } catch (error) {
      // Two clients can both find no draft and both decide "create". `pageId` is the primary
      // key, so Postgres refuses the second one — the create path gets its atomicity from
      // the key rather than from a `where`, and the loser is a conflict like any other.
      if (isUniqueViolation(error)) return conflictWith(viewer, pageId, input);
      throw error;
    }
  }

  // `decideSave` cannot return "update" with a null `current`, but narrowing it is not
  // ceremony: `updatedAt: undefined` in a Prisma `where` DROPS the condition rather than
  // matching nothing, which is precisely the mutation the clause below exists to prevent.
  // A non-null assertion would compile and lose the guarantee.
  if (current === null) return conflictWith(viewer, pageId, input);

  // The whole atomicity guarantee is `updatedAt: current` in this `where`. Read-then-write
  // would let two saves both read the same timestamp and both decide "update"; here the
  // second one's UPDATE re-evaluates its predicate after the first commits, matches nothing,
  // and returns no rows. `updateManyAndReturn` is the `updateMany` the plan calls for with
  // Postgres's RETURNING attached, so the row count and the new `updatedAt` come from the
  // same statement — a separate read-back would reopen the window this closes.
  const rows = await db.pageDraft.updateManyAndReturn({
    where: {
      pageId: page.id,
      updatedAt: current,
      page: visiblePage({ space: readableSpace(viewer) }),
    },
    data: {
      title: input.title,
      markdown: input.markdown,
      updatedById: viewer.id,
    },
    select: { title: true, markdown: true, updatedAt: true },
  });

  const draft = rows[0];
  if (rows.length === 0 || draft === undefined) {
    return conflictWith(viewer, pageId, input);
  }
  return { ok: true, created: false, draft };
}

/**
 * Builds the refusal, including everything the 409 needs so the API layer does not have to
 * query again: the other editor's name, their timestamp, and both texts.
 *
 * It restates the permission predicate rather than trusting the check its caller already
 * made. That is this project's one rule for query modules — no query is guarded by call
 * ordering — and here it also means a page soft-deleted mid-request cannot leak its draft
 * back out through the conflict body.
 */
async function conflictWith(
  viewer: Viewer,
  pageId: string,
  mine: DraftText,
): Promise<SaveDraftResult> {
  const theirs = await db.pageDraft.findFirst({
    where: { pageId, page: visiblePage({ space: readableSpace(viewer) }) },
    select: {
      title: true,
      markdown: true,
      updatedAt: true,
      updatedBy: { select: { name: true } },
    },
  });

  return {
    ok: false,
    reason: "conflict",
    theirs:
      theirs === null
        ? null
        : {
            title: theirs.title,
            markdown: theirs.markdown,
            updatedAt: theirs.updatedAt,
            editorName: theirs.updatedBy.name,
          },
    mine: { title: mine.title, markdown: mine.markdown },
  };
}

/** P2002 is Prisma's unique-constraint violation; here it can only be the `pageId` key. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}
