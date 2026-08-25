import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The publish endpoint. `publishPage` owns every decision here, so this file tests only the
 * translation: which status code each refusal becomes, and that the reader URL the client
 * navigates to is built by `pageHref` rather than concatenated.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      visibility: "MEMBERS",
    },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt-contracts",
      // A path with a segment that has to be encoded, so a route that concatenates instead
      // of calling `pageHref` returns a broken href and this file notices.
      path: "architecture/mqtt contracts",
      title: "MQTT contracts (working title)",
      createdById: aisyah.id,
      status: "DRAFT",
    },
  });
  await db.pageDraft.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "Every topic is namespaced by outlet.\n",
      updatedById: aisyah.id,
    },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });

  const as = (role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return { space, page, aisyah, asEditor: as("EDITOR"), asViewer: as("VIEWER") };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Loads the route with a given signed-in viewer. */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/pages/[pageId]/publish/route")).POST;
}

/** No body, deliberately — the endpoint reads none. See the route's docstring. */
function post(pageId: string) {
  return {
    request: new Request(`http://localhost/api/pages/${pageId}/publish`, { method: "POST" }),
    context: { params: Promise.resolve({ pageId }) },
  };
}

test("a published page comes back with the reader URL, encoded per segment", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const { request, context } = post(page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body.title).toBe("MQTT contracts");
  expect(body.status).toBe("CURRENT");
  // `pageHref`: the space key and every path segment encoded, the separators kept. A route
  // that built this with a template string would return the unencoded space here.
  expect(body.href).toBe("/engineering/architecture/mqtt%20contracts");
  expect(body.versionId).toEqual(expect.any(String));

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBe(body.versionId);
});

/**
 * Phase 3 Task 11. The editor's dormant-cascade notice is rendered from this key, so it has to
 * cross the boundary — and it has to be here on the ordinary publish too, empty, or an editor
 * cannot tell "nothing was dormant" from "the server does not send this".
 */
test("the success body always carries a dormant list", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const { request, context } = post(page.id);
  const body = await (await POST(request, context)).json();
  expect(body.dormant).toEqual([]);
});

test("an unauthenticated caller gets 401 and nothing is published", async () => {
  const { page } = await fixture();
  const POST = await routeAs(null);

  const { request, context } = post(page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(401);
  expect(await db.pageVersion.count()).toBe(0);
});

test("a VIEWER gets 403", async () => {
  const { space, page, aisyah, asViewer } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: aisyah.id } },
    data: { role: "VIEWER" },
  });
  const POST = await routeAs(asViewer);

  const { request, context } = post(page.id);
  expect((await POST(request, context)).status).toBe(403);
  expect(await db.pageVersion.count()).toBe(0);
});

test("a page in an unreadable space gets 404, byte-identical to one that never existed", async () => {
  const { page } = await fixture();
  const POST = await routeAs(stranger);

  const unreadable = post(page.id);
  const missing = post("page-that-never-existed");
  const a = await POST(unreadable.request, unreadable.context);
  const b = await POST(missing.request, missing.context);

  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  // The whole point of the 404: the two answers must be indistinguishable, body included.
  expect(await a.json()).toEqual(await b.json());
});

/**
 * 422, not 400 and not 500. The request is well formed — there is no body to malform — and
 * the refusal is about the draft it names, which is something the person can fix.
 */
test("an empty title is 422 with the field, the code and the sentence", async () => {
  const { page, asEditor } = await fixture();
  await db.pageDraft.update({ where: { pageId: page.id }, data: { title: "  " } });
  const POST = await routeAs(asEditor);

  const { request, context } = post(page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(422);

  const body = await response.json();
  expect(body).toMatchObject({ error: "invalid", field: "title", code: "title-empty" });
  // The editor renders this verbatim, so an empty one would be a banner saying nothing.
  expect(body.message).toMatch(/title/i);

  expect(await db.pageVersion.count()).toBe(0);
});

test("publishing an already-published page is 422, not 500", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const first = post(page.id);
  expect((await POST(first.request, first.context)).status).toBe(200);

  const second = post(page.id);
  const response = await POST(second.request, second.context);
  expect(response.status).toBe(422);
  expect((await response.json()).code).toBe("no-draft");
  expect(await db.pageVersion.count()).toBe(1);
});
