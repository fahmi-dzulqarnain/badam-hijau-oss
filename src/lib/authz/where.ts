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
 * Pass it DIRECTLY as `where` — never spread it, at any nesting depth. Correct:
 * `where: readableSpace(v, { key })` and `where: { spaceId, space: readableSpace(v) }`.
 * Broken: `{ ...readableSpace(v), AND: [...] }` and, identically,
 * `{ space: { ...readableSpace(v), AND: [...] } }` — the spread replaces this function's
 * own top-level `AND` and the predicate vanishes. Both forms were verified against
 * Postgres to return members-only rows to a non-member. TypeScript and Prisma accept
 * both, so this comment is the only guard.
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

/**
 * The edit predicate alone. Deliberately NOT exported, for the same reason as
 * `readableSpaceWhere`: composing it by spread is an authorization bug tsc cannot see.
 *
 * The `isSuperAdmin` short-circuit is load-bearing and is the whole reason this cannot be
 * written as `readableSpace(viewer, { memberships: { some: … } })`. That composition returns
 * `{ AND: [{}, { memberships: … }] }` for a super admin — the membership filter standing
 * alone — so a super admin with no row reads nothing, while `can()` says they may edit
 * everything. `can.ts` already warns that these two mechanisms must change together.
 *
 * Note what is NOT here: `visibility: "ALL_STAFF"`. An ALL_STAFF space is readable by any
 * signed-in user and editable by nobody who is not a member, which is the one place the two
 * predicates must diverge.
 */
function editableSpaceWhere(viewer: Viewer): Prisma.SpaceWhereInput {
  if (viewer.isSuperAdmin) return {};
  return {
    memberships: { some: { userId: viewer.id, role: { in: ["EDITOR", "ADMIN"] } } },
  };
}

/**
 * The only sanctioned way to filter spaces by "this viewer may edit here". Returns the
 * COMPLETE `where`, exactly like `readableSpace` — and like it, **must never be spread**, at
 * any nesting depth. Pass it directly: `where: editableSpace(v, { id })`, or nested as
 * `{ space: editableSpace(v) }`.
 *
 * Where both predicates are needed on one query they go in SEPARATE varargs of the composing
 * helper, never in one object literal — two `space:` keys in one object silently lose one.
 */
export function editableSpace(
  viewer: Viewer,
  ...and: Prisma.SpaceWhereInput[]
): Prisma.SpaceWhereInput {
  return { AND: [editableSpaceWhere(viewer), ...and] };
}
