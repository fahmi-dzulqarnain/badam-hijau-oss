import type { Action, SpaceRef, SpaceRole, Viewer } from "./types";

function roleIn(viewer: Viewer, spaceId: string): SpaceRole | undefined {
  return viewer.memberships.find((m) => m.spaceId === spaceId)?.role;
}

export function can(viewer: Viewer, space: SpaceRef, action: Action): boolean {
  if (viewer.isSuperAdmin) return true;

  const role = roleIn(viewer, space.id);

  switch (action) {
    case "READ":
      return space.visibility === "ALL_STAFF" || role !== undefined;
    case "EDIT":
    case "PUBLISH":
      return role === "EDITOR" || role === "ADMIN";
    case "MANAGE_SPACE":
      return role === "ADMIN";
  }
}

/**
 * A super admin reading a members-only space they do not belong to is legitimate but
 * must leave a trace (spec §8).
 */
export function needsAccessAudit(viewer: Viewer, space: SpaceRef): boolean {
  return (
    viewer.isSuperAdmin &&
    space.visibility === "MEMBERS" &&
    roleIn(viewer, space.id) === undefined
  );
}

/**
 * A Prisma `where` fragment for Space, so the permission check runs in SQL. Returning
 * ids instead would mean loading every space first, and would let a caller forget to
 * apply the filter.
 */
export function readableSpaceWhere(viewer: Viewer) {
  if (viewer.isSuperAdmin) return {};
  return {
    OR: [
      { visibility: "ALL_STAFF" as const },
      { memberships: { some: { userId: viewer.id } } },
    ],
  };
}
