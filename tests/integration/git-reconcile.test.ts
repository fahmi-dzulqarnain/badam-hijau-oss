import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  MAX_RECONCILE_JOBS,
  reconcileUnmirrored,
  unmirroredReport,
} from "@/lib/git/reconcile";
import type { GitJobState } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Phase 7 Task 7's reconcile pass — **the third of the debts Phase 5 named and deferred here**,
 * against the real database.
 *
 * Phase 5's sentence is the thing under test as much as the feature is: *"the queue is not a
 * reconciliation, and pre-mirror versions stay `gitSha = null`."* This pass does not make the queue
 * a reconciliation; it makes reconciliation an **act**, with a count in front of it and an audit
 * row behind it. So the tests come in three groups:
 *
 * 1. **What counts as a gap**, which is the half that is easy to get subtly wrong: three states
 *    look alike from `gitSha = null`, and only one of them is this pass's.
 * 2. **That it reuses the enqueue rather than inventing a second way to make a job** — the captured
 *    address, the version id, and the never-published rule that lives in the callee.
 * 3. **That nothing happens without a person**, which is the whole of §10's value: the bound, the
 *    audit row, and the refusal.
 *
 * Integration and not unit for `git-failures.test.ts`'s reason: every question here is a question
 * about rows and about which of them a predicate reaches.
 */

async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Root", isSuperAdmin: true },
  });
  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: author.id, role: "ADMIN" },
  });

  /**
   * A page, optionally published, optionally with a sha on the published version, optionally
   * soft-deleted.
   *
   * `published: false` is the never-published case, which is `enqueueMirrorJobs`'s own rule rather
   * than this module's — kept in the fixture so a test can prove the rule still holds through the
   * reuse.
   */
  const page = async (opts: {
    path: string;
    spaceId?: string;
    published?: boolean;
    gitSha?: string | null;
    deleted?: boolean;
  }) => {
    const created = await db.page.create({
      data: {
        spaceId: opts.spaceId ?? engineering.id,
        slug: opts.path.split("/").pop()!,
        path: opts.path,
        title: `Page ${opts.path}`,
        docType: "DOC",
        status: "CURRENT",
        createdById: author.id,
        deletedAt: opts.deleted === true ? new Date() : null,
      },
      select: { id: true, path: true, spaceId: true },
    });

    if (opts.published === false) return { ...created, versionId: null as string | null };

    const version = await db.pageVersion.create({
      data: {
        pageId: created.id,
        title: `Page ${opts.path}`,
        markdown: `# Page ${opts.path}`,
        searchText: `Page ${opts.path}`,
        status: "CURRENT",
        authorId: author.id,
        gitSha: opts.gitSha ?? null,
      },
      select: { id: true },
    });
    await db.page.update({
      where: { id: created.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
    return { ...created, versionId: version.id };
  };

  /** A job on a page, in whatever state the case needs. */
  const job = async (pageId: string, state: GitJobState) =>
    await db.gitJob.create({
      data: {
        pageId,
        kind: "PUBLISH",
        state,
        spaceKey: "engineering",
        path: "whatever",
        attempts: state === "FAILED" ? 5 : 0,
      },
      select: { id: true },
    });

  const member: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: engineering.id, role: "ADMIN" }],
  };
  const admin: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };

  return { author, root, engineering, handbook, page, job, member, admin };
}

async function report(viewer: Viewer) {
  const result = await unmirroredReport(viewer);
  if (!result.ok) throw new Error(`unmirroredReport refused: ${result.reason}`);
  return result.report;
}

async function reconcile(viewer: Viewer) {
  const result = await reconcileUnmirrored(viewer);
  if (!result.ok) throw new Error(`reconcileUnmirrored refused: ${result.reason}`);
  return result;
}

const queuedJobs = async () =>
  await db.gitJob.findMany({
    orderBy: { id: "asc" },
    select: { pageId: true, kind: true, state: true, spaceKey: true, path: true, fromPath: true, versionId: true },
  });

/* -------------------------------------------------------------------------- */
/* What counts as a gap                                                       */
/* -------------------------------------------------------------------------- */

test("a published version with no sha and no job is the gap, and is queued", async () => {
  const f = await fixture();
  const stranded = await f.page({ path: "architecture/mqtt-contracts" });

  const before = await report(f.admin);
  expect(before.unmirrored).toBe(1);
  expect(before.awaitingQueue).toBe(0);

  const result = await reconcile(f.admin);
  expect(result.queued).toBe(1);
  expect(result.remaining).toBe(0);

  const jobs = await queuedJobs();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    pageId: stranded.id,
    kind: "PUBLISH",
    state: "PENDING",
    // The address captured at enqueue time is the page's address NOW, which is where a repaired
    // file belongs — a page moved since publication has one correct mirror path and it is today's.
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    fromPath: null,
  });
  // A PUBLISH writes bytes, so it carries the version whose bytes they are — `enqueueMirrorJobs`'s
  // rule, reached through the reuse rather than restated here.
  expect(jobs[0]?.versionId).toBe(stranded.versionId);
});

test("a version that already carries a sha is not a gap", async () => {
  const f = await fixture();
  await f.page({ path: "mirrored", gitSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736" });

  expect((await report(f.admin)).unmirrored).toBe(0);
  expect((await reconcile(f.admin)).queued).toBe(0);

  // Non-vacuity: the same call over a page whose version has no sha queues it, so zero above is
  // the predicate and not a pass that never runs.
  await f.page({ path: "unmirrored" });
  expect((await reconcile(f.admin)).queued).toBe(1);
});

/**
 * **A page the queue already knows about is not this pass's**, in all three unfinished states.
 *
 * `PENDING` and `RUNNING` are work the worker is going to do; a second `PUBLISH` would sit behind
 * the first under Task 6's barrier and could not arrive sooner. `FAILED` is the sharper case: the
 * page is wedged, so a reconcile job would join a queue that is not moving and grow the failures
 * page's *blocked* count while changing nothing.
 *
 * All three are counted as `awaitingQueue` rather than dropped, because "nothing to reconcile" and
 * "everything unmirrored is already queued" are different states and a surface showing one number
 * could not tell them apart.
 */
test("a page with a pending, running or failed job is counted apart and never queued twice", async () => {
  const f = await fixture();
  const pending = await f.page({ path: "pending" });
  const running = await f.page({ path: "running" });
  const failed = await f.page({ path: "failed" });
  await f.job(pending.id, "PENDING");
  await f.job(running.id, "RUNNING");
  await f.job(failed.id, "FAILED");

  const shown = await report(f.admin);
  expect(shown.unmirrored).toBe(0);
  expect(shown.awaitingQueue).toBe(3);

  const result = await reconcile(f.admin);
  expect(result.queued).toBe(0);
  expect(await db.gitJob.count()).toBe(3);
});

/**
 * A page whose only jobs are `DONE` **is** a gap, and this is the case that separates the two
 * predicates.
 *
 * It is reachable rather than exotic: a `DELETE` and a `RESTORE` drain to `DONE` without writing
 * a sha, and a retention sweep on a busy installation leaves a page with no rows at all. What
 * decides is the version's `gitSha`, and `state <> 'DONE'` is only about whether a new job would
 * be applied or would queue behind something.
 */
test("a page whose jobs have all finished is still a gap when the version carries no sha", async () => {
  const f = await fixture();
  const page = await f.page({ path: "drained-but-unmirrored" });
  await f.job(page.id, "DONE");

  expect((await report(f.admin)).unmirrored).toBe(1);
  expect((await reconcile(f.admin)).queued).toBe(1);
});

/**
 * **A soft-deleted page is never reconciled**, and this is the mutation `deletedAt: null` exists
 * for.
 *
 * Its file is *supposed* to be absent from the mirror — the `DELETE` job removed it, or it never
 * had one — so a repair pass that wrote it back would put a page the product has taken down into
 * the content repository. `restorePage` is the legitimate way one comes back, and it enqueues.
 *
 * The live page in the same assertion is the non-vacuity companion: removing the filter changes
 * both numbers, and both halves are asserted, because a test that only counted would pass over an
 * implementation that counted correctly and queued everything.
 */
test("a soft-deleted page is never counted and never reconciled, and a live one is", async () => {
  const f = await fixture();
  await f.page({ path: "gone", deleted: true });
  const live = await f.page({ path: "here" });

  expect((await report(f.admin)).unmirrored).toBe(1);

  const result = await reconcile(f.admin);
  expect(result.queued).toBe(1);
  const jobs = await queuedJobs();
  expect(jobs.map((row) => row.pageId)).toEqual([live.id]);
});

/**
 * A page that was never published enqueues nothing — Phase 5 Task 4's rule, and it is the
 * **callee's**.
 *
 * `enqueueMirrorJobs` filters `publishedVersionId !== null` and owns the argument. This module's
 * `where` asks for pages whose *published version* has no sha, which cannot match a page without
 * one, so the rule is stated once. The test exists because "stated once" is only safe if the one
 * statement is reached.
 */
test("a page that was never published is not a gap", async () => {
  const f = await fixture();
  await f.page({ path: "draft-only", published: false });

  expect((await report(f.admin)).unmirrored).toBe(0);
  expect((await reconcile(f.admin)).queued).toBe(0);
  expect(await db.gitJob.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* Across spaces                                                              */
/* -------------------------------------------------------------------------- */

test("the breakdown says where the gap is, biggest space first", async () => {
  const f = await fixture();
  await f.page({ path: "one" });
  await f.page({ path: "two" });
  await f.page({ path: "solo", spaceId: f.handbook.id });

  const shown = await report(f.admin);
  expect(shown.unmirrored).toBe(3);
  expect(shown.spaces).toEqual([
    { key: "engineering", unmirrored: 2 },
    { key: "handbook", unmirrored: 1 },
  ]);
});

test("one pass queues both spaces, each job carrying its own space key", async () => {
  const f = await fixture();
  const eng = await f.page({ path: "one" });
  const hand = await f.page({ path: "solo", spaceId: f.handbook.id });

  expect((await reconcile(f.admin)).queued).toBe(2);

  const jobs = await queuedJobs();
  // The captured key is the page's own, not the first one the pass saw: a job's address is
  // `<spaceKey>/<path>.md`, so one wrong key writes a file into another space's directory.
  expect(
    jobs.map((row) => [row.pageId, row.spaceKey, row.path]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ).toEqual([
    [eng.id, "engineering", "one"],
    [hand.id, "handbook", "solo"],
  ]);
});

/* -------------------------------------------------------------------------- */
/* The bound, and pressing again                                              */
/* -------------------------------------------------------------------------- */

/**
 * The cap, asserted against a set larger than it, with the remainder reported and reachable by a
 * second press.
 *
 * `MAX_RECONCILE_JOBS` is 500 and seeding 501 pages is a minute of fixture for one number, so this
 * asserts the two properties the cap exists for — `take` bounds the pass, and `remaining` is what
 * is left — against the real constant by checking the arithmetic rather than by exceeding it. The
 * `truncated` flag has its own assertion below over a report, which is where the surface reads it.
 */
test("a pass queues everything under the cap and says nothing is left", async () => {
  const f = await fixture();
  for (const path of ["a", "b", "c"]) await f.page({ path });

  const shown = await report(f.admin);
  expect(shown.cap).toBe(MAX_RECONCILE_JOBS);
  expect(shown.truncated).toBe(false);

  const result = await reconcile(f.admin);
  expect(result.queued).toBe(3);
  expect(result.remaining).toBe(0);
  expect(result.cap).toBe(MAX_RECONCILE_JOBS);

  // Pressing again does nothing: every page it would have taken now has an unfinished job. That is
  // the property that makes a bounded pass safe to repeat, and it is the same predicate doing it.
  const again = await reconcile(f.admin);
  expect(again.queued).toBe(0);
  expect(await db.gitJob.count()).toBe(3);
});

test("the report says a pass will not close the gap when there are more than the cap", async () => {
  const f = await fixture();
  await f.page({ path: "one" });

  // The flag is arithmetic over the count and the cap, so it is asserted where it is computed
  // rather than by seeding 501 pages: `truncated` is `unmirrored > cap`.
  const shown = await report(f.admin);
  expect(shown.truncated).toBe(shown.unmirrored > shown.cap);
  expect(shown.truncated).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* Nothing happens without a person                                           */
/* -------------------------------------------------------------------------- */

test("reading the report queues nothing — it is a count, not a repair", async () => {
  /*
   * The sentence Phase 5 wrote, as an assertion: a gap is *noticed*, and noticing it must not
   * close it. A lazy repair on read is exactly the shape that would make the mirror's value
   * disappear quietly, so the read path is pinned to write nothing at all.
   */
  const f = await fixture();
  await f.page({ path: "one" });

  await report(f.admin);
  await report(f.admin);

  expect(await db.gitJob.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
});

test("a pass writes one spaceless mirror.reconcile row with the counts and the breakdown", async () => {
  const f = await fixture();
  await f.page({ path: "one" });
  await f.page({ path: "solo", spaceId: f.handbook.id });

  await reconcile(f.admin);

  const rows = await db.auditLog.findMany({
    where: { action: "mirror.reconcile" },
    select: { actorId: true, spaceId: true, pageId: true, detail: true },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.root.id, spaceId: null, pageId: null });
  expect(rows[0]?.detail).toMatchObject({
    queued: 2,
    remaining: 0,
    cap: MAX_RECONCILE_JOBS,
    spaces: { engineering: 1, handbook: 1 },
  });
});

test("a pass with nothing to do writes the row and no jobs", async () => {
  // "Was this ever run?" is the question the row answers, and a trail that recorded only the
  // presses that queued something could not.
  const f = await fixture();
  await reconcile(f.admin);

  expect(await db.gitJob.count()).toBe(0);
  expect(await db.auditLog.count({ where: { action: "mirror.reconcile" } })).toBe(1);
});

test("a refused pass queues nothing and writes nothing", async () => {
  const f = await fixture();
  await f.page({ path: "one" });

  expect(await reconcileUnmirrored(f.member)).toEqual({ ok: false, reason: "not-found" });

  expect(await db.gitJob.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
});

/**
 * The discriminating viewer is an **`ADMIN` of a real space**, not a stranger — a member of nothing
 * is refused by any predicate at all. And it is a discrimination rather than an absence: the super
 * admin reads and acts on the same fixture in the same test.
 */
test("a space ADMIN is refused by both entry points, and the super admin is not", async () => {
  const f = await fixture();
  await f.page({ path: "one" });

  expect(await unmirroredReport(f.member)).toEqual({ ok: false, reason: "not-found" });
  expect(await reconcileUnmirrored(f.member)).toEqual({ ok: false, reason: "not-found" });

  expect((await report(f.admin)).unmirrored).toBe(1);
  expect((await reconcile(f.admin)).queued).toBe(1);
});

/**
 * **The pass reaches a `MEMBERS` space the super admin does not belong to**, which is the wrong
 * kind of blind spot to have quietly.
 *
 * `readableSpace` is absent from the module and this is why: an installation's mirror does not stop
 * at the spaces its administrator happens to be a member of, and a repair pass with that filter
 * would leave exactly the closed spaces unmirrored for ever while reporting success. The admin in
 * this fixture is a member of nothing.
 */
test("a MEMBERS space the admin does not belong to is reconciled like any other", async () => {
  const f = await fixture();
  const closed = await f.page({ path: "closed" });

  expect((await report(f.admin)).spaces).toEqual([{ key: "engineering", unmirrored: 1 }]);
  await reconcile(f.admin);

  const jobs = await queuedJobs();
  expect(jobs.map((row) => row.pageId)).toEqual([closed.id]);
});

/**
 * And it writes **no** `space.access` row, which is Task 6's line rather than Task 1's.
 *
 * What this surface shows is containers and integers — a space key and how many of its pages are
 * unmirrored — with no title and no path anywhere, which is what `listSpacesForAdmin` already shows
 * every super admin without writing a row. The discrimination is against `listMirrorFailures` on
 * the same page, which paints titles and paths and audits: the two are asserted together so the
 * zero here is a decision rather than a call site somebody forgot.
 */
test("counting a private space's unmirrored pages writes no space.access row", async () => {
  const f = await fixture();
  await f.page({ path: "closed" });

  await report(f.admin);
  await reconcile(f.admin);

  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(0);
  // Non-vacuity: the same super admin, the same MEMBERS space, and the surface's other read — the
  // one that paints a title and a path — does write the row. So zero above is `needsAccessAudit`
  // being asked a different question, not an audit that has stopped working.
  const { listMirrorFailures } = await import("@/lib/git/failures");
  await db.gitJob.updateMany({ where: {}, data: { state: "FAILED", lastError: "nope" } });
  await listMirrorFailures(f.admin);
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(1);
});
