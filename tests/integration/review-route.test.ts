import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * The review-confirmation endpoint — spec §12, Phase 7 Task 4.
 *
 * `confirmReview` owns every decision: who may confirm, the write predicate, the audit row and
 * the discriminated result. So this file tests only the translation, and the three answers where
 * a translation could quietly flatten something:
 *
 * - the **403 carries the module's own message**, because "an editor is not enough" is the one
 *   thing about this endpoint nobody can guess;
 * - the **404 carries none**, so a stranger cannot tell a page they may not see from one that
 *   does not exist;
 * - the 200 carries the new `reviewedAt` and a `pageHref`-built URL, encoded per segment.
 */
async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const dara = await db.user.create({ data: { email: "dara@example.com", name: "Dara M." } });
  const space = await db.space.create({
    /*
     * A legal key since Phase 7 Task 6: `Space_key_shape` refuses a space, so `"eng ops"` — what
     * this fixture used to write — can no longer be stored by anything. The encoding claim this
     * test makes now rests entirely on the page's own path below, which is the half that is still
     * reachable: `Page.path` has no CHECK, and a direct write is how a segment with a space gets
     * into it.
     */
    data: { key: "eng-ops", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: dara.id, role: "EDITOR" },
  });

  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt contracts",
      path: "architecture/mqtt contracts",
      title: "MQTT contracts",
      status: "CURRENT",
      createdById: aisyah.id,
      ownerId: aisyah.id,
      reviewedAt: new Date("2024-01-01T00:00:00Z"),
    },
    select: { id: true },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "# MQTT contracts\n",
      status: "CURRENT",
      authorId: aisyah.id,
    },
    select: { id: true },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date("2024-01-01T00:00:00Z") },
  });

  const as = (id: string): Viewer => ({
    id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "EDITOR" }],
  });

  return { space, page, asOwner: as(aisyah.id), asOtherEditor: as(dara.id) };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/pages/[pageId]/review/route")).POST;
}

/** No body, deliberately — the endpoint reads none, and the timestamp is the server's. */
function post(pageId: string) {
  return {
    request: new Request(`http://localhost/api/pages/${pageId}/review`, { method: "POST" }),
    context: { params: Promise.resolve({ pageId }) },
  };
}

const reviewedAtOf = async (pageId: string) =>
  (await db.page.findUniqueOrThrow({ where: { id: pageId }, select: { reviewedAt: true } }))
    .reviewedAt;

test("the owner confirms and gets the new timestamp and the reader URL", async () => {
  const f = await fixture();
  const before = new Date();

  const POST = await routeAs(f.asOwner);
  const { request, context } = post(f.page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body.pageId).toBe(f.page.id);
  expect(body.href).toBe("/eng-ops/architecture/mqtt%20contracts");
  // The stored value and the reported one are the same instant, and it is a real "now" rather
  // than a value echoed back from the request — compared against the clock, not against itself.
  const stored = await reviewedAtOf(f.page.id);
  expect(body.reviewedAt).toBe(stored?.toISOString());
  expect(stored!.getTime()).toBeGreaterThanOrEqual(before.getTime());
});

test("an unauthenticated caller gets 401 and nothing is confirmed", async () => {
  const f = await fixture();
  const was = await reviewedAtOf(f.page.id);

  const POST = await routeAs(null);
  const { request, context } = post(f.page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(401);
  expect((await response.json()).message).toMatch(/sign in/i);
  expect(await reviewedAtOf(f.page.id)).toEqual(was);
});

/**
 * The 403 and its sentence. An EDITOR of the page's own space, who does not own it — the viewer
 * that separates the ownership rule from every other guard, which is why the fixture gives `dara`
 * a real membership rather than making them a stranger.
 */
test("an editor who does not own the page gets 403 with the reason", async () => {
  const f = await fixture();
  const was = await reviewedAtOf(f.page.id);

  const POST = await routeAs(f.asOtherEditor);
  const { request, context } = post(f.page.id);
  const response = await POST(request, context);
  expect(response.status).toBe(403);
  expect((await response.json()).message).toBe(
    "Only this page's owner, or an administrator of the space, can confirm a review.",
  );
  expect(await reviewedAtOf(f.page.id)).toEqual(was);
});

/**
 * §8's 404-not-403 rule at the HTTP boundary: a page in a space the caller cannot read and an id
 * that names nothing must be **byte-identical**, body included. A 403 for the first would say the
 * page exists; a different sentence would say it too, more quietly.
 */
test("a stranger and a nonexistent id get the same 404, body included", async () => {
  const f = await fixture();

  const POST = await routeAs(stranger);
  const hidden = post(f.page.id);
  const missing = post("no-such-page-id");

  const hiddenResponse = await POST(hidden.request, hidden.context);
  const missingResponse = await POST(missing.request, missing.context);
  expect(hiddenResponse.status).toBe(404);
  expect(missingResponse.status).toBe(404);
  expect(await hiddenResponse.json()).toEqual(await missingResponse.json());
});
