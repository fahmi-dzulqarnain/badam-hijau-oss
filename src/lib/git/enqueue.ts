import type { GitJobKind, Prisma } from "@prisma/client";

/**
 * The one place a `GitJob` row is written — spec §9 step 8 and §10.
 *
 * Four mutations change what the mirror should contain (`publishPage`, `movePage`,
 * `deletePage`, `restorePage`) and each of them calls this, inside the transaction it already
 * has, with rows it has already read. Nothing else in `src/` may touch the `gitJob` delegate,
 * for the reason `writeAudit` owns `auditLog`: a second writer is a second place the capture
 * rule below can be got wrong, and getting it wrong produces a mirror that is silently one
 * version stale rather than an error anybody sees.
 *
 * ## "Enqueue transactionally" and "git is never on the critical path" are about different steps
 *
 * They read as a contradiction and are not, and this paragraph exists because the next reader
 * will meet one of the two sentences and delete the other.
 *
 * - **The enqueue is transactional, and must be.** Spec §9 step 8 says the job "is committed
 *   with it", so *a published version with no queued job is a state this system cannot reach*.
 *   That is a property of one `INSERT` into the same Postgres, in the same transaction — it
 *   cannot fail for any reason a git host can invent, because no git host is involved. The test
 *   for it is that a **forced enqueue failure rolls the publish back**
 *   (`tests/integration/git-enqueue.test.ts`).
 * - **The push is what must never block a publish.** §10's promise is that documentation does
 *   not go down because a git server does: the clone, the commit, the push and every retry
 *   happen in Task 6's worker, in a different process, on a schedule. A publish never waits on
 *   one, and an unreachable remote leaves `gitSha = null` and a retrying job.
 *
 * So the critical path contains a row insert and does not contain git. Anything in this file
 * that spawns a subprocess, opens a socket or touches a working tree has broken the second
 * property; anything that moves this insert out of the caller's transaction — a `db` client, a
 * `void` call, an `after()` — has broken the first.
 *
 * ## `tx`, never `db`
 *
 * The client is a parameter and it is the caller's **transaction** client. `db.gitJob.create`
 * inside a `$transaction` callback runs on a different connection and commits **independently**:
 * the publish could then roll back and leave a job to mirror a version that does not exist, or
 * — the direction that matters here — the enqueue could commit while the publish rolls back, and
 * the property above would be gone with every test still green. `tests/integration/git-enqueue.test.ts`
 * pins the direction a rollback test cannot see: a publish that fails *after* the enqueue leaves
 * **no** job.
 *
 * ## No permission predicate, deliberately, and this is the exception to the project rule
 *
 * "Every query states its own permission predicate, no exceptions based on call ordering" is
 * this project's rule and this module is a stated exception to it. It is stated rather than
 * silently taken, because an unexplained exception is how the next reader justifies a second one:
 *
 * - There is **no viewer here**, and adding one would be inventing a parameter. The job is not
 *   read by the person who caused it; it is drained by a worker with no session at all.
 * - It **returns nothing about a page** — no path, no title, no id — so there is nothing to
 *   disclose. Its only result is a row count of work it queued.
 * - Every caller has already authorised the *mutation* whose consequence this is, on the page's
 *   own space (`PUBLISH` for publish, `EDIT` for move and delete, `MANAGE_SPACE` for restore),
 *   and re-reading the page here under `visiblePage`/`readableSpace` would be the
 *   `resolveRedirect` mistake this project has recorded twice: a predicate stated in two places
 *   is a predicate neither copy can be tested for.
 *
 * `readableSpace` and `visiblePage` are therefore not imported here, and — the rule that holds
 * whatever else changes — neither may ever be **spread** if a later phase does need one.
 *
 * ## It reads no `Page` row, and that absence is what keeps restore honest
 *
 * Every field of every job comes from the caller's own read. That is not only a capture rule (see
 * below); it is what makes the soft-delete question disappear. A **restore** enqueue is
 * legitimately about a page whose `deletedAt` is set — it is the one caller in this codebase for
 * which a soft-delete filter would be the bug rather than the guard — so a version of this module
 * that read `Page` would need a `deletedAt`-blind query, an explanation of why, and a test. It
 * reads nothing, so it needs none of the three, and `src/lib/pages/visible.test.ts` registers it
 * as `reachesPage: false` with exactly that reason.
 *
 * ## Not an audited action
 *
 * No `AuditLog` row, and `src/lib/audit/log.ts` remains the only module that may touch that
 * delegate. An audit row answers "who did what to this page"; enqueueing is not something a
 * person did, it is the mechanical consequence of the publish/move/delete/restore that **is**
 * already audited, in the same transaction, by the same actor, against the same page. A second
 * row would say nothing the first does not and would double every page's history. The queue is
 * also its own record — `DONE` rows are kept precisely so a drain is observable (see the
 * retention note on `GitJob`), and Task 8 is the surface for the ones that fail.
 *
 * ## Ordering is the sequence's job, and nothing here may help
 *
 * One `createMany` writes **byte-identical** `createdAt` values — measured in Task 3, and it is
 * the shape a subtree move uses — which is why `GitJob.id` is an autoincrement sequence and is
 * both identity and order. So the rows go in one statement, in array order, and this module adds
 * no timestamp, no per-row offset and no explicit ordering column. A tiebreak invented here would
 * be a second ordering key, and the query that ordered by the wrong one would still look right.
 */

/**
 * Whatever can write `GitJob`. Structural, and named `tx` for the reason every other client type
 * in this codebase is: the caller passes its **transaction** client, and the sweep in
 * `src/lib/pages/visible.test.ts` matches `db.`/`tx.` delegate calls, so a parameter named
 * anything else would hide this write from it.
 */
export type GitJobClient = Pick<Prisma.TransactionClient, "gitJob">;

/**
 * One page the operation touched, as the caller already has it.
 *
 * Every field is a **capture**: the value as this transaction leaves it, not a value the worker
 * may re-read. That is the load-bearing rule of the model — see the `GitJob` docstring in
 * `prisma/schema.prisma` — and it is why this type asks for values rather than for a page id it
 * could look up. A publish enqueued before a move and drained after it must still write its file
 * at the path it was published at; joining `Page.path` at drain time would put it at the new one
 * and leave the move's own job renaming a file that never existed.
 */
export type MirrorTarget = {
  /** `Page.id`. */
  id: string;
  /**
   * Where this job's file ends up: `Page.path` **as this transaction leaves it** — the new path
   * for a move, and simply the page's path for the other three kinds.
   */
  path: string;
  /**
   * Where the file is now, for a `MOVE`, so the operation is `git mv <fromPath> <path>`. `null`
   * for every other kind. It cannot be reconstructed after the fact: the transaction that
   * enqueues it has already rewritten `Page.path`.
   */
  fromPath: string | null;
  /**
   * The page's published version as this transaction leaves it, or `null` for a page that has
   * never been published.
   *
   * This is the field that decides whether a job is written at all — see `enqueueMirrorJobs`.
   */
  publishedVersionId: string | null;
};

/**
 * The kinds whose job **writes bytes**, and therefore needs a version to write them from.
 *
 * `PUBLISH` and `RESTORE` write the file (the `GitJobKind` docstring says why they are still two
 * values); `MOVE` is a `git mv` and `DELETE` is a `git rm`, and neither reads a document. So
 * those two carry `versionId: null` — not because there is no version, but because there are no
 * bytes. If Task 6 ever finds it needs a document for a move — a repair path for a file the
 * working tree has lost, say — that is a **capture to add here**, never a join at drain time.
 */
const WRITES_BYTES: ReadonlySet<GitJobKind> = new Set<GitJobKind>(["PUBLISH", "RESTORE"]);

/**
 * Queues the mirror work for one mutation, in the caller's transaction. Returns how many rows
 * were written, which is **not** the number of pages the mutation touched — see below.
 *
 * ## A page that was never published enqueues nothing, and that is a decision
 *
 * The mirror only ever holds a file for a page that has been published: the only thing that
 * writes one is a `PUBLISH` job, and only `publishPage` enqueues those. So a move, delete or
 * restore of a never-published page is work with no file to do it to, and the two available
 * answers were a job the worker no-ops on, or no job. **No job**, because:
 *
 * - **A job whose only outcome is "nothing to do" makes every drain assertion weaker.** With one
 *   enqueued per affected row, "the queue drained" and "the mirror changed" stop being the same
 *   observation, and Tasks 6 and 9 can no longer conclude from a job count that any file moved.
 *   That is this project's most repeated test failure — an assertion that passes for a reason
 *   nobody meant — and it would be built into the schema on purpose.
 * - **The faithful-log-of-intent role is already taken, by a table designed for it.**
 *   `AuditLog` records every move, delete and restore whether or not the page was ever
 *   published, outlives the rows it describes, and is indexed by page. `GitJob` is *work*: that
 *   is the argument Task 3 used for giving it real foreign keys where `BugReport` has none, and
 *   the same argument decides this. A queue of things that are not work is a queue whose length
 *   means nothing.
 * - **`DONE` rows are kept and there is no retention pass** (deliberately — see the schema).
 *   Reorganising a space full of drafts would write rows that will never be deleted and never
 *   did anything.
 * - **Task 8's failure page would have to explain them.** A `git mv` of a path the tree does not
 *   contain fails; a worker branch that silently skips it is a branch with no observable effect
 *   and therefore no honest test.
 *
 * What makes it safe is that "published" is monotonic in this product: nothing clears
 * `Page.publishedVersionId`, so a page with no published version has never had a mirrored file
 * and cannot acquire one without a `PUBLISH` job of its own — which is enqueued in the same
 * transaction that sets the column, and which Task 6 drains before any later job for that page.
 * **A future unpublish would break exactly this**, and would have to enqueue a `DELETE` at the
 * point it clears the column; that is the line to change, and this is where to look for it.
 *
 * The test that separates the two answers is a **mixed subtree** — a move where some pages are
 * published and some never were — asserted as a set of `{pageId, fromPath, path}` rather than a
 * count, so it fails under either answer if the implementation takes the other one.
 *
 * Rows the mutation does not affect are the **caller's** filter, not this one's: `movePage`
 * excludes soft-deleted descendants (their file was removed when they were deleted, and their
 * restore will write it wherever the page has since moved to), `deletePage` passes only the rows
 * it actually took down, and `restorePage` only the ones carrying the stamp it is undoing. Each
 * of those is a set the caller has already computed for its own writes; recomputing them here
 * would be a second opinion about which rows an operation touched.
 */
export async function enqueueMirrorJobs(
  tx: GitJobClient,
  args: {
    kind: GitJobKind;
    /**
     * `Space.key`, captured with the paths rather than joined at drain time: the mirror's
     * address is `<spaceKey>/<path>.md`, and a captured path under a joined key would be an
     * address assembled from two different instants.
     */
    spaceKey: string;
    /** The pages this mutation affected. May be empty; the statement is then not run. */
    targets: readonly MirrorTarget[];
  },
): Promise<number> {
  const { kind, spaceKey } = args;
  const writesBytes = WRITES_BYTES.has(kind);

  const data = args.targets
    // The whole of the never-published decision, in one place. See the docstring.
    .filter((target) => target.publishedVersionId !== null)
    .map((target) => ({
      kind,
      pageId: target.id,
      versionId: writesBytes ? target.publishedVersionId : null,
      spaceKey,
      path: target.path,
      fromPath: target.fromPath,
    }));

  if (data.length === 0) return 0;

  // One statement, in array order, so the sequence issues ids in that order. No
  // `skipDuplicates`: two identical jobs are two pieces of work, not a mistake — republishing a
  // page unchanged genuinely does owe the mirror a second commit-and-push attempt, and a queue
  // that silently dropped the second would leave the newer version unmirrored.
  const written = await tx.gitJob.createMany({ data });
  return written.count;
}
