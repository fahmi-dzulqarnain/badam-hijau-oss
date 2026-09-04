import type { Action, SpaceRef, SpaceRole, Viewer } from "./types";

function roleIn(viewer: Viewer, spaceId: string): SpaceRole | undefined {
  return viewer.memberships.find((m) => m.spaceId === spaceId)?.role;
}

export function can(viewer: Viewer, space: SpaceRef, action: Action): boolean {
  if (viewer.isSuperAdmin) return true;

  const role = roleIn(viewer, space.id);

  switch (action) {
    // Every current SpaceRole grants read, so any membership suffices. This is the one
    // fail-open direction in the module: a future role that must NOT confer read
    // (PENDING, INVITED, BLOCKED) has to change this line and the predicate in
    // where.ts together, or the two mechanisms will silently disagree.
    case "READ":
      return space.visibility === "ALL_STAFF" || role !== undefined;
    // This role list is duplicated in `editableSpaceWhere` in where.ts, as a SQL
    // `role: { in: [...] }`. Changing either alone makes the in-memory decision and the query
    // disagree — the same two-sources-of-truth exposure the READ arm above warns about.
    // Splitting PUBLISH out of EDIT means where.ts needs a SECOND predicate; `editableSpace`
    // is the EDIT one and would silently over-grant if reused for a narrowed PUBLISH.
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
