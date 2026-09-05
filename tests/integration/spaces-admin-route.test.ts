import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The `/api/admin/spaces` endpoints — Phase 7 Task 6.
 *
 * `src/lib/spaces/admin.ts` owns every decision, so this file tests only the translation, and the
 * answers where a translation could quietly flatten something:
 *
 * - the **refusal is 404 and carries no admin-specific sentence**, so a signed-in member cannot
 *   tell "you may not" from "there is no such endpoint";
 * - the **422 carries per-field errors**, since the form renders each one beside its input — and
 *   on this surface one of those errors is the route-shadowing refusal, which is the whole of
 *   Step 2 arriving over HTTP;
 * - `PATCH` is a patch: a body naming one field changes one field and leaves the rest;
 * - the membership endpoints echo `admins`, the number that says whether anybody in the space can
 *   still manage it.
 */

async function fixture() {
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      description: "How we build things.",
      visibility: "MEMBERS",
    },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "ADMIN" },
  });

  return {
    space,
    aisyah,
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
  return (await import("@/app/api/admin/spaces/route")).POST;
}

async function itemAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return import("@/app/api/admin/spaces/[id]/route");
}

async function membersAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return import("@/app/api/admin/spaces/[id]/members/route");
}

async function memberAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return import("@/app/api/admin/spaces/[id]/members/[userId]/route");
}

const send = (method: string, value?: unknown) => ({
  method,
  ...(value === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
});

const request = (path: string, init: RequestInit) =>
  new Request(`http://localhost${path}`, init);

const space = {
  key: "product",
  name: "Product",
  initials: "PR",
  description: "",
  visibility: "MEMBERS" as const,
};

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

test("a signed-in member gets 404 from every endpoint, and a super admin does not", async () => {
  const f = await fixture();
  const id = { params: Promise.resolve({ id: f.space.id }) };
  const member = { params: Promise.resolve({ id: f.space.id, userId: f.aisyah.id }) };

  const POST = await collectionAs(f.asSpaceAdmin);
  expect((await POST(request("/api/admin/spaces", send("POST", space)))).status).toBe(404);

  const item = await itemAs(f.asSpaceAdmin);
  expect(
    (await item.PATCH(request("/api/admin/spaces/x", send("PATCH", { name: "X" })), id)).status,
  ).toBe(404);

  const members = await membersAs(f.asSpaceAdmin);
  expect((await members.GET(request("/x/members", send("GET")), id)).status).toBe(404);
  expect(
    (
      await members.POST(
        request("/x/members", send("POST", { email: "a@example.com", role: "VIEWER" })),
        id,
      )
    ).status,
  ).toBe(404);

  const one = await memberAs(f.asSpaceAdmin);
  expect(
    (await one.PATCH(request("/x/members/y", send("PATCH", { role: "VIEWER" })), member)).status,
  ).toBe(404);
  expect((await one.DELETE(request("/x/members/y", send("DELETE")), member)).status).toBe(404);

  // The non-vacuity companion. Without it, six 404s are consistent with six endpoints that do not
  // exist — which is exactly what a 404 means, and why it takes two viewers to tell them apart.
  const allowed = await membersAs(f.asRoot);
  expect((await allowed.GET(request("/x/members", send("GET")), id)).status).toBe(200);
});

test("the 404 body says nothing an ordinary member could not have guessed", async () => {
  const f = await fixture();
  const members = await membersAs(f.asSpaceAdmin);
  const refused = await members.GET(request("/x/members", send("GET")), {
    params: Promise.resolve({ id: f.space.id }),
  });
  const body = await refused.json();
  expect(body).toEqual({ error: "not-found", message: "That page does not exist." });
  // Never `403`, and never a word about permission — `src/lib/admin/gate.ts` carries the argument.
  expect(JSON.stringify(body)).not.toContain("admin");
});

test("a signed-out caller gets 401, which every write endpoint in this product answers", async () => {
  await fixture();
  const POST = await collectionAs(null);
  const response = await POST(request("/api/admin/spaces", send("POST", space)));
  expect(response.status).toBe(401);
  expect(await db.space.count()).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

test("201 with the id and key, and 422 with the route-shadowing sentence", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asRoot);

  const created = await POST(request("/api/admin/spaces", send("POST", space)));
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ key: "product" });

  const refused = await POST(
    request("/api/admin/spaces", send("POST", { ...space, key: "systems" })),
  );
  expect(refused.status).toBe(422);
  const body = await refused.json();
  expect(body.errors.map((e: { field: string; code: string }) => [e.field, e.code])).toEqual([
    ["key", "reserved"],
  ]);
  expect(await db.space.count()).toBe(2);
});

test("a body this endpoint cannot read is 400, and an unknown key is refused rather than dropped", async () => {
  const f = await fixture();
  const POST = await collectionAs(f.asRoot);

  expect(
    (await POST(request("/api/admin/spaces", { method: "POST", body: "not json" }))).status,
  ).toBe(400);

  // `z.strictObject`, never `z.object`: a mistyped `initals:` is refused rather than stripped and
  // then reported as a missing required field the admin did fill in.
  const typo = await POST(
    request("/api/admin/spaces", send("POST", { ...space, initals: "PR" })),
  );
  expect(typo.status).toBe(400);
  expect(await db.space.count()).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* Patch                                                                       */
/* -------------------------------------------------------------------------- */

test("a PATCH naming one field changes one field, and echoes what the change was", async () => {
  const f = await fixture();
  const item = await itemAs(f.asRoot);
  const id = { params: Promise.resolve({ id: f.space.id }) };

  const response = await item.PATCH(
    request("/api/admin/spaces/x", send("PATCH", { visibility: "ALL_STAFF" })),
    id,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    key: "engineering",
    renamedFrom: null,
    visibilityWas: "MEMBERS",
  });

  const after = await db.space.findUniqueOrThrow({
    where: { id: f.space.id },
    select: { key: true, name: true, description: true, visibility: true },
  });
  expect(after).toEqual({
    key: "engineering",
    name: "Engineering",
    // Untouched: a patch is not a replacement, and a replacement form would have sent `""` here.
    description: "How we build things.",
    visibility: "ALL_STAFF",
  });
});

test("a PATCH for a space that does not exist is the same 404 a member gets", async () => {
  const f = await fixture();
  const item = await itemAs(f.asRoot);
  const response = await item.PATCH(
    request("/api/admin/spaces/x", send("PATCH", { name: "X" })),
    { params: Promise.resolve({ id: "no-such-space" }) },
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: "not-found",
    message: "That page does not exist.",
  });
});

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

test("the member endpoints add, promote and remove, echoing what is left", async () => {
  const f = await fixture();
  const id = { params: Promise.resolve({ id: f.space.id }) };

  const members = await membersAs(f.asRoot);
  const listed = await members.GET(request("/x/members", send("GET")), id);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({
    key: "engineering",
    truncated: false,
    members: [{ email: "aisyah@example.com", role: "ADMIN" }],
  });

  const dara = await db.user.create({
    data: { email: "dara@example.com", name: "Dara M." },
    select: { id: true },
  });
  const added = await members.POST(
    request("/x/members", send("POST", { email: "dara@example.com", role: "VIEWER" })),
    id,
  );
  expect(added.status).toBe(201);
  expect(await added.json()).toMatchObject({ userId: dara.id, role: "VIEWER", admins: 1 });

  const one = await memberAs(f.asRoot);
  const member = { params: Promise.resolve({ id: f.space.id, userId: f.aisyah.id }) };

  const demoted = await one.PATCH(
    request("/x/members/y", send("PATCH", { role: "VIEWER" })),
    member,
  );
  expect(demoted.status).toBe(200);
  // Nobody can manage the space any more, and the number says so rather than a refusal preventing
  // it — refusing would make the last admin unoffboardable.
  expect(await demoted.json()).toMatchObject({ previousRole: "ADMIN", admins: 0 });

  const removed = await one.DELETE(request("/x/members/y", send("DELETE")), member);
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ role: "VIEWER", admins: 0 });
  expect(await db.spaceMembership.count({ where: { spaceId: f.space.id } })).toBe(1);
});

test("an address nobody has signed in with is 422 on the email field", async () => {
  const f = await fixture();
  const members = await membersAs(f.asRoot);
  const response = await members.POST(
    request("/x/members", send("POST", { email: "nobody@example.com", role: "ADMIN" })),
    { params: Promise.resolve({ id: f.space.id }) },
  );
  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body.errors.map((e: { field: string; code: string }) => [e.field, e.code])).toEqual([
    ["email", "no-such-user"],
  ]);
  expect(await db.spaceMembership.count({ where: { spaceId: f.space.id } })).toBe(1);
});

test("a role outside SpaceRole is refused by shape, before any rule runs", async () => {
  const f = await fixture();
  const one = await memberAs(f.asRoot);
  const response = await one.PATCH(
    request("/x/members/y", send("PATCH", { role: "OWNER" })),
    { params: Promise.resolve({ id: f.space.id, userId: f.aisyah.id }) },
  );
  expect(response.status).toBe(400);
  const membership = await db.spaceMembership.findFirstOrThrow({ select: { role: true } });
  expect(membership.role).toBe("ADMIN");
});
