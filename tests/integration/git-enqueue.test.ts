import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage } from "@/lib/pages/publish";
import { movePage } from "@/lib/pages/move";
import { deletePage, restorePage } from "@/lib/pages/delete";
import { childPath } from "@/lib/pages/slug";
import type { GitJobKind } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

/**
 * Phase 5 Task 4 — the `GitJob` rows the four mirror-changing mutations write.
 *
 * What this file is for, stated once: **the job is committed with the mutation, and it carries
 * the address as it stood at that instant.** Both halves are invisible to a test that only
 * counts rows, which is why nothing here asserts a count alone.
 */

/**
 * Lets two tests force `enqueueMirrorJobs` to fail, on either side of the real call.
 *
 * `vi.hoisted` because a `vi.mock` factory is hoisted above every import, and the factory needs
 * something to read. The wrapper delegates to the real module in every other test in this file,
 * so nothing else here is testing a stub.
 *
 * The two modes are not the same test and neither subsumes the other:
 *
 * - `throw-before` proves the publish is **rolled back** by a failing enqueue — spec §9 step 8's
 *   "committed with it", from the direction where the job never exists.
 * - `throw-after` proves the enqueue is **inside** the caller's transaction. A rollback test
 *   cannot see that: `db.gitJob.createMany` on a second connection would satisfy `throw-before`
 *   exactly as well, commit its row independently, and leave a job for a version that never
 *   existed. This is the mutant the brief names — an enqueue on `db` inside a `$transaction`.
 */
const forced = vi.hoisted(() => ({ mode: "pass" as "pass" | "throw-before" | "throw-after" }));

vi.mock("@/lib/git/enqueue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git/enqueue")>();
  return {
    ...actual,
    enqueueMirrorJobs: async (
      ...args: Parameters<typeof actual.enqueueMirrorJobs>
    ): Promise<number> => {
      if (forced.mode === "throw-before") throw new Error("forced enqueue failure (before)");
      const written = await actual.enqueueMirrorJobs(...args);
      if (forced.mode === "throw-after") throw new Error("forced enqueue failure (after)");
      return written;
    },
  };
});

beforeEach(async () => {
  forced.mode = "pass";
  await resetDb();
});

/**
 * One space, one tree, nothing published.
 *
 * Every field gets a value nothing else shares — `slug`, `path` and `title` are all
 * distinguishable, so swapping one for another in the implementation is visible. The tree
 * carries `architecture/mqtt-contracts-v2` beside `architecture/mqtt-contracts` for the reason
 * every other subtree fixture in this project does: it is a path *prefix* that is not a path
 * boundary, so a job set that includes it is a boundary bug rather than a mirror bug.
 *
 * Pages start **unpublished** and each test says which ones have a mirrored file. That is the
 * discrimination this task's central decision needs — a fixture where everything is published
 * cannot fail either way.
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

  const page = async (parent: { id: string; path: string } | null, slug: string, title: string) =>
    db.page.create({
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

  const architecture = await page(null, "architecture", "Architecture notes");
  const mqtt = await page(architecture, "mqtt-contracts", "MQTT contracts");
  const registry = await page(mqtt, "topic-registry", "Topic registry");
  const scratch = await page(mqtt, "scratch-notes", "Scratch notes, never published");
  const mqttV2 = await page(architecture, "mqtt-contracts-v2", "MQTT contracts, second cut");
  const platform = await page(null, "platform", "Platform group");

  /**
   * Points a page at a real published version **without** going through `publishPage`, so a
   * test can set up "this page has a file in the mirror" without also queueing the job that
   * would have written it. Every job in such a test is one the mutation under test wrote.
   */
  const markPublished = async (pageId: string, title: string) => {
    const version = await db.pageVersion.create({
      data: {
        pageId,
        title,
        markdown: `# ${title}\n\nSeeded body.\n`,
        status: "CURRENT",
        authorId: aisyah.id,
      },
      select: { id: true },
    });
    await db.page.update({
      where: { id: pageId },
      data: {
        publishedVersionId: version.id,
        publishedAt: new Date("2026-08-20T09:00:00Z"),
        status: "CURRENT",
      },
    });
    return version.id;
  };

  /** The draft `publishPage` needs. */
  const withDraft = async (pageId: string, title: string, markdown: string) => {
    await db.pageDraft.create({
      data: { pageId, title, markdown, updatedById: aisyah.id },
    });
  };

  const viewer: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    // ADMIN, because one fixture has to satisfy `PUBLISH`, `EDIT` and `MANAGE_SPACE`.
    memberships: [{ spaceId: space.id, role: "ADMIN" }],
  };

  const names = new Map<string, string>([
    [architecture.id, "architecture"],
    [mqtt.id, "mqtt-contracts"],
    [registry.id, "topic-registry"],
    [scratch.id, "scratch-notes"],
    [mqttV2.id, "mqtt-contracts-v2"],
    [platform.id, "platform"],
  ]);

  return {
    aisyah,
    space,
    viewer,
    architecture,
    mqtt,
    registry,
    scratch,
    mqttV2,
    platform,
    markPublished,
    withDraft,
    names,
  };
}

type JobRow = {
  id: number;
  kind: GitJobKind;
  state: string;
  pageId: string;
  versionId: string | null;
  spaceKey: string;
  path: string;
  fromPath: string | null;
  attempts: number;
};

/** Every queued job, in the sequence's order — which is the order the drain will use. */
const jobs = (): Promise<JobRow[]> =>
  db.gitJob.findMany({
    orderBy: { id: "asc" },
    // Explicit select, never `include`.
    select: {
      id: true,
      kind: true,
      state: true,
      pageId: true,
      versionId: true,
      spaceKey: true,
      path: true,
      fromPath: true,
      attempts: true,
    },
  });

/**
 * The set of *addresses* a batch of jobs carries: which page, from where, to where.
 *
 * A **set**, and not a count, because a count cannot tell one job per moved file from the same
 * file queued twice, and it cannot see a `fromPath` at all — which is the one column that
 * becomes unreconstructible the moment the move commits. Page names rather than ids so a failure
 * reads.
 */
const addresses = (rows: JobRow[], names: Map<string, string>): Set<string> =>
  new Set(
    rows.map(
      (row) =>
        `${names.get(row.pageId) ?? row.pageId}: ${row.fromPath ?? "(no from)"} -> ${row.path}`,
    ),
  );

test("a publish enqueues one job, carrying the address and the version it published", async () => {
  const f = await fixture();
  await f.withDraft(f.mqtt.id, "MQTT contracts", "# Topics\n\nNamespaced by outlet.\n");

  const result = await publishPage(f.viewer, f.mqtt.id);
  if (!result.ok) throw new Error(`expected a publish, got ${JSON.stringify(result)}`);

  const queued = await jobs();
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    kind: "PUBLISH",
    state: "PENDING",
    pageId: f.mqtt.id,
    // The version this publish wrote — the bytes the mirror owes, not whatever
    // `Page.publishedVersionId` says at drain time.
    versionId: result.page.versionId,
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    // A `MOVE`'s column.
    fromPath: null,
    attempts: 0,
  });
});

test("a later move leaves the earlier publish job at the path it was published at", async () => {
  // The property `GitJob`'s captured columns exist for, and the one a test that asserts only
  // "a job was created" cannot see. If the worker were to read `Page.path` at drain time — or if
  // this enqueue joined it — the publish would write its file at the *new* path and the move's
  // own job would then rename a path that never existed: a correctly ordered queue producing a
  // wrong tree, with nothing anywhere reporting an error.
  const f = await fixture();
  await f.withDraft(f.mqtt.id, "MQTT contracts", "# Topics\n\nNamespaced by outlet.\n");

  const published = await publishPage(f.viewer, f.mqtt.id);
  if (!published.ok) throw new Error(`expected a publish, got ${JSON.stringify(published)}`);

  const moved = await movePage(f.viewer, f.mqtt.id, {
    newParentId: f.platform.id,
    newSlug: "mqtt-contracts",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);

  // The page really did move, so the "old path" below is genuinely stale data.
  const after = await db.page.findUniqueOrThrow({
    where: { id: f.mqtt.id },
    select: { path: true },
  });
  expect(after.path).toBe("platform/mqtt-contracts");

  const queued = await jobs();
  expect(queued.map((row) => row.kind)).toEqual(["PUBLISH", "MOVE"]);
  expect(queued[0]).toMatchObject({
    kind: "PUBLISH",
    path: "architecture/mqtt-contracts",
    fromPath: null,
  });
  expect(queued[1]).toMatchObject({
    kind: "MOVE",
    fromPath: "architecture/mqtt-contracts",
    path: "platform/mqtt-contracts",
    // A `git mv` writes no document, so there are no bytes to name.
    versionId: null,
  });
});

test("a forced enqueue failure rolls the whole publish back", async () => {
  // Spec §9 step 8 is "committed with it", so a published version with no queued job is a state
  // this system cannot reach. Nothing in `publishPage` catches this: the enqueue's failure takes
  // the version, the page pointer, the draft deletion and the audit row with it.
  const f = await fixture();
  await f.withDraft(f.mqtt.id, "MQTT contracts", "# Topics\n\nNamespaced by outlet.\n");

  forced.mode = "throw-before";
  await expect(publishPage(f.viewer, f.mqtt.id)).rejects.toThrow(/forced enqueue failure/);

  const page = await db.page.findUniqueOrThrow({
    where: { id: f.mqtt.id },
    select: { publishedVersionId: true, publishedAt: true, status: true },
  });
  expect(page.publishedVersionId).toBeNull();
  expect(page.publishedAt).toBeNull();
  expect(page.status).toBe("DRAFT");
  expect(await db.pageVersion.count({ where: { pageId: f.mqtt.id } })).toBe(0);
  expect(await db.gitJob.count()).toBe(0);
  expect(await db.auditLog.count({ where: { pageId: f.mqtt.id } })).toBe(0);

  // The draft is intact — the thing a rolled-back publish must not have consumed.
  const draft = await db.pageDraft.findUnique({
    where: { pageId: f.mqtt.id },
    select: { title: true, markdown: true },
  });
  expect(draft).toEqual({
    title: "MQTT contracts",
    markdown: "# Topics\n\nNamespaced by outlet.\n",
  });

  // The non-vacuity companion: the same publish, with nothing forced, does all of it.
  forced.mode = "pass";
  const result = await publishPage(f.viewer, f.mqtt.id);
  expect(result.ok).toBe(true);
  expect(await db.gitJob.count()).toBe(1);
});

test("a failure after the enqueue leaves no job — the row is written on the caller's transaction", async () => {
  // The mutant this kills is `db.gitJob.createMany` in place of `tx.gitJob.createMany`. It runs
  // on a second connection, commits independently, and passes the rollback test above
  // identically — the job never exists there because the enqueue never ran. Here the enqueue
  // *does* run and the publish then fails, so an independently committed row survives and this
  // assertion is the only thing in the suite that notices.
  const f = await fixture();
  await f.withDraft(f.mqtt.id, "MQTT contracts", "# Topics\n\nNamespaced by outlet.\n");

  forced.mode = "throw-after";
  await expect(publishPage(f.viewer, f.mqtt.id)).rejects.toThrow(/forced enqueue failure/);

  expect(await db.gitJob.count()).toBe(0);
  expect(await db.pageVersion.count({ where: { pageId: f.mqtt.id } })).toBe(0);
});

test("a failure after a restore's enqueue leaves the restore undone and no job behind", async () => {
  // The same `tx`-not-`db` property, on the mutation where it is **not** loud on its own.
  //
  // Measured while mutation-testing this task: replacing `tx.gitJob.createMany` with
  // `db.gitJob.createMany` makes the publish and move tests above time out rather than fail, and
  // the reason is a lock rather than the assertion — the second connection's foreign-key check
  // waits on the uncommitted `PageVersion` row, and on the `Page` row a move has locked `FOR
  // UPDATE` because `(spaceId, path)` is a unique index. Delete and restore update only
  // `deletedAt`, which is in no unique index, so they take `FOR NO KEY UPDATE`, the key-share
  // check does not conflict, and the mutant commits its row **silently** and passes every other
  // test in this file. This is the assertion that sees it.
  const f = await fixture();
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");

  const deleted = await deletePage(f.viewer, f.mqtt.id);
  if (!deleted.ok) throw new Error(`expected a delete, got ${JSON.stringify(deleted)}`);
  const afterDelete = await jobs();
  expect(afterDelete.map((row) => row.kind)).toEqual(["DELETE", "DELETE"]);

  forced.mode = "throw-after";
  await expect(restorePage(f.viewer, f.mqtt.id)).rejects.toThrow(/forced enqueue failure/);

  // The delete's own jobs are untouched, which is what makes "no RESTORE job" an observation
  // about this transaction rather than about an empty table.
  expect(await jobs()).toEqual(afterDelete);
  const page = await db.page.findUniqueOrThrow({
    where: { id: f.mqtt.id },
    select: { deletedAt: true },
  });
  expect(page.deletedAt).not.toBeNull();
});

test("a subtree move enqueues one job per moved file, each carrying its own old path", async () => {
  const f = await fixture();
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");
  await f.markPublished(f.scratch.id, "Scratch notes");
  // The prefix that is not a path boundary. Published, so its absence below is a boundary
  // answer and not "it had no file".
  await f.markPublished(f.mqttV2.id, "MQTT contracts, second cut");

  const moved = await movePage(f.viewer, f.mqtt.id, {
    newParentId: f.platform.id,
    newSlug: "mqtt-contracts",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);
  expect(moved.page.rewritten).toBe(3);

  const queued = await jobs();
  expect(new Set(queued.map((row) => row.kind))).toEqual(new Set(["MOVE"]));
  // A set, not a count: three jobs with the right *number* and the wrong `fromPath` is exactly
  // the failure a count cannot see, and it is the column nothing can reconstruct afterwards.
  expect(addresses(queued, f.names)).toEqual(
    new Set([
      "mqtt-contracts: architecture/mqtt-contracts -> platform/mqtt-contracts",
      "topic-registry: architecture/mqtt-contracts/topic-registry -> platform/mqtt-contracts/topic-registry",
      "scratch-notes: architecture/mqtt-contracts/scratch-notes -> platform/mqtt-contracts/scratch-notes",
    ]),
  );
  expect(queued.every((row) => row.spaceKey === "engineering")).toBe(true);
});

test("a mixed subtree rewrites three rows and enqueues two jobs: a page never published has no file to move", async () => {
  // **The test that separates this task's decision from its alternative.** A design that
  // enqueued a job the worker no-ops on would produce three jobs here and pass every other
  // assertion in this file; this one fails under it, by naming the set rather than counting it.
  const f = await fixture();
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");
  // `scratch-notes` stays unpublished: it has a row, a path and no mirrored file.

  const moved = await movePage(f.viewer, f.mqtt.id, {
    newParentId: f.platform.id,
    newSlug: "mqtt-contracts",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);

  // Three rows moved — the mirror question is not the same question as the rewrite.
  expect(moved.page.rewritten).toBe(3);
  const scratch = await db.page.findUniqueOrThrow({
    where: { id: f.scratch.id },
    select: { path: true },
  });
  expect(scratch.path).toBe("platform/mqtt-contracts/scratch-notes");

  const queued = await jobs();
  expect(addresses(queued, f.names)).toEqual(
    new Set([
      "mqtt-contracts: architecture/mqtt-contracts -> platform/mqtt-contracts",
      "topic-registry: architecture/mqtt-contracts/topic-registry -> platform/mqtt-contracts/topic-registry",
    ]),
  );
  expect(queued.some((row) => row.pageId === f.scratch.id)).toBe(false);
});

test("a delete enqueues one removal per file it took, and nothing for a page never published", async () => {
  const f = await fixture();
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");
  await f.markPublished(f.mqttV2.id, "MQTT contracts, second cut");
  // `scratch-notes` unpublished again — the non-vacuity companion is `topic-registry`, its
  // published sibling in the same subtree, which does enqueue.

  const deleted = await deletePage(f.viewer, f.mqtt.id);
  if (!deleted.ok) throw new Error(`expected a delete, got ${JSON.stringify(deleted)}`);
  expect(deleted.page.deleted).toBe(3);

  const queued = await jobs();
  expect(new Set(queued.map((row) => row.kind))).toEqual(new Set(["DELETE"]));
  expect(addresses(queued, f.names)).toEqual(
    new Set([
      "mqtt-contracts: (no from) -> architecture/mqtt-contracts",
      "topic-registry: (no from) -> architecture/mqtt-contracts/topic-registry",
    ]),
  );
  // A `git rm` reads no document.
  expect(queued.every((row) => row.versionId === null)).toBe(true);
});

test("a restore re-adds exactly the files its delete removed, naming the version to write", async () => {
  const f = await fixture();
  const mqttVersion = await f.markPublished(f.mqtt.id, "MQTT contracts");
  const registryVersion = await f.markPublished(f.registry.id, "Topic registry");

  const deleted = await deletePage(f.viewer, f.mqtt.id);
  if (!deleted.ok) throw new Error(`expected a delete, got ${JSON.stringify(deleted)}`);

  const restored = await restorePage(f.viewer, f.mqtt.id);
  if (!restored.ok) throw new Error(`expected a restore, got ${JSON.stringify(restored)}`);
  expect(restored.page.restored).toBe(3);

  const queued = await jobs();
  expect(queued.map((row) => row.kind)).toEqual(["DELETE", "DELETE", "RESTORE", "RESTORE"]);

  const restoreJobs = queued.filter((row) => row.kind === "RESTORE");
  expect(addresses(restoreJobs, f.names)).toEqual(
    new Set([
      "mqtt-contracts: (no from) -> architecture/mqtt-contracts",
      "topic-registry: (no from) -> architecture/mqtt-contracts/topic-registry",
    ]),
  );
  // A restore writes bytes, so it names the version to write them from — and it is the version
  // the page had all along, because a restore authors none.
  expect(
    new Map(restoreJobs.map((row) => [row.pageId, row.versionId])),
  ).toEqual(
    new Map([
      [f.mqtt.id, mqttVersion],
      [f.registry.id, registryVersion],
    ]),
  );
  // Never-published `scratch-notes` came back with the subtree and owes the mirror nothing.
  expect(queued.some((row) => row.pageId === f.scratch.id)).toBe(false);
});

test("a subtree moved while deleted enqueues nothing, and its restore writes the file where the page now is", async () => {
  // The case that decides `movePage`'s soft-delete filter. The deleted rows' files are already
  // gone, so a `git mv` would fail on a path the tree does not contain; the restore is what puts
  // them back, and it must put them back at the page's *current* address.
  const f = await fixture();
  await f.markPublished(f.architecture.id, "Architecture notes");
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");

  const deleted = await deletePage(f.viewer, f.mqtt.id);
  if (!deleted.ok) throw new Error(`expected a delete, got ${JSON.stringify(deleted)}`);
  await db.gitJob.deleteMany({});

  // The still-live ancestor moves, dragging the deleted subtree's paths with it.
  const moved = await movePage(f.viewer, f.architecture.id, {
    newParentId: f.platform.id,
    newSlug: "architecture",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);
  expect(moved.page.rewritten).toBe(5);

  const afterMove = await jobs();
  // The live published ancestor is the non-vacuity companion: the filter is "these rows have no
  // file", not "moves do not enqueue".
  expect(addresses(afterMove, f.names)).toEqual(
    new Set(["architecture: architecture -> platform/architecture"]),
  );

  const restored = await restorePage(f.viewer, f.mqtt.id);
  if (!restored.ok) throw new Error(`expected a restore, got ${JSON.stringify(restored)}`);

  const restoreJobs = (await jobs()).filter((row) => row.kind === "RESTORE");
  expect(addresses(restoreJobs, f.names)).toEqual(
    new Set([
      "mqtt-contracts: (no from) -> platform/architecture/mqtt-contracts",
      "topic-registry: (no from) -> platform/architecture/mqtt-contracts/topic-registry",
    ]),
  );
});

test("jobs for one page are written in enqueue order, and the sequence is that order", async () => {
  // Task 3's decision, exercised from the writing side: `createdAt` cannot order these rows —
  // one `createMany` writes byte-identical values — so `id` is the order, and nothing here adds
  // a tiebreak of its own.
  const f = await fixture();
  await f.withDraft(f.mqtt.id, "MQTT contracts", "# Topics\n\nNamespaced by outlet.\n");

  const published = await publishPage(f.viewer, f.mqtt.id);
  if (!published.ok) throw new Error(`expected a publish, got ${JSON.stringify(published)}`);
  const moved = await movePage(f.viewer, f.mqtt.id, {
    newParentId: f.platform.id,
    newSlug: "mqtt-contracts",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);
  const deleted = await deletePage(f.viewer, f.mqtt.id);
  if (!deleted.ok) throw new Error(`expected a delete, got ${JSON.stringify(deleted)}`);

  const queued = await jobs();
  expect(queued.map((row) => row.kind)).toEqual(["PUBLISH", "MOVE", "DELETE"]);
  expect(queued.map((row) => row.id)).toEqual([...queued.map((row) => row.id)].sort((a, b) => a - b));
  expect(new Set(queued.map((row) => row.id)).size).toBe(3);
});

test("a subtree move writes its rows in one statement, so their createdAt cannot order them", async () => {
  // The measurement Task 3 built the schema around, re-asserted where it is produced rather
  // than only recorded in a comment: a `createMany` binds one client-side `createdAt` for every
  // row. If this ever stops being true the schema's argument still holds — `id` is the order —
  // but the sentence in it would have gone stale, and a stale measurement is one this project
  // has been bitten by before.
  const f = await fixture();
  await f.markPublished(f.mqtt.id, "MQTT contracts");
  await f.markPublished(f.registry.id, "Topic registry");

  const moved = await movePage(f.viewer, f.mqtt.id, {
    newParentId: f.platform.id,
    newSlug: "mqtt-contracts",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);

  const rows = await db.gitJob.findMany({
    orderBy: { id: "asc" },
    select: { id: true, createdAt: true },
  });
  expect(rows).toHaveLength(2);
  expect(rows[0]!.createdAt.getTime()).toBe(rows[1]!.createdAt.getTime());
  expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
});
