"use client";

import { useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";

/** A page in this space that could be the move target's parent. */
export type ParentChoice = { id: string; title: string; path: string };

/** A live page that a delete of this page would take with it. */
export type SubtreePage = { id: string; title: string; path: string };

export type PageActionsProps = {
  pageId: string;
  title: string;
  path: string;
  slug: string;
  parentId: string | null;
  /**
   * Candidate parents, already filtered of this page and its own subtree by the route. That
   * filtering is a **suggestion, not the authorisation or the validation** — `movePage`
   * re-resolves the parent, re-checks `EDIT` and re-runs the cycle check from the path prefix,
   * so a hand-posted parent id gets the same refusal a stranger's would. Exactly the line
   * `/new` draws between its `<select>` and `createPage`.
   */
  parents: ParentChoice[];
  /**
   * The pages a delete would take, computed on the server from the same rows this space's nav
   * rail is built from. **This is the one place in Phase 2 where a UI detail is a data-safety
   * property**: deleting a page takes its whole subtree, restore needs a space admin, and an
   * editor who is not told finds out afterwards with no way to undo it themselves.
   */
  descendants: SubtreePage[];
  /** Where to send someone whose page no longer exists. */
  spaceHref: string;
};

type Pending = "move" | "delete" | null;

/**
 * Move and delete, on the editor's own surface.
 *
 * **Restore is deliberately absent.** It is `MANAGE_SPACE` where these two are `EDIT`, and the
 * asymmetry is the point: an editor cannot undo their own delete. Putting a restore button
 * here would either be permanently disabled for the person looking at it or would imply the
 * delete beside it is reversible by them. It lives on the space's own admin surface instead —
 * `/{space}/-/deleted`.
 *
 * Both actions POST to the routes and re-read the server's answer; neither re-decides
 * anything. Every message shown below a failure is the endpoint's own sentence, verbatim, for
 * the reason the Publish button gives: `movePage` writes each refusal for the person who has
 * to act on it — an occupied path naming the page that holds it, a cycle naming the page, a
 * no-op naming where it already is — and re-wording them here would give this surface a
 * second, worse copy of each.
 */
export function PageActions({
  pageId,
  title,
  path,
  slug,
  parentId,
  parents,
  descendants,
  spaceHref,
}: PageActionsProps) {
  const router = useRouter();

  const [pending, setPending] = useState<Pending>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * Whether the confirmation is open. A single "Delete" button that acts on the first click
   * cannot name what else goes, which is the whole requirement — so the first click opens the
   * sentence and the second one acts on it.
   */
  const [confirming, setConfirming] = useState(false);

  // Controlled, every one of them, for the reason `NewPageForm` measured: a rejection
  // re-renders this and an uncontrolled `<select>` comes back at its default, so the next
  // attempt would silently move the page somewhere the editor did not choose.
  const [nextParentId, setNextParentId] = useState(parentId ?? "");
  const [nextSlug, setNextSlug] = useState(slug);

  const move = async () => {
    if (pending !== null) return;
    setPending("move");
    setMoveError(null);
    setMoved(null);

    let response: Response;
    try {
      response = await fetch(`/api/pages/${pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // "" is this form's way of saying "the top level of the space"; the endpoint wants a
          // real null, and it distinguishes null from a missing key.
          newParentId: nextParentId === "" ? null : nextParentId,
          newSlug: nextSlug,
        }),
      });
    } catch {
      setPending(null);
      setMoveError("Not moved — the browser could not reach the server.");
      return;
    }

    const body = await response.json().catch(() => null);
    setPending(null);

    if (!response.ok || typeof body?.path !== "string") {
      setMoveError(
        typeof body?.message === "string"
          ? body.message
          : `Not moved — the server refused it (${response.status}).`,
      );
      return;
    }

    // The page id has not changed, so this route is still the right one — only the path
    // displayed in the editor's own bar is stale. `router.refresh()` re-renders the server
    // component that supplied it. Navigating to the reader instead would throw away an open
    // editor, and the editor is where someone who just renamed a page usually still is.
    setMoved(
      body.rewritten > 1
        ? `Moved to “${body.path}”, taking ${body.rewritten - 1} sub-page${
            body.rewritten === 2 ? "" : "s"
          } with it. The old URL now redirects here.`
        : `Moved to “${body.path}”. The old URL now redirects here.`,
    );
    router.refresh();
  };

  const remove = async () => {
    if (pending !== null) return;
    setPending("delete");
    setDeleteError(null);

    let response: Response;
    try {
      response = await fetch(`/api/pages/${pageId}/delete`, { method: "POST" });
    } catch {
      setPending(null);
      setDeleteError("Not deleted — the browser could not reach the server.");
      return;
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      setPending(null);
      setDeleteError(
        typeof body?.message === "string"
          ? body.message
          : `Not deleted — the server refused it (${response.status}).`,
      );
      return;
    }

    // This route is now a 404 for its own author — `getPageForEditing` carries
    // `visiblePage()` — so staying here is not an option. The nearest surviving ancestor if
    // the delete wrote redirects to one, and the space otherwise: a deleted root page has no
    // surviving ancestor, so `redirectHref` is null and there is nowhere else to go.
    const href = typeof body?.redirectHref === "string" ? body.redirectHref : spaceHref;
    router.push(href as Route);
  };

  return (
    <section className="ed-manage" aria-labelledby="ed-manage-head">
      <h2 className="ed-manage-head" id="ed-manage-head">
        Page settings
      </h2>

      <div className="ed-manage-grid">
        <div className="ed-manage-block">
          <h3 className="ed-manage-sub">Move</h3>
          <p className="ed-manage-hint">
            Renaming or reparenting this page takes its sub-pages with it, and every old URL
            keeps working — the reader permanently redirects them here.
          </p>

          <label className="ed-label" htmlFor="ed-move-parent">
            Parent page
          </label>
          <select
            id="ed-move-parent"
            className="ed-manage-input"
            value={nextParentId}
            onChange={(event) => setNextParentId(event.target.value)}
          >
            <option value="">None — top level of the space</option>
            {parents.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.title} — {parent.path}
              </option>
            ))}
          </select>

          <label className="ed-label" htmlFor="ed-move-slug">
            Slug
          </label>
          <input
            id="ed-move-slug"
            className="ed-manage-input"
            value={nextSlug}
            onChange={(event) => setNextSlug(event.target.value)}
          />
          <p className="ed-manage-hint">
            The last segment of the page&rsquo;s URL. Lowercase letters, numbers and hyphens.
          </p>

          <button
            type="button"
            className="ed-manage-go"
            onClick={() => void move()}
            disabled={pending !== null}
          >
            {pending === "move" ? "Moving…" : "Move page"}
          </button>

          {moveError ? (
            <p className="ed-manage-error" role="alert">
              {moveError}
            </p>
          ) : null}
          {moved ? (
            <p className="ed-manage-done" role="status">
              {moved}
            </p>
          ) : null}
        </div>

        <div className="ed-manage-block">
          <h3 className="ed-manage-sub">Delete</h3>
          <p className="ed-manage-hint">
            A deleted page leaves the reader and the nav rail and keeps its history. Only a
            space admin can put it back.
          </p>

          {confirming ? (
            <div className="ed-manage-confirm" role="alert">
              {/*
                The sentence the whole component exists for. The count is rendered from
                `descendants.length` and the titles are listed, because "and 3 sub-pages" is
                actionable and "and its sub-pages" is not — and because a number with no list
                beside it is exactly what a hardcoded 1 looks like.
              */}
              <p className="ed-manage-confirm-lead">
                Delete <strong>{title}</strong> at <code>{path}</code>?
              </p>
              {descendants.length === 0 ? (
                <p className="ed-manage-hint">
                  This page has no sub-pages, so nothing else is affected.
                </p>
              ) : (
                <>
                  <p className="ed-manage-confirm-lead">
                    This also deletes its {descendants.length} sub-page
                    {descendants.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="ed-manage-list">
                    {descendants.map((child) => (
                      <li key={child.id}>
                        {child.title} <code>{child.path}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="ed-manage-confirm-actions">
                <button
                  type="button"
                  className="ed-manage-danger"
                  onClick={() => void remove()}
                  disabled={pending !== null}
                >
                  {pending === "delete"
                    ? "Deleting…"
                    : descendants.length === 0
                      ? "Delete this page"
                      : `Delete this page and ${descendants.length} sub-page${
                          descendants.length === 1 ? "" : "s"
                        }`}
                </button>
                <button
                  type="button"
                  className="ed-manage-go"
                  onClick={() => setConfirming(false)}
                  disabled={pending !== null}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="ed-manage-danger"
              onClick={() => setConfirming(true)}
            >
              Delete this page&hellip;
            </button>
          )}

          {deleteError ? (
            <p className="ed-manage-error" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
