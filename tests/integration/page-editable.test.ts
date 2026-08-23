import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { getPageForEditing } from "@/lib/pages/editable";
import type { EditablePageResult } from "@/lib/pages/editable";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Every field carries a value nothing else in the fixture shares, so a `title`/`slug`/`path`
 * mix-up in the loader cannot hide behind two equal strings.
 */
async function fixture(visibility: "MEMBERS" | "ALL_STAFF" = "MEMBERS") {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering handbook", initials: "EN", visibility },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      docType: "ADR",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts as published",
      markdown: "## Topics\n\nThe published paragraph.",
      status: "CURRENT",
      authorId: aisyah.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });

  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });

  const as = (role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return { space, page, version, aisyah, asEditor: as("EDITOR"), asViewer: as("VIEWER") };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Narrows to the success branch, failing with the actual result rather than on `undefined`. */
function loaded(result: EditablePageResult) {
  if (!result.ok) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.page;
}

test("a published page with no draft opens on the published text", async () => {
  // Kills a loader that opens a blank document over a live page: the editor would then
  // autosave an empty draft two seconds later and publishing it would wipe the page.
  const { page, asEditor } = await fixture();

  const loadedPage = loaded(await getPageForEditing(asEditor, page.id));
  // The title comes from `Page`, the body from the published `PageVersion`, and the fixture
  // gives the two different values so the pairing is pinned rather than incidental. That is
  // "what readers currently see": the reader route renders `page.title` as the heading and
  // `publishedVersion.markdown` as the body, from those same two columns.
  expect(loadedPage.text).toEqual({
    title: "MQTT contracts",
    markdown: "## Topics\n\nThe published paragraph.",
  });
  expect(loadedPage.seen).toBeNull();
  expect(loadedPage.path).toBe("architecture/mqtt-contracts");
  expect(loadedPage.docType).toBe("ADR");
  expect(loadedPage.space).toEqual({ key: "engineering", name: "Engineering handbook" });
});

test("a draft wins over the published version, and brings the timestamp the first save needs", async () => {
  const { page, asEditor, aisyah } = await fixture();
  const draft = await db.pageDraft.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts, in progress",
      markdown: "The unsaved paragraph.",
      updatedById: aisyah.id,
    },
  });

  const loadedPage = loaded(await getPageForEditing(asEditor, page.id));
  expect(loadedPage.text).toEqual({
    title: "MQTT contracts, in progress",
    markdown: "The unsaved paragraph.",
  });
  // `seen` is the draft's timestamp exactly. Anything else — the page's `updatedAt`, the
  // version's — makes the very first autosave conflict with nothing to reconcile.
  expect(loadedPage.seen?.getTime()).toBe(draft.updatedAt.getTime());
});

test("a never-published page with no draft opens empty rather than failing", async () => {
  const { space, aisyah, asEditor } = await fixture();
  const fresh = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "topic-registry",
      path: "architecture/topic-registry",
      title: "Topic registry",
      createdById: aisyah.id,
      status: "DRAFT",
    },
  });

  const loadedPage = loaded(await getPageForEditing(asEditor, fresh.id));
  expect(loadedPage.text).toEqual({ title: "Topic registry", markdown: "" });
  expect(loadedPage.seen).toBeNull();
  expect(loadedPage.status).toBe("DRAFT");
});

/**
 * The soft-delete test this module's entry in `src/lib/pages/visible.test.ts` points at.
 *
 * A deleted page must not be editable, and must not be *distinguishable* from one that never
 * existed: a 403 or a "this page was deleted" here would confirm to a stranger that the page
 * is real, which is the leak the whole not-found convention exists to close.
 */
test("a soft-deleted page is not editable, and reads as not-found", async () => {
  const { page, asEditor } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(await getPageForEditing(asEditor, page.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
});

test("a soft-deleted page reads the same to a stranger as a page id that never existed", async () => {
  const { page } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(await getPageForEditing(stranger, page.id)).toEqual(
    await getPageForEditing(stranger, "no-such-page-id"),
  );
});

test("a non-member gets not-found, never forbidden", async () => {
  // The line Tasks 4 and 6 both draw. A 403 would tell a stranger the page exists.
  const { page } = await fixture();
  expect(await getPageForEditing(stranger, page.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
});

test("a VIEWER in the space is forbidden, not not-found", async () => {
  // The other half of that line: they can already read the page, so saying "you cannot edit
  // it" discloses nothing, and pretending it does not exist would be a lie they can disprove
  // by clicking the link in the nav rail.
  const { page, asViewer } = await fixture();
  expect(await getPageForEditing(asViewer, page.id)).toEqual({
    ok: false,
    reason: "forbidden",
  });
});

test("a stranger in an ALL_STAFF space can read the page but is refused the editor", async () => {
  const { page } = await fixture("ALL_STAFF");
  expect(await getPageForEditing(stranger, page.id)).toEqual({
    ok: false,
    reason: "forbidden",
  });
});

test("a super admin may edit a members-only space they do not belong to", async () => {
  const { page } = await fixture();
  const admin: Viewer = { id: "u-admin", isSuperAdmin: true, memberships: [] };
  expect(loaded(await getPageForEditing(admin, page.id)).path).toBe(
    "architecture/mqtt-contracts",
  );
});

test("a super admin still cannot open a soft-deleted page", async () => {
  // The permission predicate and the soft-delete predicate are independent, and the one
  // viewer who bypasses the first must not bypass the second.
  const { page } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  const admin: Viewer = { id: "u-admin", isSuperAdmin: true, memberships: [] };
  expect(await getPageForEditing(admin, page.id)).toEqual({ ok: false, reason: "not-found" });
});
