import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { getPageRelations, MAX_RELATIONS_RENDERED } from "@/lib/lifecycle/read";
import { retirementNotice } from "@/lib/lifecycle/retired";
import { publishPage } from "@/lib/pages/publish";
import { deletePage } from "@/lib/pages/delete";
import type { DocStatus, DocType, RelationType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Integration, against the real database, because every question Task 9's reads answer is a
 * question about rows and about who may see them: whether the inverse direction finds anything at
 * all, whether a soft-deleted far page is filtered, and — the one that matters most — whether the
 * answer changes for a viewer who cannot read the far page's space. A stubbed client can be made
 * to agree with any of those, which is exactly why it would prove none of them.
 *
 * The relation rows here are written directly, not through `publishPage`, for everything except
 * the one end-to-end test at the bottom. That is deliberate: `PageRelation` is a row, and Phase
 * 3's same-space and same-doc-type rules are *resolution* rules rather than schema constraints, so
 * the hostile shapes this file has to cover — a relation across spaces, a relation to a
 * soft-deleted page — are reachable in the database and unreachable through publish. Injecting
 * them is the only way to test the filters that exist for them.
 */

/**
 * Two spaces, and a `decisions/` tree in the first. `other` is `MEMBERS` and the editor does not
 * belong to it, so it is the space a relation must never surface a page from.
 *
 * Every field is distinguishable — slug, path and title all differ — so a query that read `slug`
 * where it meant `path`, or returned the near page instead of the far one, fails here rather than
 * passing by coincidence.
 */
async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const other = await db.space.create({
    data: { key: "finance", name: "Finance", initials: "FI", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "EDITOR" },
  });

  const page = async (opts: {
    slug: string;
    title: string;
    spaceId?: string;
    docType?: DocType;
    status?: DocStatus;
    publish?: boolean;
    id?: string;
  }) => {
    const row = await db.page.create({
      data: {
        ...(opts.id === undefined ? {} : { id: opts.id }),
        spaceId: opts.spaceId ?? space.id,
        slug: opts.slug,
        path: opts.slug,
        title: opts.title,
        docType: opts.docType ?? "ADR",
        status: opts.status ?? "ACCEPTED",
        createdById: author.id,
      },
      select: { id: true, path: true, title: true },
    });
    if (opts.publish !== false) {
      const version = await db.pageVersion.create({
        data: {
          pageId: row.id,
          title: opts.title,
          markdown: `# ${opts.title}`,
          status: opts.status ?? "ACCEPTED",
          authorId: author.id,
        },
        select: { id: true },
      });
      await db.page.update({
        where: { id: row.id },
        data: {
          publishedVersionId: version.id,
          publishedAt: new Date("2026-03-04T09:00:00Z"),
        },
      });
    }
    return row;
  };

  const editor: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "EDITOR" }],
  };

  return { author, space, other, page, editor };
}

const relate = (fromId: string, toId: string, type: RelationType = "SUPERSEDES") =>
  db.pageRelation.create({ data: { fromId, toId, type } });

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/* -------------------------------------------------------------------------- */
/* Both directions of one stored row                                          */
/* -------------------------------------------------------------------------- */

test("one stored row answers both directions, and the inverse is never a second row", async () => {
  const { page, editor } = await fixture();
  const newer = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  const older = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "SUPERSEDED",
  });
  await relate(newer.id, older.id);

  // Spec §6.2: stored one direction only. One row in the table, and two questions answered.
  expect(await db.pageRelation.count()).toBe(1);

  const fromNewer = await getPageRelations(editor, { id: newer.id, status: "ACCEPTED" });
  expect(fromNewer.outgoing).toEqual([
    {
      type: "SUPERSEDES",
      page: {
        id: older.id,
        spaceKey: "engineering",
        path: "adr-0030-topic-layout",
        title: "ADR-0030 Topic layout",
        status: "SUPERSEDED",
        publishedAt: new Date("2026-03-04T09:00:00Z"),
        isLinkable: true,
      },
    },
  ]);
  // The page that supersedes something is not itself retired, so no inverse query is owed.
  expect(fromNewer.retiredBy).toEqual([]);

  const fromOlder = await getPageRelations(editor, { id: older.id, status: "SUPERSEDED" });
  expect(fromOlder.outgoing).toEqual([]);
  expect(fromOlder.retiredBy).toEqual([
    {
      type: "SUPERSEDES",
      page: {
        id: newer.id,
        spaceKey: "engineering",
        path: "adr-0032-mqtt-contracts",
        title: "ADR-0032 MQTT contracts",
        status: "ACCEPTED",
        publishedAt: new Date("2026-03-04T09:00:00Z"),
        isLinkable: true,
      },
    },
  ]);

  // And the banner reads it.
  const notice = retirementNotice({ status: "SUPERSEDED", replacements: fromOlder.retiredBy });
  expect(notice?.replacements.map((r) => r.page.title)).toEqual(["ADR-0032 MQTT contracts"]);
});

test("a DECIDES row retires an RFC and names the ADR that closed it", async () => {
  const { page, editor } = await fixture();
  const adr = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  const rfc = await page({
    slug: "rfc-0004-topic-shape",
    title: "RFC-0004 Topic shape",
    docType: "RFC",
    status: "CLOSED",
  });
  await relate(adr.id, rfc.id, "DECIDES");

  const { retiredBy } = await getPageRelations(editor, { id: rfc.id, status: "CLOSED" });
  expect(retiredBy).toHaveLength(1);
  expect(retiredBy[0]?.type).toBe("DECIDES");
  expect(retiredBy[0]?.page.title).toBe("ADR-0032 MQTT contracts");
});

/* -------------------------------------------------------------------------- */
/* The permission predicate, in both directions                               */
/* -------------------------------------------------------------------------- */

/**
 * **Mutation target: `readableSpace` dropped from either read.** The far page lives in a
 * `MEMBERS` space this viewer does not belong to, so a relation row that names it must surface
 * nothing at all — not a redacted entry, not a title.
 *
 * This is why neither query carries a `spaceId` shape constraint beside the predicate: scoped to
 * the page's own space, this test could not exist. The viewer can necessarily read the space of
 * the page they are reading, so the only viewer for whom `readableSpace` answers differently is
 * one looking at a relation that leaves the space — exactly this one.
 */
test("a relation to a page in a space the viewer cannot read is absent, both ways", async () => {
  const { page, other, editor } = await fixture();
  const mine = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "SUPERSEDED",
  });
  const theirs = await page({
    slug: "adr-0099-ledger-format",
    title: "ADR-0099 Ledger format",
    spaceId: other.id,
  });
  // Both directions, so neither filter can be dropped while the other's test stays green.
  await relate(theirs.id, mine.id);
  await relate(mine.id, theirs.id, "RELATES_TO");

  const seen = await getPageRelations(editor, { id: mine.id, status: "SUPERSEDED" });
  expect(seen.retiredBy).toEqual([]);
  expect(seen.outgoing).toEqual([]);
  // The banner therefore names no replacement, rather than one it must not disclose.
  expect(retirementNotice({ status: "SUPERSEDED", replacements: seen.retiredBy })?.replacements)
    .toEqual([]);

  // Not vacuous: the same viewer, once they are a member of that space, sees both rows — so the
  // rows are really there and it is the predicate that hid them. The membership is a real
  // `SpaceMembership` row and not a field on the viewer object, because `readableSpace` filters
  // on the row in SQL: a synthetic self-declared membership reads nothing, which is the
  // deliberate second source of truth this project records.
  await db.spaceMembership.create({
    data: { spaceId: other.id, userId: editor.id, role: "VIEWER" },
  });
  const insiderSees = await getPageRelations(editor, { id: mine.id, status: "SUPERSEDED" });
  expect(insiderSees.retiredBy.map((r) => r.page.title)).toEqual(["ADR-0099 Ledger format"]);
  expect(insiderSees.outgoing.map((r) => r.page.title)).toEqual(["ADR-0099 Ledger format"]);
});

test("a stranger reads no relations at all", async () => {
  const { page } = await fixture();
  const mine = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "SUPERSEDED",
  });
  const newer = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  await relate(newer.id, mine.id);
  await relate(mine.id, newer.id, "RELATES_TO");

  // The reader route would already have 404ed, and this query does not rely on that: it states
  // its own predicate, so a second caller cannot inherit a bypass.
  expect(await getPageRelations(stranger, { id: mine.id, status: "SUPERSEDED" })).toEqual({
    outgoing: [],
    retiredBy: [],
  });
});

/* -------------------------------------------------------------------------- */
/* The soft-delete filter, in both directions                                 */
/* -------------------------------------------------------------------------- */

/**
 * **Mutation target: `visiblePage()` dropped from either read.** Task 12 promises a soft-deleted
 * page is invisible; nothing in the delete path removes relation rows, so this filter is the only
 * thing between a soft delete and a banner naming a page whose URL 404s.
 */
test("a relation to a soft-deleted page is not rendered in either direction", async () => {
  const { page, editor, space } = await fixture();
  const mine = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "SUPERSEDED",
  });
  const newer = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  const sibling = await page({ slug: "adr-0031-namespacing", title: "ADR-0031 Namespacing" });
  await relate(newer.id, mine.id);
  await relate(mine.id, sibling.id, "RELATES_TO");

  // Both are visible first, so the assertions below are about the delete and not about a
  // relation that never resolved.
  const before = await getPageRelations(editor, { id: mine.id, status: "SUPERSEDED" });
  expect(before.retiredBy).toHaveLength(1);
  expect(before.outgoing).toHaveLength(1);

  const admin: Viewer = {
    id: editor.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "ADMIN" }],
  };
  expect((await deletePage(admin, newer.id)).ok).toBe(true);
  expect((await deletePage(admin, sibling.id)).ok).toBe(true);

  // The rows are still there — this is a soft delete, and `onDelete: Cascade` fires on a hard
  // one, which nothing in the product does.
  expect(await db.pageRelation.count()).toBe(2);

  const after = await getPageRelations(editor, { id: mine.id, status: "SUPERSEDED" });
  expect(after.retiredBy).toEqual([]);
  expect(after.outgoing).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Which incoming relations reach the banner                                  */
/* -------------------------------------------------------------------------- */

/**
 * The type filter, from the side that would otherwise be silent: an amendment modifies a document
 * without replacing it, so it is not why the page is retired and must not be offered as the
 * replacement. Kills a query keyed on `toId` alone.
 */
test("an incoming AMENDS is not a replacement for a superseded page", async () => {
  const { page, editor } = await fixture();
  const mine = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "SUPERSEDED",
  });
  const amender = await page({ slug: "adr-0031-namespacing", title: "ADR-0031 Namespacing" });
  const replacement = await page({
    slug: "adr-0032-mqtt-contracts",
    title: "ADR-0032 MQTT contracts",
  });
  await relate(amender.id, mine.id, "AMENDS");
  await relate(amender.id, mine.id, "RELATES_TO");
  await relate(replacement.id, mine.id, "SUPERSEDES");

  const { retiredBy } = await getPageRelations(editor, { id: mine.id, status: "SUPERSEDED" });
  expect(retiredBy.map((r) => `${r.type} ${r.page.title}`)).toEqual([
    "SUPERSEDES ADR-0032 MQTT contracts",
  ]);
});

/**
 * A proposal that declares `supersedes:` writes the row at `PROPOSED` and cascades nothing (Task
 * 6). So a page still in force can have an incoming `SUPERSEDES` row, and it must not sprout a
 * banner claiming it has been superseded.
 */
test("a page in force with an incoming SUPERSEDES row gets no banner", async () => {
  const { page, editor } = await fixture();
  const live = await page({ slug: "adr-0030-topic-layout", title: "ADR-0030 Topic layout" });
  const proposal = await page({
    slug: "adr-0032-mqtt-contracts",
    title: "ADR-0032 MQTT contracts",
    status: "PROPOSED",
  });
  await relate(proposal.id, live.id);

  const { retiredBy } = await getPageRelations(editor, { id: live.id, status: "ACCEPTED" });
  expect(retiredBy).toEqual([]);
  expect(retirementNotice({ status: "ACCEPTED", replacements: retiredBy })).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* Shape: linkability, order, and the rendering cap                           */
/* -------------------------------------------------------------------------- */

test("a relation to a page that has never been published is named but not linkable", async () => {
  const { page, editor } = await fixture();
  const mine = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  const unpublished = await page({
    slug: "adr-0035-draft-only",
    title: "ADR-0035 Draft only",
    status: "DRAFT",
    publish: false,
  });
  await relate(mine.id, unpublished.id, "RELATES_TO");

  const { outgoing } = await getPageRelations(editor, { id: mine.id, status: "ACCEPTED" });
  // Named, so the author can see what they declared; inert, because `getPublishedPage` requires
  // a published version and a link would 404 for everyone.
  expect(outgoing).toHaveLength(1);
  expect(outgoing[0]?.page.title).toBe("ADR-0035 Draft only");
  expect(outgoing[0]?.page.isLinkable).toBe(false);
  expect(outgoing[0]?.page.publishedAt).toBeNull();
});

test("relations come back grouped by type, deterministically", async () => {
  const { page, editor } = await fixture();
  const mine = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });
  const a = await page({ slug: "adr-0030-topic-layout", title: "ADR-0030 Topic layout" });
  const b = await page({ slug: "adr-0031-namespacing", title: "ADR-0031 Namespacing" });
  const c = await page({ slug: "runbook-mqtt", title: "MQTT runbook", docType: "RUNBOOK" });
  // Inserted in an order that is not the rendering order.
  await relate(mine.id, c.id, "RELATES_TO");
  await relate(mine.id, b.id, "AMENDS");
  await relate(mine.id, a.id, "SUPERSEDES");

  const first = await getPageRelations(editor, { id: mine.id, status: "ACCEPTED" });
  const second = await getPageRelations(editor, { id: mine.id, status: "ACCEPTED" });
  expect(first.outgoing.map((r) => r.type)).toEqual(["SUPERSEDES", "AMENDS", "RELATES_TO"]);
  expect(second.outgoing).toEqual(first.outgoing);
});

/**
 * Incoming relations are unbounded by construction — any number of pages may declare a relation
 * to this one — and this read is what a Server Component renders outside `.body`. The cap is a
 * rendering bound, not a correctness one, and it is above anything one publish can reach
 * (`MAX_RELATION_TARGETS` is 20).
 */
test("the rendered relation list is capped", async () => {
  const { page, editor, author, space } = await fixture();
  const mine = await page({ slug: "adr-0032-mqtt-contracts", title: "ADR-0032 MQTT contracts" });

  const count = MAX_RELATIONS_RENDERED + 3;
  await db.page.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      spaceId: space.id,
      slug: `related-${i}`,
      path: `related-${i}`,
      title: `Related ${i}`,
      docType: "DOC" as DocType,
      status: "CURRENT" as DocStatus,
      createdById: author.id,
    })),
  });
  const targets = await db.page.findMany({
    where: { spaceId: space.id, slug: { startsWith: "related-" } },
    select: { id: true },
  });
  await db.pageRelation.createMany({
    data: targets.map((target) => ({
      fromId: mine.id,
      toId: target.id,
      type: "RELATES_TO" as RelationType,
    })),
  });

  const { outgoing } = await getPageRelations(editor, { id: mine.id, status: "ACCEPTED" });
  expect(targets).toHaveLength(count);
  expect(outgoing).toHaveLength(MAX_RELATIONS_RENDERED);
});

/* -------------------------------------------------------------------------- */
/* Through the real path                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The whole chain over rows the product actually writes: a publish declares `supersedes:`, the
 * cascade retires the target, and the target's reader derives the banner from the one stored row.
 *
 * It also pins the date the banner shows. The cascade runs inside the replacement's own publish
 * transaction and deliberately leaves the target's `publishedAt` alone, so the two timestamps
 * disagree — and the one the banner reports is the replacement's, which is the instant the
 * retirement happened. Asserted as an inequality against the target's own value, because
 * comparing a timestamp against another copy of itself is what hid the timezone bug in
 * `delete.ts`.
 */
test("a publish that supersedes a page gives that page's reader its banner", async () => {
  const { page, editor, author, space } = await fixture();
  const older = await page({
    slug: "adr-0030-topic-layout",
    title: "ADR-0030 Topic layout",
    status: "ACCEPTED",
  });
  const newer = await page({
    slug: "adr-0032-mqtt-contracts",
    title: "ADR-0032 MQTT contracts",
    status: "PROPOSED",
  });
  await db.pageDraft.create({
    data: {
      pageId: newer.id,
      title: "ADR-0032 MQTT contracts",
      markdown: `---\nstatus: ACCEPTED\nsupersedes: ${older.path}\n---\n\n# Contracts\n\nText.\n`,
      updatedById: author.id,
    },
  });

  const publisher: Viewer = {
    id: editor.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "ADMIN" }],
  };
  const result = await publishPage(publisher, newer.id);
  expect(result.ok, JSON.stringify(result)).toBe(true);

  const retired = await db.page.findUniqueOrThrow({
    where: { id: older.id },
    select: { status: true, publishedAt: true },
  });
  expect(retired.status).toBe("SUPERSEDED");

  const { retiredBy } = await getPageRelations(editor, { id: older.id, status: retired.status });
  const notice = retirementNotice({ status: retired.status, replacements: retiredBy });
  expect(notice?.lead).toMatch(/superseded/i);
  expect(notice?.replacements).toHaveLength(1);

  const replacement = notice?.replacements[0]?.page;
  expect(replacement?.title).toBe("ADR-0032 MQTT contracts");
  expect(replacement?.isLinkable).toBe(true);
  // The date the banner shows is the replacement's publish, which is the transaction the cascade
  // ran in — and it is NOT the retired page's own `publishedAt`, which still says when that page
  // was last published while it was in force.
  expect(replacement?.publishedAt).not.toEqual(retired.publishedAt);
  expect(replacement?.publishedAt?.getTime() ?? 0).toBeGreaterThan(
    retired.publishedAt?.getTime() ?? 0,
  );
});
