import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { MAX_HISTORY_ROWS, listPageVersions } from "@/lib/pages/history";
import type { DocStatus } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Task 7 Step 3's query, against the real database.
 *
 * Integration rather than unit, because every question it answers is a question about rows and
 * about who may see them: whether a soft-deleted page still has a history, whether a page in
 * another space can be reached by asking for its path under a readable space key, and whether a
 * viewer who can read *one* space is refused the other. A stubbed client can be made to agree
 * with any of those, which is exactly why it would prove none of them.
 *
 * The pure half — how a `GitJob` state becomes a sentence — is in `src/lib/pages/history.test.ts`.
 */

/**
 * Two spaces with **the same page path in each**, which is the fixture the shape constraint needs.
 *
 * `engineering` is `MEMBERS` and `handbook` is `ALL_STAFF`, so one viewer can be given exactly one
 * of them — and that is what turns "a non-member finds nothing" into a discrimination rather than
 * an absence. Phase 4 measured why that matters: a viewer who can read no space at all makes a
 * refusal indistinguishable from a deleted predicate.
 */
async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const other = await db.user.create({
    data: { email: "hafiz@example.com", name: "Hafiz M." },
  });
  const members = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const open = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: members.id, userId: author.id, role: "EDITOR" },
  });

  /** A page, optionally with versions, the last of which becomes the published one. */
  const page = async (opts: {
    spaceId?: string;
    path?: string;
    title?: string;
    versions?: {
      title?: string;
      status?: DocStatus;
      gitSha?: string | null;
      authorId?: string;
      /** Minutes after the fixed base time. Explicit, so no test depends on insert speed. */
      minute: number;
    }[];
  }) => {
    const title = opts.title ?? "MQTT contracts";
    const path = opts.path ?? "architecture/mqtt-contracts";
    const row = await db.page.create({
      data: {
        spaceId: opts.spaceId ?? members.id,
        slug: path.split("/").pop()!,
        path,
        title,
        docType: "DOC",
        status: "CURRENT",
        createdById: author.id,
      },
      select: { id: true },
    });

    let last: string | null = null;
    for (const version of opts.versions ?? []) {
      const created = await db.pageVersion.create({
        data: {
          pageId: row.id,
          title: version.title ?? title,
          markdown: `# ${title}`,
          status: version.status ?? "CURRENT",
          authorId: version.authorId ?? author.id,
          gitSha: version.gitSha ?? null,
          createdAt: new Date(Date.UTC(2026, 2, 4, 9, version.minute)),
        },
        select: { id: true },
      });
      last = created.id;
    }
    if (last !== null) {
      await db.page.update({
        where: { id: row.id },
        data: { publishedVersionId: last, publishedAt: new Date("2026-03-04T09:00:00Z") },
      });
    }
    return { id: row.id, path, title };
  };

  const editor: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: members.id, role: "EDITOR" }],
  };
  /** Reads `handbook` because it is `ALL_STAFF`, and `engineering` not at all. */
  const outsider: Viewer = { id: other.id, isSuperAdmin: false, memberships: [] };
  const admin: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

  return { author, other, members, open, page, editor, outsider, admin };
}

/** The history, or a failure loud enough to read — most assertions below want the rows. */
async function historyOf(viewer: Viewer, spaceKey: string, path: string) {
  const result = await listPageVersions(viewer, { spaceKey, path });
  if (!result.ok) throw new Error(`expected a history, got ${result.reason}`);
  return result.history;
}

const SHA = "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d";

/* -------------------------------------------------------------------------- */
/* What the history lists                                                     */
/* -------------------------------------------------------------------------- */

test("versions come back newest first, with author, status and content sha", async () => {
  const { page, editor, other } = await fixture();
  await page({
    versions: [
      { minute: 0, status: "DRAFT", gitSha: SHA },
      { minute: 30, status: "CURRENT", gitSha: null, authorId: other.id },
    ],
  });

  const history = await historyOf(editor, "engineering", "architecture/mqtt-contracts");

  expect(history.rows.map((row) => row.status)).toEqual(["CURRENT", "DRAFT"]);
  expect(history.rows.map((row) => row.authorName)).toEqual(["Hafiz M.", "Aisyah R."]);
  expect(history.rows.map((row) => row.gitSha)).toEqual([null, SHA]);
  expect(history.total).toBe(2);
  expect(history.truncated).toBe(false);
  // The published one is the newest, and only it is marked.
  expect(history.rows.map((row) => row.isPublished)).toEqual([true, false]);
  expect(history.page.isLinkable).toBe(true);
});

test("a version published under a different title reports the title, and one under the same does not", async () => {
  const { page, editor } = await fixture();
  await page({
    title: "MQTT contracts",
    versions: [
      { minute: 0, title: "Topic naming" },
      { minute: 30, title: "MQTT contracts" },
    ],
  });

  const history = await historyOf(editor, "engineering", "architecture/mqtt-contracts");
  // Nulled where it matches the page's current title, so a rename shows and repetition does not.
  expect(history.rows.map((row) => row.renamedTo)).toEqual([null, "Topic naming"]);
});

test("a page with exactly one version is a list of one", async () => {
  const { page, editor } = await fixture();
  await page({ versions: [{ minute: 0, gitSha: SHA }] });

  const history = await historyOf(editor, "engineering", "architecture/mqtt-contracts");
  expect(history.rows).toHaveLength(1);
  expect(history.total).toBe(1);
  expect(history.truncated).toBe(false);
  expect(history.rows[0]!.isPublished).toBe(true);
});

/**
 * The reader route 404s a page with no published version, and this one does not — see the module
 * docstring. Nothing leaks by saying so: `listSpacePages` already puts every unpublished page's
 * title in the nav rail of anyone who can read the space.
 */
test("a page that was never published has an empty history rather than a miss", async () => {
  const { page, editor } = await fixture();
  await page({ path: "drafts/nothing-yet", title: "Nothing yet" });

  const history = await historyOf(editor, "engineering", "drafts/nothing-yet");
  expect(history.rows).toEqual([]);
  expect(history.total).toBe(0);
  // So the surface knows not to offer a link that would 404 for everyone.
  expect(history.page.isLinkable).toBe(false);
});

test("the list is capped and says so, and the total is not capped with it", async () => {
  const { page, editor, author } = await fixture();
  const created = await page({ versions: [{ minute: 0 }] });
  // One statement rather than a loop: the cap is what is being tested, not the writes.
  await db.pageVersion.createMany({
    data: Array.from({ length: MAX_HISTORY_ROWS }, (_, index) => ({
      pageId: created.id,
      title: created.title,
      markdown: "# x",
      status: "CURRENT" as DocStatus,
      authorId: author.id,
      createdAt: new Date(Date.UTC(2026, 2, 5, 9, index)),
    })),
  });

  const history = await historyOf(editor, "engineering", created.path);
  expect(history.rows).toHaveLength(MAX_HISTORY_ROWS);
  expect(history.total).toBe(MAX_HISTORY_ROWS + 1);
  expect(history.truncated).toBe(true);
  // The cap takes the newest, not an arbitrary page of them: the one version left out is the
  // oldest, which is the only one from 4 March.
  expect(
    history.rows.every((row) => row.createdAt >= new Date(Date.UTC(2026, 2, 5, 9, 0))),
  ).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* Who may read it                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The soft-delete predicate. Both directions, because an absence assertion needs a companion that
 * could have been present: the same page, the same viewer, the same call — before and after.
 */
test("a soft-deleted page has no history, and reads as not-found", async () => {
  const { page, editor } = await fixture();
  const created = await page({ versions: [{ minute: 0, gitSha: SHA }] });

  const before = await historyOf(editor, "engineering", created.path);
  expect(before.rows).toHaveLength(1);

  await db.page.update({ where: { id: created.id }, data: { deletedAt: new Date() } });

  expect(await listPageVersions(editor, { spaceKey: "engineering", path: created.path })).toEqual({
    ok: false,
    reason: "not-found",
  });
});

/**
 * The permission predicate, as a **discrimination**. The same viewer, in the same call, reads one
 * space's history and is refused the other's — so a deleted `readableSpace` fails here rather
 * than passing on a viewer who could see nothing either way.
 */
test("a viewer reads the history of a page they can read, and not one they cannot", async () => {
  const { page, open, outsider } = await fixture();
  await page({ versions: [{ minute: 0, gitSha: SHA }] });
  await page({
    spaceId: open.id,
    path: "onboarding/first-week",
    title: "First week",
    versions: [{ minute: 0, gitSha: SHA }],
  });

  // `handbook` is ALL_STAFF: readable, and the rows are counted so this half cannot be vacuous.
  const readable = await historyOf(outsider, "handbook", "onboarding/first-week");
  expect(readable.rows).toHaveLength(1);
  expect(readable.total).toBe(1);

  // `engineering` is MEMBERS and this viewer is a member of nothing.
  expect(
    await listPageVersions(outsider, {
      spaceKey: "engineering",
      path: "architecture/mqtt-contracts",
    }),
  ).toEqual({ ok: false, reason: "not-found" });
});

/**
 * The space is a **shape** constraint as well as a permission one, and this is what pins it: the
 * same path exists in both spaces, and asking for it under one key must not return the other's
 * row — which is what a query keyed on `path` alone would do, readably, for a viewer who can read
 * both.
 */
test("a path is resolved inside the space the URL names, not anywhere it happens to exist", async () => {
  const { page, open, admin } = await fixture();
  await page({ title: "Engineering copy", versions: [{ minute: 0, gitSha: SHA }] });
  await page({
    spaceId: open.id,
    title: "Handbook copy",
    versions: [{ minute: 0 }, { minute: 30 }],
  });

  const engineering = await historyOf(admin, "engineering", "architecture/mqtt-contracts");
  const handbook = await historyOf(admin, "handbook", "architecture/mqtt-contracts");

  expect(engineering.page.title).toBe("Engineering copy");
  expect(engineering.total).toBe(1);
  expect(handbook.page.title).toBe("Handbook copy");
  expect(handbook.total).toBe(2);
});

test("a super admin reads a MEMBERS space they do not belong to", async () => {
  const { page, admin } = await fixture();
  await page({ versions: [{ minute: 0, gitSha: SHA }] });

  const history = await historyOf(admin, "engineering", "architecture/mqtt-contracts");
  expect(history.rows).toHaveLength(1);
});

/**
 * The pairing every deliberately-permissive read in this codebase carries: the permission bypass
 * must not also be a soft-delete bypass. `getPageForEditing`, `publishPage`, `movePage` and
 * `deletePage` each have this test, and it is the same two predicates being kept independent.
 */
test("a super admin's reach is not also a soft-delete bypass", async () => {
  const { page, admin } = await fixture();
  const created = await page({ versions: [{ minute: 0 }] });
  await db.page.update({ where: { id: created.id }, data: { deletedAt: new Date() } });

  expect(await listPageVersions(admin, { spaceKey: "engineering", path: created.path })).toEqual({
    ok: false,
    reason: "not-found",
  });
});

test("a path that exists in no space is the same answer as one that cannot be read", async () => {
  const { editor } = await fixture();
  expect(await listPageVersions(editor, { spaceKey: "engineering", path: "no/such" })).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await listPageVersions(editor, { spaceKey: "no-such-space", path: "a" })).toEqual({
    ok: false,
    reason: "not-found",
  });
});

/* -------------------------------------------------------------------------- */
/* The mirror queue                                                           */
/* -------------------------------------------------------------------------- */

/** A `GitJob` for a page, in whatever state the test needs. */
async function job(
  pageId: string,
  state: "PENDING" | "RUNNING" | "FAILED" | "DONE",
  path = "architecture/mqtt-contracts",
) {
  await db.gitJob.create({
    data: { kind: "PUBLISH", state, pageId, spaceKey: "engineering", path },
  });
}

test("a page with nothing outstanding says nothing about its mirror", async () => {
  const { page, editor } = await fixture();
  const created = await page({ versions: [{ minute: 0, gitSha: SHA }] });
  await job(created.id, "DONE");

  const history = await historyOf(editor, "engineering", created.path);
  expect(history.mirror).toEqual({ queued: 0, failed: 0 });
});

test("a failed job for this page is reported, and a queued one is counted apart", async () => {
  const { page, editor } = await fixture();
  const created = await page({ versions: [{ minute: 0, gitSha: null }] });
  await job(created.id, "FAILED");
  await job(created.id, "PENDING");
  await job(created.id, "RUNNING");
  await job(created.id, "DONE");

  const history = await historyOf(editor, "engineering", created.path);
  expect(history.mirror).toEqual({ queued: 2, failed: 1 });
});

/**
 * The aggregate is keyed on the page, so this is the assertion that it is keyed on the **right**
 * page — a `groupBy` with the `where` dropped would report every job in the database and paint a
 * stuck-mirror warning on every page in the product.
 */
test("another page's failure is not this page's problem", async () => {
  const { page, editor } = await fixture();
  const mine = await page({ versions: [{ minute: 0, gitSha: SHA }] });
  const theirs = await page({ path: "architecture/other", title: "Other" });
  await job(theirs.id, "FAILED", "architecture/other");

  expect((await historyOf(editor, "engineering", mine.path)).mirror).toEqual({
    queued: 0,
    failed: 0,
  });
  // The companion: the job is real and is found where it belongs.
  expect((await historyOf(editor, "engineering", theirs.path)).mirror).toEqual({
    queued: 0,
    failed: 1,
  });
});

/**
 * A `MOVE`, `DELETE` or `RESTORE` job carries `versionId: null` by design, so a page can be wedged
 * by a failure that belongs to no version at all — which is why the queue is counted per page and
 * reported once, rather than per row. This is the fixture that would be invisible to a
 * per-version join.
 */
test("a failure that belongs to no version still says the page's mirror is stuck", async () => {
  const { page, editor } = await fixture();
  const created = await page({ versions: [{ minute: 0, gitSha: SHA }] });
  await db.gitJob.create({
    data: {
      kind: "MOVE",
      state: "FAILED",
      pageId: created.id,
      spaceKey: "engineering",
      path: created.path,
      fromPath: "architecture/old-name",
      versionId: null,
    },
  });

  const history = await historyOf(editor, "engineering", created.path);
  expect(history.mirror).toEqual({ queued: 0, failed: 1 });
  // And the version it has nothing to do with still reports its own sha.
  expect(history.rows[0]!.gitSha).toBe(SHA);
});
