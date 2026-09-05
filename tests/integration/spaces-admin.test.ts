import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { inOneRequest } from "@/lib/audit/log";
import {
  addSpaceMember,
  createSpace,
  listSpaceMembers,
  listSpacesForAdmin,
  removeSpaceMember,
  setSpaceMemberRole,
  updateSpace,
  type SpaceInput,
} from "@/lib/spaces/admin";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * `/admin/spaces` against the real database — Phase 7 Task 6.
 *
 * Five claims, each of which this task was handed by name:
 *
 * 1. **The refusal is one predicate and it is falsifiable in both directions.** Every refusal
 *    assertion has its non-vacuity companion in the same test — the super admin making the
 *    identical call and getting an answer — because Task 4 found a refusal test that a *second*
 *    guard was silently satisfying.
 * 2. **A key that would shadow a route is refused, and the shape rule reaches the column.** Both
 *    halves: the validator's sentence, and the CHECK constraint underneath it that catches
 *    anything not going through the validator at all.
 * 3. **The page count that refuses a rename counts soft-deleted pages**, deliberately, and this
 *    file is what `src/lib/pages/visible.test.ts` registers that absence against.
 * 4. **Membership widens access, and every widening leaves a row.** Including the one no
 *    membership action would see: a `MEMBERS` → `ALL_STAFF` flip.
 * 5. **The count is free and the names are audited**, as a discrimination between a `MEMBERS`
 *    space and an `ALL_STAFF` one rather than as an absence.
 */

const input = (over: Partial<SpaceInput> = {}): SpaceInput => ({
  key: "product",
  name: "Product",
  initials: "PR",
  description: "",
  visibility: "MEMBERS",
  ...over,
});

async function fixture() {
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const dara = await db.user.create({ data: { email: "dara@example.com", name: "Dara M." } });

  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  // `aisyah` is an **ADMIN of a space**, not a stranger — the discriminating viewer this project
  // settled on, because a member of nothing is refused by any predicate at all, including a
  // mutated one. She is exactly the viewer `can(v, space, "MANAGE_SPACE")` says yes to, which is
  // the temptation `src/lib/spaces/admin.ts` argues against at the line.
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: aisyah.id, role: "ADMIN" },
  });

  return {
    engineering,
    handbook,
    aisyah,
    dara,
    /** A super admin who belongs to nothing — §8's audited case, and this surface's only viewer. */
    asRoot: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    asSpaceAdmin: {
      id: aisyah.id,
      isSuperAdmin: false,
      memberships: [{ spaceId: engineering.id, role: "ADMIN" }],
    } satisfies Viewer,
  };
}

/** A page in a space, written directly: the shapes below include a soft-deleted one. */
async function pageIn(spaceId: string, slug: string, deleted = false) {
  const author = await db.user.findFirstOrThrow({ select: { id: true } });
  return db.page.create({
    data: {
      spaceId,
      slug,
      path: slug,
      title: slug,
      status: "CURRENT",
      createdById: author.id,
      ownerId: author.id,
      deletedAt: deleted ? new Date() : null,
    },
    select: { id: true },
  });
}

const spaceByKey = (key: string) =>
  db.space.findUnique({
    where: { key },
    select: { id: true, key: true, name: true, visibility: true },
  });

const auditRows = () =>
  db.auditLog.findMany({
    orderBy: { createdAt: "asc" },
    select: { action: true, spaceId: true, detail: true },
  });

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

test("a space ADMIN is refused by every entry point, and the super admin is not", async () => {
  const f = await fixture();
  const before = await db.space.count();

  expect(await listSpacesForAdmin(f.asSpaceAdmin)).toEqual({ ok: false, reason: "not-found" });
  expect(await listSpaceMembers(f.asSpaceAdmin, f.engineering.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await createSpace(f.asSpaceAdmin, input())).toEqual({ ok: false, reason: "not-found" });
  expect(await updateSpace(f.asSpaceAdmin, f.engineering.id, { name: "Renamed" })).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(
    await addSpaceMember(f.asSpaceAdmin, f.engineering.id, "dara@example.com", "VIEWER"),
  ).toEqual({ ok: false, reason: "not-found" });
  expect(
    await setSpaceMemberRole(f.asSpaceAdmin, f.engineering.id, f.aisyah.id, "VIEWER"),
  ).toEqual({ ok: false, reason: "not-found" });
  expect(await removeSpaceMember(f.asSpaceAdmin, f.engineering.id, f.aisyah.id)).toEqual({
    ok: false,
    reason: "not-found",
  });

  // Nothing was written. A refusal that returned the right shape while committing the change
  // would pass every assertion above — and here that would mean a space `ADMIN` quietly
  // demoting herself, or adding somebody to a space she administers.
  expect(await db.space.count()).toBe(before);
  expect((await spaceByKey("engineering"))?.name).toBe("Engineering");
  expect(await db.spaceMembership.count()).toBe(1);
  expect(await db.auditLog.count()).toBe(0);

  // The non-vacuity companion, and the discrimination: the identical seven calls, one line of
  // difference in the viewer.
  expect((await listSpacesForAdmin(f.asRoot)).ok).toBe(true);
  expect((await listSpaceMembers(f.asRoot, f.engineering.id)).ok).toBe(true);
  expect((await createSpace(f.asRoot, input())).ok).toBe(true);
  expect((await updateSpace(f.asRoot, f.engineering.id, { name: "Engineering!" })).ok).toBe(true);
  expect(
    (await addSpaceMember(f.asRoot, f.engineering.id, "dara@example.com", "VIEWER")).ok,
  ).toBe(true);
  expect((await setSpaceMemberRole(f.asRoot, f.engineering.id, f.dara.id, "EDITOR")).ok).toBe(
    true,
  );
  expect((await removeSpaceMember(f.asRoot, f.engineering.id, f.dara.id)).ok).toBe(true);
});

/** The refusal is not-found and never forbidden — §8, and `src/lib/admin/gate.ts`'s argument. */
test("the refusal is indistinguishable from a space that does not exist", async () => {
  const f = await fixture();

  const refusedByPermission = await listSpaceMembers(f.asSpaceAdmin, f.engineering.id);
  const refusedByAbsence = await listSpaceMembers(f.asRoot, "no-such-space-id");
  expect(refusedByPermission).toEqual(refusedByAbsence);
  expect(JSON.stringify(refusedByPermission)).not.toContain("forbidden");

  // The companion: the same id the space admin was refused over is a real space.
  expect((await listSpaceMembers(f.asRoot, f.engineering.id)).ok).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* The key                                                                     */
/* -------------------------------------------------------------------------- */

test("a key that would shadow a top-level route is refused, and a legal one is not", async () => {
  const f = await fixture();

  for (const key of ["admin", "systems", "search", "api", "new", "edit"]) {
    const refused = await createSpace(f.asRoot, input({ key }));
    if (refused.ok || refused.reason !== "invalid") throw new Error(`"${key}" was accepted`);
    expect(refused.errors.map((e) => [e.field, e.code])).toEqual([["key", "reserved"]]);
    // The consequence, in the sentence: the page is in the database and its URL answers 404.
    expect(refused.errors[0]?.message).toContain("404");
  }

  // The non-vacuity companion. Without it, "refused" is consistent with a validator that refuses
  // every key — and `admin-web` is the shape that proves the rule is the whole segment and not a
  // prefix of it.
  expect((await createSpace(f.asRoot, input({ key: "admin-web" }))).ok).toBe(true);
  expect(await spaceByKey("admin")).toBeNull();
  expect(await spaceByKey("admin-web")).not.toBeNull();
});

test("the shape rules refuse before the route list does, and every sentence names its field", async () => {
  const f = await fixture();

  const cases: [string, string][] = [
    ["", "empty"],
    ["Admin", "uppercase"],
    ["eng ops", "whitespace"],
    ["eng/ops", "not-one-segment"],
    ["-eng", "hyphen-edge"],
    ["eng-", "hyphen-edge"],
    ["engineering", "key-taken"],
  ];
  for (const [key, code] of cases) {
    const refused = await createSpace(f.asRoot, input({ key }));
    if (refused.ok || refused.reason !== "invalid") throw new Error(`"${key}" was accepted`);
    expect([key, refused.errors[0]?.code]).toEqual([key, code]);
    expect(refused.errors[0]?.field).toBe("key");
  }
  expect(await db.space.count()).toBe(2);
});

/**
 * **The CHECK is the half of the rule that catches whatever does not come through the validator.**
 *
 * `validateSpaceKey` is a sentence for the one surface a person types into; `Space_key_shape` is
 * what makes the column trustworthy for `mirrorPathOf`, for every URL builder, and for the claim
 * that `Space_key_key` is folded uniqueness. A direct write is the closest this suite can get to
 * the writers that motivated it — a hand-run `UPDATE`, a future importer, a fixture — and it is
 * exactly how the two rows this task had to worry about got there in the first place.
 */
test("the column itself refuses an uppercase key, so the unique index is a folded one", async () => {
  await fixture();

  await expect(
    db.space.create({
      data: { key: "Engineering", name: "Shadow", initials: "SH", visibility: "MEMBERS" },
    }),
  ).rejects.toThrow(/Space_key_shape/);

  await expect(
    db.space.create({ data: { key: "eng ops", name: "X", initials: "XX" } }),
  ).rejects.toThrow(/Space_key_shape/);

  // Which is what makes the *existing* unique index a folded one: there is no second spelling of
  // `engineering` the column can hold, so the only collision left is the exact one.
  // Prisma reports P2002 by field rather than by index name, unlike the CHECK above, which
  // arrives as a raw `P2010`/`23514` carrying the constraint's own name — which is precisely why
  // `validateSpaceKey` exists to say a sentence before either of them is reached.
  await expect(
    db.space.create({ data: { key: "engineering", name: "X", initials: "XX" } }),
  ).rejects.toThrow(/Unique constraint failed on the fields: \(`key`\)/);

  // The non-vacuity companion for all three: the same statement with a legal key succeeds.
  expect(
    await db.space.create({
      data: { key: "eng-ops", name: "Eng ops", initials: "EO" },
      select: { key: true },
    }),
  ).toEqual({ key: "eng-ops" });
});

/* -------------------------------------------------------------------------- */
/* The rename rule, and the count behind it                                    */
/* -------------------------------------------------------------------------- */

test("an empty space can be rekeyed, and the audit row says what it was", async () => {
  const f = await fixture();

  const renamed = await updateSpace(f.asRoot, f.engineering.id, { key: "eng" });
  if (!renamed.ok) throw new Error(`refused: ${JSON.stringify(renamed)}`);
  expect(renamed.renamedFrom).toBe("engineering");
  expect((await spaceByKey("eng"))?.id).toBe(f.engineering.id);

  const [row] = await auditRows();
  expect(row?.action).toBe("space.update");
  expect(row?.spaceId).toBe(f.engineering.id);
  expect(row?.detail).toMatchObject({ key: "eng", previousKey: "engineering", pages: 0 });
});

/**
 * **The soft-delete registration for this module**, and the absence it pins.
 *
 * The count that refuses a rename counts *every* `Page` row. A soft delete does not un-share the
 * URL and does not remove the mirror file for good — `restorePage` brings both back — so a
 * filtered count would let a space whose pages had all been deleted be rekeyed, and strand
 * `content/<old-key>/` the moment one of them came back.
 *
 * Both halves are in one assertion: the live page is the non-vacuity companion, and the count in
 * the refusal's sentence is asserted to equal the row's, which is the property the filter would
 * break.
 */
test("a soft-deleted page still counts, and still refuses a rename", async () => {
  const f = await fixture();
  await pageIn(f.engineering.id, "live");
  await pageIn(f.engineering.id, "gone", true);

  const refused = await updateSpace(f.asRoot, f.engineering.id, { key: "eng" });
  if (refused.ok || refused.reason !== "invalid") throw new Error("the rename was allowed");
  expect(refused.errors.map((e) => [e.field, e.code])).toEqual([["key", "key-immutable"]]);
  // Two, not one: the soft-deleted page is in the number the admin reads.
  expect(refused.errors[0]?.message).toContain("2 pages");

  const listed = await listSpacesForAdmin(f.asRoot);
  if (!listed.ok) throw new Error("refused");
  const row = listed.spaces.find((space) => space.key === "engineering");
  expect(row?.pages).toBe(2);

  // The key did not move, and nothing was audited for a change that did not happen.
  expect(await spaceByKey("eng")).toBeNull();
  expect(await db.auditLog.count()).toBe(0);

  // The other four fields still save while the key is fixed — a refusal that took the whole
  // request down with it would be a worse surface than one that refuses one field.
  const saved = await updateSpace(f.asRoot, f.engineering.id, { name: "Engineering (renamed)" });
  expect(saved.ok).toBe(true);
  expect((await spaceByKey("engineering"))?.name).toBe("Engineering (renamed)");
});

/* -------------------------------------------------------------------------- */
/* Visibility: the widening no membership action would see                     */
/* -------------------------------------------------------------------------- */

test("flipping MEMBERS to ALL_STAFF is audited with what it was and how much it reached", async () => {
  const f = await fixture();
  await pageIn(f.engineering.id, "one");
  await pageIn(f.engineering.id, "two");

  const widened = await updateSpace(f.asRoot, f.engineering.id, { visibility: "ALL_STAFF" });
  if (!widened.ok) throw new Error(`refused: ${JSON.stringify(widened)}`);
  expect(widened.visibilityWas).toBe("MEMBERS");
  expect(widened.pages).toBe(2);
  expect((await spaceByKey("engineering"))?.visibility).toBe("ALL_STAFF");

  const [row] = await auditRows();
  expect(row?.action).toBe("space.update");
  expect(row?.detail).toMatchObject({
    visibility: "ALL_STAFF",
    previousVisibility: "MEMBERS",
    pages: 2,
    fields: ["visibility"],
  });

  /*
   * Null and not absent when nothing was flipped — the `previousKey` distinction, and the reason
   * it matters here is that this column is the only record of when a space's own `space.access`
   * trail was switched off. An auditor asking "when did this stop being members-only" reads a
   * missing key as "no rows match" rather than as "it never happened".
   */
  const again = await updateSpace(f.asRoot, f.engineering.id, { name: "Engineering" });
  expect(again.ok && again.visibilityWas).toBeNull();
  const rows = await auditRows();
  expect(rows[1]?.detail).toMatchObject({ previousVisibility: null, previousKey: null });
});

/**
 * The consequence of that flip on this table, asserted rather than described.
 *
 * `needsAccessAudit` fires for a `MEMBERS` space alone, so widening a space silently ends the §8
 * trail for every super admin who is not a member. The `space.update` row is the only durable
 * record of the moment, which is why it carries `previousVisibility` — and this is the test that
 * says the consequence is real.
 */
test("a widened space stops producing space.access rows, which is why the flip is recorded", async () => {
  const f = await fixture();

  await inOneRequest(() => listSpaceMembers(f.asRoot, f.engineering.id));
  expect((await auditRows()).filter((r) => r.action === "space.access")).toHaveLength(1);

  await updateSpace(f.asRoot, f.engineering.id, { visibility: "ALL_STAFF" });
  await inOneRequest(() => listSpaceMembers(f.asRoot, f.engineering.id));

  // Still one: the second read wrote nothing, because the space is no longer members-only.
  expect((await auditRows()).filter((r) => r.action === "space.access")).toHaveLength(1);
  // And the moment it changed is on the record.
  expect(
    (await auditRows()).filter((r) => r.action === "space.update")[0]?.detail,
  ).toMatchObject({ previousVisibility: "MEMBERS" });
});

/* -------------------------------------------------------------------------- */
/* Memberships                                                                 */
/* -------------------------------------------------------------------------- */

test("adding a member grants access, by an email that is folded rather than refused", async () => {
  const f = await fixture();

  // Mixed case and surrounding space: the lookup key is folded, unlike a space key, which is
  // stored and is therefore refused rather than corrected.
  const added = await addSpaceMember(f.asRoot, f.handbook.id, " Dara@Example.COM ", "EDITOR");
  if (!added.ok) throw new Error(`refused: ${JSON.stringify(added)}`);
  expect(added).toMatchObject({ userId: f.dara.id, role: "EDITOR", previousRole: null });

  const membership = await db.spaceMembership.findUnique({
    where: { spaceId_userId: { spaceId: f.handbook.id, userId: f.dara.id } },
    select: { role: true },
  });
  expect(membership).toEqual({ role: "EDITOR" });

  const [row] = await auditRows();
  expect(row?.action).toBe("space.member.add");
  expect(row?.spaceId).toBe(f.handbook.id);
  // The subject by id and never by email — the copy that would rot after an address change.
  expect(row?.detail).toEqual({ userId: f.dara.id, role: "EDITOR" });
  expect(JSON.stringify(row?.detail)).not.toContain("example.com");
});

test("a person who has never signed in cannot be added, and is told what has to happen", async () => {
  const f = await fixture();

  const refused = await addSpaceMember(f.asRoot, f.handbook.id, "nobody@example.com", "VIEWER");
  if (refused.ok || refused.reason !== "invalid") throw new Error("it was accepted");
  expect(refused.errors.map((e) => [e.field, e.code])).toEqual([["email", "no-such-user"]]);
  expect(refused.errors[0]?.message).toContain("sign in");
  expect(await db.spaceMembership.count()).toBe(1);
  expect(await db.auditLog.count()).toBe(0);

  // No `User` row was invented on the way past. Creating one here would mean asserting an identity
  // the identity provider has not confirmed, against a `@unique` email.
  expect(await db.user.findUnique({ where: { email: "nobody@example.com" } })).toBeNull();

  // The companion: the same call for somebody who has.
  expect((await addSpaceMember(f.asRoot, f.handbook.id, "dara@example.com", "VIEWER")).ok).toBe(
    true,
  );
});

test("adding somebody twice is a sentence about the role, not a constraint violation", async () => {
  const f = await fixture();

  const refused = await addSpaceMember(f.asRoot, f.engineering.id, "aisyah@example.com", "VIEWER");
  if (refused.ok || refused.reason !== "invalid") throw new Error("it was accepted");
  expect(refused.errors.map((e) => [e.field, e.code])).toEqual([["email", "already-a-member"]]);

  // And the role she had is untouched — a second add must not quietly become a demotion.
  const membership = await db.spaceMembership.findUnique({
    where: { spaceId_userId: { spaceId: f.engineering.id, userId: f.aisyah.id } },
    select: { role: true },
  });
  expect(membership).toEqual({ role: "ADMIN" });
});

test("a role change is audited with what it was, and setting the same role writes nothing", async () => {
  const f = await fixture();

  const promoted = await setSpaceMemberRole(f.asRoot, f.engineering.id, f.aisyah.id, "VIEWER");
  if (!promoted.ok) throw new Error(`refused: ${JSON.stringify(promoted)}`);
  expect(promoted).toMatchObject({ role: "VIEWER", previousRole: "ADMIN", admins: 0 });

  const [row] = await auditRows();
  expect(row?.action).toBe("space.member.role");
  expect(row?.detail).toEqual({ userId: f.aisyah.id, role: "VIEWER", previousRole: "ADMIN" });

  // A request that changes nothing records nothing: a row saying VIEWER became VIEWER makes the
  // trail harder to read rather than more complete. The result still says what the role is.
  const again = await setSpaceMemberRole(f.asRoot, f.engineering.id, f.aisyah.id, "VIEWER");
  expect(again.ok && again.previousRole).toBe("VIEWER");
  expect(await db.auditLog.count()).toBe(1);
});

/**
 * Removing the last `ADMIN` is allowed and reported, and the reason it is not refused is that
 * refusing would make the last admin of a space unoffboardable — `can()` short-circuits on
 * `isSuperAdmin`, so the space stays administrable either way.
 */
test("the removal row is the only record the membership ever existed, and reports what is left", async () => {
  const f = await fixture();
  await addSpaceMember(f.asRoot, f.engineering.id, "dara@example.com", "EDITOR");

  const removed = await removeSpaceMember(f.asRoot, f.engineering.id, f.aisyah.id);
  if (!removed.ok) throw new Error(`refused: ${JSON.stringify(removed)}`);
  // The role she held, which nothing else now holds — the row is gone.
  expect(removed).toMatchObject({ userId: f.aisyah.id, role: "ADMIN", admins: 0 });

  expect(
    await db.spaceMembership.findUnique({
      where: { spaceId_userId: { spaceId: f.engineering.id, userId: f.aisyah.id } },
    }),
  ).toBeNull();

  const rows = await auditRows();
  expect(rows.at(-1)?.action).toBe("space.member.remove");
  expect(rows.at(-1)?.detail).toEqual({ userId: f.aisyah.id, role: "ADMIN" });

  // The companion for `admins: 0`: promote the remaining member and it is 1, so the number is a
  // count of the state and not a constant.
  const promoted = await setSpaceMemberRole(f.asRoot, f.engineering.id, f.dara.id, "ADMIN");
  expect(promoted.ok && promoted.admins).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* The audit line: the container is free, the people are not                  */
/* -------------------------------------------------------------------------- */

/**
 * Task 1's line, moved one category along and asserted as a **discrimination**.
 *
 * Two calls by one super admin who belongs to nothing, over two spaces that differ only in
 * visibility, plus the whole space index — one row. `handbook` is `ALL_STAFF` and contributes
 * none, which is `needsAccessAudit` being *called* rather than copied, and `listSpacesForAdmin`
 * contributes none, which is the line itself.
 */
test("listing the members audits a MEMBERS space and not an ALL_STAFF one; the index audits neither", async () => {
  const f = await fixture();

  await inOneRequest(async () => {
    expect((await listSpacesForAdmin(f.asRoot)).ok).toBe(true);
    expect((await listSpaceMembers(f.asRoot, f.handbook.id)).ok).toBe(true);
    expect((await listSpaceMembers(f.asRoot, f.engineering.id)).ok).toBe(true);
  });

  const access = (await auditRows()).filter((row) => row.action === "space.access");
  expect(access).toHaveLength(1);
  expect(access[0]?.spaceId).toBe(f.engineering.id);
  expect(access[0]?.detail).toMatchObject({ key: "engineering", visibility: "MEMBERS" });
});

test("the member list names the people, ADMIN first, and reads across a boundary to do it", async () => {
  const f = await fixture();
  await addSpaceMember(f.asRoot, f.engineering.id, "dara@example.com", "VIEWER");

  const listed = await listSpaceMembers(f.asRoot, f.engineering.id);
  if (!listed.ok) throw new Error("refused");
  expect(listed.members.map((m) => [m.email, m.role])).toEqual([
    ["aisyah@example.com", "ADMIN"],
    ["dara@example.com", "VIEWER"],
  ]);
  expect(listed.truncated).toBe(false);

  // The count on the index is the same number and costs no audit row — the two halves of the line
  // agreeing, which is the property that makes the split honest rather than convenient.
  const index = await listSpacesForAdmin(f.asRoot);
  if (!index.ok) throw new Error("refused");
  expect(index.spaces.find((s) => s.key === "engineering")?.members).toBe(2);
});

/* -------------------------------------------------------------------------- */
/* Creating one                                                                */
/* -------------------------------------------------------------------------- */

test("a created space has no members, so a members-only one is readable by super admins alone", async () => {
  const f = await fixture();

  const created = await createSpace(
    f.asRoot,
    input({ key: "product", name: "Product", description: "What we are building." }),
  );
  if (!created.ok) throw new Error(`refused: ${JSON.stringify(created)}`);
  expect(created).toMatchObject({ key: "product", members: 0, pages: 0, renamedFrom: null });

  // The creating admin was NOT inserted as a member: `can()` already says yes to them, so the row
  // would grant nothing and would put a non-member in the list this surface exists to keep true.
  expect(await db.spaceMembership.count({ where: { space: { key: "product" } } })).toBe(0);

  const [row] = await auditRows();
  expect(row?.action).toBe("space.create");
  expect(row?.spaceId).toBe(created.id);
  expect(row?.detail).toEqual({ key: "product", name: "Product", visibility: "MEMBERS" });

  // And the state is visible on the row rather than only in a message that scrolls away.
  const listed = await listSpacesForAdmin(f.asRoot);
  if (!listed.ok) throw new Error("refused");
  expect(listed.spaces.find((s) => s.key === "product")).toMatchObject({
    visibility: "MEMBERS",
    members: 0,
    pages: 0,
  });
});

test("every field's sentence comes back at once, and none of them is stored", async () => {
  const f = await fixture();

  const refused = await createSpace(
    f.asRoot,
    input({ key: "Product Team", name: "  ", initials: "TOOLONG", description: "x".repeat(1001) }),
  );
  if (refused.ok || refused.reason !== "invalid") throw new Error("it was accepted");
  expect(refused.errors.map((e) => e.field)).toEqual([
    "key",
    "name",
    "initials",
    "description",
  ]);
  expect(await db.space.count()).toBe(2);
});

test("control characters are stripped from free text rather than becoming a 500", async () => {
  const f = await fixture();

  // Escapes, never literals — a literal NUL has hidden three files from `rg` on this project.
  const created = await createSpace(
    f.asRoot,
    input({ key: "product", name: "Prod\u0000uct", description: "one\u0007two" }),
  );
  if (!created.ok) throw new Error(`refused: ${JSON.stringify(created)}`);

  const stored = await db.space.findUnique({
    where: { key: "product" },
    select: { name: true, description: true },
  });
  expect(stored).toEqual({ name: "Product", description: "onetwo" });
});
