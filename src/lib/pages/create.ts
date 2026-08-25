import type { DocType } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { writeAudit } from "@/lib/audit/log";
import { visiblePage } from "@/lib/pages/visible";
import {
  childPath,
  validatePath,
  validateSlug,
  type PathErrorCode,
  type SlugErrorCode,
} from "@/lib/pages/slug";
import { stripControl } from "@/lib/text/control";
import { templateFor } from "@/lib/templates/load";
import { TITLE_MAX_LENGTH } from "@/lib/drafts/schema";
import type { Viewer } from "@/lib/authz/types";

/** The three inputs a rejection can be attached to, so the form can render it in place. */
export type CreateField = "slug" | "title" | "parentId";

/** Rejections this module raises that the slug rules do not already have a code for. */
export type CreateErrorCode =
  | "title-empty"
  | "title-too-long"
  | "parent-not-found"
  | "path-occupied"
  | "path-occupied-by-deleted";

/**
 * The same `{ field, code, message }` shape `validateSlug` and `validatePath` return, widened
 * to the fields and codes this form has. Their `FieldError<"slug">` is assignable to it, so a
 * slug rejection is passed through untouched rather than re-worded here — one rule, one
 * sentence, wherever it is enforced.
 */
export type CreateFieldError = {
  field: CreateField;
  code: SlugErrorCode | PathErrorCode | CreateErrorCode;
  message: string;
};

export type CreatedPage = { id: string; path: string; spaceKey: string };

export type CreatePageInput = {
  spaceId: string;
  parentId: string | null;
  slug: string;
  title: string;
  docType: DocType;
};

export type CreatePageResult =
  | { ok: true; page: CreatedPage }
  /**
   * The space does not exist, or the viewer cannot read it — one answer for both. Never a
   * 403: telling a stranger "you may not create here" confirms the space exists, which is
   * the leak spec §8 closes. `saveDraft` draws this same line and the two must not diverge.
   */
  | { ok: false; reason: "not-found" }
  /**
   * The viewer can read the space but not write to it — a `VIEWER` in it, or anyone at all
   * in an `ALL_STAFF` space they do not belong to. They can already see the space, so saying
   * "you cannot create pages here" discloses nothing new.
   */
  | { ok: false; reason: "forbidden" }
  /** Something the editor typed. Always attached to a field, never thrown. */
  | { ok: false; reason: "invalid"; error: CreateFieldError };

const invalid = (error: CreateFieldError): CreatePageResult => ({
  ok: false,
  reason: "invalid",
  error,
});

/**
 * The spaces the create form may offer. Readable is not enough — a `VIEWER` can read a space
 * and cannot write to it, so offering it would produce a form that only fails on submit.
 *
 * `readableSpace` does the narrowing SQL can express; `can(..., "EDIT")` does the rest in
 * memory, because role lives on `Viewer.memberships` and the two sources of truth for
 * membership are deliberately separate (see PROGRESS.md). The filter here is a convenience
 * for the form and NOT the authorisation: `createPage` re-checks both, so a hand-posted
 * `spaceId` gains nothing.
 */
export async function listEditableSpaces(viewer: Viewer) {
  const spaces = await db.space.findMany({
    // No `visiblePage()`: this queries Space, which has no `deletedAt`. Listed as exempt in
    // the soft-delete guard rather than simply omitted from it.
    where: readableSpace(viewer),
    orderBy: { name: "asc" },
    select: { id: true, key: true, name: true, visibility: true },
  });
  return spaces.filter((space) => can(viewer, space, "EDIT"));
}

/**
 * Creates a page as a draft.
 *
 * Three things here are load-bearing and each has a test that fails when it is removed.
 *
 * **`validatePath` on the assembled path.** `validateSlug` caps one segment at 80 characters
 * and cannot do more: it sees a segment at a time and nesting depth is unbounded, so 33
 * levels of perfectly legal slugs breach the btree index row limit while every individual
 * slug passes. Without this call the failure arrives from Postgres as
 * `index row size ... exceeds btree version 4 maximum 2704` — a 500, and nothing the editor
 * can act on.
 *
 * **The occupied path is rejected before the insert, never after it.** This project's rule,
 * stated for the move in the plan's landmines and applying identically here: do not attempt
 * a write and read the constraint violation back as a decision. A `P2002` cannot say
 * *which* page holds the path, cannot distinguish a live page from a soft-deleted one, and
 * arrives after the transaction is already unwinding.
 *
 * **The new page is invisible to readers from the moment it exists.** `status: DRAFT` and no
 * `publishedVersionId`, which is what Phase 1's reader and nav rail key off — the rail
 * renders it as inert text and `getPublishedPage` returns null for it. That behaviour is
 * relied on here rather than assumed; `tests/integration/page-create.test.ts` asserts it.
 */
export async function createPage(
  viewer: Viewer,
  input: CreatePageInput,
): Promise<CreatePageResult> {
  // `readableSpace` returns a COMPLETE `where` and is passed whole, never spread.
  // Explicit `select`, never `include`.
  const space = await db.space.findFirst({
    where: readableSpace(viewer, { id: input.spaceId }),
    select: { id: true, key: true, visibility: true },
  });
  if (!space) return { ok: false, reason: "not-found" };

  if (!can(viewer, space, "EDIT")) return { ok: false, reason: "forbidden" };

  // Validated before anything is read from the page table, so a malformed slug costs one
  // query rather than three, and — more to the point — so the message the editor sees is
  // about what they typed rather than about a parent they picked correctly.
  const slug = validateSlug(input.slug);
  if (!slug.ok) return invalid(slug.error);

  // Stripped BEFORE the emptiness check, not after: a title of nothing but control
  // characters is an empty title, and treating it as non-empty would store a page whose
  // breadcrumb and nav entry are blank. `stripControl` is imported rather than reimplemented
  // — see its own docstring for why it is `\p{Cc}` and not `\p{C}`.
  const title = stripControl(input.title).trim();
  if (title.length === 0) {
    return invalid({
      field: "title",
      code: "title-empty",
      message: "Enter a title. It is what the nav rail and breadcrumbs show.",
    });
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return invalid({
      field: "title",
      code: "title-too-long",
      message: `Titles are at most ${TITLE_MAX_LENGTH} characters; this one is ${title.length}.`,
    });
  }

  return db.$transaction(async (tx) => {
    // Serialises every write to this space's path namespace. Without it the check below is
    // advisory only: at READ COMMITTED a concurrent create — or a Task 10 move, which
    // rewrites a whole subtree of paths — can take `path` between this transaction's read
    // and its insert, and the insert then fails on the unique index with exactly the
    // unactionable constraint violation this function exists to avoid.
    //
    // Keyed on the space id, hashed because advisory locks take integers and a cuid is not
    // one. Task 10 must take the SAME lock on the same key, or create and move serialise
    // against themselves but not against each other. A hash collision between two space ids
    // costs a little needless serialisation and nothing else.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${space.id}))`;

    // Read INSIDE the lock, and this is not fussiness. The parent's `path` is what the
    // child's path is built from, and Task 10's move rewrites a whole subtree of paths under
    // this same lock — so reading the parent outside it would let a move land between the
    // read and the insert, and the child would be created carrying its parent's old prefix.
    // A page whose path disagrees with its parent's is reachable by URL and absent from the
    // rail, which is the quietest possible way to lose a page.
    //
    // The parent's **path**, never its **slug**: at depth two a parent's path *is* its slug,
    // so deriving from the slug is indistinguishable from correct until depth three.
    //
    // `spaceId` in the filter is not redundant with the space check above. Without it a
    // parent id from any other readable space would be accepted, and the child would be
    // created in *this* space carrying the other space's path prefix.
    let parentPath: string | null = null;
    if (input.parentId !== null) {
      const parent = await tx.page.findFirst({
        where: visiblePage({
          id: input.parentId,
          spaceId: space.id,
          space: readableSpace(viewer),
        }),
        select: { path: true },
      });
      if (!parent) {
        return invalid({
          field: "parentId",
          code: "parent-not-found",
          message:
            "That parent page is no longer available in this space. Pick another, or create this page at the top level.",
        });
      }
      parentPath = parent.path;
    }

    const path = childPath(parentPath, slug.slug);

    const bounded = validatePath(path);
    if (!bounded.ok) return invalid(bounded.error);

    // **Deliberately not wrapped in `visiblePage()`.** Every other page read in this codebase
    // excludes soft-deleted rows; this one must not, because the unique index on
    // `(spaceId, path)` does not know about `deletedAt` either. A soft-deleted page still
    // holds its path, so filtering it out here would let the check pass and the insert fail.
    //
    // The alternatives were considered and rejected: hard-deleting the old row destroys the
    // version history soft delete exists to keep; moving its path aside is a write to a page
    // the editor never asked to touch, and Task 12's restore promises to put a page back
    // where it was; suffixing the new page's path hands the editor a URL they did not
    // choose. So it is refused, with a message that names the deleted page and points at the
    // action that clears the way.
    const occupant = await tx.page.findFirst({
      where: { spaceId: space.id, path, space: readableSpace(viewer) },
      select: { id: true, title: true, deletedAt: true },
    });

    if (occupant) {
      return occupant.deletedAt === null
        ? invalid({
            field: "slug",
            code: "path-occupied",
            message: `“${occupant.title}” already has the path “${path}”. Choose a different slug, or a different parent.`,
          })
        : invalid({
            field: "slug",
            code: "path-occupied-by-deleted",
            message: `The path “${path}” still belongs to the deleted page “${occupant.title}”. Restore it, or choose a different slug.`,
          });
    }

    const page = await tx.page.create({
      data: {
        spaceId: space.id,
        parentId: input.parentId,
        slug: slug.slug,
        path,
        title,
        docType: input.docType,
        // Stated rather than left to the column default. It is the whole reason a
        // half-written page is invisible to readers, and a default is a fact about the
        // schema, not a decision this function is seen to have made.
        status: "DRAFT",
        // `publishedVersionId` and `publishedAt` are left null, together. They are two
        // independent nullable columns and "published" means the former; setting either one
        // here would produce a page the reader offers and then 404s.
        createdById: viewer.id,
      },
      select: { id: true, path: true },
    });

    // The editor opens on this row, so it exists from the start rather than being created by
    // the first autosave — which would make the editor's first save a create racing its own
    // second save, and would leave a page with no draft if the tab were closed immediately.
    //
    // The doc type's template is written into it HERE, at create time, and that is a decision
    // rather than a convenience. The alternative — rendering the template as the editor's
    // placeholder — puts text on screen that is not in the database: it vanishes on the first
    // keystroke, so an author who types one word has silently discarded the frontmatter and
    // the headings, and an author who closes the tab has a page whose stored draft is empty
    // while the screen showed a document. Written here, the draft row and the pane agree from
    // the first render, and the frontmatter the author is meant to fill in is already theirs.
    await tx.pageDraft.create({
      data: {
        pageId: page.id,
        title,
        markdown: templateFor(input.docType),
        // Null, and honestly so: there is no published version to depart from yet.
        baseVersionId: null,
        updatedById: viewer.id,
      },
      select: { pageId: true },
    });

    await writeAudit(tx, {
      actorId: viewer.id,
      action: "page.create",
      spaceId: space.id,
      pageId: page.id,
      // The path is recorded now because Task 10 can move the page afterwards, at which
      // point the row no longer says where it was created.
      detail: {
        path: page.path,
        slug: slug.slug,
        title,
        docType: input.docType,
        parentId: input.parentId,
      },
    });

    return { ok: true, page: { id: page.id, path: page.path, spaceKey: space.key } };
  });
}
