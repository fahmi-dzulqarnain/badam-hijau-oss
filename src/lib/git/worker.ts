import { PrismaClient, type GitJobKind, type GitJobState } from "@prisma/client";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { mirrorDocumentOf, type MirroredVersion } from "@/lib/git/document";
import type { FrontmatterValue } from "@/lib/markdown/frontmatter";
import {
  commit,
  ensureRepository,
  gitConfigFromEnv,
  mirrorCommitMessage,
  push,
  stageDelete,
  stageMove,
  stageWrite,
  type GitConfig,
  type GitError,
  type GitErrorCode,
  type MirrorRef,
} from "@/lib/git/repo";

/**
 * The worker: claims `GitJob` rows, applies them to the working tree, and finishes them.
 *
 * `src/lib/git/enqueue.ts` is the only writer of these rows and this is the only reader of them.
 * Everything that spawns `git` is in `repo.ts`; everything that decides what a file contains is
 * in `document.ts`; everything that decides where it goes is in `paths.ts`. What is left — and
 * all that is here — is *when* work happens, *in what order*, and *what happens when it fails*.
 *
 * ## No database transaction is open while git runs, and this is the load-bearing rule
 *
 * A push has a sixty-second ceiling (`DEFAULT_NETWORK_TIMEOUT_MS`) and a clone has the same, so a
 * transaction wrapped around a job would sit open for a minute at a time. This project has lost a
 * whole test run to one open transaction, and three test files carry a note about it. So each job
 * is:
 *
 * 1. **a short transaction** — reclaim, then claim, then commit; nothing else;
 * 2. **the git work**, with no transaction open at all;
 * 3. **a second short transaction** — write the terminal state, and the sha with it.
 *
 * Every raw statement below is therefore a single statement, and there is no interactive
 * transaction in this module that contains an `await` on anything but Postgres.
 *
 * ## Two workers, and the two different things that must not happen
 *
 * They are separate problems with separate mechanisms, and conflating them is how one of the two
 * ends up unprotected:
 *
 * - **Two workers must not claim the same job.** {@link claimNextJob} is one `UPDATE … WHERE id =
 *   (SELECT … WHERE state = 'PENDING' … FOR UPDATE SKIP LOCKED LIMIT 1)`. The state predicate is
 *   inside the locking read, so the claim is a conditional transition: a second worker whose
 *   subquery is racing re-evaluates it against the committed row version and matches nothing.
 * - **Two workers must not both hold the working tree.** That is *not* what the claim protects:
 *   two workers claiming two jobs for two different pages would each be a legal claim and would
 *   still run `git` in one directory at the same time. `git` takes its own `index.lock`, but the
 *   failure that produces is an operational mystery — a `fatal: Unable to create … index.lock`
 *   in a job's `lastError` — rather than a clean refusal. So the whole run is wrapped in
 *   {@link withMirrorLock}, a **session-level** Postgres advisory lock keyed on the working tree.
 *
 * ### Why the tree lock needs its own client, stated because it looks like an extravagance
 *
 * A session advisory lock belongs to a *connection*, and Prisma hands out a pooled connection per
 * statement — it pins one only inside an interactive transaction, which is exactly what rule one
 * above forbids holding across a push. So the lock lives on its own {@link PrismaClient} with
 * `connection_limit=1`, which makes every statement on it the same backend. Measured before it
 * was written: two statements on such a client report the same `pg_backend_pid()`, the lock is
 * visible in `pg_locks` after an unrelated statement, and a second client's
 * `pg_try_advisory_lock` on the same key answers `false`.
 *
 * The consequence is the good half: a **session** lock is released by Postgres when the session
 * ends, and the session ends when the process does. A worker killed mid-job cannot leave the tree
 * locked — there is no lease to expire and no stale lock file to clear by hand. That is why the
 * lease below is about the *row* and not about the tree.
 *
 * ## Order per page, and what the sequence does not give
 *
 * Task 3 measured it: sequence values are issued at INSERT and not at COMMIT, so a transaction
 * holding id 62009 can commit *after* a faster 62010, and a worker taking the lowest ready id
 * would then drain the later job first — out of enqueue order, with no error anywhere. For one
 * page the enqueues are nearly exclusive (publish takes the `PageDraft` row lock; create and move
 * take the space advisory lock) but a publish and a move of the same page take **different**
 * locks and can interleave exactly that way.
 *
 * The claim therefore carries a barrier: **a job is not claimable while any earlier job for the
 * same page is unfinished.** That is the `NOT EXISTS` in {@link claimNextJob}, and it is what
 * `@@index([pageId, id])` exists for. Two jobs enqueued out of commit order are still applied in
 * id order, because the later one is refused until the earlier one is `DONE`.
 *
 * ## A `FAILED` job blocks its page, deliberately
 *
 * "Unfinished" above is `state <> 'DONE'`, so `FAILED` blocks too. The alternative — step over a
 * failed job and keep draining that page — produces the worst outcome this phase can reach: job 3
 * applied without job 2, a tree that disagrees with Postgres, and **nothing that notices**, which
 * is the precise property §10 exists to provide. A `MOVE` that failed followed by a `PUBLISH` that
 * succeeded leaves an orphan file at the old path and a fresh file at the new one, and every job
 * involved reports success.
 *
 * The cost is real and is Task 8's whole purpose: one bad job stalls that page's mirror until a
 * super admin intervenes. It stalls **only that page** — the barrier is keyed on `pageId`, so
 * every other page keeps draining, and the test for this asserts both halves, because "blocks the
 * page" and "wedged the worker" are indistinguishable from a single-page fixture.
 *
 * ## Commit, push, then record — and this is where the plan and the exit criteria disagreed
 *
 * The brief for this task says "record the sha as soon as the commit exists, so a failed push is
 * retried as a push and never as a second commit". The phase's exit criteria say that a publish
 * with the remote unreachable leaves **`gitSha` null** while the job retries, and Task 7 renders
 * `null` as "not mirrored yet". Both cannot hold if the sha is written between the commit and the
 * push.
 *
 * The exit criterion wins, and the plan's sentence turns out to be unnecessary rather than wrong:
 * **nothing needs to be recorded to make the retry idempotent**, because Task 5 already built
 * that. A retried job rewrites byte-identical content (`mirrorDocumentOf` is deterministic and the
 * job captures its `versionId`), so `git add` stages nothing, `git diff --cached --quiet` exits 0,
 * and `commit()` returns `committed: false` with **`sha` = HEAD** — its docstring says in as many
 * words that this exists so "a worker that crashed after committing gets the right sha on retry
 * without knowing it crashed". One publish, one commit, whatever happens to the push.
 *
 * Recording early would also defeat the property it was meant to protect: a sha painted on a page
 * for a commit that exists on one server's disk and on no remote is a mirror that is broken and
 * *not noticed*, which is the failure §10 is about. So the sha is written after the push reports
 * success — including the no-remote case (§19), where a local repository **is** the mirror and
 * `push()` legitimately reports `pushed: false` with no error.
 *
 * ## What a `MOVE` with no source in the tree means
 *
 * `stageMove` answers `moved: false` when the old path is not tracked, and this worker treats that
 * as a **success that did nothing**, not as a failure and not as a repair.
 *
 * It is reachable, and by the ordinary route rather than an exotic one: every version published
 * before this phase existed has no mirrored file (the plan's "backfilling history" non-goal says
 * so outright), so the first move of any such page is a `git mv` of a path the tree has never
 * held. Failing it would fill Task 8's page with jobs no intervention can clear — a `MOVE` job
 * carries `versionId: null` by design, so there are no bytes to write and nothing an operator
 * could do but delete the row.
 *
 * Repairing it — writing the file at the new path — was the tempting answer and is refused for a
 * concrete reason rather than on taste: the bytes would have to come from a `PageVersion` joined
 * at drain time, and Task 4 states the rule that forbids exactly that ("capture the mutable, join
 * the immutable"), naming this repair as the case that would need a **new captured column**, not a
 * join. A join here would mirror whatever the page's *current* published version is, which for a
 * page republished since the move is not the version this job is about.
 *
 * What makes the no-op safe is that it converges: the address is captured per job, so the page's
 * next `PUBLISH` writes its file at the path it holds by then, and the tree catches up without
 * anybody doing anything. The outcome is reported as {@link JobDetail} `move-source-absent` so a
 * drain that did nothing is distinguishable from a drain that moved a file — this project's most
 * repeated test failure is an assertion that cannot tell those apart.
 *
 * ## `MOVE`, `DELETE` and `RESTORE` are committed by the service, not by the last publisher
 *
 * Only `PUBLISH` has an author: its `versionId` names the row whose `authorId` is the person who
 * published those bytes. A `GitJob` captures no actor for the other three — `AuditLog` is what
 * records who moved or deleted a page — so attributing a move to whoever last published the page
 * would be a false statement about a named person in a permanent record. Task 5 measured why that
 * matters more than it looks: **the author email is the field a git host matches to an account.**
 * So those three commit as `config.authorFallback`, and capturing the actor would be a column on
 * `GitJob`, which is Task 4's file and not this one's.
 *
 * ## The lease, and what it means if the worker it reclaims is alive
 *
 * A worker killed between claiming a job and finishing it leaves the row `RUNNING` for ever;
 * nothing in the schema recovers it, and because a `FAILED`-or-`RUNNING` job blocks its page, that
 * one row would freeze that page's mirror permanently.
 *
 * {@link reclaimAbandonedJobs} runs at the start of every drain, under the tree lock, and returns
 * `RUNNING` rows whose `updatedAt` is older than the configured lease to `PENDING`. `updatedAt` is
 * the lease clock rather than a new column because the schema already defines it as "when it was
 * last attempted" — the claim sets it, and the claim is the only thing that puts a row into
 * `RUNNING`. A second column would be a second answer to the same question.
 *
 * Three things make this safe, and the third is the one to keep:
 *
 * - **The reclaim runs only while this worker holds the tree lock**, and no worker claims anything
 *   without holding it. So a `RUNNING` row seen from inside the lock belongs to a worker that no
 *   longer holds it — which, for a session lock, means a process that no longer exists. The lease
 *   is therefore belt-and-braces rather than the primary evidence, and it is set well past any
 *   honest job (ten minutes against a worst case of a few local operations at ten seconds and one
 *   push at sixty) so that the remaining case — a live worker whose lock *session* dropped under
 *   it — stays outside it.
 * - **If that case happens anyway, the job runs twice and the tree is unharmed.** Both runs write
 *   the same bytes; the second finds a clean index and commits nothing. The visible cost is a
 *   duplicate push, which git answers `Everything up-to-date`.
 * - **The late finish writes nothing**, because {@link finishJob}'s predicate is
 *   `state = 'RUNNING' AND attempts = <the value this claim returned>`. `attempts` is the fencing
 *   token: a reclaim-then-reclaim bumps it, so the abandoned worker's `UPDATE` matches zero rows
 *   and reports {@link JobDetail} `lease-lost` instead of overwriting a state it no longer owns.
 *
 * The reclaim also **applies the attempt ceiling**, which closes a loop that would otherwise be
 * open: a job that kills the worker every time never reaches {@link finishJob}, so without this it
 * would be reclaimed and re-run for ever while `attempts` climbed past the ceiling unnoticed. A
 * reclaim of a job that has already used its attempts writes `FAILED`.
 */

// ── Configuration ─────────────────────────────────────────────────────────────────────────────

export type WorkerConfig = {
  /** The seam's configuration — the working tree, the remote, the identities, the timeouts. */
  git: GitConfig;
  /**
   * How many times a job may be attempted before it is `FAILED`. Counted in `GitJob.attempts`,
   * which the claim increments, so the first run of a job has `attempts = 1`.
   */
  maxAttempts: number;
  /** The first retry's delay. Doubles per attempt, up to {@link WorkerConfig.backoffCeilingMs}. */
  backoffBaseMs: number;
  /** The longest a retry is ever pushed out by. */
  backoffCeilingMs: number;
  /** How long a `RUNNING` row may go untouched before it is treated as abandoned. */
  leaseMs: number;
  /** How long to wait for another worker's tree lock before giving up and exiting cleanly. */
  lockWaitMs: number;
  /** A ceiling on one run, so a backlog cannot hold a cron slot indefinitely. */
  maxJobs: number;
};

/** Five attempts spans roughly fifteen minutes of backoff — long enough for a host to come back. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Thirty seconds, doubling: 30s, 1m, 2m, 4m. */
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
export const DEFAULT_BACKOFF_CEILING_MS = 30 * 60_000;
/**
 * Ten minutes. The bound that matters is not "how long a job takes" — the tree lock already means
 * a `RUNNING` row seen from inside the lock has no live owner — but "how long a worker could be
 * alive after losing its lock session". Ten minutes is far past the worst honest job (a few local
 * operations at ten seconds each plus one push at sixty) and far short of a page staying frozen
 * for a working day.
 */
export const DEFAULT_LEASE_MS = 10 * 60_000;
/**
 * Five seconds. A worker that cannot get the tree in five seconds is not in an error state: the
 * previous run is still going, which is the *correct* outcome of running the same cron twice.
 * Waiting longer only piles processes up behind a backlog.
 */
export const DEFAULT_LOCK_WAIT_MS = 5_000;
export const DEFAULT_MAX_JOBS = 500;

/**
 * §17's variables for the worker half, read in exactly one place — the shape `gitConfigFromEnv`
 * and `buildInfo` both use, and for the same reason: a module that reads `process.env` inside its
 * operations is a module a test cannot call twice with two answers.
 */
export function workerConfigFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): WorkerConfig {
  const positiveInt = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    // Same shape as `gitConfigFromEnv`: `Number("")` and `Number(null)` are both 0, and a zero
    // ceiling here would mean "never give up", "no backoff" or "never lock" depending on the
    // field. A garbage value falls back rather than disabling the thing it configures.
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };

  return {
    git: gitConfigFromEnv(env),
    maxAttempts: positiveInt("GIT_WORKER_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    backoffBaseMs: positiveInt("GIT_WORKER_BACKOFF_MS", DEFAULT_BACKOFF_BASE_MS),
    backoffCeilingMs: positiveInt("GIT_WORKER_BACKOFF_CEILING_MS", DEFAULT_BACKOFF_CEILING_MS),
    leaseMs: positiveInt("GIT_WORKER_LEASE_MS", DEFAULT_LEASE_MS),
    lockWaitMs: positiveInt("GIT_WORKER_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS),
    maxJobs: positiveInt("GIT_WORKER_MAX_JOBS", DEFAULT_MAX_JOBS),
  };
}

/**
 * How long to wait before attempt `attempts + 1`, given that `attempts` have already been made.
 *
 * Exponential from the base, capped. Exported because a pure function with a ceiling is worth
 * asserting directly: the interesting values are the first one and the one that stops growing.
 */
export function backoffMs(config: WorkerConfig, attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  // `2 ** 40` is finite but enormous; the `min` is what keeps this a number rather than Infinity
  // for a job whose attempts column was raised by hand.
  const raw = config.backoffBaseMs * 2 ** Math.min(exponent, 30);
  return Math.min(raw, config.backoffCeilingMs);
}

// ── The tree lock ─────────────────────────────────────────────────────────────────────────────

/**
 * The advisory lock key, in **two** parts, and both halves of that are decisions.
 *
 * ## Two arguments, because one would share a key space with the page locks
 *
 * `createPage`, `movePage` and `deletePage` all take `pg_advisory_xact_lock(hashtext(spaceId))` —
 * the **one-argument** form. A one-argument mirror lock would live in the same key space, and
 * `hashtext` over an arbitrary working-tree path colliding with `hashtext` over an arbitrary space
 * id is a 1-in-2^32 accident that would present as a move deadlocking against a mirror drain, with
 * nothing in either statement to suggest why.
 *
 * The two-argument form removes the possibility rather than making it unlikely, and that is
 * measured rather than argued from the documentation: Postgres records the one-argument form with
 * `objsubid = 1` and the two-argument form with `objsubid = 2`, so the two never name the same
 * lock. Taken together in one session, `pg_locks` shows
 * `(classid 4294967295, objid 3251558737, objsubid 1)` for `pg_advisory_lock(hashtext('engineering'))`
 * and `(classid 20260826, objid 3364510785, objsubid 2)` for the mirror's — two rows, not one.
 *
 * What each argument classifies: **`classid` is the *kind* of thing being locked** (this constant,
 * meaning "a git mirror working tree" — it is a namespace, not a hash of anything) and **`objid` is
 * *which* one** (`hashtext` of the resolved working-tree root). Two deployments sharing a database
 * and mirroring into different trees therefore do not block each other, and two workers pointed at
 * the same tree do.
 *
 * ## The casts are load-bearing
 *
 * Postgres offers `pg_advisory_lock(int8)` and `pg_advisory_lock(int4, int4)` and nothing in
 * between. Prisma binds a JS number as `bigint`, so the natural spelling asks for
 * `pg_advisory_lock(bigint, integer)` and fails at runtime with `42883 — function … does not
 * exist`, having type-checked, built and passed every test that does not take the lock. Both
 * arguments are therefore cast in the SQL: `::int4` on the namespace, and `hashtext` already
 * returns `int4`. Written out so the two-argument overload is chosen by this file rather than by
 * whatever Prisma infers next.
 */
export const MIRROR_LOCK_CLASS = 20260826;

/** Postgres' `lock_timeout` cancellation. The one error code that means "someone else has it". */
const LOCK_NOT_AVAILABLE = "55P03";

export type LockOutcome<T> = { held: true; value: T } | { held: false };

/**
 * Run `fn` while holding the working tree's advisory lock, or report that another worker has it.
 *
 * The client is created here and disconnected in a `finally`, and both halves matter. Creating it
 * per run rather than per process means the lock cannot outlive the drain it belongs to;
 * disconnecting ends the session, and a session advisory lock is released with its session, so the
 * unlock below is a courtesy rather than the guarantee. A worker that is killed releases the lock
 * when its socket closes, which is what makes the tree recover on its own.
 */
export async function withMirrorLock<T>(
  config: WorkerConfig,
  fn: () => Promise<T>,
): Promise<LockOutcome<T>> {
  const root = resolve(config.git.root);
  const url = new URL(databaseUrl());
  // One connection, so every statement below is the same backend. A session advisory lock belongs
  // to a connection, and Prisma's pool would otherwise hand the unlock to a session that never
  // took the lock — which fails silently, because `pg_advisory_unlock` returns `false` rather
  // than raising.
  url.searchParams.set("connection_limit", "1");
  const holder = new PrismaClient({ datasourceUrl: url.toString() });

  try {
    // `SET` takes no bind parameters, so this is the one interpolated statement in the module.
    // The value is `Math.floor`ed to a positive integer by `workerConfigFromEnv` and re-checked
    // here, because the *next* caller might build a `WorkerConfig` by hand.
    const waitMs = Number.isFinite(config.lockWaitMs) ? Math.max(1, Math.floor(config.lockWaitMs)) : 1;
    await holder.$executeRawUnsafe(`SET lock_timeout = ${waitMs}`);

    try {
      await holder.$executeRaw`SELECT pg_advisory_lock(${MIRROR_LOCK_CLASS}::int4, hashtext(${root}))`;
    } catch (error) {
      if (String(error).includes(LOCK_NOT_AVAILABLE)) return { held: false };
      throw error;
    }

    try {
      return { held: true, value: await fn() };
    } finally {
      await holder
        .$executeRaw`SELECT pg_advisory_unlock(${MIRROR_LOCK_CLASS}::int4, hashtext(${root}))`
        .catch(() => {
          // The disconnect below releases it regardless. Swallowed rather than surfaced because
          // a failure here cannot leave the lock held and must not mask the drain's own error.
        });
    }
  } finally {
    await holder.$disconnect();
  }
}

/**
 * The connection string for the lock's own client.
 *
 * Read here rather than passed in because it must be the **same database** the rest of the worker
 * is talking to, and that is `db`'s connection, not a configuration choice. `@/lib/db` constructs
 * its client from `DATABASE_URL`; so does this.
 */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is unset, so the git worker cannot take the working tree's advisory lock. " +
        "Without it two workers would run git in one directory.",
    );
  }
  return url;
}

// ── Claiming ──────────────────────────────────────────────────────────────────────────────────

/** A claimed job, as the claim statement returns it. Every column is a capture — see `enqueue.ts`. */
export type ClaimedJob = {
  id: number;
  kind: GitJobKind;
  pageId: string;
  versionId: string | null;
  spaceKey: string;
  path: string;
  fromPath: string | null;
  /** After the increment this claim applied. It is also the fencing token — see {@link finishJob}. */
  attempts: number;
  /**
   * A **later** job for this page has already been applied. See {@link claimNextJob} for the one
   * interleaving that reaches it and why it is a refusal rather than a silent application.
   */
  laterApplied: boolean;
};

/**
 * Return abandoned `RUNNING` rows to the queue, or fail them if they have used their attempts.
 *
 * Called once per drain, **inside** the tree lock. See the module note for why a `RUNNING` row
 * seen from in here has no live owner, and why the lease is a second line rather than the first.
 */
export async function reclaimAbandonedJobs(config: WorkerConfig): Promise<number> {
  const rows = await db.$queryRaw<{ id: number }[]>`
    UPDATE "GitJob"
       SET "state" = CASE
             WHEN "attempts" >= ${config.maxAttempts} THEN 'FAILED'::"GitJobState"
             ELSE 'PENDING'::"GitJobState"
           END,
           "lastError" = ${
             "The worker that claimed this job did not finish it — it was reclaimed after the " +
             "lease expired. If this repeats, the job is killing the worker rather than failing."
           },
           "updatedAt" = now()
     WHERE "state" = 'RUNNING'
       AND "updatedAt" < now() - (${config.leaseMs}::double precision / 1000.0) * interval '1 second'
    RETURNING "id"`;
  return rows.length;
}

/**
 * Take the next job that is due and whose page has no earlier unfinished job, or `null`.
 *
 * One statement, so the read and the transition cannot be separated by anything. Three clauses
 * carry the whole design and each is load-bearing on its own:
 *
 * - **`state = 'PENDING'` inside the locking read** makes this a conditional transition. A
 *   read-then-write pair — `SELECT` the id, then `UPDATE … WHERE id = $1` — passes every
 *   single-worker test and lets two workers claim one row.
 * - **`FOR UPDATE SKIP LOCKED`** is what keeps a second worker moving instead of queueing behind
 *   a row it will be refused anyway. It is honestly a liveness clause rather than a correctness
 *   one: with a plain `FOR UPDATE`, the second worker would block, then re-evaluate
 *   `state = 'PENDING'` against the committed row version and match nothing, which is the same
 *   answer arrived at more slowly.
 * - **`NOT EXISTS (… id < c.id AND state <> 'DONE')`** is the per-page barrier — enqueue order,
 *   and a failed job stopping its own page. See the module note for both.
 *
 * `ORDER BY "nextAttemptAt", "id"` matches `@@index([state, nextAttemptAt, id])` exactly, which
 * Task 3 measured as a bare index scan against the same query ordered by `id` alone planning an
 * extra sort of every ready row.
 *
 * ## What the barrier cannot see, and the column that catches it afterwards
 *
 * **Correcting the brief for this task, which believed `@@index([pageId, id])` closed the whole
 * hazard:** the barrier is a `NOT EXISTS` evaluated in this statement's snapshot, and the
 * inversion Task 3 measured is precisely a row that **is not yet committed**. A publish holding
 * id 62009 open while a move takes 62010 and commits leaves 62009 *invisible* here, so `NOT
 * EXISTS` is trivially true, 62010 is claimed, and 62009 is drained afterwards — out of enqueue
 * order, exactly as before. The barrier closes every case where both rows are visible, which is
 * the common one (a job backing off while a later job for the same page is due now would
 * otherwise be drained first by `ORDER BY "nextAttemptAt"`), and it does not close that one.
 *
 * Closing it properly needs a visibility fence rather than an ordering one — claiming only rows
 * whose inserting transaction is older than `pg_snapshot_xmin(pg_current_snapshot())` — and the
 * cost of that is that **any** long-running transaction anywhere in the database stalls the whole
 * mirror. That is a worse failure than the one it prevents, so it is not done.
 *
 * What is done instead is to make the residual **noticed**, which is §10's actual promise:
 * `laterApplied` reports whether a job with a higher id for the same page has already reached
 * `DONE`. It can only be true through the interleaving above, it means the tree has already moved
 * past this job, and applying it anyway is the silent wrong tree this phase exists to avoid. So
 * the job is failed with a message that says so and lands on Task 8's page. In normal draining it
 * is always false: the barrier means jobs for one page finish in id order, so nothing later can be
 * `DONE` while an earlier one is still claimable.
 */
export async function claimNextJob(config: WorkerConfig): Promise<ClaimedJob | null> {
  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "GitJob" AS j
       SET "state" = 'RUNNING'::"GitJobState",
           "attempts" = j."attempts" + 1,
           "updatedAt" = now()
     WHERE j."id" = (
       SELECT c."id"
         FROM "GitJob" AS c
        WHERE c."state" = 'PENDING'
          AND c."nextAttemptAt" <= now()
          AND NOT EXISTS (
            SELECT 1
              FROM "GitJob" AS e
             WHERE e."pageId" = c."pageId"
               AND e."id" < c."id"
               AND e."state" <> 'DONE'
          )
        ORDER BY c."nextAttemptAt", c."id"
          FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING j."id", j."kind", j."pageId", j."versionId", j."spaceKey", j."path",
              j."fromPath", j."attempts",
              EXISTS (
                SELECT 1
                  FROM "GitJob" AS l
                 WHERE l."pageId" = j."pageId"
                   AND l."id" > j."id"
                   AND l."state" = 'DONE'
              ) AS "laterApplied"`;
  // `config` is unused by the statement and taken anyway, so that the claim's signature does not
  // have to change when a future limit (a per-space worker, say) becomes a predicate here.
  void config;
  return rows[0] ?? null;
}

/**
 * Write a job's terminal state, and the version's sha with it, in one short transaction.
 *
 * **The predicate is the fence.** `state = 'RUNNING' AND attempts = <this claim's value>` means a
 * worker whose job was reclaimed and re-claimed by someone else writes nothing at all — see the
 * module note on the lease. Zero rows matched is not an error; it is `lease-lost`, and the caller
 * reports it.
 *
 * The `PageVersion` write carries **no soft-delete filter and no permission predicate**, both
 * deliberately. There is no viewer: the worker has no session, and the version it names came from
 * a job the mutation that authorised it wrote in its own transaction — the argument
 * `enqueueMirrorJobs` states at length for the same absence. And a page soft-deleted between its
 * publish and this drain still owes the mirror those bytes: the `PUBLISH` job writes the file and
 * the `DELETE` job behind it removes the file, and a soft-delete filter here would break the first
 * half and leave the second removing a file that was never written. This is the same case
 * `restorePage` carries an explicitly `deletedAt`-blind query for.
 *
 * `gitSha IS NULL` in the update's `where` is idempotence, not a permission: it keeps the sha of
 * the commit that **first** mirrored a version, so a `RESTORE` that re-writes the same bytes into
 * a later commit does not rewrite the page's provenance to point at it.
 */
export async function finishJob(args: {
  job: ClaimedJob;
  state: GitJobState;
  /** Milliseconds to push `nextAttemptAt` out by. Zero for a terminal state. */
  retryInMs: number;
  lastError: string | null;
  /** The commit that holds this version's bytes, once the push has reported success. */
  sha: string | null;
}): Promise<"written" | "lease-lost"> {
  const { job } = args;
  return await db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "GitJob"
         SET "state" = ${args.state}::"GitJobState",
             "nextAttemptAt" = now()
                 + (${args.retryInMs}::double precision / 1000.0) * interval '1 second',
             "lastError" = ${args.lastError},
             "updatedAt" = now()
       WHERE "id" = ${job.id}
         AND "state" = 'RUNNING'
         AND "attempts" = ${job.attempts}`;
    if (updated === 0) return "lease-lost";

    if (args.sha !== null && job.versionId !== null && recordsSha(job.kind)) {
      await tx.pageVersion.updateMany({
        where: { id: job.versionId, gitSha: null },
        data: { gitSha: args.sha },
      });
    }
    return "written";
  });
}

/**
 * Whether this kind of job is what puts a sha on a version.
 *
 * `PUBLISH` only. A `RESTORE` writes the same version's bytes into a later commit, and the
 * provenance a reader wants is the commit that first mirrored the version, not the most recent one
 * that happens to contain it — `finishJob`'s `gitSha IS NULL` would make a restore a no-op anyway,
 * and stating it here as well would be the "predicate in two places" mistake. It is here because
 * this is the *meaning*: `MOVE` and `DELETE` carry no version at all, and a restore's commit is
 * about a page's presence rather than about a version's bytes.
 */
function recordsSha(kind: GitJobKind): boolean {
  return kind === "PUBLISH";
}

// ── Applying one job ──────────────────────────────────────────────────────────────────────────

/**
 * What actually happened to the tree, beyond the job's state. Reported so a drain that changed
 * nothing is distinguishable from a drain that changed something — the discrimination this
 * project's tests keep losing when a count is the only observable.
 */
export type JobDetail =
  /** Bytes were written and staged (`PUBLISH`, `RESTORE`). */
  | "written"
  /** A tracked file was renamed. */
  | "moved"
  /** A tracked file was removed. */
  | "removed"
  /** A `MOVE` whose source is not in the tree. A success that did nothing — see the module note. */
  | "move-source-absent"
  /** A `DELETE` whose file is not in the tree. Same shape: the re-run, or a page never mirrored. */
  | "delete-target-absent"
  /** The commit found a clean index: this job had already been applied. */
  | "already-applied"
  /** git refused, or the filesystem did. Retryable unless {@link PERMANENT} says otherwise. */
  | "failed"
  /** The job was reclaimed by another worker while this one was working. Nothing was written. */
  | "lease-lost";

export type JobOutcome = {
  id: number;
  kind: GitJobKind;
  pageId: string;
  /** The state the row was left in. `null` when the fence refused the write. */
  state: GitJobState | null;
  detail: JobDetail;
  /** The commit this job's bytes are in, when there is one and the push succeeded. */
  sha: string | null;
  /** What went in `lastError`. */
  error: string | null;
};

/**
 * The error codes that cannot be fixed by trying again.
 *
 * `path-refused` is the whole set today: `mirrorPathOf` is a pure function of two captured columns,
 * so it will answer the same thing for ever, and the fault is upstream — a `Space.key` with a
 * separator in it, or a `Page.path` that is not canonical. Everything else (`write-failed`,
 * `timed-out`, `git-failed`) can be an operational condition that clears: a full disk, a host that
 * is down, a hook that was misconfigured for an hour.
 *
 * `not-a-repository` is deliberately absent: it is a whole-run condition rather than a job's, it is
 * reported by `ensureRepository` before any job is claimed, and failing every queued job because
 * `GIT_MIRROR_ROOT` was pointed at the wrong directory would turn a one-line configuration fix into
 * a queue that has to be repaired by hand.
 */
const PERMANENT: ReadonlySet<GitErrorCode> = new Set<GitErrorCode>(["path-refused"]);

/**
 * The details that already explain an empty index, so {@link JobDetail} `already-applied` must not
 * replace them. See the note at the end of {@link applyJob}.
 */
const NOTHING_TO_STAGE: ReadonlySet<JobDetail> = new Set<JobDetail>([
  "move-source-absent",
  "delete-target-absent",
]);

/** What one job's git work produced, before the database hears about it. */
type Applied =
  | { ok: true; detail: JobDetail; sha: string | null }
  | { ok: false; detail: "failed"; message: string; permanent: boolean };

/**
 * Stage the job's change, commit it, push it. No database write, and no transaction is open while
 * any of this runs — the module's first rule.
 */
async function applyJob(config: WorkerConfig, job: ClaimedJob): Promise<Applied> {
  if (job.laterApplied) {
    return {
      ok: false,
      detail: "failed",
      message:
        `A later job for this page has already been applied, so job ${job.id} is out of order and ` +
        "applying it would move the mirror backwards — an older document written over a newer " +
        "one, or a file restored to a path the page has left. This is reachable only when the " +
        "transaction that enqueued this job committed after one that enqueued a later job; see " +
        "`claimNextJob`. Nothing was written. The page's mirror is frozen here until someone " +
        "decides what the tree should hold, which is what this failure exists to make visible.",
      permanent: true,
    };
  }

  const git = config.git;
  const ref: MirrorRef = { spaceKey: job.spaceKey, path: job.path };

  let staged: JobDetail;
  let author = git.authorFallback;
  let title: string | undefined;
  let note: string | null | undefined;

  if (job.kind === "PUBLISH" || job.kind === "RESTORE") {
    const version = await loadVersion(job.versionId);
    if (version === null) {
      return {
        ok: false,
        detail: "failed",
        message:
          `This ${job.kind} job names version ${JSON.stringify(job.versionId)}, which no longer ` +
          "exists. A version row is deleted only by a hard delete, which this product does not " +
          "have; there is nothing to mirror and retrying cannot change that.",
        permanent: true,
      };
    }

    const contents = mirrorDocumentOf({ ...version, spaceKey: job.spaceKey, path: job.path });
    const written = await stageWrite(git, ref, contents);
    if (!written.ok) return failure(written.error);

    staged = "written";
    title = version.title;
    note = version.message;
    // Only a publish has an author — see the module note on why a move is not attributed to the
    // last publisher, and why a restore is not attributed to the version's author either.
    if (job.kind === "PUBLISH") author = version.author;
  } else if (job.kind === "MOVE") {
    if (job.fromPath === null) {
      return {
        ok: false,
        detail: "failed",
        message:
          "This MOVE job has no `fromPath`, so there is no file to rename. `enqueueMirrorJobs` " +
          "captures it in the transaction that rewrites `Page.path`, and it is unreconstructible " +
          "afterwards — this row was written by something other than that function.",
        permanent: true,
      };
    }
    const moved = await stageMove(git, { spaceKey: job.spaceKey, path: job.fromPath }, ref);
    if (!moved.ok) return failure(moved.error);
    staged = moved.moved ? "moved" : "move-source-absent";
  } else {
    const removed = await stageDelete(git, ref);
    if (!removed.ok) return failure(removed.error);
    staged = removed.removed ? "removed" : "delete-target-absent";
  }

  const message = mirrorCommitMessage({
    kind: job.kind,
    ref,
    previous: job.fromPath === null ? undefined : { spaceKey: job.spaceKey, path: job.fromPath },
    title,
    versionId: job.versionId ?? undefined,
    note,
  });

  const committed = await commit(git, { message, author });
  if (!committed.ok) return failure(committed.error);

  // The push is the second failure and the only one that may be retried by repeating it. Nothing
  // has been written to the database yet, so a failure here leaves the commit on disk and the
  // version unmirrored — which is the exit criterion, and which the retry resolves by finding a
  // clean index and pushing the same commit again.
  const pushed = await push(git);
  if (!pushed.ok) return failure(pushed.error);

  return {
    ok: true,
    // `committed: false` after a successful stage means the tree already held these bytes: the
    // re-run of a job whose commit survived a crash, or a repeated MOVE/DELETE/RESTORE. Reported
    // as its own detail so "the drain applied something" stays a separate observation from "the
    // drain finished".
    //
    // **Unless the seam already said why nothing was staged.** A `MOVE` with no source and a
    // `DELETE` with no target also reach a clean index, and `already-applied` would erase the
    // more specific answer — turning "there was nothing at the old path" into "this had already
    // been done", which are different facts about the tree and want different answers from an
    // operator. Found by the test for the absent move source, which is exactly the
    // discrimination this project keeps losing.
    detail: committed.committed || NOTHING_TO_STAGE.has(staged) ? staged : "already-applied",
    sha: committed.sha,
  };
}

function failure(error: GitError): Applied {
  return {
    ok: false,
    detail: "failed",
    message: error.message,
    permanent: PERMANENT.has(error.code),
  };
}

/**
 * The version a `PUBLISH` or `RESTORE` job writes, in the shape `mirrorDocumentOf` takes.
 *
 * Explicit `select:`, never `include:`. `spaceKey` and `path` are **not** read here — they are
 * captured on the job, and joining them would give an address assembled from two instants, which
 * is the mistake `enqueue.ts` states the capture rule to prevent.
 *
 * `page.docType` is the one join, and Task 4 named it as the one to watch: `document.ts` needs it,
 * `PageVersion` does not carry it, and it is safe only while nothing updates it. It is also the
 * only place this module reaches a `Page` row, and it does so with **no soft-delete filter** — a
 * page deleted after publishing still owes the mirror the publish that preceded the deletion. See
 * `finishJob` for the same argument on the write side.
 */
async function loadVersion(
  versionId: string | null,
): Promise<Omit<MirroredVersion, "spaceKey" | "path"> & { message: string | null } | null> {
  if (versionId === null) return null;
  const row = await db.pageVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      title: true,
      markdown: true,
      frontmatter: true,
      status: true,
      message: true,
      createdAt: true,
      author: { select: { name: true, email: true } },
      page: { select: { docType: true } },
    },
  });
  if (row === null) return null;

  return {
    versionId: row.id,
    title: row.title,
    markdown: row.markdown,
    // `Json` widens to Prisma's `JsonValue`, which is structurally `FrontmatterValue` for
    // everything `validateFrontmatter` can store. The cast is at the boundary, once.
    frontmatter: row.frontmatter as FrontmatterValue,
    status: row.status,
    publishedAt: row.createdAt,
    author: { name: row.author.name ?? "", email: row.author.email },
    docType: row.page.docType,
    message: row.message,
  };
}

// ── The drain ─────────────────────────────────────────────────────────────────────────────────

export type DrainReport = {
  /**
   * `drained` — the queue was worked until it had nothing claimable left, or the run hit
   * {@link WorkerConfig.maxJobs}. `busy` — another worker holds the working tree, which is not an
   * error. `fatal` — the run could not start: the repository could not be made, or the database
   * could not be reached.
   */
  outcome: "drained" | "busy" | "fatal";
  reclaimed: number;
  done: number;
  failed: number;
  /** Jobs left `PENDING` with `nextAttemptAt` pushed out. */
  retrying: number;
  jobs: JobOutcome[];
  fatal: string | null;
};

const EMPTY: Omit<DrainReport, "outcome" | "fatal"> = {
  reclaimed: 0,
  done: 0,
  failed: 0,
  retrying: 0,
  jobs: [],
};

/**
 * Claim and apply jobs until there are none claimable, then return.
 *
 * The whole run holds the working tree's advisory lock; the reclaim and every claim happen inside
 * it. A run that cannot get the lock reports `busy` and is a **success** — the tree is being
 * worked by somebody, which is exactly what the lock is for, and an operator whose cron overlaps
 * its own previous run should not get mail about it.
 */
export async function drainMirrorJobs(config: WorkerConfig): Promise<DrainReport> {
  let held: LockOutcome<DrainReport>;
  try {
    held = await withMirrorLock(config, () => drainUnderLock(config));
  } catch (error) {
    return { outcome: "fatal", ...EMPTY, fatal: String(error) };
  }
  if (!held.held) return { outcome: "busy", ...EMPTY, fatal: null };
  return held.value;
}

async function drainUnderLock(config: WorkerConfig): Promise<DrainReport> {
  const report: DrainReport = { outcome: "drained", ...EMPTY, jobs: [], fatal: null };

  // Before anything is claimed: §17 says the working tree is not durable state and is re-cloned
  // on start, so "there is no tree" is the normal first run rather than an error. A failure here
  // is the whole run's — see `PERMANENT` for why it is not each job's.
  const ensured = await ensureRepository(config.git);
  if (!ensured.ok) {
    return { ...report, outcome: "fatal", fatal: ensured.error.message };
  }

  report.reclaimed = await reclaimAbandonedJobs(config);

  while (report.jobs.length < config.maxJobs) {
    const job = await claimNextJob(config);
    if (job === null) break;

    const applied = await applyJob(config, job);

    const state: GitJobState = applied.ok
      ? "DONE"
      : applied.permanent || job.attempts >= config.maxAttempts
        ? "FAILED"
        : "PENDING";
    const retryInMs = state === "PENDING" ? backoffMs(config, job.attempts) : 0;
    const error = applied.ok ? null : applied.message;

    const finished = await finishJob({
      job,
      state,
      retryInMs,
      lastError: error,
      sha: applied.ok ? applied.sha : null,
    });

    if (finished === "lease-lost") {
      report.jobs.push({
        id: job.id,
        kind: job.kind,
        pageId: job.pageId,
        state: null,
        detail: "lease-lost",
        sha: null,
        error,
      });
      continue;
    }

    report.jobs.push({
      id: job.id,
      kind: job.kind,
      pageId: job.pageId,
      state,
      detail: applied.ok ? applied.detail : "failed",
      sha: applied.ok ? applied.sha : null,
      error,
    });
    if (state === "DONE") report.done += 1;
    else if (state === "FAILED") report.failed += 1;
    else report.retrying += 1;
  }

  return report;
}
