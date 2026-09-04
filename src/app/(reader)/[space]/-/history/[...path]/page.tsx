import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { listPageVersions } from "@/lib/pages/history";
import { MIRROR_FAILURES_PATH, pageHistoryHref } from "@/lib/pages/href";
import { VersionHistory } from "@/components/VersionHistory";

/**
 * `/{space}/-/history/{path}` — a page's version history, spec §10.
 *
 * ## Why it lives under `-/` and not beside the page
 *
 * The obvious URL is `/{space}/{path}/-/history`, and it is unrepresentable: `[...path]` is a
 * catch-all, and a catch-all has to be the last segment of a route. So the only two shapes
 * available are a reserved segment *before* the page path, or a separate top-level route keyed on
 * a page id.
 *
 * A top-level route is the worse of the two, and the reason is not aesthetics. `/history/{id}`
 * would be a **static segment at the same depth as `[space]`**, so it would shadow any space
 * whose key is `history` — and space keys are created by people, where the `-/` segment is
 * reserved by the product: `validateSlug` refuses any slug beginning with `-`, with its own error
 * code and its own test, upstream of both `createPage` and `movePage`. `/search` already carries
 * the top-level shape and shadows a space keyed `search`; that is existing debt, not a pattern to
 * extend.
 *
 * ## The catch-all it nests inside, and how the collision was checked
 *
 * `/{space}/-/history/a/b` matches this route **and** `[space]/[...path]` with
 * `path = ["-", "history", "a", "b"]`. Next resolves the literal segment first: a static segment
 * outranks a dynamic one, which outranks a catch-all, evaluated left to right. Three routes in
 * this codebase have relied on that since Phase 2 — `-/deleted`, `-/adrs` and `-/rfcs` — and the
 * only thing new here is that the reserved segment is followed by a catch-all of its own.
 *
 * Checked rather than assumed, because the assumption is the interesting half. `next build`'s
 * `routes-manifest.json` lists `^/([^/]+?)/\-/history/(.+?)(?:/)?$` **before**
 * `^/([^/]+?)/(.+?)(?:/)?$`, and a real `next start` driven against the test database answered
 * `/probe/-/history/a/b` with this page (200, `<h1>Version history</h1>`) while
 * `/probe/-/history/no/such` answered 404 — which is what a catch-all match would have given for
 * both, since no page has a path beginning `-/`.
 *
 * Two things make it safe by construction rather than by luck: no page path can begin with `-`,
 * so nothing a person creates can even reach the ambiguity; and if precedence ever inverted, the
 * catch-all would answer with a 404 rather than with someone else's page, for the same reason.
 *
 * ## No `resolveRedirect`
 *
 * The reader route follows a `Redirect` row for a moved page; this one does not, and
 * `pageHistoryHref` states the trade. Every link here is generated from the page's current path
 * on the page itself, so a stale history URL is only reachable from a bookmark.
 */
export default async function PageHistoryRoute({
  params,
}: {
  params: Promise<{ space: string; path: string[] }>;
}) {
  const { space: spaceKey, path } = await params;
  const routePath = path.join("/");
  // The full URL as the sign-in return path. Correct rather than effective, for the reason the
  // reader route states at length: the space layout's own `requireViewer` has only the space key
  // and will usually redirect first on a cold load.
  const viewer = await requireViewer(pageHistoryHref(spaceKey, routePath));

  const result = await listPageVersions(viewer, { spaceKey, path: routePath });
  // Unreadable, soft-deleted and nonexistent are one answer, as everywhere (spec §8).
  if (!result.ok) notFound();

  return (
    <VersionHistory
      spaceKey={spaceKey}
      history={result.history}
      /*
       * The one affordance that reaches `/-/mirror` (Phase 5 Task 8). Decided here because this
       * is where the viewer is, and offered only to the reader who can act on it: that page is
       * super-admin only and 404s for everyone else, so an unconditional link would be a dead end
       * shown to precisely the people who cannot follow it. `VersionHistory` renders it inside the
       * stuck notice and nowhere else — see its `failuresHref` prop.
       *
       * No query pays for it: `Viewer.isSuperAdmin` is already loaded, the same rule the space
       * layout's `manageHref` and the reader route's Edit link both follow.
       */
      failuresHref={viewer.isSuperAdmin ? MIRROR_FAILURES_PATH : null}
    />
  );
}
