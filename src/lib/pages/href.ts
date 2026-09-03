import type { Route } from "next";

/**
 * The single place a reader link is built from a space key and a `Page.path`.
 *
 * `Page.path` has no format constraint, so a slug containing `#`, `?` or a space would
 * silently produce a broken link without per-segment encoding. Encoding per segment rather
 * than with a single `encodeURI`/`encodeURIComponent` call is the point: the `/` separators
 * must survive, everything inside a segment must not.
 *
 * The `Route` cast is unavoidable and costs nothing — the string is opaque to typedRoutes
 * either way, since neither the space key nor the path is known at compile time.
 *
 * Omit `path` for the space root.
 */
export function pageHref(spaceKey: string, path?: string): Route {
  const base = `/${encodeURIComponent(spaceKey)}`;
  if (path === undefined) return base as Route;
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}` as Route;
}

/**
 * The reserved segment every application route under a space lives beneath.
 *
 * `validateSlug` refuses any slug beginning with `-`, with `reserved-prefix` as its own error
 * code and its own test, and the refusal runs upstream of both `createPage` and `movePage` — so
 * a page can never take a path under `-/` and shadow one of these routes. `-/adrs`, `-/rfcs` and
 * `-/deleted` already stand on that guarantee; `-/history` is the fourth.
 *
 * It is **not** percent-encoded, deliberately: it is a literal route segment, not data, and
 * `encodeURIComponent("-")` happens to be the identity today — a fact this would be relying on
 * silently. Written out here once so the two builders below cannot disagree about it.
 */
const RESERVED = "-";

/**
 * A page's version history — `/{space}/-/history/{path}`, spec §10.
 *
 * Built here rather than at the two call sites for the reason `pageHref` exists: this project
 * has twice had a link rule honoured by two sites and quietly dropped by the third. The path is
 * encoded per segment by `pageHref`, whose separators must survive and whose segment contents
 * must not.
 *
 * **The path is the page's path and not its id**, and the trade is worth stating: a bookmarked
 * history URL stops resolving when the page moves, where the reader route would follow a
 * `Redirect` row to the new path. That is deliberate for this phase — every link to this route
 * is generated from the page's current path on the page itself, so the stale URL is only
 * reachable from a bookmark, and adding redirect resolution here would put a second lookup on a
 * miss branch for a URL nothing generates. A phase that finds people sharing these URLs should
 * add the same `resolveRedirect` hop the reader route makes, not a second addressing scheme.
 */
export function pageHistoryHref(spaceKey: string, path: string): Route {
  return `/${encodeURIComponent(spaceKey)}/${RESERVED}/history/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}` as Route;
}
