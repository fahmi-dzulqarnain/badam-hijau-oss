import type { Route } from "next";
import type { BugStatus } from "@prisma/client";

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
 * **It is no longer a *top-level* segment**, and that is Phase 7 Task 7's doing: `/-/mirror` was
 * the only route directly under `-`, and absorbing it into {@link ADMIN_GIT_PATH} deleted the
 * directory. So `-` is absent from {@link RESERVED_TOP_LEVEL_SEGMENTS} below — the sweep in
 * `src/lib/spaces/key.test.ts` reads that list off `src/app` and would fail if it were still
 * there — while every use here, all of them one level *inside* a space, is untouched.
 *
 * It is **not** percent-encoded, deliberately: it is a literal route segment, not data, and
 * `encodeURIComponent("-")` happens to be the identity today — a fact this would be relying on
 * silently. Written out here once so the two builders below cannot disagree about it.
 */
const RESERVED = "-";

/**
 * The systems catalogue — `/systems`, Phase 7 Task 3, spec §7 and §11.
 *
 * A constant for the reason {@link ADMIN_GIT_PATH} is one: three files name it (the two routes'
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
 * A constant for {@link ADMIN_GIT_PATH}'s reason: the route's own `requireViewer` return path, the
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
 * The git mirror's administration surface — `/admin/git`, Phase 7 Task 7, spec §10 and §11.
 *
 * A constant for `ADMIN_SYSTEMS_PATH`'s reason: the route's own `requireViewer` return path, the
 * version-history link that reaches it, the two endpoints under it and the layout's cross-links
 * all name this address.
 *
 * ## It replaces `/-/mirror`, and the old URL is a 404 rather than a redirect
 *
 * Phase 5 Task 8 shipped the failures list at `/-/mirror` as **explicitly provisional** — *"Phase
 * 7 owns `/admin` and will fold this in"* — and this task folds it in. It is a **move and not a
 * copy**: two surfaces for one thing is how one of them goes stale, and the second one would be
 * the one nobody links to.
 *
 * `/-/mirror` now answers **not-found**, because the route it named is gone and `/-` is not a
 * space. That is a decision and not a leftover; a redirect was the alternative and loses on three
 * counts:
 *
 * 1. **A redirect is itself a route, and this one would answer every visitor.** The refusal on
 *    this surface is not-found precisely so that an ordinary member learns nothing about the shape
 *    of the system (§8, `src/lib/admin/gate.ts`) — and a `308` to `/admin/git` tells them a git
 *    administration surface exists, from a URL that is otherwise a 404. Gating the redirect
 *    instead would mean a second statement of the admin predicate on a route whose whole purpose
 *    is to be obsolete.
 * 2. **Nothing external holds the old URL.** Phase 5 Task 8 measured that the failures page had
 *    exactly **one** affordance — the version-history page's stuck notice, shown only to a super
 *    admin — and it is generated from this constant, so it moves in the same commit. There is no
 *    published link, no email, no bookmark this product handed anybody.
 * 3. **Keeping it alive keeps the collision.** A route under `-` is a top-level static segment,
 *    and {@link RESERVED_TOP_LEVEL_SEGMENTS} below is a list of exactly those. Deleting the
 *    directory hands the segment back: `-` is no longer a top-level route at all, which is why it
 *    is no longer on that list — the sweep in `src/lib/spaces/key.test.ts` compares the constant
 *    against the directory and would fail if it were.
 *
 * ## The window a space keyed `admin` loses, and this leaf's share of it
 *
 * Fully static, two literal segments, so `routes-manifest.json` puts it in `staticRoutes` and adds
 * nothing to `dynamicRoutes`: the cost is exactly **one more path**, and the landing page survives
 * — Task 5's measured shape, which was itself measured as `/-/mirror`'s. There is still no
 * `/admin/page.tsx`. The move is therefore net **zero** paths: `/-/mirror` gave one back.
 */
export const ADMIN_GIT_PATH = "/admin/git" as Route;

/**
 * The bug-report triage surface — `/admin/bugs`, Phase 7 Task 8, spec §11 and §18.2's *"listed for
 * admins at `/admin/bugs`"*.
 *
 * A constant for `ADMIN_SYSTEMS_PATH`'s reason: the route's own `requireViewer` return path, the
 * layout's cross-links and the endpoint below it all name this address.
 *
 * **The fourth and last leaf**, so this is where the `admin` window stops widening for this phase.
 * Fully static, two literal segments, so `routes-manifest.json` puts it in `staticRoutes` and adds
 * nothing to `dynamicRoutes` — Task 5's measured class, and one more path lost by a hypothetical
 * space keyed `admin`, whose landing page still survives because there is still no
 * `/admin/page.tsx`. Four leaves now index each other from the layout, which creates no route; an
 * `/admin` index would be the fifth path and would take the landing page with it, and Task 9 is
 * where a decision about one belongs.
 *
 * The page reads a `?status=` filter, which changes none of that: `searchParams` are not segments,
 * so nothing about the manifest or the collision depends on them.
 */
export const ADMIN_BUGS_PATH = "/admin/bugs" as Route;

/**
 * `/admin/bugs`, optionally filtered to one status.
 *
 * A function rather than a template literal at each of the four call sites, for `pageHref`'s
 * reason: **every link to a thing goes through one function**, because the moment there are two
 * they disagree — the draft-is-inert rule and the path-encoding rule were each honoured by two
 * link sites and quietly dropped by the third. Here the divergence waiting to happen is the
 * *unfiltered* case, which is `ADMIN_BUGS_PATH` with no query string at all and not `?status=`.
 *
 * `BugStatus` is an enum of three uppercase words, so nothing needs encoding — and it is encoded
 * anyway, for the reason `pageHref` states: the guarantee lives in a Prisma enum this function
 * cannot see.
 */
export function adminBugsHref(status: BugStatus | null): Route {
  if (status === null) return ADMIN_BUGS_PATH;
  return `${ADMIN_BUGS_PATH}?status=${encodeURIComponent(status)}` as Route;
}

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
 * | `admin` | exactly one path per leaf below it (`systems`, `spaces`, `git`, `bugs`) — all four fully static, nothing in `dynamicRoutes`, and no `/admin` index, so the landing page survives | Task 5 |
 * | ~~`-`~~ | ~~one path (`mirror`)~~ — **no longer a top-level segment**: Task 7 absorbed `/-/mirror` into `/admin/git` and deleted the directory, so this row is history and the entry is gone from the list below | Phase 5 Task 8 |
 * | `search`, `new`, `edit`, `api` | not separately measured; `search` and `new` are the `-` shape (a static leaf, or a static segment with a dynamic child in `edit`'s case) | — |
 *
 * ## Phase 5 objected to exactly this list, and the objection does not survive being made concrete
 *
 * Phase 5 Task 8's `/-/mirror` argued that reserving `-` "costs that phase one rule, where
 * reserving `admin`, `mirror`, `search` and whatever comes next costs it a list that grows with
 * every route". Three things are wrong with that, and only the first is obvious:
 *
 * 1. **The measurement it rests on is off by six — and Task 7 has since made it off by all of
 *    them.** The claim was that reserving `-` makes the fix "a rule the product already states —
 *    `validateSlug` refuses a leading `-`". Run over the seven segments that existed when Task 6
 *    measured it, `validateSlug` **accepted six**: `admin`, `api`, `search`, `systems`, `edit` and
 *    `new` are all legal slugs, and only `-` was refused. Task 7 then absorbed `/-/mirror` into
 *    `/admin/git` and deleted the `-` directory, so the one segment that rule closed is not a
 *    top-level route any more: over the **six** that remain it closes **none**.
 *    `src/lib/spaces/key.test.ts` asserts that count rather than repeating this sentence, so it
 *    cannot rot — and it did not: the count moved under it and the assertion is what said so.
 * 2. **The list does not grow with every route; it grows with every top-level *segment*.** A space
 *    key is exactly one segment, so `/admin/spaces` and `/systems/[key]` cannot shadow one at all —
 *    only a new directory directly under `src/app` can. There have been seven in six phases — six
 *    now, Task 7 having given `-` back — and each one was already a decision somebody wrote a
 *    docstring about (this file holds four of them). The true rate is about one per phase, not one
 *    per route, and it is not monotonic.
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
  // `-` USED to be here, and Phase 7 Task 7 is why it is not: `/-/mirror` was the only route
  // directly under `src/app/(reader)/-`, so absorbing it into `/admin/git` deleted the directory
  // and the segment with it. The sweep in `src/lib/spaces/key.test.ts` compares this list against
  // `src/app`, so leaving the entry in would be a failing test rather than harmless caution — and
  // nothing is lost, because a leading hyphen is refused by shape (`hyphen-edge` here,
  // `reserved-prefix` in `validateSlug`) and by the CHECK, which anchors both ends on an
  // alphanumeric. That is asserted in `key.test.ts` rather than trusted from this comment.
  //
  // It also moves the measurement Task 6 rested an argument on: `-` was the ONE segment of seven
  // that `validateSlug` refused, so with it gone a slug rule closes **none** of the six that
  // remain. Phase 5's "one rule" promise is not merely off by six now; it is off by all of them.
  //
  // `src/app/(reader)/admin` — `/admin/systems`, `/admin/spaces`, `/admin/git`, `/admin/bugs`.
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
