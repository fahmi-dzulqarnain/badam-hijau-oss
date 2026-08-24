import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { childPath } from "@/lib/pages/slug";
import { MAX_MOVE_BODY_BYTES } from "@/lib/pages/move-schema";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The move endpoint. `movePage` owns every decision here — the permission, the cycle check,
 * the occupancy check, the lock, the rewrite, the redirects — so this file tests only the
 * translation: which status code each outcome becomes, that the reader URL is built by
 * `pageHref` rather than concatenated, and that a body exists and is bounded before it is
 * read.
 *
 * What it deliberately does NOT re-test is *why* each refusal happens. `page-move.test.ts`
 * pins that against a real tree; asserting it twice here would create a second place to
 * update when the rule changes, and this project has already measured what a predicate stated
 * twice costs — neither copy is testable.
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
  const platform = await page(null, "platform", "Platform group");

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
    platform,
    asEditor: as("EDITOR"),
    asViewer: as("VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Loads the route with a given signed-in viewer. */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/pages/[pageId]/move/route")).POST;
}

/**
 * A well-formed request, with the header the size guard actually reads.
 *
 * `Content-Length` is set explicitly and counted in **bytes** — `TextEncoder`, not
 * `String.length` — which is the same thing `draft-route.test.ts` does and for the same
 * reason: the guard is a byte guard, and a test that declared UTF-16 units would pass while
 * measuring the wrong quantity.
 */
function post(pageId: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return {
    request: new Request(`http://localhost/api/pages/${pageId}/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(payload).length),
        ...headers,
      },
      body: payload,
    }),
    context: { params: Promise.resolve({ pageId }) },
  };
}

test("a moved page comes back with the reader URL, encoded per segment", async () => {
  const { mqtt, registry, platform, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // A slug that needs no encoding under a parent path that does: the space key and every
  // segment are encoded by `pageHref`, and a route that built this with a template string
  // would return something a browser resolves differently.
  await db.page.update({
    where: { id: platform.id },
    data: { slug: "platform group", path: "platform group" },
  });

  const { request, context } = post(mqtt.id, {
    newParentId: platform.id,
    newSlug: "mqtt-contracts",
  });
  const response = await POST(request, context);
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body.path).toBe("platform group/mqtt-contracts");
  expect(body.previousPath).toBe("architecture/mqtt-contracts");
  expect(body.href).toBe("/engineering/platform%20group/mqtt-contracts");
  // The page and its one descendant. The number is the difference between a rename and a
  // reorganisation and nothing else on the wire says it.
  expect(body.rewritten).toBe(2);
  expect(body.redirects).toBe(2);

  expect(
    (await db.page.findUniqueOrThrow({ where: { id: registry.id } })).path,
  ).toBe("platform group/mqtt-contracts/topic-registry");
});

test("an unauthenticated caller gets 401 and nothing moves", async () => {
  const { mqtt } = await fixture();
  const POST = await routeAs(null);

  const { request, context } = post(mqtt.id, { newParentId: null, newSlug: "moved" });
  expect((await POST(request, context)).status).toBe(401);
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
  expect(await db.redirect.count()).toBe(0);
});

test("a VIEWER gets 403 and nothing moves", async () => {
  const { space, mqtt, aisyah, asViewer } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: aisyah.id } },
    data: { role: "VIEWER" },
  });
  const POST = await routeAs(asViewer);

  const { request, context } = post(mqtt.id, { newParentId: null, newSlug: "moved" });
  expect((await POST(request, context)).status).toBe(403);
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
  expect(await db.redirect.count()).toBe(0);
});

test("a page in an unreadable space gets 404, byte-identical to one that never existed", async () => {
  const { mqtt } = await fixture();
  const POST = await routeAs(stranger);

  const unreadable = post(mqtt.id, { newParentId: null, newSlug: "moved" });
  const missing = post("page-that-never-existed", { newParentId: null, newSlug: "moved" });
  const a = await POST(unreadable.request, unreadable.context);
  const b = await POST(missing.request, missing.context);

  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
  // The whole point of the 404: the two answers must be indistinguishable, body included.
  expect(await a.json()).toEqual(await b.json());
});

/**
 * 422, not 400 and not 500. The request is well formed; the refusal is about the tree it
 * describes, and every one of these is something the person can fix from the form they are
 * looking at — which is why `field` and `code` travel with the sentence.
 */
test("an occupied target path is 422 with the field, the code and the sentence", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // `platform` already holds this path.
  const { request, context } = post(mqtt.id, { newParentId: null, newSlug: "platform" });
  const response = await POST(request, context);
  expect(response.status).toBe(422);

  const body = await response.json();
  expect(body).toMatchObject({ error: "invalid", field: "slug", code: "path-occupied" });
  // Rendered verbatim by the form, so an empty one would be a banner saying nothing.
  expect(body.message).toContain("Platform group");
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
});

test("a cycle is 422 against the parent field, not the slug", async () => {
  const { mqtt, registry, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // Under its own descendant. The field matters: this is a bad *parent* choice, and a form
  // that showed the message under "Slug" would point at the input that is fine.
  const { request, context } = post(mqtt.id, {
    newParentId: registry.id,
    newSlug: "mqtt-contracts",
  });
  const response = await POST(request, context);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    field: "parentId",
    code: "parent-is-descendant",
  });
});

test("an illegal slug is 422 with the slug rules' own sentence, not a 400", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // The schema deliberately does not cap the slug, so this reaches `validateSlug` and comes
  // back as the actionable sentence rather than "that could not be read".
  const { request, context } = post(mqtt.id, {
    newParentId: null,
    newSlug: "a".repeat(200),
  });
  const response = await POST(request, context);
  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body.code).toBe("too-long");
  expect(body.message).toContain("200");
});

/* ----------------------------------------------------------------- the body handling ---- */

test("a missing Content-Length is 411, not a 413 and not a parse", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // A chunked request omits the header entirely. `Number(null)` is 0, so a numeric-only cap
  // waves every unbounded body straight through — Task 5's finding, and it is a property of
  // any endpoint with a body rather than of that one route.
  const { request, context } = post(mqtt.id, { newParentId: null, newSlug: "moved" });
  request.headers.delete("content-length");

  expect((await POST(request, context)).status).toBe(411);
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
});

test("an oversized declared body is 413 before it is read", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const { request, context } = post(mqtt.id, {
    newParentId: null,
    newSlug: "x".repeat(MAX_MOVE_BODY_BYTES),
  });
  expect((await POST(request, context)).status).toBe(413);
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
});

test("a Content-Length that is not a positive integer is 413", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // `Number("1e9")` is a number and not an integer; `Number("")` is 0. Each of these is a
  // declared length no honest client sends, and none may reach the body.
  for (const length of ["-1", "0", "not-a-number", "1e9"]) {
    const { request, context } = post(
      mqtt.id,
      { newParentId: null, newSlug: "moved" },
      { "content-length": length },
    );
    expect((await POST(request, context)).status, `content-length: ${length}`).toBe(413);
  }
});

test("a missing newParentId key is 400 — it is not read as null", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // The contract `MovePageInput` states: both fields are required and neither is optional,
  // because "omit to keep the current value" on a field whose purpose is to carry `null`
  // would silently move the page to the space root.
  const { request, context } = post(mqtt.id, { newSlug: "mqtt-contracts" });
  const response = await POST(request, context);
  expect(response.status).toBe(400);
  expect((await db.page.findUniqueOrThrow({ where: { id: mqtt.id } })).path).toBe(
    "architecture/mqtt-contracts",
  );
});

test("a body that is not JSON is 400, not a 500", async () => {
  const { mqtt, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const body = "not json at all";
  const request = new Request(`http://localhost/api/pages/${mqtt.id}/move`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
    },
    body,
  });
  const response = await POST(request, { params: Promise.resolve({ pageId: mqtt.id }) });
  expect(response.status).toBe(400);
});
