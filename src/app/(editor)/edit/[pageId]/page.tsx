import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { getPageForEditing } from "@/lib/pages/editable";
import { listSpacePages } from "@/lib/pages/repo";
import { descendantsOf, isInSubtree } from "@/lib/pages/slug";
import { defaultPublishStatus, publishDestinations } from "@/lib/pages/transition";
import { Editor } from "@/components/Editor";
import { PageActions } from "@/components/PageActions";

/**
 * The editing route, reached from `/new` and from anywhere else that links an editor at a
 * page id.
 *
 * The permission line is drawn exactly where Tasks 4 and 6 drew it, and the two halves are
 * different on purpose:
 *
 * - Cannot READ the space → the reader's own not-found. Never a 403; a permission error on a
 *   page a stranger cannot see confirms the page exists, which is the leak spec §8 closes.
 * - Can read but cannot EDIT → say so. They can already see the page in the nav rail, so
 *   "you do not have permission to edit it" discloses nothing, and a 404 would be a lie they
 *   can disprove by clicking through to the page itself.
 *
 * This check authorises the *render*. Every save is re-authorised by `saveDraft`, because a
 * route that checks once holds for as long as the tab stays open.
 */
export default async function EditPage({
  params,
}: {
  params: Promise<{ pageId: string }>;
}) {
  const { pageId } = await params;
  const viewer = await requireViewer(`/edit/${pageId}`);

  const result = await getPageForEditing(viewer, pageId);

  if (!result.ok) {
    if (result.reason === "not-found") notFound();
    return (
      <main className="ed-denied">
        <h1>You cannot edit this page</h1>
        <p>
          You have read access to this space but not the Editor role. Ask a space admin if
          you need to make changes.
        </p>
      </main>
    );
  }

  const { page } = result;

  /**
   * The space's pages, once, for the two questions the move and delete surface asks: which
   * pages could be this one's parent, and which pages a delete would take with it.
   *
   * Through `listSpacePages` rather than a query of this route's own, for the reason `/new`
   * gives: it states its own permission predicate and its own soft-delete filter, so going
   * through the repository is what keeps this route out of the soft-delete guard's registry
   * and out of the class of bugs it exists to catch. It also means the delete confirmation
   * counts exactly what `deletePage` will take — the page plus every **live** descendant —
   * because both sides are reading rows filtered by `visiblePage()`.
   */
  const rows = await listSpacePages(viewer, page.space.id);

  /**
   * A suggestion, not a constraint. `movePage` rejects a cycle from the path prefix and
   * re-checks everything else, so this filter only keeps the picker from offering options
   * that cannot work: the page itself, and anything inside its own subtree.
   *
   * `isInSubtree` and not a `startsWith`, because `architecture/mqtt-contracts-v2` is not
   * inside `architecture/mqtt-contracts` and a picker that hid it would be quietly refusing a
   * legal move. That is the exact off-by-one `movePage` has already had once.
   */
  const parents = rows
    .filter((row) => !isInSubtree(page.path, row.path))
    .map((row) => ({ id: row.id, title: row.title, path: row.path }));

  const descendants = descendantsOf(page.path, rows).map((row) => ({
    id: row.id,
    title: row.title,
    path: row.path,
  }));

  return (
    <>
      <Editor
        page={{
          id: page.id,
          path: page.path,
          docType: page.docType,
          status: page.status,
          spaceName: page.space.name,
          title: page.text.title,
          markdown: page.text.markdown,
          // Serialised here rather than in the client component: this is the exact string the
          // first autosave sends back as `seen`, and `Date` does not survive the RSC boundary
          // as one anyway. Null means "no draft row", which routes that save to the create
          // branch instead of conflicting against a row that does not exist.
          updatedAt: page.seen?.toISOString() ?? null,
          // The status picker's options and its fallback, both derived from `PUBLISHABLE_INTO`
          // **here** rather than in the client component. Two reasons, and neither is about
          // bundle size: spec §6.3 says the vocabulary is never maintained in two places, and a
          // list computed in the browser would be a second place; and the table is keyed by
          // `DocType` and `DocStatus`, which are real types on this side of the boundary and
          // plain strings on the other.
          statusOptions: publishDestinations(page.docType, page.status),
          defaultStatus: defaultPublishStatus(page.docType, page.status),
        }}
      />
      {/*
        A sibling of the editor rather than a section inside it, deliberately. `Editor` owns a
        `CodeMirror` view that must never be rebuilt — the rule its whole component is arranged
        around — and every prop added to it is one more thing that can change and take the
        cursor, the undo history and the scroll position with it. Move and delete need this
        space's page list, which the editor has no use for; keeping them apart means a
        `router.refresh()` after a move re-renders both from the server without either one
        being able to disturb the other.
      */}
      <PageActions
        pageId={page.id}
        title={page.text.title}
        path={page.path}
        slug={page.slug}
        parentId={page.parentId}
        parents={parents}
        descendants={descendants}
        spaceHref={`/${encodeURIComponent(page.space.key)}`}
      />
    </>
  );
}
