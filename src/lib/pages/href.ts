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
 * The mirror's failed jobs — `/-/mirror`, Phase 5 Task 8, spec §10.
 *
 * A constant and not a literal because two files name it (the route's own `requireViewer` return
 * path and the version-history link that reaches it), and because the reservation below is the
 * whole argument for the address.
 *
 * ## Why the same `-` one level up
 *
 * This surface is **not space-scoped** — a wedged mirror is a property of the mirror, and the
 * failures in it belong to whichever spaces happen to have one — so `/{space}/-/mirror` is the
 * wrong shape: it would either filter to one space, hiding failures, or paint other spaces' pages
 * under a space's heading. That leaves a top-level route, and a top-level static segment sits at
 * the same depth as `[space]`, so it **shadows** any space whose key it matches.
 *
 * Nothing prevents that today for any word: `Space.key` is a bare `String @unique` with no
 * validation anywhere (`src/lib/git/paths.ts` measured this — the seed and the fixtures are the
 * only writers, one of which uses `"eng ops"`), and `/search` already shadows a space keyed
 * `search`. Task 7 called that existing debt and declined to extend it, which is right.
 *
 * So `-` is chosen over `admin` or `mirror`, and the honest claim is narrow: **it does not remove
 * the collision, it makes the fix a rule the product already states.** `validateSlug` refuses any
 * slug beginning with `-`, with `reserved-prefix` as its own error code and its own test, and it
 * is the function a Phase 7 space-key validator would reuse — so reserving one character at the
 * top level costs that phase one rule, where reserving `admin`, `mirror`, `search` and whatever
 * comes next costs it a list that grows with every route. `-` is also not a word anybody would
 * name a space, which is not an argument but is worth a line.
 *
 * Phase 7 owns `/admin` and folds this in. Taking `/admin` now would squat on that namespace with
 * a single list and reserve an English word for it, which is the debt above, twice.
 *
 * The collision was **measured, not reasoned about**: see the route's own docstring for the
 * `routes-manifest.json` ordering and the `next start` probe against a space actually keyed `-`.
 */
export const MIRROR_FAILURES_PATH = `/${RESERVED}/mirror` as Route;

/**
 * The systems catalogue — `/systems`, Phase 7 Task 3, spec §7 and §11.
 *
 * A constant for the reason `MIRROR_FAILURES_PATH` is one: three files name it (the two routes'
 * own `requireViewer` return paths and the top bar's link), and a route address written out in
 * four places is a route address that disagrees with itself after the next move.
 *
 * ## It is a top-level static segment, and it therefore shadows a space keyed `systems`
 *
 * The same debt `/search` already carries and `/-/mirror` measured: `Space.key` is a bare
 * `String @unique` with no validation until Task 6, so nothing stops a space being created with
 * this key, and Next resolves a static segment ahead of a dynamic one.
 *
 * **Measured, not reasoned about** — see `src/app/(reader)/systems/page.tsx` for the
 * `routes-manifest.json` ordering and the `next start` probe against a space actually keyed
 * `systems`. The shadow costs such a space its landing page and **every path at depth one**,
 * which is wider than `/-/mirror`'s one URL because `[key]` matches any single segment; depth two
 * and below is untouched, and a shadowed path 404s rather than falling through. Task 6 closes the
 * window going forward, and no space is keyed `systems` today.
 *
 * `-/systems` was available and was not taken. `/-/mirror` reserved that prefix for surfaces that
 * are *not* space-scoped and are also not part of the product a reader navigates; §11 lists
 * `/systems` beside `/search` as a top-level destination in the product's own navigation, and
 * `/search` is the precedent that decides the address. Hiding a documented product surface behind
 * the reserved punctuation to dodge a debt Task 6 pays three tasks later would trade a legible URL
 * for two weeks of safety.
 */
export const SYSTEMS_PATH = "/systems" as Route;

/**
 * The systems administration surface — `/admin/systems`, Phase 7 Task 5, spec §7 and §11.
 *
 * A constant for `MIRROR_FAILURES_PATH`'s reason: the route's own `requireViewer` return path, the
 * affordance on `/systems`, and the three endpoints under it all name this address.
 *
 * ## `/admin` is taken here, and the collision is narrower than `/systems`'s — measured
 *
 * `/-/mirror` deliberately did **not** squat on `/admin` ("Phase 7 owns `/admin` and folds this
 * in"), and this is that phase. `Space.key` is still a bare `String @unique` until Task 6, so a
 * space keyed `admin` collides with this route — but the shape is not `/systems`'s.
 *
 * **This route is fully static: two literal segments and no dynamic one.** `/systems/[key]` cost a
 * space keyed `systems` its landing page *and every path at depth one*, because `[key]` matches
 * any single segment. Here there is nothing dynamic to match with, so the shadow is exactly the
 * one path `systems` inside a space keyed `admin`, and that space keeps its landing page and every
 * other page it has — the `/-/mirror` shape, not the `/systems/[key]` one.
 *
 * `/admin` itself has **no page**, deliberately: a layout without a page creates no route, so
 * `/admin` still resolves to `[space]`. Tasks 6, 7 and 8 add three more leaves under it, each
 * costing that hypothetical space one more path; an `/admin` index page, if one is ever wanted,
 * would be the thing that takes its landing page too. Measured against a real `next build` and
 * `next start` — see the route's own docstring for the `routes-manifest.json` ordering.
 *
 * No space is keyed `admin` today. Task 6 closes the window going forward.
 */
export const ADMIN_SYSTEMS_PATH = "/admin/systems" as Route;

/**
 * One system's generated page — `/systems/{key}`.
 *
 * `System.key` is lowercase, digits and hyphens by CHECK constraint (Task 1), so
 * `encodeURIComponent` is the identity for every key the database can hold. It is applied anyway,
 * for `pageHref`'s reason: the guarantee lives in a constraint this function cannot see, and a
 * link builder that relies on a promise made elsewhere is how `Page.path` produced broken links
 * three times before every site was routed through one function.
 */
export function systemHref(key: string): Route {
  return `${SYSTEMS_PATH}/${encodeURIComponent(key)}` as Route;
}

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
