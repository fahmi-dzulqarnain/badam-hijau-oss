import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { viewerForEmail } from "@/lib/users/viewer";

beforeEach(resetDb);

test("carries every membership the user holds", async () => {
  const user = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN" },
  });
  const people = await db.space.create({
    data: { key: "people", name: "People", initials: "PP" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: user.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({
    data: { spaceId: people.id, userId: user.id, role: "VIEWER" },
  });

  const viewer = await viewerForEmail("aisyah@example.com");

  expect(viewer?.id).toBe(user.id);
  expect(viewer?.isSuperAdmin).toBe(false);
  expect(viewer?.memberships).toHaveLength(2);
  expect(viewer?.memberships.map((m) => m.role).sort()).toEqual(["EDITOR", "VIEWER"]);
});

test("matches the email case-insensitively", async () => {
  await db.user.create({ data: { email: "wei@example.com", name: "Wei L." } });
  expect(await viewerForEmail("WEI@Example.COM")).not.toBeNull();
});

test("returns null when a signed-in email has no local user row", async () => {
  expect(await viewerForEmail("ghost@example.com")).toBeNull();
});

test("carries super-admin status through", async () => {
  await db.user.create({
    data: { email: "root@example.com", name: "Root", isSuperAdmin: true },
  });
  expect((await viewerForEmail("root@example.com"))?.isSuperAdmin).toBe(true);
});
