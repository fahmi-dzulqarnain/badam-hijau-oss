import Link from "next/link";
import { pageHref } from "@/lib/pages/href";
import { dateFormat } from "@/lib/format";
import { forwardLabel, inverseLabel } from "@/lib/lifecycle/retired";
import type { PageRelation, RetirementNotice } from "@/lib/lifecycle/retired";

/**
 * The two surfaces a page's relations get on the reader — spec §6.2 and §6.4.
 *
 * **One file for both, deliberately.** They share how the far page of a relation is rendered:
 * through `pageHref`, as inert text when it has never been published, and with the
 * overflow-wrap guard every user-typed string painted outside `.body` needs. That rule has been
 * dropped by the third site to need it twice in this project — the draft-is-inert rule and the
 * path-encoding rule were each honoured by the nav rail and the breadcrumbs and then quietly
 * lost — and both times the fix was to make it one function rather than one habit. So the row is
 * `RelationRow` and neither component gets its own copy.
 */

/**
 * One relation, as a label and a far page.
 *
 * `title` is user-typed and painted **outside** `.body`, so it is the sixth candidate for the
 * horizontal-overflow class that has bitten five times. The guard is in `doc.css` on `.rel-row`
 * and `.rel-title`; this component's job is to keep the title inside an element that carries it
 * rather than, say, interpolating it into the label's text node.
 */
function RelationRow({ label, relation }: { label: string; relation: PageRelation }) {
  const { page } = relation;
  return (
    <li className="rel-row">
      <span className="rel-k">{label}</span>
      {page.isLinkable ? (
        <Link className="rel-title" href={pageHref(page.spaceKey, page.path)}>
          {page.title}
        </Link>
      ) : (
        // Never published, so `getPublishedPage` would 404 for everyone — inert text, exactly as
        // the nav rail and the breadcrumbs render an unpublished page.
        <span className="rel-title rel-inert">{page.title}</span>
      )}
      {page.publishedAt ? (
        <span className="rel-when">published {dateFormat.format(page.publishedAt)}</span>
      ) : null}
    </li>
  );
}

/**
 * The retired banner — spec §6.4, above the body and naming the replacement.
 *
 * **The body is untouched.** Nothing here hides, truncates, collapses or greys it: a retired
 * document is history, not an error state, and §6.4 says it stays fully readable. This renders a
 * sibling above `.body` and no rule in `doc.css` reaches into it.
 *
 * The date is the replacement's own publish date, labelled as that rather than as a retirement
 * date. `src/lib/lifecycle/retired.ts` argues why at length — in short, nothing in the schema
 * records the instant a status changed, and the two candidates that look like it are each wrong
 * for one of the two ways a page gets retired.
 *
 * The no-replacement branch is not a fallback for missing data. A page an author retired on its
 * own page has no incoming relation, an `ARCHIVED` doc can never have one, and a page whose
 * replacement dropped its `supersedes:` key keeps its status — removal does not un-retire the
 * target. So the banner says the page is history and that nothing here names a replacement,
 * which is all that is actually known.
 */
export function RetiredBanner({ notice }: { notice: RetirementNotice }) {
  return (
    <aside className="retired" aria-label="Lifecycle status">
      <p className="retired-lead">{notice.lead}</p>
      {notice.replacements.length > 0 ? (
        <ul className="rel-list">
          {notice.replacements.map((relation) => (
            <RelationRow
              key={`${relation.type}-${relation.page.id}`}
              label={inverseLabel(relation.type)}
              relation={relation}
            />
          ))}
        </ul>
      ) : (
        <p className="retired-none">
          No page here names a replacement — it was retired on its own page, or the document
          that replaced it no longer says so.
        </p>
      )}
      <p className="retired-still">Everything below still reads as it was written.</p>
    </aside>
  );
}

/**
 * What this page says about others — the stored direction of §6.2, below the body.
 *
 * Below rather than above, because the banner is about the page the reader is on and this is a
 * list of other documents; and inside `.doc` rather than in `.rail-r`, because `doc.css` hides
 * the right rail entirely below 1180px and a relation that vanished on a laptop in a split
 * window would be the same bug as Phase 1's dialog inside `.rail-l`.
 *
 * Renders nothing at all when the page declares no relations, rather than an empty heading.
 */
export function RelationList({ relations }: { relations: PageRelation[] }) {
  if (relations.length === 0) return null;
  return (
    <section className="rels" aria-labelledby="rels-head">
      <h2 className="rels-head" id="rels-head">
        Relations
      </h2>
      <ul className="rel-list">
        {relations.map((relation) => (
          <RelationRow
            key={`${relation.type}-${relation.page.id}`}
            label={forwardLabel(relation.type)}
            relation={relation}
          />
        ))}
      </ul>
    </section>
  );
}
