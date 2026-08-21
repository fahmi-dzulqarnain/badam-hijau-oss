import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { getPublishedPage, getReadableSpaceByKey, listSpacePages } from "@/lib/pages/repo";
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

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

test("an all-staff page is readable by a non-member", async () => {
  await fixture("ALL_STAFF");
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: stranger,
  });
  expect(result?.version.markdown).toContain("One namespace.");
});

test("a members-only page is not readable by a non-member", async () => {
  await fixture("MEMBERS");
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: stranger,
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
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer,
  });
  expect(result?.page.title).toBe("MQTT contracts");
});

test("a super admin can read a members-only page", async () => {
  await fixture("MEMBERS");
  const root: Viewer = { id: "root", isSuperAdmin: true, memberships: [] };
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: root,
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
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/draft-only",
    viewer: stranger,
  });
  expect(result).toBeNull();
});

test("an unreadable space key resolves to null rather than an error", async () => {
  await fixture("MEMBERS");
  expect(await getReadableSpaceByKey("engineering", stranger)).toBeNull();
  expect(await getReadableSpaceByKey("nonexistent", stranger)).toBeNull();
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
