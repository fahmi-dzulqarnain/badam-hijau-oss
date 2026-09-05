import { db } from "@/lib/db";
import { refuseNonAdmin, type AdminRefusal } from "@/lib/admin/gate";
import { writeAudit } from "@/lib/audit/log";
import type { Viewer } from "@/lib/authz/types";

/**
 * Retention for finished `GitJob` rows — Phase 7 Task 7, and **the second of the three debts Phase
 * 5 named and deferred to this phase**.
 *
 * ## What Phase 5 decided, and what must survive being paid
 *
 * Task 3 kept `DONE` rows **deliberately**, and the argument is the thing this module has to
 * preserve rather than the behaviour: *"deleting them makes success unobservable — 'the job
 * drained' and 'no job was ever enqueued' become the same observation, and every drain assertion
 * in Tasks 6 and 9 goes vacuous."* That is this project's most repeated test failure — an
 * assertion that passes for a reason nobody meant — and a sweep is exactly the change that could
 * build it into the schema after the fact.
 *
 * Three things keep it true, and none of them is a comment:
 *
 * 1. **A window, with a floor.** Nothing is swept until it has been finished for
 *    {@link retentionDaysFromEnv} days. Every drain assertion in the suite and in
 *    `scripts/smoke.sh` is about a job that finished seconds ago, so the sweep cannot reach one; a
 *    `0` or garbage `GIT_JOB_RETENTION_DAYS` **falls back to the default** rather than meaning
 *    "delete everything", which is `repo.ts`'s rule for its timeout ceiling — "no ceiling" is the
 *    wedged worker the ceiling exists to prevent, and "no window" is the vacuum this argument
 *    exists to prevent.
 * 2. **`DONE` only.** Not `PENDING`, not `RUNNING`, and — the one worth arguing — **not
 *    `FAILED`**. Deleting a failed job would silently *unblock* its page: Task 6's barrier refuses
 *    to claim a job while any earlier one for its page is unfinished, so removing the row lets
 *    every later change apply over a change that never happened. That is the silently wrong tree
 *    §10 exists to prevent, arriving through a tidy-up. Clearing a failure is a repair with its
 *    own concurrency question against a running worker, and it is nobody's yet.
 * 3. **The durable evidence is not in this table.** A swept `PUBLISH` leaves `PageVersion.gitSha`,
 *    which is the record that those bytes reached the repository and is what the reader paints; a
 *    swept `MOVE`, `DELETE` or `RESTORE` leaves its `AuditLog` row and the tree itself. So the
 *    observability the queue provides is about *recent* drains, and that is exactly the window
 *    this module refuses to touch.
 *
 * ## What retention is **not** for, said out loud so the reasoning cannot go stale
 *
 * It is not a performance fix, and this project has watched a stated measurement rot into a
 * justification before (`MAX_RELATION_TARGETS`, corrected three times). Task 3 measured it: over
 * **60,000 finished rows and eight pending ones, the claim query plans as a bare index scan
 * touching 4 buffers**, because `state` leads `@@index([state, nextAttemptAt, id])` and every
 * `DONE` row is on the far side of the equality. The table getting bigger does not make the worker
 * slower.
 *
 * What it addresses is **unbounded growth**: a row per publish, move, delete and restore, kept for
 * ever, in a database whose backups and migrations carry it. That is a storage and operations
 * concern with no deadline, which is precisely why it is a button an operator presses and not a
 * cron job — Task 3's own words for deferring it here were that *"a sweep with no operator surface
 * is a cron job nobody knows about"*.
 *
 * ## An operator action with a count, and the count comes first
 *
 * {@link finishedJobsReport} is a read: three integers and a timestamp, no rows, no titles, no
 * paths. {@link sweepFinishedJobs} is the write, and it reports what it **did** rather than
 * echoing what it was shown — the two numbers can differ by whatever the worker finished in
 * between, and a surface that reprinted the prediction would be hiding that.
 *
 * ## The permission, the audit, and the two absences
 *
 * `refuseNonAdmin`, once, from `src/lib/admin/gate.ts`. `readableSpace` and `visiblePage` are
 * absent and this module cannot want them: it never reads a `Page` row, or any column of one — a
 * `GitJob` carries its own captured `spaceKey` and `path`, and this module reads neither. There is
 * no cross-space read to audit under §8 either, which is why the only audit row here is about the
 * *act*: nothing is enumerated, so `auditSpaceAccess` has nothing to be called about.
 *
 * The `mirror.sweep` row is the whole of what survives the sweep, which is the standing
 * `system.delete` and `space.member.remove` have — a deletion's only remaining trace. It is
 * written in the same transaction as the delete, because an audit row that is not committed with
 * the change it describes is a lie either way it fails.
 */

/** The default window, in days, when the environment does not set one. */
export const GIT_JOB_RETENTION_DEFAULT_DAYS = 90;

/**
 * The shortest window this module will honour.
 *
 * One day, and it is the floor rather than a suggestion: a value below it falls back to the
 * default. This is the line that keeps Task 3's observability argument true no matter what an
 * environment says — with `GIT_JOB_RETENTION_DAYS=0` an operator could otherwise make "the job
 * drained" and "no job was ever enqueued" the same observation with one press, which is the exact
 * state Phase 5 refused to ship.
 */
export const GIT_JOB_RETENTION_MIN_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a finished job is kept, from `GIT_JOB_RETENTION_DAYS`.
 *
 * **It has a default, and that is the opposite of `ATTACHMENT_RETENTION_DAYS`'s decision** — which
 * refuses to run at all when its variable is unset, on the ground that guessing a retention window
 * is a policy decision a script has no basis to make silently. Two things differ here and both
 * point the other way:
 *
 * - **This is a page, not a cron job.** `scripts/sweep-attachments.mjs` deletes on being run, so an
 *   assumed window there is an assumed *deletion*. Nothing here deletes until an operator has been
 *   shown the count the window produces and has pressed the button; a defaulted window is a
 *   defaulted **prediction**, and the operator sees it before it becomes an act.
 * - **`.env.test` is untracked and per-checkout.** A variable added to `.env.example` with no
 *   default breaks every other checkout silently — that is how merging Phase 6 produced 27 phantom
 *   failures here, and `REVIEW_INTERVAL_MONTHS` was given a code-side default in Task 4 for
 *   exactly that reason. Refusing to render `/admin/git` because a checkout has not caught up
 *   would break the *failures* list too, which is the part of the page that has nothing to do with
 *   retention.
 *
 * Garbage, zero and negatives fall back rather than being honoured — see
 * {@link GIT_JOB_RETENTION_MIN_DAYS}. A fractional value is floored, so `0.5` is a fallback and
 * `1.5` is one day: the window is a number of days and a partial day is a rounding argument nobody
 * needs to have.
 */
export function retentionDaysFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): number {
  const parsed = Math.floor(Number(env.GIT_JOB_RETENTION_DAYS));
  if (!Number.isFinite(parsed) || parsed < GIT_JOB_RETENTION_MIN_DAYS) {
    return GIT_JOB_RETENTION_DEFAULT_DAYS;
  }
  return parsed;
}

/** What the surface says before anything is pressed. Integers and one timestamp; no rows. */
export type RetentionReport = {
  /** The window in force, so the number below is readable without knowing the environment. */
  retentionDays: number;
  /** Everything the sweep would delete were it run now — the number the button acts on. */
  sweepable: number;
  /**
   * Every `DONE` row, swept or not.
   *
   * Here so the operator can see the growth this addresses *and* how much of it the window is
   * deliberately keeping: `sweepable` alone cannot distinguish "nothing has accumulated" from "a
   * great deal has, all of it inside the window".
   */
  finished: number;
  /**
   * When the oldest finished job was last attempted, or null when there are none.
   *
   * `GitJob.updatedAt`, which the schema defines as when a job was last attempted and is therefore
   * when a `DONE` row finished. It answers the question a count cannot: how far back this table
   * goes, and so whether a window of `retentionDays` would reach anything at all.
   */
  oldestFinishedAt: Date | null;
};

export type RetentionReportResult = { ok: true; report: RetentionReport } | AdminRefusal;

/**
 * The prediction half. Reads three numbers about `GitJob` and nothing else.
 *
 * **No audit row**, and it is Task 6's line rather than Task 1's: this is a count of the
 * installation's own machinery, with no page title, no path and no space in it — there is nothing
 * here a `MEMBERS` space keeps to itself, so there is nothing for §8 to record. Contrast
 * `listMirrorFailures` on the same page, which paints titles and paths and audits one row per
 * space that produced one.
 */
export async function finishedJobsReport(viewer: Viewer): Promise<RetentionReportResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const retentionDays = retentionDaysFromEnv();
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

  // Three statements rather than one grouped query: `groupBy` would still need the cutoff
  // predicate as a separate pass, and these are index-served counts on a table whose only large
  // population is exactly the one `state` leads the index on.
  const [finished, sweepable, oldest] = await Promise.all([
    db.gitJob.count({ where: { state: "DONE" } }),
    db.gitJob.count({ where: { state: "DONE", updatedAt: { lt: cutoff } } }),
    db.gitJob.findFirst({
      where: { state: "DONE" },
      orderBy: { updatedAt: "asc" },
      // Explicit select, never `include`.
      select: { updatedAt: true },
    }),
  ]);

  return {
    ok: true,
    report: {
      retentionDays,
      sweepable,
      finished,
      oldestFinishedAt: oldest?.updatedAt ?? null,
    },
  };
}

export type SweepResult =
  | {
      ok: true;
      /** Rows actually deleted — not the number the report predicted. See the module docstring. */
      deleted: number;
      retentionDays: number;
      /** Everything finished before this instant was in scope. */
      cutoff: Date;
      /** `DONE` rows left, all of them inside the window. */
      remaining: number;
    }
  | AdminRefusal;

/**
 * Delete the finished jobs that have been finished longer than the window. The operator action.
 *
 * ## The window comes from the environment and never from the request
 *
 * There is no `days` parameter, and that absence is the design: a retention policy is a property
 * of a deployment, and a number typed into a browser that then deletes rows is a policy decision
 * made by whoever last used the page. The endpoint therefore has **no body at all** — see
 * `src/app/api/admin/git/retention/route.ts` — so there is nothing to validate and nothing a
 * hostile request can widen. The consequence is stated rather than hidden: changing the window is
 * a deployment change, and an operator who wants a different one edits `GIT_JOB_RETENTION_DAYS`.
 *
 * ## One statement, uncapped, and why that is not the reconcile pass's answer
 *
 * {@link import("./reconcile").reconcileUnmirrored} is bounded to a few hundred jobs per press,
 * because what it creates is **work**: every row it writes costs the worker a commit and a push.
 * A delete of already-finished rows creates nothing — the cost is one statement over an
 * index-served predicate, and the operator has already been shown its size. A cap here would mean
 * pressing a button repeatedly to reach a state one press could reach, with a count that shrinks
 * for reasons the surface would have to explain.
 *
 * What it can cost, said at the line: a very large first sweep is a long-running `DELETE` holding
 * row locks on rows nothing else reads — a worker only ever locks `PENDING` rows, and only with
 * `SKIP LOCKED` — so the worst case is a slow request rather than a blocked drain.
 */
export async function sweepFinishedJobs(viewer: Viewer): Promise<SweepResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const retentionDays = retentionDaysFromEnv();
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

  return await db.$transaction(async (tx) => {
    /*
     * `state: "DONE"` is the whole safety argument and it is stated once, here. The predicate is
     * not "not PENDING and not RUNNING": that spelling would include `FAILED`, and deleting a
     * failed job unblocks its page's queue silently — Task 6's barrier is `state <> 'DONE'`, so
     * the row that is refusing to let later changes apply is the row a broader predicate would
     * remove. `tests/integration/git-retention.test.ts` asserts an old FAILED row survives, which
     * is the mutation this line exists for.
     */
    const removed = await tx.gitJob.deleteMany({
      where: { state: "DONE", updatedAt: { lt: cutoff } },
    });

    // Read after the delete, inside the same transaction, so the number the operator is told is
    // the state their own press produced rather than one assembled from two instants.
    const remaining = await tx.gitJob.count({ where: { state: "DONE" } });

    await writeAudit(tx, {
      actorId: viewer.id,
      /*
       * Null, and this is the third action in the union that names no space — `system.*`'s
       * standing. A sweep is one act over rows belonging to every space at once, and picking one
       * of them (the last space in the list, say) would put a false answer in the column an
       * auditor filters by. Splitting it per space would be worse: the operator performed one act,
       * and `GitJob.spaceKey` is a captured string rather than a foreign key, so the rows cannot
       * be attributed to a `Space.id` without a join the delete has already made impossible.
       */
      spaceId: null,
      action: "mirror.sweep",
      /*
       * The row is the only surviving record — the standing `system.delete` has, and the reason
       * this action exists at all. It carries the window and the cutoff as well as the count,
       * because "37 rows were deleted" is unreadable a year later without the rule that chose
       * them, and `GIT_JOB_RETENTION_DAYS` is a deployment setting nothing else records.
       *
       * The cutoff is an ISO string: `detail` is a JSON column, and a `Date` in it is a value
       * whose serialisation is Prisma's business rather than this row's.
       */
      detail: {
        retentionDays,
        cutoff: cutoff.toISOString(),
        deleted: removed.count,
        remaining,
      },
    });

    return {
      ok: true as const,
      deleted: removed.count,
      retentionDays,
      cutoff,
      remaining,
    };
  });
}
