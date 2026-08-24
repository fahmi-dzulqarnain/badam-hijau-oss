import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { childPath } from "@/lib/pages/slug";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The delete endpoint. `deletePage` owns every decision — the `EDIT` permission, the lock,
 * the subtree stamp, the redirect to the nearest surviving ancestor and the 404-not-403 line
 * — so this file tests only the translation: which status code each outcome becomes, and that
 * the two paths it hands back are hrefs built by `pageHref` rather than concatenated strings.
 *
 * It reads no body, which is why there is no 411/413 pair here and there is one in
 * `move-route.test.ts`. Publish has none for the same reason.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
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

  const as = (role: "VIEWER" | "EDITOR"): Viewer => ({
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    aisyah,
    architecture,
    mqtt,
    registry,
    asEditor: as("EDITOR"),
    asViewer: as("VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/pages/[pageId]/delete/route")).POST;
}

/** No body, deliberately — the endpoint reads none. See the route's docstring. */
function post(pageId: string) {
  return {
    request: new Request(`http://localhost/api/pages/${pageId}/delete`, { method: "POST" }),
    context: { params: Promise.resolve({ pageId }) },
  };
}

test("a deleted page reports its subtree and where its old URL now points", async () => {
  const { space, mqtt, registry, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const { request, context } = post(mqtt.id);
  const response = await POST(request, context);
  expect(response.status).toBe(200);

  const body = await response.json();
  // Two rows: the page and its one descendant. The number is what tells the surface that
  // asked whether it took one page or a branch.
  expect(body.deleted).toBe(2);
  expect(body.redirects).toBe(2);
  expect(body.path).toBe("architecture/mqtt-contracts");
  // The nearest surviving ancestor, as a path and as a link to it.
  expect(body.redirectTo).toBe("architecture");
  expect(body.redirectHref).toBe("/engineering/architecture");
  expect(body.spaceHref).toBe("/engineering");

  for (const id of [mqtt.id, registry.id]) {
    expect((await db.page.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
  }
  expect(await db.redirect.count({ where: { spaceId: space.id } })).toBe(2);
});

test("a deleted root page reports redirectTo as an explicit null", async () => {
  const { architecture, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const { request, context } = post(architecture.id);
  const body = await (await POST(request, context)).json();

  // `Redirect.toPageId` is not nullable and a root has no surviving ancestor, so there is
  // genuinely nowhere to send the old URL. Emitted as null rather than omitted, so a client
  // can tell "no ancestor" from a truncated body — and paired with `spaceHref`, which is the
  // one place a surface can still send someone.
  expect(body.redirectTo).toBeNull();
  expect(body.redirectHref).toBeNull();
  expect(body.spaceHref).toBe("/engineering");
  expect(body.redirects).toBe(0);
  expect(body.deleted).toBe(3);
  expect(await db.redirect.count()).toBe(0);
});

test("an unauthenticated caller gets 401 and nothing is deleted", async () => {
  const { mqtt } = await fixture();
  const POST = await routeAs(null);

  const { request, context } = post(mqtt.id);
  expect((await POST(request, context)).status).toBe(401);
  expect(await db.page.count({ where: { deletedAt: { not: null } } })).toBe(0);
});

test("a VIEWER gets 403 and nothing is deleted", async () => {
  const { space, mqtt, aisyah, asViewer } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: aisyah.id } },
    data: { role: "VIEWER" },
  });
  const POST = await routeAs(asViewer);

  const { request, context } = post(mqtt.id);
  expect((await POST(request, context)).status).toBe(403);
  expect(await db.page.count({ where: { deletedAt: { not: null } } })).toBe(0);
  expect(await db.redirect.count()).toBe(0);
});

test("a page in an unreadable space gets 404, byte-identical to one that never existed", async () => {
  const { mqtt } = await fixture();
  const POST = await routeAs(stranger);

  const unreadable = post(mqtt.id);
  const missing = post("page-that-never-existed");
  const a = await POST(unreadable.request, unreadable.context);
  const b = await POST(missing.request, missing.context);

  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  expect(await a.json()).toEqual(await b.json());
});

test("deleting an already-deleted page is 404, not a second delete", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const first = post(mqtt.id);
  expect((await POST(first.request, first.context)).status).toBe(200);

  // Already gone is the same statement about the world as never existed: there is no such
  // live page. It is also what makes this endpoint safe to retry.
  const second = post(mqtt.id);
  expect((await POST(second.request, second.context)).status).toBe(404);
  expect(await db.redirect.count()).toBe(2);
});
