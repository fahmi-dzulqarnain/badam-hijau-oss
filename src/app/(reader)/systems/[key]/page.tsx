import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { dateFormat } from "@/lib/format";
import { SYSTEMS_PATH, pageHref, systemHref } from "@/lib/pages/href";
import { getSystemDocumentation, type SystemDocGroup } from "@/lib/systems/read";
import { SystemRepo } from "@/components/SystemRepo";

/**
 * `/systems/[key]` — spec §7's generated page per system: *"the documentation that affects it,
 * grouped by doc type: ADRs affecting it, its runbooks, open RFCs."*
 *
 * ## This is the phase's landmine, and the route is where it is easiest to see
 *
 * Every other read in this product is scoped to a space the URL names. This one is not: it
 * collects pages from wherever they live, so the list a viewer gets is a **function of their
 * memberships** and nothing else. `getSystemDocumentation` states the readable-space predicate in
 * the query, once, and this route neither adds a filter of its own nor drops a row it was given —
 * a route that filtered what it rendered would be a second copy of the permission rule, in JSX,
 * after fetching, which is the exact shape Phase 4 Task 3 measured leaving 24 tests green over a
 * deleted SQL clause.
 *
 * The proof that it works is a **discrimination**, not an absence: two viewers, one URL, two
 * different lists, both non-empty. `tests/integration/systems-read.test.ts` is where that lives.
 *
 * ## Not-found means not-found, and there is no forbidden branch
 *
 * A system carries no permissions (§7), so the only miss is a key the catalogue does not have.
 * That renders `notFound()` — the same answer an unreadable space gives, which is §8's rule
 * everywhere in this product. A viewer who can read nothing sees the system's metadata and four
 * empty groups, and that is correct rather than a leak: the metadata is global by §7, and no page
 * title, path or space name reaches them.
 *
 * ## Overflow
 *
 * Every string on this page is typed by a person: the system's name, description and owning team
 * by an admin, and each row's title, path and space name by an author, in a space this viewer may
 * be reading for the first time. All of them are painted **outside** `.body`, which is the shape
 * that widened the reader by 4,321px before `.doc > h1` was fixed.
 *
 * **The ninth shape was real and this page had it.** Measured by the injection probe before any
 * of this was written: **515px of overflow on a 1280px viewport**, from a 300-character owning
 * team in a `flex: none` box — `overflow-wrap: anywhere` cannot break a token inside a box that
 * is not allowed to shrink, and `flex: none` is `0 0 auto`. The fix is in `doc.css` beside
 * `.sys-key`, not here. `e2e/systems.spec.ts` measures the class with `HOSTILE` rather than with
 * the seeded corpus, because a guard that asserts a class over a fixed corpus is testing the
 * corpus. This file's job is to keep every such string inside an element that carries a guard,
 * rather than interpolating it into a neighbouring text node.
 */
export default async function SystemPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const viewer = await requireViewer(systemHref(key));

  const result = await getSystemDocumentation(viewer, key);
  if (!result.ok) notFound();

  const { system, groups, documented } = result;
  // Whether any group has something to say — rows, or a count of what it is leaving out. Four
  // empty headings under a system nobody has written about is noise; an RFC group that is hiding
  // three closed proposals is not, even with no open ones.
  const anything = documented > 0 || groups.some((group) => group.excluded > 0);

  return (
    <main className="doc">
      <p className="sys-back">
        <Link href={SYSTEMS_PATH}>Systems</Link>
      </p>
      <h1>{system.name}</h1>

      <p className="sys-meta">
        <span className="sys-kind">{system.kind}</span>
        <code className="sys-key">{system.key}</code>
        {system.ownerTeam === null ? (
          <span className="sys-team sys-none">No owning team</span>
        ) : (
          <span className="sys-team">{system.ownerTeam}</span>
        )}
        <SystemRepo repo={system.repo} />
      </p>

      {system.isActive ? null : (
        <p className="sys-sunset-note">
          This system is being sunsetted. Its documentation is kept and still names it — a
          decommissioning runbook is exactly the sort of page that belongs here.
        </p>
      )}

      {system.description === null ? null : <p className="sys-desc">{system.description}</p>}

      <p className="sys-lead">
        Documentation that names <code className="sys-code">{system.key}</code> in its{" "}
        <code className="sys-code">systems:</code> frontmatter, in every space you can read.
        Someone with different memberships sees a different list on this page.
      </p>

      {anything ? (
        groups.map((group) => <Group key={group.docType} group={group} />)
      ) : (
        <p className="sys-empty">
          No page names this system yet. A page declares one by listing its key under{" "}
          <code className="sys-code">systems:</code> and publishing — and if you can see spaces
          this system is documented in but nothing here, nothing has been written yet; a page you
          cannot read would not appear at all.
        </p>
      )}
    </main>
  );
}

/**
 * One doc-type group.
 *
 * The heading, the blurb and the nouns come from `src/lib/systems/groups.ts`, which is pure and
 * has its own tests — including that the RFC blurb names the statuses it is excluding, derived
 * from the vocabulary rather than typed. Nothing about which statuses "open" means is decided
 * here.
 *
 * **The count sentence is what makes the heading honest.** "Open RFCs" over a list that quietly
 * dropped the closed ones is the same class of lie as a facet that vanishes at publish, so the
 * group says how many it is leaving out, as a number, from the aggregate — not "some may be
 * hidden".
 */
function Group({ group }: { group: SystemDocGroup }) {
  const { heading, blurb, rows, total, excluded, truncated } = group;
  return (
    <section className="sys-group">
      <h2 className="sys-h">{heading}</h2>
      <p className="sys-blurb">{blurb}</p>

      {rows.length === 0 ? (
        <p className="sys-none-row">
          {excluded === 0
            ? "None."
            : excluded === 1
              ? "None — and one is not listed here, see above."
              : `None — and ${excluded} are not listed here, see above.`}
        </p>
      ) : (
        <>
          <ul className="sys-docs">
            {rows.map((row) => (
              <li className="sys-doc" key={row.pageId}>
                <span className="sys-status">{row.status}</span>
                <Link className="sys-title" href={pageHref(row.spaceKey, row.path)}>
                  {row.title}
                </Link>
                <span className="sys-space">{row.spaceName}</span>
                {row.publishedAt === null ? null : (
                  <span className="sys-when">{dateFormat.format(row.publishedAt)}</span>
                )}
                {/* Its own line: a path is the string most likely to be one unbreakable token. */}
                <code className="sys-path">{row.path}</code>
              </li>
            ))}
          </ul>
          {/* Only when there is something to report. An empty sentence under every group is a
              line of chrome that teaches a reader to stop looking at this one. */}
          {truncated || excluded > 0 ? (
            <p className="sys-count">
              {truncated ? `Showing ${rows.length} of ${total}. This page is not paginated.` : null}
              {excluded === 0
                ? null
                : excluded === 1
                  ? `${truncated ? " " : ""}One more is not listed here, see above.`
                  : `${truncated ? " " : ""}${excluded} more are not listed here, see above.`}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
