import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  getPublishedPage,
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
  resolveRedirect,
} from "@/lib/pages/repo";
import { movePage } from "@/lib/pages/move";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

async function fixture(visibility: "MEMBERS" | "ALL_STAFF") {
  const author = await db.user.create({
    data: { email: "author@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "## Topics\n\nOne namespace.",
      status: "CURRENT",
      authorId: author.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });
  return { author, space, page, version };
}

/**
 * A second page in an existing space. `withVersion: false` leaves `publishedVersionId`
 * null while still allowing a `publishedAt` — the shape an unpublish or a rollback leaves
 * behind, and the reason "published" cannot be read off the timestamp alone.
 */
async function addPage(
  spaceId: string,
  authorId: string,
  opts: { slug: string; publishedAt: Date | null; withVersion?: boolean },
) {
  const page = await db.page.create({
    data: {
      spaceId,
      slug: opts.slug,
      path: `architecture/${opts.slug}`,
      title: opts.slug,
      createdById: authorId,
      status: "CURRENT",
    },
  });
  const version =
    opts.withVersion === false
      ? null
      : await db.pageVersion.create({
          data: {
            pageId: page.id,
            title: opts.slug,
            markdown: "Body.",
            status: "CURRENT",
            authorId,
          },
        });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version?.id ?? null, publishedAt: opts.publishedAt },
  });
  return page;
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

test("an all-staff page is readable by a non-member", async () => {
  await fixture("ALL_STAFF");
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result?.version.markdown).toContain("One namespace.");
});

test("a members-only page is not readable by a non-member", async () => {
  await fixture("MEMBERS");
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result).toBeNull();
});

test("a members-only page is readable by a member", async () => {
  const { space, author } = await fixture("MEMBERS");
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "VIEWER" },
  });
  const viewer: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  };
  const result = await getPublishedPage(viewer, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result?.page.title).toBe("MQTT contracts");
});

test("a super admin can read a members-only page", async () => {
  await fixture("MEMBERS");
  const root: Viewer = { id: "root", isSuperAdmin: true, memberships: [] };
  const result = await getPublishedPage(root, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result).not.toBeNull();
});

test("an unpublished page is not readable even by a member", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  await db.page.create({
    data: {
      spaceId: space.id,
      slug: "draft-only",
      path: "architecture/draft-only",
      title: "Draft only",
      createdById: author.id,
    },
  });
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/draft-only",
  });
  expect(result).toBeNull();
});

test("an unreadable space key resolves to null rather than an error", async () => {
  await fixture("MEMBERS");
  expect(await getReadableSpaceByKey(stranger, "engineering")).toBeNull();
  expect(await getReadableSpaceByKey(stranger, "nonexistent")).toBeNull();
});

test("listSpacePages returns every page including unpublished ones", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  await db.page.create({
    data: {
      spaceId: space.id,
      slug: "wip",
      path: "architecture/wip",
      title: "WIP",
      createdById: author.id,
    },
  });
  const rows = await listSpacePages(stranger, space.id);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.publishedVersionId === null)).toHaveLength(1);
});

test("listSpacePages returns nothing for a space the viewer cannot read", async () => {
  const { space } = await fixture("MEMBERS");
  expect(await listSpacePages(stranger, space.id)).toEqual([]);
});

test("listRecentlyPublished returns nothing for a space the viewer cannot read", async () => {
  const { space } = await fixture("MEMBERS");
  expect(await listRecentlyPublished(stranger, space.id)).toEqual([]);
});

test("listRecentlyPublished carries the published version's author", async () => {
  const { space } = await fixture("ALL_STAFF");
  const rows = await listRecentlyPublished(stranger, space.id);
  expect(rows.map((r) => r.publishedVersion?.author.name)).toEqual(["Aisyah R."]);
});

test("listRecentlyPublished excludes a page whose publishedVersionId is null", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  // Timestamp set, version pointer cleared: what an unpublish or a rollback leaves behind.
  // Filtering on publishedAt alone lists it, and its link 404s for everyone.
  await addPage(space.id, author.id, {
    slug: "rolled-back",
    publishedAt: new Date("2026-08-22T09:00:00Z"),
    withVersion: false,
  });
  // And the plain never-published case, which has neither column set.
  await addPage(space.id, author.id, {
    slug: "never-published",
    publishedAt: null,
    withVersion: false,
  });

  const rows = await listRecentlyPublished(stranger, space.id);
  expect(rows.map((r) => r.title)).toEqual(["MQTT contracts"]);
});

test("listRecentlyPublished orders by publishedAt descending and respects limit", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  // The fixture page publishes at `new Date()`, so it is always the most recent.
  await addPage(space.id, author.id, {
    slug: "oldest",
    publishedAt: new Date("2026-01-01T00:00:00Z"),
  });
  await addPage(space.id, author.id, {
    slug: "newest",
    publishedAt: new Date("2026-08-01T00:00:00Z"),
  });
  await addPage(space.id, author.id, {
    slug: "middle",
    publishedAt: new Date("2026-06-01T00:00:00Z"),
  });

  const all = await listRecentlyPublished(stranger, space.id);
  expect(all.map((r) => r.title)).toEqual(["MQTT contracts", "newest", "middle", "oldest"]);

  const top = await listRecentlyPublished(stranger, space.id, 2);
  expect(top.map((r) => r.title)).toEqual(["MQTT contracts", "newest"]);
});

/**
 * Soft delete. One test per query listed in COVERED in `src/lib/pages/visible.test.ts` —
 * that guard fails if a reader is added here without one of these.
 */

test("getPublishedPage returns null for a soft-deleted page", async () => {
  const { page } = await fixture("ALL_STAFF");
  const args = { spaceKey: "engineering", path: "architecture/mqtt-contracts" };
  // Readable first, so the null below is the deletion and not a broken fixture.
  expect(await getPublishedPage(stranger, args)).not.toBeNull();

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  // `null`, not a throw: the reader route turns this into the same 404 an unreadable page
  // gets. A distinct error would tell an outsider that the page exists and was deleted.
  expect(await getPublishedPage(stranger, args)).toBeNull();
});

test("listSpacePages omits a soft-deleted page and keeps its siblings", async () => {
  const { space, author, page } = await fixture("ALL_STAFF");
  await addPage(space.id, author.id, {
    slug: "still-here",
    publishedAt: new Date("2026-08-01T00:00:00Z"),
  });
  expect(await listSpacePages(stranger, space.id)).toHaveLength(2);

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  // Asserted as the surviving titles rather than a count, so a filter that dropped both
  // pages cannot pass as a filter that dropped the right one.
  const rows = await listSpacePages(stranger, space.id);
  expect(rows.map((r) => r.title)).toEqual(["still-here"]);
});

test("listRecentlyPublished omits a soft-deleted page and keeps its siblings", async () => {
  const { space, author, page } = await fixture("ALL_STAFF");
  await addPage(space.id, author.id, {
    slug: "still-here",
    publishedAt: new Date("2026-08-01T00:00:00Z"),
  });
  expect(await listRecentlyPublished(stranger, space.id)).toHaveLength(2);

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  const rows = await listRecentlyPublished(stranger, space.id);
  expect(rows.map((r) => r.title)).toEqual(["still-here"]);
});

/**
 * Redirects (Task 11). `resolveRedirect` is only ever reached on a read miss, so every test
 * here asserts the miss first — otherwise a redirect test can pass against a path that was
 * never a miss in the first place, which is the same "verified the instance, not the class"
 * mistake this project has made three times.
 *
 * The rows are written by the real `movePage` rather than by hand wherever a move can produce
 * the shape under test. A `Redirect` fixture built with `db.redirect.create` proves this
 * function reads a table; using the move proves it reads what the move writes.
 */

/**
 * The shape `movePage` needs and the plain `fixture` above does not have: a page with a real
 * parent row, two other root pages to move it to, and an `EDITOR` who may move it.
 *
 * Every field is distinguishable — slug, path and title all differ — so swapping one for
 * another in the implementation is visible rather than invisible.
 */
async function movableFixture(visibility: "MEMBERS" | "ALL_STAFF") {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "EDITOR" },
  });

  const root = (slug: string, title: string) =>
    db.page.create({
      data: {
        spaceId: space.id,
        slug,
        path: slug,
        title,
        createdById: author.id,
        status: "CURRENT",
      },
      select: { id: true, path: true },
    });

  const architecture = await root("architecture", "Architecture notes");
  const platform = await root("platform", "Platform group");
  const decisions = await root("decisions", "Decision log");

  const page = await db.page.create({
    data: {
      spaceId: space.id,
      parentId: architecture.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      createdById: author.id,
      status: "CURRENT",
    },
    select: { id: true, path: true },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "## Topics\n\nOne namespace.",
      status: "CURRENT",
      authorId: author.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date("2026-08-20T09:00:00Z") },
  });

  const editor: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "EDITOR" }],
  };
  return { author, space, architecture, platform, decisions, page, editor };
}

/** Fails loudly with the rejection reason rather than on a downstream `undefined`. */
async function move(viewer: Viewer, pageId: string, newParentId: string | null, newSlug: string) {
  const result = await movePage(viewer, pageId, { newParentId, newSlug });
  if (!result.ok) throw new Error(`move rejected: ${JSON.stringify(result)}`);
  return result.page;
}

const ORIGINAL = "architecture/mqtt-contracts";
const args = (path: string) => ({ spaceKey: "engineering", path });

test("a moved page's old path resolves to where the page is now", async () => {
  const { page, platform, editor } = await movableFixture("ALL_STAFF");
  expect(await getPublishedPage(editor, args(ORIGINAL))).not.toBeNull();

  await move(editor, page.id, platform.id, "mqtt-contracts");

  // The miss first: the redirect is only consulted because the page read failed.
  expect(await getPublishedPage(editor, args(ORIGINAL))).toBeNull();
  expect(await resolveRedirect(editor, args(ORIGINAL))).toEqual({
    pageId: page.id,
    path: "platform/mqtt-contracts",
  });
  // And the page really is readable at the path the redirect names, so this is a redirect to
  // a page and not merely to a string.
  expect(await getPublishedPage(editor, args("platform/mqtt-contracts"))).not.toBeNull();
});

/**
 * The property `Redirect.toPageId` buys, and the one test the plan does not list.
 *
 * Two moves leave two redirect rows. Both point at the same page id, so both resolve to
 * wherever it is *now* — the first one included, in a single hop. Had the schema stored a
 * target path, the first row would still name `platform/mqtt-contracts`, and answering the
 * original URL correctly would require following it to a second row: a chain, with an
 * infinite loop one bad row away. This is why "resolve exactly one hop" is sufficient rather
 * than a limitation.
 */
test("a redirect whose target has moved again resolves in one hop to its current path", async () => {
  const { space, page, platform, decisions, editor } = await movableFixture("ALL_STAFF");

  await move(editor, page.id, platform.id, "mqtt-contracts");
  await move(editor, page.id, decisions.id, "mqtt-contracts");

  // Requested: the ORIGINAL path, not the intermediate one.
  expect(await getPublishedPage(editor, args(ORIGINAL))).toBeNull();
  expect(await resolveRedirect(editor, args(ORIGINAL))).toEqual({
    pageId: page.id,
    path: "decisions/mqtt-contracts",
  });

  // The intermediate path resolves in one hop too, to the same place.
  expect(await resolveRedirect(editor, args("platform/mqtt-contracts"))).toEqual({
    pageId: page.id,
    path: "decisions/mqtt-contracts",
  });

  // And the reason both work: two rows, one target. Asserted so a future schema change that
  // added a `toPath` — or a move that rewrote old redirects instead of adding one — would
  // fail here rather than degrade quietly into a chain.
  const rows = await db.redirect.findMany({
    where: { spaceId: space.id },
    select: { fromPath: true, toPageId: true },
    orderBy: { fromPath: "asc" },
  });
  expect(rows).toEqual([
    { fromPath: ORIGINAL, toPageId: page.id },
    { fromPath: "platform/mqtt-contracts", toPageId: page.id },
  ]);
});

test("a redirect in a space the viewer cannot read resolves to null rather than revealing the target", async () => {
  const { page, platform, editor } = await movableFixture("MEMBERS");
  await move(editor, page.id, platform.id, "mqtt-contracts");

  // The member gets the redirect, so the row exists and is resolvable — without this line
  // the assertion below would also pass against a function that resolves nothing at all.
  expect(await resolveRedirect(editor, args(ORIGINAL))).not.toBeNull();

  // The non-member gets exactly what they get for a path that never existed. Both callers
  // ask about the same row: a different answer is what tells the outsider the page is real.
  expect(await resolveRedirect(stranger, args(ORIGINAL))).toBeNull();
  expect(await resolveRedirect(stranger, args("architecture/never-existed"))).toBeNull();
});

test("a redirect to a soft-deleted page 404s instead of delivering the reader to it", async () => {
  const { space, page, platform, editor } = await movableFixture("ALL_STAFF");
  await move(editor, page.id, platform.id, "mqtt-contracts");
  expect(await resolveRedirect(editor, args(ORIGINAL))).not.toBeNull();

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(await resolveRedirect(editor, args(ORIGINAL))).toBeNull();
  // Inert, not gone. Task 10 writes redirects for soft-deleted rows on purpose and Task 12's
  // restore is what makes them work again, so the row must survive the deletion.
  expect(await db.redirect.count({ where: { spaceId: space.id, fromPath: ORIGINAL } })).toBe(1);
});

/**
 * One hop, stated as a property of the resolution rather than of the data.
 *
 * A `Redirect` may legitimately sit at a live page's own path — dormant, shadowed by the page
 * on top of it, waiting for that page to move away. Here one sits at exactly the path the
 * first redirect resolves to. A resolver that looped "while a redirect exists at the answer"
 * would walk on to `decisions/adr-0042`; this one stops.
 */
test("no redirect chain is followed", async () => {
  const { space, author, page, platform, decisions, editor } = await movableFixture("ALL_STAFF");
  await move(editor, page.id, platform.id, "mqtt-contracts");

  const elsewhere = await db.page.create({
    data: {
      spaceId: space.id,
      parentId: decisions.id,
      slug: "adr-0042",
      path: "decisions/adr-0042",
      title: "MQTT topic naming",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  // Hand-written, because a correct move never produces it: this is the dormant row.
  await db.redirect.create({
    data: {
      spaceId: space.id,
      fromPath: "platform/mqtt-contracts",
      toPageId: elsewhere.id,
    },
  });

  expect(await resolveRedirect(editor, args(ORIGINAL))).toEqual({
    pageId: page.id,
    path: "platform/mqtt-contracts",
  });
});

/**
 * The self-redirect guard. A redirect standing at the live path of its own target would make
 * the reader redirect a URL to itself — which a browser follows until it gives up, the exact
 * production failure mode Step 2 of this task exists to rule out. Task 10's reclaiming
 * `deleteMany` is what stops the row existing; this is the second line of defence, and it is
 * only reachable when the page is a read miss for some other reason (here: unpublished).
 */
test("a redirect pointing at its own path resolves to null rather than to itself", async () => {
  const { space, author, editor } = await movableFixture("ALL_STAFF");
  const unpublished = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "draft-only",
      path: "draft-only",
      title: "Draft only",
      createdById: author.id,
    },
  });
  await db.redirect.create({
    data: { spaceId: space.id, fromPath: "draft-only", toPageId: unpublished.id },
  });

  expect(await getPublishedPage(editor, args("draft-only"))).toBeNull();
  expect(await resolveRedirect(editor, args("draft-only"))).toBeNull();
});

/**
 * The same-space constraint on the target, which is the other half of the `toPage` filter and
 * would otherwise be an untested clause. Nothing in the schema ties `Redirect.spaceId` to
 * `toPage.spaceId`; no current writer produces a mismatch, and a future one that did would
 * make this function answer a request for `/engineering/...` with a path that only exists in
 * `handbook` — a wrong URL, and a readable-space check that was never asked about the space
 * the reader actually lands in.
 */
test("a redirect pointing at a page in another space resolves to null", async () => {
  const { space, author, page, platform, editor } = await movableFixture("ALL_STAFF");
  await move(editor, page.id, platform.id, "mqtt-contracts");

  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  const welcome = await db.page.create({
    data: {
      spaceId: handbook.id,
      slug: "welcome",
      path: "welcome",
      title: "Welcome aboard",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  // Repointed rather than inserted, so the row is otherwise exactly what the move wrote and
  // the space of the target is the only thing that differs.
  await db.redirect.updateMany({
    where: { spaceId: space.id, fromPath: ORIGINAL },
    data: { toPageId: welcome.id },
  });

  // The handbook page is readable by everyone, so a permission check alone would let this
  // through — which is why this is a shape constraint and has its own test.
  expect(await getPublishedPage(stranger, { spaceKey: "handbook", path: "welcome" })).toBeNull();
  expect(await resolveRedirect(editor, args(ORIGINAL))).toBeNull();
});
