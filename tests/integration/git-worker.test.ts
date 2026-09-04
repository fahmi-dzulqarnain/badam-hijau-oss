import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { removeScratchDirs, scratch } from "../setup/scratch";
import { publishPage } from "@/lib/pages/publish";
import { movePage } from "@/lib/pages/move";
import { deletePage, restorePage } from "@/lib/pages/delete";
import { saveDraft } from "@/lib/drafts/repo";
import { childPath } from "@/lib/pages/slug";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { runGit, type GitConfig } from "@/lib/git/repo";
import {
  MIRROR_LOCK_CLASS,
  backoffMs,
  claimNextJob,
  drainMirrorJobs,
  finishJob,
  reclaimAbandonedJobs,
  workerConfigFromEnv,
  type ClaimedJob,
  type WorkerConfig,
} from "@/lib/git/worker";
import type { Viewer } from "@/lib/authz/types";

/**
 * Phase 5 Task 6 — the worker, against a real Postgres and real `git`.
 *
 * **Every repository here is a temporary directory** handed out by `tests/setup/scratch.ts`, which
 * refuses to return a path inside this checkout. Nothing in this file runs `git` against the
 * project — see that module for why the obvious mistake is plausible rather than exotic.
 *
 * What this file is for, stated once so the individual tests do not have to repeat it: the worker
 * has four properties nothing else can check, and each is invisible to a test that only counts
 * rows or asserts "the job is DONE".
 *
 * 1. **Two workers take one job once, and hold the tree one at a time.** The tree half is the one
 *    that *blocks*, and it is staged with a competing lock held open.
 * 2. **Jobs for one page apply in enqueue order**, asserted through an outcome that differs
 *    between the two orders — a mirrored file whose body says which job ran last.
 * 3. **A commit and a push are two failures**, and only the push may be retried by repeating it.
 * 4. **A publish stands whatever git does.** §10's central claim, and an exit criterion.
 *
 * Control characters are escapes throughout. A literal NUL in the sibling `repo.test.ts` made `rg`
 * skip that whole file until this task found it.
 */

beforeEach(resetDb);
afterEach(removeScratchDirs);

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/**
 * A worker config over a fresh temporary tree.
 *
 * Timeouts are short so a bug is a failure rather than a hang, and the backoff is milliseconds so
 * a retry test does not sleep for thirty seconds. `maxJobs` is left at the default: a run that
 * drains more than that is a bug in a test's fixture, not a case worth exercising here.
 */
async function workerConfig(overrides: Partial<WorkerConfig> = {}): Promise<WorkerConfig> {
  const base = workerConfigFromEnv({});
  return {
    ...base,
    git: {
      ...base.git,
      root: await scratch("worker"),
      remoteUrl: null,
      committer: { name: "Badam Service", email: "service@badam.test" },
      authorFallback: { name: "Badam Fallback", email: "fallback@badam.test" },
      localTimeoutMs: 15_000,
      networkTimeoutMs: 15_000,
      ...(overrides.git ?? {}),
    },
    backoffBaseMs: 50,
    backoffCeilingMs: 200,
    lockWaitMs: 500,
    ...overrides,
  };
}

/** A bare repository to push at. A local path is a real remote to git, and involves no network. */
async function bareRemote(): Promise<string> {
  const dir = await scratch("remote");
  const path = join(dir, "content.git");
  const cfg = { ...(await workerConfig()).git, root: dir };
  const run = await runGit(cfg, ["init", "--bare", "--initial-branch", "main", "--", path], {
    cwd: dir,
  });
  expect(run.ok).toBe(true);
  return path;
}

/**
 * One space, one editor, one page with a draft ready to publish.
 *
 * Every field takes a value nothing else shares — a fixture whose `slug`, `path` and `title` all
 * default to the same string cannot catch a field mix-up.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "ADMIN" },
  });

  const viewer: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    // ADMIN, because one fixture has to satisfy PUBLISH, EDIT and MANAGE_SPACE.
    memberships: [{ spaceId: space.id, role: "ADMIN" }],
  };

  const page = async (
    parent: { id: string; path: string } | null,
    slug: string,
    title: string,
  ) =>
    await db.page.create({
      data: {
        spaceId: space.id,
        parentId: parent?.id ?? null,
        slug,
        path: childPath(parent?.path ?? null, slug),
        title,
        createdById: aisyah.id,
        status: "DRAFT",
      },
      select: { id: true, path: true },
    });

  return { aisyah, space, viewer, page };
}

/** Write a draft and publish it, returning the published version's id. */
async function publish(
  viewer: Viewer,
  pageId: string,
  body: string,
  title = "Topic registry",
): Promise<string> {
  const draft = await saveDraft(viewer, pageId, { title, markdown: body, seen: null });
  if (!draft.ok) throw new Error(`saveDraft refused: ${draft.reason}`);
  const result = await publishPage(viewer, pageId);
  if (!result.ok) throw new Error(`publishPage refused: ${JSON.stringify(result)}`);
  return result.page.versionId;
}

// ── Reading the tree ──────────────────────────────────────────────────────────────────────────

async function mirrored(config: WorkerConfig, path: string): Promise<string | null> {
  try {
    return await readFile(join(config.git.root, path), "utf8");
  } catch {
    return null;
  }
}

async function exists(config: WorkerConfig, path: string): Promise<boolean> {
  try {
    await stat(join(config.git.root, path));
    return true;
  } catch {
    return false;
  }
}

async function commitCount(config: GitConfig): Promise<number> {
  const run = await runGit(config, ["rev-list", "--count", "HEAD"]);
  if (!run.ok) return 0;
  return Number(run.stdout.trim());
}

async function subjects(config: GitConfig): Promise<string[]> {
  const run = await runGit(config, ["log", "--format=%s"]);
  if (!run.ok) return [];
  return run.stdout.trim().split("\n").filter(Boolean);
}

async function jobs() {
  return await db.gitJob.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      state: true,
      pageId: true,
      attempts: true,
      nextAttemptAt: true,
      lastError: true,
      path: true,
      fromPath: true,
    },
  });
}

/** Stage-and-release helper: the waits stage an interleaving and nothing is asserted about them. */
const settle = () => new Promise((done) => setTimeout(done, 200));

/** This checkout, so the script runs from the project rather than from a temporary tree. */
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

// ── The happy path, so every absence assertion below has something to be absent from ──────────

test("a publish drains to one commit whose file parses back to the version row", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(
    viewer,
    target.id,
    "---\nsystems:\n  - mqtt-broker\n---\n\nThe body.\n",
  );

  const report = await drainMirrorJobs(config);

  expect(report.outcome).toBe("drained");
  expect({ done: report.done, failed: report.failed, retrying: report.retrying }).toEqual({
    done: 1,
    failed: 0,
    retrying: 0,
  });
  expect(report.jobs.map((j) => [j.kind, j.state, j.detail])).toEqual([
    ["PUBLISH", "DONE", "written"],
  ]);

  const file = await mirrored(config, "engineering/topic-registry.md");
  expect(file).not.toBeNull();
  // The round trip Task 1 promises, asserted here against a row that went through a real publish
  // rather than a literal. A "the file contains the title" check cannot fail on an injected key.
  const parsed = splitFrontmatter(file!);
  if (!parsed.ok) throw new Error(`the mirrored file does not parse: ${parsed.error.message}`);
  expect(parsed.frontmatter).toMatchObject({
    title: "Topic registry",
    space: "engineering",
    path: "topic-registry",
    docType: "DOC",
    version: versionId,
    author: { name: "Aisyah R.", email: "aisyah@example.com" },
    declared: { systems: ["mqtt-broker"] },
  });
  expect(parsed.body).toBe("\nThe body.\n");

  expect(await commitCount(config.git)).toBe(1);
  const version = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });
  expect(version.gitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(report.jobs[0]!.sha).toBe(version.gitSha);

  // The publisher is the author; the service is the committer. Task 5 measured that the author
  // email is the field a git host matches to an account, so this is the one that matters.
  const idents = await runGit(config.git, ["log", "-1", "--format=%an|%ae|%cn|%ce"]);
  expect(idents.stdout.trim()).toBe(
    "Aisyah R.|aisyah@example.com|Badam Service|service@badam.test",
  );
});

test("DONE is terminal: a second drain of the same queue claims nothing", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "Body.\n");

  expect((await drainMirrorJobs(config)).done).toBe(1);
  const again = await drainMirrorJobs(config);

  expect(again.jobs).toEqual([]);
  expect(await commitCount(config.git)).toBe(1);
  expect((await jobs()).map((j) => [j.state, j.attempts])).toEqual([["DONE", 1]]);
});

// ── Step 1: claiming ──────────────────────────────────────────────────────────────────────────

/**
 * The claim is a **conditional transition**, and this stages the interleaving that separates it
 * from the shape that merely looks like one.
 *
 * A competing transaction performs the claim's own `UPDATE` and is held open, so the row is locked
 * and — to anyone who can see past the lock — no longer `PENDING`. Then a second claim runs.
 *
 * What each implementation does here, which is the whole point of staging it:
 *
 * - **This implementation** returns `null` immediately. `FOR UPDATE SKIP LOCKED` steps over the
 *   locked row, and there is no other ready job, so there is nothing to claim.
 * - **A read-then-write claim** — `SELECT` the id, then `UPDATE … WHERE id = $1` — reads the
 *   pre-update row under MVCC, decides to claim it, and **blocks** on the row lock. When the held
 *   transaction commits it unblocks, its `WHERE` names only the id, and it claims a job another
 *   worker is already running: `attempts` ends at 2 and two workers hold one job. That mutant is
 *   what the assertions below kill, and it is the one that blocks.
 * - **Dropping `SKIP LOCKED` alone** blocks and then re-evaluates `state = 'PENDING'` against the
 *   committed row version, matching nothing — the same answer, more slowly. An equivalent mutant
 *   for correctness, reported rather than tested for, because the clause is a liveness clause.
 */
test("a second worker cannot claim a job another worker has already claimed", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "Body.\n");
  const [queued] = await jobs();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Resolved from INSIDE the transaction, once the UPDATE has actually run — and awaiting it
  // before the claim is issued is what makes this staging deterministic rather than probable.
  // It replaced a real flake: starting the transaction only *begins* it, so on a loaded machine
  // the claim's `FOR UPDATE SKIP LOCKED` could reach the row before that UPDATE had taken the
  // lock, claim it perfectly legitimately, and fail this assertion with the very job it was
  // staged not to see. Measured once in a full 1321-test run and never in this file alone: the
  // rest of the suite is the load, which is why `npx vitest run` on this path proves nothing.
  let locked!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    locked = resolve;
  });

  // Raw and interactive, because this has to sit between another writer's UPDATE and its COMMIT.
  // The `finally` below is not optional: a leaked uncommitted transaction blocks the next
  // TRUNCATE and buries the real failure under hook timeouts.
  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "GitJob"
           SET "state" = 'RUNNING', "attempts" = "attempts" + 1, "updatedAt" = now()
         WHERE "id" = ${queued!.id}`;
      locked();
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
  await lockHeld;

  // The claim is raced against the settle window rather than simply awaited, and that is not
  // impatience: the read-then-write mutant **blocks**, so a bare `await` makes it a five-second
  // suite timeout — a diagnosis of "something hung" instead of "the claim queued behind a row
  // another worker holds". This project has the same note about a `kill(pid)` mutant that hung a
  // test rather than failing it. The claim is still awaited below, after the release, so the
  // second assertion can say what the mutant actually did.
  const claim = claimNextJob(config).then((job) => ({ returned: true as const, job }));
  try {
    await settle(); // the claim now has a settle window against a lock already held

    const raced = await Promise.race([
      claim,
      settle().then(() => ({ returned: false as const, job: null })),
    ]);
    expect(
      raced,
      "the claim must step over a row another worker holds rather than queue behind it",
    ).toEqual({ returned: true, job: null });
  } finally {
    release();
    await other;
    await claim;
  }

  // One claim happened, not two. Under the read-then-write mutant this is 2, which is two workers
  // holding one job.
  expect((await jobs()).map((j) => [j.state, j.attempts])).toEqual([["RUNNING", 1]]);
});

/**
 * The blocking half, and the one the exit criterion "two workers cannot both hold the working
 * tree" is about.
 *
 * The claim above protects a *row*; it cannot protect the tree, because two workers claiming two
 * jobs for two different pages are both claiming legally and would still run `git` in one
 * directory at once. So the whole run takes a session advisory lock on the working tree, and this
 * test holds that lock from another connection and watches the worker **wait**.
 *
 * Kills: deleting `withMirrorLock` from `drainMirrorJobs`, which makes the drain finish while the
 * lock is held — caught by the mid-flight assertions, which are the only ones that can see the
 * difference between "waited" and "ran anyway".
 */
test("a second worker blocks on the working tree rather than running git in it", async () => {
  const { viewer, page } = await fixture();
  // A long wait, so the worker really queues behind the lock instead of reporting `busy`.
  const config = await workerConfig({ lockWaitMs: 20_000 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "Body.\n");

  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("connection_limit", "1");
  const holder = new PrismaClient({ datasourceUrl: url.toString() });

  let drained: ReturnType<typeof drainMirrorJobs>;
  try {
    await holder.$executeRaw`
      SELECT pg_advisory_lock(${MIRROR_LOCK_CLASS}::int4, hashtext(${config.git.root}))`;

    drained = drainMirrorJobs(config);
    await settle();

    // Mid-flight, with the lock held: nothing has happened. Not "the job is DONE and the file is
    // absent" — nothing at all, because the worker has not reached `ensureRepository` either.
    expect((await jobs()).map((j) => [j.state, j.attempts])).toEqual([["PENDING", 0]]);
    expect(await exists(config, "engineering/topic-registry.md")).toBe(false);
    expect(await exists(config, ".git")).toBe(false);
  } finally {
    await holder
      .$executeRaw`SELECT pg_advisory_unlock(${MIRROR_LOCK_CLASS}::int4, hashtext(${config.git.root}))`
      .catch(() => undefined);
    await holder.$disconnect();
  }

  // Released: the worker was waiting, not refused, so it now does the whole job.
  const report = await drained!;
  expect(report.outcome).toBe("drained");
  expect(report.done).toBe(1);
  expect(await mirrored(config, "engineering/topic-registry.md")).toContain("Body.");
});

test("a worker that cannot get the tree within its wait reports busy, and that is a success", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ lockWaitMs: 200 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "Body.\n");

  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("connection_limit", "1");
  const holder = new PrismaClient({ datasourceUrl: url.toString() });

  try {
    await holder.$executeRaw`
      SELECT pg_advisory_lock(${MIRROR_LOCK_CLASS}::int4, hashtext(${config.git.root}))`;
    const report = await drainMirrorJobs(config);

    // `busy` and not `fatal`: another worker is doing the work, which is the lock working. The
    // script turns this into exit 0 for exactly that reason.
    expect(report.outcome).toBe("busy");
    expect(report.jobs).toEqual([]);
    expect((await jobs()).map((j) => j.state)).toEqual(["PENDING"]);
  } finally {
    await holder
      .$executeRaw`SELECT pg_advisory_unlock(${MIRROR_LOCK_CLASS}::int4, hashtext(${config.git.root}))`
      .catch(() => undefined);
    await holder.$disconnect();
  }
});

test("two workers over one tree apply every job exactly once", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ lockWaitMs: 20_000 });
  for (const slug of ["alpha", "beta", "gamma"]) {
    const target = await page(null, slug, `Page ${slug}`);
    await publish(viewer, target.id, `Body of ${slug}.\n`, `Page ${slug}`);
  }

  const [first, second] = await Promise.all([
    drainMirrorJobs(config),
    drainMirrorJobs(config),
  ]);

  expect(first.done + second.done).toBe(3);
  expect(first.failed + second.failed).toBe(0);
  // Three jobs, three commits, one attempt each: neither worker re-ran another's work.
  expect(await commitCount(config.git)).toBe(3);
  expect((await jobs()).map((j) => [j.state, j.attempts])).toEqual([
    ["DONE", 1],
    ["DONE", 1],
    ["DONE", 1],
  ]);
});

// ── Step 2: order per page ────────────────────────────────────────────────────────────────────

/**
 * **The ordering test, and it cannot pass in the wrong order.**
 *
 * Two publishes of one page: v1 with the body `first`, v2 with the body `second`. The correct
 * drain applies job 1 then job 2 and leaves `second` in the tree. The incorrect drain applies job
 * 2 then job 1 and leaves **`first`** — the mirror one version stale, with both versions carrying
 * a sha, and nothing anywhere reporting a failure. That is the exact hazard the phase plan names,
 * and the assertion below distinguishes them because the file's body differs.
 *
 * The inversion is staged rather than hoped for: `nextAttemptAt` is moved so that job 2 sorts
 * **first** under `ORDER BY "nextAttemptAt", "id"`. That is not a contrivance — it is what a
 * backoff does. Job 1 failing once and being pushed out while job 2 arrives due-now is the
 * ordinary way two jobs for one page end up sorted backwards.
 *
 * Kills: deleting the `NOT EXISTS` barrier from `claimNextJob` — measured, and the file then holds
 * `first`. It also kills ordering by `id` alone in a way an id-ordered assertion could not.
 */
test("jobs for one page apply in enqueue order even when a later job sorts first", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");

  const v1 = await publish(viewer, target.id, "first\n");
  const v2 = await publish(viewer, target.id, "second\n");
  const queued = await jobs();
  expect(queued).toHaveLength(2);

  // Job 2 becomes the one `ORDER BY "nextAttemptAt", "id"` reaches first.
  await db.gitJob.update({
    where: { id: queued[0]!.id },
    data: { nextAttemptAt: new Date(Date.now() - 1_000) },
  });
  await db.gitJob.update({
    where: { id: queued[1]!.id },
    data: { nextAttemptAt: new Date(Date.now() - 60_000) },
  });

  const report = await drainMirrorJobs(config);
  expect(report.done).toBe(2);

  const file = await mirrored(config, "engineering/topic-registry.md");
  expect(file).toContain("second");
  expect(file).not.toContain("first");
  // And the sha on each version names the commit that mirrored *it*, in the order they were made.
  const versions = await db.pageVersion.findMany({
    where: { id: { in: [v1, v2] } },
    select: { id: true, gitSha: true },
  });
  const shas = new Map(versions.map((v) => [v.id, v.gitSha]));
  expect(shas.get(v1)).not.toBeNull();
  expect(shas.get(v2)).not.toBeNull();
  expect(shas.get(v1)).not.toBe(shas.get(v2));
  const history = await runGit(config.git, ["rev-list", "HEAD"]);
  const order = history.stdout.trim().split("\n");
  // `rev-list` is newest first, so v2's commit is the head and v1's is behind it.
  expect(order[0]).toBe(shas.get(v2));
  expect(order[1]).toBe(shas.get(v1));
});

/**
 * The move case, which fails differently from two publishes and so is not the same test.
 *
 * Out of order, the `MOVE` runs against a tree that has no file yet, no-ops, and the `PUBLISH`
 * then writes at the path it captured — leaving the document at the **old** address for ever,
 * because nothing will enqueue that move again. In order, the publish writes the old path and the
 * move renames it.
 */
test("a publish enqueued before a move is applied before it, whatever the sort order says", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const architecture = await page(null, "architecture", "Architecture");
  const reference = await page(null, "reference", "Reference");
  const target = await page(architecture, "topic-registry", "Topic registry");

  await publish(viewer, target.id, "The registry.\n");
  const moved = await movePage(viewer, target.id, {
    newParentId: reference.id,
    newSlug: "topic-registry",
  });
  expect(moved.ok).toBe(true);

  const queued = await jobs();
  expect(queued.map((j) => [j.kind, j.fromPath, j.path])).toEqual([
    ["PUBLISH", null, "architecture/topic-registry"],
    ["MOVE", "architecture/topic-registry", "reference/topic-registry"],
  ]);
  await db.gitJob.update({
    where: { id: queued[1]!.id },
    data: { nextAttemptAt: new Date(Date.now() - 60_000) },
  });

  expect((await drainMirrorJobs(config)).done).toBe(2);

  expect(await exists(config, "engineering/architecture/topic-registry.md")).toBe(false);
  expect(await mirrored(config, "engineering/reference/topic-registry.md")).toContain(
    "The registry.",
  );
});

/**
 * The residual the barrier cannot close, made visible instead of silent.
 *
 * A `NOT EXISTS` cannot see an uncommitted row, so the interleaving Task 3 measured — a slow
 * transaction holding a lower id while a faster one commits a higher one — still drains the later
 * job first. Rather than pretend otherwise, the worker refuses the earlier job when a later one
 * for the same page has already reached `DONE`, and the refusal is permanent and says why.
 *
 * Staged by making the out-of-order application real: a job is inserted with an id below one that
 * has already drained.
 */
test("a job that arrives after a later job for its page has been applied fails instead of writing", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const v1 = await publish(viewer, target.id, "first\n");
  const v2 = await publish(viewer, target.id, "second\n");

  const queued = await jobs();
  const staleId = queued[0]!.id;
  // The stale job is removed, the newer one is drained, and then the stale one is put back at its
  // original id — which is exactly what "committed later, numbered earlier" looks like from the
  // worker's side, and the one shape a `NOT EXISTS` in the claim's own snapshot cannot see.
  await db.gitJob.delete({ where: { id: staleId } });
  expect((await drainMirrorJobs(config)).done).toBe(1);

  await db.$executeRaw`
    INSERT INTO "GitJob" ("id", "kind", "state", "pageId", "versionId", "spaceKey", "path",
                          "attempts", "nextAttemptAt", "createdAt", "updatedAt")
    VALUES (${staleId}, 'PUBLISH', 'PENDING', ${target.id}, ${v1}, 'engineering',
            'topic-registry', 0, now(), now(), now())`;

  const report = await drainMirrorJobs(config);

  expect(report.failed).toBe(1);
  expect(report.jobs.map((j) => [j.state, j.detail])).toEqual([["FAILED", "failed"]]);
  expect(report.jobs[0]!.error).toContain("out of order");
  // Nothing was written: the newer document stands and no commit was made for the stale job.
  expect(await mirrored(config, "engineering/topic-registry.md")).toContain("second");
  expect(await commitCount(config.git)).toBe(1);
  expect(
    (await db.pageVersion.findUniqueOrThrow({ where: { id: v2 }, select: { gitSha: true } }))
      .gitSha,
  ).not.toBeNull();
});

// ── Step 3: commit, then push, then record ────────────────────────────────────────────────────

/**
 * **The commit-then-push proof.** The push fails, the job retries, the push succeeds — and there
 * is exactly one commit and one sha at the end.
 *
 * The remote is a path that does not exist, so `git push` fails immediately and locally: no
 * network, no timeout, no flake. The tree is initialised without a remote first, so
 * `ensureRepository` finds it `existing` and never tries to clone from the broken URL.
 *
 * Kills: recording the sha before the push (the mid-flight assertion that `gitSha` is null), and
 * committing again on the retry (the commit count, which is 2 under any implementation that does
 * not go through Task 5's clean-index branch).
 */
test("a commit whose push fails is retried as a push: one commit, one sha, publish standing", async () => {
  const { viewer, page } = await fixture();
  const broken = join(await scratch("gone"), "missing.git");
  const config = await workerConfig({ maxAttempts: 5 });
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "The body.\n");

  // Make the tree first with no remote, then point the config at a remote that is not there.
  expect((await drainMirrorJobs({ ...config, git: { ...config.git, remoteUrl: null } })).done)
    .toBe(1);
  // Undo that drain so the same job runs again against the broken remote — this is a
  // characterisation of the retry path, not of a second publish.
  await db.gitJob.updateMany({ data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date() } });
  await db.pageVersion.updateMany({ where: { id: versionId }, data: { gitSha: null } });

  const failing = { ...config, git: { ...config.git, remoteUrl: broken } };
  const first = await drainMirrorJobs(failing);

  expect(first.retrying).toBe(1);
  expect(first.jobs[0]!.state).toBe("PENDING");
  expect(first.jobs[0]!.error).toContain("Pushing to the content remote");
  // The commit exists locally and the version is *not* mirrored. Both halves are the exit
  // criterion: "the version stands, gitSha is null, the job retries with backoff".
  expect(await commitCount(config.git)).toBe(1);
  const midflight = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true, page: { select: { publishedVersionId: true } } },
  });
  expect(midflight.gitSha).toBeNull();
  // The publish stood. Documentation does not go down because a git host does.
  expect(midflight.page.publishedVersionId).toBe(versionId);

  // Now a remote that works. `nextAttemptAt` has been pushed out, so wind it back rather than
  // sleeping for the backoff.
  const working = { ...config, git: { ...config.git, remoteUrl: await bareRemote() } };
  await db.gitJob.updateMany({ data: { nextAttemptAt: new Date() } });
  const second = await drainMirrorJobs(working);

  expect(second.done).toBe(1);
  expect(second.jobs[0]!.detail).toBe("already-applied");
  // One commit, one sha. The retry pushed; it did not commit again.
  expect(await commitCount(config.git)).toBe(1);
  const final = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });
  expect(final.gitSha).toMatch(/^[0-9a-f]{40}$/);
  expect((await jobs())[0]!.attempts).toBe(2);

  // And the commit really is on the remote, which is what "mirrored" means once one is configured.
  const onRemote = await runGit(working.git, ["ls-remote", "--", working.git.remoteUrl!, "HEAD"]);
  expect(onRemote.stdout).toContain(final.gitSha!);
});

test("with no remote configured the local repository is the mirror, and the sha is recorded", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ git: { ...(await workerConfig()).git, remoteUrl: null } });
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "Body.\n");

  expect((await drainMirrorJobs(config)).done).toBe(1);

  const version = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });
  expect(version.gitSha).toMatch(/^[0-9a-f]{40}$/);
});

// ── Step 4: backoff, and a terminal state ─────────────────────────────────────────────────────

test("backoffMs doubles from the base and stops at the ceiling", () => {
  const config = { backoffBaseMs: 1000, backoffCeilingMs: 8000 } as WorkerConfig;
  expect([1, 2, 3, 4, 5, 9].map((n) => backoffMs(config, n))).toEqual([
    1000, 2000, 4000, 8000, 8000, 8000,
  ]);
});

/**
 * Attempts climb, `nextAttemptAt` moves out, and the job is `FAILED` at the ceiling rather than
 * retried for ever — **and the publish stands throughout**, which is the phase's central claim and
 * an exit criterion, so it is asserted at every step rather than once at the end.
 */
test("a job retries with backoff and then fails terminally, with the publish standing throughout", async () => {
  const { viewer, page } = await fixture();
  const broken = join(await scratch("gone"), "missing.git");
  const config = await workerConfig({ maxAttempts: 2, backoffBaseMs: 60_000 });
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "The body.\n");

  // A tree with no remote to start, so `ensureRepository` never clones from the broken URL.
  await drainMirrorJobs({ ...config, git: { ...config.git, remoteUrl: null }, maxJobs: 0 });
  const failing = { ...config, git: { ...config.git, remoteUrl: broken } };

  const first = await drainMirrorJobs(failing);
  expect(first.retrying).toBe(1);
  const afterFirst = (await jobs())[0]!;
  expect(afterFirst.state).toBe("PENDING");
  expect(afterFirst.attempts).toBe(1);
  expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  expect(afterFirst.lastError).toContain("Pushing to the content remote");

  // Still due in the future, so a drain now is a no-op — the backoff is real, not decorative.
  expect((await drainMirrorJobs(failing)).jobs).toEqual([]);

  await db.gitJob.updateMany({ data: { nextAttemptAt: new Date() } });
  const second = await drainMirrorJobs(failing);
  expect(second.failed).toBe(1);
  const afterSecond = (await jobs())[0]!;
  expect(afterSecond.state).toBe("FAILED");
  expect(afterSecond.attempts).toBe(2);

  // Terminal: a further drain does not pick it up again.
  await db.gitJob.updateMany({ data: { nextAttemptAt: new Date() } });
  expect((await drainMirrorJobs(failing)).jobs).toEqual([]);
  expect((await jobs())[0]!.attempts).toBe(2);

  // The publish never wavered: the page is published, the version is intact and readable, and the
  // only thing missing is the sha — which is exactly what "not mirrored yet" is supposed to mean.
  const version = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: {
      gitSha: true,
      markdown: true,
      page: { select: { publishedVersionId: true, deletedAt: true } },
    },
  });
  expect(version.gitSha).toBeNull();
  expect(version.markdown).toBe("The body.\n");
  expect(version.page.publishedVersionId).toBe(versionId);
  expect(version.page.deletedAt).toBeNull();
});

/**
 * A refusal that no retry can change is failed on its first attempt.
 *
 * `mirrorPathOf` is a pure function of two captured columns, so a `path-refused` will answer the
 * same thing for ever; burning four more attempts and thirty minutes of backoff on it only delays
 * the moment it reaches Task 8's page. The address here is a space key with a separator in it,
 * which `Space.key` has no validation to prevent — `paths.ts` measured that.
 */
test("a path the mirror refuses fails immediately rather than retrying to the ceiling", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ maxAttempts: 5 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "Body.\n");
  await db.gitJob.updateMany({ data: { spaceKey: "engineering/../../etc" } });

  const report = await drainMirrorJobs(config);

  expect(report.failed).toBe(1);
  expect((await jobs())[0]!).toMatchObject({ state: "FAILED", attempts: 1 });
  expect(report.jobs[0]!.error).toContain("one directory name");
  expect(await commitCount(config.git)).toBe(0);
});

// ── A FAILED job blocks its own page, and only its own page ───────────────────────────────────

/**
 * **The decision, and the consequence, both pinned.**
 *
 * A failed job stops its page's queue. The alternative — step over it — applies job 3 without job
 * 2, which is a tree that disagrees with Postgres and *nothing that notices*: the precise property
 * §10 exists to provide. The cost is that one bad job freezes that page until someone intervenes,
 * which is what Task 8's page is for.
 *
 * Both halves are asserted, because they are not the same claim and a single-page fixture cannot
 * tell them apart: "blocked the page" and "wedged the worker" look identical until another page's
 * job drains in the same run.
 */
test("a FAILED job blocks later jobs for its own page and no others", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ maxAttempts: 1 });
  const architecture = await page(null, "architecture", "Architecture");
  const reference = await page(null, "reference", "Reference");
  const stuck = await page(architecture, "topic-registry", "Topic registry");
  const other = await page(null, "handbook", "Handbook");

  await publish(viewer, stuck.id, "The registry.\n");
  await publish(viewer, other.id, "The handbook.\n", "Handbook");
  // Make the first page's publish job unfixable: an address the mirror refuses.
  const [stuckJob] = await jobs();
  await db.gitJob.update({
    where: { id: stuckJob!.id },
    data: { spaceKey: "engineering/nested" },
  });

  expect((await drainMirrorJobs(config)).failed).toBe(1);

  // A second job for the stuck page, and it must not be applied.
  const moved = await movePage(viewer, stuck.id, {
    newParentId: reference.id,
    newSlug: "topic-registry",
  });
  expect(moved.ok).toBe(true);
  // A second job for the other page too, so "nothing drained" cannot pass for "the page is
  // blocked".
  await publish(viewer, other.id, "The handbook, revised.\n", "Handbook");

  const report = await drainMirrorJobs(config);

  const rows = await jobs();
  const byPage = (pageId: string) => rows.filter((r) => r.pageId === pageId);
  expect(byPage(stuck.id).map((r) => [r.kind, r.state, r.attempts])).toEqual([
    ["PUBLISH", "FAILED", 1],
    ["MOVE", "PENDING", 0],
  ]);
  expect(byPage(other.id).map((r) => [r.kind, r.state])).toEqual([
    ["PUBLISH", "DONE"],
    ["PUBLISH", "DONE"],
  ]);
  expect(report.done).toBe(1);
  expect(await mirrored(config, "engineering/handbook.md")).toContain("revised");
});

// ── A MOVE whose source is not in the tree ────────────────────────────────────────────────────

/**
 * **A no-op, not a failure and not a repair**, and the reachable route is the ordinary one: every
 * version published before this phase existed has no mirrored file, so the first move of any such
 * page renames a path the tree has never held.
 *
 * The fixture is exactly that page — a published version written straight to the database, the way
 * every row that predates the mirror looks — and then a real `movePage`.
 *
 * Failing it would fill Task 8's page with jobs no operator can clear, because a `MOVE` carries
 * `versionId: null` by design and there are no bytes to write. Repairing it would need those bytes
 * from a `PageVersion` joined at drain time, which is the join Task 4's capture rule forbids by
 * name. The no-op converges instead: the assertion at the end is that the page's **next** publish
 * writes its file at the path it holds by then.
 */
test("a MOVE whose source is not in the tree is a no-op that converges on the next publish", async () => {
  const { aisyah, viewer, space, page } = await fixture();
  const config = await workerConfig();
  const architecture = await page(null, "architecture", "Architecture");
  const reference = await page(null, "reference", "Reference");
  const target = await page(architecture, "topic-registry", "Topic registry");

  // Published before the mirror existed: a version row and a `publishedVersionId`, and no job.
  const version = await db.pageVersion.create({
    data: {
      pageId: target.id,
      title: "Topic registry",
      markdown: "Predates the mirror.\n",
      status: "CURRENT",
      authorId: aisyah.id,
    },
  });
  await db.page.update({
    where: { id: target.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });
  expect(await db.gitJob.count()).toBe(0);

  const moved = await movePage(viewer, target.id, {
    newParentId: reference.id,
    newSlug: "topic-registry",
  });
  expect(moved.ok).toBe(true);

  const report = await drainMirrorJobs(config);

  expect(report.done).toBe(1);
  expect(report.jobs.map((j) => [j.kind, j.state, j.detail])).toEqual([
    ["MOVE", "DONE", "move-source-absent"],
  ]);
  // Nothing was invented at either address, and no commit was made for a change that did not
  // happen.
  expect(await exists(config, "engineering/architecture/topic-registry.md")).toBe(false);
  expect(await exists(config, "engineering/reference/topic-registry.md")).toBe(false);
  expect(await commitCount(config.git)).toBe(0);

  // Convergence: the address is captured per job, so the next publish writes at the current path
  // and the tree catches up with no operator involved.
  await publish(viewer, target.id, "Now mirrored.\n");
  expect((await drainMirrorJobs(config)).done).toBe(1);
  expect(await mirrored(config, "engineering/reference/topic-registry.md")).toContain(
    "Now mirrored.",
  );
  expect(await exists(config, "engineering/architecture/topic-registry.md")).toBe(false);
  expect(space.key).toBe("engineering");
});

test("a DELETE of a page the tree never held is a no-op rather than a failure", async () => {
  const { aisyah, viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const version = await db.pageVersion.create({
    data: {
      pageId: target.id,
      title: "Topic registry",
      markdown: "Predates the mirror.\n",
      status: "CURRENT",
      authorId: aisyah.id,
    },
  });
  await db.page.update({
    where: { id: target.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });

  expect((await deletePage(viewer, target.id)).ok).toBe(true);
  const report = await drainMirrorJobs(config);

  expect(report.jobs.map((j) => [j.kind, j.state, j.detail])).toEqual([
    ["DELETE", "DONE", "delete-target-absent"],
  ]);
  expect(await commitCount(config.git)).toBe(0);
});

// ── Soft delete: the worker mirrors a deleted page's deletion, and must not filter it out ─────

/**
 * The soft-delete registration in `src/lib/pages/visible.test.ts` claims this module is
 * deliberately **blind** to `deletedAt`, and this is the test that pins the absence — the same
 * shape `createPage`'s collision check carries, where a filter added later would break something
 * that has a test rather than merely be redundant.
 *
 * The interleaving is the one that makes it necessary: a page published and then deleted before
 * the worker ever ran. The `PUBLISH` job's version belongs to a page whose `deletedAt` is set, and
 * a soft-delete filter on the version read would fail it — leaving the `DELETE` job behind it to
 * remove a file that was never written, and the version permanently unmirrored.
 */
test("a page soft-deleted before the drain still has its publish mirrored, then removed", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "The body.\n");
  expect((await deletePage(viewer, target.id)).ok).toBe(true);

  const report = await drainMirrorJobs(config);

  expect(report.jobs.map((j) => [j.kind, j.state, j.detail])).toEqual([
    ["PUBLISH", "DONE", "written"],
    ["DELETE", "DONE", "removed"],
  ]);
  // Two commits: the file was really written and really removed, which is what makes the mirror a
  // history rather than a snapshot.
  expect(await commitCount(config.git)).toBe(2);
  expect(await subjects(config.git)).toEqual([
    'Delete "engineering/topic-registry"',
    'Publish "engineering/topic-registry"',
  ]);
  expect(await exists(config, "engineering/topic-registry.md")).toBe(false);
  // The sha was recorded for a version whose page is soft-deleted — the write side of the same
  // blindness.
  const version = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });
  expect(version.gitSha).toMatch(/^[0-9a-f]{40}$/);
});

test("a restore puts the file back, and does not rewrite the version's provenance", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "The body.\n");
  expect((await drainMirrorJobs(config)).done).toBe(1);
  const published = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });

  expect((await deletePage(viewer, target.id)).ok).toBe(true);
  expect((await restorePage(viewer, target.id)).ok).toBe(true);
  const report = await drainMirrorJobs(config);

  expect(report.jobs.map((j) => [j.kind, j.state, j.detail])).toEqual([
    ["DELETE", "DONE", "removed"],
    ["RESTORE", "DONE", "written"],
  ]);
  expect(await mirrored(config, "engineering/topic-registry.md")).toContain("The body.");

  // The sha still names the commit that **first** mirrored these bytes. A restore is about a
  // page's presence, not about a version's provenance.
  const after = await db.pageVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { gitSha: true },
  });
  expect(after.gitSha).toBe(published.gitSha);

  // And the restore is committed by the service, not by the version's author: a `GitJob` captures
  // no actor, and the author email is what a git host matches to an account.
  const idents = await runGit(config.git, ["log", "-1", "--format=%an|%ae"]);
  expect(idents.stdout.trim()).toBe("Badam Fallback|fallback@badam.test");
});

// ── Stale RUNNING: a worker that died mid-job ─────────────────────────────────────────────────

/**
 * A worker killed between claiming a job and finishing it leaves the row `RUNNING` for ever, and
 * because an unfinished job blocks its page, that one row would freeze that page's mirror
 * permanently. Nothing in the schema recovers it; the reclaim does.
 *
 * `updatedAt` is the lease clock — the schema already defines it as "when it was last attempted",
 * and the claim is the only thing that puts a row into `RUNNING`.
 */
test("a job abandoned by a dead worker becomes claimable again and drains", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ leaseMs: 60_000 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "The body.\n");

  // Exactly what a killed worker leaves: RUNNING, one attempt spent, and no further writes.
  const [queued] = await jobs();
  await db.$executeRaw`
    UPDATE "GitJob"
       SET "state" = 'RUNNING', "attempts" = 1, "updatedAt" = now() - interval '1 hour'
     WHERE "id" = ${queued!.id}`;

  // Not claimable while it is RUNNING — the barrier is what makes the reclaim necessary rather
  // than merely tidy.
  expect(await claimNextJob(config)).toBeNull();

  const report = await drainMirrorJobs(config);

  expect(report.reclaimed).toBe(1);
  expect(report.done).toBe(1);
  // The reclaim spent no attempt of its own; the claim that followed it did.
  expect((await jobs())[0]!.attempts).toBe(2);
  expect(await mirrored(config, "engineering/topic-registry.md")).toContain("The body.");
});

test("a RUNNING job younger than the lease is left alone", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ leaseMs: 60_000 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "The body.\n");
  await db.$executeRaw`UPDATE "GitJob" SET "state" = 'RUNNING', "attempts" = 1, "updatedAt" = now()`;

  expect(await reclaimAbandonedJobs(config)).toBe(0);
  expect((await jobs())[0]!.state).toBe("RUNNING");
});

/**
 * The loop the reclaim has to close, and the reason it applies the ceiling itself: a job that
 * kills the worker every time never reaches the code that writes `FAILED`, so a reclaim that only
 * ever wrote `PENDING` would re-run it for ever while `attempts` climbed past the ceiling with
 * nobody looking.
 */
test("a job reclaimed after using its attempts is FAILED rather than retried for ever", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig({ maxAttempts: 3, leaseMs: 60_000 });
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "The body.\n");
  await db.$executeRaw`
    UPDATE "GitJob"
       SET "state" = 'RUNNING', "attempts" = 3, "updatedAt" = now() - interval '1 hour'`;

  expect(await reclaimAbandonedJobs(config)).toBe(1);

  const row = (await jobs())[0]!;
  expect(row.state).toBe("FAILED");
  expect(row.lastError).toContain("did not finish it");
});

/**
 * The fence, which is what makes a wrongly-reclaimed job harmless.
 *
 * If the lease expires while the worker that claimed the job is in fact alive, that job is
 * re-claimed and run twice. Both runs write the same bytes and the second finds a clean index, so
 * the tree is unharmed — but the first worker will eventually come back and try to write a
 * terminal state for a job it no longer owns. `attempts` is the fencing token: the finish names
 * the value its own claim returned, so a stale finish matches zero rows and reports itself.
 */
test("a worker whose job was reclaimed writes nothing when it finishes", async () => {
  const { viewer, page } = await fixture();
  const config = await workerConfig();
  const target = await page(null, "topic-registry", "Topic registry");
  const versionId = await publish(viewer, target.id, "The body.\n");

  const claimed = await claimNextJob(config);
  expect(claimed).not.toBeNull();
  const stale = claimed as ClaimedJob;

  // Somebody else reclaimed and re-claimed it while this worker was busy.
  await db.$executeRaw`
    UPDATE "GitJob" SET "attempts" = "attempts" + 1, "updatedAt" = now() WHERE "id" = ${stale.id}`;

  const outcome = await finishJob({
    job: stale,
    state: "DONE",
    retryInMs: 0,
    lastError: null,
    sha: "0".repeat(40),
  });

  expect(outcome).toBe("lease-lost");
  // Neither the state nor the sha was written: the row is still owned by whoever holds attempt 2.
  expect((await jobs())[0]!).toMatchObject({ state: "RUNNING", attempts: 2 });
  expect(
    (await db.pageVersion.findUniqueOrThrow({ where: { id: versionId }, select: { gitSha: true } }))
      .gitSha,
  ).toBeNull();
});

// ── Step 5: the exit code an operator puts in a cron ──────────────────────────────────────────

/**
 * The script, run as a real subprocess, because the exit code **is** the product surface here and
 * nothing else in the suite can see it. A function that returns a number is not a check that
 * `npm run git:worker` answers with one — that is the class of gap this project keeps finding, and
 * the smoke script's own docstring already carries the version of it where a pipeline reported
 * `tail`'s status instead of the command's.
 *
 * Status is read from the spawn, never through a pipe. Three bugs in this project came from a
 * pipeline reporting its last command's status, and one of them was measured in this very phase.
 */
async function runWorkerScript(
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((settle) => {
    const child = spawn("npx", ["--no", "tsx", "scripts/git-worker.ts"], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

test("npm run git:worker exits 0 with nothing to do", async () => {
  const root = await scratch("cli-idle");
  const run = await runWorkerScript({ GIT_MIRROR_ROOT: root });

  expect(run.code).toBe(0);
  expect(run.stdout).toContain("0 done, 0 retrying, 0 failed");
}, 60_000);

test("npm run git:worker exits 0 when it drained, and 1 when a job ended FAILED", async () => {
  const { viewer, page } = await fixture();
  const root = await scratch("cli-drain");
  const target = await page(null, "topic-registry", "Topic registry");
  await publish(viewer, target.id, "The body.\n");

  const drained = await runWorkerScript({ GIT_MIRROR_ROOT: root });
  expect(drained.code).toBe(0);
  expect(drained.stdout).toContain("1 done, 0 retrying, 0 failed");

  // A second page whose address the mirror refuses, with one attempt allowed: it ends FAILED, and
  // a cron has to hear about that.
  const doomed = await page(null, "handbook", "Handbook");
  await publish(viewer, doomed.id, "The handbook.\n", "Handbook");
  await db.gitJob.updateMany({
    where: { pageId: doomed.id },
    data: { spaceKey: "engineering/nested" },
  });

  const failed = await runWorkerScript({ GIT_MIRROR_ROOT: root, GIT_WORKER_MAX_ATTEMPTS: "1" });
  expect(failed.code).toBe(1);
  expect(failed.stdout).toContain("0 done, 0 retrying, 1 failed");
}, 120_000);

/**
 * A run that could not start at all is a **2**, not a 1: "one page is stuck" and "the mirror has
 * not run since Tuesday" need different people, and a cron whose mail cannot tell them apart is a
 * cron whose mail stops being read.
 *
 * The unreachable database is the cheapest way to reach it and touches nothing — the working tree
 * is never even looked at, because the advisory lock comes first.
 */
test("npm run git:worker exits 2 when the run itself cannot start", async () => {
  const root = await scratch("cli-fatal");
  const run = await runWorkerScript({
    GIT_MIRROR_ROOT: root,
    DATABASE_URL: "postgresql://badam:badam@127.0.0.1:1/nowhere",
  });

  expect(run.code).toBe(2);
  expect(run.stderr).toContain("could not run");
  // Nothing was written: a worker that cannot reach its queue must not have made a repository.
  expect(await exists({ git: { root } } as WorkerConfig, ".git")).toBe(false);
}, 60_000);
