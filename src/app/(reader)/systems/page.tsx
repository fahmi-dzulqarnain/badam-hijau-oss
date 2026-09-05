import Link from "next/link";
import { requireViewer } from "@/lib/auth/viewer";
import { SYSTEMS_PATH, systemHref } from "@/lib/pages/href";
import { listSystems } from "@/lib/systems/read";
import { SystemRepo } from "@/components/SystemRepo";

/**
 * `/systems` — spec §7's catalogue, and §11's top-level route.
 *
 * §7: *"a lightweight service catalogue … kind, owning team, repository, and whether it is active
 * or being sunsetted"*, and *"systems are global, not owned by a space, and carry no permissions
 * of their own"*. So there is one list, the same list for everyone signed in, and no filtering of
 * any kind happens here — which is worth saying explicitly on the one route in this phase that
 * genuinely has no permission predicate, because the route beside it is the phase's landmine.
 *
 * ## The route collision, measured rather than reasoned about
 *
 * `/systems` is a top-level **static** segment and `Space.key` has no validation until Task 6, so
 * a space keyed `systems` collides with this route. Phase 5 Task 8 measured the same thing for
 * `/-/mirror` and this task measured it the same way, against a real `next build` and
 * `next start` with a space actually keyed `systems` holding two published pages:
 *
 * - `routes-manifest.json` puts `^/systems(?:/)?$` in **`staticRoutes`**, which is matched ahead
 *   of every dynamic route, and `/systems/[key]` at index 11 of `dynamicRoutes` — **before**
 *   `/[space]` at 12 and `/[space]/[...path]` at 17.
 * - `/systems` → `200`, this catalogue. The space's landing page is unreachable.
 * - `/systems/store-ios` → `200`, the system page, over that space's published page at `store-ios`.
 * - `/systems/ordinary` → **`404`**, for a published page that genuinely exists at `ordinary` in
 *   that space. So does `/systems/deep`, whose page has children.
 * - `/systems/no-such-system` → `404`.
 * - `/systems/deep/page` → `200`, the **space's** own page at depth two.
 *
 * **The window is wider than `/-/mirror`'s and the difference is the shape, not the depth.** That
 * route cost a space keyed `-` exactly one URL, because `/-/welcome` still answered with the
 * space's page. Here the shadowing segment is `[key]`, which matches *any* single segment — so a
 * space keyed `systems` loses its landing page and **every page at depth one**, while everything
 * at depth two and below is untouched. The part worth stating separately is the `404`: a shadowed
 * path does **not** fall through to the dynamic route when the system key misses, so those pages
 * are not merely outranked, they are gone.
 *
 * Task 6 validates `Space.key` and makes new collisions unreachable; it does not retro-validate,
 * so a space keyed `systems` created before it would still lose those paths. **No space is keyed
 * `systems` today** — the two that exist are `engineering` and `handbook` — so the window is
 * empty in practice and closes for good three tasks from now.
 */
export default async function SystemsCataloguePage() {
  await requireViewer(SYSTEMS_PATH);

  const systems = await listSystems();

  return (
    <main className="doc">
      <h1>Systems</h1>
      <p className="sys-lead">
        The deployables this documentation is about — apps, services and libraries. A page
        declares the systems it affects in its <code className="sys-code">systems:</code>{" "}
        frontmatter, and each system&rsquo;s own page collects what has been written about it.
        Systems are global: this list is the same for everyone, and naming one grants no access to
        anything.
      </p>

      {systems.length === 0 ? (
        <p className="sys-empty">
          The catalogue is empty. Until a system exists here, no page can declare one — publish
          refuses a <code className="sys-code">systems:</code> key that names nothing.
        </p>
      ) : (
        <ul className="sys-list">
          {systems.map((system) => (
            <li className="sys-row" key={system.key}>
              <p className="sys-head">
                {/*
                  `kind` is §7's first piece of metadata and the column is required, so every row
                  has one. `admin-web` reads `SERVICE` because §5.2's enum has no web-app value —
                  Task 1 recorded that gap rather than widening a normative enum, and said this
                  page is where the evidence for a `WEB_APP` would come from. It reads acceptably.
                */}
                <span className="sys-kind">{system.kind}</span>
                <Link className="sys-name" href={systemHref(system.key)}>
                  {system.name}
                </Link>
                {/*
                  §7's "active or sunsetting". Rendered only when it is false: a badge on every
                  row saying ACTIVE is a badge nobody reads, and the state worth seeing at a
                  glance is the one that changes how a reader treats the documentation.
                */}
                {system.isActive ? null : <span className="sys-sunset">Sunsetting</span>}
              </p>
              {system.description === null ? null : (
                <p className="sys-desc">{system.description}</p>
              )}
              <p className="sys-meta">
                <code className="sys-key">{system.key}</code>
                {system.ownerTeam === null ? (
                  <span className="sys-team sys-none">No owning team</span>
                ) : (
                  <span className="sys-team">{system.ownerTeam}</span>
                )}
                <SystemRepo repo={system.repo} />
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
