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
 * caller cannot build a query and forget the filter. Extra conditions go in `and` and are
 * nested, so they can never collide with the predicate.
 *
 * Pass it DIRECTLY as `where` — never spread it. `where: readableSpace(v, { key })` is
 * correct; `where: { ...readableSpace(v), AND: [...] }` silently drops the predicate,
 * because the spread replaces this function's own top-level `AND`. Verified against
 * Postgres: the spread form returns members-only spaces to a non-member. TypeScript and
 * Prisma both accept it, so this comment is the only guard.
 *
 * If a third Space query site ever needs conditions this signature cannot express, do not
 * reach for a spread — move composition up a level into a `findReadableSpaces(viewer,
 * args)` helper that owns the `where` entirely, so callers never touch the fragment.
 */
export function readableSpace(
  viewer: Viewer,
  ...and: Prisma.SpaceWhereInput[]
): Prisma.SpaceWhereInput {
  return { AND: [readableSpaceWhere(viewer), ...and] };
}
