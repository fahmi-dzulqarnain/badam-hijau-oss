import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The `/api/admin/bugs/[id]` endpoint — Phase 7 Task 8.
 *
 * `src/lib/bugs/admin.ts` owns every decision, so this file tests only the translation, and the
 * answers where a translation could quietly flatten something:
 *
 * - the **refusal is 404 and carries no admin-specific sentence**, so a signed-in member cannot
 *   tell "you may not" from "there is no such endpoint" — and it is byte-identical to the answer
 *   for a report id that names nothing, which is `src/lib/admin/gate.ts`'s whole point;
 * - a **signed-out caller gets 401**, which is the one status this endpoint gives that the
 *   surface's own 404 does not, and is not a leak because every write endpoint answers it;
 * - a **body that is not a status is 400 and writes nothing** — including the two shapes
 *   `z.strictObject` and `z.enum` exist for, an unknown key and a status outside the enum;
 * - the success body echoes `previousStatus`, which is the value the client cannot know and the
 *   audit row records.
 */

async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return import("@/app/api/admin/bugs/[id]/route");
}

const request = (path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "PATCH",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

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
  const report = await db.bugReport.create({
    data: {
      reporterId: aisyah.id,
      summary: "The nav rail loses the third level.",
      routePath: "/engineering/architecture",
      appVersion: "0.1.0",
      userAgent: "Mozilla/5.0",
      viewport: "1440x900",
    },
    select: { id: true },
  });

  return {
    report,
    asRoot: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    asSpaceAdmin: {
      id: aisyah.id,
      isSuperAdmin: false,
      memberships: [{ spaceId: space.id, role: "ADMIN" }],
    } satisfies Viewer,
  };
}

const status = async (report: { id: string }) =>
  (
    await db.bugReport.findUniqueOrThrow({
      where: { id: report.id },
      select: { status: true },
    })
  ).status;

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A **discrimination**, not two absences: the same fixture is triaged successfully by the super
 * admin in the same test, so the member's 404 is a refusal and not an endpoint that never worked.
 */
test("a signed-in member gets 404 with no admin-specific sentence, and a super admin does not", async () => {
  const f = await fixture();
  const params = { params: Promise.resolve({ id: f.report.id }) };

  const refused = await routeAs(f.asSpaceAdmin);
  const denied = await refused.PATCH(request("/api/admin/bugs/x", { status: "TRIAGED" }), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({
    error: "not-found",
    message: "That page does not exist.",
  });
  expect(await status(f.report)).toBe("NEW");

  const allowed = await routeAs(f.asRoot);
  const ok = await allowed.PATCH(request("/api/admin/bugs/x", { status: "TRIAGED" }), params);
  expect(ok.status).toBe(200);
  expect(await status(f.report)).toBe("TRIAGED");
});

/**
 * A report id that names nothing answers **exactly** what a refused member gets.
 *
 * That is the whole of `src/lib/admin/gate.ts`'s "the refusal is byte-identical to a miss": a
 * different body, or a different status, would let a member distinguish "no such report" from "not
 * for you" and learn the shape of the system from a 404.
 */
test("an unknown report id answers the same 404 as the refusal", async () => {
  const f = await fixture();
  const route = await routeAs(f.asRoot);

  const missing = await route.PATCH(request("/api/admin/bugs/x", { status: "CLOSED" }), {
    params: Promise.resolve({ id: "cnosuchreport0000000000" }),
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: "not-found",
    message: "That page does not exist.",
  });
});

test("a signed-out caller gets 401 and changes nothing", async () => {
  const f = await fixture();
  const route = await routeAs(null);

  const response = await route.PATCH(request("/api/admin/bugs/x", { status: "CLOSED" }), {
    params: Promise.resolve({ id: f.report.id }),
  });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "unauthenticated" });
  expect(await status(f.report)).toBe("NEW");
  expect(await db.auditLog.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* The body                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The three shapes the wire schema is for, each writing nothing.
 *
 * `WONTFIX` is the interesting one: it is the fourth status somebody will eventually want, and
 * §18.2 does not have it — `z.enum(BugStatus)` takes Prisma's generated enum rather than a retyped
 * array of three strings, so this refusal moves by itself if the vocabulary is ever widened
 * deliberately, and cannot be widened by accident here.
 *
 * The unknown key is `z.strictObject`'s: one word between refusing a typo and stripping it
 * silently.
 */
test("a body that is not a status is 400, and nothing is written", async () => {
  const f = await fixture();
  const route = await routeAs(f.asRoot);
  const params = { params: Promise.resolve({ id: f.report.id }) };

  for (const body of [
    undefined,
    {},
    { status: "WONTFIX" },
    { status: "new" },
    { status: "TRIAGED", note: "duplicate" },
    { status: null },
  ]) {
    const response = await route.PATCH(request("/api/admin/bugs/x", body), params);
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid-body",
      message: "That is not a bug report status.",
    });
  }

  expect(await status(f.report)).toBe("NEW");
  expect(await db.auditLog.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* The success body                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `previousStatus` is echoed because it is the half the client cannot know: two triagers pressing
 * a second apart both believe they moved it from what their page last rendered, and only the
 * server knows which of them did. It is the same value the `bug.triage` row records, which is what
 * makes the sentence on the surface and the trail agree.
 */
test("a triage answers 200 with the new status and the one it replaced", async () => {
  const f = await fixture();
  const params = { params: Promise.resolve({ id: f.report.id }) };

  const route = await routeAs(f.asRoot);
  await route.PATCH(request("/api/admin/bugs/x", { status: "TRIAGED" }), params);
  const second = await route.PATCH(request("/api/admin/bugs/x", { status: "CLOSED" }), params);

  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({
    id: f.report.id,
    status: "CLOSED",
    previousStatus: "TRIAGED",
  });
  expect(await db.auditLog.count({ where: { action: "bug.triage" } })).toBe(2);
});
