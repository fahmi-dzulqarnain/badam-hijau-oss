import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { getPageForEditing } from "@/lib/pages/editable";
import { Editor } from "@/components/Editor";

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

  return (
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
      }}
    />
  );
}
