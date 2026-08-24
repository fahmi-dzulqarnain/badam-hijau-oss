import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { deletePage } from "@/lib/pages/delete";
import { childPath } from "@/lib/pages/slug";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The restore endpoint. `restorePage` owns every decision — the `MANAGE_SPACE` permission,
 * the lock, the ancestor check, the all-or-nothing write predicate and the redirect reclaim —
 * so this file tests only the translation.
 *
 * Two of its answers are shaped differently from every other route in the phase, and both are
 * pinned here because the route is where a translation could quietly flatten them:
 *
 * - the **403 carries a message**, because the `EDIT`-deletes / `MANAGE_SPACE`-restores
 *   asymmetry is the one nobody can guess;
 * - a page that is **not deleted** is 422 and not 404, because the admin is looking straight
 *   at it and "no such page" would send them hunting.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  // A real row: a restore writes an `AuditLog` and `actorId` is a foreign key, so a synthetic
  // admin passes every permission check and then fails on the insert.
  const dara = await db.user.create({ data: { email: "dara@example.com", name: "Dara M." } });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });

  const page = async (parent: { id: string; path: string } | null, slug: string, title: string) =>
    db.page.create({
      data: {
        spaceId: space.id,
        parentId: parent?.id ?? null,
        slug,
        path: childPath(parent?.path ?? null, slug),
        title,
        createdById: aisyah.id,
        status: "CURRENT",
      },
      select: { id: true, path: true },
    });

  const architecture = await page(null, "architecture", "Architecture notes");
  const mqtt = await page(architecture, "mqtt-contracts", "MQTT contracts");
  const registry = await page(mqtt, "topic-registry", "Topic registry");

  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: dara.id, role: "ADMIN" },
  });

  const as = (id: string, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    architecture,
    mqtt,
    registry,
    asEditor: as(aisyah.id, "EDITOR"),
    asAdmin: as(dara.id, "ADMIN"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/pages/[pageId]/restore/route")).POST;
}

/** No body, deliberately — the endpoint reads none. */
function post(pageId: string) {
  return {
    request: new Request(`http://localhost/api/pages/${pageId}/restore`, { method: "POST" }),
    context: { params: Promise.resolve({ pageId }) },
  };
}

test("a restored subtree comes back with the reader URL, encoded per segment", async () => {
  const f = await fixture();
  // A space key and a parent segment that both need encoding, so a route that concatenated
  // instead of calling `pageHref` returns a broken href.
  await db.space.update({ where: { id: f.space.id }, data: { key: "eng ops" } });
  await db.page.update({
    where: { id: f.architecture.id },
    data: { slug: "architecture notes", path: "architecture notes" },
  });
  await db.page.update({
    where: { id: f.mqtt.id },
    data: { path: "architecture notes/mqtt-contracts" },
  });
  await db.page.update({
    where: { id: f.registry.id },
    data: { path: "architecture notes/mqtt-contracts/topic-registry" },
  });

  const deleted = await deletePage(f.asEditor, f.mqtt.id);
  if (!deleted.ok) throw new Error(`deletePage: ${JSON.stringify(deleted)}`);

  const POST = await routeAs(f.asAdmin);
  const { request, context } = post(f.mqtt.id);
  const response = await POST(request, context);
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body.path).toBe("architecture notes/mqtt-contracts");
  expect(body.href).toBe("/eng%20ops/architecture%20notes/mqtt-contracts");
  // The page and the descendant the same delete took, all or nothing.
  expect(body.restored).toBe(2);
  // The two redirects the delete wrote stood at paths that hold live pages again.
  expect(body.redirectsCleared).toBe(2);

  for (const id of [f.mqtt.id, f.registry.id]) {
    expect((await db.page.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  }
});

test("an unauthenticated caller gets 401 and nothing is restored", async () => {
  const f = await fixture();
  const deleted = await deletePage(f.asEditor, f.mqtt.id);
  if (!deleted.ok) throw new Error("deletePage failed");

  const POST = await routeAs(null);
  const { request, context } = post(f.mqtt.id);
  expect((await POST(request, context)).status).toBe(401);
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.mqtt.id } })).deletedAt,
  ).not.toBeNull();
});

/**
 * The permission asymmetry, rendered. This is the only 403 in the codebase with a message,
 * and the route passes the module's own sentence through rather than writing a second copy —
 * so a mutation that replaced it with a generic "you do not have permission" is visible here.
 */
test("the editor who deleted it gets 403 naming who can restore it", async () => {
  const f = await fixture();
  const deleted = await deletePage(f.asEditor, f.mqtt.id);
  if (!deleted.ok) throw new Error("deletePage failed");

  const POST = await routeAs(f.asEditor);
  const { request, context } = post(f.mqtt.id);
  const response = await POST(request, context);
  expect(response.status).toBe(403);

  const body = await response.json();
  expect(body.error).toBe("forbidden");
  expect(body.message).toMatch(/space admin/i);
  expect(body.message).toMatch(/any editor can delete/i);
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.mqtt.id } })).deletedAt,
  ).not.toBeNull();
});

test("a page in an unreadable space gets 404, byte-identical to one that never existed", async () => {
  const f = await fixture();
  const deleted = await deletePage(f.asEditor, f.mqtt.id);
  if (!deleted.ok) throw new Error("deletePage failed");

  const POST = await routeAs(stranger);
  const unreadable = post(f.mqtt.id);
  const missing = post("page-that-never-existed");
  const a = await POST(unreadable.request, unreadable.context);
  const b = await POST(missing.request, missing.context);

  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  expect(await a.json()).toEqual(await b.json());
});

test("restoring a page that is not deleted is 422 with a code, not 404", async () => {
  const f = await fixture();
  const POST = await routeAs(f.asAdmin);

  // The admin is looking at a live page. 404 would be a lie they can disprove by clicking it.
  const { request, context } = post(f.mqtt.id);
  const response = await POST(request, context);
  expect(response.status).toBe(422);

  const body = await response.json();
  expect(body).toMatchObject({ error: "invalid", code: "not-deleted" });
  expect(body.message).toBeTruthy();
  // No `field`: restore has no form, so there is nowhere to attach one.
  expect(body.field).toBeUndefined();
});

test("restoring under a still-deleted ancestor is 422 and changes nothing", async () => {
  const f = await fixture();
  // Delete the child first so it carries its own stamp, then the parent — so the child is a
  // separate delete set and can be asked for on its own.
  const child = await deletePage(f.asEditor, f.registry.id);
  if (!child.ok) throw new Error("deletePage failed");
  const parent = await deletePage(f.asEditor, f.mqtt.id);
  if (!parent.ok) throw new Error("deletePage failed");

  const POST = await routeAs(f.asAdmin);
  const { request, context } = post(f.registry.id);
  const response = await POST(request, context);
  expect(response.status).toBe(422);

  const body = await response.json();
  expect(body.code).toBe("ancestor-deleted");
  // The message names the shallowest deleted ancestor, because otherwise `buildTree` promotes
  // the parentless node to a root and it surfaces as a bogus top-level module.
  expect(body.message).toContain("MQTT contracts");
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: f.registry.id } })).deletedAt,
  ).not.toBeNull();
});
