import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseNonAdmin, type AdminRefusal } from "@/lib/admin/gate";
import { writeAudit } from "@/lib/audit/log";
import { enqueueMirrorJobs } from "@/lib/git/enqueue";
import type { Viewer } from "@/lib/authz/types";

/**
 * Reconciling the versions that predate the mirror — Phase 7 Task 7, and **the third of the debts
 * Phase 5 named and deferred to this phase**.
 *
 * ## What Phase 5 said, and the exact sentence that must not be undone
 *
 * *"The queue is not a reconciliation."* Every job in `GitJob` exists because a publish, a move, a
 * delete or a restore put it there, inside that mutation's own transaction; nothing walks the
 * database looking for work. That is why a page published before the mirror existed carries
 * `gitSha = null` for ever, and why Task 8's failures page says so in a section headed *what this
 * list does not cover*.
 *
 * This module does **not** change that, and the distinction is the whole design:
 *
 * - **Nothing here runs on its own.** There is no cron entry, no hook in publish, no lazy repair on
 *   read. `reconcileUnmirrored` runs when a super admin presses a button on `/admin/git`, and it
 *   writes one audit row saying they did.
 * - **The gap stays visible until somebody closes it.** §10's value is that an unmirrored version
 *   is *noticed* — the reader paints "not mirrored" and the history page says why. A silent
 *   backfill would replace a visible gap with an invisible assumption, which is the failure mode
 *   the mirror exists to prevent, arriving as a convenience.
 * - **The count comes before the act.** {@link unmirroredReport} is a read of four numbers and a
 *   per-space breakdown; nothing is queued until the operator has seen how much would be.
 *
 * ## What a "gap" is here, stated precisely, because three states look alike
 *
 * A published version with no `gitSha` can be in three states, and only the first is this pass's:
 *
 * 1. **Nothing was ever queued for it.** Published before Phase 5 existed, or published by a build
 *    that predates the enqueue. There is no job, so nothing will ever mirror it. This is the gap.
 * 2. **A job is queued or retrying.** The worker has not got to it, or the remote is refusing.
 *    Queuing a second `PUBLISH` would be work the queue is already going to do, and it would sit
 *    *behind* the first — Task 6's barrier — so it could not even arrive sooner. Counted as
 *    {@link ReconcileReport.awaitingQueue} and left alone.
 * 3. **A job has failed.** The page is wedged: nothing later for it can be claimed until somebody
 *    intervenes, so a reconcile job would join a queue that is not moving and make the failures
 *    page's *blocked* count grow. Also counted as `awaitingQueue`, because from this pass's point
 *    of view they are one fact — *the queue already knows about this page* — and the failures list
 *    below it on the same surface is where the difference is acted on.
 *
 * So the predicate is "no unfinished job **of any kind** for this page", which is
 * `state <> 'DONE'` — deliberately the same set Task 6's barrier calls unfinished, because the
 * question being asked is the same one: *would a new job for this page be applied, or would it
 * queue behind something?*
 *
 * ## It reuses `enqueueMirrorJobs` rather than inventing a second way to make a job
 *
 * Two Phase 5 rules bear on that and both are the callee's, not this module's:
 *
 * - **A page that was never published enqueues nothing.** `enqueueMirrorJobs` filters
 *   `publishedVersionId !== null` and owns the argument (a job whose only outcome is "nothing to
 *   do" makes every drain assertion weaker). This module's `where` does not restate it — it asks
 *   for pages whose *published version* has no sha, and a relation filter on a to-one implies the
 *   relation exists, so the rule is stated once and in the place that has the argument.
 * - **Every job captures its address at enqueue time.** `spaceKey` and `path` come from the rows
 *   read in this transaction, which is exactly right for a repair: the file this job should write
 *   belongs at the page's address **now**, not at whatever address it had when it was published.
 *   A page published in 2025 and moved twice since has one correct mirror path, and it is today's.
 *
 * The jobs are `PUBLISH`, so they carry the version id and write bytes. `MOVE`, `DELETE` and
 * `RESTORE` are not reconcilable and are not attempted: their bytes are not derivable from a row —
 * Task 6 measured that a `MOVE` whose source is not in the tree is a success that did nothing, and
 * a `DELETE` of a file that was never written is the same. A `PUBLISH` at the page's current path
 * converges the tree from any of them.
 *
 * ## Soft-deleted pages are excluded, and that is the one place a filter here is load-bearing
 *
 * `deletedAt: null`, stated at the line below. A soft-deleted page's file is *supposed* to be
 * absent from the mirror — its `DELETE` job removed it, or it never had one — so reconciling it
 * would write a file for a page the product has taken down, and `restorePage` is what puts it back
 * legitimately. This is the opposite call from `src/lib/git/failures.ts` and
 * `src/lib/git/worker.ts`, which are both deliberately blind to `deletedAt`, and the difference is
 * that they are about jobs the product created while this creates them.
 *
 * ## The permission, and the audit line
 *
 * `refuseNonAdmin`, once, from `src/lib/admin/gate.ts`. `readableSpace` is absent and would be
 * inert — `readableSpaceWhere` answers `{}` for the only viewer that gets past the gate, the
 * `resolveRedirect` shape — *and* wrong: an installation's mirror does not stop at the spaces the
 * administrator happens to belong to, and a repair pass with a blind spot would leave exactly the
 * closed spaces unmirrored. `visiblePage` is absent because this module states the soft-delete
 * predicate itself, for the reason above, and `visiblePage()` would also carry a permission
 * predicate that is inert here.
 *
 * **No `space.access` row**, and this is Task 6's line rather than Task 1's: what this surface
 * shows is *containers and integers* — a space key and how many of its pages are unmirrored — with
 * no page title and no path anywhere. `listSpaceMembers` and `listBlockingPages` audit because
 * they name what is *inside* a private space; a count of documents is what `listSpacesForAdmin`
 * already shows every super admin without writing a row. If a later phase lists the pages
 * themselves here, that listing needs its own endpoint and its own `auditSpaceAccess` call, which
 * is the shape both of those already have.
 */

/**
 * The most jobs one press may queue.
 *
 * **A bound, because a reconcile creates work rather than removing it** — which is the difference
 * from `sweepFinishedJobs`, deliberately uncapped in the same surface. Every row written here
 * costs the worker a commit and a push against a real git host, drained serially under one
 * working-tree lock, so a press that queued ten thousand jobs would be an operator action whose
 * consequence the operator cannot see the end of: hours of pushing, a failures page that cannot be
 * read while it happens, and no way to stop it short of deleting rows by hand.
 *
 * Five hundred is one worker run's worth of work rather than a measured ceiling, and the surface
 * says how many are left so the pass is obviously repeatable. It is the same shape as
 * `MAX_MIRROR_FAILURES` and `MAX_BLOCKING_PAGES` — a bound on what one interaction produces, with
 * the remainder stated rather than hidden.
 */
export const MAX_RECONCILE_JOBS = 500;

/** One space's share of the gap. A key and an integer — see the docstring's audit line. */
export type ReconcileSpaceRow = {
  key: string;
  unmirrored: number;
};

export type ReconcileReport = {
  /**
   * Published, live pages whose published version carries no commit **and** that have no
   * unfinished job — the pages this pass would queue.
   */
  unmirrored: number;
  /**
   * Published, live pages with no commit that the queue already knows about: a job is pending,
   * running, or has failed. Not this pass's, and counted so that a zero above is readable —
   * "nothing to reconcile" and "everything unmirrored is already queued" are different states, and
   * a surface that showed one number could not tell them apart.
   */
  awaitingQueue: number;
  /** Where the gap is, biggest first, then by key so two requests cannot disagree. */
  spaces: ReconcileSpaceRow[];
  /** {@link MAX_RECONCILE_JOBS}, so the surface can say what one press will do. */
  cap: number;
  /** More than the cap: one press will not close the gap, and the surface says so. */
  truncated: boolean;
};

export type ReconcileReportResult = { ok: true; report: ReconcileReport } | AdminRefusal;

/**
 * Live, published pages whose published version has no commit.
 *
 * Stated once, here, and used by the count and by the pass — a repair that queued a set the
 * operator was not shown would be the "prediction and act disagree" failure this surface's whole
 * shape is against. `unfinished` splits the two halves.
 *
 * `publishedVersion: { gitSha: null }` is a relation filter on a nullable to-one, so it implies the
 * relation exists: a page with no published version cannot match. That is why there is no
 * `publishedVersionId: { not: null }` beside it — see the module docstring on not restating
 * `enqueueMirrorJobs`'s rule.
 */
function unmirroredWhere(unfinished: boolean): Prisma.PageWhereInput {
  return {
    // The one load-bearing filter in this module. A soft-deleted page's file is *supposed* to be
    // gone from the mirror, so reconciling it would write a file the product has taken down;
    // `restorePage` is the legitimate way one comes back. Removing this line fails "a soft-deleted
    // page is never reconciled" in `tests/integration/git-reconcile.test.ts`.
    deletedAt: null,
    publishedVersion: { gitSha: null },
    // "Would a new job for this page be applied, or queue behind something?" — `state <> 'DONE'`
    // is Task 6's own definition of unfinished, used here because it is the same question.
    gitJobs: unfinished ? { some: { state: { not: "DONE" } } } : { none: { state: { not: "DONE" } } },
  };
}

/**
 * The prediction half: two counts and a per-space breakdown, no titles and no paths.
 *
 * **No audit row** — see the module docstring. Two queries and a `groupBy` rather than one: the
 * breakdown needs `Space.key`, which `groupBy` on `Page` cannot select, and joining it back is one
 * small read of a table with two rows in this installation.
 */
export async function unmirroredReport(viewer: Viewer): Promise<ReconcileReportResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const [unmirrored, awaitingQueue, groups] = await Promise.all([
    db.page.count({ where: unmirroredWhere(false) }),
    db.page.count({ where: unmirroredWhere(true) }),
    db.page.groupBy({
      by: ["spaceId"],
      where: unmirroredWhere(false),
      _count: { _all: true },
    }),
  ]);

  const spaces: ReconcileSpaceRow[] = [];
  if (groups.length > 0) {
    const rows = await db.space.findMany({
      where: { id: { in: groups.map((group) => group.spaceId) } },
      // Explicit select, never `include`. No permission predicate: this is the same read
      // `listSpacesForAdmin` makes, on a surface only a super admin reaches, and a
      // `readableSpace(viewer)` here would answer `{}` for that viewer — a filter no test could
      // be written against.
      select: { id: true, key: true },
    });
    const keyOf = new Map(rows.map((row) => [row.id, row.key]));
    for (const group of groups) {
      const key = keyOf.get(group.spaceId);
      // A space id with no row is unreachable — `Page.spaceId` is a foreign key — and skipping
      // rather than inventing a label is the honest branch. It is not the `byId.get` lookup Phase
      // 4 measured as a hidden second filter: the count above is already final, and this loop only
      // labels it.
      if (key !== undefined) spaces.push({ key, unmirrored: group._count._all });
    }
    spaces.sort((a, b) => b.unmirrored - a.unmirrored || a.key.localeCompare(b.key));
  }

  return {
    ok: true,
    report: {
      unmirrored,
      awaitingQueue,
      spaces,
      cap: MAX_RECONCILE_JOBS,
      truncated: unmirrored > MAX_RECONCILE_JOBS,
    },
  };
}

export type ReconcileResult =
  | {
      ok: true;
      /** `GitJob` rows actually written — the number to report, not the one predicted. */
      queued: number;
      /** Still unmirrored and unqueued after this pass. Non-zero means press again. */
      remaining: number;
      cap: number;
    }
  | AdminRefusal;

/**
 * Queue a `PUBLISH` for up to {@link MAX_RECONCILE_JOBS} pages that the mirror never heard about.
 *
 * The operator action. One transaction: the pages are read, the jobs are written through
 * `enqueueMirrorJobs`, the remainder is counted and the audit row is committed with all of it —
 * an audit row that is not committed with the change it describes is a lie either way it fails.
 *
 * ## The race it does not close, stated rather than hidden
 *
 * Between this read and its commit, a publish in another transaction can enqueue a `PUBLISH` for a
 * page this pass has also picked up. The cost is one duplicate job, and it is genuinely small:
 * Task 6's barrier applies them in id order, the second finds a working tree that already holds
 * those bytes, `git add` stages nothing, and `commit()` returns `committed: false` with `sha` =
 * HEAD — the path Phase 5 built for a retried push. So the second job records the same sha and
 * pushes nothing. Locking `Page` for the duration to prevent it would put a repair pass in the way
 * of every publish in the installation, which is the trade `updateSpace` refused for the same
 * reason.
 *
 * ## One statement per space, in one transaction
 *
 * `enqueueMirrorJobs` takes one `spaceKey` per call, because a job's address is
 * `<spaceKey>/<path>.md` and the key is captured rather than joined. Grouping here rather than
 * calling it per page is not an optimisation of round trips — it is what keeps each call's rows in
 * one `createMany`, in array order, so the sequence issues ids in that order. Task 3's rule: the
 * sequence is the ordering, and nothing may help it.
 */
export async function reconcileUnmirrored(viewer: Viewer): Promise<ReconcileResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  return await db.$transaction(async (tx) => {
    const pages = await tx.page.findMany({
      where: unmirroredWhere(false),
      /*
       * Grouped by space and then by path, which is deterministic and is the order the jobs are
       * written in. Not "oldest publish first": the pages this pass is for were published before
       * the mirror existed, so their timestamps are all on the far side of one event and ordering
       * by them would sort a set that is, for this purpose, simultaneous. A stable order matters
       * because a truncated pass is meant to be pressed again — an arbitrary one would revisit the
       * same pages while others waited.
       */
      orderBy: [{ spaceId: "asc" }, { path: "asc" }],
      take: MAX_RECONCILE_JOBS,
      // Explicit select, never `include`. Exactly the columns `MirrorTarget` needs, plus the
      // space key it captures.
      select: {
        id: true,
        path: true,
        publishedVersionId: true,
        space: { select: { key: true } },
      },
    });

    const bySpace = new Map<string, { id: string; path: string; publishedVersionId: string | null }[]>();
    for (const page of pages) {
      const group = bySpace.get(page.space.key) ?? [];
      group.push({ id: page.id, path: page.path, publishedVersionId: page.publishedVersionId });
      bySpace.set(page.space.key, group);
    }

    let queued = 0;
    const perSpace: Record<string, number> = {};
    for (const [spaceKey, targets] of bySpace) {
      const written = await enqueueMirrorJobs(tx, {
        kind: "PUBLISH",
        spaceKey,
        // `fromPath` is null: this is not a move. The address is the page's current one, which is
        // where a repaired file belongs — see the module docstring.
        targets: targets.map((target) => ({ ...target, fromPath: null })),
      });
      queued += written;
      perSpace[spaceKey] = written;
    }

    // After the writes, inside the same transaction, so the number an operator is told to press
    // again for is the state their own press produced. The same predicate: a page this pass just
    // queued now has an unfinished job and is no longer counted.
    const remaining = await tx.page.count({ where: unmirroredWhere(false) });

    await writeAudit(tx, {
      actorId: viewer.id,
      /*
       * Null, `mirror.sweep`'s standing: one act over pages in every space at once. The per-space
       * breakdown is in `detail` instead, which is where an auditor asking "what did this touch"
       * looks, and it is the same breakdown the operator was shown before pressing.
       */
      spaceId: null,
      action: "mirror.reconcile",
      /*
       * Without this row nothing anywhere says a person decided to mirror versions that predate
       * the mirror: a reconciled job is byte-identical to one a publish enqueued, and once it
       * drains it is a `gitSha` on a version like any other. §10's value is that a gap is noticed;
       * this is the record that somebody closed one.
       */
      detail: { queued, remaining, cap: MAX_RECONCILE_JOBS, spaces: perSpace },
    });

    return { ok: true as const, queued, remaining, cap: MAX_RECONCILE_JOBS };
  });
}
