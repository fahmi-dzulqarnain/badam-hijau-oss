import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };
const root: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

async function fixture() {
  const member = await db.user.create({
    data: { email: "member@example.com", name: "Member" },
  });
  const open = await db.space.create({
    data: {
      key: "handbook",
      name: "Handbook planning",
      initials: "HB",
      visibility: "ALL_STAFF",
    },
  });
  const closed = await db.space.create({
    data: {
      key: "layoffs",
      name: "Layoffs 2027 planning",
      initials: "LO",
      visibility: "MEMBERS",
    },
  });
  return { member, open, closed };
}

test("a caller's own OR cannot displace the permission predicate", async () => {
  await fixture();

  // The natural way to write space search. Written as a spread of a bare `OR` fragment,
  // this returned the MEMBERS space to a non-member.
  const rows = await db.space.findMany({
    where: readableSpace(stranger, {
      OR: [{ name: { contains: "planning" } }, { key: { contains: "planning" } }],
    }),
    select: { key: true },
  });

  const keys = rows.map((row) => row.key);
  expect(keys).toContain("handbook");
  expect(keys).not.toContain("layoffs");
});

test("a super admin sees members-only spaces through the same helper", async () => {
  await fixture();

  const rows = await db.space.findMany({
    where: readableSpace(root),
    select: { key: true },
  });

  expect(rows.map((row) => row.key).sort()).toEqual(["handbook", "layoffs"]);
});

test("can(READ) agrees with the SQL predicate for every viewer and visibility", async () => {
  const { member, open, closed } = await fixture();
  await db.spaceMembership.create({
    data: { spaceId: closed.id, userId: member.id, role: "VIEWER" },
  });

  const viewers: { label: string; viewer: Viewer }[] = [
    { label: "stranger", viewer: stranger },
    { label: "super admin", viewer: root },
    {
      label: "member of the closed space",
      viewer: {
        id: member.id,
        isSuperAdmin: false,
        memberships: [{ spaceId: closed.id, role: "VIEWER" }],
      },
    },
  ];

  for (const { label, viewer } of viewers) {
    const rows = await db.space.findMany({
      where: readableSpace(viewer),
      select: { id: true },
    });
    const visible = new Set(rows.map((row) => row.id));

    for (const space of [open, closed]) {
      const ref: SpaceRef = { id: space.id, visibility: space.visibility };
      expect(
        visible.has(space.id),
        `${label} / ${space.key}: can() and the SQL predicate disagree`,
      ).toBe(can(viewer, ref, "READ"));
    }
  }
});
