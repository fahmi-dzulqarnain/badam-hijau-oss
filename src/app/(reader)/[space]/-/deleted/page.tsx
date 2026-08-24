import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { getReadableSpaceByKey } from "@/lib/pages/repo";
import { listDeletedPages } from "@/lib/pages/delete";
import { dateFormat } from "@/lib/format";
import { RestoreButton } from "@/components/RestoreButton";

/**
 * Deleted pages, and the restore button.
 *
 * ## Why here, and why this is deliberately the smallest possible admin surface
 *
 * Restore is `MANAGE_SPACE` where delete is `EDIT`, and that asymmetry is the whole reason it
 * cannot live beside delete on the editor's surface: an editor cannot undo their own delete, so
 * a restore control there would be permanently refused for the person looking at it — or, worse,
 * would imply the delete next to it is reversible by them. It belongs somewhere an admin would
 * look, which is the space they administer, reached from the nav rail they are already reading.
 *
 * **Phase 6 owns administration properly** (spec §11 — space settings, membership, `PageSystem`
 * rows), and this is not a down payment on it: it is one list and one button, added because
 * Task 12 shipped `restorePage` with no way to reach it and "a deleted page can be restored by
 * an admin" is a Phase 2 exit criterion. When Phase 6 builds a real space-admin area this route
 * is a section inside it, not a thing to keep beside it.
 *
 * ## The path is `-/deleted`, and that segment is reserved rather than lucky
 *
 * `validateSlug` refuses any slug beginning with `-`, with `reserved-prefix` as its own error
 * code and its own test, precisely so application routes can live under `/{space}/-/…` without a
 * page ever being able to shadow one. So this route cannot collide with a page path, today or
 * after any create or move — the refusal is upstream of both.
 *
 * ## The permission is resolved twice, on purpose
 *
 * `getReadableSpaceByKey` answers "may this viewer read the space", which is what turns an
 * unknown key and an unreadable space into the same 404. `listDeletedPages` then re-resolves the
 * space and checks `MANAGE_SPACE` on its own, because that is this project's one rule for page
 * queries: every query states its own predicate and none is guarded by call ordering. The two
 * are not one predicate stated twice — they are two different questions, and each has its own
 * test.
 */
export default async function DeletedPages({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  const viewer = await requireViewer(`/${spaceKey}/-/deleted`);

  // Cache hit: the space layout resolved the same space with the same viewer in this render.
  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) notFound();

  const result = await listDeletedPages(viewer, space.id);

  if (!result.ok) {
    // `not-found` cannot be reached here — the read above already answered it — but it is
    // rendered rather than assumed away, because "cannot happen" is how a 500 gets shipped.
    if (result.reason === "not-found") notFound();
    return (
      <main className="doc">
        <h1>Deleted pages</h1>
        {/*
          The module's own sentence, verbatim. It is the one `forbidden` message in the
          codebase, written because the `EDIT`-deletes / `MANAGE_SPACE`-restores asymmetry is
          the one nobody can guess — so this surface renders it rather than writing a second,
          worse copy of the only explanation that exists.
        */}
        <p className="del-empty">{result.message}</p>
      </main>
    );
  }

  return (
    <main className="doc">
      <h1>Deleted pages</h1>
      <p className="del-lead">
        A deleted page keeps its version history and comes back under its parent, wherever that
        parent has since moved to. Restoring a page brings back everything the same delete took
        with it.
      </p>

      {result.pages.length === 0 ? (
        <p className="del-empty">Nothing in {space.name} has been deleted.</p>
      ) : (
        <ul className="del-list">
          {result.pages.map((page) => (
            <li key={page.id}>
              <div className="del-row">
                <div className="del-what">
                  {/* Every one of these three is user-typed text that can be one unbreakable
                      300-character token, and none of them is inside `.body` — the fifth shape
                      of the overflow class exactly. `del.css` states the guard by name. */}
                  <span className="del-title">{page.title}</span>
                  <code className="del-path">{page.path}</code>
                  <span className="del-when">
                    Deleted {dateFormat.format(page.deletedAt)}
                    {page.descendants > 0
                      ? ` · restoring it brings back ${page.descendants} sub-page${
                          page.descendants === 1 ? "" : "s"
                        }`
                      : ""}
                  </span>
                </div>
                <RestoreButton pageId={page.id} title={page.title} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
