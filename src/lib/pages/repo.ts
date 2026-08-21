import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import type { Viewer } from "@/lib/authz/types";

export async function getReadableSpaceByKey(key: string, viewer: Viewer) {
  // TODO(phase-2): call needsAccessAudit(viewer, space) on the result and write to
  // AuditLog. This is the single funnel every space read passes through, so it is the
  // correct wiring point for spec §8's super-admin audit requirement.
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
}

export async function getPublishedPage(params: {
  spaceKey: string;
  path: string;
  viewer: Viewer;
}) {
  const space = await getReadableSpaceByKey(params.spaceKey, params.viewer);
  if (!space) return null;

  // No `space: readableSpace(viewer)` on this query, deliberately: the space was
  // resolved through the permission check three lines above, inside this same function.
  // The guarantee is local, not a convention spanning a call boundary — which is the
  // distinction that makes `listSpacePages` below take the viewer instead.
  const page = await db.page.findFirst({
    where: {
      spaceId: space.id,
      path: params.path,
      publishedVersionId: { not: null },
    },
    include: {
      publishedVersion: true,
      owner: { select: { name: true } },
    },
  });

  if (!page?.publishedVersion) return null;

  return { space, page, version: page.publishedVersion };
}

export async function listSpacePages(viewer: Viewer, spaceId: string) {
  // Takes the viewer and re-asserts readability through the relation rather than
  // trusting that the caller resolved the space id through a permission check first.
  // A bare spaceId parameter would be safe only by convention, which spec §8 rejects.
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
}
