import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { inOneRequest } from "@/lib/audit/log";
import { createPage } from "@/lib/pages/create";
import { saveDraft } from "@/lib/drafts/repo";
import { publishPage } from "@/lib/pages/publish";
import {
  createSystem,
  deleteSystem,
  listBlockingPages,
  listSystemsForAdmin,
  updateSystem,
  type SystemInput,
} from "@/lib/systems/admin";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * `/admin/systems` against the real database — Phase 7 Task 5.
 *
 * The file is written around four claims, each of which this task was handed by name:
 *
 * 1. **The refusal is one predicate, and it is falsifiable.** Every assertion about a refusal has
 *    its non-vacuity companion in the same test — the super admin making the identical call and
 *    getting an answer. Task 4's finding is the reason: a refusal test can be masked by a *second*
 *    guard producing an identical answer, so the tests below are written so that deleting
 *    `refuseNonAdmin`'s one line changes what they see, in both directions.
 * 2. **The reference count is `PageSystem` rows, not what `/systems/[key]` shows**, because the
 *    foreign key counts soft-deleted and unpublished pages too.
 * 3. **A credentialed `repoUrl` never reaches the column**, with the credential-free form of the
 *    same URL accepted in the same test — otherwise "refused" is consistent with a validator that
 *    refuses everything.
 * 4. **A rename's stated consequence is real**, driven end to end through a real republish rather
 *    than asserted from a comment.
 */

/** A URL of the shape `git remote -v` prints in the real checkouts on this machine. */
const CREDENTIALED = "https://oauth2:glpat-AbCdEf1234567890@gitlab.example.com/acme/hub.git";
/** The same repository, without the userinfo. The non-vacuity companion for every refusal below. */
const CLEAN = "https://gitlab.example.com/acme/hub.git";

async function fixture() {
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });

  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  // `aisyah` is an **ADMIN** of a space, not a stranger. A member of nothing is refused by any
  // predicate at all, including a mutated one — the near-vacuity Phase 4 recorded. A space ADMIN
  // is exactly the viewer `can(v, space, "MANAGE_SPACE")` says yes to, so refusing them is what
  // separates "administers a space" from "administers the installation".
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: aisyah.id, role: "ADMIN" },
  });

  const hubCore = await db.system.create({
    data: { key: "order-hub", name: "Order hub", kind: "LIBRARY", ownerTeam: "Hub", repoUrl: CLEAN },
    select: { id: true, key: true },
  });
  const bridge = await db.system.create({
    data: { key: "kiosk-bridge", name: "Kiosk bridge", kind: "SERVICE", isActive: false },
    select: { id: true, key: true },
  });

  return {
    engineering,
    handbook,
    hubCore,
    bridge,
    /** A super admin who belongs to nothing — §8's audited case, and this surface's only viewer. */
    asRoot: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    asSpaceAdmin: {
      id: aisyah.id,
      isSuperAdmin: false,
      memberships: [{ spaceId: engineering.id, role: "ADMIN" }],
    } satisfies Viewer,
  };
}

/**
 * A page with a facet row, written directly.
 *
 * The version row and the `PageSystem` row are direct writes rather than a real publish, for
 * `systems-read.test.ts`'s reason: the authoring path that produces them is Task 2's and is tested
 * against every rule it owns in `publish.test.ts`, while several row shapes here — a soft-deleted
 * page, an unpublished one — cannot be reached through publish at all. One test below does drive a
 * real publish end to end, so the two halves are joined somewhere.
 */
async function documented(args: {
  spaceId: string;
  slug: string;
  title: string;
  systemId: string;
  published?: boolean;
  deleted?: boolean;
}) {
  const author = await db.user.findFirstOrThrow({ select: { id: true } });
  const page = await db.page.create({
    data: {
      spaceId: args.spaceId,
      slug: args.slug,
      path: args.slug,
      title: args.title,
      createdById: author.id,
      status: "CURRENT",
      deletedAt: args.deleted === true ? new Date() : null,
    },
    select: { id: true },
  });
  if (args.published !== false) {
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: args.title,
        markdown: `# ${args.title}\n`,
        status: "CURRENT",
        authorId: author.id,
      },
      select: { id: true },
    });
    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
  }
  await db.pageSystem.create({ data: { pageId: page.id, systemId: args.systemId } });
  return page;
}

const input = (over: Partial<SystemInput> = {}): SystemInput => ({
  key: "admin-web",
  name: "Admin web",
  kind: "SERVICE",
  ownerTeam: "Platform",
  description: "The browser console.",
  repoUrl: "",
  ...over,
});

const systemByKey = (key: string) =>
  db.system.findUnique({
    where: { key },
    select: { id: true, key: true, name: true, isActive: true, repoUrl: true, ownerTeam: true },
  });

const auditRows = (action: string) =>
  db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

/* ------------------------------------------------------------------ the gate */

/**
 * The whole point of `src/lib/admin/gate.ts` in one test: five entry points, one predicate.
 *
 * **Mutation-verified, and the two directions kill different mutants.** With
 * `if (viewer.isSuperAdmin) return null;` deleted from `refuseNonAdmin`, the second half fails —
 * the super admin is refused too. With the guard inverted or the whole body replaced by
 * `return null`, the first half fails — a space ADMIN reads and writes the catalogue. There is no
 * second guard anywhere in the module that could produce either answer on its own, which is the
 * masking Task 4 found in `confirmReview`: `listSystemsForAdmin` has no other filter at all, and
 * `createSystem` would genuinely insert the row.
 */
test("a space ADMIN is refused by every entry point, and the super admin is not", async () => {
  const f = await fixture();
  const before = await db.system.count();

  expect(await listSystemsForAdmin(f.asSpaceAdmin)).toEqual({ ok: false, reason: "not-found" });
  expect(await listBlockingPages(f.asSpaceAdmin, f.hubCore.id)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await createSystem(f.asSpaceAdmin, input())).toEqual({ ok: false, reason: "not-found" });
  expect(await updateSystem(f.asSpaceAdmin, f.hubCore.id, { name: "Renamed" })).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await deleteSystem(f.asSpaceAdmin, f.bridge.id)).toEqual({
    ok: false,
    reason: "not-found",
  });

  // Nothing was written. A refusal that returned the right shape while committing the change
  // would pass every assertion above.
  expect(await db.system.count()).toBe(before);
  expect((await systemByKey("order-hub"))?.name).toBe("Order hub");

  // The non-vacuity companion, and the discrimination: the identical five calls, one line of
  // difference in the viewer.
  const listed = await listSystemsForAdmin(f.asRoot);
  expect(listed.ok).toBe(true);
  expect((await listBlockingPages(f.asRoot, f.hubCore.id)).ok).toBe(true);
  expect((await createSystem(f.asRoot, input())).ok).toBe(true);
  expect((await updateSystem(f.asRoot, f.hubCore.id, { name: "Order hub (renamed)" })).ok).toBe(
    true,
  );
  expect((await deleteSystem(f.asRoot, f.bridge.id)).ok).toBe(true);
});

/** The refusal is not-found and never forbidden — §8, and `src/lib/admin/gate.ts`'s argument. */
test("the refusal is indistinguishable from a system that does not exist", async () => {
  const f = await fixture();

  const refusedByPermission = await listBlockingPages(f.asSpaceAdmin, f.hubCore.id);
  const refusedByMiss = await listBlockingPages(f.asRoot, "no-such-system-id");
  expect(refusedByPermission).toEqual(refusedByMiss);
  // Non-vacuity: the same call, a real id, an admin — this is what the two refusals are NOT.
  expect((await listBlockingPages(f.asRoot, f.hubCore.id)).ok).toBe(true);
});

/* ------------------------------------------------- the count, and what it counts */

/**
 * Task 1's requirement, and the one number on this page that is deliberately not the number
 * `/systems/[key]` renders.
 *
 * Three pages name `order-hub`: one ordinary, one never published, one soft-deleted. All three hold
 * a `PageSystem` row and all three make `onDelete: Restrict` refuse, so all three are counted. The
 * companion assertion is `kiosk-bridge` at zero — without it, a count that returned the whole
 * table's size would pass.
 */
test("the reference count is every PageSystem row, soft-deleted and unpublished included", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "topic-registry",
    title: "Topic registry",
    systemId: f.hubCore.id,
  });
  await documented({
    spaceId: f.engineering.id,
    slug: "draft-note",
    title: "Draft note",
    systemId: f.hubCore.id,
    published: false,
  });
  await documented({
    spaceId: f.handbook.id,
    slug: "old-runbook",
    title: "Old runbook",
    systemId: f.hubCore.id,
    deleted: true,
  });

  const listed = await listSystemsForAdmin(f.asRoot);
  if (!listed.ok) throw new Error("expected the catalogue");

  const byKey = new Map(listed.systems.map((row) => [row.key, row]));
  expect(byKey.get("order-hub")?.references).toBe(3);
  expect(byKey.get("kiosk-bridge")?.references).toBe(0);
  // Key order, the same order `/systems` uses.
  expect(listed.systems.map((row) => row.key)).toEqual(["kiosk-bridge", "order-hub"]);
});

/* --------------------------------------------------------------- refused delete */

/**
 * What a refused delete shows and offers — the whole of what Task 1 said this task owed.
 *
 * The count comes from the database after the refusal, the sentence names it, and `isActive` is
 * what lets the surface offer `isActive = false` in the place the refusal appeared. The audit
 * assertion is the one that pins the rollback: the delete and its `system.delete` row share a
 * transaction, so a refusal that left a row behind would be a record of something that did not
 * happen.
 */
test("deleting a referenced system is refused with the count, the reason and the alternative", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "topic-registry",
    title: "Topic registry",
    systemId: f.hubCore.id,
  });
  await documented({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: "Welcome",
    systemId: f.hubCore.id,
  });

  const result = await deleteSystem(f.asRoot, f.hubCore.id);
  if (result.ok || result.reason !== "referenced") {
    throw new Error(`expected a referenced refusal, got ${JSON.stringify(result)}`);
  }

  expect(result.references).toBe(2);
  expect(result.isActive).toBe(true);
  expect(result.message).toContain("2 pages");
  expect(result.message).toContain("order-hub");
  // The alternative, named in the refusal rather than left to the admin to find.
  expect(result.message).toContain("sunsetting");

  // Still there, and no audit row claiming otherwise.
  expect(await systemByKey("order-hub")).not.toBeNull();
  expect(await auditRows("system.delete")).toEqual([]);
});

/**
 * The offer is suppressed when it has already been taken.
 *
 * A refusal that told an admin to mark a system sunsetting when it already is would be the "a
 * refusal that names no alternative" failure wearing a helpful face.
 */
test("a sunsetting system's refusal offers deletion advice rather than sunsetting again", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "decommission",
    title: "Decommissioning the bridge",
    systemId: f.bridge.id,
  });

  const result = await deleteSystem(f.asRoot, f.bridge.id);
  if (result.ok || result.reason !== "referenced") throw new Error("expected a refusal");

  expect(result.isActive).toBe(false);
  expect(result.references).toBe(1);
  expect(result.message).toContain("1 page");
  expect(result.message).toContain("already marked sunsetting");
});

/**
 * The case `Restrict` never blocks, which is Task 1's third argument for choosing it: a row
 * created in error has no pages naming it.
 *
 * The audit row is the only thing left afterwards, which is why it is asserted field by field —
 * `System` has no `createdAt` and the row is gone, so this is the whole record.
 */
test("an unreferenced system deletes, and its audit row is the only record left", async () => {
  const f = await fixture();

  expect(await deleteSystem(f.asRoot, f.bridge.id)).toEqual({ ok: true, key: "kiosk-bridge" });
  expect(await systemByKey("kiosk-bridge")).toBeNull();

  const rows = await auditRows("system.delete");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.asRoot.id, spaceId: null, pageId: null });
  expect(rows[0]!.detail).toEqual({
    key: "kiosk-bridge",
    name: "Kiosk bridge",
    kind: "SERVICE",
  });
});

/* ----------------------------------------------------- the credential refusal */

/**
 * **The write half of the two-ended credential fix**, with its non-vacuity companion in the same
 * test.
 *
 * Phase 5's lesson is that removing either end alone still leaks, and Task 3 built `repoLinkOf`
 * pure so this end could reuse it rather than growing a second URL parser. The companion is what
 * makes the refusal mean something: the *same repository*, one component removed, is accepted and
 * stored — so this cannot pass over a validator that refuses every URL.
 *
 * The message assertion is not decoration. An error message is rendered, logged and screenshotted,
 * so a refusal that quoted the URL back would move the token from the form into three more places.
 */
test("a repoUrl embedding a credential is refused, and the same URL without it is stored", async () => {
  const f = await fixture();

  const refused = await createSystem(f.asRoot, input({ key: "order-hub-gateway", repoUrl: CREDENTIALED }));
  if (refused.ok || refused.reason !== "invalid") {
    throw new Error(`expected a field error, got ${JSON.stringify(refused)}`);
  }
  expect(refused.errors).toHaveLength(1);
  expect(refused.errors[0]!.field).toBe("repoUrl");
  expect(refused.errors[0]!.code).toBe("repo-credentials");
  // Nothing of the URL, not the token, not the user, not even the host.
  expect(refused.errors[0]!.message).not.toContain("glpat");
  expect(refused.errors[0]!.message).not.toContain("oauth2");
  expect(refused.errors[0]!.message).not.toContain("gitlab.example.com");
  // And nothing was written — a refusal that reported an error after inserting would pass above.
  expect(await systemByKey("order-hub-gateway")).toBeNull();

  const accepted = await createSystem(f.asRoot, input({ key: "order-hub-gateway", repoUrl: CLEAN }));
  expect(accepted.ok).toBe(true);
  expect((await systemByKey("order-hub-gateway"))?.repoUrl).toBe(CLEAN);
});

/**
 * `username` alone withholds, which is the case `repo-url.ts` says matters most: a personal access
 * token pasted as the username with no password at all. A rule that only looked for a password
 * would pass this straight through.
 */
test("a bare token as the username is refused too", async () => {
  const f = await fixture();
  const refused = await createSystem(
    f.asRoot,
    input({ key: "order-hub-gateway", repoUrl: "https://glpat-AbCdEf1234567890@gitlab.example.com/x.git" }),
  );
  if (refused.ok || refused.reason !== "invalid") throw new Error("expected a field error");
  expect(refused.errors[0]!.code).toBe("repo-credentials");
});

/**
 * The scheme allowlist is a second defect and not a variant of the first — a stored
 * `javascript:` URL is script execution in an `href`, not a broken link.
 *
 * Refusing it here is what makes Task 3's render-side check a second line of defence rather than
 * the only one. `ssh://` is in the same test because it is the honest case: a real remote that
 * simply has no browsable form, reported as a scheme problem rather than a credential alarm even
 * though its `git@` looks like userinfo.
 */
test("a non-http scheme is refused, and reported as a scheme rather than a credential", async () => {
  const f = await fixture();

  const script = await createSystem(
    f.asRoot,
    input({ key: "order-hub-gateway", repoUrl: "javascript:alert(1)" }),
  );
  if (script.ok || script.reason !== "invalid") throw new Error("expected a field error");
  expect(script.errors[0]!.code).toBe("repo-scheme");

  const ssh = await createSystem(
    f.asRoot,
    input({ key: "order-hub-gateway", repoUrl: "ssh://git@gitlab.example.com/acme/hub.git" }),
  );
  if (ssh.ok || ssh.reason !== "invalid") throw new Error("expected a field error");
  expect(ssh.errors[0]!.code).toBe("repo-scheme");

  expect(await systemByKey("order-hub-gateway")).toBeNull();
});

/**
 * The patch, and why an edit is one.
 *
 * A credentialed URL can be in the column already — written by an older build, or by a hand-run
 * `UPDATE`, which is the case `repo-url.ts` names when it says the render-side guard exists
 * "whether or not Task 5's write refusal does". A replacement form would have to prefill it, which
 * means printing it; a patch does not, and this test is what pins that an edit which never mentions
 * `repoUrl` leaves the column exactly as it was rather than clearing it.
 */
test("an edit that does not mention repoUrl leaves a stored credentialed URL untouched", async () => {
  const f = await fixture();
  await db.system.update({
    where: { id: f.hubCore.id },
    data: { repoUrl: CREDENTIALED },
    select: { id: true },
  });

  const saved = await updateSystem(f.asRoot, f.hubCore.id, { name: "Order hub (gateway)" });
  expect(saved.ok).toBe(true);

  const row = await systemByKey("order-hub");
  expect(row?.name).toBe("Order hub (gateway)");
  expect(row?.repoUrl).toBe(CREDENTIALED);

  // And the admin list still refuses to render it — the other end of the fix, unchanged by this
  // one. Without this line the test above is consistent with an admin page that prints it.
  const listed = await listSystemsForAdmin(f.asRoot);
  if (!listed.ok) throw new Error("expected the catalogue");
  const hub = listed.systems.find((row) => row.key === "order-hub");
  expect(hub?.repo).toEqual({ kind: "withheld", reason: "credentials" });

  // Explicitly clearing it is the way out, and it is one field.
  expect((await updateSystem(f.asRoot, f.hubCore.id, { repoUrl: "" })).ok).toBe(true);
  expect((await systemByKey("order-hub"))?.repoUrl).toBeNull();
});

/* ----------------------------------------------------------------- the rename */

/**
 * The rename decision, recorded where Task 2 asked for it: on the row that changed.
 *
 * `strandedPages` is the number that says what the rename cost — every one of those pages holds
 * the old key in its published frontmatter. `previousKey` is null and not absent on an ordinary
 * edit, for `page.review`'s reason.
 */
test("a rename is allowed, and audited with the old key and the count it stranded", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "topic-registry",
    title: "Topic registry",
    systemId: f.hubCore.id,
  });

  const renamed = await updateSystem(f.asRoot, f.hubCore.id, { key: "order-hub-gateway" });
  expect(renamed).toMatchObject({ ok: true, key: "order-hub-gateway", renamedFrom: "order-hub", references: 1 });

  // The facet row survives, by id — which is the half of Task 2's finding that is *not* a problem.
  expect(await db.pageSystem.count({ where: { systemId: f.hubCore.id } })).toBe(1);

  const rows = await auditRows("system.update");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.asRoot.id, spaceId: null });
  expect(rows[0]!.detail).toMatchObject({
    key: "order-hub-gateway",
    previousKey: "order-hub",
    strandedPages: 1,
    fields: ["key"],
  });
  // `repoUrl` is never copied into an audit row, by value — only ever by name in `fields`.
  expect(JSON.stringify(rows[0]!.detail)).not.toContain("gitlab.example.com");

  // An ordinary edit records the absence rather than omitting the key.
  await updateSystem(f.asRoot, f.hubCore.id, { name: "Hub gateway" });
  const second = (await auditRows("system.update"))[1];
  expect(second!.detail).toMatchObject({ previousKey: null, strandedPages: 0, fields: ["name"] });
});

/**
 * **The rename's stated consequence, driven end to end rather than asserted from a comment.**
 *
 * This is the test that decides whether allowing the rename was the right call: it shows that the
 * breakage is a refusal with a sentence on the `systems:` line, not a silent drop — the failure
 * Phase 3 recorded and Task 2 closed. A real `createPage`, a real draft, a real publish, then the
 * rename, then a real republish.
 *
 * The non-vacuity companion is the first publish: without it, a refusal on the second one is
 * consistent with a page that could never have published at all.
 */
test("after a rename, republishing a page that named the old key is refused and says so", async () => {
  const f = await fixture();

  const created = await createPage(f.asRoot, {
    spaceId: f.engineering.id,
    parentId: null,
    slug: "topic-registry",
    title: "Topic registry",
    docType: "DOC",
  });
  if (!created.ok) throw new Error(`createPage: ${JSON.stringify(created)}`);

  const document = "---\nsystems:\n  - order-hub\n---\n\n# Topics\n\nNamespaced by outlet.\n";
  const draft = await db.pageDraft.findUniqueOrThrow({
    where: { pageId: created.page.id },
    select: { updatedAt: true },
  });
  const saved = await saveDraft(f.asRoot, created.page.id, {
    title: "Topic registry",
    markdown: document,
    seen: draft.updatedAt,
  });
  if (!saved.ok) throw new Error(`saveDraft: ${JSON.stringify(saved)}`);

  const first = await publishPage(f.asRoot, created.page.id, {});
  expect(first.ok).toBe(true);
  expect(await db.pageSystem.count({ where: { pageId: created.page.id } })).toBe(1);

  const renamed = await updateSystem(f.asRoot, f.hubCore.id, { key: "order-hub-gateway" });
  expect(renamed).toMatchObject({ ok: true, renamedFrom: "order-hub" });

  // The same document, unchanged — which is the point: nothing rewrote the author's text.
  const again = await saveDraft(f.asRoot, created.page.id, {
    title: "Topic registry",
    markdown: document,
    seen: null,
  });
  if (!again.ok) throw new Error(`saveDraft: ${JSON.stringify(again)}`);

  const second = await publishPage(f.asRoot, created.page.id, {});
  if (second.ok) throw new Error("expected the republish to be refused");
  expect(JSON.stringify(second)).toContain("order-hub");
  expect(JSON.stringify(second)).toContain("systems");
});

/* ----------------------------------------------- the audit line Task 1 drew */

/**
 * *"Showing the number needs no audit; showing the titles does."*
 *
 * A discrimination and not an absence: the same super admin, the same `MEMBERS` space they do not
 * belong to, two calls — one writes a `space.access` row and the other does not. An assertion that
 * the catalogue writes none would pass over an audit that never fired at all.
 *
 * `handbook` is `ALL_STAFF`, so it must contribute **no** row however many pages it produced —
 * `needsAccessAudit` is the one rule, called and not copied.
 */
test("listing the blocking pages audits the spaces it read; the count alone audits nothing", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "topic-registry",
    title: "Topic registry",
    systemId: f.hubCore.id,
  });
  await documented({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: "Welcome",
    systemId: f.hubCore.id,
  });

  await inOneRequest(async () => {
    const listed = await listSystemsForAdmin(f.asRoot);
    if (!listed.ok) throw new Error("expected the catalogue");
    expect(listed.systems.find((row) => row.key === "order-hub")?.references).toBe(2);
  });
  expect(await auditRows("space.access")).toEqual([]);

  await inOneRequest(async () => {
    const blocking = await listBlockingPages(f.asRoot, f.hubCore.id);
    if (!blocking.ok) throw new Error("expected the blocking pages");
    expect(blocking.pages.map((page) => page.title)).toEqual(["Topic registry", "Welcome"]);
  });

  const access = await auditRows("space.access");
  expect(access).toHaveLength(1);
  expect(access[0]!.spaceId).toBe(f.engineering.id);
  expect(access[0]!.detail).toEqual({
    key: "engineering",
    visibility: "MEMBERS",
    by: "super-admin",
  });
});

/**
 * The listing has **no** `visiblePage()` and that absence is load-bearing, not an omission.
 *
 * A soft-deleted page keeps its `PageSystem` row and keeps blocking the `Restrict`, so a filtered
 * list would name fewer pages than the refusal counts and leave an admin looking for a blocker
 * that had been hidden from them. The live page in the same assertion is the non-vacuity
 * companion: a list that returned nothing at all would satisfy "the deleted one is flagged"
 * vacuously.
 */
test("a soft-deleted page still blocks, is listed, and is flagged", async () => {
  const f = await fixture();
  await documented({
    spaceId: f.engineering.id,
    slug: "live-note",
    title: "Live note",
    systemId: f.hubCore.id,
  });
  await documented({
    spaceId: f.engineering.id,
    slug: "gone-note",
    title: "Gone note",
    systemId: f.hubCore.id,
    deleted: true,
  });

  const blocking = await listBlockingPages(f.asRoot, f.hubCore.id);
  if (!blocking.ok) throw new Error("expected the blocking pages");
  expect(blocking.pages.map((page) => [page.title, page.deleted])).toEqual([
    ["Gone note", true],
    ["Live note", false],
  ]);

  // And it really does block: the count and the list agree, which is the property a `visiblePage`
  // here would break.
  const refused = await deleteSystem(f.asRoot, f.hubCore.id);
  if (refused.ok || refused.reason !== "referenced") throw new Error("expected a refusal");
  expect(refused.references).toBe(blocking.pages.length);
});

/* ------------------------------------------------------------ field validation */

/**
 * The key rules reach the surface as a sentence rather than as a constraint violation, which is
 * the whole reason `validateSystemKey` exists — Task 1 deferred it here in as many words.
 *
 * The companion is the row count: a 500 from the CHECK would also leave nothing written, so
 * "nothing was created" is not on its own evidence that the *validator* refused.
 */
test("an illegal key is a field error with a sentence, not a constraint violation", async () => {
  const f = await fixture();

  const refused = await createSystem(f.asRoot, input({ key: "Hub Core" }));
  if (refused.ok || refused.reason !== "invalid") throw new Error("expected a field error");
  expect(refused.errors[0]).toMatchObject({ field: "key", code: "whitespace" });
  expect(refused.errors[0]!.message).toMatch(/hyphen/i);

  const long = await createSystem(f.asRoot, input({ key: "a".repeat(300) }));
  if (long.ok || long.reason !== "invalid") throw new Error("expected a field error");
  expect(long.errors[0]).toMatchObject({ field: "key", code: "too-long" });

  expect(await db.system.count()).toBe(2);
});

/** Every field is reported at once: one form, six inputs, one round trip. */
test("several bad fields come back together", async () => {
  const f = await fixture();
  const refused = await createSystem(
    f.asRoot,
    input({ key: "Hub Core", name: "  ", repoUrl: CREDENTIALED }),
  );
  if (refused.ok || refused.reason !== "invalid") throw new Error("expected field errors");
  expect(refused.errors.map((error) => error.field).sort()).toEqual(["key", "name", "repoUrl"]);
});

/**
 * A duplicate key is a field error and not a 500, caught from Postgres rather than pre-checked —
 * see `duplicateKey`. It has to hold on the rename path too, which is the one a pre-check would
 * most easily have been forgotten on.
 */
test("a key already in the catalogue is refused on create and on rename", async () => {
  const f = await fixture();

  const created = await createSystem(f.asRoot, input({ key: "order-hub" }));
  if (created.ok || created.reason !== "invalid") throw new Error("expected a field error");
  expect(created.errors[0]).toMatchObject({ field: "key", code: "key-taken" });

  const renamed = await updateSystem(f.asRoot, f.bridge.id, { key: "order-hub" });
  if (renamed.ok || renamed.reason !== "invalid") throw new Error("expected a field error");
  expect(renamed.errors[0]).toMatchObject({ field: "key", code: "key-taken" });

  // Nothing moved: `kiosk-bridge` is still itself.
  expect((await systemByKey("kiosk-bridge"))?.id).toBe(f.bridge.id);
});

/** Create writes an audit row too, because `System` has no `createdAt` — Task 1 removed it. */
test("creating a system is audited, which is the only record of when it was added", async () => {
  const f = await fixture();
  const created = await createSystem(f.asRoot, input({ key: "admin-web", repoUrl: CLEAN }));
  expect(created).toMatchObject({ ok: true, key: "admin-web", references: 0, renamedFrom: null });

  const rows = await auditRows("system.create");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.asRoot.id, spaceId: null, pageId: null });
  expect(rows[0]!.detail).toEqual({ key: "admin-web", name: "Admin web", kind: "SERVICE" });
  // The URL is stored on the row and never in the audit — see `auditFields`.
  expect((await systemByKey("admin-web"))?.repoUrl).toBe(CLEAN);
  expect(JSON.stringify(rows[0]!.detail)).not.toContain("gitlab");
});
