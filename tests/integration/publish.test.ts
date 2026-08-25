import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage, type PublishResult } from "@/lib/pages/publish";
import { saveDraft } from "@/lib/drafts/repo";
import { getPublishedPage } from "@/lib/pages/repo";
import { movePage } from "@/lib/pages/move";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import type { DocStatus, DocType } from "@prisma/client";
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
    // Task 7. The rows themselves, `createdAt` included, and not a count: a count agrees with
    // a transaction that deleted a relation and reinserted it, which is the churn the
    // idempotence test below refuses, and it cannot tell a row pointing at the right page from
    // one pointing at the wrong one.
    relations: await db.pageRelation.findMany({
      where: { fromId: pageId },
      select: { id: true, toId: true, type: true, createdAt: true },
      orderBy: [{ type: "asc" }, { toId: "asc" }],
    }),
  };
}

/** Waits are only ever used to stage an interleaving; nothing is asserted about them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * Another page in the same space, for a relation to point at.
 *
 * Root-level, so its `path` is its `slug` and a test can write that path into frontmatter
 * verbatim rather than assembling it. Every field is still distinguishable — the title is never
 * the slug — so a resolution that read `slug` where it meant `path` fails here.
 */
async function otherPage(args: {
  spaceId: string;
  createdById: string;
  slug: string;
  title: string;
  docType?: DocType;
  status?: DocStatus;
}) {
  return db.page.create({
    data: {
      spaceId: args.spaceId,
      slug: args.slug,
      path: args.slug,
      title: args.title,
      docType: args.docType ?? "DOC",
      status: args.status ?? "CURRENT",
      createdById: args.createdById,
    },
    select: { id: true, path: true, title: true },
  });
}

/** A document opening on `yaml` as its frontmatter block. `null` for no frontmatter at all. */
const document = (yaml: string | null): string =>
  yaml === null
    ? "# Topics\n\nEvery topic is namespaced by outlet.\n"
    : `---\n${yaml}\n---\n\n# Topics\n\nEvery topic is namespaced by outlet.\n`;

/** Rewrites the draft the fixture already created. Returns the markdown, for comparison. */
async function declaring(pageId: string, yaml: string | null): Promise<string> {
  const markdown = document(yaml);
  await db.pageDraft.update({ where: { pageId }, data: { markdown } });
  return markdown;
}

/**
 * A fresh draft after a publish took the last one, so a republish has something to publish.
 *
 * Through `saveDraft` rather than `db.pageDraft.create`, because that is the path an author
 * takes: `seen: null` against a page whose draft a publish deleted is `decideSave`'s `create`
 * branch, and if it ever stopped being one these tests would be republishing rows the product
 * cannot produce.
 */
async function redeclaring(viewer: Viewer, pageId: string, yaml: string | null): Promise<string> {
  const markdown = document(yaml);
  const saved = await saveDraft(viewer, pageId, {
    title: "MQTT contracts",
    markdown,
    seen: null,
  });
  if (!saved.ok) throw new Error(`expected a fresh draft, got ${JSON.stringify(saved)}`);
  return markdown;
}

/** The relation rows leaving a page, as `type → target path` pairs. */
async function relationsOf(pageId: string) {
  const rows = await db.pageRelation.findMany({
    where: { fromId: pageId },
    select: { type: true, to: { select: { path: true } } },
    orderBy: [{ type: "asc" }, { toId: "asc" }],
  });
  return rows.map((row) => `${row.type} ${row.to.path}`);
}

/** Every `page.cascade` row about this page, oldest first. */
async function cascadeAudits(pageId: string) {
  return db.auditLog.findMany({
    where: { pageId, action: "page.cascade" },
    orderBy: { createdAt: "asc" },
    select: { actorId: true, action: true, spaceId: true, pageId: true, detail: true },
  });
}

/** The one `page.publish` row this page's latest publish wrote. */
async function lastPublishAudit(pageId: string) {
  const rows = await db.auditLog.findMany({
    where: { pageId, action: "page.publish" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const row = rows[0];
  if (row === undefined) throw new Error(`no page.publish audit row for ${pageId}`);
  return row;
}

const statusOf = async (pageId: string) =>
  (await db.page.findUniqueOrThrow({ where: { id: pageId }, select: { status: true } })).status;

/**
 * Whether some other transaction is holding an exclusive lock on this page row **right now**.
 *
 * The only way to observe a lock a running publish is holding, and the whole mechanism behind
 * the two lock-ordering tests below. A short `lock_timeout` turns "somebody else has it" into a
 * failed statement instead of a hang, and the error is matched rather than swallowed — a bare
 * `catch` would report a typo in the SQL as a held lock and pass for the wrong reason.
 */
async function lockedByAnother(pageId: string): Promise<boolean> {
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '400ms'");
        await tx.$queryRaw`SELECT "id" FROM "Page" WHERE "id" = ${pageId} FOR UPDATE`;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/lock timeout/i.test(message)) throw error;
    return true;
  }
}

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
    fromStatus: "DRAFT",
    toStatus: "CURRENT",
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
 * The other direction of publish-versus-autosave, and the one `publishPage`'s docstring
 * makes a claim about: an autosave already in flight when the publish commits.
 *
 * `saveDraft` reads the pre-delete row under MVCC, decides `update` on a timestamp that is
 * about to stop being true, and blocks on its own `UPDATE`. When the publish commits, that
 * predicate is re-evaluated against a row that no longer exists, so it matches nothing — and
 * the save comes back as the 409 with `theirs: null` that Task 5's route and Task 7's banner
 * were both written for. Nothing is resurrected.
 *
 * The publish is staged as its bare effect (an uncommitted `DELETE`) because `publishPage`
 * owns its own transaction and there is no way to pause inside it. What is being tested is
 * `saveDraft`'s behaviour when a publish lands underneath it, which this reproduces exactly.
 */
test("an autosave in flight when a publish commits is refused, not resurrected", async () => {
  const { page, asAisyah, asBudi } = await fixture();
  const opened = await saveDraft(asBudi, page.id, {
    title: "MQTT contracts",
    markdown: "Budi's work in progress.\n",
    seen: (await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } })).updatedAt,
  });
  if (!opened.ok) throw new Error("expected the setup save to succeed");

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publishing = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`DELETE FROM "PageDraft" WHERE "pageId" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the DELETE has taken the row lock
  const racing = saveDraft(asBudi, page.id, {
    title: "MQTT contracts",
    markdown: "One more paragraph, typed as the publish landed.\n",
    seen: opened.draft.updatedAt,
  });
  await settle(); // `racing` read the old row, decided update, and is now blocked

  release();
  await publishing;
  const result = await racing;

  expect(result.ok).toBe(false);
  if (result.ok || result.reason !== "conflict") {
    throw new Error(`expected a conflict, got ${JSON.stringify(result)}`);
  }
  // No other draft to offer, which is what the banner's one-action branch keys off.
  expect(result.theirs).toBeNull();
  expect(result.mine.markdown).toBe("One more paragraph, typed as the publish landed.\n");
  // And nothing was written: the row stays gone.
  expect(await db.pageDraft.findUnique({ where: { pageId: page.id } })).toBeNull();
  // Publishing afterwards is still refused for having no draft, not silently accepted.
  expect(rejection(await publishPage(asAisyah, page.id)).code).toBe("no-draft");
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

/**
 * ## Frontmatter and relations — spec §9 steps 1 and 4
 *
 * Four modules meet here for the first time: `splitFrontmatter` finds the block,
 * `validateFrontmatter` decides what the doc type accepts, `resolveRelations` turns paths into
 * page ids, and `checkRelations` decides whether the resulting edges are legal. Each is tested
 * on its own; what only this file can test is the composition — that the value stored is the
 * validated one, that the rows written are the declared ones, that the rows *not* declared are
 * gone, and that a refusal from any of the four leaves the database exactly as it was.
 */

/**
 * Task 1 Step 2's assertion, and the reason it is worth an assertion: **the draft holds what
 * the author typed and the version holds what validation accepted, and they are not the same
 * value.** Three normalisations make them differ, and all three are visible here — a scalar
 * becomes a one-element list, an unfilled template key becomes `[]` rather than `null`, and the
 * `relations` map carries all four types whether or not this doc type can declare them.
 *
 * Kills leaving `frontmatter` at its `{}` default: the version would carry no record of what
 * the author declared, Phase 5's git mirror would have nothing to write back out, and Phase 6
 * would have no `systems:` to migrate.
 *
 * Kills storing `split.frontmatter` — the raw parse — instead: `supersedes` would be a string,
 * the empty keys would be `null`, and every consumer would have to re-derive the arity.
 */
test("the version stores validated frontmatter, which is not what the draft held", async () => {
  const { space, page, aisyah, asAisyah, parent } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  const markdown = await declaring(
    page.id,
    [
      "status: ACCEPTED",
      "systems: order-hub",
      `supersedes: ${superseded.path}`,
      `related: ${parent.path}`,
      "amends:",
      "decides:",
    ].join("\n"),
  );

  const result = published(await publishPage(asAisyah, page.id));
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });

  expect(version.frontmatter).toEqual({
    status: "ACCEPTED",
    systems: ["order-hub"],
    relations: {
      SUPERSEDES: ["adr-0030-topic-layout"],
      DECIDES: [],
      AMENDS: [],
      RELATES_TO: ["architecture"],
    },
  });

  // The other half of the claim: what the author typed, parsed, is a different value. Read
  // through `splitFrontmatter` rather than compared against a hand-written literal, so this
  // stays true if the parser's own shape changes.
  const typed = splitFrontmatter(markdown);
  if (!typed.ok) throw new Error("the fixture's own frontmatter must parse");
  expect(version.frontmatter).not.toEqual(typed.frontmatter);
  expect(typed.frontmatter).toMatchObject({
    supersedes: "adr-0030-topic-layout", // a scalar there, a list on the version
    amends: null, // an unfilled template key; `[]` on the version
  });
  expect(typed.frontmatter).not.toHaveProperty("relations");
});

/**
 * The frontmatter's `status:` is what the publish lands on — the third source `publishPage`
 * documents, and the one the author controls.
 *
 * Kills ignoring the key: the ADR would land at `PROPOSED` (its entry state) while the version
 * row it just wrote carried `status: ACCEPTED` in its frontmatter — the same status maintained
 * in two places, disagreeing, written by the one transaction that exists to stop that.
 */
test("a frontmatter status is what the page is published into", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  await declaring(page.id, "status: ACCEPTED");

  const result = published(await publishPage(asAisyah, page.id));
  expect(result.status).toBe("ACCEPTED");

  const row = await db.page.findUniqueOrThrow({ where: { id: page.id } });
  expect(row.status).toBe("ACCEPTED");
  // Not `PROPOSED`, which is where `FIRST_PUBLISH.ADR` would have put it.
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.status).toBe("ACCEPTED");
});

/**
 * The precedence, pinned because it is a choice rather than a fact: an explicit `options.status`
 * outranks the frontmatter. No product caller passes one — the route reads no body — so this is
 * about tests, the seed and the e2e helper, and Task 11 should write the frontmatter rather than
 * pass this option if it offers a status picker.
 */
test("an explicit status option outranks the frontmatter's", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  await declaring(page.id, "status: PROPOSED");

  const result = published(await publishPage(asAisyah, page.id, { status: "ACCEPTED" }));
  expect(result.status).toBe("ACCEPTED");
});

/**
 * Membership and reachability are two questions and both are asked. `SUPERSEDED` is in the
 * ADR's vocabulary, so Task 3's schema accepts the key; it is not reachable from `DRAFT`, so
 * `validateTransition` refuses the publish. The author hears about the transition, which is the
 * accurate sentence.
 *
 * Kills a schema that validated the status against a hardcoded list, and kills a publish that
 * took the frontmatter's status without running it past the transition table.
 */
test("a status the vocabulary cannot reach from here is an illegal transition, and writes nothing", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  await declaring(page.id, "status: SUPERSEDED");

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.field).toBe("status");
  expect(error.code).toBe("illegal-transition");
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * The declared relations become rows, against the **resolved page ids**.
 *
 * Kills leaving the §9 step 4 TODO in place, and kills storing the path the author wrote: the
 * `toId` is asserted against the target's own row id, and the redirect test below is the case
 * where the path and the resolved page disagree.
 */
test("publishing writes the relations the frontmatter declares", async () => {
  const { space, page, aisyah, asAisyah, parent } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(
    page.id,
    ["status: ACCEPTED", `supersedes: ${superseded.path}`, `related: ${parent.path}`].join("\n"),
  );
  published(await publishPage(asAisyah, page.id));

  const rows = await db.pageRelation.findMany({
    where: { fromId: page.id },
    select: { toId: true, type: true },
  });
  // Compared as `type → id` strings, sorted, so the assertion does not depend on the order
  // Postgres returns enum values in — and so a row pointing at the *other* declared page
  // fails rather than passing on a count.
  expect(rows.map((r) => `${r.type} ${r.toId}`).sort()).toEqual(
    [`SUPERSEDES ${superseded.id}`, `RELATES_TO ${parent.id}`].sort(),
  );

  // Stored one direction only (spec §6.2): no reverse row, ever.
  expect(await db.pageRelation.count({ where: { fromId: superseded.id } })).toBe(0);
});

/**
 * **Removal is the half that gets forgotten.** An author who deletes `supersedes:` and
 * republishes is saying the relation was wrong; leaving the row would make the frontmatter and
 * the database disagree with no way to tell which is right — and the database is what Task 9's
 * banner reads, so the retired page would go on naming a replacement the document no longer
 * mentions.
 *
 * Kills an implementation that only inserts. It is the single most likely omission in this task
 * and the suite is otherwise completely silent about it: every other assertion passes.
 */
test("republishing without a relation deletes the row", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  expect(await relationsOf(page.id)).toEqual(["SUPERSEDES adr-0030-topic-layout"]);

  // The author decides the supersede was wrong and takes the key out entirely.
  await redeclaring(asAisyah, page.id, "status: ACCEPTED");
  published(await publishPage(asAisyah, page.id));

  expect(await relationsOf(page.id)).toEqual([]);
  expect(await db.pageRelation.count()).toBe(0);
});

/**
 * Idempotence, and specifically **without churn**. The row must survive republishing rather
 * than be deleted and reinserted: `createdAt` is when the relation was first asserted, and Task
 * 9's banner shows that date on the retired page.
 *
 * The timestamp is backdated between the two publishes so the assertion cannot pass by the two
 * writes landing in the same millisecond — the same lesson as "compare a stored timestamp
 * against the real clock, not against another copy of itself".
 *
 * Kills a delete-all-then-insert-all implementation, which passes every row-count assertion in
 * this file.
 */
test("republishing unchanged relations touches neither the row nor its createdAt", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  const yaml = ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n");
  await declaring(page.id, yaml);
  published(await publishPage(asAisyah, page.id));

  const first = await db.pageRelation.findFirstOrThrow({ where: { fromId: page.id } });
  const asserted = new Date("2026-08-01T09:00:00Z");
  await db.pageRelation.update({ where: { id: first.id }, data: { createdAt: asserted } });

  await redeclaring(asAisyah, page.id, yaml);
  published(await publishPage(asAisyah, page.id));

  const rows = await db.pageRelation.findMany({ where: { fromId: page.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(first.id);
  expect(rows[0]?.createdAt).toEqual(asserted);
});

/**
 * The `fromId` on the delete, which is the difference between "replace this page's relations"
 * and "empty the table".
 *
 * Kills a `deleteMany` whose `where` is only the `NOT`: the other ADR's relation — declared by
 * a different author, in a different publish — would disappear, and nothing else in this file
 * would notice.
 */
test("replacing one page's relations leaves another page's alone", async () => {
  const { space, page, aisyah, asAisyah, parent } = await fixture({ docType: "ADR" });
  const other = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0029-outlet-ids",
    title: "ADR-0029 Outlet ids",
    docType: "ADR",
    status: "ACCEPTED",
  });
  // A relation this publish knows nothing about, written by a publish of a different page.
  await db.pageRelation.create({
    data: { fromId: other.id, toId: parent.id, type: "RELATES_TO" },
  });

  await declaring(page.id, ["status: ACCEPTED", `related: ${parent.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  await redeclaring(asAisyah, page.id, "status: ACCEPTED");
  published(await publishPage(asAisyah, page.id));

  expect(await relationsOf(page.id)).toEqual([]);
  expect(await relationsOf(other.id)).toEqual(["RELATES_TO architecture"]);
});

/**
 * The property Task 5's design was chosen for, end to end for the first time: the page moved
 * *after* the frontmatter was written, and the relation is stored against where it is **now**.
 *
 * This is the whole argument for resolving to a page id rather than storing the path — and
 * nothing tested it through a publish. `movePage` writes the redirect, so the reference the
 * author wrote a month ago still lands.
 *
 * Kills a resolution that only looks at live paths (the publish would be refused as
 * `not-found`), and kills storing the reference text (the row would name a path no page holds).
 */
test("a relation whose target moved resolves through the redirect to the page it is now", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  // The author writes the frontmatter naming the path as it stands today...
  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));

  // ...and someone moves the target before the publish happens.
  const moved = await movePage(asAisyah, target.id, {
    newParentId: null,
    newSlug: "adr-0030-topic-layout-superseded",
  });
  if (!moved.ok) throw new Error(`expected the move to succeed: ${JSON.stringify(moved)}`);

  published(await publishPage(asAisyah, page.id));

  // The row names the page, at its new path. Not the path the author wrote.
  expect(await relationsOf(page.id)).toEqual([
    "SUPERSEDES adr-0030-topic-layout-superseded",
  ]);
  const row = await db.pageRelation.findFirstOrThrow({ where: { fromId: page.id } });
  expect(row.toId).toBe(target.id);
});

/**
 * Two references that resolve to the same page — the pre-move path and the current one — are one
 * relation. `resolveRelations` deliberately does not deduplicate and says the upsert should;
 * this is that.
 *
 * Kills relying on `ON CONFLICT` to collapse duplicates inside a single `createMany`, which is
 * a Postgres subtlety rather than a property this code should depend on.
 */
test("two references to the same page produce one relation row", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "architecture-old",
    title: "Architecture, before the move",
  });
  const moved = await movePage(asAisyah, target.id, {
    newParentId: null,
    newSlug: "architecture-new",
  });
  if (!moved.ok) throw new Error(`expected the move to succeed: ${JSON.stringify(moved)}`);

  await declaring(page.id, "related: [architecture-old, architecture-new]");
  published(await publishPage(asAisyah, page.id));

  expect(await relationsOf(page.id)).toEqual(["RELATES_TO architecture-new"]);
});

/**
 * A frontmatter key the doc type does not accept refuses the publish and writes nothing — and
 * **every** error comes back, not the first.
 *
 * The snapshot is the assertion that matters. A test that only checked the message would pass
 * against a transaction that inserted the version and then failed, which is precisely what
 * validating frontmatter *after* the version insert would do.
 */
test("a mistyped frontmatter key is refused with every error, and nothing is written", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  await declaring(page.id, ["supersedez: decisions/adr-0031", "decidez: rfcs/rfc-0004"].join("\n"));

  const before = await snapshot(page.id);
  const result = await publishPage(asAisyah, page.id);
  if (result.ok || result.reason !== "invalid") {
    throw new Error(`expected a field error, got ${JSON.stringify(result)}`);
  }

  // Both keys, and the invariant that keeps the single-error surface honest.
  expect(result.errors).toHaveLength(2);
  expect(result.errors[0]).toBe(result.error);
  expect(result.errors.map((e) => e.key)).toEqual(["supersedez", "decidez"]);
  expect(result.errors.map((e) => e.code)).toEqual(["unknown-key", "unknown-key"]);
  // The key is what lets Task 11 point at the line; `field` alone can only underline the pane.
  expect(result.error.field).toBe("markdown");
  expect(result.error.message).toMatch(/supersedes/);

  expect(await snapshot(page.id)).toEqual(before);
});

test("frontmatter that is not valid YAML is refused, and nothing is written", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  // A tab where YAML forbids one, so this is a syntax error rather than a schema failure.
  await declaring(page.id, "status: ACCEPTED\n\tsupersedes: x");

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("frontmatter-unparseable");
  expect(error.key).toBeNull();
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * An unresolvable reference. The message is the shared `not-found` sentence — the same one an
 * unreadable target gets — and the publish writes nothing.
 */
test("a relation naming no page is refused, and nothing is written", async () => {
  const { page, asAisyah } = await fixture({ docType: "ADR" });
  await declaring(page.id, ["status: ACCEPTED", "supersedes: decisions/adr-0031"].join("\n"));

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("not-found");
  expect(error.key).toBe("supersedes");
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * The soft-delete test `src/lib/pages/visible.test.ts` names for the relation writes: a deleted
 * target never becomes a stored relation, because `resolveRelations` refuses it.
 *
 * Kills dropping `visiblePage()` from that resolution — the row would be written against a page
 * Task 12 promises is invisible, and Task 8's cascade would then set a status on it.
 */
test("a relation naming a soft-deleted page is refused, and the publish writes nothing", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });
  await db.page.update({ where: { id: target.id }, data: { deletedAt: new Date() } });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("deleted");
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * The other direction of the same absence, and the reason the delete deliberately carries no
 * soft-delete filter on its target: a page deleted *after* the relation was written must not
 * strand the row. If the delete filtered, the author could never bring the frontmatter and the
 * database back into agreement — the key is gone from the document and the row is unreachable.
 */
test("a relation to a page deleted afterwards can still be removed by republishing without it", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  expect(await relationsOf(page.id)).toHaveLength(1);

  await db.page.update({ where: { id: target.id }, data: { deletedAt: new Date() } });

  await redeclaring(asAisyah, page.id, "status: ACCEPTED");
  published(await publishPage(asAisyah, page.id));
  expect(await relationsOf(page.id)).toEqual([]);
});

/**
 * A guardrail refusal, through the publish rather than through `checkRelations` directly. An ADR
 * cannot supersede a doc — the cascade would ask for a `SUPERSEDED` that is in no other
 * vocabulary.
 */
test("an illegal relation is refused by the guardrail, and nothing is written", async () => {
  const { page, asAisyah, parent } = await fixture({ docType: "ADR" });
  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${parent.path}`].join("\n"));

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("not-same-doc-type");
  expect(error.key).toBe("supersedes");
  expect(await snapshot(page.id)).toEqual(before);
});

/**
 * The cycle, closed over rows **this task wrote**. Task 6's tests build the chain by hand; this
 * is the only place the walk runs over a graph the publish path itself produced, which is what
 * makes the two halves agree in practice rather than by construction.
 *
 * Kills a guardrail call the publish forgot to make, and kills walking the frontmatter instead
 * of the stored rows.
 *
 * **The first publish lands at `PROPOSED`, and Task 8 is why.** It was `ACCEPTED` until the
 * cascade existed, and then this test began failing as `illegal-transition` — correctly: the
 * accepted publish retires `other`, and a `SUPERSEDED` ADR cannot be published forward at all,
 * so the second publish was refused for its own transition before the cycle walk was reached.
 * That is the honest new shape of the product, and it is pinned by its own test below rather
 * than left as this one's surprise. Published at `PROPOSED` the relation row is still written
 * and no cascade fires (Task 6's `ACCEPTED` precondition), which is exactly the state Task 6's
 * docstring names as the reason the walk runs whether or not the cascade does: *"a cycle
 * admitted by a `PROPOSED` publish would already be stored by the time the accepting publish
 * refused it."*
 */
test("an ADR cannot supersede the ADR that already supersedes it, and nothing is written", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const other = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  // This page supersedes the other, published for real so the row is the product's own.
  await declaring(page.id, ["status: PROPOSED", `supersedes: ${other.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  // No cascade at PROPOSED, so `other` is still publishable and the loop is reachable.
  expect((await db.page.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("ACCEPTED");

  // Now the other one tries to supersede this one, which would close the loop.
  await db.pageDraft.create({
    data: {
      pageId: other.id,
      title: other.title,
      markdown: document(`status: ACCEPTED\nsupersedes: ${page.path}`),
      updatedById: aisyah.id,
    },
  });

  const before = await snapshot(other.id);
  const error = rejection(await publishPage(asAisyah, other.id));
  expect(error.code).toBe("supersede-cycle");
  expect(await snapshot(other.id)).toEqual(before);
  // And the edge that was already there is untouched.
  expect(await relationsOf(page.id)).toEqual(["SUPERSEDES adr-0030-topic-layout"]);
});

/**
 * ## The cascades — spec §9 step 5 and §6.3
 *
 * `checkRelations` decided *whether* each cascade is eligible and handed over a `cascade` status;
 * everything below is about what happens to the **other page**. Four things are tested and they
 * are four different mechanisms: the write, the `PUBLISHABLE_INTO` check on it, the audit row on
 * the far side, and the order the two rows are locked in.
 */

/**
 * The cascade, both sides of it, and both audit rows.
 *
 * Kills leaving the §9 step 5 TODO in place — which every other assertion in this file passes
 * against — and kills a cascade that writes the status without auditing the page it changed.
 */
test("publishing an accepted ADR retires the ADR it supersedes, and audits both sides", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n"));
  const result = published(await publishPage(asAisyah, page.id));

  // One action, both sides (§6.3): the row and the status, in the same transaction.
  expect(await relationsOf(page.id)).toEqual(["SUPERSEDES adr-0030-topic-layout"]);
  expect(await statusOf(superseded.id)).toBe("SUPERSEDED");
  // The publishing page landed where it asked to, and its own status is not the cascade's.
  expect(await statusOf(page.id)).toBe("ACCEPTED");

  // The far side's own audit row, keyed on the page that CHANGED — the whole reason it is a
  // separate action rather than a key in the publish row's detail.
  const cascades = await cascadeAudits(superseded.id);
  expect(cascades).toHaveLength(1);
  expect(cascades[0]).toMatchObject({
    action: "page.cascade",
    // The publisher: they did not edit this page, and they did cause this.
    actorId: aisyah.id,
    spaceId: space.id,
    pageId: superseded.id,
  });
  expect(cascades[0]!.detail).toEqual({
    path: "adr-0030-topic-layout",
    fromStatus: "ACCEPTED",
    toStatus: "SUPERSEDED",
    relation: "SUPERSEDES",
    byPageId: page.id,
    byPagePath: "architecture/mqtt-contracts",
    byVersionId: result.versionId,
  });

  // And the near side records what it did to other pages, so the join reads both ways.
  const publish = await lastPublishAudit(page.id);
  expect(publish.detail).toMatchObject({
    cascaded: [
      {
        pageId: superseded.id,
        path: "adr-0030-topic-layout",
        fromStatus: "ACCEPTED",
        toStatus: "SUPERSEDED",
        relation: "SUPERSEDES",
      },
    ],
    relations: { added: [{ type: "SUPERSEDES", toId: superseded.id }], removed: [] },
  });

  // The retired page keeps its published version: no version was authored for it, and inventing
  // one would put a revision in its history that nobody wrote.
  const retired = await db.page.findUniqueOrThrow({ where: { id: superseded.id } });
  expect(retired.publishedVersionId).toBeNull();
  expect(await db.pageVersion.count({ where: { pageId: superseded.id } })).toBe(0);
});

/**
 * The second cascade, which is a different status on a different vocabulary — so a cascade
 * hardcoded to `SUPERSEDED`, or one that reads the source's doc type instead of the target's,
 * fails here and nowhere else.
 */
test("an accepted ADR closes the RFC it decides", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const rfc = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "rfc-0004-topic-naming",
    title: "RFC-0004 Topic naming",
    docType: "RFC",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `decides: ${rfc.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));

  expect(await statusOf(rfc.id)).toBe("CLOSED");
  const cascades = await cascadeAudits(rfc.id);
  expect(cascades).toHaveLength(1);
  expect(cascades[0]!.detail).toMatchObject({
    fromStatus: "ACCEPTED",
    toStatus: "CLOSED",
    relation: "DECIDES",
  });
});

/**
 * Task 6's `ACCEPTED` precondition, seen from the far side: the relation is written at
 * `PROPOSED` and nothing is retired. A proposal that says what it *would* replace is exactly
 * what a reviewer needs, and the consequence waits for the publish that accepts it.
 *
 * Kills a cascade that fires off the relation type alone and ignores `CheckedRelation.cascade`.
 */
test("a proposed ADR writes the relation and retires nothing", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: PROPOSED", `supersedes: ${target.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));

  expect(await relationsOf(page.id)).toEqual(["SUPERSEDES adr-0030-topic-layout"]);
  expect(await statusOf(target.id)).toBe("ACCEPTED");
  expect(await db.auditLog.count({ where: { action: "page.cascade" } })).toBe(0);
  expect((await lastPublishAudit(page.id)).detail).toMatchObject({ cascaded: [] });

  // And then the accepting publish is the one that retires it.
  await redeclaring(asAisyah, page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  expect(await statusOf(target.id)).toBe("SUPERSEDED");
  expect(await cascadeAudits(target.id)).toHaveLength(1);
});

/**
 * **Task 8's first decision, and the case Task 6 deliberately did not answer.** An ADR at
 * `PROPOSED` cannot reach `SUPERSEDED` — `PUBLISHABLE_INTO` says so — and this is the choice
 * between refusing the publish and skipping the cascade. It refuses, and the argument is at
 * `planCascades`: a skipped cascade would leave a `SUPERSEDES` row from an `ACCEPTED` ADR over a
 * target that is not retired, which is the divergence §6.3 exists to prevent, and it would be
 * lost rather than deferred because nothing re-runs a cascade later.
 *
 * The snapshot is the assertion that matters, on **both** pages: a refusal decided after the
 * version insert could only abort by throwing, and this proves it is decided before.
 *
 * Kills dropping the `PUBLISHABLE_INTO` check on the cascade — the publish would succeed and set
 * `SUPERSEDED` on a page whose vocabulary cannot hold it — and kills validating it after any
 * write.
 */
test("a cascade the target's vocabulary forbids refuses the publish, and writes nothing", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const proposal = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "PROPOSED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${proposal.path}`].join("\n"));

  const before = await snapshot(page.id);
  const beforeTarget = await snapshot(proposal.id);

  const error = rejection(await publishPage(asAisyah, page.id));
  expect(error.code).toBe("cascade-illegal-transition");
  // The frontmatter line, not the status control: the fault is in `supersedes:`, and the status
  // box belongs to the page being published.
  expect(error.field).toBe("markdown");
  expect(error.key).toBe("supersedes");
  expect(error.message).toContain("PROPOSED");
  expect(error.message).toContain("SUPERSEDED");
  expect(error.message).toContain("related:");
  // "an ADR", not "a ADR". Shared with the guardrail's `article` rather than written again —
  // the first draft of this sentence got it wrong, which is what a third copy of a rule does.
  expect(error.message).toContain("an ADR");

  expect(await snapshot(page.id)).toEqual(before);
  expect(await snapshot(proposal.id)).toEqual(beforeTarget);
  expect(await statusOf(proposal.id)).toBe("PROPOSED");
  expect(await db.pageRelation.count()).toBe(0);
});

/** The same refusal for a target that was never published at all. `DRAFT` reaches nothing. */
test("an ADR that was never published cannot be superseded either", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const unpublished = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "DRAFT",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${unpublished.path}`].join("\n"));
  const before = await snapshot(page.id);
  expect(rejection(await publishPage(asAisyah, page.id)).code).toBe("cascade-illegal-transition");
  expect(await snapshot(page.id)).toEqual(before);
  expect(await statusOf(unpublished.id)).toBe("DRAFT");
});

/**
 * **The mirror of the test above, and the one that makes the refusal survivable.** A target
 * already at the cascade status is a no-op, not a transition — and asking
 * `PUBLISHABLE_INTO` about `SUPERSEDED → SUPERSEDED` would refuse it, because `SUPERSEDED` is
 * terminal. Without that branch, an ADR that ever superseded another could never be republished
 * again: fixing a typo in it would be refused for a cascade that had already happened.
 *
 * Kills validating the cascade unconditionally instead of skipping the no-op, and kills writing
 * a second audit row for a status that did not change.
 */
test("republishing an ADR whose supersede already fired is not refused, and cascades once", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  const yaml = ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n");
  await declaring(page.id, yaml);
  published(await publishPage(asAisyah, page.id));
  expect(await statusOf(superseded.id)).toBe("SUPERSEDED");

  // The typo fix. Same frontmatter, same relation, and the target is already retired.
  await redeclaring(asAisyah, page.id, yaml);
  published(await publishPage(asAisyah, page.id));

  expect(await statusOf(superseded.id)).toBe("SUPERSEDED");
  // Still one cascade row: the second publish changed nothing on the far side and says nothing.
  expect(await cascadeAudits(superseded.id)).toHaveLength(1);
  expect((await lastPublishAudit(page.id)).detail).toMatchObject({ cascaded: [] });
  // The relation row survived both publishes, so `createdAt` still says when it was asserted.
  expect(await db.pageRelation.count({ where: { fromId: page.id } })).toBe(1);
});

/**
 * A consequence of the cascade worth pinning rather than discovering: the page it retires can no
 * longer be published at all. `SUPERSEDED` has no row in `PUBLISHABLE_INTO`, so every
 * destination is refused — including itself.
 *
 * This is not a Task 8 rule; it is the transition table, and the cascade is what now routinely
 * puts pages into it. It is pinned here because it is what broke the supersede-cycle test above,
 * and because it sits against spec §6.4's *"remains editable by editors so it can be
 * annotated"* — the annotation can be drafted and cannot be published. Reported with this task
 * rather than resolved: whether a retired document may be republished into its own status is a
 * row in the vocabulary, and the vocabulary is §6.1's.
 */
test("a page retired by a cascade cannot be published forward", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));

  // Its author annotates it, which §6.4 promises they can.
  const saved = await saveDraft(asAisyah, superseded.id, {
    title: superseded.title,
    markdown: "Superseded by the MQTT contracts ADR. Kept for the argument in section 3.\n",
    seen: null,
  });
  expect(saved.ok).toBe(true);

  const before = await snapshot(superseded.id);
  const error = rejection(await publishPage(asAisyah, superseded.id));
  expect(error.code).toBe("illegal-transition");
  expect(error.message).toContain("SUPERSEDED");
  expect(await snapshot(superseded.id)).toEqual(before);
});

/**
 * **Task 8's second decision, from the side that could leak.** The cascade requires no
 * permission check of its own, and the reason it is safe is that a relation cannot cross a
 * space: resolution refuses an absolute reference syntactically and scopes every one of its
 * queries to the source's `spaceId`. So the same-path page in another space is not found, is
 * refused with the shared `not-found` sentence, and is not touched.
 *
 * The other space is `ALL_STAFF` **on purpose**, so the viewer really can read it — otherwise
 * the permission predicate would hide the bug this test exists to catch, and the test would pass
 * against a resolution with no space scoping at all. Inject the hostile case; do not hope the
 * fixture contains it.
 *
 * Kills dropping `spaceId` from `findLive`: the reference would resolve to the other space's ADR
 * and the cascade would retire a page in a space this publish has no authority over.
 */
test("a relation naming a page in another space is refused, and that page is not cascaded", async () => {
  const { page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  const elsewhere = await otherPage({
    spaceId: handbook.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout, in another space",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${elsewhere.path}`].join("\n"));

  const before = await snapshot(page.id);
  const error = rejection(await publishPage(asAisyah, page.id));
  // The same answer a path naming nothing gets. A cascade must never be a way to learn that a
  // page exists, and the refusal says nothing about the other space.
  expect(error.code).toBe("not-found");
  expect(error.message).not.toContain("handbook");

  expect(await snapshot(page.id)).toEqual(before);
  expect(await statusOf(elsewhere.id)).toBe("ACCEPTED");
  expect(await db.auditLog.count({ where: { pageId: elsewhere.id } })).toBe(0);
});

/**
 * **Task 8's second decision, from the side that must keep working.** The publisher holds
 * `PUBLISH` on the space and nothing more: they did not write the ADR they are retiring, they do
 * not own it, and the cascade fires anyway. That is the decision — no `EDIT` on the target, no
 * ownership, no approval — and it is what a shared decision log means.
 *
 * Kills adding an owner or author gate on the cascade, which is the plausible wrong answer to
 * "the publisher is changing another page's status".
 */
test("an editor retires a decision written and owned by somebody else", async () => {
  const { space, page, aisyah, budi, asAisyah } = await fixture({ docType: "ADR" });
  const theirs = await otherPage({
    spaceId: space.id,
    createdById: budi.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });
  await db.page.update({ where: { id: theirs.id }, data: { ownerId: budi.id } });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${theirs.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));

  expect(await statusOf(theirs.id)).toBe("SUPERSEDED");
  // Audited to the person who caused it, not to the page's owner.
  expect((await cascadeAudits(theirs.id))[0]).toMatchObject({ actorId: aisyah.id });
  expect(space.id).toBe((await db.page.findUniqueOrThrow({ where: { id: theirs.id } })).spaceId);
});

/**
 * **Task 8's fourth decision.** Dropping `supersedes:` deletes the row, and the audit trail says
 * so — with the edge, not with the reference that produced it. It also does **not** un-retire the
 * target, which is the reason the row is worth writing: without it, nothing anywhere would say
 * how a `SUPERSEDED` page with no incoming relation got that way.
 *
 * Kills leaving Task 7's removal unaudited, and kills recording only removals: the first
 * publish's row carries the addition.
 */
test("a removed relation is recorded on the publish that removed it", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const superseded = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${superseded.path}`].join("\n"));
  published(await publishPage(asAisyah, page.id));
  expect((await lastPublishAudit(page.id)).detail).toMatchObject({
    relations: { added: [{ type: "SUPERSEDES", toId: superseded.id }], removed: [] },
  });

  // The author decides the supersede was wrong and takes the key out.
  await redeclaring(asAisyah, page.id, "status: ACCEPTED");
  published(await publishPage(asAisyah, page.id));

  expect(await relationsOf(page.id)).toEqual([]);
  expect((await lastPublishAudit(page.id)).detail).toMatchObject({
    relations: { added: [], removed: [{ type: "SUPERSEDES", toId: superseded.id }] },
  });
  // Removing the relation does NOT un-retire the target — no phase has taken that decision, and
  // this row is now the only account of why it is retired.
  expect(await statusOf(superseded.id)).toBe("SUPERSEDED");
});

/**
 * ## The lock order — Task 8's third decision
 *
 * Ascending page id, **including the publishing page's own row**, because two ADRs superseding
 * each other concurrently want the same two rows and in opposite orders that is a deadlock.
 *
 * A `Promise.all` race does not test this, and on this project it has been measured passing
 * three runs out of three with an atomicity guarantee deleted. So both tests below stage the
 * interleaving: an adversary holds one row, the publish is started, and a third connection with
 * a short `lock_timeout` asks whether the publish is holding the **other** row while it waits.
 * That is the only observable that distinguishes "locked in ascending order" from "locked in
 * whatever order the code happens to write".
 *
 * The two tests are the two arrangements, and one alone proves nothing: with the target's id
 * lower the ascending rule means the target first, and with it higher the rule means this page's
 * own row first. Ids are set explicitly — `0-…` sorts below every cuid and `z-…` above every
 * cuid, under the `COLLATE "C"` byte order the statement asks for — because a test that relied
 * on cuid generation order would be a test of cuid generation order.
 */

/** The target's id sorts BELOW the publishing page's, so ascending order takes it first. */
test("the cascade locks a lower-id target before this page's own row", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await db.page.create({
    data: {
      id: "0-adr-0030-topic-layout",
      spaceId: space.id,
      slug: "adr-0030-topic-layout",
      path: "adr-0030-topic-layout",
      title: "ADR-0030 Topic layout",
      docType: "ADR",
      status: "ACCEPTED",
      createdById: aisyah.id,
    },
  });
  expect(target.id < page.id).toBe(true);

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The adversary holds this page's OWN row — the higher of the two.
  const other = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Page" WHERE "id" = ${page.id} FOR UPDATE`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle();
  const racing = publishPage(asAisyah, page.id);
  // Two settles: the publish takes the draft lock, reads the page, resolves and checks the
  // relations before it reaches the locking statement at all.
  await settle();
  await settle();

  // Locked the target and then blocked on this page's row. Reversed or absent, the publish would
  // be waiting on `page.id` without holding the target at all.
  //
  // Released in a `finally`, which PROGRESS records as a rule and this task re-measured while
  // mutation-testing the lock order: a failed assertion here otherwise leaks an uncommitted
  // transaction, the next `TRUNCATE` blocks on it, and the run reports hook timeouts that bury
  // the one real failure underneath them.
  try {
    expect(await lockedByAnother(target.id)).toBe(true);
  } finally {
    release();
    await other;
  }
  published(await racing);
  expect(await statusOf(target.id)).toBe("SUPERSEDED");
});

/** The target's id sorts ABOVE it, so ascending order takes this page's own row first. */
test("the cascade locks this page's own row before a higher-id target", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await db.page.create({
    data: {
      id: "z-adr-0030-topic-layout",
      spaceId: space.id,
      slug: "adr-0030-topic-layout",
      path: "adr-0030-topic-layout",
      title: "ADR-0030 Topic layout",
      docType: "ADR",
      status: "ACCEPTED",
      createdById: aisyah.id,
    },
  });
  expect(target.id > page.id).toBe(true);

  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // This time the adversary holds the TARGET — again the higher of the two.
  const other = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Page" WHERE "id" = ${target.id} FOR UPDATE`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle();
  const racing = publishPage(asAisyah, page.id);
  await settle();
  await settle();

  // This is the assertion that pins "including the publishing page's own row": with the own row
  // left out of the lock list, the publish's first lock attempt is the target, it blocks
  // immediately, and it holds nothing at all. Released in a `finally` for the reason the test
  // above gives.
  try {
    expect(await lockedByAnother(page.id)).toBe(true);
  } finally {
    release();
    await other;
  }
  published(await racing);
  expect(await statusOf(target.id)).toBe("SUPERSEDED");
});

/**
 * Atomicity across the cascade, staged: the target is soft-deleted while the publish waits for
 * its row lock. The locking read deliberately does not filter `deletedAt`, so it hands back the
 * row; the cascade's **write** carries `visiblePage()`, matches nothing, and the whole publish
 * rolls back — version, page pointer, draft, relation rows and both audit rows.
 *
 * This is the only test that proves the transaction is all-or-nothing *through* the cascade, and
 * it is the one that kills dropping `visiblePage()` from `applyCascade`: without it the publish
 * would succeed and set a status on a page Task 12 promises is invisible.
 */
test("a soft delete of the cascade target landing mid-publish rolls the whole publish back", async () => {
  const { space, page, aisyah, asAisyah } = await fixture({ docType: "ADR" });
  const target = await otherPage({
    spaceId: space.id,
    createdById: aisyah.id,
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "ACCEPTED",
  });
  await declaring(page.id, ["status: ACCEPTED", `supersedes: ${target.path}`].join("\n"));

  const before = await snapshot(page.id);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${target.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the UPDATE holds the target's row lock
  // The publish resolves the relation against a target that still looks live under MVCC, then
  // blocks on the locking statement.
  const racing = publishPage(asAisyah, page.id);
  await settle();
  await settle();

  release();
  await other;

  expect(await racing).toEqual({ ok: false, reason: "not-found" });

  // Nothing survived: this is the assertion a half-committing cascade fails.
  expect(await snapshot(page.id)).toEqual(before);
  expect(await db.pageRelation.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
  expect(await statusOf(target.id)).toBe("ACCEPTED");
});

/**
 * A page with no frontmatter at all publishes exactly as it did in Phase 2, and stores an empty
 * validated shape rather than nothing — every doc type's four relation keys, empty. That is what
 * makes "declared nothing" and "did not mention the key" the same value for the removal step.
 */
test("a document with no frontmatter publishes, and its version records that", async () => {
  const { page, asAisyah } = await fixture();
  await declaring(page.id, null);

  const result = published(await publishPage(asAisyah, page.id));
  const version = await db.pageVersion.findUniqueOrThrow({ where: { id: result.versionId } });
  expect(version.frontmatter).toEqual({
    status: null,
    systems: [],
    relations: { SUPERSEDES: [], DECIDES: [], AMENDS: [], RELATES_TO: [] },
  });
  expect(await relationsOf(page.id)).toEqual([]);
});
