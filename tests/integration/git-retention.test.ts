import { afterEach, beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  GIT_JOB_RETENTION_DEFAULT_DAYS,
  finishedJobsReport,
  retentionDaysFromEnv,
  sweepFinishedJobs,
} from "@/lib/git/retention";
import type { GitJobKind, GitJobState } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Phase 7 Task 7's retention pass — **the second of the three debts Phase 5 named and deferred to
 * this phase**, against the real database.
 *
 * Integration and not unit, because every question here is a question about rows: which states are
 * in scope, whether a row inside the window survives, whether the audit row is committed with the
 * delete, and whether a `PageVersion`'s sha outlives the job that produced it. A stubbed client can
 * be made to agree with any of those.
 *
 * The one pure half — the window's own parsing — is at the bottom, run against literal environments
 * rather than against `process.env`. That is not only tidiness: importing anything that touches
 * Prisma loads `.env` into `process.env`, so a test that *cleared* the variable would get the
 * file's value back, which is the trap `ALLOW_TEST_LOGIN` was caught by in Phase 1.
 *
 * ## What this file is protecting, beyond the behaviour
 *
 * Phase 5 Task 3 kept `DONE` rows deliberately: *"deleting them makes success unobservable — 'the
 * job drained' and 'no job was ever enqueued' become the same observation."* A sweep is exactly the
 * change that can undo that argument silently, so three tests here are about the argument rather
 * than about the feature: a recently finished job survives, a `FAILED` job survives at any age, and
 * a swept `PUBLISH` leaves its version's `gitSha` behind.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window every test in this file runs under, set as the environment because the module reads
 * the environment. Two days, so "yesterday" is inside it and "a week ago" is not — a one-day
 * window would make the two cases a few hours apart and the fixtures unreadable. */
const WINDOW_DAYS = 2;

let previousWindow: string | undefined;

beforeEach(() => {
  previousWindow = process.env.GIT_JOB_RETENTION_DAYS;
  process.env.GIT_JOB_RETENTION_DAYS = String(WINDOW_DAYS);
});

afterEach(() => {
  if (previousWindow === undefined) delete process.env.GIT_JOB_RETENTION_DAYS;
  else process.env.GIT_JOB_RETENTION_DAYS = previousWindow;
});

/**
 * One space, one page, and jobs written directly.
 *
 * `git-failures.test.ts`'s reason, unchanged: driving the worker to produce a `DONE` row takes a
 * real repository and a real push per fixture, `tests/integration/git-worker.test.ts` already owns
 * that path, and what this file is about is a predicate over the rows it leaves.
 */
async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Root", isSuperAdmin: true },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "EDITOR" },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      docType: "DOC",
      status: "CURRENT",
      createdById: author.id,
    },
    select: { id: true, path: true },
  });

  /** A job whose `updatedAt` — the schema's "when it was last attempted" — is `daysAgo` old. */
  const job = async (opts: {
    state?: GitJobState;
    kind?: GitJobKind;
    daysAgo: number;
    pageId?: string;
    versionId?: string;
  }) => {
    const at = new Date(Date.now() - opts.daysAgo * DAY_MS);
    return await db.gitJob.create({
      data: {
        pageId: opts.pageId ?? page.id,
        versionId: opts.versionId ?? null,
        kind: opts.kind ?? "PUBLISH",
        state: opts.state ?? "DONE",
        spaceKey: "engineering",
        path: page.path,
        attempts: 1,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true, state: true },
    });
  };

  const member: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "ADMIN" }],
  };
  const admin: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };

  return { author, root, space, page, job, member, admin };
}

/** Unwraps, so a failed permission check reads as a named failure rather than a type error. */
async function report(viewer: Viewer) {
  const result = await finishedJobsReport(viewer);
  if (!result.ok) throw new Error(`finishedJobsReport refused: ${result.reason}`);
  return result.report;
}

async function sweep(viewer: Viewer) {
  const result = await sweepFinishedJobs(viewer);
  if (!result.ok) throw new Error(`sweepFinishedJobs refused: ${result.reason}`);
  return result;
}

const states = async () =>
  (
    await db.gitJob.findMany({ orderBy: { id: "asc" }, select: { state: true } })
  ).map((row) => row.state);

/* -------------------------------------------------------------------------- */
/* The count, before anything is pressed                                      */
/* -------------------------------------------------------------------------- */

test("the report counts what the sweep would take, and what it is keeping", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 30 });
  await f.job({ daysAgo: 10 });
  await f.job({ daysAgo: 0 });
  // Neither of these is finished, so neither is in either number.
  await f.job({ state: "PENDING", daysAgo: 30 });
  await f.job({ state: "FAILED", daysAgo: 30 });

  const shown = await report(f.admin);

  expect(shown.retentionDays).toBe(WINDOW_DAYS);
  // Two are older than the window; the third finished moments ago and is deliberately kept.
  expect(shown.sweepable).toBe(2);
  // `finished` is every DONE row, which is how an operator sees that the window is keeping one
  // rather than that there was nothing to keep.
  expect(shown.finished).toBe(3);
  expect(shown.oldestFinishedAt).not.toBeNull();
  // Asserted against the clock rather than against another copy of itself — the trap
  // `deletePage`'s timezone bug was found by. Thirty days ago, to the hour.
  const age = Date.now() - (shown.oldestFinishedAt?.getTime() ?? 0);
  expect(age / DAY_MS).toBeGreaterThan(29.9);
  expect(age / DAY_MS).toBeLessThan(30.1);
});

test("an empty queue reports zeroes and no oldest, rather than throwing", async () => {
  const f = await fixture();
  expect(await report(f.admin)).toEqual({
    retentionDays: WINDOW_DAYS,
    sweepable: 0,
    finished: 0,
    oldestFinishedAt: null,
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep, and the three things Phase 5's argument needs it not to do      */
/* -------------------------------------------------------------------------- */

test("the sweep deletes finished jobs past the window and reports what it did", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 30 });
  await f.job({ daysAgo: 10 });
  const kept = await f.job({ daysAgo: 0 });

  const result = await sweep(f.admin);

  expect(result.deleted).toBe(2);
  // Read after the delete, inside the same transaction: what is left, not what was predicted.
  expect(result.remaining).toBe(1);
  expect(result.retentionDays).toBe(WINDOW_DAYS);
  const left = await db.gitJob.findMany({ select: { id: true } });
  expect(left.map((row) => row.id)).toEqual([kept.id]);
});

/**
 * **The observability floor, which is the whole of Phase 5 Task 3's argument.**
 *
 * A job that drained a minute ago is what every drain assertion in `git-worker.test.ts`,
 * `e2e/mirror-tree.spec.ts` and `scripts/smoke.sh` reads. If a sweep could reach it, "the job
 * drained" and "no job was ever enqueued" would be the same observation again — the state Phase 5
 * refused to ship, arriving through the feature that pays its debt.
 *
 * The non-vacuity half is in the same assertion: an older row in the same call is deleted, so the
 * survival below is a window and not a sweep that did nothing.
 */
test("a job that finished inside the window survives, and an older one in the same sweep does not", async () => {
  const f = await fixture();
  const recent = await f.job({ daysAgo: 0 });
  await f.job({ daysAgo: 30 });

  const result = await sweep(f.admin);

  expect(result.deleted).toBe(1);
  const left = await db.gitJob.findMany({ select: { id: true } });
  expect(left.map((row) => row.id)).toEqual([recent.id]);
});

/**
 * **A `FAILED` job is never swept, at any age**, and this is the mutation `state: "DONE"` exists
 * for.
 *
 * Task 6's barrier is `state <> 'DONE'`: a job is unclaimable while an earlier job for its page is
 * unfinished. So deleting a `FAILED` row does not tidy anything — it *unblocks* the page, and every
 * change queued behind the failure then applies over a change that never happened. That is the
 * silently wrong tree §10 exists to prevent, arriving as housekeeping.
 *
 * Written with a `PENDING` and a `RUNNING` row beside it, all far outside the window, so the
 * assertion is about the predicate being an equality on `DONE` rather than about `FAILED` having
 * been special-cased. A mutant spelling it `state: { not: "PENDING" }` — the shape somebody
 * reaches for — deletes two of these three.
 */
test("a FAILED, PENDING or RUNNING job is never swept, however old", async () => {
  const f = await fixture();
  await f.job({ state: "FAILED", daysAgo: 400 });
  await f.job({ state: "PENDING", daysAgo: 400 });
  await f.job({ state: "RUNNING", daysAgo: 400 });
  await f.job({ state: "DONE", daysAgo: 400 });

  const result = await sweep(f.admin);

  expect(result.deleted).toBe(1);
  expect(await states()).toEqual(["FAILED", "PENDING", "RUNNING"]);
});

/**
 * **What a swept publish leaves behind**, which is the other half of "success stays observable".
 *
 * `PageVersion.gitSha` is the durable record that those bytes reached the repository — it is what
 * the reader paints and what `/{space}/-/history` lists — and it is on a different table. A sweep
 * that took it with them would be deleting the answer rather than the receipt.
 */
test("a swept publish leaves its version's sha, which is the record that it was mirrored", async () => {
  const f = await fixture();
  const version = await db.pageVersion.create({
    data: {
      pageId: f.page.id,
      title: "MQTT contracts",
      markdown: "# MQTT contracts",
      searchText: "MQTT contracts",
      status: "CURRENT",
      authorId: f.author.id,
      gitSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
    },
    select: { id: true, gitSha: true },
  });
  await f.job({ daysAgo: 30, versionId: version.id });

  const result = await sweep(f.admin);
  expect(result.deleted).toBe(1);

  const after = await db.pageVersion.findUniqueOrThrow({
    where: { id: version.id },
    select: { gitSha: true },
  });
  expect(after.gitSha).toBe(version.gitSha);
  // And the page it belongs to is untouched — `GitJob.pageId` cascades from `Page`, never the
  // other way, which is a direction worth pinning on the one module that deletes jobs in bulk.
  expect(await db.page.count()).toBe(1);
});

test("sweeping an empty window deletes nothing and says so", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 0 });

  const result = await sweep(f.admin);
  expect(result.deleted).toBe(0);
  expect(result.remaining).toBe(1);
  // Non-vacuity: the same call over an older row deletes it, so zero above is the window and not
  // a statement that never runs.
  await f.job({ daysAgo: 30 });
  expect((await sweep(f.admin)).deleted).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* The audit row, which is the only thing that survives the rows              */
/* -------------------------------------------------------------------------- */

test("a sweep writes one spaceless mirror.sweep row carrying the window and the count", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 30 });
  await f.job({ daysAgo: 30 });
  await f.job({ daysAgo: 0 });

  await sweep(f.admin);

  const rows = await db.auditLog.findMany({
    where: { action: "mirror.sweep" },
    select: { actorId: true, spaceId: true, pageId: true, detail: true },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.root.id, spaceId: null, pageId: null });
  expect(rows[0]?.detail).toMatchObject({
    retentionDays: WINDOW_DAYS,
    deleted: 2,
    remaining: 1,
  });
  // The cutoff is on the row because "2 rows were deleted" is unreadable a year later without the
  // rule that chose them, and it is an ISO string rather than a `Date` because `detail` is JSON.
  const detail = rows[0]?.detail as { cutoff?: unknown };
  expect(typeof detail.cutoff).toBe("string");
  expect(new Date(String(detail.cutoff)).getTime()).toBeLessThan(Date.now());
});

test("a sweep that deletes nothing still writes the row", async () => {
  // An operator pressed the button and something happened — namely nothing. A trail that recorded
  // only the presses that deleted rows would make "was this ever run?" unanswerable, which is the
  // question the row exists for.
  const f = await fixture();
  await sweep(f.admin);
  expect(await db.auditLog.count({ where: { action: "mirror.sweep" } })).toBe(1);
});

test("a refused sweep deletes nothing and writes nothing", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 30 });

  expect(await sweepFinishedJobs(f.member)).toEqual({ ok: false, reason: "not-found" });

  expect(await db.gitJob.count()).toBe(1);
  expect(await db.auditLog.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* The refusal                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The discriminating viewer is an **`ADMIN` of a real space**, not a stranger — a member of nothing
 * is refused by any predicate at all, which is the near-vacuity Phase 4 measured. And it is a
 * discrimination rather than an absence: the super admin reads the same fixture in the same test.
 */
test("a space ADMIN is refused by both entry points, and the super admin is not", async () => {
  const f = await fixture();
  await f.job({ daysAgo: 30 });

  expect(await finishedJobsReport(f.member)).toEqual({ ok: false, reason: "not-found" });
  expect(await sweepFinishedJobs(f.member)).toEqual({ ok: false, reason: "not-found" });

  expect((await report(f.admin)).sweepable).toBe(1);
  expect((await sweep(f.admin)).deleted).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* The window itself, pure                                                    */
/* -------------------------------------------------------------------------- */

test("the window comes from the environment, and a missing one is the default", () => {
  expect(retentionDaysFromEnv({ GIT_JOB_RETENTION_DAYS: "7" })).toBe(7);
  expect(retentionDaysFromEnv({})).toBe(GIT_JOB_RETENTION_DEFAULT_DAYS);
  expect(retentionDaysFromEnv({ GIT_JOB_RETENTION_DAYS: "" })).toBe(
    GIT_JOB_RETENTION_DEFAULT_DAYS,
  );
});

/**
 * **Zero does not mean "delete everything", and that is the floor rather than a rounding rule.**
 *
 * `repo.ts` decided the same thing about its timeout ceiling — *"a zero or garbage override falls
 * back rather than disabling the ceiling, because 'no ceiling' is the wedged worker this exists to
 * prevent"* — and the shape here is identical: "no window" is the vacuum Phase 5 Task 3 refused to
 * ship, one environment variable away.
 */
test("zero, negative and garbage fall back rather than widening the sweep", () => {
  for (const raw of ["0", "-1", "-90", "later", "NaN", "  "]) {
    expect(retentionDaysFromEnv({ GIT_JOB_RETENTION_DAYS: raw }), raw).toBe(
      GIT_JOB_RETENTION_DEFAULT_DAYS,
    );
  }
  // A fraction below the floor falls back; one above it floors to whole days. Asserted as a pair,
  // because either alone passes over an implementation that rounds instead of flooring.
  expect(retentionDaysFromEnv({ GIT_JOB_RETENTION_DAYS: "0.5" })).toBe(
    GIT_JOB_RETENTION_DEFAULT_DAYS,
  );
  expect(retentionDaysFromEnv({ GIT_JOB_RETENTION_DAYS: "1.9" })).toBe(1);
});
