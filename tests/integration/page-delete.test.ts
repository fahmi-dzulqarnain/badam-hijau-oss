import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  deletePage,
  listDeletedPages,
  restorePage,
  type DeleteResult,
  type RestoreResult,
} from "@/lib/pages/delete";
import {
  getPublishedPage,
  listRecentlyPublished,
  listSpacePages,
  resolveRedirect,
} from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { summariseModules } from "@/lib/spaces/landing";
import { childPath } from "@/lib/pages/slug";
import type { Prisma } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The tree every test starts from — the same shape `page-move.test.ts` uses, for the same
 * reasons: a three-deep branch so a subtree delete is visible at depth, and
 * `architecture/mqtt-contracts-v2` — a prefix of `architecture/mqtt-contracts` that is not a
 * path boundary — sitting beside the page most tests delete.
 *
 * `architecture`, `architecture/mqtt-contracts` and `architecture/mqtt-contracts/topic-registry`
 * are published; `mqtt-contracts-v2` deliberately is not, so the landing page's two counters
 * (`pageCount` and `draftCount`) both have something to lose.
 *
 * Every field gets a value nothing else shares: `slug`, `path` and `title` are all
 * distinguishable, so swapping one for another in the implementation is visible.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const dara = await db.user.create({ data: { email: "dara@example.com", name: "Dara M." } });
  // A real row, because a restore writes an `AuditLog` and `actorId` is a foreign key — a
  // synthetic super admin passes every permission check and then fails on the audit insert.
  const root = await db.user.create({
    data: { email: "root@example.com", name: "Root", isSuperAdmin: true },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const other = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });

  const page = async (
    parent: { id: string; path: string } | null,
    slug: string,
    title: string,
    spaceId = space.id,
  ) =>
    db.page.create({
      data: {
        spaceId,
        parentId: parent?.id ?? null,
        slug,
        path: childPath(parent?.path ?? null, slug),
        title,
        createdById: aisyah.id,
        status: "CURRENT",
      },
      select: { id: true, path: true, slug: true, parentId: true },
    });

  const architecture = await page(null, "architecture", "Architecture notes");
  const mqtt = await page(architecture, "mqtt-contracts", "MQTT contracts");
  const registry = await page(mqtt, "topic-registry", "Topic registry");
  const mqttV2 = await page(architecture, "mqtt-contracts-v2", "MQTT contracts, second cut");
  const platform = await page(null, "platform", "Platform group");
  const decisions = await page(null, "decisions", "Decision log");
  const adr = await page(decisions, "adr-0042", "MQTT topic naming");
  const handbookWelcome = await page(null, "welcome", "Welcome aboard", other.id);

  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: dara.id, role: "ADMIN" },
  });

  /** Points a page at a real published version, so the reader's own query can find it. */
  const publish = async (pageId: string, title: string, markdown: string, minute: number) => {
    const version = await db.pageVersion.create({
      data: { pageId, title, markdown, status: "CURRENT", authorId: aisyah.id },
      select: { id: true },
    });
    await db.page.update({
      where: { id: pageId },
      data: {
        publishedVersionId: version.id,
        publishedAt: new Date(Date.UTC(2026, 7, 20, 9, minute)),
      },
    });
    return version.id;
  };

  await publish(architecture.id, "Architecture notes", "# Architecture\n", 0);
  await publish(mqtt.id, "MQTT contracts", "# Contracts\n", 1);
  await publish(registry.id, "Topic registry", "# Topics\n\nNamespaced by outlet.\n", 2);

  const asRole = (id: string, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    other,
    aisyah,
    dara,
    root,
    asSuperAdmin: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    architecture,
    mqtt,
    registry,
    mqttV2,
    platform,
    decisions,
    adr,
    handbookWelcome,
    publish,
    asAisyah: asRole(aisyah.id, "EDITOR"),
    asDara: asRole(dara.id, "ADMIN"),
    asViewer: asRole(aisyah.id, "VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Narrows to the success branch, failing with the actual result if it is not one. */
function deleted(result: DeleteResult) {
  if (!result.ok) throw new Error(`expected a delete, got ${JSON.stringify(result)}`);
  return result.page;
}

function restored(result: RestoreResult) {
  if (!result.ok) throw new Error(`expected a restore, got ${JSON.stringify(result)}`);
  return result.page;
}

/** Narrows to a restore rejection, failing with the actual result if it is not one. */
function refusal(result: RestoreResult) {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** Which pages are live, by path, in a stable order. */
async function livePaths(spaceId: string) {
  const rows = await db.page.findMany({
    where: { spaceId, deletedAt: null },
    orderBy: { path: "asc" },
    select: { path: true },
  });
  return rows.map((row) => row.path);
}

/** Everything a delete or a restore would change, for "nothing was written" assertions. */
async function snapshot(spaceId: string) {
  return {
    rows: (
      await db.page.findMany({
        where: { spaceId },
        orderBy: { path: "asc" },
        select: { path: true, slug: true, parentId: true, deletedAt: true },
      })
    ).map((r) => `${r.path} ${r.slug} ${r.parentId ?? "-"} ${r.deletedAt?.toISOString() ?? "-"}`),
    redirects: (
      await db.redirect.findMany({
        where: { spaceId },
        orderBy: { fromPath: "asc" },
        select: { fromPath: true, toPageId: true },
      })
    ).map((r) => `${r.fromPath} -> ${r.toPageId}`),
    audits: await db.auditLog.count({ where: { spaceId } }),
    drafts: await db.pageDraft.count({ where: { page: { spaceId } } }),
  };
}

/** The nav rail's own query and tree builder, flattened to paths in rail order. */
async function railPaths(viewer: Viewer, spaceId: string) {
  const flatten = (nodes: ReturnType<typeof buildTree>): string[] =>
    nodes.flatMap((node) => [node.path, ...flatten(node.children)]);
  return flatten(buildTree(await listSpacePages(viewer, spaceId)));
}

/** The space landing's module summaries, keyed by title. */
async function landingCounts(viewer: Viewer, spaceId: string) {
  const modules = summariseModules(buildTree(await listSpacePages(viewer, spaceId)));
  return Object.fromEntries(
    modules.map((m) => [m.title, { pages: m.pageCount, drafts: m.draftCount }]),
  );
}

/** Waits are only ever used to stage an interleaving; nothing is asserted about them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/**
 * Runs one statement inside an interactive transaction and holds it open — the only way to sit
 * between another writer's statement and its `COMMIT`, and so the only way to prove that
 * something else blocks.
 *
 * **`finish()` goes in a `finally`.** A staged interleaving whose release is skipped by a failed
 * assertion leaves an uncommitted transaction holding locks, the next test's `TRUNCATE` waits on
 * it, and one real failure arrives buried under a page of unrelated hook timeouts. `finish()` is
 * idempotent and never rejects.
 */
function holdOpen(open: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.$transaction(
    async (tx) => {
      await open(tx);
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
  return {
    finish: async () => {
      release();
      await Promise.allSettled([holder]);
    },
  };
}

// ---------------------------------------------------------------------------------------
// The subtree
// ---------------------------------------------------------------------------------------

/**
 * The whole point of the module. A child left visible under a deleted parent is reachable at
 * its URL with a breadcrumb through a 404, and `buildTree` promotes a node whose parent is
 * missing from the result set to a **root** — so `topic-registry` would not merely linger, it
 * would reappear as a top-level module on the space landing.
 *
 * Kills dropping the `LIKE` clause from the subtree statement, in the only way that matters:
 * the child survives.
 */
test("deleting a page takes its whole subtree with it", async () => {
  const f = await fixture();

  const result = deleted(await deletePage(f.asAisyah, f.mqtt.id));
  expect(result.path).toBe("architecture/mqtt-contracts");
  expect(result.deleted).toBe(2);
  expect(result.spaceKey).toBe("engineering");

  const rows = await db.page.findMany({
    where: { id: { in: [f.mqtt.id, f.registry.id] } },
    select: { id: true, deletedAt: true },
  });
  for (const row of rows) expect(row.deletedAt, `${row.id} is deleted`).not.toBeNull();

  // One stamp for the whole subtree — the key `restorePage` matches on.
  expect(rows[0]!.deletedAt!.getTime()).toBe(rows[1]!.deletedAt!.getTime());

  expect(await livePaths(f.space.id)).toEqual([
    "architecture",
    "architecture/mqtt-contracts-v2",
    "decisions",
    "decisions/adr-0042",
    "platform",
  ]);
});

/**
 * **The stamp must be a real UTC instant, and this test exists because it was not.**
 *
 * Prisma maps `DateTime` to `TIMESTAMP(3)` — *without* time zone — and does the UTC conversion
 * itself on the way in and out. A raw statement bypasses that: Prisma binds a JavaScript `Date`
 * as a `timestamptz`, and assigning a `timestamptz` to a `timestamp` column converts it to the
 * **session** time zone. Measured on this machine (`Asia/Kuala_Lumpur`): a stamp written at
 * `07:00Z` came back from Prisma as `15:00Z`, eight hours in the future, with every test still
 * green — because the restore compares the stored value against itself and never against a
 * clock.
 *
 * Kills dropping `AT TIME ZONE 'UTC'` from the delete statement. Nothing else can: the whole
 * delete/restore round trip is internally consistent with the wrong value in it, and only a
 * comparison against the real clock notices.
 */
test("the stored deletedAt is the real wall clock, not the session's", async () => {
  const f = await fixture();
  const before = Date.now();

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  const row = await db.page.findUniqueOrThrow({
    where: { id: f.mqtt.id },
    select: { deletedAt: true },
  });
  const after = Date.now();
  expect(row.deletedAt!.getTime()).toBeGreaterThanOrEqual(before);
  expect(row.deletedAt!.getTime()).toBeLessThanOrEqual(after);
});

/**
 * The other side of the boundary rule. `architecture/mqtt-contracts-v2` is a prefix match and
 * not a path boundary, so it must survive. Kills replacing the `/`-boundary pattern with a bare
 * `LIKE 'prefix%'` in either the read or the statement — which would take an unrelated page and
 * its subtree down and write redirects for them.
 */
test("a sibling whose path is a prefix but not a boundary survives", async () => {
  const f = await fixture();
  const v2Child = await db.page.create({
    data: {
      spaceId: f.space.id,
      parentId: f.mqttV2.id,
      slug: "payload-shapes",
      path: "architecture/mqtt-contracts-v2/payload-shapes",
      title: "Payload shapes",
      createdById: f.aisyah.id,
    },
    select: { id: true },
  });

  expect(deleted(await deletePage(f.asAisyah, f.mqtt.id)).deleted).toBe(2);

  for (const id of [f.mqttV2.id, v2Child.id]) {
    expect((await db.page.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  }
  // And only the two deleted rows got a redirect.
  expect(
    (
      await db.redirect.findMany({
        where: { spaceId: f.space.id },
        orderBy: { fromPath: "asc" },
        select: { fromPath: true },
      })
    ).map((r) => r.fromPath),
  ).toEqual([
    "architecture/mqtt-contracts",
    "architecture/mqtt-contracts/topic-registry",
  ]);
});

/**
 * `%`, `_` and `\` are `LIKE` metacharacters and none can appear in a slug today — which is
 * exactly why the escaping is easy to skip and expensive to discover later. These rows are
 * inserted directly, below the slug rules, so the escaping is exercised now.
 *
 * Each character kills a different half. `_` unescaped is a single-character wildcard, so
 * deleting `probe/b_c` also matches `probe/bxc`; `%` matches any run; the escape character
 * itself, unescaped, consumes the `/` that follows it and the page's own child stops matching —
 * the under-match direction, which arrives silently rather than as an error.
 */
test("LIKE metacharacters in a path are literals, not wildcards", async () => {
  const f = await fixture();
  const raw = async (parentId: string | null, slug: string, path: string, title: string) =>
    db.page.create({
      data: { spaceId: f.space.id, parentId, slug, path, title, createdById: f.aisyah.id },
      select: { id: true, path: true },
    });

  const probe = await raw(null, "probe", "probe", "Probe root");
  const underscore = await raw(probe.id, "b_c", "probe/b_c", "Underscore sibling");
  const underscoreChild = await raw(underscore.id, "leaf", "probe/b_c/leaf", "Underscore leaf");
  const wildcardVictim = await raw(probe.id, "bxc", "probe/bxc", "Single-character victim");
  const percent = await raw(probe.id, "p%", "probe/p%", "Percent sibling");
  const percentVictim = await raw(probe.id, "pzz", "probe/pzz", "Percent victim");
  const percentVictimChild = await raw(
    percentVictim.id,
    "child",
    "probe/pzz/child",
    "Percent victim's child",
  );
  const backslash = await raw(probe.id, "back\\", "probe/back\\", "Backslash sibling");
  const backslashChild = await raw(
    backslash.id,
    "child",
    "probe/back\\/child",
    "Backslash child",
  );

  expect(deleted(await deletePage(f.asAisyah, underscore.id)).deleted).toBe(2);
  expect((await db.page.findUniqueOrThrow({ where: { id: underscoreChild.id } })).deletedAt)
    .not.toBeNull();
  expect((await db.page.findUniqueOrThrow({ where: { id: wildcardVictim.id } })).deletedAt)
    .toBeNull();

  expect(deleted(await deletePage(f.asAisyah, percent.id)).deleted).toBe(1);
  for (const id of [percentVictim.id, percentVictimChild.id]) {
    expect((await db.page.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  }

  // The under-match direction: the descendant must go down with its parent.
  expect(deleted(await deletePage(f.asAisyah, backslash.id)).deleted).toBe(2);
  expect((await db.page.findUniqueOrThrow({ where: { id: backslashChild.id } })).deletedAt)
    .not.toBeNull();
});

// ---------------------------------------------------------------------------------------
// What a reader sees
// ---------------------------------------------------------------------------------------

test("a deleted page 404s for everyone, including a super admin, and keeps its versions", async () => {
  const f = await fixture();
  const versionsBefore = await db.pageVersion.count({ where: { pageId: f.registry.id } });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  for (const viewer of [f.asAisyah, f.asDara, f.asSuperAdmin]) {
    expect(
      await getPublishedPage(viewer, {
        spaceKey: "engineering",
        path: "architecture/mqtt-contracts",
      }),
    ).toBeNull();
    expect(
      await getPublishedPage(viewer, {
        spaceKey: "engineering",
        path: "architecture/mqtt-contracts/topic-registry",
      }),
    ).toBeNull();
  }

  // Soft, not hard: the history is the reason the delete is soft at all.
  expect(await db.pageVersion.count({ where: { pageId: f.registry.id } })).toBe(versionsBefore);
  expect(await db.pageVersion.count({ where: { pageId: f.mqtt.id } })).toBe(1);
});

/**
 * **The rail and the landing counts are asserted separately, and that is deliberate.** The nav
 * rail is a tree walk and the landing counters are a recursive count over the same tree; a
 * change that fixes one and not the other is invisible from either assertion alone.
 * "Recently published" is a third answer, from its own query rather than from the tree at all.
 */
test("a deleted subtree disappears from the nav rail", async () => {
  const f = await fixture();
  expect(await railPaths(f.asAisyah, f.space.id)).toContain(
    "architecture/mqtt-contracts/topic-registry",
  );

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  expect(await railPaths(f.asAisyah, f.space.id)).toEqual([
    "architecture",
    "architecture/mqtt-contracts-v2",
    "decisions",
    "decisions/adr-0042",
    "platform",
  ]);
});

test("a deleted subtree disappears from the space landing counts", async () => {
  const f = await fixture();
  expect(await landingCounts(f.asAisyah, f.space.id)).toEqual({
    "Architecture notes": { pages: 2, drafts: 1 },
    "Decision log": { pages: 0, drafts: 1 },
    "Platform group": { pages: 0, drafts: 0 },
  });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  // Both counters move: `mqtt-contracts` and `topic-registry` are published descendants, so
  // "2 pages" becomes "0 pages" while the unpublished `mqtt-contracts-v2` draft stays.
  expect(await landingCounts(f.asAisyah, f.space.id)).toEqual({
    "Architecture notes": { pages: 0, drafts: 1 },
    "Decision log": { pages: 0, drafts: 1 },
    "Platform group": { pages: 0, drafts: 0 },
  });
});

test("a deleted page drops out of Recently published", async () => {
  const f = await fixture();
  expect(
    (await listRecentlyPublished(f.asAisyah, f.space.id)).map((p) => p.path),
  ).toEqual([
    "architecture/mqtt-contracts/topic-registry",
    "architecture/mqtt-contracts",
    "architecture",
  ]);

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  expect(
    (await listRecentlyPublished(f.asAisyah, f.space.id)).map((p) => p.path),
  ).toEqual(["architecture"]);
});

// ---------------------------------------------------------------------------------------
// Redirects, including the root-page case the plan does not cover
// ---------------------------------------------------------------------------------------

/**
 * One redirect per deleted row, all pointing at the **nearest surviving ancestor** rather than
 * at each row's own parent. A redirect from `…/topic-registry` to `…/mqtt-contracts` would be
 * inert the moment it was written — its target is being deleted in the same statement, and
 * `resolveRedirect` refuses to deliver anyone to a soft-deleted page.
 */
test("every deleted path redirects to the nearest surviving ancestor", async () => {
  const f = await fixture();

  const result = deleted(await deletePage(f.asAisyah, f.mqtt.id));
  expect(result.redirects).toBe(2);
  expect(result.redirectTo).toBe("architecture");

  expect(
    await db.redirect.findMany({
      where: { spaceId: f.space.id },
      orderBy: { fromPath: "asc" },
      select: { fromPath: true, toPageId: true },
    }),
  ).toEqual([
    { fromPath: "architecture/mqtt-contracts", toPageId: f.architecture.id },
    {
      fromPath: "architecture/mqtt-contracts/topic-registry",
      toPageId: f.architecture.id,
    },
  ]);

  // Through the reader's own resolver, which is what turns the row into a 308.
  for (const path of [
    "architecture/mqtt-contracts",
    "architecture/mqtt-contracts/topic-registry",
  ]) {
    expect(await resolveRedirect(f.asAisyah, { spaceKey: "engineering", path })).toEqual({
      pageId: f.architecture.id,
      path: "architecture",
    });
  }
});

/**
 * **The case the plan does not cover.** `Redirect.toPageId` is not nullable, so a deleted root
 * page has no target to point at — there is no `Page` row meaning "the space landing".
 *
 * The decision is to write **no redirect**, and to say so in the result rather than leave the
 * caller to infer it from a zero. The alternatives were to invent a target (a sibling root is
 * arbitrary, and a permanent redirect to an unrelated page is a worse answer than a 404, cached
 * by browsers and repeated by `resolveRedirect` forever) or to make `toPageId` nullable, which
 * grows a branch in every reader of `Redirect` for a case a plain 404 plus the space rail
 * already answers. Deliberately not taken in Phase 2.
 *
 * Kills a redirect written to an arbitrary page, and kills a crash on the null parent.
 */
test("deleting a root page writes no redirect, and its URL 404s", async () => {
  const f = await fixture();

  const result = deleted(await deletePage(f.asAisyah, f.decisions.id));
  expect(result.deleted).toBe(2);
  expect(result.redirects).toBe(0);
  expect(result.redirectTo).toBeNull();

  expect(await db.redirect.count({ where: { spaceId: f.space.id } })).toBe(0);
  for (const path of ["decisions", "decisions/adr-0042"]) {
    expect(await resolveRedirect(f.asAisyah, { spaceKey: "engineering", path })).toBeNull();
    expect(
      await getPublishedPage(f.asAisyah, { spaceKey: "engineering", path }),
    ).toBeNull();
  }
});

/**
 * A dormant `Redirect` can already stand at a path being deleted — shadowed by the live page
 * that is now going away — and `(spaceId, fromPath)` is unique. Task 10 hit exactly this on the
 * move's vacated paths and resolved it by deleting first; the newer redirect wins, because the
 * older one was unreachable for as long as the page sat on top of it.
 *
 * Kills inserting without the reclaiming `deleteMany`: the delete would die on a `P2002` about
 * a row the author never touched.
 */
test("a dormant redirect at a deleted path is replaced, not collided with", async () => {
  const f = await fixture();
  await db.redirect.create({
    data: {
      spaceId: f.space.id,
      fromPath: "architecture/mqtt-contracts",
      toPageId: f.adr.id,
    },
  });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  expect(
    (
      await db.redirect.findFirstOrThrow({
        where: { spaceId: f.space.id, fromPath: "architecture/mqtt-contracts" },
        select: { toPageId: true },
      })
    ).toPageId,
  ).toBe(f.architecture.id);
});

/**
 * Redirects pointing **at** a deleted page are left standing and go inert on their own, because
 * `resolveRedirect` refuses a soft-deleted target. That is the half of the soft delete that
 * makes an old link start working again the moment the page comes back.
 */
test("a redirect to a deleted page goes inert and revives on restore", async () => {
  const f = await fixture();
  await db.redirect.create({
    data: { spaceId: f.space.id, fromPath: "old/mqtt", toPageId: f.mqtt.id },
  });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  expect(
    await resolveRedirect(f.asAisyah, { spaceKey: "engineering", path: "old/mqtt" }),
  ).toBeNull();

  restored(await restorePage(f.asDara, f.mqtt.id));
  expect(
    await resolveRedirect(f.asAisyah, { spaceKey: "engineering", path: "old/mqtt" }),
  ).toEqual({ pageId: f.mqtt.id, path: "architecture/mqtt-contracts" });
});

// ---------------------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------------------

test("restore brings back the whole subtree, where it was", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const result = restored(await restorePage(f.asDara, f.mqtt.id));

  expect(result.restored).toBe(2);
  expect(result.path).toBe("architecture/mqtt-contracts");

  expect(await railPaths(f.asAisyah, f.space.id)).toEqual([
    "architecture",
    "architecture/mqtt-contracts",
    "architecture/mqtt-contracts/topic-registry",
    "architecture/mqtt-contracts-v2",
    "decisions",
    "decisions/adr-0042",
    "platform",
  ]);
  expect(await landingCounts(f.asAisyah, f.space.id)).toEqual({
    "Architecture notes": { pages: 2, drafts: 1 },
    "Decision log": { pages: 0, drafts: 1 },
    "Platform group": { pages: 0, drafts: 0 },
  });

  // Readable again at exactly the path it had, with the version it was published from.
  const read = await getPublishedPage(f.asAisyah, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts/topic-registry",
  });
  expect(read?.version.markdown).toContain("Namespaced by outlet");

  // The rows are byte-identical to before the delete apart from the two audit rows: same
  // paths, same parents, same slugs, no `deletedAt`, and the redirects the delete wrote have
  // been reclaimed.
  const after = await snapshot(f.space.id);
  expect(after.rows).toEqual(before.rows);
  expect(after.redirects).toEqual(before.redirects);
  expect(after.audits).toBe(2);
});

/**
 * The reclaim, and it is not cosmetic. `deletePage` wrote a redirect from every deleted path to
 * the surviving ancestor; restore makes those paths live again. The reader consults
 * `resolveRedirect` **only after the page read misses**, and an unpublished page always misses
 * — so a restored draft's URL would 308 up to its parent instead of 404ing.
 *
 * Kills dropping the reclaiming `deleteMany` from `restorePage`.
 */
test("restore clears the redirects standing at the paths it makes live", async () => {
  const f = await fixture();
  // Unpublished, so the reader's page read misses and the redirect lookup is reached.
  await db.page.update({
    where: { id: f.mqtt.id },
    data: { publishedVersionId: null, publishedAt: null },
  });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const result = restored(await restorePage(f.asDara, f.mqtt.id));

  expect(result.redirectsCleared).toBe(2);
  expect(await db.redirect.count({ where: { spaceId: f.space.id } })).toBe(0);
  expect(
    await resolveRedirect(f.asAisyah, {
      spaceKey: "engineering",
      path: "architecture/mqtt-contracts",
    }),
  ).toBeNull();
});

/**
 * **Restore undoes one delete, not everything ever deleted under here.** `deletePage` skips
 * rows that already carry a `deletedAt` and stamps the rest with one value; restore matches
 * that value. So a page somebody deliberately removed from a section months ago is not
 * resurrected by an admin restoring the section.
 *
 * Kills restoring the whole subtree unconditionally, and kills stamping over an existing
 * `deletedAt` in the delete statement — either mutation brings `topic-registry` back.
 */
test("a descendant deleted earlier and separately is not restored with the subtree", async () => {
  const f = await fixture();

  deleted(await deletePage(f.asAisyah, f.registry.id));
  const earlier = (await db.page.findUniqueOrThrow({ where: { id: f.registry.id } })).deletedAt;

  const parentDelete = deleted(await deletePage(f.asAisyah, f.mqtt.id));
  // Only the parent: the descendant was already gone.
  expect(parentDelete.deleted).toBe(1);
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.registry.id } })).deletedAt,
  ).toEqual(earlier);

  const result = restored(await restorePage(f.asDara, f.mqtt.id));
  expect(result.restored).toBe(1);
  expect((await db.page.findUniqueOrThrow({ where: { id: f.mqtt.id } })).deletedAt).toBeNull();
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.registry.id } })).deletedAt,
  ).toEqual(earlier);

  // And that page can still be restored on its own, now that its parent is live again.
  restored(await restorePage(f.asDara, f.registry.id));
  expect(await railPaths(f.asAisyah, f.space.id)).toContain(
    "architecture/mqtt-contracts/topic-registry",
  );
});

/**
 * **The restore that can actually fail, and it is not the plan's.**
 *
 * Restoring a descendant while its ancestor is still deleted puts the page back at a URL whose
 * parent 404s, and `buildTree` promotes a node whose parent is missing from the result set to a
 * **root** — so `topic-registry` would appear on the space landing as a top-level module.
 * Refused, naming the shallowest deleted ancestor, because that is the page the admin has to
 * restore first.
 *
 * Kills dropping the ancestor check. Nothing is written.
 */
test("restoring under a still-deleted ancestor is refused, and changes nothing", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const before = await snapshot(f.space.id);

  const error = refusal(await restorePage(f.asDara, f.registry.id));
  expect(error.code).toBe("ancestor-deleted");
  expect(error.message).toContain("MQTT contracts");
  expect(error.message).toContain("architecture/mqtt-contracts");

  expect(await snapshot(f.space.id)).toEqual(before);
  // Restoring the ancestor is what brings both back, which is what the message says.
  expect(restored(await restorePage(f.asDara, f.mqtt.id)).restored).toBe(2);
});

test("restoring a page that is not deleted says so rather than reporting a miss", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const error = refusal(await restorePage(f.asDara, f.mqtt.id));
  expect(error.code).toBe("not-deleted");
  expect(error.message).toContain("MQTT contracts");
  expect(await snapshot(f.space.id)).toEqual(before);
});

/**
 * Restore puts the page back **under its parent**, which is the only version of "where it was"
 * that survives the parent moving. Task 10 rewrites soft-deleted descendants along with the
 * subtree precisely so that this holds: the deleted row's path follows its ancestors, and
 * restore lands it where the tree now says it belongs rather than at the literal string it held
 * when it was deleted.
 */
test("a subtree deleted and then moved by an ancestor comes back at its new home", async () => {
  const f = await fixture();
  const { movePage } = await import("@/lib/pages/move");

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const move = await movePage(f.asAisyah, f.architecture.id, {
    newParentId: f.platform.id,
    newSlug: "architecture",
  });
  if (!move.ok) throw new Error(`expected a move, got ${JSON.stringify(move)}`);

  const result = restored(await restorePage(f.asDara, f.mqtt.id));
  expect(result.path).toBe("platform/architecture/mqtt-contracts");
  expect(result.restored).toBe(2);

  expect(await railPaths(f.asAisyah, f.space.id)).toEqual([
    "decisions",
    "decisions/adr-0042",
    "platform",
    "platform/architecture",
    "platform/architecture/mqtt-contracts",
    "platform/architecture/mqtt-contracts/topic-registry",
    "platform/architecture/mqtt-contracts-v2",
  ]);
});

// ---------------------------------------------------------------------------------------
// The PageDraft decision
// ---------------------------------------------------------------------------------------

/**
 * **The draft survives a delete, and comes back with the page.** The argument, since this is a
 * decision rather than an omission: `PageVersion` rows are immutable history that can always be
 * re-read, while the draft is the only copy of text a human has written and not yet published.
 * A soft delete exists so that nothing is lost and a restore returns the page as it was;
 * dropping the draft would make delete quietly destructive in the one place where the loss
 * cannot be undone by the restore that is supposed to undo it.
 *
 * It costs nothing to keep. `getPageForEditing`, `canEditPage` and `saveDraft` all carry
 * `visiblePage()`, so nobody can read or write the draft of a deleted page while it is gone —
 * asserted here rather than assumed — and `PageDraft.pageId` cascades, so a *hard* delete still
 * takes it.
 */
test("the draft survives a delete and comes back untouched", async () => {
  const f = await fixture();
  const { getPageForEditing } = await import("@/lib/pages/editable");
  const { saveDraft } = await import("@/lib/drafts/repo");

  await db.pageDraft.create({
    data: {
      pageId: f.mqtt.id,
      title: "MQTT contracts",
      markdown: "## Unpublished thinking\n\nHalf a paragraph nobody else has.\n",
      updatedById: f.aisyah.id,
    },
  });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  const draft = await db.pageDraft.findUniqueOrThrow({ where: { pageId: f.mqtt.id } });
  expect(draft.markdown).toContain("Half a paragraph nobody else has");

  // Unreachable while the page is gone, through both doors.
  expect(await getPageForEditing(f.asAisyah, f.mqtt.id)).toMatchObject({
    ok: false,
    reason: "not-found",
  });
  expect(
    await saveDraft(f.asAisyah, f.mqtt.id, {
      title: "Overwritten",
      markdown: "gone",
      seen: draft.updatedAt,
    }),
  ).toMatchObject({ ok: false, reason: "not-found" });

  restored(await restorePage(f.asDara, f.mqtt.id));

  const after = await db.pageDraft.findUniqueOrThrow({ where: { pageId: f.mqtt.id } });
  expect(after.markdown).toBe(draft.markdown);
  expect(after.updatedAt).toEqual(draft.updatedAt);
});

// ---------------------------------------------------------------------------------------
// Authorisation, and the asymmetry
// ---------------------------------------------------------------------------------------

/**
 * **`EDIT` deletes, `ADMIN` restores, so an editor cannot undo their own delete.** That is the
 * intended behaviour and not a bug: a delete that is trivially reversible gets used casually,
 * and a restore that is trivially available puts a page back at a path someone else has since
 * planned around.
 *
 * It is also the one asymmetry in Phase 2 that nobody can guess, so the refusal carries a
 * message saying who can — asserted here, because a `forbidden` with no explanation would send
 * the editor looking for a bug instead of an admin.
 *
 * Kills weakening `MANAGE_SPACE` to `EDIT` on restore.
 */
test("the editor who deleted a page cannot restore it, and is told who can", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const before = await snapshot(f.space.id);

  const result = await restorePage(f.asAisyah, f.mqtt.id);
  expect(result).toEqual({
    ok: false,
    reason: "forbidden",
    message: expect.stringContaining("space admin"),
  });
  if (result.ok || result.reason !== "forbidden") throw new Error("unreachable");
  expect(result.message).toContain("Any editor can delete");
  expect(await snapshot(f.space.id)).toEqual(before);

  // The admin in the same space can, and so can a super admin.
  restored(await restorePage(f.asDara, f.mqtt.id));
  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  restored(await restorePage(f.asSuperAdmin, f.mqtt.id));
});

test("a VIEWER in the space is forbidden rather than not-found, for both directions", async () => {
  const f = await fixture();

  expect(await deletePage(f.asViewer, f.mqtt.id)).toEqual({ ok: false, reason: "forbidden" });

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  expect(await restorePage(f.asViewer, f.mqtt.id)).toMatchObject({
    ok: false,
    reason: "forbidden",
  });
});

test("a stranger cannot delete or restore, and cannot discover the page exists", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  expect(await deletePage(stranger, f.mqtt.id)).toEqual({ ok: false, reason: "not-found" });
  expect(await snapshot(f.space.id)).toEqual(before);

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  // Not "forbidden": a 403 confirms the page is real. The line Tasks 4, 6, 7, 8, 9 and 10 all
  // draw in the same place.
  expect(await restorePage(stranger, f.mqtt.id)).toEqual({ ok: false, reason: "not-found" });
});

/**
 * The permission predicate and the soft-delete predicate are independent, and the one viewer
 * who skips the first must not skip the second.
 */
test("a super admin cannot delete an already-deleted page", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  expect(await deletePage(f.asSuperAdmin, f.mqtt.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await deletePage(f.asAisyah, f.registry.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
});

test("a page in another space is out of reach of this space's members", async () => {
  const f = await fixture();
  // `handbook` is ALL_STAFF, so Aisyah can *read* it — and still cannot write to it, because
  // she is not a member. Readable but not writable is `forbidden`, not `not-found`.
  expect(await deletePage(f.asAisyah, f.handbookWelcome.id)).toEqual({
    ok: false,
    reason: "forbidden",
  });
});

// ---------------------------------------------------------------------------------------
// The audit rows
// ---------------------------------------------------------------------------------------

test("delete and restore each write one audit row, joined by the delete stamp", async () => {
  const f = await fixture();

  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  restored(await restorePage(f.asDara, f.mqtt.id));

  const audits = await db.auditLog.findMany({
    where: { spaceId: f.space.id },
    orderBy: { createdAt: "asc" },
  });
  expect(audits.map((a) => a.action)).toEqual(["page.delete", "page.restore"]);
  expect(audits.map((a) => a.actorId)).toEqual([f.aisyah.id, f.dara.id]);
  for (const audit of audits) expect(audit.pageId).toBe(f.mqtt.id);

  const [remove, restore] = audits as [(typeof audits)[number], (typeof audits)[number]];
  const removeDetail = remove.detail as Record<string, unknown>;
  const restoreDetail = restore.detail as Record<string, unknown>;
  expect(removeDetail).toEqual({
    path: "architecture/mqtt-contracts",
    title: "MQTT contracts",
    deletedAt: expect.any(String),
    deleted: 2,
    redirects: 2,
    redirectTo: "architecture",
  });
  expect(restoreDetail).toEqual({
    path: "architecture/mqtt-contracts",
    title: "MQTT contracts",
    deletedAt: removeDetail.deletedAt,
    restored: 2,
    redirectsCleared: 2,
  });
});

// ---------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------

/**
 * The lock key, compared as source text rather than as behaviour, because behaviour cannot
 * distinguish two keys that happen to agree today from two keys that agree by construction.
 *
 * Create, move and delete must take the **same** lock on the **same** key. Delete writes a
 * `Redirect` at a path a concurrent move may be reclaiming and reads a subtree a concurrent
 * move may be rewriting; restore asks whether a path is free and then claims it. Two different
 * keys would serialise each of them against its own kind and none of them against the others.
 *
 * Publish is asserted to take none, deliberately: it never touches `Page.path`. That absence is
 * a decision, not an oversight — see Task 9, and do not "fix" it.
 */
function advisoryLockStatements(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  return [...source.matchAll(/SELECT pg_advisory_xact_lock\([^`]*\)/g)].map((m) =>
    m[0].replace(/\$\{[^}]*\}/g, "${SPACE_ID}"),
  );
}

test("delete and restore take byte-identically the same advisory lock create takes", () => {
  const key = "SELECT pg_advisory_xact_lock(hashtext(${SPACE_ID}))";
  // One per exported function in this module, and both the same key.
  expect(advisoryLockStatements("src/lib/pages/delete.ts")).toEqual([key, key]);
  expect(advisoryLockStatements("src/lib/pages/create.ts")).toEqual([key]);
  expect(advisoryLockStatements("src/lib/pages/move.ts")).toEqual([key]);
  expect(advisoryLockStatements("src/lib/pages/publish.ts")).toEqual([]);
});

/**
 * A `Promise.all` race is not a test of a lock on this project — it staggers on a real
 * connection pool, and Phase 1 measured an equivalent test passing three runs out of three with
 * the guarantee it claimed to prove deleted. So this one **blocks**, staged with a held
 * transaction.
 *
 * The staging: a held transaction takes a row lock on a page the delete must stamp, so the
 * delete sits inside its own transaction holding the advisory lock. A *move* in the same space,
 * touching an entirely different subtree, must then wait — and the assertion is that it has not
 * finished while the delete is stuck.
 *
 * Kills removing the advisory lock from `deletePage`: the move runs straight past, which is the
 * interleaving where a move rewrites paths a delete has already read and is about to write
 * redirects for.
 */
test("a move in the same space blocks behind a delete's lock", async () => {
  const f = await fixture();
  const { movePage } = await import("@/lib/pages/move");

  const staged = holdOpen(
    (tx) => tx.$queryRaw`SELECT 1 FROM "Page" WHERE "id" = ${f.registry.id} FOR UPDATE`,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await settle(); // the row lock is taken

    let deleteDone = false;
    const removing = deletePage(f.asAisyah, f.mqtt.id).then((r) => {
      deleteDone = true;
      return r;
    });
    pending.push(removing);
    await settle(); // the delete holds the advisory lock and is blocked on the row lock
    expect(deleteDone, "the delete is blocked on the held row").toBe(false);

    let moveDone = false;
    const moving = movePage(f.asAisyah, f.adr.id, {
      newParentId: null,
      newSlug: "adr-0042-mqtt-topic-naming",
    }).then((r) => {
      moveDone = true;
      return r;
    });
    pending.push(moving);
    await settle();

    expect(moveDone, "the move waits for the space lock the delete holds").toBe(false);

    await staged.finish();
    deleted(await removing);
    const move = await moving;
    expect(move.ok, `the move should succeed once unblocked: ${JSON.stringify(move)}`).toBe(true);

    expect(await livePaths(f.space.id)).toEqual([
      "adr-0042-mqtt-topic-naming",
      "architecture",
      "architecture/mqtt-contracts-v2",
      "decisions",
      "platform",
    ]);
  } finally {
    await staged.finish();
    await Promise.allSettled(pending);
  }
});

/**
 * The other half of the key: a delete in one space is not blocked by a lock held on another.
 * Kills replacing `hashtext(spaceId)` with a constant — which would pass the test above while
 * serialising every author in the installation behind every other.
 */
test("a delete is not blocked by a lock held on a different space", async () => {
  const f = await fixture();

  const staged = holdOpen(
    (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${f.other.id}))`,
  );
  try {
    await settle();
    // Nothing is released before this line: the delete must complete on its own.
    deleted(await deletePage(f.asAisyah, f.mqtt.id));
  } finally {
    await staged.finish();
  }
});

/**
 * The mid-write abort, and the only test here that proves the `$transaction` is all-or-nothing:
 * every other rejection returns before a row is written, which a function with no transaction
 * at all would also pass.
 *
 * A second delete commits while this one is between its subtree read and its `UPDATE`. The
 * statement carries `deletedAt IS NULL`, Postgres re-evaluates it after the row lock clears,
 * the descendant falls out, and the row count comes back **short** — which is reported as
 * `not-found` and rolled back rather than committing a delete whose redirects and audit row
 * describe rows it did not take.
 *
 * Kills reporting the shortfall as success, and kills dropping `deletedAt IS NULL` from the
 * statement — without it the descendant is re-stamped with this delete's timestamp and silently
 * enrolled in this delete's restore set.
 */
test("a competing delete landing mid-statement rolls the whole delete back", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const staged = holdOpen(
    (tx) =>
      tx.$executeRaw`UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${f.registry.id}`,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await settle(); // the competing delete holds the descendant's row lock, uncommitted

    // The delete takes the advisory lock (uncontended), reads a subtree that still looks
    // entirely live under MVCC, and blocks inside its `UPDATE` on the held row.
    const racing = deletePage(f.asAisyah, f.mqtt.id);
    pending.push(racing);
    await settle();

    await staged.finish();

    expect(await racing).toEqual({ ok: false, reason: "not-found" });

    // Nothing committed. Compared against the whole snapshot rather than one count, because a
    // half-committed transaction fails in whichever half nobody looked at — the parent must
    // still be live, and there must be no redirect and no audit row.
    const after = await snapshot(f.space.id);
    expect(after.rows.filter((r) => r.startsWith("architecture/mqtt-contracts "))).toEqual(
      before.rows.filter((r) => r.startsWith("architecture/mqtt-contracts ")),
    );
    expect(after.redirects).toEqual([]);
    expect(after.audits).toBe(0);
  } finally {
    await staged.finish();
    await Promise.allSettled(pending);
  }
});

/**
 * The same shape for restore, and it is what the `deletedAt: stamp` write predicate is for. A
 * competing writer changes one row's `deletedAt` while the restore is between its read and its
 * `updateMany`; the predicate no longer matches, the count comes back short, and the whole
 * restore rolls back rather than bringing back half a subtree — a page reachable at its URL
 * with its parent still missing from the rail.
 *
 * Kills dropping `deletedAt: stamp` from the update, and kills dropping the count check.
 */
test("a competing write landing mid-restore rolls the whole restore back", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  const before = await snapshot(f.space.id);

  const staged = holdOpen(
    (tx) =>
      tx.$executeRaw`UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${f.registry.id}`,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await settle();

    const racing = restorePage(f.asDara, f.mqtt.id);
    pending.push(racing);
    await settle();

    await staged.finish();

    expect(await racing).toEqual({ ok: false, reason: "not-found" });

    const after = await snapshot(f.space.id);
    // The parent is still deleted and the redirects the delete wrote are still standing.
    expect(
      (await db.page.findUniqueOrThrow({ where: { id: f.mqtt.id } })).deletedAt,
    ).not.toBeNull();
    expect(after.redirects).toEqual(before.redirects);
    expect(after.audits).toBe(before.audits);
  } finally {
    await staged.finish();
    await Promise.allSettled(pending);
  }
});

/* ------------------------------------------------- the restore list (Task 14b) ---------- */

test("the deleted list holds only deleted pages, newest delete first", async () => {
  const f = await fixture();

  // Nothing deleted yet: the list is empty even though the space is full of pages. This is
  // the half that fails if the filter is dropped — every live page would be listed, which is
  // a titles listing wearing the label "deleted".
  const empty = await listDeletedPages(f.asDara, f.space.id);
  expect(empty).toEqual({ ok: true, pages: [] });

  deleted(await deletePage(f.asAisyah, f.adr.id));
  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  const result = await listDeletedPages(f.asDara, f.space.id);
  if (!result.ok) throw new Error(`expected a list, got ${JSON.stringify(result)}`);

  // The mqtt subtree went down second, so its two rows come first; the ADR is older. And the
  // list is exactly the deleted set — `architecture`, `mqtt-contracts-v2` and `platform` are
  // all still live and must not be in it.
  expect(result.pages.map((p) => p.path)).toEqual([
    "architecture/mqtt-contracts",
    "architecture/mqtt-contracts/topic-registry",
    "decisions/adr-0042",
  ]);
  expect(result.pages.map((p) => p.title)).toEqual([
    "MQTT contracts",
    "Topic registry",
    "MQTT topic naming",
  ]);
});

test("each row counts the pages that come back with it, and does not count a prefix sibling", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.architecture.id));

  const result = await listDeletedPages(f.asDara, f.space.id);
  if (!result.ok) throw new Error(`expected a list, got ${JSON.stringify(result)}`);

  const by = new Map(result.pages.map((p) => [p.path, p.descendants]));
  // `architecture` took all three below it. `mqtt-contracts` took one — `topic-registry` —
  // and NOT `mqtt-contracts-v2`, which is its sibling and merely shares a prefix. That is the
  // mutation this count exists to be wrong about in the most expensive place.
  expect(by.get("architecture")).toBe(3);
  expect(by.get("architecture/mqtt-contracts")).toBe(1);
  expect(by.get("architecture/mqtt-contracts-v2")).toBe(0);
  expect(by.get("architecture/mqtt-contracts/topic-registry")).toBe(0);
});

test("an editor cannot list deleted pages, and is told who can", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  // The asymmetry, from the side that makes it visible: the editor who just deleted the page
  // cannot see it in a restore list, let alone restore it. Same permission as `restorePage`
  // and the same sentence, because it is the same screen.
  const result = await listDeletedPages(f.asAisyah, f.space.id);
  expect(result.ok).toBe(false);
  if (result.ok || result.reason !== "forbidden") throw new Error("expected forbidden");
  expect(result.message).toMatch(/space admin/i);

  // A VIEWER is refused the same way, and an ADMIN is not.
  expect((await listDeletedPages(f.asViewer, f.space.id)).ok).toBe(false);
  expect((await listDeletedPages(f.asDara, f.space.id)).ok).toBe(true);
  // A super admin can, which is how the seeded e2e identity reaches this surface.
  expect((await listDeletedPages(f.asSuperAdmin, f.space.id)).ok).toBe(true);
});

test("a stranger cannot list deleted pages, and gets not-found rather than forbidden", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));

  // Not-found and never forbidden: a 403 on a space a stranger cannot read confirms the space
  // exists, and the list would then be a list of its titles.
  expect(await listDeletedPages(stranger, f.space.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await listDeletedPages(f.asDara, "space-that-never-existed")).toEqual({
    ok: false,
    reason: "not-found",
  });
});

test("a restored page leaves the list, and the subtree leaves with it", async () => {
  const f = await fixture();
  deleted(await deletePage(f.asAisyah, f.mqtt.id));
  expect((await listDeletedPages(f.asDara, f.space.id)).ok).toBe(true);

  restored(await restorePage(f.asDara, f.mqtt.id));

  // The whole round trip through the surface an admin actually uses: the list is what they
  // pick from, so it has to be empty again afterwards or the same page is offered twice.
  expect(await listDeletedPages(f.asDara, f.space.id)).toEqual({ ok: true, pages: [] });
});
