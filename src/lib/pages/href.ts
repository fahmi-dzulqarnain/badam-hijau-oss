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
