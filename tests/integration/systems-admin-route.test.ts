import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The `/api/admin/systems` endpoints — Phase 7 Task 5.
 *
 * `src/lib/systems/admin.ts` owns every decision, so this file tests only the translation, and the
 * four answers where a translation could quietly flatten something:
 *
 * - the **refusal is 404 and carries no admin-specific sentence**, so a signed-in member cannot
 *   tell "you may not" from "there is no such endpoint" — which is the point of `refuseNonAdmin`
 *   answering not-found, and the exit criterion Task 9 will assert over real HTTP;
 * - the **409 carries the module's own sentence verbatim**, plus the count and `isActive`, because
 *   the alternative it offers is the whole reason Task 1 could choose `Restrict`;
 * - the **422 carries per-field errors**, since the form renders each one beside its input;
 * - `PATCH` is a patch: a body naming one field changes one field.
 */

async function fixture() {
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "ADMIN" },
  });

  const hubCore = await db.system.create({
    data: { key: "order-hub", name: "Order hub", kind: "LIBRARY" },
    select: { id: true },
  });

  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "topic-registry",
      path: "topic-registry",
      title: "Topic registry",
      createdById: aisyah.id,
      status: "CURRENT",
    },
    select: { id: true },
  });
  await db.pageSystem.create({ data: { pageId: page.id, systemId: hubCore.id } });

  return {
    hubCore,
    asRoot: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    asSpaceAdmin: {
      id: aisyah.id,
      isSuperAdmin: false,
      memberships: [{ spaceId: space.id, role: "ADMIN" }],
    } satisfies Viewer,
  };
}

async function collectionAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/admin/systems/route")).POST;
}

async function itemAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return import("@/app/api/admin/systems/[id]/route");
}

const body = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const newSystem = {
  key: "admin-web",
  name: "Admin web",
  kind: "SERVICE",
  ownerTeam: "",
  description: "",
  repoUrl: "",
};

test("a super admin creates a system and gets 201 with its key", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asRoot);

  const response = await POST(
    new Request("http://localhost/api/admin/systems", body(newSystem)),
  );
  expect(response.status).toBe(201);
  expect((await response.json()).key).toBe("admin-web");
  expect(await db.system.count()).toBe(2);
});

/**
 * **The refusal, and the shape of it is the assertion.** A `403` would tell an ordinary member
 * that this endpoint exists and that they are the wrong sort of person; the 404 body is the one
 * every other miss in the product returns, word for word.
 *
 * The viewer is an `ADMIN` of a real space rather than a stranger, for the reason
 * `src/lib/admin/gate.test.ts` states: a member of nothing is refused by any predicate at all.
 */
test("a space ADMIN gets 404 with nothing admin-shaped in it, and writes nothing", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asSpaceAdmin);

  const response = await POST(
    new Request("http://localhost/api/admin/systems", body(newSystem)),
  );
  expect(response.status).toBe(404);
  const payload = await response.json();
  expect(payload).toEqual({ error: "not-found", message: "That page does not exist." });
  expect(JSON.stringify(payload)).not.toMatch(/admin|forbidden|permission/i);
  expect(await db.system.count()).toBe(1);
});

test("a signed-out caller gets 401", async () => {
  await fixture();
  const POST = await collectionAs(null);
  const response = await POST(
    new Request("http://localhost/api/admin/systems", body(newSystem)),
  );
  expect(response.status).toBe(401);
  expect(await db.system.count()).toBe(1);
});

/**
 * `z.strictObject`: a mistyped key is refused rather than stripped — one word between refusing a
 * typo and storing a system with no owning team the admin thought they had given it.
 */
test("an unknown field in the body is a 400, not a silently dropped value", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asRoot);
  const response = await POST(
    new Request(
      "http://localhost/api/admin/systems",
      body({ ...newSystem, ownerteam: "Platform" }),
    ),
  );
  expect(response.status).toBe(400);
  expect(await db.system.count()).toBe(1);
});

test("a field error is a 422 carrying the field, the code and the sentence", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asRoot);
  const response = await POST(
    new Request(
      "http://localhost/api/admin/systems",
      body({ ...newSystem, key: "Admin Web", repoUrl: "https://tok@example.com/x.git" }),
    ),
  );
  expect(response.status).toBe(422);
  const errors = (await response.json()).errors as { field: string; code: string }[];
  expect(errors.map((error) => error.field).sort()).toEqual(["key", "repoUrl"]);
  expect(errors.find((error) => error.field === "repoUrl")?.code).toBe("repo-credentials");
  expect(await db.system.count()).toBe(1);
});

/**
 * The refused delete over HTTP: `409`, the module's sentence verbatim, and the two values the
 * surface builds its alternative from.
 */
test("deleting a referenced system is 409 with the count and the alternative", async () => {
  const f = await fixture();
  const { DELETE } = await itemAs(f.asRoot);

  const response = await DELETE(
    new Request(`http://localhost/api/admin/systems/${f.hubCore.id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: f.hubCore.id }) },
  );
  expect(response.status).toBe(409);
  const payload = await response.json();
  expect(payload.references).toBe(1);
  expect(payload.isActive).toBe(true);
  expect(payload.message).toContain("1 page");
  expect(payload.message).toContain("sunsetting");
  expect(await db.system.count()).toBe(1);
});

/**
 * `PATCH` is a patch, and this is the assertion that pins it: one field in the body, one column
 * changed, and in particular a `key` that was not sent is not cleared.
 */
test("a PATCH naming one field changes one field", async () => {
  const f = await fixture();
  const { PATCH } = await itemAs(f.asRoot);

  const response = await PATCH(
    new Request(`http://localhost/api/admin/systems/${f.hubCore.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    }),
    { params: Promise.resolve({ id: f.hubCore.id }) },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).renamedFrom).toBeNull();

  const row = await db.system.findUniqueOrThrow({
    where: { id: f.hubCore.id },
    select: { key: true, name: true, isActive: true },
  });
  expect(row).toEqual({ key: "order-hub", name: "Order hub", isActive: false });
});

/**
 * The audited listing behind its own endpoint, and the refusal shape again — this is the one
 * request on the surface that reads titles out of a space the admin may not belong to.
 */
test("the blocking-pages endpoint lists titles for an admin and 404s for anyone else", async () => {
  const f = await fixture();

  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => f.asRoot }));
  const asAdmin = (await import("@/app/api/admin/systems/[id]/pages/route")).GET;
  const allowed = await asAdmin(
    new Request(`http://localhost/api/admin/systems/${f.hubCore.id}/pages`),
    { params: Promise.resolve({ id: f.hubCore.id }) },
  );
  expect(allowed.status).toBe(200);
  const listed = await allowed.json();
  expect(listed.pages.map((page: { title: string }) => page.title)).toEqual(["Topic registry"]);

  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => f.asSpaceAdmin }));
  const asMember = (await import("@/app/api/admin/systems/[id]/pages/route")).GET;
  const refused = await asMember(
    new Request(`http://localhost/api/admin/systems/${f.hubCore.id}/pages`),
    { params: Promise.resolve({ id: f.hubCore.id }) },
  );
  expect(refused.status).toBe(404);
  // Byte-identical to the answer for a system id that names nothing.
  expect(await refused.json()).toEqual({
    error: "not-found",
    message: "That page does not exist.",
  });
});
