import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import type { DocStatus, DocType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

/**
 * Everything the editor route needs in one read: what to put in the document, what the
 * chrome says, and the timestamp the first autosave must send as `seen`.
 */
export type EditablePage = {
  id: string;
  path: string;
  docType: DocType;
  status: DocStatus;
  /**
   * The page's own `slug` and `parentId`, which the move form needs as its starting values.
   * `movePage` requires both fields on every call and documents why neither may be optional:
   * on a field whose purpose is to carry `null`, "omit to keep the current value" would
   * silently move the page to the space root. The caller has to *have* the current values to
   * send them, and this is the read that already had the row open.
   */
  slug: string;
  parentId: string | null;
  /**
   * `id` as well as the display fields, because the editor route lists this space's pages —
   * for the move form's parent picker and for the delete confirmation's subtree — and
   * `listSpacePages` is keyed by space id. Reading it here costs nothing: the query already
   * selects the space relation to answer `can()`.
   */
  space: { id: string; key: string; name: string };
  /**
   * The text to load into the editor. From the draft when there is one; otherwise from the
   * published version, so opening a published page starts from what readers currently see
   * rather than from a blank document.
   */
  text: { title: string; markdown: string };
  /**
   * The draft's `updatedAt`, or **null when there is no draft row**. Null is not a missing
   * value here — it is the claim the first save makes, and it is what routes that save to
   * the create branch instead of a conflict against a row that does not exist.
   */
  seen: Date | null;
};

export type EditablePageResult =
  | { ok: true; page: EditablePage }
  /**
   * The page does not exist, is soft-deleted, or lives in a space this viewer cannot read.
   * One answer for all three, and the route renders it as the reader's own not-found —
   * never a 403, which would confirm the page exists. `saveDraft` and `createPage` draw the
   * same line and the three must not diverge.
   */
  | { ok: false; reason: "not-found" }
  /**
   * Readable but not editable — a `VIEWER` in the space, or anyone in an `ALL_STAFF` space
   * they do not belong to. Safe to be specific: they can already see the page.
   */
  | { ok: false; reason: "forbidden" };

/**
 * Loads a page for editing under the same permission rules the autosave endpoint enforces.
 *
 * This is NOT the authorisation for the writes that follow it. `saveDraft` re-resolves the
 * page and re-checks `EDIT` on every save, because a route that authorises once at render
 * time authorises for as long as the tab stays open — and a membership revoked at 09:00
 * must not keep writing until lunch.
 */
export async function getPageForEditing(
  viewer: Viewer,
  pageId: string,
): Promise<EditablePageResult> {
  const page = await db.page.findFirst({
    // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage`
    // owns the top level and `readableSpace` is passed whole as the `space` relation filter.
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    // Explicit select, never `include`.
    select: {
      id: true,
      title: true,
      path: true,
      slug: true,
      parentId: true,
      docType: true,
      status: true,
      space: { select: { id: true, key: true, name: true, visibility: true } },
      draft: { select: { title: true, markdown: true, updatedAt: true } },
      publishedVersion: { select: { markdown: true } },
    },
  });
  if (!page) return { ok: false, reason: "not-found" };

  if (!can(viewer, page.space, "EDIT")) return { ok: false, reason: "forbidden" };

  return {
    ok: true,
    page: {
      id: page.id,
      path: page.path,
      slug: page.slug,
      parentId: page.parentId,
      docType: page.docType,
      status: page.status,
      space: { id: page.space.id, key: page.space.key, name: page.space.name },
      text: page.draft
        ? { title: page.draft.title, markdown: page.draft.markdown }
        : { title: page.title, markdown: page.publishedVersion?.markdown ?? "" },
      seen: page.draft?.updatedAt ?? null,
    },
  };
}

/**
 * Whether this viewer may edit this page, without loading a word of its text.
 *
 * The preview endpoint's authorisation. It renders caller-supplied Markdown into HTML, so
 * without an `EDIT` check it is an open HTML-rendering service for anyone holding a session
 * — and it fires on the same two-second tick as autosave, so paying for the draft and the
 * published version on every keystroke-batch to learn one boolean would be wasteful as well
 * as wrong. `getPageForEditing` above answers a different question and reads five more
 * columns to do it.
 *
 * The two refusals are the same two, drawn in the same place, for the same reasons: a page
 * the viewer cannot READ is `not-found` and never `forbidden`, or the 403 itself tells a
 * stranger the page is real.
 */
export type EditAccessResult =
  | { ok: true }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "forbidden" };

export async function canEditPage(
  viewer: Viewer,
  pageId: string,
): Promise<EditAccessResult> {
  const page = await db.page.findFirst({
    // Both helpers return COMPLETE `where` objects and neither is spread. `visiblePage` is
    // not decoration here: a soft-deleted page must not be previewable, or a deleted page
    // stays a working Markdown renderer for as long as someone keeps its id.
    where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
    // Explicit select, never `include`. Only what `can()` needs.
    select: { space: { select: { id: true, visibility: true } } },
  });
  if (!page) return { ok: false, reason: "not-found" };

  if (!can(viewer, page.space, "EDIT")) return { ok: false, reason: "forbidden" };

  return { ok: true };
}
