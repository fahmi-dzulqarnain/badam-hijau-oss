import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { inOneRequest } from "@/lib/audit/log";
import {
  MAX_BUG_REPORTS,
  listBugReports,
  parseBugStatusFilter,
  setBugStatus,
  type AdminBugReport,
} from "@/lib/bugs/admin";
import type { BugStatus } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * `/admin/bugs` — Phase 7 Task 8, the first thing in this product that reads a `BugReport` back.
 *
 * Integration and not unit, because every question here is a question about rows, and one of them
 * is a question about rows that are **not there**: `BugReport.spaceId`, `pageId` and `versionId`
 * carry no foreign keys, so an id naming nothing is a legal state of a legal row and a stubbed
 * client could be made to agree with any story about it.
 *
 * The three claims this file is protecting, in the order the task states them:
 *
 * 1. **Triage is the three statuses that already exist**, any of them reachable from any other,
 *    and every press leaves an audit row because the column keeps only the latest answer.
 * 2. **A soft-deleted page and an absent one are two different facts**, and the module reports
 *    them as two different kinds. The mutation this file exists for is `deletedAt: null` on the
 *    page resolution, which turns the recoverable one into the lost one.
 * 3. **The audit line is Task 7's**, asserted as the same discrimination it used: the list writes
 *    a `space.access` row over a `MEMBERS` space the admin does not belong to, the triage over
 *    the same report writes none, and an `ALL_STAFF` space contributes none either way.
 */

const auditRows = (action: string) =>
  db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

/**
 * Two spaces, three pages in three states, and reports written directly.
 *
 * Written with `db.bugReport.create` rather than through `createBugReport` for
 * `git-retention.test.ts`'s reason: `resolveReportContext` can only ever produce ids that resolve,
 * because it derives them by reading the rows — so the state this file is about (a captured id
 * that names nothing) is **unreachable through the writer** and has to be constructed. That is the
 * same reason `e2e/admin-git.spec.ts` writes its credentialed `lastError` by hand: a fixture
 * produced by the guard is a test of the fixture.
 *
 * `engineering` is `MEMBERS` and `handbook` is `ALL_STAFF`, which is what makes the audit
 * assertion a discrimination rather than an absence — Phase 4's lesson, in the shape Task 7 left.
 */
async function fixture() {
  const reporter = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Root", isSuperAdmin: true },
  });
  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: reporter.id, role: "ADMIN" },
  });

  /** A page, optionally published and optionally soft-deleted. */
  const page = async (opts: {
    spaceId?: string;
    slug: string;
    title: string;
    published?: boolean;
    deleted?: boolean;
  }) => {
    const row = await db.page.create({
      data: {
        spaceId: opts.spaceId ?? engineering.id,
        slug: opts.slug,
        path: opts.slug,
        title: opts.title,
        docType: "DOC",
        status: "CURRENT",
        createdById: reporter.id,
        deletedAt: opts.deleted === true ? new Date() : null,
      },
      select: { id: true, path: true },
    });
    if (opts.published === false) return row;
    const version = await db.pageVersion.create({
      data: {
        pageId: row.id,
        title: opts.title,
        markdown: `# ${opts.title}`,
        searchText: opts.title,
        status: "CURRENT",
        authorId: reporter.id,
      },
      select: { id: true },
    });
    await db.page.update({
      where: { id: row.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
    return { ...row, versionId: version.id };
  };

  /** A report. Every captured id is whatever the caller says it is — including nothing at all. */
  const report = async (over: {
    summary?: string;
    expected?: string | null;
    routePath?: string;
    spaceId?: string | null;
    pageId?: string | null;
    versionId?: string | null;
    consoleError?: string | null;
    status?: BugStatus;
    createdAt?: Date;
  }) =>
    await db.bugReport.create({
      data: {
        reporterId: reporter.id,
        summary: over.summary ?? "The table of contents is empty.",
        expected: over.expected ?? null,
        routePath: over.routePath ?? "/engineering/architecture",
        spaceId: over.spaceId ?? null,
        pageId: over.pageId ?? null,
        versionId: over.versionId ?? null,
        appVersion: "0.1.0",
        gitSha: "abc1234",
        userAgent: "Mozilla/5.0",
        viewport: "1440x900",
        consoleError: over.consoleError ?? null,
        status: over.status ?? "NEW",
        ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt }),
      },
      select: { id: true, status: true },
    });

  const member: Viewer = {
    id: reporter.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: engineering.id, role: "ADMIN" }],
  };
  const admin: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };

  return { reporter, root, engineering, handbook, page, report, member, admin };
}

/** Unwraps, so a failed permission check reads as a named failure rather than a type error. */
async function listed(viewer: Viewer, options: { status?: BugStatus | null } = {}) {
  const result = await listBugReports(viewer, options);
  if (!result.ok) throw new Error(`listBugReports refused: ${result.reason}`);
  return result;
}

async function triage(viewer: Viewer, id: string, status: BugStatus) {
  const result = await setBugStatus(viewer, id, status);
  if (!result.ok) throw new Error(`setBugStatus refused: ${result.reason}`);
  return result;
}

const bySummary = (reports: AdminBugReport[], summary: string) => {
  const found = reports.find((row) => row.summary === summary);
  if (found === undefined) throw new Error(`no report summarised "${summary}"`);
  return found;
};

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Both entry points, one predicate — and **mutation-verified in both directions**.
 *
 * With `if (viewer.isSuperAdmin) return null;` deleted from `refuseNonAdmin`, the second half
 * fails: the super admin is refused too. With the body replaced by `return null`, the first half
 * fails: a space `ADMIN` reads every reporter's email address. There is no second guard in the
 * module that could produce either answer — `listBugReports` has no other filter at all, and
 * `setBugStatus` genuinely writes the row.
 *
 * The discriminating viewer is an **`ADMIN` of a real space**, not a stranger: a member of nothing
 * is refused by any predicate at all, which is the near-vacuity Phase 4 measured. And it is a
 * discrimination rather than an absence — the same fixture is read by the super admin below.
 */
test("a space ADMIN is refused by both entry points, and the super admin is not", async () => {
  const f = await fixture();
  const filed = await f.report({ summary: "Only report" });

  expect(await listBugReports(f.member)).toEqual({ ok: false, reason: "not-found" });
  expect(await setBugStatus(f.member, filed.id, "TRIAGED")).toEqual({
    ok: false,
    reason: "not-found",
  });

  expect((await listed(f.admin)).reports).toHaveLength(1);
  expect((await triage(f.admin, filed.id, "TRIAGED")).status).toBe("TRIAGED");
});

test("a refused triage changes nothing and writes nothing", async () => {
  const f = await fixture();
  const filed = await f.report({ status: "NEW" });

  expect(await setBugStatus(f.member, filed.id, "CLOSED")).toEqual({
    ok: false,
    reason: "not-found",
  });

  const after = await db.bugReport.findUniqueOrThrow({
    where: { id: filed.id },
    select: { status: true },
  });
  expect(after.status).toBe("NEW");
  expect(await db.auditLog.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* Step 2: a captured id may dangle, and two ways of being gone are different  */
/* -------------------------------------------------------------------------- */

/**
 * **The heart of Step 2.** Three reports, three answers, one call.
 *
 * A live published page, a **soft-deleted** one and an **absent** one — and the middle and last
 * are the pair the surface exists to tell apart, because one is a `restorePage` away from being
 * back and the other is the last trace a document existed. The live row in the same assertion is
 * the non-vacuity companion: a resolution that returned nothing at all would satisfy "the deleted
 * one is flagged" vacuously.
 *
 * **Mutated to `where: { id: { in: pageIds }, deletedAt: null }`** — the filter a reader reaches
 * for out of habit, and the one `visiblePage()` would bring with it — the soft-deleted row drops
 * out of the lookup and is reported as `absent`, and this test fails on the middle expectation
 * with `expected "absent" to be "found"`. That is the whole reason the module states the absence
 * at the line instead of leaving it to be noticed.
 */
test("a live page, a soft-deleted page and an absent page are three different answers", async () => {
  const f = await fixture();
  const live = await f.page({ slug: "live", title: "Live page" });
  const gone = await f.page({ slug: "gone", title: "Taken down", deleted: true });

  await f.report({
    summary: "live",
    spaceId: f.engineering.id,
    pageId: live.id,
    routePath: "/engineering/live",
  });
  await f.report({
    summary: "soft-deleted",
    spaceId: f.engineering.id,
    pageId: gone.id,
    routePath: "/engineering/gone",
  });
  await f.report({
    summary: "absent",
    spaceId: f.engineering.id,
    // A cuid-shaped id that names no row. Unreachable through this product — nothing hard-deletes
    // a page — which is exactly why the schema gave up the foreign key and why this is a fixture.
    pageId: "cnosuchpage000000000000",
    routePath: "/engineering/architecture/mqtt-contracts",
  });

  const { reports } = await listed(f.admin);

  const one = bySummary(reports, "live").page;
  expect(one.kind).toBe("found");
  if (one.kind !== "found") throw new Error("unreachable");
  expect(one).toMatchObject({
    title: "Live page",
    spaceKey: "engineering",
    path: "live",
    deleted: false,
    isLinkable: true,
  });

  const two = bySummary(reports, "soft-deleted").page;
  expect(two.kind).toBe("found");
  if (two.kind !== "found") throw new Error("unreachable");
  // The row is still there, so the title, the path and the space are all still readable — which is
  // the difference a triager acts on.
  expect(two).toMatchObject({
    title: "Taken down",
    spaceKey: "engineering",
    path: "gone",
    deleted: true,
    // No link: the reader route 404s for a soft-deleted page, and this surface offers no 404s.
    isLinkable: false,
  });

  const three = bySummary(reports, "absent").page;
  expect(three).toEqual({ kind: "absent", pageId: "cnosuchpage000000000000" });
  // And `routePath` is what is left, which is the whole of the schema's argument for the missing
  // foreign key.
  expect(bySummary(reports, "absent").routePath).toBe(
    "/engineering/architecture/mqtt-contracts",
  );
});

test("a dangling space id renders as absent, and no captured space renders as none", async () => {
  const f = await fixture();
  await f.report({ summary: "dangling space", spaceId: "cnosuchspace00000000000" });
  await f.report({ summary: "no space", spaceId: null, routePath: "/search?q=mqtt" });
  await f.report({ summary: "real space", spaceId: f.engineering.id });

  const { reports } = await listed(f.admin);

  expect(bySummary(reports, "dangling space").space).toEqual({
    kind: "absent",
    spaceId: "cnosuchspace00000000000",
  });
  expect(bySummary(reports, "no space").space).toEqual({ kind: "none" });
  // The non-vacuity companion: the same call resolves a real one, so "absent" is a resolution that
  // failed rather than a resolution that never ran.
  expect(bySummary(reports, "real space").space).toEqual({
    kind: "found",
    spaceId: f.engineering.id,
    key: "engineering",
    name: "Engineering",
  });
});

/**
 * A page that is live but has no published version.
 *
 * Reachable rather than defensive: `resolveReportContext` sets `pageId` only through
 * `getPublishedPage`, so every captured page **was** published when the report was filed — and an
 * unpublish afterwards is exactly the sort of thing a bug report outlives. `isLinkable` is
 * `publishedVersionId` and never `publishedAt`, which is this project's standing rule about two
 * independent nullable columns.
 */
test("a live page with no published version is found, not deleted, and not linkable", async () => {
  const f = await fixture();
  const unpublished = await f.page({ slug: "draft", title: "Never published", published: false });
  await f.report({ summary: "unpublished", pageId: unpublished.id, spaceId: f.engineering.id });

  const { reports } = await listed(f.admin);
  const page = bySummary(reports, "unpublished").page;
  if (page.kind !== "found") throw new Error("expected the page row to be found");
  expect(page).toMatchObject({ title: "Never published", deleted: false, isLinkable: false });
});

/**
 * A report with no page captured at all — the space landing page, `/search`, `/systems`.
 *
 * `none` and not `absent`, because they answer different questions: nothing was ever captured
 * against this report, and that is not the same as a capture that no longer resolves. A surface
 * that showed both as "the page is gone" would invent a page that never existed.
 */
test("a report with no captured page reads as none, and still renders its route", async () => {
  const f = await fixture();
  await f.report({ summary: "no page", spaceId: f.engineering.id, routePath: "/engineering" });

  const { reports } = await listed(f.admin);
  expect(bySummary(reports, "no page").page).toEqual({ kind: "none" });
  expect(bySummary(reports, "no page").routePath).toBe("/engineering");
});

/**
 * `versionId` is carried and deliberately **not** resolved.
 *
 * A `PageVersion` cascades from its `Page` and nothing in this product deletes one on its own, so
 * "is the captured version still on record" has the same answer as "is the captured page still on
 * record" — a second query whose result is implied by the first is the untestable duplicate this
 * project keeps finding. What the surface owes is the id itself, which is what a triager pastes
 * into a query, and the assertion is that it survives a page that does not.
 */
test("the captured version id is carried through even when its page is absent", async () => {
  const f = await fixture();
  await f.report({
    summary: "version",
    pageId: "cnosuchpage000000000000",
    versionId: "cnosuchversion000000000",
  });

  const { reports } = await listed(f.admin);
  expect(bySummary(reports, "version").versionId).toBe("cnosuchversion000000000");
  expect(bySummary(reports, "version").page.kind).toBe("absent");
});

/**
 * **`reporterId` is the one captured identifier that cannot dangle**, and this is the assertion
 * that keeps the module honest about not defending against it.
 *
 * The Phase 1 `bug_report_retention` migration dropped the foreign key and re-added it with
 * `ON DELETE RESTRICT`, so the database refuses to remove a reporter who has filed anything. A
 * null-guard on `report.reporter` would therefore be a branch no state can reach — Task 1 declined
 * one on the same ground — and the honest way to say so is to assert the refusal rather than to
 * write the guard and leave it uncovered.
 */
test("the database refuses to delete a reporter, which is why nothing here guards for one", async () => {
  const f = await fixture();
  await f.report({ summary: "filed" });

  await expect(db.user.delete({ where: { id: f.reporter.id } })).rejects.toThrow();

  // Non-vacuity: a user who has filed nothing deletes cleanly, so the refusal above is the
  // reference and not a `User` row that can never be removed at all.
  const nobody = await db.user.create({ data: { email: "nobody@example.com", name: "Nobody" } });
  await db.user.delete({ where: { id: nobody.id } });

  const { reports } = await listed(f.admin);
  expect(reports[0]).toMatchObject({
    reporterName: "Aisyah R.",
    reporterEmail: "aisyah@example.com",
  });
});

/* -------------------------------------------------------------------------- */
/* The list: order, counts, filter, truncation                                 */
/* -------------------------------------------------------------------------- */

test("reports come back newest first, with counts over the whole table", async () => {
  const f = await fixture();
  await f.report({ summary: "oldest", createdAt: new Date("2026-08-01T09:00:00Z") });
  await f.report({
    summary: "middle",
    status: "TRIAGED",
    createdAt: new Date("2026-08-02T09:00:00Z"),
  });
  await f.report({
    summary: "newest",
    status: "CLOSED",
    createdAt: new Date("2026-08-03T09:00:00Z"),
  });

  const result = await listed(f.admin);
  expect(result.reports.map((row) => row.summary)).toEqual(["newest", "middle", "oldest"]);
  expect(result.counts).toEqual({ NEW: 1, TRIAGED: 1, CLOSED: 1 });
  expect(result.status).toBeNull();
  expect(result.truncated).toBe(false);
});

/**
 * The filter narrows the list and leaves the counts alone.
 *
 * Both halves in one assertion, because the counts are what the filter's own controls are labelled
 * with: a count that moved with the filter would leave a triager looking at `NEW 1` on a page
 * where two other reports exist and nothing said so.
 */
test("a status filter narrows the rows and not the counts", async () => {
  const f = await fixture();
  await f.report({ summary: "open", status: "NEW" });
  await f.report({ summary: "seen", status: "TRIAGED" });
  await f.report({ summary: "done", status: "CLOSED" });

  const result = await listed(f.admin, { status: "TRIAGED" });
  expect(result.reports.map((row) => row.summary)).toEqual(["seen"]);
  expect(result.status).toBe("TRIAGED");
  expect(result.counts).toEqual({ NEW: 1, TRIAGED: 1, CLOSED: 1 });
});

test("a state with no rows is a zero rather than a missing count", async () => {
  const f = await fixture();
  await f.report({ summary: "open" });

  const result = await listed(f.admin);
  expect(result.counts).toEqual({ NEW: 1, TRIAGED: 0, CLOSED: 0 });
});

test("an empty table lists nothing, counts zeroes, and does not throw", async () => {
  const f = await fixture();
  const result = await listed(f.admin);
  expect(result.reports).toEqual([]);
  expect(result.counts).toEqual({ NEW: 0, TRIAGED: 0, CLOSED: 0 });
  expect(result.truncated).toBe(false);
});

/**
 * The rendering bound, with the `take: cap + 1` shape that knows about truncation without a second
 * count — `search()`'s and `listMirrorFailures`'s.
 *
 * The non-vacuity half is the exact length: a list that came back empty, or short for some other
 * reason, would satisfy `truncated === true` on its own.
 */
test("more reports than the cap are cut short, and the surface is told", async () => {
  const f = await fixture();
  await db.bugReport.createMany({
    data: Array.from({ length: MAX_BUG_REPORTS + 1 }, (_unused, index) => ({
      reporterId: f.reporter.id,
      summary: `Report ${index}`,
      routePath: "/engineering",
      appVersion: "0.1.0",
      userAgent: "Mozilla/5.0",
      viewport: "1440x900",
    })),
  });

  const result = await listed(f.admin);
  expect(result.reports).toHaveLength(MAX_BUG_REPORTS);
  expect(result.truncated).toBe(true);
  // The counts are over the table and not over the page, so they see the row the list cut.
  expect(result.counts.NEW).toBe(MAX_BUG_REPORTS + 1);
});

/* -------------------------------------------------------------------------- */
/* Triage                                                                      */
/* -------------------------------------------------------------------------- */

test("a triage moves the status and reports what it was", async () => {
  const f = await fixture();
  const filed = await f.report({ status: "NEW" });

  const result = await triage(f.admin, filed.id, "TRIAGED");
  expect(result).toMatchObject({ id: filed.id, status: "TRIAGED", previousStatus: "NEW" });

  const after = await db.bugReport.findUniqueOrThrow({
    where: { id: filed.id },
    select: { status: true },
  });
  expect(after.status).toBe("TRIAGED");
});

/**
 * **Any status from any other, including backwards**, and the reason is at the module docstring:
 * a one-way `NEW → TRIAGED → CLOSED` makes a mis-clicked `CLOSED` permanent on a table with no
 * other repair surface. A reopen is one press.
 *
 * The walk is asserted as a sequence rather than as three separate calls, because what is being
 * pinned is that no transition is refused *given the one before it* — which is what a state
 * machine would break and three independent calls from `NEW` would not notice.
 */
test("a closed report can be reopened, and every step records what it moved from", async () => {
  const f = await fixture();
  const filed = await f.report({ status: "NEW" });

  expect((await triage(f.admin, filed.id, "CLOSED")).previousStatus).toBe("NEW");
  expect((await triage(f.admin, filed.id, "TRIAGED")).previousStatus).toBe("CLOSED");
  expect((await triage(f.admin, filed.id, "NEW")).previousStatus).toBe("TRIAGED");

  const rows = await auditRows("bug.triage");
  expect(rows.map((row) => (row.detail as { status?: string }).status)).toEqual([
    "CLOSED",
    "TRIAGED",
    "NEW",
  ]);
});

/**
 * The audit row, and it is `page.review`'s argument arriving on another single mutable column.
 *
 * **Spaceless and pageless**, deliberately: the report captures a `spaceId` and a `pageId` without
 * foreign keys, and `AuditLog.spaceId` has none either — so copying one across would be *accepted*
 * by the database and would put an unverified capture in the column eleven other actions fill with
 * a `Space.id` read in the same transaction. The fixture gives this report a real space precisely
 * so the assertion is about the decision and not about there being nothing to copy.
 */
test("a triage writes one spaceless, pageless bug.triage row carrying both statuses", async () => {
  const f = await fixture();
  const live = await f.page({ slug: "live", title: "Live page" });
  const filed = await f.report({
    status: "NEW",
    spaceId: f.engineering.id,
    pageId: live.id,
  });

  await triage(f.admin, filed.id, "CLOSED");

  const rows = await auditRows("bug.triage");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.root.id, spaceId: null, pageId: null });
  expect(rows[0]?.detail).toEqual({
    reportId: filed.id,
    status: "CLOSED",
    previousStatus: "NEW",
  });
});

/**
 * Setting the status a report already has still writes a row — `mirror.sweep`'s standing: an
 * operator pressed the button, and *"was this ever done"* is the question the row answers.
 *
 * Not reachable from the surface, where the current status is not a pressable control, and
 * reachable from the endpoint, which is why it is pinned here rather than in the e2e spec.
 */
test("re-asserting the same status is accepted and still recorded", async () => {
  const f = await fixture();
  const filed = await f.report({ status: "TRIAGED" });

  const result = await triage(f.admin, filed.id, "TRIAGED");
  expect(result).toMatchObject({ status: "TRIAGED", previousStatus: "TRIAGED" });
  expect(await auditRows("bug.triage")).toHaveLength(1);
});

test("triaging a report that does not exist is not-found, and writes nothing", async () => {
  const f = await fixture();
  expect(await setBugStatus(f.admin, "cnosuchreport0000000000", "CLOSED")).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await db.auditLog.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* The audit line, as the discrimination Task 7 pinned it with                 */
/* -------------------------------------------------------------------------- */

/**
 * **Task 7's line, and the same shape of assertion.**
 *
 * Its reconcile report over a `MEMBERS` space the admin does not belong to writes **0**
 * `space.access` rows while the failures list over the same space in the same test writes **1**.
 * Here the list is the one that writes and the triage is the one that does not, and the two calls
 * are about the same report:
 *
 * - {@link listBugReports} paints a route inside the space, the **title** of a page in it, and the
 *   **name and email of the person who was reading it**. The first two are exactly what
 *   `listMirrorFailures` audits for; the third is what `listSpaceMembers` audits for. One row
 *   covers both observables.
 * - {@link setBugStatus} names one report by id and enumerates nothing — `mirror.reconcile`'s
 *   standing.
 *
 * `handbook` is `ALL_STAFF` and contributes none however many reports it produced, which is
 * `needsAccessAudit` being **called** rather than copied. Removing the loop at the end of
 * `listBugReports` fails the first half with `expected [] to have a length of 1`.
 */
test("listing audits the MEMBERS space it read; triaging the same report audits nothing", async () => {
  const f = await fixture();
  const closed = await f.page({ slug: "closed", title: "Closed page" });
  const open = await f.page({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: "Welcome",
  });
  const filed = await f.report({
    summary: "in a members space",
    spaceId: f.engineering.id,
    pageId: closed.id,
  });
  await f.report({
    summary: "in an all-staff space",
    spaceId: f.handbook.id,
    pageId: open.id,
  });

  await inOneRequest(async () => {
    const result = await listed(f.admin);
    expect(result.reports).toHaveLength(2);
  });

  const access = await auditRows("space.access");
  expect(access).toHaveLength(1);
  expect(access[0]?.spaceId).toBe(f.engineering.id);
  expect(access[0]?.detail).toEqual({
    key: "engineering",
    visibility: "MEMBERS",
    by: "super-admin",
  });

  await inOneRequest(async () => {
    await triage(f.admin, filed.id, "TRIAGED");
  });
  // Still one: the triage added none. The row above is what proves the audit fires at all, so this
  // is a discrimination and not an absence.
  expect(await auditRows("space.access")).toHaveLength(1);
});

/**
 * A report whose captured space no longer resolves audits nothing, and cannot throw.
 *
 * There is no space to have been read into — `auditSpaceAccess` needs an id, a key and a
 * visibility, and a dangling capture has none of the last two. The live report in the same call is
 * the non-vacuity companion.
 */
test("a dangling captured space produces no access row, and does not stop the one beside it", async () => {
  const f = await fixture();
  await f.report({ summary: "dangling", spaceId: "cnosuchspace00000000000" });
  await f.report({ summary: "real", spaceId: f.engineering.id });

  await inOneRequest(async () => {
    expect((await listed(f.admin)).reports).toHaveLength(2);
  });

  const access = await auditRows("space.access");
  expect(access).toHaveLength(1);
  expect(access[0]?.spaceId).toBe(f.engineering.id);
});

/* -------------------------------------------------------------------------- */
/* The filter parser, pure                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A query string is a view and not an identity, so an unrecognised one is **ignored** rather than
 * refused: `?status=banana` shows the unfiltered list rather than claiming the page does not
 * exist. The repeated-parameter case arrives as an array from Next and is ignored for the same
 * reason — two filters is not a filter.
 */
test("the status filter reads the three statuses and ignores everything else", () => {
  expect(parseBugStatusFilter("NEW")).toBe("NEW");
  expect(parseBugStatusFilter("TRIAGED")).toBe("TRIAGED");
  expect(parseBugStatusFilter("CLOSED")).toBe("CLOSED");

  expect(parseBugStatusFilter(undefined)).toBeNull();
  expect(parseBugStatusFilter("")).toBeNull();
  expect(parseBugStatusFilter("banana")).toBeNull();
  // Case matters: the enum is what the column holds, and a case-folding parser here would be a
  // second, looser statement of what a `BugStatus` is.
  expect(parseBugStatusFilter("new")).toBeNull();
  /*
   * **Prototype keys are not statuses, and this assertion caught a real defect.** The first
   * version of the parser was `raw in BugStatus`, which is the spelling that reads best — and
   * Prisma's generated enum is an ordinary object literal, so it inherits `Object.prototype` and
   * `"toString" in BugStatus` is `true`. `?status=toString` would have reached Prisma as
   * `where: { status: "toString" }`. Fixed to a membership test over the values, which is the
   * question the function is asking.
   */
  expect(parseBugStatusFilter("toString")).toBeNull();
  expect(parseBugStatusFilter("constructor")).toBeNull();
  expect(parseBugStatusFilter(["NEW", "CLOSED"])).toBeNull();
});
