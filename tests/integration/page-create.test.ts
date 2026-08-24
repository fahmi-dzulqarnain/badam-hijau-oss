import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { createPage } from "@/lib/pages/create";
import type { CreatePageResult } from "@/lib/pages/create";
import { getPublishedPage, listSpacePages } from "@/lib/pages/repo";
import { MAX_PATH_BYTES, SLUG_MAX_LENGTH } from "@/lib/pages/slug";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Every field gets a value nothing else in the fixture shares — `slug`, `path` and `title`
 * are all distinguishable, so swapping one for another in the implementation is visible.
 * Phase 1 learned that the hard way from a fixture whose fields all defaulted to the node id.
 */
async function fixture(visibility: "MEMBERS" | "ALL_STAFF" = "MEMBERS") {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  const other = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });

  // A three-deep chain, because `childPath` derived from a parent's SLUG is
  // indistinguishable from correct at depth two and wrong at depth three.
  const architecture = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "architecture",
      path: "architecture",
      title: "Architecture notes",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });
  const contracts = await db.page.create({
    data: {
      spaceId: space.id,
      parentId: architecture.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });

  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });

  const asRole = (role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    other,
    aisyah,
    architecture,
    contracts,
    asAisyah: asRole("EDITOR"),
    asViewer: asRole("VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Narrows to the success branch, failing with the actual result if it is not one. */
function created(result: CreatePageResult) {
  if (!result.ok) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.page;
}

/** Narrows to a field rejection, failing with the actual result if it is not one. */
function rejection(result: CreatePageResult) {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`expected a field error, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

const input = (over: Partial<Parameters<typeof createPage>[1]> & { spaceId: string }) => ({
  parentId: null,
  slug: "adr-0042-mqtt-topic-naming",
  title: "ADR 0042: MQTT topic naming",
  docType: "ADR" as const,
  ...over,
});

test("a top-level page is created as a draft, with its draft row and an audit entry", async () => {
  const { space, aisyah, asAisyah } = await fixture();

  const page = created(await createPage(asAisyah, input({ spaceId: space.id })));
  expect(page.path).toBe("adr-0042-mqtt-topic-naming");
  expect(page.spaceKey).toBe("engineering");

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.slug).toBe("adr-0042-mqtt-topic-naming");
  expect(row.path).toBe("adr-0042-mqtt-topic-naming");
  expect(row.title).toBe("ADR 0042: MQTT topic naming");
  expect(row.docType).toBe("ADR");
  expect(row.parentId).toBeNull();
  expect(row.createdById).toBe(aisyah.id);

  // The two independent columns that together mean "published", both left null.
  expect(row.status).toBe("DRAFT");
  expect(row.publishedVersionId).toBeNull();
  expect(row.publishedAt).toBeNull();
  expect(row.deletedAt).toBeNull();

  const draft = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(draft.title).toBe("ADR 0042: MQTT topic naming");
  expect(draft.markdown).toBe("");
  expect(draft.baseVersionId).toBeNull();
  expect(draft.updatedById).toBe(aisyah.id);

  const audit = await db.auditLog.findMany({ where: { pageId: page.id } });
  expect(audit).toHaveLength(1);
  expect(audit[0]?.action).toBe("page.create");
  expect(audit[0]?.actorId).toBe(aisyah.id);
  expect(audit[0]?.spaceId).toBe(space.id);
  expect(audit[0]?.detail).toMatchObject({ path: "adr-0042-mqtt-topic-naming" });

  // Nothing was published as a side effect.
  expect(await db.pageVersion.count()).toBe(0);
});

/**
 * The three-level case, explicitly. Kills a `childPath` fed the parent's `slug` instead of
 * its `path` — which yields `mqtt-contracts/topic-registry` and is invisible at depth two.
 */
test("a child page's path comes from its parent's path, three levels deep", async () => {
  const { space, contracts, asAisyah } = await fixture();

  const page = created(
    await createPage(
      asAisyah,
      input({
        spaceId: space.id,
        parentId: contracts.id,
        slug: "topic-registry",
        title: "Topic registry",
        docType: "DOC",
      }),
    ),
  );

  expect(page.path).toBe("architecture/mqtt-contracts/topic-registry");
  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.slug).toBe("topic-registry");
  expect(row.parentId).toBe(contracts.id);
});

/**
 * The property the whole "create as a draft" decision rests on, asserted rather than assumed.
 * `getPublishedPage` is what the reader route calls, and it must return null — the same null
 * an unreadable page gets, which the route turns into a 404. In the nav rail the page is
 * present but has no `publishedVersionId`, which is what makes it render as inert text
 * instead of a link that would 404 for everyone.
 *
 * Kills: setting `status` to anything published-ish, and any future "publish on create".
 */
test("a freshly created page is not readable, and is inert in the nav rail", async () => {
  const { space, asAisyah } = await fixture();
  const page = created(await createPage(asAisyah, input({ spaceId: space.id })));

  expect(
    await getPublishedPage(asAisyah, { spaceKey: "engineering", path: page.path }),
  ).toBeNull();

  const listed = (await listSpacePages(asAisyah, space.id)).find((p) => p.id === page.id);
  expect(listed).toBeDefined();
  expect(listed?.publishedVersionId).toBeNull();
  expect(listed?.status).toBe("DRAFT");
});

/**
 * Slug rules are enforced, and enforced by `validateSlug` rather than re-worded here: each
 * expectation names the code that function assigns. Kills dropping the call entirely (which
 * would 500 on `a/b`, since `/` in a path is legal to Postgres and produces a page nested
 * under a parent that does not exist) and kills swapping in a laxer regex.
 */
test.each([
  ["", "empty"],
  ["-adrs", "reserved-prefix"],
  ["a/b", "not-one-segment"],
  ["A-Slug", "uppercase"],
  ["a b", "whitespace"],
  ["..", "path-traversal"],
  ["adr_0042", "invalid-characters"],
  ["x".repeat(SLUG_MAX_LENGTH + 1), "too-long"],
])("slug %j is a field error on `slug` (%s), not a 500", async (slug, code) => {
  const { space, asAisyah } = await fixture();

  const error = rejection(await createPage(asAisyah, input({ spaceId: space.id, slug })));
  expect(error.field).toBe("slug");
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);

  expect(await db.page.count({ where: { path: { contains: "adr" } } })).toBe(0);
});

/**
 * The one `validateSlug` cannot catch. Every slug in the chain below is legal — 80
 * characters, lowercase, kebab — and the assembled path is still over the limit, because
 * depth is unbounded.
 *
 * Kills: dropping the `validatePath` call. Without it this insert SUCCEEDS: 2024 bytes is
 * over the module's 2000-byte guard but comfortably under Postgres's 2704-byte btree row
 * limit, so nothing objects and the guard's whole purpose — catching the class before it
 * reaches the index — is gone. The test therefore asserts the field error rather than
 * asserting "some failure", which a raw constraint violation would also satisfy.
 */
test("an assembled path over the byte limit is a field error, not a constraint violation", async () => {
  const { space, aisyah, asAisyah } = await fixture();

  const segment = "d".repeat(SLUG_MAX_LENGTH);
  const deepPath = Array.from({ length: 24 }, () => segment).join("/");
  expect(deepPath.length).toBeLessThan(MAX_PATH_BYTES);

  const deep = await db.page.create({
    data: {
      spaceId: space.id,
      slug: segment,
      path: deepPath,
      title: "A very deeply nested page",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });

  const result = await createPage(
    asAisyah,
    input({ spaceId: space.id, parentId: deep.id, slug: segment, title: "One level too far" }),
  );

  const error = rejection(result);
  expect(error.field).toBe("slug");
  expect(error.code).toBe("path-too-long");
  expect(error.message).toContain(String(MAX_PATH_BYTES));

  expect(await db.page.count({ where: { title: "One level too far" } })).toBe(0);
});

/**
 * The occupied path, refused before the insert with a message that names the conflict.
 *
 * Kills: dropping the pre-check. The insert then raises Prisma's `P2002` out of the
 * transaction and the caller gets a rejected promise instead of a field error — asserted as
 * `resolves`, so a throw fails the test rather than being caught by a looser assertion.
 */
test("an occupied path is refused up front, naming the page that holds it", async () => {
  const { space, contracts, asAisyah } = await fixture();

  const result = await createPage(
    asAisyah,
    input({
      spaceId: space.id,
      parentId: contracts.id,
      slug: "topic-registry",
      title: "Topic registry",
    }),
  );
  created(result);

  const again = createPage(
    asAisyah,
    input({
      spaceId: space.id,
      parentId: contracts.id,
      slug: "topic-registry",
      title: "Topic registry, again",
    }),
  );
  await expect(again).resolves.toBeDefined();

  const error = rejection(await again);
  expect(error.field).toBe("slug");
  expect(error.code).toBe("path-occupied");
  expect(error.message).toContain("Topic registry");
  expect(error.message).toContain("architecture/mqtt-contracts/topic-registry");

  expect(await db.page.count({ where: { title: "Topic registry, again" } })).toBe(0);
  expect(await db.page.count({ where: { path: "architecture/mqtt-contracts/topic-registry" } })).toBe(1);
});

/**
 * The soft-delete case the unique index does not know about, and the reason the collision
 * check is the one page read in this module without `visiblePage()`.
 *
 * Decided deliberately: refuse, and say so. The row still holds the path, so a check that
 * filtered it out would pass and the insert would fail on the index — the exact unactionable
 * violation the pre-check exists to prevent. Reusing the path by hard-deleting the old row
 * would destroy the version history soft delete exists to keep, and moving the deleted page
 * aside would break Task 12's promise to restore a page where it was.
 *
 * Kills: wrapping the collision check in `visiblePage()`, which turns this into a P2002; and
 * collapsing the two messages into one, which would tell the editor to pick another slug
 * while hiding the restore that actually clears the path.
 */
test("a path held by a soft-deleted page is refused, naming it as deleted", async () => {
  const { space, contracts, asAisyah } = await fixture();

  const first = created(
    await createPage(
      asAisyah,
      input({
        spaceId: space.id,
        parentId: contracts.id,
        slug: "topic-registry",
        title: "Topic registry",
      }),
    ),
  );
  await db.page.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

  const error = rejection(
    await createPage(
      asAisyah,
      input({
        spaceId: space.id,
        parentId: contracts.id,
        slug: "topic-registry",
        title: "Topic registry, replacement",
      }),
    ),
  );
  expect(error.field).toBe("slug");
  expect(error.code).toBe("path-occupied-by-deleted");
  expect(error.message).toContain("Topic registry");
  expect(error.message).toMatch(/deleted/i);

  expect(await db.page.count({ where: { title: "Topic registry, replacement" } })).toBe(0);
});

/**
 * The soft-delete coverage for this module's ordinary read. A deleted parent is gone for
 * writes as well as reads: nesting under it would produce a page whose ancestor no longer
 * exists, reachable by URL and absent from every rail.
 *
 * Kills: dropping `visiblePage()` from the parent lookup.
 */
test("a soft-deleted parent cannot be used as a parent", async () => {
  const { space, contracts, asAisyah } = await fixture();
  await db.page.update({ where: { id: contracts.id }, data: { deletedAt: new Date() } });

  const error = rejection(
    await createPage(
      asAisyah,
      input({
        spaceId: space.id,
        parentId: contracts.id,
        slug: "topic-registry",
        title: "Topic registry",
      }),
    ),
  );
  expect(error.field).toBe("parentId");
  expect(error.code).toBe("parent-not-found");

  expect(await db.page.count({ where: { title: "Topic registry" } })).toBe(0);
});

/**
 * Kills: dropping `spaceId` from the parent lookup. `handbook` is ALL_STAFF, so the viewer
 * genuinely can read that parent — the filter that must refuse it is the space one, not the
 * permission one. Without it the page lands in `engineering` carrying `handbook`'s prefix.
 */
test("a parent in another space is refused, even a readable one", async () => {
  const { space, other, aisyah, asAisyah } = await fixture();
  const foreign = await db.page.create({
    data: {
      spaceId: other.id,
      slug: "welcome",
      path: "welcome",
      title: "Welcome",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });

  const error = rejection(
    await createPage(asAisyah, input({ spaceId: space.id, parentId: foreign.id })),
  );
  expect(error.field).toBe("parentId");
  expect(error.code).toBe("parent-not-found");
  expect(await db.page.count({ where: { spaceId: space.id, path: { startsWith: "welcome" } } })).toBe(0);
});

/**
 * Kills: weakening the permission check to `READ`, or dropping it. A VIEWER passes every
 * READ predicate in the stack — `readableSpace` returns their space and `visiblePage` has no
 * opinion — so `can(..., "EDIT")` is the only thing standing between them and a write.
 */
test("a VIEWER cannot create a page, and nothing is written", async () => {
  const { space, aisyah, asViewer } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: aisyah.id } },
    data: { role: "VIEWER" },
  });

  expect(await createPage(asViewer, input({ spaceId: space.id }))).toEqual({
    ok: false,
    reason: "forbidden",
  });
  expect(await db.page.count()).toBe(2);
  expect(await db.pageDraft.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
});

/**
 * 404-not-403 as a security property, asserted the same way `saveDraft`'s test does it: the
 * answer for a real space must be byte-identical to the answer for a space id that was never
 * real, so the two shapes cannot drift apart and leak the difference.
 */
test("a non-member gets the not-found shape, identical to a space that does not exist", async () => {
  const { space } = await fixture("MEMBERS");

  const real = await createPage(stranger, input({ spaceId: space.id }));
  const imaginary = await createPage(stranger, input({ spaceId: "does-not-exist" }));

  expect(real).toEqual({ ok: false, reason: "not-found" });
  expect(real).toEqual(imaginary);
  expect(await db.page.count()).toBe(2);
  expect(await db.auditLog.count()).toBe(0);
});

/**
 * The other half, and the reason `not-found` cannot simply be the answer to every refusal.
 * In an ALL_STAFF space the stranger can already see the space, so "forbidden" tells them
 * nothing new — and `not-found` would be a lie the form cannot act on.
 */
test("a non-member of an all-staff space is forbidden, not not-found", async () => {
  const { space } = await fixture("ALL_STAFF");

  expect(await createPage(stranger, input({ spaceId: space.id }))).toEqual({
    ok: false,
    reason: "forbidden",
  });
  expect(await db.page.count()).toBe(2);
});

test("a super admin who belongs to nothing can create", async () => {
  const { space } = await fixture("MEMBERS");
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });

  const page = created(
    await createPage(
      { id: root.id, isSuperAdmin: true, memberships: [] },
      input({ spaceId: space.id }),
    ),
  );
  expect(page.path).toBe("adr-0042-mqtt-topic-naming");
});

/**
 * The title is the one free-text field here and it goes straight into Postgres. Kills
 * dropping `stripControl` — a NUL makes the INSERT fail with 22021, which no retry clears —
 * and kills stripping after the emptiness check instead of before it, which would store a
 * page whose nav entry and breadcrumb are blank.
 */
test("control characters are stripped from the title, and a title of only them is empty", async () => {
  const { space, asAisyah } = await fixture();

  // Escape sequences, never literals. A literal NUL or zero-width mark is invisible in a
  // diff, and this project has already had a shell command rejected for carrying one.
  const page = created(
    await createPage(
      asAisyah,
      input({ spaceId: space.id, title: "MQTT\u0000 \u0007topic\u0008 naming" }),
    ),
  );
  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.title).toBe("MQTT topic naming");

  const error = rejection(
    await createPage(
      asAisyah,
      input({ spaceId: space.id, slug: "another-one", title: " \u0000\u001f " }),
    ),
  );
  expect(error.field).toBe("title");
  expect(error.code).toBe("title-empty");
});

/**
 * Two creates of the same path landing together. Exactly one may win: both winning is
 * impossible (the unique index would refuse it) but both *failing gracefully* is not the
 * contract either, and a raw `P2002` escaping to the caller is what the advisory lock and
 * the in-transaction check exist to prevent.
 *
 * Unlike the draft race, this one does not need the interleaving staged by hand — the
 * `pg_advisory_xact_lock` is what makes the check authoritative, so the loser is guaranteed
 * to read the winner's row rather than to be staggered into reading it by luck. Kills:
 * moving the collision check outside the transaction, and dropping the lock, either of which
 * turns the loser into a rejected promise.
 */
test("two creates of the same path racing: one wins and the other is a field error", async () => {
  const { space, asAisyah } = await fixture();

  const results = await Promise.allSettled([
    createPage(asAisyah, input({ spaceId: space.id, title: "First" })),
    createPage(asAisyah, input({ spaceId: space.id, title: "Second" })),
  ]);

  const settled = results.map((r) => {
    if (r.status === "rejected") throw new Error(`a create threw: ${r.reason}`);
    return r.value;
  });

  expect(settled.filter((r) => r.ok)).toHaveLength(1);
  const loser = settled.find((r) => !r.ok);
  expect(loser).toBeDefined();
  expect(rejection(loser!).code).toBe("path-occupied");

  expect(await db.page.count({ where: { path: "adr-0042-mqtt-topic-naming" } })).toBe(1);
  expect(await db.pageDraft.count()).toBe(1);
  expect(await db.auditLog.count()).toBe(1);
});
