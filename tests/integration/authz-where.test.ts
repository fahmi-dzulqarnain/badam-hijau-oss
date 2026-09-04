import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { can } from "@/lib/authz/can";
import { editableSpace, readableSpace } from "@/lib/authz/where";
import type { SpaceRef, SpaceRole, Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };
const root: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

async function fixture() {
  const member = await db.user.create({
    data: { email: "member@example.com", name: "Member" },
  });
  const open = await db.space.create({
    data: {
      key: "handbook",
      name: "Handbook planning",
      initials: "HB",
      visibility: "ALL_STAFF",
    },
  });
  const closed = await db.space.create({
    data: {
      key: "layoffs",
      name: "Layoffs 2027 planning",
      initials: "LO",
      visibility: "MEMBERS",
    },
  });
  return { member, open, closed };
}

test("a caller's own OR cannot displace the permission predicate", async () => {
  await fixture();

  // The natural way to write space search. Written as a spread of a bare `OR` fragment,
  // this returned the MEMBERS space to a non-member.
  const rows = await db.space.findMany({
    where: readableSpace(stranger, {
      OR: [{ name: { contains: "planning" } }, { key: { contains: "planning" } }],
    }),
    select: { key: true },
  });

  const keys = rows.map((row) => row.key);
  expect(keys).toContain("handbook");
  expect(keys).not.toContain("layoffs");
});

test("a super admin sees members-only spaces through the same helper", async () => {
  await fixture();

  const rows = await db.space.findMany({
    where: readableSpace(root),
    select: { key: true },
  });

  expect(rows.map((row) => row.key).sort()).toEqual(["handbook", "layoffs"]);
});

test("can(READ) agrees with the SQL predicate for every viewer and visibility", async () => {
  const { member, open, closed } = await fixture();
  await db.spaceMembership.create({
    data: { spaceId: closed.id, userId: member.id, role: "VIEWER" },
  });

  const viewers: { label: string; viewer: Viewer }[] = [
    { label: "stranger", viewer: stranger },
    { label: "super admin", viewer: root },
    {
      label: "member of the closed space",
      viewer: {
        id: member.id,
        isSuperAdmin: false,
        memberships: [{ spaceId: closed.id, role: "VIEWER" }],
      },
    },
  ];

  for (const { label, viewer } of viewers) {
    const rows = await db.space.findMany({
      where: readableSpace(viewer),
      select: { id: true },
    });
    const visible = new Set(rows.map((row) => row.id));

    for (const space of [open, closed]) {
      const ref: SpaceRef = { id: space.id, visibility: space.visibility };
      expect(
        visible.has(space.id),
        `${label} / ${space.key}: can() and the SQL predicate disagree`,
      ).toBe(can(viewer, ref, "READ"));
    }
  }
});

async function editSpace(visibility: "MEMBERS" | "ALL_STAFF") {
  return db.space.create({
    data: { key: "editing", name: "Editing", initials: "ED", visibility },
    select: { id: true },
  });
}

async function memberViewer(email: string, spaceId: string, role: SpaceRole): Promise<Viewer> {
  const user = await db.user.create({ data: { email, name: email }, select: { id: true } });
  // A REAL membership row. `editableSpace` filters on the row in SQL while `can()` reads
  // `Viewer.memberships` — a synthetic viewer with a self-declared membership passes the
  // second while reading nothing through the first.
  await db.spaceMembership.create({ data: { spaceId, userId: user.id, role } });
  return { id: user.id, isSuperAdmin: false, memberships: [{ spaceId, role }] };
}

async function isEditable(viewer: Viewer, spaceId: string): Promise<boolean> {
  const found = await db.space.findFirst({
    where: editableSpace(viewer, { id: spaceId }),
    select: { id: true },
  });
  return found !== null;
}

test("editableSpace admits a super admin with NO membership row", async () => {
  const space = await editSpace("MEMBERS");
  const god = await db.user.create({
    data: { email: "root@example.com", name: "Root", isSuperAdmin: true },
    select: { id: true },
  });

  // The naive composition — readableSpace(v, { memberships: { some: … } }) — is FALSE here:
  // readableSpaceWhere is {} for a super admin, so the membership filter stands alone and
  // demands a row they do not have. `can()` short-circuits on isSuperAdmin, and these two
  // mechanisms must not disagree.
  expect(await isEditable({ id: god.id, isSuperAdmin: true, memberships: [] }, space.id)).toBe(true);
});

test("editableSpace admits an EDITOR and an ADMIN, and refuses a VIEWER", async () => {
  const space = await editSpace("ALL_STAFF");
  for (const [role, expected] of [["EDITOR", true], ["ADMIN", true], ["VIEWER", false]] as const) {
    const viewer = await memberViewer(`${role.toLowerCase()}@example.com`, space.id, role);
    expect(await isEditable(viewer, space.id), role).toBe(expected);
  }
});

test("editableSpace refuses a non-member of an ALL_STAFF space", async () => {
  // ALL_STAFF grants READ to any signed-in user but never EDIT — the one place where the
  // readable and editable predicates must diverge.
  const space = await editSpace("ALL_STAFF");
  const stranger = await db.user.create({
    data: { email: "nobody@example.com", name: "Nobody" }, select: { id: true },
  });
  expect(
    await isEditable({ id: stranger.id, isSuperAdmin: false, memberships: [] }, space.id),
  ).toBe(false);
});

test("can(EDIT) agrees with the SQL predicate for every viewer, role and visibility", async () => {
  // The EDIT counterpart to the READ agreement test above, and it exists because the three
  // example-based tests below leave one invariant pinned only by accident. Mutation-tested:
  // deleting `userId: viewer.id` from `editableSpaceWhere` is an authorization bypass — any
  // signed-in user may edit any space holding one EDITOR — and the rest of this file stays
  // green as long as the role loop happens to create an EDITOR before it asserts on a VIEWER.
  // Reordering that tuple, a change no reviewer would question, hides the bypass entirely.
  //
  // So this injects the case no other fixture here contains: a FOREIGN editor in the same
  // space, giving an unscoped `some` a row to find.
  for (const isSuperAdmin of [false, true]) {
    for (const role of ["none", "VIEWER", "EDITOR", "ADMIN"] as const) {
      for (const visibility of ["MEMBERS", "ALL_STAFF"] as const) {
        await resetDb();
        const space = await editSpace(visibility);
        await memberViewer("foreign-editor@example.com", space.id, "EDITOR");

        const user = await db.user.create({
          data: { email: "subject@example.com", name: "Subject", isSuperAdmin },
          select: { id: true },
        });
        const memberships: Viewer["memberships"] = [];
        if (role !== "none") {
          // A REAL row, for the reason `memberViewer` states: the SQL predicate reads the
          // row and `can()` reads the array, so both have to be populated to compare them.
          await db.spaceMembership.create({ data: { spaceId: space.id, userId: user.id, role } });
          memberships.push({ spaceId: space.id, role });
        }
        const viewer: Viewer = { id: user.id, isSuperAdmin, memberships };

        expect(
          await isEditable(viewer, space.id),
          `superAdmin=${isSuperAdmin} role=${role} visibility=${visibility}`,
        ).toBe(can(viewer, { id: space.id, visibility }, "EDIT"));
      }
    }
  }
});
