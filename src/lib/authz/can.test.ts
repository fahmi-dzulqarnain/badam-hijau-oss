import { describe, expect, test } from "vitest";
import { can, needsAccessAudit, readableSpaceWhere } from "./can";
import type { SpaceRef, Viewer } from "./types";

const openSpace: SpaceRef = { id: "s-open", visibility: "ALL_STAFF" };
const closedSpace: SpaceRef = { id: "s-closed", visibility: "MEMBERS" };

function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return { id: "u1", isSuperAdmin: false, memberships: [], ...overrides };
}

describe("READ", () => {
  test("any signed-in user may read an all-staff space", () => {
    expect(can(viewer(), openSpace, "READ")).toBe(true);
  });

  test("a non-member may not read a members-only space", () => {
    expect(can(viewer(), closedSpace, "READ")).toBe(false);
  });

  test("a viewer-role member may read a members-only space", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "VIEWER" }] });
    expect(can(v, closedSpace, "READ")).toBe(true);
  });

  test("membership in another space grants nothing here", () => {
    const v = viewer({ memberships: [{ spaceId: "s-other", role: "ADMIN" }] });
    expect(can(v, closedSpace, "READ")).toBe(false);
  });
});

describe("EDIT and PUBLISH", () => {
  test("a viewer-role member cannot edit", () => {
    const v = viewer({ memberships: [{ spaceId: "s-open", role: "VIEWER" }] });
    expect(can(v, openSpace, "EDIT")).toBe(false);
    expect(can(v, openSpace, "PUBLISH")).toBe(false);
  });

  test("an editor can edit and publish", () => {
    const v = viewer({ memberships: [{ spaceId: "s-open", role: "EDITOR" }] });
    expect(can(v, openSpace, "EDIT")).toBe(true);
    expect(can(v, openSpace, "PUBLISH")).toBe(true);
  });

  test("readable does not imply editable in an all-staff space", () => {
    expect(can(viewer(), openSpace, "EDIT")).toBe(false);
  });
});

describe("MANAGE_SPACE", () => {
  test("a space admin can manage it", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "ADMIN" }] });
    expect(can(v, closedSpace, "MANAGE_SPACE")).toBe(true);
  });

  test("an editor cannot manage the space", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "EDITOR" }] });
    expect(can(v, closedSpace, "MANAGE_SPACE")).toBe(false);
  });
});

describe("super admin", () => {
  const superUser = viewer({ id: "root", isSuperAdmin: true });

  test("holds every action everywhere", () => {
    for (const action of ["READ", "EDIT", "PUBLISH", "MANAGE_SPACE"] as const) {
      expect(can(superUser, closedSpace, action)).toBe(true);
    }
  });

  test("reading a members-only space they do not belong to is audited", () => {
    expect(needsAccessAudit(superUser, closedSpace)).toBe(true);
  });

  test("reading an all-staff space is not audited", () => {
    expect(needsAccessAudit(superUser, openSpace)).toBe(false);
  });

  test("a member super admin is not audited", () => {
    const member = viewer({
      id: "root",
      isSuperAdmin: true,
      memberships: [{ spaceId: "s-closed", role: "ADMIN" }],
    });
    expect(needsAccessAudit(member, closedSpace)).toBe(false);
  });

  test("an ordinary user is never audited", () => {
    expect(needsAccessAudit(viewer(), closedSpace)).toBe(false);
  });
});

describe("readableSpaceWhere", () => {
  test("a super admin gets an unfiltered clause", () => {
    expect(readableSpaceWhere(viewer({ isSuperAdmin: true }))).toEqual({});
  });

  test("everyone else gets all-staff spaces or their own memberships", () => {
    expect(readableSpaceWhere(viewer())).toEqual({
      OR: [
        { visibility: "ALL_STAFF" },
        { memberships: { some: { userId: "u1" } } },
      ],
    });
  });
});
