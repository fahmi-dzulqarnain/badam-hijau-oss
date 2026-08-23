import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage, type PublishResult } from "@/lib/pages/publish";
import { saveDraft } from "@/lib/drafts/repo";
import { getPublishedPage } from "@/lib/pages/repo";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Every field gets a value nothing else in the fixture shares — `slug`, `path` and `title`
 * are all distinguishable, so swapping one for another in the implementation is visible.
 * Phase 1 learned that from a fixture whose fields all defaulted to the node id.
 */
async function fixture(over: { docType?: "DOC" | "ADR" | "RFC" | "RUNBOOK" } = {}) {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const budi = await db.user.create({
    data: { email: "budi@example.com", name: "Budi S." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });

  const parent = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "architecture",
      path: "architecture",
      title: "Architecture notes",
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });
  // Two levels deep, so a reader URL built from the slug rather than the path is visible.
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      parentId: parent.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts (working title)",
      docType: over.docType ?? "DOC",
      status: "DRAFT",
      createdById: aisyah.id,
    },
  });
  const draft = await db.pageDraft.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "# Topics\n\nEvery topic is namespaced by outlet.\n",
      updatedById: aisyah.id,
    },
  });

  for (const user of [aisyah, budi]) {
    await db.spaceMembership.create({
      data: { spaceId: space.id, userId: user.id, role: "EDITOR" },
    });
  }

  const asRole = (id: string, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    aisyah,
    budi,
    parent,
    page,
    draft,
    asAisyah: asRole(aisyah.id, "EDITOR"),
    asBudi: asRole(budi.id, "EDITOR"),
    asViewer: asRole(aisyah.id, "VIEWER"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Narrows to the success branch, failing with the actual result if it is not one. */
function published(result: PublishResult) {
  if (!result.ok) throw new Error(`expected a publish, got ${JSON.stringify(result)}`);
  return result.page;
}

/** Narrows to a field rejection, failing with the actual result if it is not one. */
function rejection(result: PublishResult) {
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`expected a field error, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

/**
 * Everything a publish would change, in one object.
 *
 * The atomicity assertions in this file compare a whole snapshot rather than checking one
 * count, because a transaction that half-commits fails in whichever half nobody looked at:
 * a version inserted without the page pointer moved, a draft deleted without a version, an
 * audit row for a publish that did not happen.
 */
async function snapshot(pageId: string) {
  const page = await db.page.findUniqueOrThrow({
    where: { id: pageId },
    select: { title: true, status: true, publishedVersionId: true, publishedAt: true },
  });
  const draft = await db.pageDraft.findUnique({
    where: { pageId },
    select: { title: true, markdown: true, updatedAt: true },
  });
  return {
    page,
    draft,
    versions: await db.pageVersion.count({ where: { pageId } }),
    audits: await db.auditLog.count({ where: { pageId } }),
  };
}

/** Waits are only ever used to stage an interleaving; nothing is asserted about them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("publishing makes the page readable end to end, and takes the draft with it", async () => {
  const { space, page, aisyah, asAisyah, draft } = await fixture();

  const result = published(await publishPage(asAisyah, page.id));
  expect(result.path).toBe("architecture/mqtt-contracts");
  expect(result.spaceKey).toBe("engineering");
  expect(result.status).toBe("CURRENT");
  expect(result.title).toBe("MQTT contracts");

  // The assertion that matters: through the reader's own query, not by inspecting rows.
  // `getPublishedPage` requires BOTH `publishedVersionId` and a resolvable version, so this
  // fails for a publish that set the timestamp and not the pointer, or the pointer and not
  // the version.
  const read = await getPublishedPage(asAisyah, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(read).not.toBeNull();
  expect(read?.page.title).toBe("MQTT contracts");
  expect(read?.page.status).toBe("CURRENT");
  expect(read?.version.id).toBe(result.versionId);
  expect(read?.version.markdown).toBe(draft.markdown);
  expect(read?.space.id).toBe(space.id);

  // The version carries the publisher as author, and the page carries both "published"
  // columns — they are independent and a query on either alone is a Phase 1 lesson.
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.authorId).toBe(aisyah.id);
  expect(version.status).toBe("CURRENT");
  expect(version.title).toBe("MQTT contracts");
  expect(version.markdown).toBe(draft.markdown);

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBe(result.versionId);
  expect(row.publishedAt).not.toBeNull();
  expect(row.title).toBe("MQTT contracts");

  // Gone, which is what makes `vanished` reachable — see the sequence test below.
  expect(await db.pageDraft.findUnique({ where: { pageId: page.id } })).toBeNull();

  const audit = await db.auditLog.findFirstOrThrow({ where: { pageId: page.id } });
  expect(audit.action).toBe("page.publish");
  expect(audit.actorId).toBe(aisyah.id);
  expect(audit.detail).toMatchObject({
    path: "architecture/mqtt-contracts",
    versionId: result.versionId,
    from: "DRAFT",
    to: "CURRENT",
  });
});

/**
 * The sequence this task exists to make real, walked end to end across Task 4's code and
 * this one's. Task 7 found the bug this pins before it could happen; the unit tests on
 * `decideSave` cover the decision, and only this test covers the *event* — a real editor
 * holding a real timestamp for a row a real publish deleted.
 *
 * Kills a `decideSave` that answers `create` for "a `seen` but no draft", and kills a
 * publish that leaves the draft in place (which would make the stale save a plain `update`
 * and silently overwrite the published text's source).
 */
test("a stale editor's next autosave after a publish is refused, and writes nothing", async () => {
  const { page, asAisyah, asBudi } = await fixture();

  // Budi has the page open and has saved at least once, so he holds a real `seen`.
  const opened = await saveDraft(asBudi, page.id, {
    title: "MQTT contracts",
    markdown: "Budi's work in progress.\n",
    seen: (await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } })).updatedAt,
  });
  if (!opened.ok) throw new Error("expected the setup save to succeed");
  const seen = opened.draft.updatedAt;

  // Aisyah publishes. The draft row Budi is holding a timestamp for ceases to exist.
  const result = published(await publishPage(asAisyah, page.id));

  const stale = await saveDraft(asBudi, page.id, {
    title: "MQTT contracts",
    markdown: "Budi's work in progress, plus one more paragraph.\n",
    seen,
  });

  // NOT `create`, and not a 201. `vanished`, with his text handed back so nothing is
  // stranded, and — the part that matters — nothing written.
  expect(stale.ok).toBe(false);
  if (stale.ok || stale.reason !== "vanished") {
    throw new Error(`expected vanished, got ${JSON.stringify(stale)}`);
  }
  expect(stale.mine.markdown).toBe("Budi's work in progress, plus one more paragraph.\n");

  expect(await db.pageDraft.findUnique({ where: { pageId: page.id } })).toBeNull();
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(1);

  // And the published version is still the one Aisyah published, not a resurrection of
  // Budi's pre-publish text.
  const read = await getPublishedPage(asBudi, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(read?.version.id).toBe(result.versionId);
  expect(read?.version.markdown).toBe("Budi's work in progress.\n");
});

/**
 * The plan's atomicity assertion, and the reason it is a snapshot rather than an error-message
 * check: a test that only asserts the message passes against a transaction that inserted the
 * version and then failed.
 *
 * Kills a publish that validates the transition after the version insert, and one that
 * updates the page before validating.
 */
test("an illegal transition is refused and nothing at all is written", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });

  // Get the ADR to ACCEPTED legitimately, so the illegal step is the second publish.
  published(await publishPage(asAisyah, page.id, { status: "ACCEPTED" }));
  await saveDraft(asAisyah, page.id, {
    title: "MQTT contracts",
    markdown: "A second round of edits.\n",
    seen: null,
  });

  const before = await snapshot(page.id);
  expect(before.draft).not.toBeNull();

  const error = rejection(await publishPage(asAisyah, page.id, { status: "DRAFT" }));
  expect(error.field).toBe("status");
  expect(error.code).toBe("draft-is-not-a-destination");

  expect(await snapshot(page.id)).toEqual(before);
});

test("an ACCEPTED ADR cannot be republished as PROPOSED, and nothing is written", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  published(await publishPage(asAisyah, page.id, { status: "ACCEPTED" }));
  await saveDraft(asAisyah, page.id, {
    title: "MQTT contracts",
    markdown: "Reopening the argument.\n",
    seen: null,
  });

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id, { status: "PROPOSED" }));
  expect(error.code).toBe("illegal-transition");
  expect(await snapshot(page.id)).toEqual(before);
});

test("an empty draft is refused as a field error, and nothing is written", async () => {
  const { page, asAisyah } = await fixture();
  // Whitespace only. A `length === 0` check would let this through and publish a blank page.
  await db.pageDraft.update({
    where: { pageId: page.id },
    data: { markdown: "   \n\n\t  " },
  });

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.field).toBe("markdown");
  expect(error.code).toBe("draft-empty");
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * Task 5 allows an empty title at autosave deliberately, so an editor clearing the field to
 * retype it does not have saving start failing mid-keystroke. Publish is where that stops.
 *
 * Kills a publish that lets a blank title through (a page with a blank nav entry and a blank
 * breadcrumb) and kills one that lets it reach Postgres as an unhandled failure.
 */
test("a whitespace-only title is a field error on publish, not a 500", async () => {
  const { page, asAisyah } = await fixture();
  // Through the real autosave path, to prove the endpoint really does accept it.
  const saved = await saveDraft(asAisyah, page.id, {
    title: "   ",
    markdown: "Body is fine.\n",
    seen: (await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } })).updatedAt,
  });
  expect(saved.ok).toBe(true);

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.field).toBe("title");
  expect(error.code).toBe("title-empty");
  expect(error.message).toMatch(/title/i);
  expect(await snapshot(page.id)).toEqual(before);
});

test("a title of nothing but control characters is empty too", async () => {
  const { page, asAisyah } = await fixture();
  // Escape sequences, never literals: a literal control character is invisible in a diff,
  // and this project has already had a shell command rejected for carrying one.
  await db.pageDraft.update({
    where: { pageId: page.id },
    data: { title: "\u0001\u0002 \u001f" },
  });

  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("title-empty");
});

test("a publishable title is stripped and trimmed on both the page and the version", async () => {
  const { page, asAisyah } = await fixture();
  await db.pageDraft.update({
    where: { pageId: page.id },
    data: { title: "  MQTT\u0007 contracts  " },
  });

  const result = published(await publishPage(asAisyah, page.id));
  expect(result.title).toBe("MQTT contracts");

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.title).toBe("MQTT contracts");
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.title).toBe("MQTT contracts");
});

/**
 * The markdown is stored exactly as the draft held it — the asymmetry with the title above
 * is deliberate. The preview pane rendered these bytes through `renderMarkdown`; trimming or
 * normalising them here would publish something the approved preview never showed.
 */
test("the published markdown is byte-identical to the draft, trailing blank lines included", async () => {
  const { page, asAisyah } = await fixture();
  const markdown = "\n# Heading\n\n    indented code\n\n\n";
  await db.pageDraft.update({ where: { pageId: page.id }, data: { markdown } });

  const result = published(await publishPage(asAisyah, page.id));
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.markdown).toBe(markdown);
});

test("publishing twice in a row fails cleanly rather than writing an empty version", async () => {
  const { page, asAisyah } = await fixture();
  published(await publishPage(asAisyah, page.id));

  const before = await snapshot(page.id);
  expect(before.draft).toBeNull();

  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.field).toBe("markdown");
  expect(error.code).toBe("no-draft");
  expect(error.message).toMatch(/nothing to publish/i);

  expect(await snapshot(page.id)).toEqual(before);
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(1);
});

test("republishing a CURRENT page keeps its status and moves the pointer to the new version", async () => {
  const { page, asAisyah } = await fixture();
  const first = published(await publishPage(asAisyah, page.id));

  await saveDraft(asAisyah, page.id, {
    title: "MQTT contracts, revised",
    markdown: "Every topic is namespaced by outlet and by pump.\n",
    seen: null,
  });
  const second = published(await publishPage(asAisyah, page.id));

  expect(second.versionId).not.toBe(first.versionId);
  expect(second.status).toBe("CURRENT");

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBe(second.versionId);
  expect(row.title).toBe("MQTT contracts, revised");
  // The first version is kept — history, not garbage.
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(2);

  const read = await getPublishedPage(asAisyah, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(read?.version.markdown).toBe("Every topic is namespaced by outlet and by pump.\n");
});

test("a VIEWER cannot publish, and nothing is written", async () => {
  const { space, page, aisyah, asViewer } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: aisyah.id } },
    data: { role: "VIEWER" },
  });

  const before = await snapshot(page.id);
  expect(await publishPage(asViewer, page.id)).toEqual({ ok: false, reason: "forbidden" });
  expect(await snapshot(page.id)).toEqual(before);
});

test("a non-member gets not-found, not forbidden, and cannot learn the page exists", async () => {
  const { page } = await fixture();
  expect(await publishPage(stranger, page.id)).toEqual({ ok: false, reason: "not-found" });
});

test("a page id that never existed gets the same answer as an unreadable one", async () => {
  const { asAisyah } = await fixture();
  expect(await publishPage(asAisyah, "page-that-never-existed")).toEqual({
    ok: false,
    reason: "not-found",
  });
});

/**
 * Soft-delete coverage for this module, as `src/lib/pages/visible.test.ts` requires. Two
 * queries here carry the filter — the authorisation read and the write predicate on the page
 * update — and this covers the first; the staged race below covers the second.
 */
test("a soft-deleted page cannot be published, and reads as not-found", async () => {
  const { page, asAisyah } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  const before = await snapshot(page.id);
  expect(await publishPage(asAisyah, page.id)).toEqual({ ok: false, reason: "not-found" });
  expect(await snapshot(page.id)).toEqual(before);
});

test("a super admin's publish is not also a soft-delete bypass", async () => {
  const { page } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  const superAdmin: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

  // The permission predicate and the soft-delete predicate are independent, and the one
  // viewer who skips the first must not skip the second.
  expect(await publishPage(superAdmin, page.id)).toEqual({ ok: false, reason: "not-found" });
});

/**
 * ## The concurrency tests
 *
 * Publish takes a row lock on the `PageDraft` row rather than the space-wide advisory lock
 * Tasks 6 and 10 take, because it does not touch `Page.path` and so shares no resource with
 * a create or a move. What it does share is the draft, with another publish and with every
 * autosave — and both of those are keyed by `pageId`.
 *
 * All three of the tests below **block**. A `Promise.all` race on this project is not a test
 * of a write predicate or a lock: it staggers on a real connection pool, and it was measured
 * passing three runs out of three with Task 4's atomicity guarantee deleted. The one
 * `Promise.all` test here is kept for the outcome contract and is labelled as such.
 *
 * The waits stage the interleaving and nothing is asserted about them. A wait that is too
 * short only makes a test agree with the outcome test; it can never make a broken
 * implementation pass.
 */

/**
 * Publish versus publish. The second publish's locking read is held behind the first's
 * uncommitted `DELETE`, so when it unblocks Postgres re-evaluates it against the new row
 * version and finds nothing.
 *
 * Kills a publish whose draft read is a plain `findUnique`: under MVCC that read returns the
 * pre-delete row, and the second publish inserts a second identical `PageVersion` that
 * nothing points at and that shows up in the page's history as a publish nobody performed.
 */
test("a publish whose draft is deleted out from under it writes no version", async () => {
  const { page, asAisyah } = await fixture();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Raw, because this has to hold an uncommitted DELETE open — an interactive transaction is
  // the only way to sit between another publisher's DELETE and its COMMIT.
  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`DELETE FROM "PageDraft" WHERE "pageId" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the DELETE above has taken the row lock
  const racing = publishPage(asAisyah, page.id);
  await settle(); // `racing` is now blocked on the same row

  release();
  await other;
  const result = await racing;

  const error = rejection(result);
  expect(error.code).toBe("no-draft");
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(0);
  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBeNull();
  expect(row.status).toBe("DRAFT");
});

/**
 * Publish versus autosave, which is the interleaving that loses work. An autosave commits
 * while the publish is waiting; the publish must then publish the NEWER text, because the
 * draft it is about to delete is the newer one.
 *
 * Kills the same mutation from the other direction, and this is the one that hurts: without
 * the lock the publish reads the pre-autosave text under MVCC, publishes it, and then deletes
 * the draft that held the newer text — which the editor was told two seconds earlier had been
 * saved. Nothing anywhere else would notice.
 */
test("an autosave that commits while a publish waits is what gets published", async () => {
  const { page, asAisyah, budi } = await fixture();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "PageDraft"
           SET "markdown" = 'The paragraph Budi typed last.', "updatedById" = ${budi.id},
               "updatedAt" = now()
         WHERE "pageId" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the UPDATE above has taken the row lock
  const racing = publishPage(asAisyah, page.id);
  await settle(); // `racing` is blocked on the same row, before it has read a word of it

  release();
  await other;
  const result = published(await racing);

  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.markdown).toBe("The paragraph Budi typed last.");
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(1);

  // And through the reader, which is the only place it matters.
  const read = await getPublishedPage(asAisyah, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(read?.version.markdown).toBe("The paragraph Budi typed last.");
});

/**
 * The mid-write abort, and the only test in this file that proves the `$transaction` itself
 * is all-or-nothing: everything else is refused before a row is written, which a function
 * with no transaction at all would also pass.
 *
 * A soft delete commits while the publish is between its `PageVersion` insert and its page
 * update. The update carries `visiblePage()`, so it matches nothing, and the whole
 * transaction rolls back — version included.
 *
 * Kills dropping `visiblePage()` from that update's predicate: the publish would then set
 * `publishedVersionId` and `publishedAt` on a deleted page, leaving a row that Task 12
 * promises is invisible holding a live pointer for Task 12's restore to hand straight back
 * to readers.
 */
test("a soft delete landing mid-publish rolls the whole transaction back", async () => {
  const { page, asAisyah } = await fixture();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the UPDATE above holds the Page row lock, and nothing else
  // The publish takes the DRAFT lock (uncontended), reads a page that still looks live under
  // MVCC, inserts its version, and then blocks on the Page row.
  const racing = publishPage(asAisyah, page.id);
  await settle();

  release();
  await other;

  expect(await racing).toEqual({ ok: false, reason: "not-found" });

  // The version insert is gone with the rollback. This is the assertion a half-committing
  // implementation fails.
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(0);
  expect(await db.auditLog.count({ where: { pageId: page.id } })).toBe(0);
  expect(await db.pageDraft.findUnique({ where: { pageId: page.id } })).not.toBeNull();
  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBeNull();
  expect(row.publishedAt).toBeNull();
  expect(row.status).toBe("DRAFT");
});

/**
 * The outcome contract, not the mechanism. Kept for the same reason Task 4 kept its
 * `Promise.all` test and labelled it: it pins what a user sees when two people click Publish
 * together, and it cannot be trusted to exercise the lock — the two calls stagger on a real
 * connection pool.
 */
test("two concurrent publishes produce exactly one version", async () => {
  const { page, asAisyah, asBudi } = await fixture();

  const results = await Promise.all([
    publishPage(asAisyah, page.id),
    publishPage(asBudi, page.id),
  ]);

  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const loser = results.find((r) => !r.ok)!;
  if (loser.ok || loser.reason !== "invalid") throw new Error("expected a field error");
  expect(loser.error.code).toBe("no-draft");

  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(1);
  expect(await db.auditLog.count({ where: { pageId: page.id } })).toBe(1);
  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.publishedVersionId).toBe(published(results.find((r) => r.ok)!).versionId);
});
