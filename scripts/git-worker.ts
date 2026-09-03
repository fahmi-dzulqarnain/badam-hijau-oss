#!/usr/bin/env tsx
/**
 * `npm run git:worker` — claim the queued mirror jobs, apply them, exit.
 *
 * Phase 5's decision was a **standalone worker on a schedule** rather than an in-process drain:
 * git subprocesses and a working tree stay out of the web container's request path, backoff state
 * lives in the row rather than in a running process, and a wedged worker cannot wedge the app. So
 * this is the whole product surface of the mirror's execution — a cron entry, and the exit code it
 * reads.
 *
 * ## The exit code is the contract
 *
 * | Code | Meaning | What an operator does |
 * |---|---|---|
 * | **0** | Nothing to do, everything drained, **or another worker holds the tree** | nothing |
 * | **1** | At least one job reached `FAILED` | read the failure list (Task 8's page) |
 * | **2** | The run could not start | fix the configuration or the database |
 *
 * The three are separated because they need different people. A `1` names a page whose mirror is
 * stuck and whose queue is now blocked behind it — the barrier is per page, so the rest of the
 * mirror is still moving. A `2` means no job was even attempted: `GIT_MIRROR_ROOT` points
 * somewhere that is not a repository and cannot be made one, or `DATABASE_URL` is wrong. Collapsing
 * them into one non-zero code would mean a cron whose mail cannot distinguish "one page is stuck"
 * from "the mirror has not run since Tuesday".
 *
 * **`busy` is a zero and that is deliberate.** Running this on a schedule shorter than a slow drain
 * is the normal way to operate it, and the second run finding the tree held is the advisory lock
 * doing its job, not a fault. A non-zero there would mail an operator every minute during a
 * backlog, which is how a monitored exit code stops being read.
 *
 * A job that failed **and will be retried** is also a zero: `nextAttemptAt` has moved out, the next
 * run picks it up, and §10's promise is precisely that a git host being down is not an incident.
 * It is printed, so `-v` in a cron mail still shows it, and it becomes a `1` only when it has used
 * its attempts.
 *
 * ## Output
 *
 * One line per job and a summary, on stdout; the fatal reason on stderr. Nothing here is parsed by
 * anything — Task 8's page reads the rows, not this — so the format is for a human reading cron
 * mail.
 */
import {
  drainMirrorJobs,
  workerConfigFromEnv,
  type DrainReport,
} from "../src/lib/git/worker";
import { db } from "../src/lib/db";

/** Exit codes, named so the table above and the code cannot drift apart. */
const EXIT_OK = 0;
const EXIT_JOB_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

function report(result: DrainReport): number {
  if (result.outcome === "fatal") {
    console.error(`git:worker — could not run: ${result.fatal}`);
    return EXIT_CANNOT_RUN;
  }

  if (result.outcome === "busy") {
    console.log(
      "git:worker — another worker holds the mirror's working tree; nothing to do. " +
        "This is the advisory lock working, not a failure.",
    );
    return EXIT_OK;
  }

  if (result.reclaimed > 0) {
    console.log(
      `git:worker — reclaimed ${result.reclaimed} job(s) left RUNNING by a worker that did not ` +
        "finish them.",
    );
  }

  for (const job of result.jobs) {
    const state = job.state ?? "unclaimed";
    const sha = job.sha === null ? "" : ` ${job.sha.slice(0, 12)}`;
    console.log(`  #${job.id} ${job.kind} ${state} ${job.detail}${sha}`);
    if (job.error !== null) console.log(`      ${job.error}`);
  }

  console.log(
    `git:worker — ${result.done} done, ${result.retrying} retrying, ${result.failed} failed.`,
  );
  return result.failed > 0 ? EXIT_JOB_FAILED : EXIT_OK;
}

async function main(): Promise<void> {
  let code = EXIT_CANNOT_RUN;
  try {
    code = report(await drainMirrorJobs(workerConfigFromEnv()));
  } catch (error) {
    // `drainMirrorJobs` turns a failure to take the lock or reach the database into a `fatal`
    // report; anything reaching here is a bug in it, and it is still an operator's "the worker
    // cannot run" rather than a page's failure.
    console.error(`git:worker — unhandled failure: ${String(error)}`);
  } finally {
    await db.$disconnect();
  }
  // Set rather than thrown: `process.exitCode` lets the disconnect above and any pending stdout
  // flush finish, where `process.exit()` truncates both. A cron reading a truncated log to decide
  // whether the mirror is healthy is the failure this avoids.
  process.exitCode = code;
}

// `void main()` rather than a top-level `await`: tsx compiles a `.ts` under this project's module
// settings to CJS, where a top-level await is a transform error rather than a runtime one — so the
// script would fail to start at all. `main` catches its own failures and sets `process.exitCode`.
void main();
