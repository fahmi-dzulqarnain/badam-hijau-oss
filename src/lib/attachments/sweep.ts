import { db } from "@/lib/db";
import type { BlobStore } from "@/lib/blob/store";

/**
 * The attachment retention sweep. There is deliberately no job queue in this phase — the
 * git-mirror phase owns that, and building one here would mean building it against
 * requirements that do not exist yet — so this is a library function a script (or a test)
 * calls directly, run by hand or by cron.
 *
 * **Security does not depend on this file.** Whether an attachment is readable is decided by
 * `deletedAt` and `state` on the row, checked in SQL on every read (`readableAttachment` in
 * repo.ts). Bytes sitting in a private, application-owned SharePoint library after their row
 * is gone are unreachable through any path this application exposes — reclaiming them late,
 * or not at all, is a cost and a tidiness concern, not a hole. Treat a failed or skipped sweep
 * as a nuisance to fix on the next run, never as an incident.
 *
 * Three independent passes:
 *
 *   1. `PENDING` rows older than a 24h grace period — abandoned uploads. The grace period is
 *      the only thing separating "abandoned" from "in progress right now": `beginUpload`
 *      mints a PENDING row and hands the browser a URL to write to directly, so the
 *      application has no signal an upload finished until `commitUpload` flips the state.
 *      Reclaiming a PENDING row with no grace period would delete a file mid-upload.
 *   2. Rows soft-deleted longer ago than `retentionDays`.
 *   3. Drive items with no matching row at all — the reverse orphan, from a crash between
 *      mint and commit, or from a cascade. Reported by default; deleted only when asked.
 *
 * **Ordering within passes 1 and 2 is load-bearing: bytes first, row second.** The reverse
 * leaves a drive item with no row, which pass 3 then reports as an orphan FOREVER — turning a
 * completed deletion into a permanent warning. `BlobStore#delete` is documented idempotent
 * (deleting an absent key is not an error) precisely so that a crash between the two deletes
 * is safe to re-run: the retried pass calls `delete` again on bytes that are already gone, and
 * then removes the row it failed to remove the first time.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a PENDING row is given before it counts as abandoned. Fixed, not configurable: an
 * upload session itself is short-lived (`beginUpload`'s own `UploadSession.expiresAt` is 15
 * minutes for the memory store, and Graph's write URLs do not last much longer), so 24 hours
 * is generous headroom above any legitimate in-flight upload, not a tuned retention policy —
 * `retentionDays` is the knob operators are meant to adjust; this one is not exposed as one.
 */
const PENDING_GRACE_MS = 24 * HOUR_MS;

export type SweepOptions = {
  store: BlobStore;
  now: Date;
  retentionDays: number;
  /**
   * Delete drive items with no matching row. Off by default: a sweep bug that only REPORTS
   * an orphan is a nuisance; one that DELETES on a bug is data loss. The default has to be
   * the recoverable one.
   */
  deleteOrphans?: boolean;
  /**
   * Report what the sweep would do without writing anything — no store delete, no row
   * delete. Every mutation in this module is gated on `!dryRun`, so this is not a best-effort
   * approximation: with it set, `sweepAttachments` degrades to three read-only counts (and,
   * for pass 3, an orphan list) over the exact same queries a real run would use.
   */
  dryRun?: boolean;
};

export type SweepReport = {
  abandonedUploads: number;
  expired: number;
  orphans: string[];
};

export async function sweepAttachments(options: SweepOptions): Promise<SweepReport> {
  const { store, now, retentionDays, deleteOrphans = false, dryRun = false } = options;

  // Sequential, not `Promise.all`: pass 3 decides "orphan" by checking the drive against
  // every row CURRENTLY in the table, and that read must happen after passes 1 and 2 have
  // removed the rows they are going to remove. A row pass 1 deletes and whose bytes pass 1
  // has not yet deleted, observed mid-flight by a concurrent pass 3, would be misreported as
  // an orphan even though pass 1 is about to clean it up correctly.
  const abandonedUploads = await sweepAbandonedUploads(store, now, dryRun);
  const expired = await sweepExpired(store, now, retentionDays, dryRun);
  const orphans = await sweepOrphans(store, deleteOrphans, dryRun);

  return { abandonedUploads, expired, orphans };
}

async function sweepAbandonedUploads(
  store: BlobStore,
  now: Date,
  dryRun: boolean,
): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_GRACE_MS);
  const rows = await db.attachment.findMany({
    where: { state: "PENDING", createdAt: { lt: cutoff } },
    select: { id: true, drivePath: true },
  });

  if (!dryRun) {
    for (const row of rows) {
      // Bytes first, row second — see the module docstring on why the order is load-bearing.
      await store.delete(row.drivePath);
      await db.attachment.delete({ where: { id: row.id }, select: { id: true } });
    }
  }

  return rows.length;
}

async function sweepExpired(
  store: BlobStore,
  now: Date,
  retentionDays: number,
  dryRun: boolean,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  // `deletedAt: { lt: cutoff }` alone, with no explicit `not: null`: SQL's `NULL < x` is
  // unknown, not true, so a live row (`deletedAt` null) is excluded by the comparison itself
  // rather than by an extra clause. `state` is not filtered here on purpose — a row can only
  // reach a soft-deleted state via `softDeleteAttachment`, which requires it to already be a
  // real row a viewer could read or edit; whether it happened to be PENDING or COMMITTED at
  // that moment does not change that its `deletedAt` age is what this pass is asked to judge.
  const rows = await db.attachment.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, drivePath: true },
  });

  if (!dryRun) {
    for (const row of rows) {
      await store.delete(row.drivePath);
      await db.attachment.delete({ where: { id: row.id }, select: { id: true } });
    }
  }

  return rows.length;
}

/**
 * Every shard `driveKeyFor` can produce: `00` through `ff`. Written out rather than derived at
 * each call, and kept beside the pass that walks it so the coupling to `policy.ts`'s two-hex
 * shard is visible from here.
 */
const SHARDS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

async function sweepOrphans(
  store: BlobStore,
  deleteOrphans: boolean,
  dryRun: boolean,
): Promise<string[]> {
  // Every drivePath currently on a row — PENDING, COMMITTED, soft-deleted-but-still-within-
  // retention, all of it. Read AFTER passes 1 and 2 above, so a row those passes just removed
  // does not count as "known" here; its bytes were removed in the same pass, for the same
  // reason, so it correctly does not show up as an orphan either.
  const known = new Set(
    (await db.attachment.findMany({ select: { drivePath: true } })).map((row) => row.drivePath),
  );

  // Iterated over the 256 shard folders `driveKeyFor` hashes ids into, rather than one call
  // with an empty prefix.
  //
  // The empty-prefix form worked against `MemoryBlobStore`, whose `list` is a `startsWith`
  // over a flat Map, and could never have worked against the real one: `GraphBlobStore#list`
  // is one folder deep by its own comment, so an empty prefix lists the drive root's
  // children — which, under this layout, are the shard folders themselves and not a single
  // file. The orphan pass would have reported nothing, forever, against a real tenant, while
  // passing its tests.
  //
  // Enumerating the shards is safe precisely because the key space is OURS: every key this
  // system writes comes from `driveKeyFor`, which is `{2 lowercase hex}/{id}.{ext}`, and the
  // dev upload route validates against that same shape. A file outside that range was not put
  // there by this application, and deleting it is not this sweep's business. 256 listings per
  // run is nothing for a job that runs on a cron.
  const orphans: string[] = [];
  for (const shard of SHARDS) {
    for await (const { key } of store.list(`${shard}/`)) {
      if (!known.has(key)) orphans.push(key);
    }
  }

  if (deleteOrphans && !dryRun) {
    for (const key of orphans) await store.delete(key);
  }

  return orphans;
}
