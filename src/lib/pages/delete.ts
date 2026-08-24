import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { subtreePattern } from "@/lib/pages/like";
import { descendantPaths } from "@/lib/pages/slug";
import type { Viewer } from "@/lib/authz/types";

export type DeletedPage = {
  id: string;
  spaceKey: string;
  /** Where the page was, which is also the `Redirect.fromPath` written for it. */
  path: string;
  /** Rows soft-deleted: the page plus every *live* descendant. Never 0. */
  deleted: number;
  /** `Redirect` rows written. Equals `deleted`, or 0 when there is no surviving ancestor. */
  redirects: number;
  /**
   * Where the redirects point, or `null` for a page with no surviving ancestor — see the
   * root-page decision on `deletePage`.
   */
  redirectTo: string | null;
};

export type DeleteResult =
  | { ok: true; page: DeletedPage }
  /**
   * The page does not exist, is already soft-deleted, or sits in a space this viewer cannot
   * read — one answer for all three, and never a 403, which would confirm the page is real.
   * Tasks 4, 6, 7, 8, 9 and 10 all draw this line in the same place and the seven must not
   * diverge.
   */
  | { ok: false; reason: "not-found" }
  /**
   * Readable but not writable — a `VIEWER` in the space, or anyone in an `ALL_STAFF` space
   * they do not belong to. Safe to be specific: they can already see the page.
   */
  | { ok: false; reason: "forbidden" };

export type RestoredPage = {
  id: string;
  spaceKey: string;
  /** Where the page is again — under its parent, wherever that parent has since moved to. */
  path: string;
  /** Rows brought back: the page plus every descendant the same delete took. Never 0. */
  restored: number;
  /** Redirects cleared because the paths they stood at hold a live page again. */
  redirectsCleared: number;
};

/** Why a restore was refused. The `message` is what a human reads. */
export type RestoreErrorCode = "not-deleted" | "ancestor-deleted" | "path-occupied";

/**
 * No `field`, unlike `MoveFieldError` and `CreateFieldError`. Restore has no form: the caller
 * picked a row out of a list of deleted pages and pressed one button, so there is nowhere to
 * attach a rejection except the page itself.
 */
export type RestoreError = { code: RestoreErrorCode; message: string };

export type RestoreResult =
  | { ok: true; page: RestoredPage }
  | { ok: false; reason: "not-found" }
  /**
   * **Carries a message, and this is the one `forbidden` in the codebase that does.** The
   * permission asymmetry is deliberate — `EDIT` deletes and `ADMIN` restores, so an editor
   * cannot undo their own delete — and an asymmetry nobody can guess needs to say who can.
   * Every other `forbidden` in Phase 2 is the ordinary "you may read but not write" and the
   * caller already knows what it means.
   */
  | { ok: false; reason: "forbidden"; message: string }
  | { ok: false; reason: "invalid"; error: RestoreError };

const invalidRestore = (error: RestoreError): RestoreResult => ({
  ok: false,
  reason: "invalid",
  error,
});

/**
 * Thrown to abort a transaction after rows have already been written. Rolling back is the
 * point, and a sentinel class rather than a bare `Error` so the catch cannot swallow a genuine
 * database failure and report it as a missing page.
 */
class PageNoLongerDeletable extends Error {}
class PageNoLongerRestorable extends Error {}

/**
 * Thrown when a subtree statement touched a different number of rows than were read and
 * validated under the lock. Not a race to commit through and not one to report as "not found":
 * it means the statement's `LIKE` matched rows the boundary filter did not, which is what a
 * broken escape looks like. Task 10 carries the identical guard for the identical reason.
 */
class SubtreeStatementTouchedUnexpectedRows extends Error {}

/** What the subtree read returns: enough to stamp, redirect and audit each row. */
type SubtreeRow = { id: string; path: string; deletedAt: Date | null };

/**
 * Reads the subtree rooted at `path` — the row itself plus everything strictly below it at a
 * `/` boundary — soft-deleted rows included.
 *
 * Raw, and that is not a style choice. `path: { startsWith: path + "/" }` escapes no `LIKE`
 * metacharacter and adds no `ESCAPE` clause, so for a page at `probe/back\` Prisma emits
 * `LIKE 'probe/back\/%'`, the backslash escapes the `/`, and the page's own child stops
 * matching — the read comes back one row short **silently**. Measured against Postgres during
 * Task 10.
 *
 * The permission predicate cannot be a Prisma `where` here. It is pinned to `spaceId`, which
 * both callers resolve through `readableSpace` twice — once outside the lock and once inside
 * it — before this runs, and no row outside that space can match.
 *
 * The returned rows are filtered a second time in TypeScript, by `descendantPaths` rather than
 * by the `LIKE` pattern. That is not redundancy: it is an *independent* answer to "which rows
 * are in this subtree", derived from the rule that has its own unit tests, which is what lets
 * each caller compare its statement's row count against two opinions instead of one opinion
 * with itself. `architecture/mqtt-contracts-v2` is the case both halves must refuse for
 * `architecture/mqtt-contracts`.
 */
async function readSubtree(
  tx: Prisma.TransactionClient,
  spaceId: string,
  path: string,
): Promise<SubtreeRow[]> {
  const candidates = await tx.$queryRaw<SubtreeRow[]>`
    SELECT "id", "path", "deletedAt"
      FROM "Page"
     WHERE "spaceId" = ${spaceId}
       AND ("path" = ${path} OR "path" LIKE ${subtreePattern(path)} ESCAPE '\\')
     ORDER BY "path" ASC`;
  return candidates.filter((row) => descendantPaths(path, "", row.path) !== row.path);
}

/**
 * Soft-deletes a page **and its whole subtree**, and leaves a redirect behind.
 *
 * ## The subtree, in one statement
 *
 * Leaving children visible under a deleted parent produces pages that are reachable by URL
 * with a breadcrumb pointing at a 404 and a nav rail that has lost the branch above them —
 * `buildTree` promotes a node whose parent is missing from the result set to a **root**, so a
 * third-level page would reappear as a top-level module. So the descendants go with it, in one
 * `UPDATE`, matched by the same escaped `LIKE` pattern Task 10's move uses and cross-checked
 * against the boundary rule in `readSubtree`.
 *
 * `AND "deletedAt" IS NULL` is doing two jobs. It is the write predicate — a concurrent delete
 * makes the row count disagree and the whole transaction rolls back — and it is what keeps a
 * descendant that was **already** deleted, in some earlier and separate operation, at its own
 * `deletedAt`. That timestamp is what restore matches on, so overwriting it here would silently
 * enrol an independently deleted page into this delete's restore set.
 *
 * ## The stamp is one value, computed once
 *
 * Every row this call takes down gets the *same* `deletedAt`, and `restorePage` restores
 * exactly the rows carrying it. That is the whole mechanism behind "restore undoes one delete,
 * not everything that has ever been deleted under here". It is a JavaScript `Date` rather than
 * SQL `now()` because the audit row and the return value both need the value, and because
 * `now()`'s constant-within-a-transaction semantics would be an implicit dependency where this
 * is an explicit one. Prisma stores `DateTime` at millisecond precision and a JS `Date` is
 * milliseconds, so it round-trips exactly.
 *
 * ## The redirect, including the case the plan does not cover
 *
 * A deleted path gets a `Redirect` to the **nearest surviving ancestor**, so an existing link
 * lands on the section the page lived in rather than on a 404. One per deleted row, not just
 * for the page named: a redirect from `a/b/c` to its own parent `a/b` would be inert the
 * instant it was written, because `a/b` is being deleted in the same breath and
 * `resolveRedirect` refuses to deliver anyone to a soft-deleted page. The nearest surviving
 * ancestor is the same page for every row in the subtree — the deleted root's parent — so the
 * whole subtree points at one place.
 *
 * **A deleted root page gets no redirect at all, and that is a decision.**
 * `Redirect.toPageId` is not nullable, so there is no way to express "this path now belongs to
 * the space landing"; the only alternatives were to invent a target or to change the schema.
 * Inventing one is worse than a 404 — a sibling root is arbitrary, and delivering a reader to
 * an unrelated page with a 308 tells them, permanently and wrongly, that this is where the
 * content went; `resolveRedirect` would be made to lie, and browsers cache 308. Changing the
 * schema to admit a null target is a real option and is deliberately **not** taken in Phase 2:
 * a nullable `toPageId` means every reader of `Redirect` grows a branch, for a case whose
 * correct answer ("this is gone; here is the space") the reader already produces from a plain
 * 404 plus the space rail. So: no surviving ancestor, no redirect, `redirectTo: null`, and the
 * return value says so rather than leaving the caller to infer it from a zero.
 *
 * The same branch covers a subtler case honestly: a page whose `parentId` names a row that is
 * *itself* already soft-deleted. That should not exist — deleting a parent takes its children —
 * but the tree can be handed to this codebase in that state, and "no surviving ancestor" is the
 * true description of it.
 *
 * A dormant `Redirect` may already stand at a path being deleted, shadowed by the live page
 * that is going away, and `(spaceId, fromPath)` is unique — so the insert would die on a
 * `P2002` about something the author never touched. Task 10 hit exactly this and resolved it by
 * deleting first: the newer redirect wins, because the older one was unreachable for as long as
 * the page sat on top of it.
 *
 * Redirects pointing **at** the deleted pages are left alone. `resolveRedirect` refuses a
 * soft-deleted target, so they go inert on their own and start working again on restore, which
 * is exactly what a soft delete should do to them.
 *
 * ## The lock
 *
 * `pg_advisory_xact_lock(hashtext(spaceId))` — byte-identical to the one `createPage` and
 * `movePage` take, pinned as such by a test. Delete writes a `Redirect` at a path a concurrent
 * move may be reclaiming, and reads a subtree a concurrent move may be rewriting; without the
 * shared key those two serialise against their own kind and not against each other. Task 9's
 * publish deliberately takes a `FOR UPDATE` row lock instead, because it never touches
 * `Page.path` — that absence is a decision, not an omission to be fixed.
 *
 * ## The `PageDraft` stays
 *
 * Nothing here touches it. A soft delete exists so that nothing is lost and a restore returns
 * the page as it was, and the draft is the most irreplaceable thing on a page: `PageVersion`
 * rows are immutable history that can always be re-read, while the draft is the only copy of
 * text a human has written and not yet published. Dropping it would make "delete" quietly
 * destructive in exactly the one place where the loss cannot be undone by the restore that is
 * supposed to undo it. It costs nothing to keep: `getPageForEditing`, `canEditPage` and
 * `saveDraft` all carry `visiblePage()`, so no one can read or write the draft of a deleted
 * page, and `PageDraft.pageId` cascades — a *hard* delete still takes it.
 */
export async function deletePage(viewer: Viewer, pageId: string): Promise<DeleteResult> {
  // Authorisation first, outside the transaction and before the lock: an unauthorised caller
  // must never take a space-wide lock that stalls every author in a space they cannot read.
  //
  // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage` owns the
  // top level and `readableSpace` is passed whole as the `space` relation filter. Explicit
  // `select`, never `include`.
  const authorised = await db.page.findFirst({
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    select: { id: true, space: { select: { id: true, key: true, visibility: true } } },
  });
  if (!authorised) return { ok: false, reason: "not-found" };

  if (!can(viewer, authorised.space, "EDIT")) return { ok: false, reason: "forbidden" };

  const spaceId = authorised.space.id;
  const spaceKey = authorised.space.key;

  try {
    return await db.$transaction(async (tx): Promise<DeleteResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;

      // Re-read INSIDE the lock. The read above happened before any serialisation, so by now
      // a move could have rewritten this page's path — and the subtree pattern is built from
      // that path. Restating both predicates rather than trusting the earlier read is this
      // project's one rule for page queries: no query is guarded by call ordering.
      const page = await tx.page.findFirst({
        where: visiblePage({ id: pageId, spaceId, space: readableSpace(viewer) }),
        select: { id: true, path: true, title: true, parentId: true },
      });
      if (!page) return { ok: false, reason: "not-found" };

      // The nearest surviving ancestor. `visiblePage()` is what makes "surviving" mean it:
      // an already-deleted parent matches nothing here and the subtree gets no redirect,
      // which is the honest answer rather than a redirect to a page that 404s.
      //
      // `spaceId` in the filter is not redundant with the authorisation read: without it a
      // `parentId` pointing into another space would produce redirects into this space's
      // namespace aimed at a page that does not live in it.
      const parent =
        page.parentId === null
          ? null
          : await tx.page.findFirst({
              where: visiblePage({
                id: page.parentId,
                spaceId,
                space: readableSpace(viewer),
              }),
              select: { id: true, path: true },
            });

      const subtree = await readSubtree(tx, spaceId, page.path);
      // Rows this call is responsible for. An already-deleted descendant keeps its own
      // `deletedAt` and is not counted, redirected or audited here — it belongs to whichever
      // delete took it, and to that delete's restore.
      const taking = subtree.filter((row) => row.deletedAt === null);

      // The page itself is in its own subtree and was read live under the lock, so an empty
      // result means the row vanished between two statements of one transaction — impossible,
      // and not something to paper over by writing nothing and reporting success.
      if (taking.length === 0) return { ok: false, reason: "not-found" };

      // One value for every row, and the key restore matches on. See the docstring.
      const deletedAt = new Date();

      // One statement, matched by the same escaped pattern the read used. `ESCAPE '\\'` in a
      // TypeScript template literal is a single backslash in the SQL; written `'\'` it would
      // be the escape sequence for a quote and Postgres would receive `ESCAPE ''` and reject
      // it.
      //
      // **`AT TIME ZONE 'UTC'` is load-bearing, and it was measured, not reasoned.** Prisma
      // maps `DateTime` to `TIMESTAMP(3)` — *without* time zone — and stores UTC wall clock in
      // it, converting on the way in and out itself. A raw statement bypasses that: Prisma
      // binds a JavaScript `Date` as a `timestamptz`, and assigning a `timestamptz` to a
      // `timestamp` column converts it to the **session** time zone. On this machine
      // (`Asia/Kuala_Lumpur`) a stamp of `07:00Z` was stored as `15:00` and read back by
      // Prisma as `15:00Z` — eight hours in the future, silently, on a column nothing else
      // compares against the clock. Ordinary Prisma writes are unaffected, which is why no
      // earlier task hit it; every raw write of a `Date` in this codebase needs this cast.
      // Pinned by "the stored deletedAt is the real wall clock, not the session's".
      const deleted = await tx.$executeRaw`
        UPDATE "Page"
           SET "deletedAt" = ${deletedAt}::timestamptz AT TIME ZONE 'UTC'
         WHERE "spaceId" = ${spaceId}
           AND "deletedAt" IS NULL
           AND ("path" = ${page.path} OR "path" LIKE ${subtreePattern(page.path)} ESCAPE '\\')`;

      // The two directions of a row-count disagreement are two different events, and Task 10's
      // single `!==` would report both of them the same way. They are split here because one
      // of them is a race a caller can be told about and the other is not:
      //
      // **Too few.** Every row in `taking` was live when it was read and this statement
      // additionally requires `deletedAt IS NULL`, so a shortfall means a row stopped being
      // live in between — another delete committed while this one was blocked on its row lock.
      // Postgres re-evaluates the predicate after the block, the row falls out, and the honest
      // answer is the one an already-deleted page gets. Rolled back either way.
      //
      // **Too many.** The statement has no boundary filter of its own — the escaped pattern
      // *is* its boundary — so an excess means the pattern matched rows `descendantPaths`
      // rejected. That is the escaping dropped or the `/` boundary replaced by a bare prefix,
      // and it takes down pages this function never audited and never redirected: data loss,
      // not a failed delete, and not something to report as "not found".
      //
      // Like Task 10's equivalent, deleting *only* these lines fails no test. They are not a
      // behaviour of their own; they are what turns two other mutations into a rolled-back
      // delete instead of a silently over-deleted space.
      if (deleted < taking.length) {
        throw new PageNoLongerDeletable(
          `Deleting the subtree at ${page.path} took ${deleted} rows; ${taking.length} were live under the lock`,
        );
      }
      if (deleted > taking.length) {
        throw new SubtreeStatementTouchedUnexpectedRows(
          `Deleting the subtree at ${page.path} touched ${deleted} rows; ${taking.length} were read under the lock`,
        );
      }

      const fromPaths = taking.map((row) => row.path);
      let redirects = 0;
      if (parent !== null) {
        // Clears any dormant redirect standing at a path this delete is vacating. Without it
        // the insert below dies on `(spaceId, fromPath)`.
        await tx.redirect.deleteMany({ where: { spaceId, fromPath: { in: fromPaths } } });
        // No `skipDuplicates`: the delete above is what makes these collision-free, and if
        // that reasoning is ever wrong this should fail loudly rather than drop a redirect.
        const written = await tx.redirect.createMany({
          data: fromPaths.map((fromPath) => ({ spaceId, fromPath, toPageId: parent.id })),
        });
        redirects = written.count;
      }

      await tx.auditLog.create({
        data: {
          actorId: viewer.id,
          action: "page.delete",
          spaceId,
          pageId: page.id,
          // `deletedAt` is in the row because it is the restore key: given only this audit
          // trail, it is what says which rows a later restore brought back. The path because
          // the page can be moved after being restored, at which point nothing else records
          // where it was when it was deleted.
          detail: {
            path: page.path,
            title: page.title,
            deletedAt: deletedAt.toISOString(),
            deleted,
            redirects,
            redirectTo: parent?.path ?? null,
          } satisfies Prisma.InputJsonObject,
        },
        select: { id: true },
      });

      // TODO(phase-4): spec §9 step 6 — the search index still carries every row taken down
      // here. Phase 4 owns the removal; it belongs in this transaction when it exists.

      // TODO(phase-5): spec §10 — a delete is a file removal in the git mirror. Phase 5
      // enqueues a `GitJob` here, committed with this transaction.

      return {
        ok: true,
        page: {
          id: page.id,
          spaceKey,
          path: page.path,
          deleted,
          redirects,
          redirectTo: parent?.path ?? null,
        },
      };
    });
  } catch (error) {
    // The transaction has rolled back — nothing deleted, no redirect, no audit row — and the
    // honest answer for a page that stopped being deletable is the one an already-deleted page
    // gets, because that is what happened.
    if (error instanceof PageNoLongerDeletable) return { ok: false, reason: "not-found" };
    throw error;
  }
}

/**
 * Brings back exactly what one `deletePage` took: the page and every row that call stamped
 * with the same `deletedAt`.
 *
 * ## `ADMIN`, and the asymmetry is the point
 *
 * `EDIT` deletes, `MANAGE_SPACE` restores. An editor therefore cannot undo their own delete,
 * which reads like an oversight and is not: the cost of a delete that is too easy to reverse is
 * a delete that gets used casually, and the cost of a restore that is too easy is a page
 * reappearing at a path someone else has since planned around. The refusal carries a message
 * saying who can, because an asymmetry nobody can guess is one the product has to state.
 *
 * ## The restore set, and why it is not "everything under here"
 *
 * `deletePage` stamps every row it takes with one `deletedAt` and skips rows that already had
 * one. Restore matches that stamp. So a descendant deleted **earlier, on its own** stays
 * deleted, and the admin who restores a section does not silently resurrect a page somebody
 * deliberately removed from it months ago. That is not a partial restore — it is a complete
 * restore of the set the delete actually took.
 *
 * ## All-or-nothing within the set
 *
 * If any row in the set cannot come back, none of them do: one transaction, one `updateMany`,
 * and a row count checked against what was read under the lock. A half-restored subtree is
 * precisely the state the delete's own subtree rule exists to prevent — a page reachable at its
 * URL, absent from the nav rail or promoted by `buildTree` into a bogus top-level module, with
 * a breadcrumb through a 404. There is no version of "restore what you can" that does not
 * produce it, and no way for an admin looking at a success message to tell that it happened.
 *
 * ## Two ways it refuses, and only one of them can happen today
 *
 * **A deleted ancestor** is the real one. Restoring `a/b/c` while `a/b` is still deleted puts
 * the page back at a URL whose parent 404s, and `buildTree` promotes it to a root because its
 * parent is missing from the result set — so it is refused, naming the shallowest deleted
 * ancestor, because that is the page the admin has to restore first.
 *
 * **An occupied path** is the one the plan asks for, and as this codebase stands it **cannot
 * happen**. `(spaceId, path)` is a total unique index that knows nothing about `deletedAt`, so
 * a soft-deleted row goes on holding its path for as long as it exists; `createPage` and
 * `movePage` both read deleted rows on purpose and refuse with `path-occupied-by-deleted`
 * rather than taking it. There is therefore no state in which a deleted page's path is held by
 * anything else, and no test in this file can construct one — the index refuses the insert. The
 * check stays anyway, and stays as a *check* rather than a caught `P2002`: it is one query, it
 * is the difference between a readable sentence and a constraint violation if a future writer
 * ever reaches `Page` without going through create or move (a Phase 3 template importer, a
 * migration), and it would be the first thing to fire if that index were ever made partial on
 * `deletedAt IS NULL` — which is a plausible future optimisation. It is reported as an
 * equivalent mutant rather than pinned by an invented test; see PROGRESS.md.
 *
 * ## What it cleans up
 *
 * Every `Redirect` standing at a path the restore has just made live again. `deletePage` wrote
 * those, pointing at the surviving ancestor, and leaving them would send readers of an
 * *unpublished* restored page up to its parent instead of giving them the 404 an unpublished
 * page gets — because the reader consults `resolveRedirect` only after the page read misses,
 * and an unpublished page always misses. Task 10's move reclaims the same way for the same
 * reason.
 *
 * Redirects pointing **at** the restored pages are left alone and come back to life on their
 * own, which is the half of the soft delete that makes old links work again.
 */
export async function restorePage(viewer: Viewer, pageId: string): Promise<RestoreResult> {
  // **Deliberately not wrapped in `visiblePage()`** — the one read in Phase 2 that is looking
  // *for* a soft-deleted row. The permission predicate is unchanged and stated here as
  // everywhere else; only the soft-delete predicate is absent, and its absence is the feature.
  const authorised = await db.page.findFirst({
    where: { id: pageId, space: readableSpace(viewer) },
    select: { id: true, space: { select: { id: true, key: true, visibility: true } } },
  });
  if (!authorised) return { ok: false, reason: "not-found" };

  if (!can(viewer, authorised.space, "MANAGE_SPACE")) {
    return {
      ok: false,
      reason: "forbidden",
      message:
        "Restoring a deleted page needs space admin. Any editor can delete a page; only a " +
        "space admin can put one back. Ask an admin of this space to restore it.",
    };
  }

  const spaceId = authorised.space.id;
  const spaceKey = authorised.space.key;

  try {
    return await db.$transaction(async (tx): Promise<RestoreResult> => {
      // The same key create, move and delete take. Restore asks whether a path is free and
      // then writes rows that claim it, and it deletes redirects a concurrent move may be
      // about to reclaim; both questions are only answerable while the space's path namespace
      // is held still.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${spaceId}))`;

      const page = await tx.page.findFirst({
        where: { id: pageId, spaceId, space: readableSpace(viewer) },
        select: { id: true, path: true, title: true, deletedAt: true },
      });
      if (!page) return { ok: false, reason: "not-found" };

      // A live page, and this is `invalid` rather than `not-found` on purpose: the viewer is a
      // space admin looking at a page that is right there, so "it is not deleted" tells them
      // nothing they could not already see and saves them hunting for a failure.
      if (page.deletedAt === null) {
        return invalidRestore({
          code: "not-deleted",
          message: `“${page.title}” is not deleted, so there is nothing to restore.`,
        });
      }
      const stamp = page.deletedAt;

      // Every proper ancestor path, derived from this page's own path rather than by walking
      // `parentId`. Two reasons: a `parentId` walk loops on cyclic data, which `buildTree`
      // exists because this table can contain; and the path is what the unique index and the
      // reader's URL are built from, so it is the thing whose ancestry actually has to hold.
      // Exact matches via `in`, so no `LIKE` and nothing to escape.
      const segments = page.path.split("/");
      const ancestorPaths = segments
        .slice(0, -1)
        .map((_, index) => segments.slice(0, index + 1).join("/"));

      if (ancestorPaths.length > 0) {
        const blocked = await tx.page.findFirst({
          where: {
            spaceId,
            path: { in: ancestorPaths },
            deletedAt: { not: null },
            space: readableSpace(viewer),
          },
          // Shallowest first: that is the page the admin has to restore, and restoring it
          // brings this one back with it whenever the two went down together.
          orderBy: { path: "asc" },
          select: { title: true, path: true },
        });
        if (blocked) {
          return invalidRestore({
            code: "ancestor-deleted",
            message:
              `“${page.title}” sits under “${blocked.title}” (${blocked.path}), which is also ` +
              "deleted. Restore that page first — it will bring this one back with it if they " +
              "were deleted together.",
          });
        }
      }

      const subtree = await readSubtree(tx, spaceId, page.path);
      // The set one `deletePage` took, identified by its stamp. `getTime()` rather than object
      // identity: these are two separately hydrated `Date`s for the same millisecond.
      const restoring = subtree.filter(
        (row) => row.deletedAt !== null && row.deletedAt.getTime() === stamp.getTime(),
      );
      // The page itself carries the stamp by construction, so an empty set means the row
      // changed under a lock that exists to stop exactly that.
      if (restoring.length === 0) return { ok: false, reason: "not-found" };

      const restoredPaths = restoring.map((row) => row.path);

      // The occupancy check. Unreachable today — see the docstring — and one query for the
      // difference between a sentence and a `P2002` if it ever stops being.
      const occupant = await tx.page.findFirst({
        where: {
          spaceId,
          path: { in: restoredPaths },
          deletedAt: null,
          space: readableSpace(viewer),
        },
        select: { title: true, path: true },
      });
      if (occupant) {
        return invalidRestore({
          code: "path-occupied",
          message:
            `The path “${occupant.path}” now belongs to “${occupant.title}”, so “${page.title}” ` +
            "cannot go back where it was. Move or rename that page first.",
        });
      }

      // One statement, and `deletedAt: stamp` is the write predicate: anything that has
      // changed these rows since they were read matches nothing, the count disagrees, and the
      // whole restore rolls back rather than bringing half a subtree back.
      const restored = await tx.page.updateMany({
        where: { spaceId, id: { in: restoring.map((row) => row.id) }, deletedAt: stamp },
        data: { deletedAt: null },
      });
      if (restored.count !== restoring.length) {
        throw new PageNoLongerRestorable(
          `Restoring ${page.path} updated ${restored.count} rows; ${restoring.length} were read under the lock`,
        );
      }

      // Every redirect standing where a live page now sits — the ones this page's delete
      // wrote, and any other that has drifted onto one of these paths.
      const cleared = await tx.redirect.deleteMany({
        where: { spaceId, fromPath: { in: restoredPaths } },
      });

      await tx.auditLog.create({
        data: {
          actorId: viewer.id,
          action: "page.restore",
          spaceId,
          pageId: page.id,
          // The stamp identifies which delete this undid, which is the one thing the pair of
          // audit rows cannot otherwise be joined on.
          detail: {
            path: page.path,
            title: page.title,
            deletedAt: stamp.toISOString(),
            restored: restored.count,
            redirectsCleared: cleared.count,
          } satisfies Prisma.InputJsonObject,
        },
        select: { id: true },
      });

      // TODO(phase-4): spec §9 step 6 — every restored row needs its search index entry back.
      // TODO(phase-5): spec §10 — a restore re-adds the files a delete removed from the mirror.

      return {
        ok: true,
        page: {
          id: page.id,
          spaceKey,
          path: page.path,
          restored: restored.count,
          redirectsCleared: cleared.count,
        },
      };
    });
  } catch (error) {
    if (error instanceof PageNoLongerRestorable) return { ok: false, reason: "not-found" };
    throw error;
  }
}
