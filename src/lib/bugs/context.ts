import { getPublishedPage, getReadableSpaceByKey } from "@/lib/pages/repo";
import type { Viewer } from "@/lib/authz/types";

export type ReportContext = {
  spaceId: string | null;
  pageId: string | null;
  versionId: string | null;
};

const NONE: ReportContext = { spaceId: null, pageId: null, versionId: null };

/**
 * Works out which space and page a report came from, using the route the reporter was on.
 *
 * Derived here rather than accepted from the client, deliberately. A client-supplied
 * pageId could name a page in a space the reporter cannot read, and an admin reading the
 * report list would then see an id that leaked out of a space that reporter had no access
 * to. Resolving through the permission-filtered repository makes that impossible by
 * construction — and removes any need to validate these at all.
 *
 * Returns nulls rather than throwing. A report from an unrecognised route is still worth
 * keeping, and routePath is the durable breadcrumb either way.
 */
export async function resolveReportContext(
  viewer: Viewer,
  routePath: string,
): Promise<ReportContext> {
  const [spaceKey, ...rest] = routePath.split("/").filter(Boolean);
  if (!spaceKey) return NONE;

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) return NONE;

  if (rest.length === 0) {
    return { spaceId: space.id, pageId: null, versionId: null };
  }

  const found = await getPublishedPage(viewer, { spaceKey, path: rest.join("/") });
  if (!found) return { spaceId: space.id, pageId: null, versionId: null };

  return { spaceId: space.id, pageId: found.page.id, versionId: found.version.id };
}
