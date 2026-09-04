import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { attach, cast } from "./support/attachments";
import { memoryStore } from "@/lib/blob/select";
import { resetAccessWindow } from "@/lib/audit/log";
import {
  beginUpload, commitUpload, readableAttachment, softDeleteAttachment,
} from "@/lib/attachments/repo";

beforeEach(resetDb);
// Module state that outlives a single test by design, so it is reset like the database is.
// Ids are fresh per test so keys cannot collide in practice, but relying on that would make
// these tests order-dependent for no reason.
beforeEach(resetAccessWindow);

test("a published page's attachment is readable by every role, and by a non-member of ALL_STAFF", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  for (const [label, viewer] of [
    ["editor", c.editor], ["viewer", c.viewer], ["admin", c.admin],
    ["stranger", c.stranger], ["super admin", c.superAdmin],
  ] as const) {
    expect((await readableAttachment(viewer, a.id))?.id, label).toBe(a.id);
  }
});

test("a MEMBERS space hides the attachment from a non-member", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await readableAttachment(c.stranger, a.id)).toBeNull();
});

test("a DRAFT-ONLY page's attachment is hidden from a VIEWER and visible to an EDITOR", async () => {
  // The reason the OR clause exists. Without it a VIEWER who guesses an id reads an image
  // referenced only in an unpublished draft — content the nav rail refuses to link and
  // `getPublishedPage` refuses to serve.
  const c = await cast({ visibility: "ALL_STAFF", published: false });
  const a = await attach(c.pageId, c.editor.id);
  expect(await readableAttachment(c.viewer, a.id)).toBeNull();
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("a super admin reads a draft-only attachment in a MEMBERS space they do not belong to", async () => {
  // The case `editableSpace`'s short-circuit exists for. A naive composition returns null.
  const c = await cast({ visibility: "MEMBERS", published: false });
  const a = await attach(c.pageId, c.editor.id);
  expect((await readableAttachment(c.superAdmin, a.id))?.id).toBe(a.id);
});

test("that same read leaves a space.access audit row, and a member's read leaves none", async () => {
  // Spec §8, paid the same way `getReadableSpaceByKey` pays it — see the repo module's
  // docstring for why this read is the one place that hook has to live: no upstream route
  // resolves this page's space through `getReadableSpaceByKey` before fetching an attachment
  // by id, so this is the only choke point that could ever record the access.
  const c = await cast({ visibility: "MEMBERS", published: false });
  const a = await attach(c.pageId, c.editor.id);

  await readableAttachment(c.superAdmin, a.id);
  const rows = await db.auditLog.findMany({ where: { action: "space.access" } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: c.superAdmin.id, spaceId: c.spaceId });

  await readableAttachment(c.editor, a.id);
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(1);
});

test("a PENDING attachment is never readable, even by the uploader", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING" });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();
});

test("a soft-deleted attachment is not readable", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await softDeleteAttachment(c.editor, a.id)).toEqual({ ok: true });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();
});

test("SOFT-DELETING THE PAGE hides its attachments, and restoring it brings them back", async () => {
  // Emergent from nesting `visiblePage()` in the predicate rather than written anywhere. It
  // is tested precisely BECAUSE it is emergent: flatten the predicate and this breaks with
  // no other symptom.
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);

  await db.page.update({
    where: { id: c.pageId }, data: { deletedAt: new Date() }, select: { id: true },
  });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();

  await db.page.update({
    where: { id: c.pageId }, data: { deletedAt: null }, select: { id: true },
  });
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("a VIEWER cannot soft-delete, and the refusal does not disturb the row", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await softDeleteAttachment(c.viewer, a.id)).toEqual({ ok: false, reason: "not-found" });
  // `updateMany` puts the predicate in the WRITE. A read-then-write would have deleted it.
  expect((await readableAttachment(c.viewer, a.id))?.id).toBe(a.id);
});

test("beginUpload answers not-found for an unreadable page and forbidden for a readable one", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const input = { pageId: c.pageId, filename: "a.png", mimeType: "image/png", sizeBytes: 1 };
  expect(await beginUpload(c.stranger, input)).toEqual({ ok: false, reason: "not-found" });
  expect(await beginUpload(c.viewer, input)).toEqual({ ok: false, reason: "forbidden" });
});

test("beginUpload stores a drivePath in the SAME transaction as the row", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const result = await beginUpload(c.editor, {
    pageId: c.pageId, filename: "a.png", mimeType: "image/png", sizeBytes: 1,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const row = await db.attachment.findUniqueOrThrow({
    where: { id: result.attachmentId }, select: { drivePath: true, state: true },
  });
  // A committed row with an empty drivePath is garbage the sweep would reclaim, and the
  // window is invisible without this assertion.
  expect(row.drivePath).toMatch(/^..\/.+\.png$/);
  expect(row.state).toBe("PENDING");
});

test("commitUpload promotes a matching upload to COMMITTED", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", sizeBytes: 5 });
  expect((await commitUpload(c.editor, a.id)).ok).toBe(true);
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("commitUpload refuses a size mismatch, deletes the item and retires the row", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, {
    state: "PENDING", sizeBytes: 5, withBytes: false,
  });
  await memoryStore().put(a.drivePath, new Uint8Array(99));

  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "size-mismatch" });
  const row = await db.attachment.findUniqueOrThrow({
    where: { id: a.id }, select: { deletedAt: true },
  });
  expect(row.deletedAt).not.toBeNull();
  expect(await memoryStore().stat(a.drivePath)).toBeNull();
});

test("commitUpload answers not-uploaded when the item is absent", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", withBytes: false });
  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "not-uploaded" });
});

test("commitUpload re-checks EDIT rather than trusting beginUpload's check", async () => {
  // A membership can be revoked while an upload session is still live.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", sizeBytes: 5 });
  await db.spaceMembership.delete({ where: { id: c.editorMembershipId } });

  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "not-found" });
});

/** Long enough for a blocked statement to have actually reached the lock. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("two concurrent soft-deletes: exactly one wins", async () => {
  // The permission predicate must be part of the WRITE, not a read the write then trusts.
  // `updateMany` is one statement, so the second caller re-evaluates `deletedAt: null` after
  // the first commits and matches zero rows. A `findFirst` + `update`-by-id refactor is two
  // statements against two snapshots: both reads see a live row, both writes succeed, and
  // both callers are told they deleted it.
  //
  // Staged with the held-lock pattern `publish.test.ts` uses, because racing them with a bare
  // Promise.all is not deterministic — an unblocked race usually serialises by luck and the
  // test would pass for the wrong reason.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Hold the Attachment row lock so both callers must queue behind it.
  const holder = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Attachment" WHERE "id" = ${a.id} FOR UPDATE`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
  await settle();

  const first = softDeleteAttachment(c.editor, a.id);
  const second = softDeleteAttachment(c.editor, a.id);
  await settle();

  release();
  await holder;

  const results = [await first, await second];
  const won = results.filter((r) => r.ok).length;
  expect(won, JSON.stringify(results)).toBe(1);
  expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "not-found" }]);
});

test("a page's worth of attachment reads writes ONE audit row, not one each", async () => {
  // Measured before the sub-resource window existed: twelve reads wrote twelve identical
  // `space.access` rows a millisecond apart. A page with twelve screenshots is twelve HTTP
  // requests and a scrubbed video is one per seek — all one act of reading, and none of them
  // a render, so the per-request scope (`cache()`) is inert and caught none of it.
  //
  // Auditing too much is the safe direction, which is why this was shipped noisy rather than
  // silent — but a table that logs hundreds of rows per video view is unreadable at exactly
  // the moment an auditor needs it.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id);

  for (let i = 0; i < 12; i += 1) {
    expect((await readableAttachment(c.superAdmin, a.id))?.id).toBe(a.id);
  }

  expect(
    await db.auditLog.count({ where: { action: "space.access", actorId: c.superAdmin.id } }),
  ).toBe(1);
});

test("a read after the window closes writes a second row", async () => {
  // The other half: collapsing is bounded, not permanent. Without this the first test would
  // pass just as well against an audit that fired once per process and never again.
  vi.useFakeTimers();
  try {
    const c = await cast({ visibility: "MEMBERS", published: true });
    const a = await attach(c.pageId, c.editor.id);

    await readableAttachment(c.superAdmin, a.id);
    vi.advanceTimersByTime(30_000);
    await readableAttachment(c.superAdmin, a.id);
    expect(
      await db.auditLog.count({ where: { action: "space.access", actorId: c.superAdmin.id } }),
      "still inside the window",
    ).toBe(1);

    vi.advanceTimersByTime(31_000);
    await readableAttachment(c.superAdmin, a.id);
    expect(
      await db.auditLog.count({ where: { action: "space.access", actorId: c.superAdmin.id } }),
      "the window has closed",
    ).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("the window is per (actor, space), so it collapses neither apart", async () => {
  const first = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(first.pageId, first.editor.id);

  // Two different super admins reading the same attachment are two accesses.
  const other = await db.user.create({
    data: { email: "root2@example.com", name: "Root Two", isSuperAdmin: true },
    select: { id: true },
  });
  await readableAttachment(first.superAdmin, a.id);
  await readableAttachment(first.superAdmin, a.id);
  await readableAttachment({ id: other.id, isSuperAdmin: true, memberships: [] }, a.id);

  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(2);
});
