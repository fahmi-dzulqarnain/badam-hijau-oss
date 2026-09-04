import type { DocStatus, DocType, GitJobState } from "@prisma/client";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import type { Viewer } from "@/lib/authz/types";

/**
 * A page's version history — spec §10: *"The reader surfaces the published commit sha on the
 * page and links to version history, so provenance is visible and a broken mirror is
 * noticed."*
 *
 * ## The permission is the page's own, and it is stated HERE
 *
 * Both predicates are on the one page query below and each is stated exactly once:
 *
 * - **`visiblePage()` owns the top level.** A soft-deleted page has no readable history: Task 12
 *   promises a delete removes the page from the product and a restore brings it back as it was,
 *   and a history route that went on answering would be the one surface that ignored the delete.
 * - **`readableSpace(viewer, { key })` is the `space` relation filter**, keyed on the space the
 *   *URL* names. That is the space whose readability is the question being asked, so it is where
 *   the predicate belongs.
 *
 * Neither helper is spread, at any nesting depth. `visiblePage` and `readableSpace` both return
 * complete `where` objects whose own top-level `AND`/`OR` a spread would silently replace — a
 * total soft-delete or authorization bypass that neither tsc nor Prisma can detect.
 *
 * There is **no space read of its own here**, which is why the shape differs from
 * `listDocTypePages`: with nothing to resolve first there is nowhere else the predicate could
 * live, so this is `src/lib/pages/repo.ts`'s shape — one query, both predicates on it, both
 * falsifiable. The two rules only look like they conflict; what decides between them is whether
 * a second statement of the predicate would be *testable*, and here there is only one statement
 * to begin with.
 *
 * The version and job queries below carry **no** permission predicate and that is deliberate:
 * they are keyed on the `pageId` this function has just authorised, in this same function, with
 * nothing caller-supplied in between. A `page: visiblePage(...)` on either of them could be
 * deleted with the whole suite green — the `resolveRedirect` shape, measured twice in this
 * project — so restating it would make neither copy testable. What is asserted instead is that
 * removing the predicate that *is* here changes the answer; see `tests/integration/page-history.test.ts`.
 *
 * ## An unpublished page has an empty history rather than a 404
 *
 * The reader route 404s a page with no published version, because there is no text to render.
 * This route answers a different question and answers it truthfully: the page exists, the viewer
 * may read it, and nobody has published it yet. Nothing leaks by saying so — `listSpacePages`
 * already puts every unpublished page's title in the nav rail of anyone who can read the space,
 * as inert text — and a 404 here would be the surface that pretends a page a reader can *see* in
 * the rail does not exist.
 *
 * ## No audit row
 *
 * Reading history is a read of a page the viewer may already read, in a space whose access is
 * already audited by `getReadableSpaceByKey` on the request that got them here. §8's audit is
 * about a super admin reaching into a `MEMBERS` space, and it is written once per request at the
 * space boundary; a second row saying the same person read the same space again would make the
 * trail longer without making it say anything new. `src/lib/audit/log.ts` is the only module
 * allowed to write one, and this asks it for nothing.
 */

/**
 * The most version rows one page renders.
 *
 * A rendering bound, not a correctness one, exactly like `MAX_INDEX_ROWS`: this phase has no
 * pagination, and a page republished a few thousand times would otherwise paint an unbounded
 * list. `total` comes from a `_count` on the page row rather than from this array, so a truncated
 * list still reports the true number and can say it is short.
 */
export const MAX_HISTORY_ROWS = 200;

/** One published version: enough to date it, attribute it, and say where it is mirrored. */
export type PageVersionRow = {
  id: string;
  createdAt: Date;
  /** The status this version was published into — a version's own, not the page's current one. */
  status: DocStatus;
  /**
   * The version's title, or `null` when it is the page's current title.
   *
   * Nulled here rather than in the component so the "did the title change" comparison is made
   * once, against the row the page query already read. A rename is a real thing history should
   * show; repeating the current title on every row is noise, and it is 300 characters of
   * user-controlled text per row on a surface that has to stay inside its box.
   */
  renamedTo: string | null;
  /**
   * The publisher — `PageVersion.authorId`, which `publishPage` sets to the viewer who published
   * and not to the last person who autosaved.
   *
   * User-controlled text from the OIDC profile, like a title: it goes through React's escaping
   * and `doc.css`'s wrapping, the same as Phase 4's search results, where "it is only my own
   * text" stopped being an argument.
   */
  authorName: string;
  /** The content-repository commit, or `null` — a normal state. See `NOT_MIRRORED`. */
  gitSha: string | null;
  /** This version is the one the reader route renders. */
  isPublished: boolean;
};

/**
 * What this page's mirror queue is doing — the third reason a `gitSha` can be null, which no
 * amount of looking at `PageVersion` can distinguish.
 *
 * **Counted per page and not per version, deliberately.** A `MOVE`, `DELETE` or `RESTORE` job
 * carries `versionId: null` by design, so a page can be wedged by a failure that belongs to no
 * version at all — and Task 6's ordering barrier means a `FAILED` job blocks every later job for
 * *that page*, so the newest version's own job being `PENDING` is not the useful fact. The useful
 * fact is about the page: something is queued, or something gave up.
 *
 * No error text. `GitJob.lastError` is git's stderr, which can name the remote, a filesystem path
 * inside the container and whatever else git chose to say; it is Task 8's super-admin surface
 * that shows it. A reader is told the state, which is what lets them tell somebody.
 */
export type MirrorQueue = {
  /** Jobs not yet finished — `PENDING` or `RUNNING`. */
  queued: number;
  /** Jobs that reached the attempt ceiling. Blocks this page's queue until an admin intervenes. */
  failed: number;
};

export type PageHistory = {
  page: {
    id: string;
    title: string;
    path: string;
    status: DocStatus;
    docType: DocType;
    /**
     * Whether the page can be linked at all. `getPublishedPage` requires a published version, so
     * a link to a page that has never been published would 404 for everyone — the nav rail, the
     * breadcrumbs, the relation list and `DocIndexRow` each carry this rule, and this is the
     * fifth site to need it. Derived from `publishedVersionId`, never `publishedAt`.
     */
    isLinkable: boolean;
  };
  /** Newest first, capped at `MAX_HISTORY_ROWS`. */
  rows: PageVersionRow[];
  /** Every version of this page, whether or not it is in `rows`. */
  total: number;
  /** `total` exceeded `MAX_HISTORY_ROWS`, so `rows` is short. */
  truncated: boolean;
  mirror: MirrorQueue;
};

export type PageHistoryResult =
  | { ok: true; history: PageHistory }
  /** No such page, or one this viewer cannot read. One answer for both, as everywhere. */
  | { ok: false; reason: "not-found" };

/**
 * Folds a `groupBy` over `GitJob.state` into the two numbers a reader is shown.
 *
 * Pure, and separate from the query for one reason: `PENDING` and `RUNNING` are two states with
 * one meaning to a reader, `DONE` has none, and the mapping is the part worth being able to test
 * against every member of the enum. A `GitJobState` added without a decision here fails to
 * compile, the way `DOC_INDEXES` and `PUBLISHABLE_INTO` do.
 */
export function mirrorQueueOf(
  groups: readonly { state: GitJobState; count: number }[],
): MirrorQueue {
  const queue: MirrorQueue = { queued: 0, failed: 0 };
  for (const group of groups) {
    switch (group.state) {
      case "PENDING":
      case "RUNNING":
        queue.queued += group.count;
        break;
      case "FAILED":
        queue.failed += group.count;
        break;
      case "DONE":
        // Nothing to say. A finished job's only observable is the sha on the row it wrote.
        break;
    }
  }
  return queue;
}

export async function listPageVersions(
  viewer: Viewer,
  params: { spaceKey: string; path: string },
): Promise<PageHistoryResult> {
  // The only permission predicate in this module — see the docstring. Neither helper is spread:
  // `visiblePage` owns the top level and `readableSpace` is passed whole as the `space` relation
  // filter. The space key and the path together are unique, because `@@unique([spaceId, path])`
  // and `Space.key` is unique, so this reads at most one row.
  const page = await db.page.findFirst({
    where: visiblePage({
      path: params.path,
      space: readableSpace(viewer, { key: params.spaceKey }),
    }),
    // Explicit select, never `include`.
    select: {
      id: true,
      title: true,
      path: true,
      status: true,
      docType: true,
      publishedVersionId: true,
      // The total, without a second query and without reading rows this list will not show.
      _count: { select: { versions: true } },
    },
  });
  if (!page) return { ok: false, reason: "not-found" };

  const versions = await db.pageVersion.findMany({
    // No permission predicate, and no soft-delete filter: keyed on the page authorised above,
    // in this same function. See the docstring for why a second copy would be untestable.
    where: { pageId: page.id },
    /*
     * Newest first, which is the opposite of the ADR index's `path` order and for the opposite
     * reason: an index is a stable catalogue, and a history is a stack — the version a reader
     * arrived asking about is the most recent one.
     *
     * `id` breaks the tie. Two versions of one page cannot share a `createdAt` through the
     * product (one publish per transaction, and a publish takes a row lock), but a seed or a
     * fixture can write them, and a list whose order changes between two requests for no visible
     * reason is worse than one whose tiebreak is arbitrary but fixed.
     */
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_HISTORY_ROWS,
    // Explicit select, never `include`. `markdown` is deliberately absent — this is a list of
    // versions, not a diff viewer, and selecting the document text of 200 versions to render
    // none of it is the shape `include` would have produced by accident.
    //
    // `message` is absent too, and that is a decision rather than an oversight: nothing in the
    // product writes it. `publishPage` does not, so every row's value is `null` today; the
    // worker reads it as the note in a commit message. When a phase gives publishing a note,
    // this row is where it goes.
    select: {
      id: true,
      createdAt: true,
      status: true,
      title: true,
      gitSha: true,
      author: { select: { name: true } },
    },
  });

  // Same reasoning as the version query: keyed on the authorised page id, no predicate of its
  // own. One aggregate, served by `@@index([pageId, id])`'s leading column.
  const jobs = await db.gitJob.groupBy({
    by: ["state"],
    where: { pageId: page.id },
    _count: { _all: true },
  });

  return {
    ok: true,
    history: {
      page: {
        id: page.id,
        title: page.title,
        path: page.path,
        status: page.status,
        docType: page.docType,
        isLinkable: page.publishedVersionId !== null,
      },
      rows: versions.map((version) => ({
        id: version.id,
        createdAt: version.createdAt,
        status: version.status,
        renamedTo: version.title === page.title ? null : version.title,
        authorName: version.author.name,
        gitSha: version.gitSha,
        // `publishedVersionId`, never `publishedAt`: two independent nullable columns with no
        // constraint tying them together, the rule `listRecentlyPublished` and `DocIndexRow`
        // both carry.
        isPublished: page.publishedVersionId === version.id,
      })),
      total: page._count.versions,
      truncated: page._count.versions > versions.length,
      mirror: mirrorQueueOf(
        jobs.map((group) => ({ state: group.state, count: group._count._all })),
      ),
    },
  };
}
