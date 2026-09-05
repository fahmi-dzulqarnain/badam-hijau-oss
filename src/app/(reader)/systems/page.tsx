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
 * - `routes-manifest.json` lists `^/systems(?:/)?$` and `^/systems/([^/]+?)(?:/)?$` **before**
 *   `^/([^/]+?)(?:/)?$` and `^/([^/]+?)/(.+?)(?:/)?$`.
 * - `/systems` answered `200` with this page — the catalogue, not the space landing.
 * - `/systems/store-ios` answered `200` with the system page, shadowing that space's page at
 *   `store-ios`.
 * - `/systems/deep/page` answered `200` with the **space's** page, because `[key]` matches one
 *   segment and `[...path]` catches the rest.
 * - `/systems/no-such-system` answered `404`, and a page genuinely at that path in the space is
 *   unreachable — the shadow does not fall through to the dynamic route on a miss.
 *
 * **So the window is exactly two paths deep, not one**, which is where this differs from
 * `/-/mirror`: `/systems` costs such a space its landing page, and `/systems/<one segment>` costs
 * it every page at depth one — including, and this is the part worth stating, pages that *exist*,
 * which answer 404 rather than falling through. Anything deeper is untouched. Task 6 validates
 * `Space.key` and makes new collisions unreachable; it does not retro-validate, so a space keyed
 * `systems` created before it still loses these paths, and no space is keyed `systems` today.
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
