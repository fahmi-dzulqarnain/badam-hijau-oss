import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { MAX_INDEX_ROWS, listDocTypePages } from "@/lib/lifecycle/index-read";
import { deletePage } from "@/lib/pages/delete";
import type { DocStatus, DocType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Task 10's index query, against the real database.
 *
 * Integration rather than unit, because every question it answers is a question about rows and
 * about who may see them: whether another doc type's pages leak in, whether a soft-deleted ADR is
 * absent from the *counts* as well as the list, and — the one that matters most — whether a
 * stranger can tell a space they cannot read from a space with no ADRs in it. A stubbed client can
 * be made to agree with any of those, which is exactly why it would prove none of them.
 */

/**
 * Two spaces and a third the editor cannot read. Every field is distinguishable — slug, path and
 * title all differ — so a query that read `slug` where it meant `path`, or returned a page from
 * the wrong space, fails here rather than passing by coincidence.
 *
 * `handbook` is `ALL_STAFF`, so it is readable by everyone: an ADR left there is the fixture that
 * makes the `spaceId` shape constraint falsifiable, because a permission predicate alone would
 * happily return it.
 */
async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const open = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
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
  }) => {
    const status = opts.status ?? "ACCEPTED";
    const row = await db.page.create({
      data: {
        spaceId: opts.spaceId ?? space.id,
        slug: opts.slug,
        path: `decisions/${opts.slug}`,
        title: opts.title,
        docType: opts.docType ?? "ADR",
        status,
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
          status,
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

  return { author, space, open, page, editor };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

const list = (viewer: Viewer, spaceId: string, docType: DocType = "ADR", status: DocStatus | null = null) =>
  listDocTypePages(viewer, { spaceId, docType, status });

/** The listing, or a failure loud enough to read — every assertion below wants the rows. */
async function listing(viewer: Viewer, spaceId: string, docType?: DocType, status?: DocStatus | null) {
  const result = await list(viewer, spaceId, docType, status);
  if (!result.ok) throw new Error(`expected a listing, got ${result.reason}`);
  return result.listing;
}

/* -------------------------------------------------------------------------- */
/* What the index lists                                                       */
/* -------------------------------------------------------------------------- */

test("the ADR index lists ADRs, in path order, and nothing of another doc type", async () => {
  const { space, page, editor } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  await page({ slug: "adr-0031-layout", title: "Topic layout", status: "SUPERSEDED" });
  await page({ slug: "rfc-0007-billing", title: "Billing split", docType: "RFC", status: "IN_REVIEW" });
  await page({ slug: "runbook-restart", title: "Restart the bridge", docType: "RUNBOOK", status: "CURRENT" });

  const adrs = await listing(editor, space.id);
  // Number order, because the number lives in the slug and the slug is in the path.
  expect(adrs.rows.map((row) => row.title)).toEqual(["Topic layout", "MQTT topic naming"]);
  expect(adrs.total).toBe(2);

  const rfcs = await listing(editor, space.id, "RFC");
  expect(rfcs.rows.map((row) => row.title)).toEqual(["Billing split"]);
  expect(rfcs.total).toBe(1);
});

test("an ADR in another readable space is not in this space's index", async () => {
  const { space, open, page, editor } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  // `handbook` is ALL_STAFF, so the permission predicate cannot exclude this one. Only the
  // `spaceId` shape constraint can, which is what makes it a test rather than a coincidence.
  await page({ slug: "adr-0099-elsewhere", title: "Somebody else's decision", spaceId: open.id });

  const here = await listing(editor, space.id);
  expect(here.rows.map((row) => row.title)).toEqual(["MQTT topic naming"]);
  expect(here.total).toBe(1);

  const there = await listing(editor, open.id);
  expect(there.rows.map((row) => row.title)).toEqual(["Somebody else's decision"]);
});

test("an ADR that has never been published is listed, and is not linkable", async () => {
  const { space, page, editor } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  await page({ slug: "adr-0043-prisma", title: "Prisma migration policy", status: "DRAFT", publish: false });

  const adrs = await listing(editor, space.id);
  // The decision: listed, because the nav rail already shows it to the same audience — and not
  // linkable, because `getPublishedPage` would 404 it for everyone.
  expect(adrs.rows.map((row) => [row.title, row.status, row.isLinkable])).toEqual([
    ["MQTT topic naming", "ACCEPTED", true],
    ["Prisma migration policy", "DRAFT", false],
  ]);
  expect(adrs.counts.get("DRAFT")).toBe(1);
});

test("isLinkable follows publishedVersionId, not publishedAt", async () => {
  const { space, page, editor } = await fixture();
  const orphan = await page({ slug: "adr-0044-rolled-back", title: "Rolled back" });
  // Two independent nullable columns with nothing tying them together: a row with a timestamp
  // and no version is what a rollback leaves behind, and a link built on the timestamp 404s.
  await db.page.update({ where: { id: orphan.id }, data: { publishedVersionId: null } });

  const adrs = await listing(editor, space.id);
  expect(adrs.rows[0]!.publishedAt).not.toBeNull();
  expect(adrs.rows[0]!.isLinkable).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* Filtering by status                                                        */
/* -------------------------------------------------------------------------- */

test("a status filter narrows the rows and leaves the counts and the total alone", async () => {
  const { space, page, editor } = await fixture();
  await page({ slug: "adr-0031-layout", title: "Topic layout", status: "SUPERSEDED" });
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  await page({ slug: "adr-0043-prisma", title: "Prisma migration policy", status: "PROPOSED" });

  const accepted = await listing(editor, space.id, "ADR", "ACCEPTED");
  expect(accepted.rows.map((row) => row.title)).toEqual(["MQTT topic naming"]);
  expect(accepted.matched).toBe(1);
  // The counts are the *unfiltered* histogram, which is what the filter bar renders — a filter
  // that narrowed its own chips would show `1` beside the status you are already looking at and
  // `0` beside every other.
  expect(accepted.total).toBe(3);
  expect([...accepted.counts.entries()].sort()).toEqual([
    ["ACCEPTED", 1],
    ["PROPOSED", 1],
    ["SUPERSEDED", 1],
  ]);
});

test("a status no page has reached is an empty list, distinguishable from an empty space", async () => {
  const { space, open, page, editor } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });

  // Same space, a status nothing is at: the space HAS ADRs, so the page must not say it does not.
  const rejected = await listing(editor, space.id, "ADR", "REJECTED");
  expect(rejected.rows).toEqual([]);
  expect(rejected.matched).toBe(0);
  expect(rejected.total).toBe(1);

  // A different space with no ADRs at all: the other empty branch, and the two differ only in
  // `total`. Without the aggregate they would be indistinguishable and one of the two sentences
  // would be a false statement about a space.
  const none = await listing(editor, open.id);
  expect(none.rows).toEqual([]);
  expect(none.total).toBe(0);
  expect(none.counts.size).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* Soft delete                                                               */
/* -------------------------------------------------------------------------- */

test("a soft-deleted ADR is absent from the list and from the counts", async () => {
  const { space, page, editor, author } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  const gone = await page({ slug: "adr-0031-layout", title: "Topic layout" });

  const admin: Viewer = { id: author.id, isSuperAdmin: true, memberships: [] };
  const deleted = await deletePage(admin, gone.id);
  expect(deleted.ok).toBe(true);

  const adrs = await listing(editor, space.id);
  // Both halves, because they are two separate `visiblePage()` calls on two separate queries:
  // with the filter dropped from the aggregate alone the list is right and the `ACCEPTED 2` chip
  // beside it counts a page nobody can open.
  expect(adrs.rows.map((row) => row.title)).toEqual(["MQTT topic naming"]);
  expect(adrs.total).toBe(1);
  expect(adrs.counts.get("ACCEPTED")).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* Permission                                                                 */
/* -------------------------------------------------------------------------- */

test("a stranger cannot list a space's ADRs, and cannot tell it from an empty space", async () => {
  const { space, page } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });

  const refused = await list(stranger, space.id);
  // `not-found`, not an empty listing: an empty listing renders the space's *name* over an
  // explanation, which tells a stranger the space exists. Unreadable and nonexistent are one
  // answer, as everywhere (spec §8).
  expect(refused).toEqual({ ok: false, reason: "not-found" });

  const missing = await list(stranger, "sp-does-not-exist");
  expect(missing).toEqual({ ok: false, reason: "not-found" });
});

test("a super admin reads a space they do not belong to", async () => {
  const { space, page, author } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });

  const admin: Viewer = { id: author.id, isSuperAdmin: true, memberships: [] };
  const adrs = await listing(admin, space.id);
  expect(adrs.rows.map((row) => row.title)).toEqual(["MQTT topic naming"]);
});

test("an ALL_STAFF space's index is readable by someone who belongs to nothing", async () => {
  const { open, page } = await fixture();
  await page({ slug: "adr-0099-elsewhere", title: "Everybody's decision", spaceId: open.id });

  const adrs = await listing(stranger, open.id);
  expect(adrs.rows.map((row) => row.title)).toEqual(["Everybody's decision"]);
});

/* -------------------------------------------------------------------------- */
/* The rendering bound                                                        */
/* -------------------------------------------------------------------------- */

test("more ADRs than the render cap comes back short, and says so", async () => {
  const { space, author, editor } = await fixture();
  const many = MAX_INDEX_ROWS + 1;
  await db.page.createMany({
    data: Array.from({ length: many }, (_, i) => ({
      spaceId: space.id,
      // Zero-padded so path order is number order — the ordering this index relies on.
      slug: `adr-${String(i).padStart(4, "0")}`,
      path: `decisions/adr-${String(i).padStart(4, "0")}`,
      title: `Decision ${i}`,
      docType: "ADR" as DocType,
      status: "ACCEPTED" as DocStatus,
      createdById: author.id,
    })),
  });

  const adrs = await listing(editor, space.id);
  expect(adrs.rows.length).toBe(MAX_INDEX_ROWS);
  // The total comes from the aggregate, not from the truncated array, which is the only reason
  // the page can tell the reader the list is short.
  expect(adrs.total).toBe(many);
  expect(adrs.matched).toBe(many);
  expect(adrs.truncated).toBe(true);
  // Deterministically the first page of them, not an arbitrary 500.
  expect(adrs.rows[0]!.title).toBe("Decision 0");
});

test("a list that fits is not reported as truncated", async () => {
  const { space, page, editor } = await fixture();
  await page({ slug: "adr-0042-topics", title: "MQTT topic naming" });
  const adrs = await listing(editor, space.id);
  expect(adrs.truncated).toBe(false);
});
