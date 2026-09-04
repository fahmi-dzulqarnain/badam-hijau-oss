import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { editableSpace, readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { auditSpaceAccess } from "@/lib/audit/log";
import { blobStore } from "@/lib/blob/select";
import { driveKeyFor } from "@/lib/attachments/policy";
import type { BeginUploadInput } from "@/lib/attachments/schema";
import type { Viewer } from "@/lib/authz/types";

/**
 * Every permission rule for attachments. The routes translate these outcomes into status
 * codes and decide nothing.
 *
 * Note that no `page` delegate call appears anywhere in this file: reading an attachment
 * reaches a `Page` row only through a RELATION FILTER. That is the shape `visible.test.ts`
 * was widened for the fourth time — invisible to both halves of its sweep — which is why this
 * module's registration there is not a formality. `readableAttachment` also reaches `Space`
 * only through the same relation, nested one level further, for the audit hook argued below.
 */

export type ReadableAttachment = {
  id: string;
  drivePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  eTag: string | null;
};

/**
 * The read predicate, stated once.
 *
 * The `OR` is the draft rule: an attachment is readable when its page is published, or when
 * the viewer could edit it. Without it, a VIEWER who guesses an id reads an image referenced
 * only in an unpublished draft.
 *
 * `readableSpace` and `editableSpace` sit in SEPARATE varargs of `visiblePage`, which makes a
 * key collision structurally impossible. Not because a duplicate key would be silent — that
 * is a TS1117 compile error — but because MERGING them into one `space` value is not:
 * `{ ...editableSpace(v), ...readableSpace(v) }` keeps only the last `AND` and drops the edit
 * requirement, measured returning a members-only page to a VIEWER.
 */
function readablePredicate(viewer: Viewer) {
  return visiblePage(
    { space: readableSpace(viewer) },
    { OR: [{ publishedVersionId: { not: null } }, { space: editableSpace(viewer) }] },
  );
}

/**
 * **The `needsAccessAudit` decision (Task 9).**
 *
 * Spec §8 says a super admin reading a `MEMBERS` space they do not belong to is legitimate but
 * must leave a trace, and `src/lib/pages/repo.ts` pays that debt inside `getReadableSpaceByKey`
 * — the one place *every* page read passes through first. `listSpacePages` and the other
 * readers in that module deliberately do NOT audit themselves; they rely on their caller having
 * resolved the space through `getReadableSpaceByKey` earlier in the same request, and the
 * module's docstring argues that precondition explicitly rather than leaving it assumed.
 *
 * That precondition does not hold here. An attachment is fetched by its own id, not by
 * `(spaceKey, path)`, and the route that will serve it (Task 12) has no reason to resolve the
 * page's space through `getReadableSpaceByKey` first — the common case is a bare `<img src>`
 * request that never touches page resolution at all, often in a different HTTP request than
 * the page that referenced it. `readableAttachment` is therefore not "one more reader behind an
 * already-audited resolve", it is the ONLY choke point a super-admin attachment read passes
 * through. Trusting call ordering here would be exactly the gap Task 3's review flagged:
 * the audited case, unaudited.
 *
 * So this selects `page.space.{id,key,visibility}` — nested through the same relation filter
 * that already reaches `Page`, adding no new delegate call — and calls `auditSpaceAccess` for
 * every successful read. `auditSpaceAccess` itself re-checks `needsAccessAudit` and is a no-op
 * for anyone but a super admin outside their own MEMBERS space, so an ordinary editor or viewer
 * read costs nothing beyond the already-fetched columns. See
 * "that same read leaves a space.access audit row" in attachments-repo.test.ts.
 *
 * `beginUpload`, `commitUpload` and `softDeleteAttachment` are EDIT-gated, and a super admin
 * bypasses that gate the same way. This task's instruction named only the READ path, and nothing
 * downstream of it in the routes planned so far turns an edit action into a bare content
 * disclosure the way a GET does — so those three are left as they are rather than folded into
 * this decision by extension. If a later task adds an edit-only surface reachable without ever
 * resolving the space, it will need the same argument made for it, not silently inherit this one.
 */
export async function readableAttachment(
  viewer: Viewer,
  id: string,
): Promise<ReadableAttachment | null> {
  const row = await db.attachment.findFirst({
    where: { id, deletedAt: null, state: "COMMITTED", page: readablePredicate(viewer) },
    select: {
      id: true, drivePath: true, filename: true,
      mimeType: true, sizeBytes: true, eTag: true,
      page: { select: { space: { select: { id: true, key: true, visibility: true } } } },
    },
  });
  if (!row) return null;

  // `"subresource"`, because this is not a page view. One page with twelve screenshots is
  // twelve calls here, and a scrubbed video is one per seek — all one act of reading. The
  // request scope cannot see that: `cache()` is inert outside a render, and each of those is
  // its own HTTP request. Measured before the window existed: twelve reads, twelve rows.
  await auditSpaceAccess(viewer, row.page.space, "subresource");

  const { page: _page, ...attachment } = row;
  return attachment;
}

export type BeginUploadResult =
  | { ok: true; attachmentId: string; uploadUrl: string; expiresAt: Date }
  /** Page absent, soft-deleted, or in a space this viewer cannot read — one answer for all. */
  | { ok: false; reason: "not-found" }
  /** Readable but not editable. Distinct on purpose: they can already see the page. */
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "store-unavailable" };

export async function beginUpload(
  viewer: Viewer,
  input: BeginUploadInput,
): Promise<BeginUploadResult> {
  const page = await db.page.findFirst({
    where: visiblePage({ id: input.pageId, space: readableSpace(viewer) }),
    select: { id: true, space: { select: { id: true, visibility: true } } },
  });
  if (!page) return { ok: false, reason: "not-found" };
  if (!can(viewer, page.space, "EDIT")) return { ok: false, reason: "forbidden" };

  // The row first, because its id determines the key — and then the key, in the SAME
  // transaction, so no committed row ever carries an empty `drivePath`. Both `id` and
  // `createdAt` are database defaults, which is why the key cannot be computed for the
  // insert that produces them.
  const attachment = await db.$transaction(async (tx) => {
    const row = await tx.attachment.create({
      data: {
        pageId: page.id,
        drivePath: "",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedById: viewer.id,
      },
      select: { id: true },
    });
    return tx.attachment.update({
      where: { id: row.id },
      data: { drivePath: driveKeyFor(row.id, input.mimeType) },
      select: { id: true, drivePath: true },
    });
  });

  try {
    const session = await blobStore().beginUpload(
      attachment.drivePath, input.sizeBytes, input.mimeType,
    );
    return {
      ok: true,
      attachmentId: attachment.id,
      uploadUrl: session.uploadUrl,
      expiresAt: session.expiresAt,
    };
  } catch {
    // The row stays PENDING and the sweep reclaims it, which is the same cleanup path a
    // failed upload takes. Deliberately not deleted here: a store that just failed is not
    // the thing to ask for a compensating delete.
    return { ok: false, reason: "store-unavailable" };
  }
}

export type CommitResult =
  | { ok: true; attachment: ReadableAttachment }
  | { ok: false; reason: "not-found" | "not-uploaded" | "size-mismatch" | "store-unavailable" };

export async function commitUpload(viewer: Viewer, id: string): Promise<CommitResult> {
  // EDIT is re-checked rather than inherited from `beginUpload`: a membership can be revoked
  // while an upload session is still live.
  const row = await db.attachment.findFirst({
    where: {
      id,
      deletedAt: null,
      page: visiblePage({ space: readableSpace(viewer) }, { space: editableSpace(viewer) }),
    },
    select: { id: true, drivePath: true, mimeType: true, sizeBytes: true, filename: true },
  });
  if (!row) return { ok: false, reason: "not-found" };

  let stat;
  try {
    // Stat by the key THIS APPLICATION derived. The browser holds Graph's completion response
    // and could report any item id; accepting one would let it name an item it does not own.
    stat = await blobStore().stat(row.drivePath);
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  if (!stat) return { ok: false, reason: "not-uploaded" };

  if (stat.sizeBytes !== row.sizeBytes) {
    // A client that declared one size sent another. Remove the bytes and retire the row —
    // the declared size is what the cap was checked against.
    await blobStore().delete(row.drivePath).catch(() => {});
    await db.attachment.update({
      where: { id: row.id }, data: { deletedAt: new Date() }, select: { id: true },
    });
    return { ok: false, reason: "size-mismatch" };
  }

  const committed = await db.attachment.update({
    where: { id: row.id },
    data: { state: "COMMITTED", eTag: stat.eTag, sizeBytes: stat.sizeBytes },
    select: {
      id: true, drivePath: true, filename: true,
      mimeType: true, sizeBytes: true, eTag: true,
    },
  });
  return { ok: true, attachment: committed };
}

export type SoftDeleteResult = { ok: true } | { ok: false; reason: "not-found" };

export async function softDeleteAttachment(
  viewer: Viewer,
  id: string,
): Promise<SoftDeleteResult> {
  const { count } = await db.attachment.updateMany({
    where: {
      id,
      deletedAt: null,
      page: visiblePage({ space: readableSpace(viewer) }, { space: editableSpace(viewer) }),
    },
    data: { deletedAt: new Date() },
  });
  // `updateMany` so the predicate is part of the WRITE, not a read the write then trusts.
  // Zero rows is "not yours or not there" — one answer, as everywhere else.
  return count === 1 ? { ok: true } : { ok: false, reason: "not-found" };
}
