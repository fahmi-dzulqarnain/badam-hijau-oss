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
 * Nothing prevented that for any word: `Space.key` was a bare `String @unique` with no validation
 * anywhere (`src/lib/git/paths.ts` measured this — the seed and the fixtures were the only
 * writers, one of which used `"eng ops"`), and `/search` already shadows a space keyed `search`.
 * Task 7 called that existing debt and declined to extend it, which is right.
 *
 * So `-` is chosen over `admin` or `mirror`, and the honest claim is narrow: **it does not remove
 * the collision, it makes the fix a rule the product already states.** ~~`validateSlug` refuses
 * any slug beginning with `-`, with `reserved-prefix` as its own error code and its own test, and
 * it is the function a Phase 7 space-key validator would reuse — so reserving one character at the
 * top level costs that phase one rule, where reserving `admin`, `mirror`, `search` and whatever
 * comes next costs it a list that grows with every route.~~ **Superseded by Phase 7 Task 6, and
 * the measurement is what supersedes it:** run over the seven top-level segments this application
 * actually has, `validateSlug` accepts six — `admin`, `api`, `search`, `systems`, `edit` and
 * `new` are all legal slugs — so the rule the product already states closes one collision in
 * seven, and the "one rule" this sentence promised the next phase was never available. The
 * argument that replaces it, including why a growing list is affordable when a sweep maintains it,
 * is on {@link RESERVED_TOP_LEVEL_SEGMENTS} below; the six-of-seven count is asserted in
 * `src/lib/spaces/key.test.ts` rather than restated here.
 *
 * The *choice* of `-` is untouched by that: it is still the address a non-space-scoped surface
 * should take, and it is still the one segment a page slug could never shadow from below. `-` is
 * also not a word anybody would name a space, which is not an argument but is worth a line.
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
 * The same debt `/search` already carries and `/-/mirror` measured: `Space.key` was a bare
 * `String @unique` with no validation until Task 6, so nothing stopped a space being created with
 * this key, and Next resolves a static segment ahead of a dynamic one. Task 6 has since made
 * `systems` a refusal with a sentence — see {@link RESERVED_TOP_LEVEL_SEGMENTS} — for keys typed
 * after it, and for no others.
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
 * in"), and this is that phase. `Space.key` was still a bare `String @unique` when this route
 * shipped, so a space keyed `admin` collides with it — but the shape is not `/systems`'s. Task 6
 * closed the window for keys typed after it; see {@link RESERVED_TOP_LEVEL_SEGMENTS}.
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
 * The space administration surface — `/admin/spaces`, Phase 7 Task 6, spec §11.
 *
 * `ADMIN_SYSTEMS_PATH`'s reasons, and it is the **fifth** path in the window a space keyed `admin`
 * would lose: `/admin/systems` was the first, this is the second leaf, and Tasks 7 and 8 add two
 * more. Fully static, so the cost is one path each and the landing page survives — there is still
 * no `/admin/page.tsx`.
 *
 * That window is now closed **going forward** by {@link RESERVED_TOP_LEVEL_SEGMENTS} below, which
 * `validateSpaceKey` refuses against. It is not closed retroactively; see `src/lib/spaces/key.ts`
 * for exactly what a key created before Task 6 can still do.
 */
export const ADMIN_SPACES_PATH = "/admin/spaces" as Route;

/**
 * **Every top-level static route segment in this application**, and therefore every word a
 * `Space.key` must not be — Phase 7 Task 6.
 *
 * A `Space.key` is the first segment of `/{space}` and `/{space}/{...path}`. Next matches a static
 * segment ahead of a dynamic one, so a space whose key is one of these words loses paths to the
 * route that owns the word. Three phases measured the cost against a real `next build` and
 * `next start` rather than reasoning about it, and it is **not uniform**:
 *
 * | Segment | What a space keyed this loses | Measured by |
 * |---|---|---|
 * | `systems` | its landing page **and every depth-one path**, each 404ing rather than falling through — `/systems/[key]` sits in `dynamicRoutes` ahead of `/[space]`, and `[key]` matches any single segment. Depth two and below survive. | Task 3 |
 * | `admin` | exactly one path per leaf below it (`systems`, `spaces`, and Tasks 7–8's two) — fully static, nothing in `dynamicRoutes`, and no `/admin` index, so the landing page survives | Task 5 |
 * | `-` | one path (`mirror`) | Phase 5 Task 8 |
 * | `search`, `new`, `edit`, `api` | not separately measured; `search` and `new` are the `-` shape (a static leaf, or a static segment with a dynamic child in `edit`'s case) | — |
 *
 * ## Phase 5 objected to exactly this list, and the objection does not survive being made concrete
 *
 * `MIRROR_FAILURES_PATH` above argues that reserving `-` "costs that phase one rule, where
 * reserving `admin`, `mirror`, `search` and whatever comes next costs it a list that grows with
 * every route". Three things are wrong with that, and only the first is obvious:
 *
 * 1. **The measurement it rests on is off by six.** The claim was that reserving `-` makes the fix
 *    "a rule the product already states — `validateSlug` refuses a leading `-`". Run over the
 *    seven segments that actually exist, `validateSlug` **accepts six of them**: `admin`, `api`,
 *    `search`, `systems`, `edit` and `new` are all legal slugs, and only `-` is refused. So a slug
 *    rule closes one collision in seven. `src/lib/spaces/key.test.ts` asserts that count rather
 *    than repeating this sentence, so it cannot rot.
 * 2. **The list does not grow with every route; it grows with every top-level *segment*.** A space
 *    key is exactly one segment, so `/admin/spaces` and `/systems/[key]` cannot shadow one at all —
 *    only a new directory directly under `src/app` can. There have been seven in six phases, and
 *    each one was already a decision somebody wrote a docstring about (this file holds three of
 *    them). The true rate is about one per phase, not one per route.
 * 3. **"A list that grows" is only a cost if it is maintained by attention**, and this project
 *    stopped maintaining rules that way six widenings ago. `src/lib/spaces/key.test.ts` derives
 *    the segments from the `src/app` directory and fails when this constant disagrees, exactly as
 *    `src/lib/admin/gate.test.ts` sweeps for an admin module that forgot `refuseNonAdmin` and
 *    `src/lib/pages/visible.test.ts` sweeps for an unregistered query. Adding a top-level route
 *    without deciding about the collision is therefore a **failing test**, not a thing to
 *    remember — which is the only form in which a growing list is affordable, and the form Phase 5
 *    did not consider.
 *
 * The alternatives were weighed against the same three surfaces and lost. *Moving the routes*
 * under `-/` was already refused for `/systems` on §11 grounds ("hiding a documented product
 * surface behind the reserved punctuation"), and it cannot move `api`. *Accepting the collision*
 * means a published page that exists in Postgres and in the git mirror answers 404 — Task 3
 * measured a whole depth-one level of a space disappearing that way. *Delegating to `validateSlug`*
 * is the measurement in (1).
 *
 * ## What this is not
 *
 * **It is not in the database.** `Space_key_shape` constrains the character class, because that is
 * a property of the column that every writer must obey and that `mirrorPathOf` and the folded
 * `@unique` both stand on. A route list is a property of *this application's URL space*, it
 * changes when a directory is added, and encoding it in SQL would be a predicate stated twice with
 * the copy that mattered untestable — the split `validateSystemKey` makes against
 * `System_key_shape`, one rule further along.
 *
 * The consequence, stated rather than left to be found: a key written by a hand-run `UPDATE`, a
 * future importer, or a row that predates Task 6 can still be a reserved word. The CHECK stops
 * none of that, and this list stops only what goes through `validateSpaceKey`.
 */
export const RESERVED_TOP_LEVEL_SEGMENTS: readonly string[] = [
  // `src/app/(reader)/-` — refused by shape long before it reaches this list (a leading hyphen is
  // `validateSlug`'s `reserved-prefix` and the CHECK anchors both ends on an alphanumeric). Listed
  // anyway, because this constant's job is to be the truth about the routes rather than the
  // shortest list that happens to work today, and the sweep compares it against the directory.
  RESERVED,
  // `src/app/(reader)/admin` — `/admin/systems`, `/admin/spaces`, and Tasks 7 and 8.
  "admin",
  // `src/app/api` — every endpoint in the product.
  "api",
  // `src/app/(editor)/edit` — `/edit/[pageId]`.
  "edit",
  // `src/app/(editor)/new`.
  "new",
  // `src/app/(reader)/search` — Phase 4, and the first shadowing route in the product.
  "search",
  // `src/app/(reader)/systems` — Phase 7 Task 3, and the widest of the seven.
  "systems",
];

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
