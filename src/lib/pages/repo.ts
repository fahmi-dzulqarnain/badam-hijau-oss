import { cache } from "react";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { auditSpaceAccess } from "@/lib/audit/log";
import { visiblePage } from "@/lib/pages/visible";
import type { Viewer } from "@/lib/authz/types";

/**
 * Resolves a space the viewer may read, or null. Unreadable and nonexistent give the same
 * answer, so a title cannot leak through a status code (spec §8).
 *
 * **This is where Phase 1's `needsAccessAudit` debt is paid** (spec §8: a super admin reading
 * a `MEMBERS` space they do not belong to leaves a trace). It is the right wiring point for
 * the reason the Phase 1 TODO gave — every space read passes through here — and that remains
 * a precondition on callers rather than a property of this module: `listSpacePages` states its
 * own permission filter and does not pass through here, so it audits nothing. That is
 * consistent rather than lax: the routes that call it resolve the space through this function
 * first, and the audit is per request, so the row is already written.
 *
 * The audit does not block or endanger the read. `auditSpaceAccess` hands the write to
 * `after()` and cannot throw; see its docstring for why those are two mechanisms and not one
 * restated twice.
 */
export const getReadableSpaceByKey = cache(async (viewer: Viewer, key: string) => {
  const space = await db.space.findFirst({
    // No `visiblePage()` here, deliberately: this queries Space, which has no `deletedAt`.
    // Listed as exempt in the soft-delete guard test rather than simply omitted from it.
    where: readableSpace(viewer, { key }),
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      initials: true,
      visibility: true,
    },
  });

  // Nothing to audit for a miss: unreadable and nonexistent are the same answer here, and
  // neither is an access to a space.
  if (space) await auditSpaceAccess(viewer, space);

  return space;
});

/**
 * One rule for this whole module: every query states its own permission predicate, even
 * when the caller has already resolved a readable space. A reader should never have to
 * work out whether a given query is guarded by its own filter or by call ordering.
 */
export const getPublishedPage = cache(
  async (viewer: Viewer, params: { spaceKey: string; path: string }) => {
    const space = await getReadableSpaceByKey(viewer, params.spaceKey);
    if (!space) return null;

    const page = await db.page.findFirst({
      // Both helpers return COMPLETE `where` objects and neither is spread: `visiblePage`
      // owns the top level, and `readableSpace` is passed whole as the `space` relation
      // filter beside the other conditions. Spreading either one silently drops it.
      where: visiblePage({
        spaceId: space.id,
        path: params.path,
        publishedVersionId: { not: null },
        space: readableSpace(viewer),
      }),
      // Explicit select, never `include`. Prisma expands `include: true` into a column
      // list at generation time, so `include` would silently start shipping every column
      // a later phase adds — starting with Phase 2's cached render on PageVersion.
      select: {
        id: true,
        title: true,
        path: true,
        status: true,
        docType: true,
        publishedAt: true,
        reviewedAt: true,
        // The id as well as the name, because spec §12's review confirmation is the owner's to
        // make and the reader route decides whether to offer the control. `mayConfirmReview` is
        // the one place that comparison is written; this is only the column it needs.
        ownerId: true,
        owner: { select: { name: true } },
        publishedVersion: { select: { id: true, markdown: true, gitSha: true } },
        _count: { select: { versions: true } },
      },
    });

    if (!page?.publishedVersion) return null;

    // Destructured so callers get a non-nullable `version` and a `page` that no longer
    // carries a redundant nullable copy of it.
    const { publishedVersion, ...rest } = page;
    return { space, page: rest, version: publishedVersion };
  },
);

export const listSpacePages = cache(async (viewer: Viewer, spaceId: string) => {
  return db.page.findMany({
    where: visiblePage({ spaceId, space: readableSpace(viewer) }),
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: {
      id: true,
      parentId: true,
      slug: true,
      path: true,
      title: true,
      status: true,
      docType: true,
      publishedVersionId: true,
    },
  });
});

export const listRecentlyPublished = cache(
  async (viewer: Viewer, spaceId: string, limit = 5) => {
    return db.page.findMany({
      // `publishedAt` and `publishedVersionId` are two independent nullable columns with no
      // constraint tying them together, so "published" has to be stated as both. Filtering
      // on the timestamp alone would survive an unpublish or a rollback (Phase 2) and yield
      // a row whose link 404s and whose byline has no author.
      where: visiblePage({
        spaceId,
        publishedAt: { not: null },
        publishedVersionId: { not: null },
        space: readableSpace(viewer),
      }),
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: {
        id: true,
        title: true,
        path: true,
        publishedAt: true,
        publishedVersion: { select: { author: { select: { name: true } } } },
      },
    });
  },
);

/**
 * The redirect a moved page left behind, resolved to where that page is **now**.
 *
 * Returns `null` when there is nothing to redirect to, which the reader turns into the same
 * 404 an unreadable or nonexistent page gets. Three independent reasons it returns null, and
 * all three matter:
 *
 * - **No `Redirect` row at this path.** The ordinary miss.
 * - **The space is not readable.** A redirect that answered differently for a member and a
 *   non-member would tell the non-member the page exists — the third way to break the
 *   404-not-403 rule after `getPublishedPage` and `getPageForEditing`, and it has to be
 *   closed in the same place: on the query, not on the caller.
 * - **The target is soft-deleted.** Task 10 writes redirects for soft-deleted rows
 *   deliberately, so they start working again on restore. Until then they must not deliver
 *   anyone to a page that 404s.
 *
 * **One hop, and the schema is why one hop is enough.** `Redirect` stores `toPageId`, not a
 * target path, so this resolves through the page's *current* path. A page moved three times
 * has three redirect rows and every one of them lands on it in a single hop; a chain is not
 * merely unfollowed here, it is unrepresentable. Do not add a `toPath` column and do not
 * follow a second lookup — that would turn a move bug into an infinite loop in production
 * instead of a wrong answer in a test.
 *
 * Like every other query in this module, this one states its own permission predicate rather
 * than trusting the caller to have resolved a readable space first. It states it **once**,
 * and that is a decision with a measurement behind it: the first version of this function
 * carried `readableSpace` on both the redirect's space and the target page's space, and
 * *dropping either one alone passed the entire suite*. Two statements of one predicate make
 * neither of them testable — the redundancy that reads as defence in depth is exactly what
 * stops a mutation from being caught. One statement, on the space the URL names, which is the
 * space whose readability is the question being asked.
 */
export const resolveRedirect = cache(
  async (viewer: Viewer, params: { spaceKey: string; path: string }) => {
    const hit = await db.redirect.findFirst({
      where: {
        fromPath: params.path,
        // Neither helper is spread; each is passed whole. `readableSpace` is the `space`
        // relation filter and `visiblePage` owns the `toPage` filter entirely.
        space: readableSpace(viewer, { key: params.spaceKey }),
        // NOT a second permission check — see above. Two shape constraints on the target,
        // each with its own test: it must not be soft-deleted, and it must live in the space
        // the URL names, so a `Redirect` row pointing across spaces cannot make this function
        // answer with a `/{thisSpace}/{otherSpacePath}` URL.
        toPage: visiblePage({ space: { key: params.spaceKey } }),
      },
      // Explicit select, never `include`.
      select: { toPage: { select: { id: true, path: true } } },
    });

    if (!hit) return null;

    // Defence in depth, not the mechanism. A redirect standing at the live path of its own
    // target would make the reader redirect a URL to itself, which browsers follow until
    // they give up. Task 10's reclaiming `deleteMany` is what prevents that row from
    // existing; this line makes the consequence of a bug in it a 404 rather than a loop.
    if (hit.toPage.path === params.path) return null;

    return { pageId: hit.toPage.id, path: hit.toPage.path };
  },
);
