import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import {
  childPath,
  descendantPaths,
  validatePath,
  validateSlug,
  type PathErrorCode,
  type SlugErrorCode,
} from "@/lib/pages/slug";
import type { Viewer } from "@/lib/authz/types";

/** The two inputs a rejection can be attached to, so the form can render it in place. */
export type MoveField = "slug" | "parentId";

/** Rejections this module raises that the slug rules do not already have a code for. */
export type MoveErrorCode =
  | "parent-not-found"
  | "parent-is-descendant"
  | "unchanged"
  | "path-occupied"
  | "path-occupied-by-deleted"
  | "path-overlaps-subtree";

/**
 * The same `{ field, code, message }` shape `validateSlug` and `validatePath` return, widened
 * to this form's fields and codes — so a slug rejection is passed through untouched rather
 * than re-worded here. `createPage` widens the identical shape for the identical reason.
 */
export type MoveFieldError = {
  field: MoveField;
  code: SlugErrorCode | PathErrorCode | MoveErrorCode;
  message: string;
};

export type MovedPage = {
  id: string;
  spaceKey: string;
  /** Where the page is now. */
  path: string;
  /** Where it was, which is also the `Redirect.fromPath` written for it. */
  previousPath: string;
  /** Rows whose `path` was rewritten: the page itself plus every descendant. Never 0. */
  rewritten: number;
  /** `Redirect` rows written — one per rewritten row, so it equals `rewritten`. */
  redirects: number;
};

export type MoveResult =
  | { ok: true; page: MovedPage }
  /**
   * The page does not exist, is soft-deleted, or sits in a space this viewer cannot read —
   * one answer for all three, and never a 403, which would confirm the page is real. Tasks
   * 4, 6, 7, 8 and 9 all draw this line in the same place and the six must not diverge.
   *
   * It is also the answer when the page is soft-deleted *during* the transaction; see the
   * write predicate on the page update below.
   */
  | { ok: false; reason: "not-found" }
  /**
   * Readable but not writable — a `VIEWER` in the space, or anyone in an `ALL_STAFF` space
   * they do not belong to. Safe to be specific: they can already see the page.
   */
  | { ok: false; reason: "forbidden" }
  /** Something the editor chose. Always attached to a field, never thrown. */
  | { ok: false; reason: "invalid"; error: MoveFieldError };

export type MovePageInput = {
  /**
   * The new parent, or `null` for the top level of the space. **Both fields are required,
   * neither is optional**, and that is deliberate: an "omit to keep the current value"
   * signature makes `undefined` and `null` mean different things on a field whose whole
   * purpose is to carry `null`, and a form that does not send an untouched field would then
   * silently move the page to the space root. The caller has both values already — it loaded
   * the page to render the form.
   *
   * A parent in another space is rejected as `parent-not-found`: moving a page between
   * spaces would change which permission predicate governs it and which space's audit trail
   * owns it, and it is not what any Phase 2 surface offers.
   */
  newParentId: string | null;
  /** The new slug. Pass the current one to reparent without renaming. */
  newSlug: string;
};

const invalid = (error: MoveFieldError): MoveResult => ({
  ok: false,
  reason: "invalid",
  error,
});

/**
 * Thrown to abort the transaction after rows have already been written. Rolling back is the
 * point in both cases, and a sentinel class rather than a bare `Error` so the catch below
 * cannot swallow a genuine database failure and report it as a missing page.
 */
class PageNoLongerMovable extends Error {}

/**
 * Thrown when the rewrite touched a different number of rows than were read and validated
 * under the lock. Separate from the class above because it is not a race this transaction can
 * commit through and not one it should report as "not found": it means the statement's
 * `LIKE` matched rows the boundary filter did not, which is what a broken escape looks like.
 */
class RewriteTouchedUnexpectedRows extends Error {}

/**
 * The escape character for the `LIKE` pattern below. Any character would do; a backslash is
 * conventional, and being explicit is what lets `%` and `_` inside a real path be matched
 * literally.
 */
const LIKE_ESCAPE = "\\";

/**
 * Escapes a literal string for use as a `LIKE` prefix. **The escaping and the `ESCAPE` clause
 * are one decision, not two** — either without the other is broken, so they are written
 * within a few lines of each other and neither is optional.
 *
 * All three metacharacters, including the escape character itself: `%` matches any run,
 * `_` matches exactly one character, and an unescaped trailing `\` would consume the `/`
 * that follows it in the pattern.
 *
 * A measurement worth writing down, because it says which half carries the weight: **the
 * `ESCAPE '\'` clause is not what makes this work.** Postgres already treats a backslash as
 * the escape character when no clause is given — `'axb' LIKE 'a\_b'` is false either way —
 * so deleting the clause from both statements below changes nothing and no test can catch it
 * (verified: the suite passes with it removed). What the tests do catch is deleting *this
 * function*. The clause stays because it says out loud which character the pattern is escaped
 * with, and because the SQL standard does not promise Postgres's default; it is documentation
 * with teeth, not the mechanism.
 *
 * `_` is the one that bites. Slugs today are `[a-z0-9-]`, so no path can contain any of these
 * — which is exactly why this is easy to skip now and expensive to discover later. If a
 * future rule admits `_`, an unescaped pattern for `a/b_c` also matches `a/bxc` and its whole
 * subtree, and the move would drag an unrelated page across the tree. There is a test that
 * inserts such a path directly, below the slug rules, so the escaping is exercised today
 * rather than from the day the rules change.
 */
function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

/** What the subtree read returns: enough to rewrite, redirect and audit each row. */
type SubtreeRow = { id: string; path: string; deletedAt: Date | null };

/**
 * Moves a page — renames it, reparents it, or both — and takes its whole subtree with it.
 *
 * ## The landmine this function is built around
 *
 * `Page_spaceId_path_key` is a bare unique **index**, so `SET CONSTRAINTS ... DEFERRED` can
 * never apply to it and Postgres checks it row by row *even within a single statement*.
 * Measured during Phase 1, and the two halves of that measurement decide the shape of
 * everything below:
 *
 * - A one-statement **swap** of two sibling paths fails with a duplicate key violation.
 * - A one-statement **subtree prefix rewrite commits**, because the new path set shares a
 *   prefix no moving row currently holds, so it is disjoint from every unwritten old path.
 *
 * So: the descendant rewrite is **one** `$executeRaw` (Prisma's `updateMany` cannot set a
 * column from a column expression), an occupied target is rejected **up front** rather than
 * shuffled around in two phases, and the transaction opens with an advisory lock.
 *
 * ## The lock, and why it is this key
 *
 * `pg_advisory_xact_lock(hashtext(spaceId))` — **byte-identical to the statement `createPage`
 * opens with**, and there is a test that reads both files and compares them. Two different
 * keys would serialise moves against moves and creates against creates but neither against
 * the other, and create-versus-move is the pair that corrupts a tree: a create resolves its
 * parent's path and then inserts a child carrying a prefix the move has since rewritten,
 * producing a page whose path disagrees with its parent's — reachable by URL, absent from the
 * nav rail, which is the quietest possible way to lose a page.
 *
 * Task 9's publish deliberately takes a `FOR UPDATE` row lock on `PageDraft` instead. It
 * never touches `Page.path`, so it shares no resource with this function; that is not an
 * omission to be fixed.
 *
 * ## What it writes
 *
 * One `Redirect` per rewritten row, so every old URL in the subtree keeps working, and a
 * `deleteMany` that clears any redirect standing at a path this move has just made live —
 * without which moving A→B and then B→A leaves a redirect pointing away from a live page and
 * reads bounce. `Redirect.toPageId` (not a path) is what keeps Task 11 to one hop: a page
 * moved twice has two redirects, both resolving directly to wherever it is now.
 */
export async function movePage(
  viewer: Viewer,
  pageId: string,
  input: MovePageInput,
): Promise<MoveResult> {
  // Authorisation first, outside the transaction and before the lock: the cheapest refusal
  // should not open a transaction, and an unauthorised caller must never take a space-wide
  // lock that stalls every create and move in a space they cannot even read.
  //
  // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage` owns
  // the top level and `readableSpace` is passed whole as the `space` relation filter.
  // Explicit `select`, never `include`.
  const authorised = await db.page.findFirst({
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    select: { id: true, space: { select: { id: true, key: true, visibility: true } } },
  });
  if (!authorised) return { ok: false, reason: "not-found" };

  if (!can(viewer, authorised.space, "EDIT")) return { ok: false, reason: "forbidden" };

  const spaceId = authorised.space.id;
  const spaceKey = authorised.space.key;

  // Pure, so it is validated before the lock is taken. Holding a space-wide lock across a
  // typo serialises every other author in the space behind a message this function could
  // have produced without touching the database. `createPage` orders it the same way.
  const slug = validateSlug(input.newSlug);
  if (!slug.ok) return invalid(slug.error);

  try {
    return await db.$transaction(async (tx): Promise<MoveResult> => {
      // The lock. Byte-identical to `createPage`'s, and pinned as such by a test.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;

      // Re-read INSIDE the lock. The authorisation read above happened before any
      // serialisation, so by now another move could have rewritten this page's path — and
      // every computation below is built from that path. Restating both predicates rather
      // than trusting the earlier read is this project's one rule for page queries: no query
      // is guarded by call ordering.
      const page = await tx.page.findFirst({
        where: visiblePage({ id: pageId, spaceId, space: readableSpace(viewer) }),
        select: { id: true, path: true, slug: true, parentId: true, title: true },
      });
      if (!page) return { ok: false, reason: "not-found" };

      const oldPath = page.path;

      // The parent's **path**, read inside the lock for the same reason `createPage` reads it
      // inside the lock: it is what the new path is built from, and a concurrent move would
      // otherwise leave this one building a path from a prefix that no longer exists.
      //
      // `spaceId` in the filter is not redundant with the authorisation read. Without it a
      // parent id from any other readable space would be accepted, and this page would be
      // given a path prefix belonging to a different space's tree.
      let newParentPath: string | null = null;
      if (input.newParentId !== null) {
        const parent = await tx.page.findFirst({
          where: visiblePage({
            id: input.newParentId,
            spaceId,
            space: readableSpace(viewer),
          }),
          select: { path: true },
        });
        if (!parent) {
          return invalid({
            field: "parentId",
            code: "parent-not-found",
            message:
              "That parent page is no longer available in this space. Pick another, or move " +
              "this page to the top level.",
          });
        }
        newParentPath = parent.path;
      }

      /**
       * Whether a path is inside the subtree being moved — the moved page itself, or anything
       * below it at a `/` boundary.
       *
       * This is `descendantPaths` rather than a fresh comparison, and the empty replacement
       * prefix is what turns it into a question: a path inside the subtree is rewritten and so
       * comes back changed, and a path outside it comes back identical. The boundary rule
       * (`architecture/mqtt-contracts` takes `…/topic-registry` but not `…-v2`) is tested
       * once, in `slug.test.ts`, and used everywhere — including here, where writing
       * `startsWith(oldPath)` instead would call `mqtt-contracts-v2` a descendant.
       */
      const inMovingSubtree = (path: string) =>
        descendantPaths(oldPath, "", path) !== path;

      // A cycle, rejected **by path prefix and never by walking `parentId`**. A parent walk
      // loops forever on data that already contains a cycle, and `buildTree` exists precisely
      // because this data can: it carries a cycle-cutting guard for rows it finds unreachable
      // from any root. A prefix test terminates on any input.
      //
      // This also covers moving a page under itself: its own path is the first thing
      // `inMovingSubtree` matches.
      if (newParentPath !== null && inMovingSubtree(newParentPath)) {
        return invalid({
          field: "parentId",
          code: "parent-is-descendant",
          message:
            `“${page.title}” cannot be moved under itself or under one of its own ` +
            "sub-pages. Choose a parent outside this page's subtree, or move that sub-page " +
            "out first.",
        });
      }

      const newPath = childPath(newParentPath, slug.slug);

      // Nothing to do, and refused rather than silently succeeding. A no-op move would write
      // an audit row for a move that did not happen and a `Redirect` from the page's own live
      // path to itself — which is exactly the redirect-standing-at-a-live-path bug the
      // reclaim below exists to prevent, manufactured by this function instead.
      //
      // Refusing it also means every other check below can assume the target path is outside
      // the moving subtree: the only path in that subtree the new path could equal is the old
      // path itself (any other would require the new parent to be a descendant, rejected
      // above), and that is this branch.
      if (newPath === oldPath) {
        return invalid({
          field: "slug",
          code: "unchanged",
          message:
            `“${page.title}” is already at “${oldPath}”. Change the slug or the parent to ` +
            "move it.",
        });
      }

      // The subtree, **deliberately without `visiblePage()`**, and this is the decision the
      // plan asks to be made on purpose rather than by omission.
      //
      // A soft-deleted descendant is rewritten along with every live one. It has to be:
      //
      // - The unique index does not know about `deletedAt`, so a stranded soft-deleted row
      //   keeps holding a path under the *old* prefix. Move the subtree back and its returning
      //   live rows collide with that row on `(spaceId, path)` — a duplicate key violation
      //   from a page nobody can see.
      // - Its `parentId` is not changed by this move, so skipping it would leave a row whose
      //   path disagrees with its parent's. Task 12's restore promises to put a page back
      //   where it was; restoring that row would put it back at a path whose ancestors live
      //   somewhere else — reachable by URL, missing from the nav rail.
      // - `createPage`'s collision check reads deleted rows on purpose. A stranded row would
      //   refuse a path in a subtree it no longer belongs to, naming a deleted page the
      //   author has no way to relate to the place they are trying to create.
      //
      // The invariant that keeps all three closed is one line: **every row's path is its
      // parent's path plus its slug, deleted or not.** The cost is that a page soft-deleted
      // before the move is restored under the subtree's new location rather than at the
      // literal string it held when it was deleted — which is the same promise stated
      // structurally, and the only one that can survive its parent moving.
      //
      // **One pattern, built once, used by this read and by the rewrite.** The `LIKE` escaping
      // and the `ESCAPE` clause are a single decision and so is the pattern they apply to:
      // a read and a write that disagree about what "in this subtree" means is the same bug
      // twice over, in the direction nothing notices.
      const pattern = `${escapeLikeLiteral(oldPath)}/%`;

      // Raw, and this started as `path: { startsWith: oldPath + "/" }`, which was **wrong** —
      // measured, not reasoned. Prisma does not escape `LIKE` metacharacters in `startsWith`
      // and does not add an `ESCAPE` clause, so for a page at `probe/back\` it emits
      // `LIKE 'probe/back\/%'`, where the backslash escapes the `/` that follows it. The
      // child `probe/back\/child` then does not match: the read comes back one row short,
      // silently, and the child is left stranded under a prefix its parent no longer has.
      // Confirmed against Postgres — `'probe/back\/child' LIKE 'probe/back\/%'` is false, and
      // true only with the escape doubled and `ESCAPE '\'` present.
      //
      // The permission predicate cannot be a Prisma `where` here, and this is the one place in
      // the module where that is true. It is pinned to `spaceId` — resolved through
      // `readableSpace` twice already in this transaction, once outside the lock and once
      // inside it — which is exactly the guarantee the plan's own `$executeRaw` rests on: both
      // raw statements are scoped by the same authorised space id, and neither can reach a row
      // outside it.
      const candidates = await tx.$queryRaw<SubtreeRow[]>`
        SELECT "id", "path", "deletedAt"
          FROM "Page"
         WHERE "spaceId" = ${spaceId}
           AND ("path" = ${oldPath} OR "path" LIKE ${pattern} ESCAPE '\\')
         ORDER BY "path" ASC`;

      // The boundary filter, and it is not redundant with the pattern above. It is the
      // *independent* answer to "which rows move", derived from the tested rule rather than
      // from a `LIKE` pattern — which is what lets the row count below compare two opinions
      // instead of one opinion with itself.
      const subtree: SubtreeRow[] = candidates.filter((row) => inMovingSubtree(row.path));

      // The moved page is in its own subtree, so an empty result means the row vanished
      // between the read above and this one — impossible under the lock, and not something to
      // paper over by writing zero rows and reporting success.
      if (subtree.length === 0) return { ok: false, reason: "not-found" };

      const moves = subtree.map((row) => ({
        ...row,
        newPath: descendantPaths(oldPath, newPath, row.path),
      }));

      // **`validatePath` on every resulting descendant, not just on the moved page.** Moving a
      // subtree deeper lengthens every path in it at once, so a move that looks small can
      // breach the btree index row limit for a page the author was not even looking at — and
      // it arrives from Postgres as `index row size … exceeds btree version 4 maximum 2704`,
      // a 500 naming no field.
      //
      // Checking all of them is a superset of checking the longest, and avoids a second
      // implementation of "longest in UTF-8 bytes" beside the one inside `validatePath`.
      for (const move of moves) {
        const bounded = validatePath(move.newPath);
        if (!bounded.ok) return invalid(bounded.error);
      }

      // The occupancy check, **deliberately not wrapped in `visiblePage()`** — the same
      // deliberate absence `createPage` documents, for the same reason: the unique index does
      // not know about `deletedAt` either, so a soft-deleted page still holds its path and
      // filtering it out here would let the check pass and the write fail with the constraint
      // violation this check exists to replace.
      //
      // This is also what makes a sibling **swap** a rejection rather than an attempt. Two
      // pages cannot trade paths in one statement — measured — so the answer is to say so
      // before writing anything, not to discover it from a duplicate key error halfway
      // through.
      const occupant = await tx.page.findFirst({
        where: { spaceId, path: newPath, space: readableSpace(viewer) },
        select: { id: true, title: true, deletedAt: true },
      });
      if (occupant) {
        return occupant.deletedAt === null
          ? invalid({
              field: "slug",
              code: "path-occupied",
              message: `“${occupant.title}” already has the path “${newPath}”. Choose a different slug, or a different parent.`,
            })
          : invalid({
              field: "slug",
              code: "path-occupied-by-deleted",
              message: `The path “${newPath}” still belongs to the deleted page “${occupant.title}”. Restore it, or choose a different slug.`,
            });
      }

      // The precondition the one-statement rewrite rests on, asserted rather than assumed:
      // the new path set must be disjoint from the old one, or Postgres — checking the unique
      // index row by row inside the statement — hits a duplicate against a path it has not
      // rewritten yet.
      //
      // It cannot happen in a consistent tree: an overlap needs the new prefix to be an
      // ancestor path of the old one with no page holding it, and every nested page has a
      // parent row holding exactly that path (`Page.parent` cascades on delete, and a
      // soft-deleted ancestor still holds its path, where the occupancy check above catches
      // it). It *can* happen on data that has already lost a middle row, which is data this
      // codebase can be handed and cannot repair here.
      //
      // Measured with this check disabled: the move **commits**, because the statement happened
      // to rewrite the ancestor row before the descendant that wanted its path. Which row goes
      // first is heap order, so the same move on the same shape is a duplicate key violation as
      // soon as an unrelated update has shuffled the pages. "Works until it 500s, decided by the
      // scan" is not a property to ship, so it is refused — as a field error rather than a
      // throw, because moving somewhere else avoids it.
      const oldPaths = new Set(moves.map((move) => move.path));
      const overlapping = moves.find((move) => oldPaths.has(move.newPath));
      if (overlapping) {
        return invalid({
          field: "slug",
          code: "path-overlaps-subtree",
          message:
            `Moving “${page.title}” to “${newPath}” would give one of its sub-pages a path ` +
            "another sub-page still holds. Move it somewhere outside its own subtree, or " +
            "rename it first.",
        });
      }

      // One statement, and the reason is the whole landmine: Prisma's `updateMany` cannot set
      // a column from a column expression, and a row-at-a-time loop would hit the unique
      // index on the first descendant whose new path is still held by an unwritten sibling.
      //
      // `ESCAPE '\\'` in this template literal is a single backslash in the SQL — the escape
      // character `escapeLikeLiteral` used. Written `'\'` here it would be the escape sequence
      // for a quote and the statement would carry `ESCAPE ''`, which Postgres rejects; the SQL
      // in the plan is correct SQL, and this is what it looks like in a JavaScript template.
      //
      // `::text` casts because each `${}` is a separate placeholder: `char_length($2)` on its
      // own gives Postgres no other use of that parameter to infer a type from.
      const rewritten = await tx.$executeRaw`
        UPDATE "Page"
           SET "path" = ${newPath}::text || substring("path" from char_length(${oldPath}::text) + 1)
         WHERE "spaceId" = ${spaceId}
           AND ("path" = ${oldPath} OR "path" LIKE ${pattern} ESCAPE '\\')`;

      // The statement has no boundary filter of its own — the escaped pattern *is* its
      // boundary — so this is where the two agree or the transaction stops. A pattern that
      // over-matches (the escaping dropped, or the `/` boundary replaced by a bare prefix)
      // rewrites rows this function never validated, never redirected and never audited, and
      // that is a corrupted tree rather than a failed move.
      //
      // No test fails when *only* this check is deleted, and that is the honest description of
      // it: it is not a behaviour of its own, it is what turns two other mutations — the
      // escaping removed, the `/` boundary removed — from a silently mangled tree into a
      // rolled-back move with a message. Both were verified that way.
      if (rewritten !== moves.length) {
        throw new RewriteTouchedUnexpectedRows(
          `Rewriting the subtree at ${oldPath} touched ${rewritten} rows; ${moves.length} were read under the lock`,
        );
      }

      // The row's own `parentId` and `slug`. The statement above moves paths and nothing else,
      // and a page whose path says one thing while its `parentId` says another is invisible in
      // the nav rail (built from `parentId`) while reachable at its URL (built from `path`).
      //
      // `updateMany`, not `update`, so the write carries a predicate — and `visiblePage()` is
      // the predicate that matters: a soft delete committing while this transaction runs
      // (Task 12) matches nothing here, the count check throws, and the whole move rolls back
      // rather than leaving redirects and an audit row for a page that no longer exists.
      // `readableSpace` is restated for the same reason it is on every other query here.
      const moved = await tx.page.updateMany({
        where: visiblePage({ id: page.id, spaceId, space: readableSpace(viewer) }),
        data: { parentId: input.newParentId, slug: slug.slug },
      });
      if (moved.count !== 1) {
        throw new PageNoLongerMovable(
          `Page ${page.id} stopped being movable mid-transaction`,
        );
      }

      // Redirects, in two statements that have to be in this order.
      //
      // The delete covers two different things at once:
      //
      // - **Every path this move has just made live.** Without it, moving A→B and then B→A
      //   leaves the redirect written by the first move standing at a path a live page now
      //   holds, and Task 11 sends readers away from the page they asked for. Only the
      //   *live* rows count: a redirect standing where a soft-deleted page sits is reachable
      //   (the page itself 404s) and useful, and it goes dormant again on restore.
      // - **Every path this move has just vacated**, because a redirect may already stand
      //   there — dormant, shadowed by the live page that is now leaving — and
      //   `(spaceId, fromPath)` is unique, so the insert below would fail on it. The newer
      //   redirect wins deliberately: the older one was unreachable for as long as the page
      //   sat on top of it, and readers who typed that path most recently were looking for
      //   the page that just moved.
      const reclaimed = moves.filter((m) => m.deletedAt === null).map((m) => m.newPath);
      await tx.redirect.deleteMany({
        where: { spaceId, fromPath: { in: [...oldPaths, ...reclaimed] } },
      });

      // One per rewritten row, soft-deleted ones included: `Redirect.toPageId` points at the
      // page, so Task 11 resolves it to wherever that page is *now* — one hop, whatever
      // happens later. A redirect to a soft-deleted page is inert (Task 11 refuses to deliver
      // readers to one) and starts working again the moment it is restored.
      //
      // No `skipDuplicates`: the delete above is what makes these inserts collision-free, and
      // if that reasoning is ever wrong this should fail loudly rather than drop a redirect
      // and leave the old URL 404ing.
      await tx.redirect.createMany({
        data: moves.map((move) => ({ spaceId, fromPath: move.path, toPageId: move.id })),
      });

      await tx.auditLog.create({
        data: {
          actorId: viewer.id,
          action: "page.move",
          spaceId,
          pageId: page.id,
          // Both paths, both parents, and the row count. The paths because this page can be
          // moved again and the row would otherwise not say where it went; the count because
          // "a move rewrote 40 pages" is the difference between a rename and a
          // reorganisation, and nothing else records it.
          detail: {
            from: oldPath,
            to: newPath,
            fromSlug: page.slug,
            toSlug: slug.slug,
            fromParentId: page.parentId,
            toParentId: input.newParentId,
            rewritten,
          } satisfies Prisma.InputJsonObject,
        },
        select: { id: true },
      });

      // TODO(phase-4): spec §9 step 6 — the search vector stores the path, so every rewritten
      // row's index entry is now stale. Phase 4 owns the refresh; it belongs in this
      // transaction when it exists, not in a follow-up job that can fail separately.

      // TODO(phase-5): spec §10 — a move is a rename in the git mirror. Phase 5 enqueues a
      // `GitJob` here, committed with this transaction.

      return {
        ok: true,
        page: {
          id: page.id,
          spaceKey,
          path: newPath,
          previousPath: oldPath,
          rewritten,
          redirects: moves.length,
        },
      };
    });
  } catch (error) {
    // The transaction has rolled back — no path rewritten, no redirect, no audit row — and
    // the honest answer for a page that stopped being movable is the one an already-deleted
    // page gets, because that is what happened.
    if (error instanceof PageNoLongerMovable) return { ok: false, reason: "not-found" };
    throw error;
  }
}
