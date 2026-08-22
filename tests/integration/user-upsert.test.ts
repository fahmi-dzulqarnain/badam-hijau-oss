import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { upsertUserFromProfile } from "@/lib/users/upsert";

beforeEach(resetDb);

test("creates a user on first sign-in", async () => {
  const user = await upsertUserFromProfile({
    email: "nurul@example.com",
    name: "Nurul H.",
    avatarUrl: "https://example.com/n.png",
  });

  expect(user.email).toBe("nurul@example.com");
  expect(user.isSuperAdmin).toBe(false);
  expect(await db.user.count()).toBe(1);
});

test("updates the display name and avatar on later sign-ins without duplicating", async () => {
  await upsertUserFromProfile({ email: "wei@example.com", name: "Wei L." });
  const updated = await upsertUserFromProfile({
    email: "wei@example.com",
    name: "Wei Ling",
    avatarUrl: "https://example.com/w.png",
  });

  expect(updated.name).toBe("Wei Ling");
  expect(updated.avatarUrl).toBe("https://example.com/w.png");
  expect(await db.user.count()).toBe(1);
});

test("does not reset super-admin status on sign-in", async () => {
  const created = await upsertUserFromProfile({ email: "root@example.com", name: "Root" });
  await db.user.update({ where: { id: created.id }, data: { isSuperAdmin: true } });

  const again = await upsertUserFromProfile({ email: "root@example.com", name: "Root" });
  expect(again.isSuperAdmin).toBe(true);
});

test("falls back to the email local part when the provider sends no name", async () => {
  const user = await upsertUserFromProfile({ email: "noname@example.com", name: null });
  expect(user.name).toBe("noname");
});
