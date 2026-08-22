import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { resolveReportContext } from "@/lib/bugs/context";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const stranger: Viewer = { id: "nobody", isSuperAdmin: false, memberships: [] };

async function fixture() {
  const author = await db.user.create({
    data: { email: "author@example.com", name: "Author" },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt",
      path: "architecture/mqtt",
      title: "MQTT",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT",
      markdown: "hi",
      status: "CURRENT",
      authorId: author.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });

  const member: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  };
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "VIEWER" },
  });

  return { space, page, version, member };
}

test("resolves space, page and version from a page route", async () => {
  const { space, page, version, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering/architecture/mqtt")).toEqual({
    spaceId: space.id,
    pageId: page.id,
    versionId: version.id,
  });
});

test("resolves the space alone from a space route", async () => {
  const { space, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering")).toEqual({
    spaceId: space.id,
    pageId: null,
    versionId: null,
  });
});

test("gives a non-member nothing, even for a real page", async () => {
  await fixture();

  // The whole point: a reporter cannot attach context from a space they cannot read.
  expect(await resolveReportContext(stranger, "/engineering/architecture/mqtt")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
});

test("returns nulls for an unrecognised route rather than throwing", async () => {
  const { member } = await fixture();

  expect(await resolveReportContext(member, "/")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
  expect(await resolveReportContext(member, "/nonexistent/page")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
});

test("keeps the space when the page path does not resolve", async () => {
  const { space, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering/gone/missing")).toEqual({
    spaceId: space.id,
    pageId: null,
    versionId: null,
  });
});
