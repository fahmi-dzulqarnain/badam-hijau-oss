import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { movePage, type MoveResult } from "@/lib/pages/move";
import { getPublishedPage, listSpacePages } from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { childPath } from "@/lib/pages/slug";
import type { Prisma } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The tree every test starts from. Two sibling roots so there is somewhere to move *to*, a
 * three-deep branch so a descendant rewrite is visible at depth, and
 * `architecture/mqtt-contracts-v2` — a prefix of `architecture/mqtt-contracts` that is not a
 * path boundary — sitting beside the page most tests move.
 *
 * Every field gets a value nothing else shares: `slug`, `path` and `title` are all
 * distinguishable, so swapping one for another in the implementation is visible. Phase 1
 * learned that from a fixture whose fields all defaulted to the node id.
 */
async function fixture(visibility: "MEMBERS" | "ALL_STAFF" = "MEMBERS") {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const budi = await db.user.create({ data: { email: "budi@example.com", name: "Budi S." } });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  // A second space, for the cross-space parent check and for proving the lock is keyed on
  // the space rather than being one global lock.
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

  for (const user of [aisyah, budi]) {
    await db.spaceMembership.create({
      data: { spaceId: space.id, userId: user.id, role: "EDITOR" },
    });
  }

  /** Points a page at a real published version, so the reader's own query can find it. */
  const publish = async (pageId: string, markdown: string) => {
    const version = await db.pageVersion.create({
      data: { pageId, title: "Topic registry", markdown, status: "CURRENT", authorId: aisyah.id },
    });
    await db.page.update({
      where: { id: pageId },
      data: { publishedVersionId: version.id, publishedAt: new Date("2026-08-20T09:00:00Z") },
    });
  };

  const asRole = (id: string, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    other,
    aisyah,
    budi,
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
    asBudi: asRole(budi.id, "EDITOR"),
    asViewer: asRole(aisyah.id, "VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Narrows to the success branch, failing with the actual result if it is not one. */
function moved(result: MoveResult) {
  if (!result.ok) throw new Error(`expected a move, got ${JSON.stringify(result)}`);
  return result.page;
}

/** Narrows to a field rejection, failing with the actual result if it is not one. */
function rejection(result: MoveResult) {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`expected a field error, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** Every path in a space, deleted rows included, in a stable order. */
async function paths(spaceId: string) {
  const rows = await db.page.findMany({
    where: { spaceId },
    orderBy: { path: "asc" },
    select: { path: true },
  });
  return rows.map((row) => row.path);
}

/** Everything a move would change, for the assertions that a rejected move wrote nothing. */
async function snapshot(spaceId: string) {
  return {
    paths: await paths(spaceId),
    parents: (
      await db.page.findMany({
        where: { spaceId },
        orderBy: { path: "asc" },
        select: { path: true, slug: true, parentId: true },
      })
    ).map((row) => `${row.path} ${row.slug} ${row.parentId ?? "-"}`),
    redirects: await db.redirect.count({ where: { spaceId } }),
    audits: await db.auditLog.count({ where: { spaceId } }),
  };
}

/**
 * The invariant the whole module exists to preserve: **every row's path is its parent's path
 * plus its slug — soft-deleted rows included.** A row that breaks it is reachable at its URL
 * (built from `path`) and missing from the nav rail (built from `parentId`), which is the
 * quietest way to lose a page, so it is asserted after every move rather than inspected.
 */
async function expectPathsAgreeWithParents(spaceId: string) {
  const rows = await db.page.findMany({
    where: { spaceId },
    select: { id: true, parentId: true, slug: true, path: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const parent = row.parentId === null ? null : byId.get(row.parentId);
    expect(row.parentId === null || parent !== undefined, `parent of ${row.path} exists`).toBe(
      true,
    );
    expect(row.path, `${row.slug} sits under its parent`).toBe(
      childPath(parent?.path ?? null, row.slug),
    );
  }
}

/** Waits are only ever used to stage an interleaving; nothing is asserted about them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

/**
 * Runs one statement inside an interactive transaction and holds it open — the only way to sit
 * between another writer's statement and its `COMMIT`, and so the only way to prove that
 * something else blocks.
 *
 * **`finish()` goes in a `finally`.** A staged interleaving whose release is skipped by a
 * failed assertion leaves an uncommitted transaction holding locks, and the next test's
 * `TRUNCATE` waits on it — so one real failure arrives as a page of unrelated hook timeouts.
 * Measured while mutation-testing this file: removing the lock produced two honest failures and
 * three timeouts that said nothing, which is how a mutation test stops telling you which test
 * caught the mutant. `finish()` is idempotent and never rejects, so calling it on both paths is
 * safe and cannot mask the assertion that actually failed.
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
// The subtree rewrite
// ---------------------------------------------------------------------------------------

/**
 * The shape the Phase 1 probe said commits: one statement, one new prefix, disjoint from
 * every old path. Verified three levels deep, because two levels cannot tell a path rewrite
 * from a slug rewrite — at depth two a page's path is its parent's slug plus its own.
 */
test("a subtree move rewrites every descendant, three levels deep", async () => {
  const f = await fixture();

  const result = moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  expect(result.path).toBe("platform/mqtt-contracts");
  expect(result.previousPath).toBe("architecture/mqtt-contracts");
  expect(result.rewritten).toBe(2);
  expect(result.spaceKey).toBe("engineering");

  expect(await paths(f.space.id)).toEqual([
    "architecture",
    "architecture/mqtt-contracts-v2",
    "decisions",
    "decisions/adr-0042",
    "platform",
    "platform/mqtt-contracts",
    "platform/mqtt-contracts/topic-registry",
  ]);
  await expectPathsAgreeWithParents(f.space.id);

  // The row's own parent and slug, not just its path. A move that rewrites the path and
  // leaves `parentId` behind produces a page the reader can open and the nav rail cannot
  // show, so this is checked through the rail's own query and tree builder.
  const tree = buildTree(await listSpacePages(f.asAisyah, f.space.id));
  const platform = tree.find((node) => node.slug === "platform");
  expect(platform?.children.map((c) => c.path)).toEqual(["platform/mqtt-contracts"]);
  expect(platform?.children[0]?.children.map((c) => c.path)).toEqual([
    "platform/mqtt-contracts/topic-registry",
  ]);
  expect(
    tree.find((node) => node.slug === "architecture")?.children.map((c) => c.path),
  ).toEqual(["architecture/mqtt-contracts-v2"]);
});

test("a rename takes the subtree with it without touching the parent", async () => {
  const f = await fixture();

  const result = moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-topic-contracts",
    }),
  );

  expect(result.path).toBe("architecture/mqtt-topic-contracts");
  expect(await paths(f.space.id)).toContain("architecture/mqtt-topic-contracts/topic-registry");
  await expectPathsAgreeWithParents(f.space.id);

  const row = await db.page.findUniqueOrThrow({ where: { id: f.mqtt.id } });
  expect(row.slug).toBe("mqtt-topic-contracts");
  expect(row.parentId).toBe(f.architecture.id);
});

/**
 * Through the reader's own query, not by inspecting rows. The old URL 404s: Task 11 is what
 * turns the `Redirect` rows written below into a 301, and it has not landed yet.
 */
test("a moved page is readable at its new path, and not at its old one", async () => {
  const f = await fixture();
  await f.publish(f.registry.id, "# Topics\n\nEvery topic is namespaced by outlet.\n");

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const read = await getPublishedPage(f.asAisyah, {
    spaceKey: "engineering",
    path: "platform/mqtt-contracts/topic-registry",
  });
  expect(read?.version.markdown).toContain("namespaced by outlet");

  expect(
    await getPublishedPage(f.asAisyah, {
      spaceKey: "engineering",
      path: "architecture/mqtt-contracts/topic-registry",
    }),
  ).toBeNull();
});

// ---------------------------------------------------------------------------------------
// The rejections, and the two shapes the probe distinguished
// ---------------------------------------------------------------------------------------

/**
 * The shape the probe said **fails**: a one-statement swap of two sibling paths hits the
 * unique index, which Postgres checks row by row even within one statement. So it is refused
 * before anything is written rather than attempted and read back from a duplicate key error.
 *
 * Kills moving the occupancy check after the write, and kills any attempt at a two-phase
 * shuffle: both would leave one of these two paths changed.
 */
test("a sibling swap is rejected up front and both paths are unchanged", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-contracts-v2",
    }),
  );
  expect(error.code).toBe("path-occupied");
  expect(error.field).toBe("slug");
  expect(error.message).toContain("MQTT contracts, second cut");

  expect(await snapshot(f.space.id)).toEqual(before);
});

test("a move onto an occupied path is rejected with both paths intact", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  // `decisions/adr-0042` already exists, so moving the subtree there collides at the root of
  // the move rather than at a descendant.
  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.decisions.id,
      newSlug: "adr-0042",
    }),
  );
  expect(error.code).toBe("path-occupied");
  expect(await snapshot(f.space.id)).toEqual(before);
});

/**
 * The unique index does not know about `deletedAt`, so a soft-deleted page still holds its
 * path. Kills wrapping the occupancy check in `visiblePage()` — the check would pass and the
 * rewrite would fail on the constraint it exists to replace.
 */
test("a move onto a path held by a soft-deleted page names it and points at restore", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.mqttV2.id }, data: { deletedAt: new Date() } });
  const before = await snapshot(f.space.id);

  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-contracts-v2",
    }),
  );
  expect(error.code).toBe("path-occupied-by-deleted");
  expect(error.message).toContain("Restore it");
  expect(await snapshot(f.space.id)).toEqual(before);
});

/**
 * A cycle, and the reason it is a path comparison rather than a `parentId` walk: this data can
 * already contain a cycle — `buildTree` carries a cycle-cutting guard because it does — and a
 * parent walk on cyclic data loops forever.
 */
test("a page cannot move under its own descendant, or under itself", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const underDescendant = rejection(
    await movePage(f.asAisyah, f.mqtt.id, { newParentId: f.registry.id, newSlug: "moved" }),
  );
  expect(underDescendant.code).toBe("parent-is-descendant");
  expect(underDescendant.field).toBe("parentId");

  const underItself = rejection(
    await movePage(f.asAisyah, f.mqtt.id, { newParentId: f.mqtt.id, newSlug: "moved" }),
  );
  expect(underItself.code).toBe("parent-is-descendant");

  expect(await snapshot(f.space.id)).toEqual(before);
});

/**
 * The cycle check terminates even when the data it is handed already contains one. `parentId`
 * is made cyclic directly — the tree builder's own tests build the same shape — and the move
 * still answers rather than hanging, because nothing here walks parents.
 */
test("a cycle already in the data does not hang the cycle check", async () => {
  const f = await fixture();
  await db.page.update({
    where: { id: f.architecture.id },
    data: { parentId: f.registry.id },
  });

  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, { newParentId: f.registry.id, newSlug: "moved" }),
  );
  expect(error.code).toBe("parent-is-descendant");
});

/**
 * The other direction of the same off-by-one, and the one that survives a mutation test
 * otherwise: `architecture/mqtt-contracts-v2` is **not** a descendant of
 * `architecture/mqtt-contracts`, so moving that page under this sibling is legal.
 *
 * Kills replacing the boundary rule in the cycle check with a bare
 * `path.startsWith(oldPath)` — which refuses this move as a cycle, and refuses it with a
 * message about the author's own page being its own ancestor. The pattern in the rewrite
 * guards the *rows*; nothing but this guards the *decision*, which is why the check reuses
 * `descendantPaths` rather than restating the comparison.
 */
test("a sibling whose path extends this page's is a legal new parent", async () => {
  const f = await fixture();

  const result = moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.mqttV2.id,
      newSlug: "mqtt-contracts",
    }),
  );
  expect(result.path).toBe("architecture/mqtt-contracts-v2/mqtt-contracts");
  expect(await paths(f.space.id)).toContain(
    "architecture/mqtt-contracts-v2/mqtt-contracts/topic-registry",
  );
  await expectPathsAgreeWithParents(f.space.id);
});

test("a move that changes nothing is refused rather than writing a redirect to itself", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-contracts",
    }),
  );
  expect(error.code).toBe("unchanged");
  expect(await snapshot(f.space.id)).toEqual(before);
});

test("an invalid slug is a field error, and nothing is written", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const uppercase = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "MQTT-Contracts",
    }),
  );
  expect(uppercase.code).toBe("uppercase");
  expect(uppercase.field).toBe("slug");

  // The reserved prefix, which is security-adjacent rather than cosmetic: `/[space]/-/adrs`
  // is a real application route in Phase 3 and a page must not be able to shadow it.
  expect(
    rejection(
      await movePage(f.asAisyah, f.mqtt.id, { newParentId: null, newSlug: "-adrs" }),
    ).code,
  ).toBe("reserved-prefix");

  expect(await snapshot(f.space.id)).toEqual(before);
});

// ---------------------------------------------------------------------------------------
// The boundary, and the LIKE pattern
// ---------------------------------------------------------------------------------------

/**
 * `architecture/mqtt-contracts-v2` is a prefix match and not a path boundary, so it must not
 * move. Kills replacing the boundary rule with a bare `startsWith`/`LIKE 'prefix%'` in either
 * the read or the statement: the sibling and its own subtree would be dragged across the tree,
 * and nothing else in the suite would notice.
 */
test("a sibling whose path is a prefix but not a boundary is left alone", async () => {
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

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  expect((await db.page.findUniqueOrThrow({ where: { id: f.mqttV2.id } })).path).toBe(
    "architecture/mqtt-contracts-v2",
  );
  expect((await db.page.findUniqueOrThrow({ where: { id: v2Child.id } })).path).toBe(
    "architecture/mqtt-contracts-v2/payload-shapes",
  );
  await expectPathsAgreeWithParents(f.space.id);

  // And only the two moving rows got a redirect.
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
 * `%`, `_` and `\` are `LIKE` metacharacters and none of them can appear in a slug today —
 * which is exactly why the escaping is easy to skip and expensive to discover later. These
 * rows are inserted directly, under the slug rules, so the `ESCAPE` clause is exercised now
 * rather than from the day the character class changes.
 *
 * Each one kills a different half:
 *
 * - `_` unescaped is a single-character wildcard, so moving `probe/b_c` also matches
 *   `probe/bxc` and drags it and its subtree along.
 * - `%` unescaped matches any run, so moving `probe/p%` would match every sibling.
 * - the escape character itself unescaped consumes the `/` that follows it in the pattern, so
 *   the moving page's own descendant stops matching and is left stranded under the old prefix.
 *
 * The first two are caught by the row count as well as by these assertions, which is
 * deliberate: over-matching rows the function never validated is a corrupted tree, so the
 * statement's count is compared with the rows read under the lock and the transaction is
 * rolled back rather than committed.
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
  const wildcardVictim = await raw(probe.id, "bxc", "probe/bxc", "Single-character victim");
  const percent = await raw(probe.id, "p%", "probe/p%", "Percent sibling");
  // `probe/pzz/child` is what `probe/p%/%` matches when the `%` is left as a wildcard: any
  // sibling starting `probe/p` with a child of its own. `probe/plain` would NOT be dragged —
  // it has no second `/` — which is why the victim here has a child.
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
  const underscoreChild = await raw(
    underscore.id,
    "leaf",
    "probe/b_c/leaf",
    "Underscore child",
  );

  // Moving the `_` page must take its own child and nothing else.
  moved(await movePage(f.asAisyah, underscore.id, { newParentId: null, newSlug: "renamed" }));
  expect((await db.page.findUniqueOrThrow({ where: { id: underscoreChild.id } })).path).toBe(
    "renamed/leaf",
  );
  expect((await db.page.findUniqueOrThrow({ where: { id: wildcardVictim.id } })).path).toBe(
    "probe/bxc",
  );

  // Moving the `%` page must not match every sibling that has children.
  moved(await movePage(f.asAisyah, percent.id, { newParentId: null, newSlug: "percent" }));
  expect((await db.page.findUniqueOrThrow({ where: { id: percentVictim.id } })).path).toBe(
    "probe/pzz",
  );
  expect((await db.page.findUniqueOrThrow({ where: { id: percentVictimChild.id } })).path).toBe(
    "probe/pzz/child",
  );

  // Moving a page whose path ends in the escape character must still take its descendant:
  // this is the under-match direction, and it fails as a rolled-back move rather than a
  // silently stranded child.
  moved(await movePage(f.asAisyah, backslash.id, { newParentId: null, newSlug: "backslash" }));
  expect((await db.page.findUniqueOrThrow({ where: { id: backslashChild.id } })).path).toBe(
    "backslash/child",
  );

  await expectPathsAgreeWithParents(f.space.id);
});

// ---------------------------------------------------------------------------------------
// The path length limit
// ---------------------------------------------------------------------------------------

/**
 * `validatePath` on the **longest resulting descendant**, not on the moved page. The page being
 * moved gets a perfectly short new path here; a descendant three levels below it goes over the
 * 2000-byte limit, and without this check Postgres refuses the rewrite with
 * `index row size … exceeds btree version 4 maximum 2704` — a 500 that names no field and no
 * page.
 *
 * Kills validating only `newPath`, and kills validating nothing.
 */
test("a move is rejected when a descendant's path would breach the limit", async () => {
  const f = await fixture();

  // A chain of entirely legal 80-character slugs — the per-slug cap — under a five-character
  // root, extended until the leaf's path is one byte under the 2000-byte path limit. Depth is
  // what breaches the limit, which is the finding this whole guard came from: no per-slug cap
  // can bound the assembled path.
  const TARGET = 1995;
  const segment = (n: number, length = 80) =>
    `s${String(n).padStart(2, "0")}${"x".repeat(80)}`.slice(0, length);
  let parent = await db.page.create({
    data: {
      spaceId: f.space.id,
      slug: "chain",
      path: "chain",
      title: "Chain root",
      createdById: f.aisyah.id,
    },
    select: { id: true, path: true },
  });
  const chainRoot = parent;
  let depth = 0;
  const link = async (slug: string) => {
    parent = await db.page.create({
      data: {
        spaceId: f.space.id,
        parentId: parent.id,
        slug,
        path: childPath(parent.path, slug),
        title: `Link ${depth}`,
        createdById: f.aisyah.id,
      },
      select: { id: true, path: true },
    });
    depth++;
  };
  while (TARGET - parent.path.length - 1 > 80) await link(segment(depth));
  const remainder = TARGET - parent.path.length - 1;
  if (remainder > 0) await link(segment(depth, remainder));

  const leaf = parent;
  // Inside the limit now, and over it once "platform/" is prepended — which is the whole
  // point: the move looks like a nine-byte change to the page in front of the author, and it
  // is a page 25 levels below that one which stops fitting in the index.
  expect(leaf.path.length).toBe(TARGET);
  expect(depth).toBeGreaterThan(20);
  expect(leaf.path.length + "platform/".length).toBeGreaterThan(2000);

  const before = await snapshot(f.space.id);
  const error = rejection(
    await movePage(f.asAisyah, chainRoot.id, {
      newParentId: f.platform.id,
      newSlug: "chain",
    }),
  );
  expect(error.code).toBe("path-too-long");
  expect(error.field).toBe("slug");
  expect(await snapshot(f.space.id)).toEqual(before);

  // The same move one level shallower is fine, so the rejection is about the length and not
  // about the shape of the tree.
  moved(await movePage(f.asAisyah, chainRoot.id, { newParentId: null, newSlug: "chn" }));
});

// ---------------------------------------------------------------------------------------
// Soft-deleted descendants — the decision
// ---------------------------------------------------------------------------------------

/**
 * **A soft-deleted descendant moves with the subtree.** The decision, and its argument:
 *
 * A soft-deleted row keeps holding its path, and the unique index does not know about
 * `deletedAt`. Skip it and it is stranded under a prefix its parent no longer has, which
 * breaks the one invariant everything else relies on — a row's path is its parent's path plus
 * its slug. Three consequences follow, and the second is the expensive one:
 *
 * 1. `createPage` reads deleted rows on purpose, so the stranded path refuses a create in a
 *    subtree the deleted page no longer belongs to.
 * 2. Task 12's restore promises to put a page back where it was; a stranded row comes back at
 *    a path whose ancestors live elsewhere — reachable by URL, absent from the nav rail.
 * 3. Moving the subtree back collides with the stranded row on `(spaceId, path)`, which is a
 *    duplicate key error caused by a page nobody can see.
 *
 * The cost is that "where it was" means *under its parent*, not the literal string it held
 * when it was deleted. That is the only version of the promise that survives its parent
 * moving, and the round trip below is what pins it.
 */
test("a soft-deleted descendant is rewritten with the subtree", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.registry.id }, data: { deletedAt: new Date() } });

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const registry = await db.page.findUniqueOrThrow({ where: { id: f.registry.id } });
  expect(registry.path).toBe("platform/mqtt-contracts/topic-registry");
  expect(registry.deletedAt).not.toBeNull();
  await expectPathsAgreeWithParents(f.space.id);

  // Restored, it comes back under its parent's new location — and the nav rail agrees,
  // because `parentId` never changed.
  await db.page.update({ where: { id: f.registry.id }, data: { deletedAt: null } });
  const rail = buildTree(await listSpacePages(f.asAisyah, f.space.id));
  const node = rail
    .find((n) => n.slug === "platform")
    ?.children.find((n) => n.slug === "mqtt-contracts")
    ?.children.find((n) => n.slug === "topic-registry");
  expect(node?.path).toBe("platform/mqtt-contracts/topic-registry");
});

/**
 * The round trip, which is what a skipped soft-deleted descendant actually costs. With the
 * rewrite filtered to live rows, the second move here fails with a duplicate key violation on
 * `(spaceId, path)` — raised by a row no reader can see, on a move that has nothing to do
 * with it.
 */
test("a subtree with a soft-deleted descendant can move away and back", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.registry.id }, data: { deletedAt: new Date() } });

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );
  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-contracts",
    }),
  );

  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.registry.id } })).path,
  ).toBe("architecture/mqtt-contracts/topic-registry");
  await expectPathsAgreeWithParents(f.space.id);
});

// ---------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------

test("every old path in the subtree gets a redirect to the page that holds it now", async () => {
  const f = await fixture();

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const redirects = await db.redirect.findMany({
    where: { spaceId: f.space.id },
    orderBy: { fromPath: "asc" },
    select: { fromPath: true, toPageId: true },
  });
  expect(redirects).toEqual([
    { fromPath: "architecture/mqtt-contracts", toPageId: f.mqtt.id },
    { fromPath: "architecture/mqtt-contracts/topic-registry", toPageId: f.registry.id },
  ]);
});

/**
 * A→B then B→A. The second move must clear the redirect the first one wrote, because that
 * path now holds a live page again — otherwise Task 11 sends every reader who asks for it
 * somewhere else, which is a redirect away from the very page they named.
 *
 * Kills dropping the reclaiming `deleteMany`.
 */
test("moving back leaves no redirect standing at a live path", async () => {
  const f = await fixture();

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );
  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.architecture.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const live = new Set(await paths(f.space.id));
  const redirects = await db.redirect.findMany({
    where: { spaceId: f.space.id },
    select: { fromPath: true, toPageId: true },
  });
  expect(redirects.filter((r) => live.has(r.fromPath))).toEqual([]);

  // And what is left is the reverse direction, resolving in one hop to where the page is now.
  expect(redirects.map((r) => r.fromPath).sort()).toEqual([
    "platform/mqtt-contracts",
    "platform/mqtt-contracts/topic-registry",
  ]);
});

/**
 * Two moves of the same page leave two redirects, and **neither is a chain**: `Redirect` stores
 * `toPageId`, so both resolve directly to wherever the page is now. Task 11 follows exactly
 * one hop, so a chain would be a bug here rather than something the reader tolerates.
 */
test("a page moved twice has two redirects and no chain", async () => {
  const f = await fixture();

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );
  moved(
    await movePage(f.asAisyah, f.mqtt.id, { newParentId: null, newSlug: "contracts" }),
  );

  const redirects = await db.redirect.findMany({
    where: { spaceId: f.space.id, toPageId: f.mqtt.id },
    orderBy: { fromPath: "asc" },
    select: { fromPath: true },
  });
  expect(redirects.map((r) => r.fromPath)).toEqual([
    "architecture/mqtt-contracts",
    "platform/mqtt-contracts",
  ]);

  // No redirect points at a path another redirect starts from — which is what a chain is.
  const all = await db.redirect.findMany({
    where: { spaceId: f.space.id },
    select: { fromPath: true, toPage: { select: { path: true } } },
  });
  const froms = new Set(all.map((r) => r.fromPath));
  expect(all.filter((r) => froms.has(r.toPage.path))).toEqual([]);
});

/**
 * A redirect can already be standing at the path a page is vacating — dormant, shadowed by
 * the live page sitting on top of it — and `(spaceId, fromPath)` is unique. Kills inserting
 * the new redirects without clearing that one first: the move would die on a `P2002` that has
 * nothing to do with what the author asked for.
 */
test("a dormant redirect at a vacated path is replaced, not collided with", async () => {
  const f = await fixture();
  await db.redirect.create({
    data: {
      spaceId: f.space.id,
      fromPath: "architecture/mqtt-contracts",
      toPageId: f.adr.id,
    },
  });

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const redirect = await db.redirect.findFirstOrThrow({
    where: { spaceId: f.space.id, fromPath: "architecture/mqtt-contracts" },
    select: { toPageId: true },
  });
  expect(redirect.toPageId).toBe(f.mqtt.id);
});

// ---------------------------------------------------------------------------------------
// Authorisation and the audit row
// ---------------------------------------------------------------------------------------

test("a stranger cannot move a page, and cannot discover it exists", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  expect(await movePage(stranger, f.mqtt.id, { newParentId: null, newSlug: "x" })).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await snapshot(f.space.id)).toEqual(before);
});

test("a VIEWER in the space is forbidden rather than not-found", async () => {
  const f = await fixture();

  expect(
    await movePage(f.asViewer, f.mqtt.id, { newParentId: f.platform.id, newSlug: "m" }),
  ).toEqual({ ok: false, reason: "forbidden" });
});

test("a soft-deleted page cannot be moved, and reads as not-found", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.mqtt.id }, data: { deletedAt: new Date() } });

  expect(
    await movePage(f.asAisyah, f.mqtt.id, { newParentId: f.platform.id, newSlug: "m" }),
  ).toEqual({ ok: false, reason: "not-found" });
});

test("a super admin's move is not also a soft-delete bypass", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.mqtt.id }, data: { deletedAt: new Date() } });
  const superAdmin: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

  // The permission predicate and the soft-delete predicate are independent, and the one
  // viewer who skips the first must not skip the second.
  expect(
    await movePage(superAdmin, f.mqtt.id, { newParentId: f.platform.id, newSlug: "m" }),
  ).toEqual({ ok: false, reason: "not-found" });
});

/**
 * A parent in another space is `parent-not-found`, not an accepted move. Without `spaceId` on
 * the parent read the page would be given a path prefix from a different space's tree — a page
 * whose path belongs to one space and whose row belongs to another.
 */
test("a parent in another space is not a parent", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const error = rejection(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.handbookWelcome.id,
      newSlug: "mqtt-contracts",
    }),
  );
  expect(error.code).toBe("parent-not-found");
  expect(error.field).toBe("parentId");
  expect(await snapshot(f.space.id)).toEqual(before);
});

test("a soft-deleted page cannot be used as a parent", async () => {
  const f = await fixture();
  await db.page.update({ where: { id: f.platform.id }, data: { deletedAt: new Date() } });

  expect(
    rejection(
      await movePage(f.asAisyah, f.mqtt.id, {
        newParentId: f.platform.id,
        newSlug: "mqtt-contracts",
      }),
    ).code,
  ).toBe("parent-not-found");
});

test("one audit row records both paths and how many pages moved", async () => {
  const f = await fixture();

  moved(
    await movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }),
  );

  const audits = await db.auditLog.findMany({ where: { spaceId: f.space.id } });
  expect(audits).toHaveLength(1);
  const audit = audits[0]!;
  expect(audit.action).toBe("page.move");
  expect(audit.actorId).toBe(f.aisyah.id);
  expect(audit.pageId).toBe(f.mqtt.id);
  expect(audit.detail).toEqual({
    fromPath: "architecture/mqtt-contracts",
    toPath: "platform/mqtt-contracts",
    fromSlug: "mqtt-contracts",
    toSlug: "mqtt-contracts",
    fromParentId: f.architecture.id,
    toParentId: f.platform.id,
    rewritten: 2,
  });
});

// ---------------------------------------------------------------------------------------
// The precondition the one-statement rewrite rests on
// ---------------------------------------------------------------------------------------

/**
 * The one-statement rewrite is only safe while the new path set is disjoint from the old one.
 * A consistent tree cannot break that — an overlap needs the new prefix to be an ancestor path
 * of the old one, and in a consistent tree a page holds that path, where the occupancy check
 * catches it. A tree that has already lost a middle row can: `gap/leaf` with no `gap` above it,
 * carrying a child whose own slug is `leaf`. Moving it up onto `gap` hands that child the path
 * `gap/leaf` that the moving page itself still holds.
 *
 * Whether Postgres then raises a duplicate key depends on the order it happens to rewrite the
 * two rows in — a corrupted tree or an unexplained 500, chosen by the scan. Refused instead,
 * in the same spirit as the occupancy check: do not emit a statement whose safety property
 * does not hold.
 */
test("a rewrite whose new paths overlap its old ones is refused", async () => {
  const f = await fixture();
  const orphan = await db.page.create({
    data: {
      spaceId: f.space.id,
      slug: "leaf",
      // No page holds `gap`: the row above this one is gone, which is data this codebase can
      // be handed and cannot repair from here.
      path: "gap/leaf",
      title: "Orphaned leaf",
      createdById: f.aisyah.id,
    },
    select: { id: true, path: true },
  });
  await db.page.create({
    data: {
      spaceId: f.space.id,
      parentId: orphan.id,
      // The slug that repeats its parent's: this row's new path is `gap/leaf`, which its own
      // parent still holds while the statement is halfway through.
      slug: "leaf",
      path: "gap/leaf/leaf",
      title: "Orphaned twig",
      createdById: f.aisyah.id,
    },
  });
  const before = await snapshot(f.space.id);

  const error = rejection(
    await movePage(f.asAisyah, orphan.id, { newParentId: null, newSlug: "gap" }),
  );
  expect(error.code).toBe("path-overlaps-subtree");
  expect(await snapshot(f.space.id)).toEqual(before);
});

// ---------------------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------------------

/**
 * ## The concurrency tests
 *
 * A `Promise.all` race is not a test of a lock on this project. It staggers on a real
 * connection pool, and Phase 1 measured the equivalent draft test passing three runs out of
 * three with Task 4's atomicity guarantee deleted. So the two tests that assert serialisation
 * **block**, staged with a held transaction, and the `Promise.all` one is kept for the outcome
 * contract and labelled as such.
 *
 * The waits stage the interleaving and nothing is asserted about them. A wait that is too
 * short can only make a blocking test agree with the outcome test; it can never make a broken
 * implementation pass.
 */

/**
 * The lock key, compared as source text rather than as behaviour, because behaviour cannot
 * distinguish two keys that happen to agree today from two keys that agree by construction.
 *
 * Create and move must take the **same** lock on the **same** key. Two different keys
 * serialise moves against moves and creates against creates and neither against the other,
 * and create-versus-move is the pair that corrupts a tree: a create resolving a parent's path
 * while a move rewrites it inserts a child under a prefix that no longer exists.
 *
 * Publish is asserted to take none, deliberately: it never touches `Page.path`, so the space
 * lock would serialise every publish in a space against every create and move over a resource
 * none of them share. That absence is a decision, not an oversight — see Task 9.
 */
function advisoryLockStatements(relPath: string): string[] {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  return [...source.matchAll(/SELECT pg_advisory_xact_lock\([^`]*\)/g)].map((m) =>
    // The interpolated expression is normalised away: `${space.id}` and `${spaceId}` are the
    // same key, and the thing being pinned is the SQL and the hash function around it.
    m[0].replace(/\$\{[^}]*\}/g, "${SPACE_ID}"),
  );
}

test("move takes byte-identically the same advisory lock create takes", () => {
  const move = advisoryLockStatements("src/lib/pages/move.ts");
  const create = advisoryLockStatements("src/lib/pages/create.ts");

  expect(move).toEqual(["SELECT pg_advisory_xact_lock(hashtext(${SPACE_ID}))"]);
  expect(move).toEqual(create);
  expect(advisoryLockStatements("src/lib/pages/publish.ts")).toEqual([]);
});

/**
 * Two moves in one space serialise, proven by making the second one **block**.
 *
 * The staging: a held transaction takes a row lock on a page the first move must rewrite. The
 * first move therefore holds the advisory lock and cannot finish. A second move in the same
 * space, touching an entirely different subtree, must sit behind that advisory lock — and the
 * assertion is that it has not finished while the first one is stuck.
 *
 * Kills removing the lock: the second move then runs straight past the first and completes
 * while it is still blocked, which is exactly the interleaving that lets a create or a move
 * read a path another move is halfway through rewriting.
 */
test("a second move in the same space blocks behind the first move's lock", async () => {
  const f = await fixture();

  // A row lock on a page the first move must rewrite. Raw, because Prisma has no `FOR UPDATE`.
  const staged = holdOpen(
    (tx) => tx.$queryRaw`SELECT 1 FROM "Page" WHERE "id" = ${f.registry.id} FOR UPDATE`,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await settle(); // the row lock is taken

    let firstDone = false;
    const first = movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    }).then((r) => {
      firstDone = true;
      return r;
    });
    pending.push(first);
    await settle(); // `first` holds the advisory lock and is blocked on the row lock
    expect(firstDone, "the first move is blocked on the held row").toBe(false);

    let secondDone = false;
    const second = movePage(f.asAisyah, f.adr.id, {
      newParentId: null,
      newSlug: "adr-0042-mqtt-topic-naming",
    }).then((r) => {
      secondDone = true;
      return r;
    });
    pending.push(second);
    await settle();

    // The assertion the whole test exists for: the second move touches an entirely different
    // subtree and still cannot proceed, because the resource they share is the space's path
    // namespace and the first move is holding it.
    expect(secondDone, "the second move waits for the space lock").toBe(false);

    await staged.finish();
    moved(await first);
    moved(await second);

    expect(await paths(f.space.id)).toEqual([
      "adr-0042-mqtt-topic-naming",
      "architecture",
      "architecture/mqtt-contracts-v2",
      "decisions",
      "platform",
      "platform/mqtt-contracts",
      "platform/mqtt-contracts/topic-registry",
    ]);
    await expectPathsAgreeWithParents(f.space.id);
  } finally {
    await staged.finish();
    await Promise.allSettled(pending);
  }
});

/**
 * The other half of the key: a move in one space is not blocked by a lock held on another
 * space. Kills replacing `hashtext(spaceId)` with a constant — which would pass the test
 * above while serialising every author in the installation behind every other.
 */
test("a move is not blocked by a lock held on a different space", async () => {
  const f = await fixture();

  const staged = holdOpen(
    (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${f.other.id}))`,
  );
  try {
    await settle();

    // Nothing is released before this line: the move must complete on its own.
    moved(
      await movePage(f.asAisyah, f.mqtt.id, {
        newParentId: f.platform.id,
        newSlug: "mqtt-contracts",
      }),
    );
  } finally {
    await staged.finish();
  }
});

/**
 * The outcome contract, and labelled as such: two concurrent moves both complete and the tree
 * is consistent afterwards. This is the plan's own test. It is kept because the outcome is
 * worth stating, and it is **not** what proves the lock — the blocking test above is.
 */
test("two concurrent moves in one space both complete and leave a consistent tree", async () => {
  const f = await fixture();

  const results = await Promise.allSettled([
    movePage(f.asAisyah, f.mqtt.id, { newParentId: f.platform.id, newSlug: "mqtt-contracts" }),
    movePage(f.asBudi, f.adr.id, { newParentId: f.architecture.id, newSlug: "adr-0042" }),
  ]);
  for (const result of results) {
    if (result.status === "rejected") throw new Error(`a move threw: ${result.reason}`);
    moved(result.value);
  }

  expect(await paths(f.space.id)).toEqual([
    "architecture",
    "architecture/adr-0042",
    "architecture/mqtt-contracts-v2",
    "decisions",
    "platform",
    "platform/mqtt-contracts",
    "platform/mqtt-contracts/topic-registry",
  ]);
  await expectPathsAgreeWithParents(f.space.id);
});

/**
 * The mid-write abort, and the only test here that proves the `$transaction` itself is
 * all-or-nothing: every other rejection returns before a row is written, which a function with
 * no transaction at all would also pass.
 *
 * A soft delete commits while the move is between its path rewrite and its `parentId` update.
 * That update carries `visiblePage()`, so it matches nothing, and the whole move rolls back —
 * paths, redirects and audit row together.
 *
 * Kills dropping `visiblePage()` from that update: the move would commit, and Task 12's
 * restore would hand readers back a page whose redirects and audit trail describe a move that
 * happened to a deleted page.
 */
test("a soft delete landing mid-move rolls the whole transaction back", async () => {
  const f = await fixture();
  const before = await snapshot(f.space.id);

  const staged = holdOpen(
    (tx) => tx.$executeRaw`UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${f.mqtt.id}`,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await settle(); // the delete holds the moved page's row lock, uncommitted

    // The move takes the advisory lock (uncontended), reads a page that still looks live under
    // MVCC, and blocks inside the rewrite on the row this transaction is holding.
    const racing = movePage(f.asAisyah, f.mqtt.id, {
      newParentId: f.platform.id,
      newSlug: "mqtt-contracts",
    });
    pending.push(racing);
    await settle();

    await staged.finish();

    expect(await racing).toEqual({ ok: false, reason: "not-found" });

    // Nothing committed: the rewrite is rolled back with everything else. Compared against
    // the whole snapshot rather than one count, because a half-committed transaction fails in
    // whichever half nobody looked at.
    const after = await snapshot(f.space.id);
    expect(after.paths).toEqual(before.paths);
    expect(after.parents).toEqual(before.parents);
    expect(after.redirects).toBe(0);
    expect(after.audits).toBe(0);
  } finally {
    await staged.finish();
    await Promise.allSettled(pending);
  }
});
