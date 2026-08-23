import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  getPublishedPage,
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
} from "@/lib/pages/repo";
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
