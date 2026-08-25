import type { DocStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { retiringTypes, type PageRelation } from "@/lib/lifecycle/retired";
import type { Viewer } from "@/lib/authz/types";

/**
 * Reads a page's relations, in both directions — spec §6.2.
 *
 * ## The inverse is derived, never stored
 *
 * §6.2: relations are stored **one direction only** *"so the two sides can never disagree"*. So
 * there is no "superseded by" row to read: the page reader asks the same table twice, once keyed
 * on `fromId` for *what does this page supersede*, and once keyed on `toId` for *what supersedes
 * this page*. The second is why `PageRelation` carries `@@index([toId, type])`; without it the
 * inverse question is a sequential scan of every relation in the product.
 *
 * ## Both directions carry their own permission predicate
 *
 * `readableSpace` sits inside `visiblePage` on the **far** page of each row — the `to` of an
 * outgoing relation, the `from` of an incoming one — because the far page is the one whose
 * readability is the question. A relation must never surface a page the viewer cannot read:
 * `SUPERSEDES` rows are written from validated frontmatter, so an unreadable target cannot be
 * created through the product today, but a `PageRelation` row is just a row, Phase 3's
 * same-space rule is a *resolution* rule rather than a schema constraint, and a later phase that
 * allows cross-space relations must not turn this into a page-title leak. Nothing here trusts
 * the caller's own authorisation of the page being read.
 *
 * There is deliberately **no `spaceId` shape constraint** beside it, which is the opposite
 * choice from `resolveRedirect`'s target filter, and the reason is testability. Scoping these
 * queries to the page's own space would make `readableSpace` unfalsifiable: the viewer is
 * already reading this page, so they can read its space, and no viewer could exist for whom the
 * predicate answered anything. A shape constraint that hides the only rows the permission
 * predicate is there to hide is not defence in depth — it is a predicate stated twice with one
 * copy invisible. So a cross-space relation row is filtered by readability alone, and
 * `relations-read.test.ts` mutates that predicate out and watches another space's page appear.
 *
 * ## Soft-deleted far pages are absent, not rendered
 *
 * `visiblePage` owns the top level of each far-page filter. A relation to a page Task 12 promises
 * is invisible must not put its title in a banner — and the delete path does not remove relation
 * rows (`onDelete: Cascade` fires on a *hard* delete, which nothing in the product does), so this
 * filter is the only thing standing between a soft delete and a link that 404s.
 *
 * ## Two queries, capped, and only one of them runs for a page in force
 *
 * The inverse query runs only when some relation type could have retired a page into this page's
 * status — `retiringTypes`, which is empty for every status a document is in force in. So the
 * hot path (a `CURRENT` doc) pays for one query, not two, and the banner's query is filtered by
 * `type` as well as `toId`, which is what stops a page with five thousand incoming `related:`
 * rows from flooding out the one `SUPERSEDES` row the banner needs.
 *
 * `take` is a rendering bound and not a correctness one: incoming relations are unbounded by
 * construction — any number of pages may declare a relation to this one — and a reader that
 * rendered all of them would paint an unbounded list outside `.body`. `MAX_RELATIONS_RENDERED`
 * is well above `MAX_RELATION_TARGETS` (20), so no single publish can reach it.
 *
 * Not wrapped in `React.cache()`, unlike `src/lib/pages/repo.ts`'s readers: it has one caller per
 * render, and its argument is an object literal, so a cache would never hit while looking as
 * though it did.
 */

/** Per direction. Above any number a page can reach through one publish. */
export const MAX_RELATIONS_RENDERED = 60;

/**
 * The far page of a relation row. Explicit `select`, never `include` — and `space.key` is here
 * because every reader link goes through `pageHref(spaceKey, path)` and a relation's far page is
 * not guaranteed to be in the space the reader is browsing.
 */
const FAR_PAGE = {
  id: true,
  path: true,
  title: true,
  status: true,
  publishedAt: true,
  // "Published" is `publishedVersionId`, never `publishedAt`: two independent nullable columns
  // with nothing tying them together, and a link built on the timestamp alone survives a
  // rollback and 404s.
  publishedVersionId: true,
  space: { select: { key: true } },
} as const;

type FarPage = {
  id: string;
  path: string;
  title: string;
  status: DocStatus;
  publishedAt: Date | null;
  publishedVersionId: string | null;
  space: { key: string };
};

const toRelated = (page: FarPage) => ({
  id: page.id,
  spaceKey: page.space.key,
  path: page.path,
  title: page.title,
  status: page.status,
  publishedAt: page.publishedAt,
  isLinkable: page.publishedVersionId !== null,
});

/**
 * Deterministic, and grouped the way the reader renders: by relation type, then oldest edge
 * first, then by id so two rows written in the same transaction cannot swap between requests.
 */
const RELATION_ORDER = [
  { type: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] as const;

export type PageRelations = {
  /** What this page says about others: it supersedes, decides, amends or relates to them. */
  outgoing: PageRelation[];
  /**
   * The pages that retired this one — the inverse read, already narrowed to the relation types
   * that could have produced this page's status. Empty for a page in force, and empty for a
   * retired page nothing points at, which is a normal state rather than a missing row.
   */
  retiredBy: PageRelation[];
};

export async function getPageRelations(
  viewer: Viewer,
  page: { id: string; status: DocStatus },
): Promise<PageRelations> {
  const outgoingRows = await db.pageRelation.findMany({
    // `visiblePage` owns the top level of the far-page filter and `readableSpace` is passed
    // whole as its `space` relation filter. Neither helper is spread, at any depth.
    where: { fromId: page.id, to: visiblePage({ space: readableSpace(viewer) }) },
    orderBy: [...RELATION_ORDER],
    take: MAX_RELATIONS_RENDERED,
    // Explicit select, never `include`.
    select: { type: true, to: { select: FAR_PAGE } },
  });

  const types = retiringTypes(page.status);
  const incomingRows =
    types.length === 0
      ? []
      : await db.pageRelation.findMany({
          // Keyed on `toId` and `type` — the shape `@@index([toId, type])` exists for. Same
          // filter placement as above, on `from`, which is the far page in this direction.
          where: {
            toId: page.id,
            type: { in: types },
            from: visiblePage({ space: readableSpace(viewer) }),
          },
          orderBy: [...RELATION_ORDER],
          take: MAX_RELATIONS_RENDERED,
          select: { type: true, from: { select: FAR_PAGE } },
        });

  return {
    outgoing: outgoingRows.map((row) => ({ type: row.type, page: toRelated(row.to) })),
    retiredBy: incomingRows.map((row) => ({ type: row.type, page: toRelated(row.from) })),
  };
}
