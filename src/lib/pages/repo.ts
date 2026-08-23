import { cache } from "react";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import type { Viewer } from "@/lib/authz/types";

/**
 * Resolves a space the viewer may read, or null. Unreadable and nonexistent give the same
 * answer, so a title cannot leak through a status code (spec §8).
 *
 * TODO(phase-2): call needsAccessAudit(viewer, space) on the result and write to
 * AuditLog. Every page read must resolve its space through here first, which makes this
 * the right wiring point — but that is a precondition on callers, not a property of this
 * module: listSpacePages applies its own permission filter without passing through here.
 */
export const getReadableSpaceByKey = cache(async (viewer: Viewer, key: string) => {
  return db.space.findFirst({
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
      where: {
        spaceId: space.id,
        path: params.path,
        publishedVersionId: { not: null },
        space: readableSpace(viewer),
      },
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
    where: { spaceId, space: readableSpace(viewer) },
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
    where: { spaceId, publishedAt: { not: null }, space: readableSpace(viewer) },
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
});
