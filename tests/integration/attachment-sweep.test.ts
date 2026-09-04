import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { attach, cast } from "./support/attachments";
import { memoryStore } from "@/lib/blob/select";
import { sweepAttachments } from "@/lib/attachments/sweep";

beforeEach(resetDb);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

function sweep(overrides: { deleteOrphans?: boolean } = {}) {
  return sweepAttachments({
    store: memoryStore(), now: new Date(), retentionDays: 30, ...overrides,
  });
}

const exists = async (id: string) =>
  (await db.attachment.findUnique({ where: { id }, select: { id: true } })) !== null;

test("a PENDING row older than the grace period is removed, with its bytes", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(25 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(1);
  expect(await exists(a.id)).toBe(false);
  expect(await memoryStore().stat(a.drivePath)).toBeNull();
});

test("a PENDING row inside the grace period is left alone", async () => {
  // An upload in progress right now is PENDING. Reclaiming it deletes a file mid-upload.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(2 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(0);
  expect(await exists(a.id)).toBe(true);
});

test("a soft-deleted row past retention is removed, and one inside it is kept", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const past = await attach(c.pageId, c.editor.id, { deletedAt: ago(31 * DAY) });
  const recent = await attach(c.pageId, c.editor.id, { deletedAt: ago(3 * DAY) });

  expect((await sweep()).expired).toBe(1);
  expect(await exists(past.id)).toBe(false);
  expect(await exists(recent.id)).toBe(true);
});

test("a COMMITTED, undeleted row is NEVER touched, whatever its age", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { createdAt: ago(900 * DAY) });

  const report = await sweep();
  expect(report.expired + report.abandonedUploads).toBe(0);
  expect(await exists(a.id)).toBe(true);
});

test("an orphaned drive item is REPORTED and not deleted by default", async () => {
  // A sweep bug that reports is a nuisance; one that deletes is data loss. The default has
  // to be the recoverable one.
  //
  // The key sits in a REAL shard (`a3`), not a made-up one. An earlier version used `zz` to
  // prove the pass was prefix-agnostic — but prefix-agnostic is exactly what cannot work
  // against Graph, whose `list` is one folder deep, so that fixture pinned a behaviour that
  // would have reported nothing forever against a real tenant.
  await cast({ visibility: "MEMBERS", published: true });
  await memoryStore().put("a3/nosuchrow.png", new Uint8Array(1));

  expect((await sweep()).orphans).toEqual(["a3/nosuchrow.png"]);
  expect(await memoryStore().stat("a3/nosuchrow.png")).not.toBeNull();
});

test("orphans are deleted only when explicitly asked", async () => {
  await cast({ visibility: "MEMBERS", published: true });
  await memoryStore().put("a3/nosuchrow.png", new Uint8Array(1));

  await sweep({ deleteOrphans: true });
  expect(await memoryStore().stat("a3/nosuchrow.png")).toBeNull();
});

test("an item belonging to a live row is not an orphan", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  await attach(c.pageId, c.editor.id);
  expect((await sweep()).orphans).toEqual([]);
});

test("the sweep is idempotent", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(25 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(1);
  // Second pass finds nothing, and in particular does not fail on the item it already
  // deleted — `delete` is idempotent for exactly this reason.
  expect((await sweep()).abandonedUploads).toBe(0);
});
