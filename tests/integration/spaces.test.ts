import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";

beforeEach(resetDb);

test("a space can be created with a member and read back", async () => {
  const user = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      visibility: "MEMBERS",
      memberships: { create: { userId: user.id, role: "EDITOR" } },
    },
    include: { memberships: true },
  });

  expect(space.key).toBe("engineering");
  expect(space.memberships).toHaveLength(1);
  expect(space.memberships[0]?.role).toBe("EDITOR");
});

test("a user cannot hold two memberships in the same space", async () => {
  const user = await db.user.create({
    data: { email: "wei@example.com", name: "Wei L." },
  });
  const space = await db.space.create({
    data: { key: "hr", name: "People", initials: "HR" },
  });

  await db.spaceMembership.create({ data: { spaceId: space.id, userId: user.id } });

  await expect(
    db.spaceMembership.create({ data: { spaceId: space.id, userId: user.id } }),
  ).rejects.toThrow();
});
