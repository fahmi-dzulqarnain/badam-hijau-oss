import type { DocStatus, DocType } from "@prisma/client";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import type { Viewer } from "@/lib/authz/types";

/**
 * The query behind a generated index — spec §11: every ADR or RFC in one space, optionally
 * narrowed to one status.
 *
 * The words, the URL and the status vocabulary live in `src/lib/lifecycle/indexes.ts`, which is
 * pure. This module is only the rows.
 *
 * ## The permission predicate is stated ONCE, on the space, and that is the decision here
 *
 * Two page queries run below and **neither carries `readableSpace`**. The space is resolved
 * first, under `readableSpace`, and an unreadable or nonexistent space returns `not-found`
 * before a single page row is read — so the predicate sits on the thing whose readability the
 * URL is actually asking about, and both page queries carry `spaceId` as a *shape* constraint
 * instead.
 *
 * This is deliberately the `resolveRedirect` shape and not the `listDeletedPages` shape, and the
 * reason is falsifiability rather than economy. Both page queries are bounded to the one space
 * that was verified three lines above, in this same function, with nothing caller-supplied in
 * between — so a `space: readableSpace(viewer)` on either of them can be **deleted with the
 * whole suite still green**, exactly as `resolveRedirect`'s second copy could. Measured on this
 * module, not assumed; the mutation report for this task records it. Removing the predicate that
 * *is* here fails loudly: a stranger stops getting `not-found` and starts getting a list of ADR
 * titles out of a space they cannot read.
 *
 * PROGRESS.md states the rule this follows in one line — *"state a permission predicate once, on
 * the thing whose readability is the question, and let the other filters carry shape constraints
 * with their own tests"* — and it is the opposite of the *other* rule this module could have been
 * written to, `src/lib/pages/repo.ts`'s "every query states its own predicate". They do not
 * actually conflict: `listSpacePages` has no space read of its own, so its predicate is the only
 * one there is. Here there is a space read, so there is a place for the predicate to be tested.
 *
 * ## Soft-deleted pages are absent, and that filter IS on both page queries
 *
 * `visiblePage` owns the top level of both. It is not redundant with anything: a soft-deleted ADR
 * is a live row in a readable space, so nothing else excludes it — and it must be absent from
 * both the list *and* the counts, or the filter chips would advertise a status whose only page
 * cannot be opened.
 *
 * ## Two queries, and the second one is what makes the empty branches truthful
 *
 * `groupBy` over `status` costs one aggregate on an already-filtered set and answers three
 * questions the list alone cannot:
 *
 * - **"no ADRs in this space" versus "no ADRs at this status"** — two different sentences, and
 *   rendering the first when the second is true is a false statement about the space. Without a
 *   total there is no way to tell them apart, because a filtered query returning nothing looks
 *   identical either way.
 * - **The count beside each filter link**, which is what makes the vocabulary-derived filter
 *   usable: the vocabulary offers six statuses for an ADR whether or not any page is at them.
 * - **Whether the list was truncated.** `MAX_INDEX_ROWS` is a rendering bound, so the page has
 *   to be able to say the list is short — and it can only know that by comparing what it got
 *   against what exists.
 *
 * Not wrapped in `React.cache()`, unlike `src/lib/pages/repo.ts`'s readers: one caller per
 * render, and its argument is an object literal, so a cache would never hit while looking as
 * though it did.
 */

/**
 * The most rows one index renders. A rendering bound, not a correctness one: Phase 3 has no
 * pagination, and a space with more than this many ADRs would otherwise paint an unbounded list
 * outside `.body`. The counts come from the aggregate rather than from this array, so a truncated
 * list still reports the true total and says it is short.
 */
export const MAX_INDEX_ROWS = 500;

/** One row of an index: enough to link it, date it and show its status, and nothing else. */
export type DocIndexRow = {
  id: string;
  path: string;
  title: string;
  status: DocStatus;
  publishedAt: Date | null;
  /**
   * Whether it can be linked at all. `getPublishedPage` requires a published version, so a page
   * that has never been published would be a link that 404s for everyone — the nav rail, the
   * breadcrumbs and the relation list all render that case as inert text, and this is the fourth
   * site to need the rule. It is a field rather than a re-derivation in the component because the
   * previous three each grew their own copy of it.
   *
   * Derived from `publishedVersionId`, never `publishedAt`: two independent nullable columns with
   * no constraint tying them together.
   */
  isLinkable: boolean;
};

export type DocIndexListing = {
  rows: DocIndexRow[];
  /** How many pages of this doc type are at each status, before the status filter. */
  counts: ReadonlyMap<DocStatus, number>;
  /** Every page of this doc type in the space, at any status. Not affected by the filter. */
  total: number;
  /** How many the filter matched — equal to `total` when nothing is filtered. */
  matched: number;
  /** `matched` exceeded `MAX_INDEX_ROWS`, so `rows` is short. */
  truncated: boolean;
};

export type DocIndexResult =
  | { ok: true; listing: DocIndexListing }
  /** No such space, or one this viewer cannot read. One answer for both, as everywhere. */
  | { ok: false; reason: "not-found" };

export async function listDocTypePages(
  viewer: Viewer,
  args: { spaceId: string; docType: DocType; status: DocStatus | null },
): Promise<DocIndexResult> {
  const { spaceId, docType, status } = args;

  // The one permission predicate in this module — see the docstring. `readableSpace` is passed
  // whole and never spread. Space has no `deletedAt`, so no `visiblePage` here.
  const space = await db.space.findFirst({
    where: readableSpace(viewer, { id: spaceId }),
    // Explicit select, never `include`. Only the id, which is all the page queries need.
    select: { id: true },
  });
  if (!space) return { ok: false, reason: "not-found" };

  // `visiblePage` owns the top level; `spaceId` and `docType` are shape constraints beside it.
  // Neither helper is spread, at any depth.
  const scope = visiblePage({ spaceId: space.id, docType });

  const grouped = await db.page.groupBy({
    by: ["status"],
    where: scope,
    _count: { _all: true },
  });

  const rows = await db.page.findMany({
    // The same scope object, plus the status filter when there is one. Built as a fresh
    // `visiblePage(...)` call rather than by spreading `scope`, because spreading either helper
    // is the one thing this codebase forbids outright — and a spread here would drop the
    // soft-delete filter with nothing failing until a deleted ADR appeared in the list.
    where: status === null ? scope : visiblePage({ spaceId: space.id, docType, status }),
    /*
     * By path, and the argument is that an ADR's document number is *in* its slug.
     * `adr-0042-mqtt-topic-naming` sorts after `adr-0031-…` because the numbers are
     * zero-padded, so path order is number order for free, and the whole index is stable: a
     * republished page does not move.
     *
     * `publishedAt: "desc"` was the obvious alternative and is wrong for this list. Phase 1
     * measured what a shifting `publishedAt` does to a "recently published" panel — every
     * re-seed reshuffled it — and here it is worse, because fixing a typo in ADR-0031 would
     * move it to the top of a numbered list of decisions. The date is *shown* on every row;
     * it is just not what the list is ordered by.
     *
     * `id` breaks the tie so two pages sharing a path — impossible live, reachable with a
     * soft-deleted row in the table — cannot swap between requests.
     */
    orderBy: [{ path: "asc" }, { id: "asc" }],
    take: MAX_INDEX_ROWS,
    // Explicit select, never `include`.
    select: {
      id: true,
      path: true,
      title: true,
      status: true,
      publishedAt: true,
      publishedVersionId: true,
    },
  });

  const counts = new Map<DocStatus, number>(
    grouped.map((group) => [group.status, group._count._all]),
  );
  let total = 0;
  for (const count of counts.values()) total += count;
  // The filter's own total comes from the same aggregate rather than from a third query, which
  // is what lets `truncated` be a comparison instead of a `take: MAX + 1` trick.
  const matched = status === null ? total : (counts.get(status) ?? 0);

  return {
    ok: true,
    listing: {
      rows: rows.map((row) => ({
        id: row.id,
        path: row.path,
        title: row.title,
        status: row.status,
        publishedAt: row.publishedAt,
        isLinkable: row.publishedVersionId !== null,
      })),
      counts,
      total,
      matched,
      truncated: matched > rows.length,
    },
  };
}
