import { BugStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { refuseNonAdmin, type AdminRefusal } from "@/lib/admin/gate";
import { auditSpaceAccess, writeAudit } from "@/lib/audit/log";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

/**
 * `/admin/bugs` — spec §11's fourth administration surface and §18.2's *"listed for admins at
 * `/admin/bugs`"*, Phase 7 Task 8. **The first thing in this product that reads a `BugReport`
 * row back.**
 *
 * Phase 1 shipped bug *reporting* — the rail button, the dialog, the endpoint, the derived
 * context — and nothing has ever read the table since. So two things are new here rather than
 * copied: a mutation on a table whose only previous writer was the reporter, and a list whose
 * captured context is **allowed to name rows that are not there**.
 *
 * ## Triage is the three statuses that already exist, and `BugStatus` is not widened
 *
 * §18.2 fixes the vocabulary — *"a `BugReport` row with status `NEW | TRIAGED | CLOSED`"* — and
 * this task takes it as given rather than as a starting point. The temptation is a fourth value
 * splitting `CLOSED` into *fixed*, *won't fix* and *duplicate*, and it is declined on three
 * grounds, in the order they bind:
 *
 * 1. **The spec's own sentence two paragraphs above the enum**: *"This is a signal channel, not a
 *    support system: no threading, no replies, no notifications in alpha."* A resolution taxonomy
 *    is the first column of a support system, and the three states answer the question a signal
 *    channel asks — *has anybody looked at this, and is it still open*.
 * 2. **Task 1's precedent, which is this project's rule for a normative enum.** It found
 *    `SystemKind` too narrow (§5.2 has no value for a web application), recorded the gap, and
 *    left the enum alone rather than widening a spec enum unilaterally. Same standing here, and
 *    the gap is smaller.
 * 3. **A fourth value would not answer the question it looks like it answers.** *Why* a report
 *    was closed is prose, not an enum — "duplicate of which one" and "won't fix because" are the
 *    two things a triager writes down, and neither fits in a status. The shape that would answer
 *    it is a nullable `resolution` text column, which is a migration, and Task 8 was told to make
 *    none. **Stated as a gap rather than half-built**: today the durable record of a closure is
 *    the `bug.triage` audit row — who moved it and when — and it carries no reason.
 *
 * There is deliberately **no transition graph** either. Any of the three may be set from any
 * other, because the state machine somebody would write here (`NEW → TRIAGED → CLOSED`, one way)
 * makes a mis-clicked `CLOSED` permanent on a table with no other repair surface — Task 5's
 * argument for allowing a `System.key` rename, arriving on a column with even less behind it. A
 * reopen is `CLOSED → TRIAGED`, and it is one press.
 *
 * ## The captured context may dangle, and two of the ways it can are different facts
 *
 * `BugReport.spaceId`, `pageId` and `versionId` carry **no foreign keys**, and the schema says at
 * length why: their value is highest when the referenced page is gone, so `SetNull` would erase
 * the only clue and `Restrict`/`Cascade` would block the deletion or destroy the report.
 * `routePath` is the durable breadcrumb. What that buys the writer, it charges the reader: this
 * module must resolve ids that may resolve to nothing, and must not throw when they do.
 *
 * Two states look alike and are not:
 *
 * - **Soft-deleted** — the `Page` row exists and `deletedAt` is set. Recoverable: `restorePage`
 *   brings the page, its URL and its mirror file back, so the report is about a document that
 *   still exists and is currently taken down.
 * - **Absent** — no row at all. Not recoverable, and the captured id is the last trace that the
 *   page was ever there.
 *
 * They are separate {@link BugPage} kinds rather than one "gone" for that reason. **Absent is not
 * reachable through this product today**: nothing hard-deletes a `Page`, a `Space` or a
 * `PageVersion` — `deletePage` sets `deletedAt`, and Task 6 declined to build a space delete at
 * all. So the absent case is reached in a fixture, and it is worth having because the ids are
 * unconstrained by construction: a restore from a partial backup, a `DELETE` run by hand, or a
 * future hard delete would each produce it, and the schema's comment is an instruction to readers
 * to tolerate exactly this.
 *
 * `versionId` is carried through and **not resolved**, deliberately. A `PageVersion` cascades from
 * its `Page` and nothing in this product deletes one on its own, so "is the captured version still
 * on record" has the same answer as "is the captured page still on record" — a second query whose
 * result is implied by the first is the untestable duplicate this project keeps finding. The id is
 * shown as captured evidence beside the route, which is what a triager pastes into a query.
 *
 * ## `routePath` is never an `href`, and that is a security line rather than a style one
 *
 * It is the one field on this row the **client** supplies and the wire schema does not constrain
 * beyond a length (`src/lib/bugs/schema.ts`: `z.string().min(1).max(2000)`), so a report can carry
 * `javascript:…` in it as easily as `/engineering/architecture`. Rendering it as a link would be
 * script execution in an admin's browser — the same shape `repoField` refuses on the way into
 * `System.repoUrl`, and the reason that refusal covers *every* `withheld` reason and not only
 * credentials. So `routePath` is text, always, and the only link on this surface is built from a
 * **resolved page's** `spaceKey` and `path` through `pageHref`.
 *
 * ## Whether a report links to its page: yes, and only when the link works
 *
 * A link to a soft-deleted or absent page is a dead end — the reader route needs a live page with
 * a published version and 404s otherwise — and a dead end offered by an admin surface is worse
 * than no link, because the triager cannot tell a broken product from a taken-down page. A link to
 * a live published page is the whole reason the id was captured. So {@link BugPage} carries
 * `isLinkable`, true only for a live page that has a `publishedVersionId`, and the state is named
 * on the row in the two cases where it is false.
 *
 * The unpublished case is real rather than defensive: `resolveReportContext` sets `pageId` only
 * through `getPublishedPage`, so every captured page **was** published when the report was filed,
 * and an unpublish since is exactly the sort of thing a bug report outlives.
 *
 * ## The permission, and the two absences
 *
 * `refuseNonAdmin`, once, from `src/lib/admin/gate.ts` — `src/lib/admin/gate.test.ts` sweeps every
 * `admin.ts` under `src/lib/` and sees this module without being told about it.
 *
 * - **No `readableSpace`.** `readableSpaceWhere` answers `{}` for a super admin, the only viewer
 *   past the gate, so it would be a filter no test could be written against — the `resolveRedirect`
 *   shape. It would also be wrong: a report filed against a space the admin does not belong to is
 *   still a bug in this installation, and an inbox with a blind spot is one nobody can trust to be
 *   empty.
 * - **No `visiblePage`.** This one is *load-bearing rather than merely inert*, and it is the whole
 *   of Step 2: `deletedAt: null` on the page resolution would turn every soft-deleted page into an
 *   **absent** one, collapsing the two facts this surface exists to tell apart. A recoverable
 *   document and a lost one would read identically, and the recoverable one would read as the
 *   lost one — the direction that loses information. Mutation-verified in
 *   `tests/integration/bugs-admin.test.ts`.
 *
 * `reporterId` is the opposite case and gets **no defence at all**: it is the one captured
 * identifier with a foreign key (`ON DELETE RESTRICT`, dropped and re-added by the Phase 1
 * `bug_report_retention` migration), so a reporter cannot dangle and a guard for one could never
 * fire. Task 1 declined a guard on the same ground, and the test that keeps this claim honest
 * asserts the database's refusal rather than restating it here.
 *
 * ## The audit line: the list writes `space.access`, the triage writes none
 *
 * Task 7 drew it as *containers and integers need no row; titles and paths do*, and asserted it as
 * a discrimination on one page — its reconcile report over a `MEMBERS` space the admin does not
 * belong to writes **0** rows while the failures list over the same space in the same test writes
 * **1**. This surface lands on the same side as the failures list, and more heavily:
 *
 * - {@link listBugReports} paints a **route path inside a space**, the **title** of a page in it,
 *   and the **name and email of the person who was reading it**. The first two are the pair
 *   `listMirrorFailures` audits for; the third is what `listSpaceMembers` audits for — *this named
 *   person could read this private space* — so one row covers both observables.
 * - {@link setBugStatus} names one report by id and enumerates nothing. The triager read the route
 *   on the list, which is where the row was written; pressing a button reveals nothing further.
 *   That is `mirror.reconcile`'s standing exactly.
 *
 * One row per space that produced a listed report, `search()`'s rule, with `auditSpaceAccess`
 * owning both the decision (`needsAccessAudit`, so an `ALL_STAFF` space contributes none) and the
 * per-request dedupe. A report whose captured space resolves to nothing produces no row, because
 * there is no space to have been read into — and a report with no captured space at all
 * (`/search`, `/systems`, an unrecognised route) produces none for the same reason.
 *
 * The one place this over-reports is a report captured against a space **root** — a route naming
 * the space and no page. That still writes a row, because the rule is "a space produced a listed
 * report" and not "a page title was painted", and `src/lib/audit/log.ts` is explicit that
 * over-reporting is the only direction an audit may fail in.
 */

/**
 * The most reports one page renders.
 *
 * A rendering bound like `MAX_MIRROR_FAILURES` and `MAX_BLOCKING_PAGES`, and the same argument
 * for the size: a deployment with more than two hundred untriaged reports has a process problem
 * rather than a list, and the status filter above the list is the tool for it. Unlike a mirror
 * failure there is no per-page barrier making the population self-limiting, so the surface says
 * the list is short rather than pretending it is whole.
 */
export const MAX_BUG_REPORTS = 200;

/**
 * The space a report was filed from, as it resolves **now**.
 *
 * Three kinds, and the middle one is the point of the type: `BugReport.spaceId` has no foreign
 * key, so an id that names no row is a legal state of a legal row rather than corruption.
 */
export type BugSpace =
  /** No space was captured. `/search`, `/systems`, `/admin/*`, or a route that resolved to none. */
  | { kind: "none" }
  /**
   * The captured id names no `Space`. Not reachable through this product — Task 6 declined to
   * build a space delete, and nothing else removes one — so this arrives from a fixture, a
   * partial restore or a hand-run statement. It renders as the id, with `routePath` beside it.
   */
  | { kind: "absent"; spaceId: string }
  | { kind: "found"; spaceId: string; key: string; name: string };

/**
 * The page a report was filed from, as it resolves **now** — Step 2's three states.
 *
 * `found` carries `deleted` as a flag rather than being split in two, which is the shape
 * `MirrorFailure.pageDeleted` and `BlockingPage.deleted` already use: the row is there either way
 * and the flag is what an operator reads. `absent` is a different kind because there is no row to
 * carry a flag on — no title, no path, no space, nothing but the id the reporter's browser was
 * standing on.
 */
export type BugPage =
  /** No page was captured: a space landing page, a route with no page, or an unresolved one. */
  | { kind: "none" }
  /**
   * The captured id names no `Page`. **Unreachable through the product today** — `deletePage` is a
   * soft delete and there is no hard one — so it is reached in a fixture. It renders as the id
   * with `routePath` as the breadcrumb, which is exactly the state the schema comment says the
   * missing foreign key exists to preserve.
   */
  | { kind: "absent"; pageId: string }
  | {
      kind: "found";
      pageId: string;
      /** The page's space and path **now**, not the ones the route recorded: a link has to work today. */
      spaceKey: string;
      path: string;
      title: string;
      /** Soft-deleted. Recoverable — which is the whole difference from `absent`. */
      deleted: boolean;
      /**
       * A reader link would resolve. Live **and** published: the reader route requires a published
       * version and 404s without one, and this surface does not offer 404s.
       */
      isLinkable: boolean;
    };

/** One report as a triager sees it. Everything captured, plus what the captured ids resolve to. */
export type AdminBugReport = {
  id: string;
  status: BugStatus;
  /** The reporter's words, stored raw and encoded at output — Phase 1's decision, unchanged. */
  summary: string;
  expected: string | null;
  /**
   * The route the reporter was on, **as text and never as a link**. Client-supplied and bounded
   * only by a length; see the module docstring for why an `href` here would be script execution.
   */
  routePath: string;
  space: BugSpace;
  page: BugPage;
  /** Captured evidence, deliberately unresolved — see the module docstring. */
  versionId: string | null;
  appVersion: string;
  gitSha: string | null;
  userAgent: string;
  viewport: string;
  /**
   * Pasted console output, bounded at 5000 characters by `src/lib/bugs/schema.ts`.
   *
   * At that length it is the unbreakable-token overflow shape at scale — the class this project
   * has now met **nine** times — so the surface renders it in a box that both preserves newlines
   * and breaks a line that has none, which is `.mir-err`'s pairing and for the identical reason.
   */
  consoleError: string | null;
  /**
   * Who filed it. `reporterId` is the one captured identifier with a foreign key, so this cannot
   * be null and needs no fallback — see the module docstring.
   */
  reporterName: string;
  reporterEmail: string;
  createdAt: Date;
  /** `BugReport.updatedAt` — which, for a row nothing else writes, is when it was last triaged. */
  updatedAt: Date;
};

/** How many reports are in each state, over the **whole** table rather than the filtered page. */
export type BugStatusCounts = Record<BugStatus, number>;

export type BugReportsResult =
  | {
      ok: true;
      reports: AdminBugReport[];
      /** More than {@link MAX_BUG_REPORTS} matched; the list is short. */
      truncated: boolean;
      counts: BugStatusCounts;
      /** The filter in force, echoed so the surface renders the current tab without re-parsing. */
      status: BugStatus | null;
    }
  | AdminRefusal;

/**
 * Reads a `status` query parameter into a filter, and never refuses.
 *
 * An unknown value is **ignored** rather than 404ing the page: a query string is a view of a
 * resource and not its identity, so `?status=banana` shows the unfiltered list rather than
 * claiming `/admin/bugs` does not exist. A repeated parameter (`?status=NEW&status=CLOSED`)
 * arrives as an array and is ignored for the same reason — two filters is not a filter.
 *
 * Pure, and exported so the route does not grow its own copy of the enum check.
 */
export function parseBugStatusFilter(raw: string | string[] | undefined): BugStatus | null {
  if (typeof raw !== "string") return null;
  /*
   * `Object.values(...).includes` and **not** `raw in BugStatus`, which is the spelling to reach
   * for and is wrong: Prisma's generated enum is an ordinary object literal, so it inherits
   * `Object.prototype` and `"toString" in BugStatus` is `true`. That would let `?status=toString`
   * through as a `BugStatus`, and the query below would then be `where: { status: "toString" }` —
   * a Prisma error rather than a filter. A membership test over the values is the question this
   * function is actually asking.
   */
  return (Object.values(BugStatus) as string[]).includes(raw) ? (raw as BugStatus) : null;
}

/** Every status at zero, so a state with no rows is a `0` on the surface and not a missing tab. */
function emptyCounts(): BugStatusCounts {
  return { NEW: 0, TRIAGED: 0, CLOSED: 0 };
}

/**
 * The reports, newest first, with what their captured context resolves to today.
 *
 * ## Four queries, and none of them is a permission predicate
 *
 * The list, the whole-table counts, and one resolution each for the captured spaces and pages.
 * The two resolutions are `IN` lookups over ids **this function just read from rows the guard
 * above authorised** — nothing caller-supplied reaches them — which is the standing
 * `listPageVersions` and `listMirrorFailures` both state for their second queries: a second copy
 * of a predicate that cannot fail would make neither copy testable.
 *
 * The counts are deliberately over the whole table and not over the filter. They are what the
 * filter's own controls are labelled with, so a count that moved with the filter would leave a
 * triager unable to see that anything else exists.
 */
export async function listBugReports(
  viewer: Viewer,
  options: { status?: BugStatus | null } = {},
): Promise<BugReportsResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const status = options.status ?? null;

  const rows = await db.bugReport.findMany({
    where: status === null ? {} : { status },
    /*
     * Newest first, `id` breaking the tie for `listPageVersions`'s reason: two reports in the same
     * millisecond is a fixture rather than a product event, and a list that reorders itself
     * between two requests for no visible reason is worse than an arbitrary but fixed tiebreak.
     *
     * `@@index([status, createdAt])` serves the equality when a filter is in force; unfiltered
     * this is a sort of the whole table, which {@link MAX_BUG_REPORTS} bounds the *output* of and
     * not the work. That is accepted at the scale §19 states (low hundreds of staff) and is worth
     * saying rather than implying the index covers both.
     */
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One more than the cap, so truncation is known without a second count — `search()`'s shape.
    take: MAX_BUG_REPORTS + 1,
    // Explicit select, never `include`.
    select: {
      id: true,
      status: true,
      summary: true,
      expected: true,
      routePath: true,
      spaceId: true,
      pageId: true,
      versionId: true,
      appVersion: true,
      gitSha: true,
      userAgent: true,
      viewport: true,
      consoleError: true,
      createdAt: true,
      updatedAt: true,
      // Through the relation, which is the one captured identifier that has one.
      reporter: { select: { name: true, email: true } },
    },
  });

  const truncated = rows.length > MAX_BUG_REPORTS;
  const kept = rows.slice(0, MAX_BUG_REPORTS);

  const spaceIds = [...new Set(kept.flatMap((row) => (row.spaceId === null ? [] : [row.spaceId])))];
  const pageIds = [...new Set(kept.flatMap((row) => (row.pageId === null ? [] : [row.pageId])))];

  const [grouped, spaceRows, pageRows] = await Promise.all([
    db.bugReport.groupBy({ by: ["status"], _count: { _all: true } }),
    spaceIds.length === 0
      ? Promise.resolve([])
      : db.space.findMany({
          where: { id: { in: spaceIds } },
          // Explicit select. `visibility` is here for `auditSpaceAccess`, which decides whether
          // any row is written at all; `name` is what the surface paints beside the key.
          select: { id: true, key: true, name: true, visibility: true },
        }),
    pageIds.length === 0
      ? Promise.resolve([])
      : db.page.findMany({
          /*
           * **No `visiblePage()` and no `readableSpace()`**, both deliberate and both changing
           * what this returns — see the module docstring. `deletedAt` is *selected* rather than
           * filtered on, which is the entire mechanism by which a soft-deleted page reads as
           * recoverable instead of as gone.
           */
          where: { id: { in: pageIds } },
          select: {
            id: true,
            path: true,
            title: true,
            deletedAt: true,
            publishedVersionId: true,
            space: { select: { id: true, key: true, visibility: true } },
          },
        }),
  ]);

  const counts = emptyCounts();
  for (const group of grouped) counts[group.status] = group._count._all;

  const spaces = new Map(spaceRows.map((row) => [row.id, row]));
  const pages = new Map(pageRows.map((row) => [row.id, row]));

  const reports: AdminBugReport[] = kept.map((row) => {
    const space = row.spaceId === null ? null : (spaces.get(row.spaceId) ?? null);
    const page = row.pageId === null ? null : (pages.get(row.pageId) ?? null);

    return {
      id: row.id,
      status: row.status,
      summary: row.summary,
      expected: row.expected,
      routePath: row.routePath,
      space:
        row.spaceId === null
          ? { kind: "none" }
          : space === null
            ? { kind: "absent", spaceId: row.spaceId }
            : { kind: "found", spaceId: space.id, key: space.key, name: space.name },
      page:
        row.pageId === null
          ? { kind: "none" }
          : page === null
            ? { kind: "absent", pageId: row.pageId }
            : {
                kind: "found",
                pageId: page.id,
                spaceKey: page.space.key,
                path: page.path,
                title: page.title,
                deleted: page.deletedAt !== null,
                // Published *and* live. Two independent nullable columns decide nothing here —
                // `publishedVersionId` is the one this project's rule names, never `publishedAt`.
                isLinkable: page.deletedAt === null && page.publishedVersionId !== null,
              },
      versionId: row.versionId,
      appVersion: row.appVersion,
      gitSha: row.gitSha,
      userAgent: row.userAgent,
      viewport: row.viewport,
      consoleError: row.consoleError,
      reporterName: row.reporter.name,
      reporterEmail: row.reporter.email,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });

  /*
   * Spec §8's super-admin trace — one row per space that produced a listed report, whether the
   * space came from the report's own capture or from the page it resolved to. The two agree in
   * every row this product can write (`resolveReportContext` sets `pageId` only after resolving
   * the space it belongs to, and nothing moves a page between spaces), and they are gathered
   * together anyway rather than one being derived from the other: an id with no foreign key is
   * not an id whose agreement with another column may be assumed.
   *
   * `auditSpaceAccess` owns the decision (`needsAccessAudit`, so an `ALL_STAFF` space contributes
   * none), owns the per-request dedupe, and cannot throw.
   */
  const readFrom = new Map<string, SpaceRef & { key: string }>();
  for (const row of spaceRows) readFrom.set(row.id, row);
  for (const row of pageRows) readFrom.set(row.space.id, row.space);
  for (const space of readFrom.values()) await auditSpaceAccess(viewer, space);

  return { ok: true, reports, truncated, counts, status };
}

export type BugTriageResult =
  | {
      ok: true;
      id: string;
      status: BugStatus;
      /** What it was. Always a `BugStatus` — the column is `NOT NULL` with a default. */
      previousStatus: BugStatus;
    }
  | AdminRefusal;

/**
 * Move one report between the three states §18.2 gives it. The only mutation on this surface.
 *
 * ## It is audited, and the argument is `page.review`'s
 *
 * A status change **leaves no other trace**. `BugReport.status` is a single mutable column, so the
 * next triage overwrites the record of this one; `updatedAt` moves with it and says *when*
 * something happened, never *who* or *from what*. Without a row here, "who closed this, and when,
 * and was it ever triaged before somebody reopened it" is answerable only for the most recent
 * press — which is the exact shape Task 4 used to justify auditing `page.review`, arriving on a
 * table that until now had no audited mutation at all. PROGRESS records bug reporting as *"the one
 * mutation in the product that writes no audit row"*; the report is still unaudited, and the
 * triage is not.
 *
 * The row is written in the same transaction as the change, because an audit row that is not
 * committed with the change it describes is a lie either way it fails.
 *
 * ## The row is spaceless and pageless, and the reason is the missing foreign keys
 *
 * `bug.triage` joins `system.*` and `mirror.*` in naming no space. It would be easy to copy
 * `BugReport.spaceId` into `AuditLog.spaceId` — that column has no foreign key either, so nothing
 * would stop it — and it would put a **different kind of value** in the one column an auditor
 * filters by: eleven actions fill it with a `Space.id` read in the same transaction, and this one
 * would fill it with an id captured from a route months earlier that may name nothing. `pageId` is
 * out for the sharper version of the same reason: everywhere else it means *this happened to that
 * page*, and triaging a report is not something that happens to a page.
 *
 * What the detail carries instead is the report's id, which resolves to a row that is never
 * deleted and holds every captured value — so nothing is lost by not copying them.
 *
 * ## No transition rule, and no pre-check
 *
 * Any status may be set from any other; see the module docstring. Setting the status a report
 * already has is accepted and **still writes a row**, `mirror.sweep`'s standing: the operator
 * pressed the button and *"was this ever done"* is the question the row answers. A `previousStatus`
 * equal to the new one is the honest record of that, and a conditional write would be a branch
 * whose only observable is an audit row that is missing.
 */
export async function setBugStatus(
  viewer: Viewer,
  reportId: string,
  status: BugStatus,
): Promise<BugTriageResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  return await db.$transaction(async (tx) => {
    const before = await tx.bugReport.findUnique({
      where: { id: reportId },
      // Explicit select, never `include`. Read inside the transaction so `previousStatus`
      // describes the same instant the write replaced.
      select: { id: true, status: true },
    });
    // The same answer as "you may not look", byte for byte — one shape for a miss and a refusal,
    // which is `listBlockingPages`'s and `updateSystem`'s.
    if (before === null) return { ok: false, reason: "not-found" } as const;

    await tx.bugReport.update({
      where: { id: reportId },
      data: { status },
      select: { id: true },
    });

    await writeAudit(tx, {
      actorId: viewer.id,
      // Null, deliberately — see the docstring. A captured id without a foreign key does not
      // belong in the column every other action fills with a verified one.
      spaceId: null,
      action: "bug.triage",
      detail: {
        reportId: before.id,
        status,
        /*
         * Never absent, `previousReviewedAt`'s and `previousKey`'s distinction: an omitted key and
         * a present one mean different things to anyone querying the column, and *what it was
         * before* is the half a single mutable column destroys.
         */
        previousStatus: before.status,
      },
    });

    return { ok: true, id: before.id, status, previousStatus: before.status } as const;
  });
}

/**
 * The wire shape of the triage request, and **shape only**.
 *
 * The split `src/lib/systems/admin.ts` and `src/lib/drafts/schema.ts` both draw: Zod answers "is
 * this JSON the right sort of object" and the module answers everything else. There is nothing
 * else to answer here — a `BugStatus` is the whole request — which is why this endpoint has one
 * field and no `SystemFieldError` equivalent: there is no form input for a sentence to sit beside.
 *
 * `z.enum(BugStatus)` takes Prisma's generated enum object rather than a retyped array of three
 * strings, so the endpoint cannot end up refusing a status the database accepts — the property
 * `systemCreateBody` states for `SystemKind`, and the one thing that would go wrong if a later
 * phase did widen §18.2's vocabulary.
 *
 * `z.strictObject`, never `z.object`.
 */
export const bugTriageBody = z.strictObject({ status: z.enum(BugStatus) });
