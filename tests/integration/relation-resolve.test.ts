import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { resolveRelations } from "@/lib/lifecycle/resolve";
import type { RelationRefusal, RelationResolution } from "@/lib/lifecycle/resolve";
import { getPublishedPage } from "@/lib/pages/repo";
import { movePage } from "@/lib/pages/move";
import type { DocType, RelationType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Integration, against the real database, because every question this module answers is a
 * question about rows: whether a path names a page, whether a redirect leads anywhere, whether
 * a soft-deleted row is there, and — the one that matters most — whether the answer changes
 * for someone who cannot read the space. A stubbed client can be made to agree with any of
 * those, which is precisely why it would prove none of them.
 */

/** Every relation key empty. Tests override only the key under test. */
const NONE: Record<RelationType, string[]> = {
  SUPERSEDES: [],
  DECIDES: [],
  AMENDS: [],
  RELATES_TO: [],
};

const declares = (
  partial: Partial<Record<RelationType, string[]>>,
): Record<RelationType, string[]> => ({ ...NONE, ...partial });

/**
 * Two spaces, and a `decisions/` tree in the first.
 *
 * `handbook` exists so the cross-space tests can name a space that is real — and so the pair
 * of tests that name a real one and an imaginary one can show the refusal does not care.
 *
 * Every field is distinguishable — slug, path, title and docType all differ between the two
 * ADRs — so an implementation that returned the wrong row, or read `slug` where it meant
 * `path`, fails rather than passing by coincidence.
 */
async function fixture(visibility: "MEMBERS" | "ALL_STAFF") {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "EDITOR" },
  });

  const page = async (opts: {
    slug: string;
    parentId?: string | null;
    title: string;
    docType?: DocType;
    status?: "DRAFT" | "ACCEPTED" | "PROPOSED" | "CURRENT";
    publish?: boolean;
  }) => {
    const parent = opts.parentId ?? null;
    const parentPath = parent === null ? "" : `${(await pathOf(parent))}/`;
    const row = await db.page.create({
      data: {
        spaceId: space.id,
        parentId: parent,
        slug: opts.slug,
        path: `${parentPath}${opts.slug}`,
        title: opts.title,
        docType: opts.docType ?? "DOC",
        status: opts.status ?? "CURRENT",
        createdById: author.id,
      },
      select: { id: true, path: true },
    });
    if (opts.publish !== false) {
      const version = await db.pageVersion.create({
        data: {
          pageId: row.id,
          title: opts.title,
          markdown: `# ${opts.title}`,
          status: opts.status ?? "CURRENT",
          authorId: author.id,
        },
        select: { id: true },
      });
      await db.page.update({
        where: { id: row.id },
        data: { publishedVersionId: version.id, publishedAt: new Date("2026-08-20T09:00:00Z") },
      });
    }
    return row;
  };

  const decisions = await page({ slug: "decisions", title: "Decision log" });
  const platform = await page({ slug: "platform", title: "Platform group" });
  // The page doing the referencing: an ACCEPTED ADR under `decisions/`.
  const source = await page({
    slug: "adr-0031-mqtt-namespacing",
    parentId: decisions.id,
    title: "ADR-0031 MQTT namespacing",
    docType: "ADR",
    status: "ACCEPTED",
  });
  // The page being referenced: a different ADR, in a different status.
  const target = await page({
    slug: "adr-0030-topic-layout",
    parentId: decisions.id,
    title: "ADR-0030 Topic layout",
    docType: "ADR",
    status: "PROPOSED",
  });

  const editor: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "EDITOR" }],
  };

  return { author, space, decisions, platform, source, target, editor };
}

async function pathOf(pageId: string): Promise<string> {
  const row = await db.page.findUniqueOrThrow({
    where: { id: pageId },
    select: { path: true },
  });
  return row.path;
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** `resolveRelations` with the fixture's source page, so each test states only its references. */
function resolve(
  viewer: Viewer,
  source: { id: string; spaceId: string },
  relations: Partial<Record<RelationType, string[]>>,
): Promise<RelationResolution> {
  return resolveRelations(db, viewer, {
    source: { id: source.id, spaceId: source.spaceId, spaceKey: "engineering" },
    relations: declares(relations),
  });
}

/** Fails with the refusals rather than on a downstream `undefined`. */
function resolved(result: RelationResolution) {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.relations;
}

function refusals(result: RelationResolution): RelationRefusal[] {
  if (result.ok) throw new Error(`expected a refusal, resolved: ${JSON.stringify(result)}`);
  return result.errors;
}

const TARGET = "decisions/adr-0030-topic-layout";
const SOURCE = "decisions/adr-0031-mqtt-namespacing";

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

test("a space-relative path resolves to the page's id, doc type and status", async () => {
  const { space, source, target, editor } = await fixture("ALL_STAFF");

  const relations = resolved(
    await resolve(editor, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  expect(relations).toEqual([
    {
      type: "SUPERSEDES",
      ref: TARGET,
      // The three fields Task 6 needs to judge legality, and the path Task 9 will link.
      // `status` is `PROPOSED` and not the source's `ACCEPTED`, so a query that resolved the
      // wrong row cannot pass this.
      page: { id: target.id, path: TARGET, docType: "ADR", status: "PROPOSED" },
    },
  ]);
});

test("nothing declared resolves to nothing, rather than to a special case", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  // Task 7 removes relations the frontmatter no longer declares, so "declared none" has to
  // arrive as an empty list — not as an early return the caller must remember to handle.
  expect(await resolve(editor, { id: source.id, spaceId: space.id }, {})).toEqual({
    ok: true,
    relations: [],
  });
});

test("all four relation keys resolve, in a deterministic order", async () => {
  const { space, source, target, decisions, platform, editor } = await fixture("ALL_STAFF");

  const relations = resolved(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      {
        // Declared in the reverse of the order they should come back in, so the assertion
        // below is testing the module's order and not the input's.
        RELATES_TO: ["platform"],
        AMENDS: ["decisions"],
        DECIDES: [TARGET],
        SUPERSEDES: [TARGET],
      },
    ),
  );

  expect(relations.map((r) => r.type)).toEqual([
    "SUPERSEDES",
    "DECIDES",
    "AMENDS",
    "RELATES_TO",
  ]);
  expect(relations.map((r) => r.page.id)).toEqual([
    target.id,
    target.id,
    decisions.id,
    platform.id,
  ]);
});

/**
 * `DECIDES` from an ADR to an ADR, and `SUPERSEDES` to a page of another doc type, both
 * resolve here. That is not an omission — it is the boundary. Task 6 owns legality, and it can
 * only own it if this module hands it the doc types rather than pre-filtering them away.
 */
test("an illegal relation still resolves; legality is Task 6's question", async () => {
  const { space, source, platform, editor } = await fixture("ALL_STAFF");

  const relations = resolved(
    await resolve(editor, { id: source.id, spaceId: space.id }, { SUPERSEDES: ["platform"] }),
  );

  expect(relations[0]?.page).toEqual({
    id: platform.id,
    path: "platform",
    // A `DOC` under `SUPERSEDES`, which §6.3 forbids — reported faithfully, not refused.
    docType: "DOC",
    status: "CURRENT",
  });
});

test("an unpublished target resolves, carrying the status Task 6 will judge", async () => {
  const { space, source, decisions, author, editor } = await fixture("ALL_STAFF");
  const unpublished = await db.page.create({
    data: {
      spaceId: space.id,
      parentId: decisions.id,
      slug: "adr-0032-draft",
      path: "decisions/adr-0032-draft",
      title: "ADR-0032 (draft)",
      docType: "ADR",
      status: "DRAFT",
      createdById: author.id,
    },
    select: { id: true },
  });

  // The reader cannot see it — `getPublishedPage` requires a published version — and it still
  // resolves as a relation target. Not a leak: `listSpacePages` already shows unpublished
  // pages in the nav rail of everyone who can read the space.
  expect(
    await getPublishedPage(editor, {
      spaceKey: "engineering",
      path: "decisions/adr-0032-draft",
    }),
  ).toBeNull();

  const relations = resolved(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { AMENDS: ["decisions/adr-0032-draft"] },
    ),
  );
  expect(relations[0]?.page).toEqual({
    id: unpublished.id,
    path: "decisions/adr-0032-draft",
    docType: "ADR",
    status: "DRAFT",
  });
});

test("two references to the same page come back as two entries", async () => {
  const { space, source, target, editor } = await fixture("ALL_STAFF");
  // Deduplication would be this module deciding something about relations rather than about
  // references. Task 7's `@@unique([fromId, toId, type])` is what makes the upsert idempotent.
  const relations = resolved(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { RELATES_TO: [TARGET, TARGET] },
    ),
  );
  expect(relations.map((r) => r.page.id)).toEqual([target.id, target.id]);
});

/* -------------------------------------------------------------------------- */
/* The redirect hop                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The rows are written by the real `movePage` rather than by hand wherever a move can produce
 * the shape under test, exactly as `tests/integration/pages-repo.test.ts` argues: a `Redirect`
 * fixture built with `db.redirect.create` proves this module reads a table, while using the
 * move proves it reads what the move writes.
 */
async function move(viewer: Viewer, pageId: string, newParentId: string | null, slug: string) {
  const result = await movePage(viewer, pageId, { newParentId, newSlug: slug });
  if (!result.ok) throw new Error(`move rejected: ${JSON.stringify(result)}`);
  return result.page;
}

test("a reference to a moved page still resolves, to where the page is now", async () => {
  const { space, source, target, platform, editor } = await fixture("ALL_STAFF");
  const args = { spaceKey: "engineering", path: TARGET };
  expect(await getPublishedPage(editor, args)).not.toBeNull();

  await move(editor, target.id, platform.id, "adr-0030-topic-layout");

  // The miss first, so this cannot pass against a path that was never a miss — the same
  // "verified the instance, not the class" trap the redirect tests in pages-repo guard against.
  expect(await getPublishedPage(editor, args)).toBeNull();

  const relations = resolved(
    await resolve(editor, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  // The id is the page's, and the path is where it is NOW — not the path that was written.
  // This is the assertion that fails if the redirect hop is removed, and the one that fails
  // if the module ever starts recording the author's string as the identity.
  expect(relations[0]?.ref).toBe(TARGET);
  expect(relations[0]?.page.id).toBe(target.id);
  expect(relations[0]?.page.path).toBe("platform/adr-0030-topic-layout");
});

test("two moves still resolve in one hop, from either old path", async () => {
  const { space, source, target, platform, decisions, editor } = await fixture("ALL_STAFF");
  await move(editor, target.id, platform.id, "adr-0030-topic-layout");
  await move(editor, target.id, decisions.id, "adr-0030-renamed");

  // Both redirect rows point at the same page id, so both reach it directly. A chain is
  // unrepresentable here, which is why one hop is enough.
  for (const ref of [TARGET, "platform/adr-0030-topic-layout"]) {
    const relations = resolved(
      await resolve(editor, { id: source.id, spaceId: space.id }, { RELATES_TO: [ref] }),
    );
    expect(relations[0]?.page.path).toBe("decisions/adr-0030-renamed");
  }
});

test("a redirect pointing into another space does not resolve", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const other = await db.space.findUniqueOrThrow({
    where: { key: "handbook" },
    select: { id: true },
  });
  const foreign = await db.page.create({
    data: {
      spaceId: other.id,
      slug: "welcome",
      path: "welcome",
      title: "Welcome",
      createdById: (await db.user.findFirstOrThrow({ select: { id: true } })).id,
      status: "CURRENT",
    },
    select: { id: true },
  });
  // Hand-written, because no move can produce it: nothing in the schema forces a redirect's
  // target into the redirect's own space, and `resolveRedirect` guards the same shape for the
  // same reason. This is the test that kills the `spaceId` constraint inside `toPage`.
  await db.redirect.create({
    data: { spaceId: space.id, fromPath: "decisions/gone-elsewhere", toPageId: foreign.id },
  });

  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { RELATES_TO: ["decisions/gone-elsewhere"] },
    ),
  );
  expect(errors.map((e) => e.code)).toEqual(["not-found"]);
});

/* -------------------------------------------------------------------------- */
/* The refusals, and the two that are deliberately the same answer            */
/* -------------------------------------------------------------------------- */

test("a path that names no page is refused", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { SUPERSEDES: ["decisions/adr-9999-imaginary"] },
    ),
  );
  expect(errors).toEqual([
    {
      field: "markdown",
      key: "supersedes",
      type: "SUPERSEDES",
      ref: "decisions/adr-9999-imaginary",
      code: "not-found",
      message: expect.stringContaining("does not name a page here"),
    },
  ]);
});

/**
 * The security property, asserted the only way it can be: as `toEqual` between the two
 * answers, not as "both are refusals".
 *
 * The same reference string is resolved twice — once while the page really is there and the
 * viewer simply cannot read its space, and once after the row is gone for good. Identical refs
 * mean identical objects, so a refusal that leaked *anything* — a different code, a different
 * sentence, a different key — fails here. This is what `saveDraft`'s "identical to a page that
 * was never real" test does with a page id, done with a path.
 *
 * Kills the mutant that drops `readableSpace` from `findLive`: the first resolution would
 * succeed, and `refusals()` throws with the resolved relation in the message.
 */
test("an unreadable page and a missing page are the same refusal, byte for byte", async () => {
  const { space, source, target, editor } = await fixture("MEMBERS");

  // Real, and readable by a member — so the refusal below is the permission predicate and not
  // a broken fixture.
  expect(resolved(await resolve(editor, { id: source.id, spaceId: space.id }, {
    SUPERSEDES: [TARGET],
  }))[0]?.page.id).toBe(target.id);

  const unreadable = refusals(
    await resolve(stranger, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  // Gone entirely. The same reference now names nothing at all, for anyone.
  await db.page.delete({ where: { id: target.id } });
  const missing = refusals(
    await resolve(stranger, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  expect(unreadable.map((e) => e.code)).toEqual(["not-found"]);
  expect(unreadable).toEqual(missing);
});

test("a reference to a soft-deleted page is refused, and says so", async () => {
  const { space, source, target, editor } = await fixture("ALL_STAFF");
  // Readable first, so the refusal below is the deletion and not a broken fixture.
  expect(resolved(await resolve(editor, { id: source.id, spaceId: space.id }, {
    SUPERSEDES: [TARGET],
  }))).toHaveLength(1);

  await db.page.update({ where: { id: target.id }, data: { deletedAt: new Date() } });

  // Kills two mutants at once: `visiblePage()` dropped from `findLive` resolves it as a live
  // target (and Task 8's cascade would then set a status on a deleted page), and `findDeleted`
  // inverted the wrong way reports every live page as deleted, failing the assertion above.
  const errors = refusals(
    await resolve(editor, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );
  expect(errors.map((e) => e.code)).toEqual(["deleted"]);
  expect(errors[0]?.message).toContain("has been deleted");
});

/**
 * The other half of the merged refusal, and the reason `deleted` is safe to be specific about
 * only inside a readable space. A stranger must not learn that a page they cannot read once
 * existed — so for them, `deleted` collapses back into `not-found`, identically.
 *
 * Kills the mutant that drops `readableSpace` from `findDeleted`.
 */
test("a stranger cannot tell a deleted page from a missing one", async () => {
  const { space, source, target } = await fixture("MEMBERS");
  await db.page.update({ where: { id: target.id }, data: { deletedAt: new Date() } });

  const softDeleted = refusals(
    await resolve(stranger, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  await db.page.delete({ where: { id: target.id } });
  const missing = refusals(
    await resolve(stranger, { id: source.id, spaceId: space.id }, { SUPERSEDES: [TARGET] }),
  );

  expect(softDeleted.map((e) => e.code)).toEqual(["not-found"]);
  expect(softDeleted).toEqual(missing);
});

/**
 * The redirect hop's own permission predicate. `findLive` and `findViaRedirect` are two
 * different questions and each states its predicate once; this is the test that makes the
 * second one killable on its own — without it, `readableSpace` could be dropped from the
 * redirect query and every other test here would still pass.
 */
test("a moved page in an unreadable space does not resolve through its redirect", async () => {
  const { space, source, target, platform, editor } = await fixture("MEMBERS");
  await move(editor, target.id, platform.id, "adr-0030-topic-layout");

  // The member resolves it through the redirect, so the row exists and the hop works.
  expect(
    resolved(
      await resolve(editor, { id: source.id, spaceId: space.id }, { RELATES_TO: [TARGET] }),
    )[0]?.page.id,
  ).toBe(target.id);

  const errors = refusals(
    await resolve(stranger, { id: source.id, spaceId: space.id }, { RELATES_TO: [TARGET] }),
  );
  expect(errors.map((e) => e.code)).toEqual(["not-found"]);
});

/**
 * A page moved and *then* deleted. The documented blind spot: the reference names the old
 * path, the deleted row sits at the new one, so `findDeleted` cannot see it and the answer is
 * `not-found` rather than `deleted`. Pinned rather than fixed — but the part that matters is
 * that it does not *resolve*, which is what kills `toPage: visiblePage(...)` being dropped
 * from the redirect query.
 */
test("a redirect to a soft-deleted page does not resolve", async () => {
  const { space, source, target, platform, editor } = await fixture("ALL_STAFF");
  await move(editor, target.id, platform.id, "adr-0030-topic-layout");
  expect(
    resolved(
      await resolve(editor, { id: source.id, spaceId: space.id }, { RELATES_TO: [TARGET] }),
    ),
  ).toHaveLength(1);

  await db.page.update({ where: { id: target.id }, data: { deletedAt: new Date() } });

  const errors = refusals(
    await resolve(editor, { id: source.id, spaceId: space.id }, { RELATES_TO: [TARGET] }),
  );
  expect(errors.map((e) => e.code)).toEqual(["not-found"]);
});

/* -------------------------------------------------------------------------- */
/* Self-reference                                                             */
/* -------------------------------------------------------------------------- */

test("a page cannot reference itself, under any relation type", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { SUPERSEDES: [SOURCE], RELATES_TO: [SOURCE] },
    ),
  );
  expect(errors.map((e) => [e.type, e.code])).toEqual([
    ["SUPERSEDES", "self-reference"],
    ["RELATES_TO", "self-reference"],
  ]);
});

/**
 * The case a path comparison gets wrong, and the reason the check is on the resolved page.
 *
 * The source page is moved, so its own former path now carries a redirect *to itself*. A
 * reference to that former path is a self-reference — and `ref !== source.path`, so an
 * implementation that compared strings would write a relation from the page to the page.
 */
test("a reference to this page's own pre-move path is a self-reference", async () => {
  const { space, source, platform, editor } = await fixture("ALL_STAFF");
  await move(editor, source.id, platform.id, "adr-0031-mqtt-namespacing");

  const moved = await db.page.findUniqueOrThrow({
    where: { id: source.id },
    select: { path: true },
  });
  expect(moved.path).toBe("platform/adr-0031-mqtt-namespacing");
  expect(moved.path).not.toBe(SOURCE);

  const errors = refusals(
    await resolve(editor, { id: source.id, spaceId: space.id }, { SUPERSEDES: [SOURCE] }),
  );
  expect(errors.map((e) => e.code)).toEqual(["self-reference"]);
});

/* -------------------------------------------------------------------------- */
/* Cross-space                                                                */
/* -------------------------------------------------------------------------- */

test("a reference naming another space is refused as cross-space, not as a miss", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { SUPERSEDES: ["/handbook/onboarding/day-one"] },
    ),
  );
  expect(errors).toEqual([
    {
      field: "markdown",
      key: "supersedes",
      type: "SUPERSEDES",
      ref: "/handbook/onboarding/day-one",
      // Its own code, so a later phase that wants cross-space relations can find this
      // decision instead of finding a path that quietly read as missing.
      code: "cross-space",
      message: expect.stringContaining("`handbook` space"),
    },
  ]);
});

test("the cross-space refusal is syntactic: a space that does not exist answers the same", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  // `handbook` is a real space in the fixture; `ghost-space` is not. The refusal must not tell
  // the difference, or it becomes a second way to ask whether something exists.
  const real = refusals(
    await resolve(editor, { id: source.id, spaceId: space.id }, { AMENDS: ["/handbook/x"] }),
  );
  const imaginary = refusals(
    await resolve(editor, { id: source.id, spaceId: space.id }, { AMENDS: ["/ghost-space/x"] }),
  );

  expect(real.map((e) => e.code)).toEqual(["cross-space"]);
  expect(imaginary.map((e) => e.code)).toEqual(["cross-space"]);
  // Only the space key the author typed differs — no field derived from the database does.
  expect({ ...real[0], ref: "", message: "" }).toEqual({
    ...imaginary[0],
    ref: "",
    message: "",
  });
});

test("a reader URL for this page's own space resolves", async () => {
  const { space, source, target, editor } = await fixture("ALL_STAFF");
  // The obvious thing an author does is paste the address bar. Unambiguous, so it is read
  // rather than refused — and it resolves to the same page the space-relative form does.
  const relations = resolved(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { SUPERSEDES: [`/engineering/${TARGET}`] },
    ),
  );
  expect(relations[0]?.page.id).toBe(target.id);
  // `ref` is the author's text, kept verbatim; the identity is the id.
  expect(relations[0]?.ref).toBe(`/engineering/${TARGET}`);
});

test("a malformed absolute reference is a miss, not a cross-space refusal", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { RELATES_TO: ["/", "/engineering", "//decisions"] },
    ),
  );
  // None of these names a page, and none of them names another space either. Inventing a
  // fifth code for punctuation would describe the input rather than the outcome.
  expect(errors.map((e) => e.code)).toEqual(["not-found", "not-found", "not-found"]);
});

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

test("every refusal is reported, not only the first", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      {
        SUPERSEDES: ["decisions/nope", SOURCE],
        DECIDES: ["/handbook/elsewhere"],
        RELATES_TO: [TARGET],
      },
    ),
  );
  // Three problems, three messages, in declaration order — and the one good reference is
  // simply absent rather than reported. An author fixing these one publish at a time is the
  // loop `validateFrontmatter` already refused to create.
  expect(errors.map((e) => [e.key, e.code])).toEqual([
    ["supersedes", "not-found"],
    ["supersedes", "self-reference"],
    ["decides", "cross-space"],
  ]);
});

test("a refusal names the frontmatter key, so the editor can point at the line", async () => {
  const { space, source, editor } = await fixture("ALL_STAFF");
  const errors = refusals(
    await resolve(
      editor,
      { id: source.id, spaceId: space.id },
      { AMENDS: ["decisions/nope"], RELATES_TO: ["also-nope"] },
    ),
  );
  // `field` alone can only underline the whole pane — frontmatter has no per-key input — so
  // `key` is the part that makes the message actionable. Same shape as `FrontmatterKeyError`.
  expect(errors.map((e) => [e.field, e.key])).toEqual([
    ["markdown", "amends"],
    ["markdown", "related"],
  ]);
});
