import type { Prisma } from "@prisma/client";
import type { Viewer } from "./types";

/**
 * The readability predicate alone. Deliberately NOT exported: it contains a top-level
 * `OR`, so spreading it into a caller's `where` that also has `OR` would silently
 * delete one of them — a total authorization bypass that neither tsc nor Prisma can
 * detect. Compose through `readableSpace` instead.
 */
function readableSpaceWhere(viewer: Viewer): Prisma.SpaceWhereInput {
  if (viewer.isSuperAdmin) return {};
  return {
    OR: [
      { visibility: "ALL_STAFF" },
      { memberships: { some: { userId: viewer.id } } },
    ],
  };
}

/**
 * The only sanctioned way to query spaces. Returns the COMPLETE `where` clause, so a
 * caller cannot build a query and forget the filter. Extra conditions are ANDed, and
 * `AND` nests rather than merges, so no caller condition can collide with the predicate
 * at any depth.
 */
export function readableSpace(
  viewer: Viewer,
  ...and: Prisma.SpaceWhereInput[]
): Prisma.SpaceWhereInput {
  return { AND: [readableSpaceWhere(viewer), ...and] };
}
