import type { DocStatus, DocType, Prisma, SystemKind } from "@prisma/client";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { auditSpaceAccess } from "@/lib/audit/log";
import { foldSystemKey } from "@/lib/systems/resolve";
import { SYSTEM_GROUPS, SYSTEM_GROUP_ORDER, isListedInGroup } from "@/lib/systems/groups";
import { repoLinkOf, type RepoLink } from "@/lib/systems/repo-url";
import type { Viewer } from "@/lib/authz/types";

/**
 * The two reads behind `/systems` and `/systems/[key]` — spec §7's catalogue, and the generated
 * page per system.
 *
 * ## The landmine this phase opens, and where the filter therefore lives
 *
 * Every read before this one was scoped to a space the URL named: the reader route, the nav rail,
 * the generated indexes, version history. **`/systems/[key]` aggregates across spaces by design**
 * — §7 asks it for "ADRs affecting it, its runbooks, open RFCs" from wherever they live — so a
 * query without a readable-space filter is not a slightly-too-permissive list, it is a
 * cross-space enumeration of every page title and path in the installation, served to anyone
 * signed in. `/search` is the only other read shaped like this, and Phase 4 solved it there.
 *
 * The filter is **in the query**, never after fetching. That rule is not a style preference here:
 * Phase 4 Task 3's first version applied a `byId.get(row.spaceId)` lookup whose miss skipped the
 * row, and **deleting the SQL clause left all 24 tests green**, because the TypeScript copy was
 * still refusing. Nothing in this module inspects a row and decides it does not belong.
 *
 * ## `readableSpace` is nested, not derived — and that is the difference from `search`
 *
 * `src/lib/search/query.ts` derives the readable set: one `db.space.findMany` under the real
 * predicate, whose ids are bound into `spaceId = ANY(...)`. It is easy to read that as the house
 * pattern for a cross-space read and copy it. It is not; it is a **workaround with a stated
 * cause**, and the cause is in its own docstring — *"`readableSpace` returns a Prisma `where` and
 * does not compose into raw SQL"*. Search is raw SQL because `tsvector`, `ts_rank` and
 * `ts_headline` have no Prisma expression.
 *
 * These queries are Prisma, so the predicate composes directly, nested as the `space` relation
 * filter and passed whole exactly as `where.ts` sanctions (`{ spaceId, space: readableSpace(v) }`
 * is the documented shape). Copying the derivation here would add a second round trip, a second
 * intermediate list of ids, and a `spaceId: { in: [...] }` clause that means the same thing one
 * step further from the definition — all to avoid a composition problem this module does not
 * have. Derivation exists to keep the predicate stated **once**; nesting states it once too, and
 * more directly.
 *
 * ## Stated once, for both queries, and that is deliberate
 *
 * There are two page reads below — the list and the aggregate behind the counts — and they share
 * one `pageScope()` call rather than each restating the predicate. `src/lib/lifecycle/index-read.ts`
 * has the same two queries and gives each its own `visiblePage(...)`, and its registration in
 * `visible.test.ts` has to say that both halves are asserted separately, because with the filter
 * dropped from the aggregate alone "the list is right and the `ACCEPTED 3` chip beside it counts
 * a page nobody can open". One builder makes that class of divergence unrepresentable: the two
 * `where`s differ only in the group filter passed as an extra condition, and there is exactly one
 * place the permission predicate can be deleted from.
 *
 * ## Three exclusions, each stated once
 *
 * | Rule | Where it lives | What happens if it is deleted |
 * |---|---|---|
 * | Only readable spaces | `space: readableSpace(viewer)` | a member of one space reads the other's titles |
 * | No soft-deleted pages | `visiblePage()` | a deleted page is listed, and its link 404s |
 * | No unpublished pages | `publishedVersionId: { not: null }` | an unpublished title crosses a space boundary |
 *
 * The third one needs its argument written down, because the state it excludes is not reachable
 * from the product today: `PageSystem` rows are written by `publishPage` and by nothing else, so
 * a page with a facet has been published, and no surface unsets `publishedVersionId`. What can
 * still produce it is the schema — `Page_publishedVersionId_fkey` is `ON DELETE SET NULL`, so
 * deleting a `PageVersion` row nulls it while the facet rows survive — and that is why the clause
 * is here rather than assumed. Its test constructs the state with a direct write, which is honest
 * about what is being pinned: not a bug anyone can reach through the UI, but the one row shape
 * that would put an unpublished page's title on a cross-space page. `src/lib/lifecycle/index-read.ts`
 * makes the opposite choice — it renders an unpublished page as inert text rather than hiding it —
 * and the difference is exactly the space boundary: that list is inside a space the viewer already
 * reads, and this one is not.
 *
 * ## The audit, reusing the one rule rather than re-deciding it
 *
 * `auditSpaceAccess` owns both the question "is this access auditable" (`needsAccessAudit`) and
 * the per-request dedupe, so this is a call site and not a second copy of that rule — and it
 * cannot throw, by construction. It is called with the **default `"request"` scope**: this is a
 * render, one act of reading, and its fan-out belongs to a person navigating rather than to a
 * browser fetching sub-resources, which is the distinction the `"subresource"` window exists for.
 *
 * Only spaces that **produced a listed row** are audited, exactly as `search` decided it: a row
 * per readable `MEMBERS` space on every catalogue view is noise, and noise is how an audit table
 * stops being read. The bounded gap that leaves is worth naming rather than leaving to be found —
 * under truncation a space can contribute to a group's *count* without contributing a row, and
 * then it goes unaudited. What such a space discloses is one integer with no title, no path and
 * no page identity in it, which is the same thing Task 1 already decided needs no audit ("a count
 * across spaces the admin cannot read needs no audit, while listing the blocking pages is a
 * cross-boundary read").
 *
 * `listSystems` audits nothing, because it reads no space and no page: §7 makes a system global,
 * permissionless and readable by anyone signed in, and the catalogue holds no page identity at
 * all.
 *
 * ## Not `React.cache()`d
 *
 * One caller per render, and `getSystemDocumentation`'s arguments include a `Viewer` object
 * literal, so a cache would never hit while looking as though it did — the same call
 * `src/lib/lifecycle/index-read.ts` and `src/lib/search/query.ts` both decline to make.
 */

/**
 * The most rows one system page renders, across all of its groups.
 *
 * A rendering bound, not a correctness one, and the same number as `MAX_INDEX_ROWS` because a
 * system's documentation is a subset of the same corpus. The counts come from the aggregate
 * rather than from this array, so a truncated group still reports its true total and says the
 * list is short.
 *
 * **The cut is global, not per group**, and the consequence is stated rather than hidden: with
 * more than this many pages naming one system, the groups later in the ordering lose rows first
 * and report `truncated` with a total larger than their row count. That is a legible sentence on
 * the page rather than a silent short list, which is the property that matters; making the cut
 * per group would cost one query per group to improve a case no installation of this size has.
 */
export const MAX_SYSTEM_DOC_ROWS = 500;

/** §7's metadata, plus the repository decision `repo-url.ts` owns. */
export type SystemSummary = {
  key: string;
  name: string;
  kind: SystemKind;
  ownerTeam: string | null;
  description: string | null;
  /** §7's "active or sunsetting". `false` is `kiosk-bridge` in the seeded corpus. */
  isActive: boolean;
  /**
   * Never the raw column. `repoLinkOf` decides whether it may be rendered at all, so no surface
   * can put a stored credential in an `href` by writing the obvious `<a href={system.repoUrl}>`.
   */
  repo: RepoLink;
};

/** One documentation row. Enough to link it, place it and date it, and nothing else. */
export type SystemDocRow = {
  pageId: string;
  spaceKey: string;
  spaceName: string;
  path: string;
  title: string;
  status: DocStatus;
  publishedAt: Date | null;
};

export type SystemDocGroup = {
  docType: DocType;
  heading: string;
  blurb: string;
  rows: SystemDocRow[];
  /** How many pages this group's filter matches, before `MAX_SYSTEM_DOC_ROWS`. */
  total: number;
  /**
   * How many pages of this doc type name the system and are **left out by the group's status
   * filter** — closed, withdrawn and rejected RFCs, and zero for every other group.
   *
   * This is what makes the heading honest rather than merely careful: "Open RFCs" over a list
   * that quietly hides three closed ones is the same lie as a dropped facet, and a page that can
   * say *three* is making a checkable claim where "some may be hidden" is not.
   */
  excluded: number;
  /** `total` exceeded what the global cap left for this group, so `rows` is short. */
  truncated: boolean;
};

export type SystemDocsResult =
  | {
      ok: true;
      system: SystemSummary;
      /** In `SYSTEM_GROUP_ORDER`, always all four, empty groups included. */
      groups: SystemDocGroup[];
      /** Every listed page across the groups — the empty-state sentence's input. */
      documented: number;
    }
  /** No such system key. There is no permission branch: §7 gives a system no permissions. */
  | { ok: false; reason: "not-found" };

/** The columns both reads want off `System`. One literal, so the two cannot drift. */
const SYSTEM_SELECT = {
  key: true,
  name: true,
  kind: true,
  ownerTeam: true,
  description: true,
  isActive: true,
  repoUrl: true,
} satisfies Prisma.SystemSelect;

type SystemRow = Prisma.SystemGetPayload<{ select: typeof SYSTEM_SELECT }>;

function summaryOf(row: SystemRow): SystemSummary {
  return {
    key: row.key,
    name: row.name,
    kind: row.kind,
    ownerTeam: row.ownerTeam,
    description: row.description,
    isActive: row.isActive,
    repo: repoLinkOf(row.repoUrl),
  };
}

/**
 * §7's catalogue — every system, in key order.
 *
 * **No viewer parameter, and no permission predicate**, said here rather than left to be noticed:
 * §7 is explicit that *"systems are global, not owned by a space, and carry no permissions of
 * their own"*, and `System` has no `spaceId`, no `visibility` and no `deletedAt` for a predicate
 * to be written against. The route still sits behind `requireViewer`, because being signed in is
 * how this product distinguishes a reader from the internet; that is a route concern and not a
 * row filter, and giving this function a `Viewer` it did not use would suggest otherwise.
 *
 * Ordered by `key` and not by `name`: `key` is the identity, it is unique and folded (Task 1's
 * CHECK), and `name` is explicitly not unique. Task 5 orders the same catalogue the same way.
 *
 * **No per-system document count**, and the omission is a decision. A count that ignored
 * readability would report the size of spaces the viewer cannot read; a count that respected it
 * is a second cross-space aggregate whose whole output is one number per row, on the page that
 * exists to be a directory. The system's own page answers "how much is written about this", with
 * the rows to back it up.
 */
export async function listSystems(): Promise<SystemSummary[]> {
  const rows = await db.system.findMany({
    orderBy: { key: "asc" },
    // Explicit select, never `include`.
    select: SYSTEM_SELECT,
  });
  return rows.map(summaryOf);
}

/**
 * The permission predicate and the row shape, in one place, for both page queries below.
 *
 * `readableSpace` is passed **whole** as the value of the `space` relation filter and never
 * spread, at any depth — the spread form silently drops the predicate and neither tsc nor Prisma
 * can see it. `visiblePage` is likewise passed its conditions as varargs rather than being
 * spread; it nests them under its own `AND`, so nothing a caller adds can displace `deletedAt`.
 */
function pageScope(
  viewer: Viewer,
  systemId: string,
  ...extra: Prisma.PageWhereInput[]
): Prisma.PageWhereInput {
  return visiblePage(
    // The one statement of the permission predicate on this route.
    { space: readableSpace(viewer) },
    // The facet. `some` on the join, which the `@@index([systemId, pageId])` Task 1 added for
    // exactly this question serves.
    { systems: { some: { systemId } } },
    // See the module docstring: not reachable from the product, reachable from the schema.
    { publishedVersionId: { not: null } },
    ...extra,
  );
}

/**
 * The group filter, derived from `SYSTEM_GROUPS` rather than written out.
 *
 * An `OR` with one arm per doc type, so it is total by construction: a group whose `statuses` is
 * `null` contributes an unrestricted arm, and the RFC arm carries its own status list. Written
 * this way rather than as "everything except closed RFCs" because the negative form is one that
 * silently starts admitting a new doc type the render has no group for.
 */
function groupFilter(): Prisma.PageWhereInput {
  return {
    OR: SYSTEM_GROUP_ORDER.map((docType) => {
      const statuses = SYSTEM_GROUPS[docType].statuses;
      return statuses === null ? { docType } : { docType, status: { in: [...statuses] } };
    }),
  };
}

/**
 * One system and the documentation that names it, grouped by doc type — spec §7.
 *
 * The key is folded before the lookup, with `foldSystemKey`, which is the same function and the
 * same decision Task 2 applies to an author's `systems:` value. One token, typed by people in two
 * places — a URL bar and a frontmatter list — resolved by one rule; a `/systems/Order-Hub` that
 * 404s while `systems: [Order-Hub]` publishes would be two answers for one string. `System.key` is
 * lowercase by CHECK, so the folded form is the only one that can match and there is nothing to
 * disambiguate. The cost is two URLs rendering one page, which is accepted: nothing in the
 * product generates the mixed-case one.
 */
export async function getSystemDocumentation(
  viewer: Viewer,
  key: string,
): Promise<SystemDocsResult> {
  const system = await db.system.findUnique({
    where: { key: foldSystemKey(key) },
    // Explicit select, never `include`. `id` on top of the shared list, for the join filter.
    select: { id: true, ...SYSTEM_SELECT },
  });
  // Not-found, and there is deliberately no second branch. A system carries no permissions, so
  // "you may not see this system" is not a state that exists.
  if (system === null) return { ok: false, reason: "not-found" };

  // The counts, over the permission-filtered set and **without** the group filter — which is the
  // whole point of the aggregate. It is what lets the RFC group say how many closed RFCs it is
  // leaving out, and it is what makes a truncated group report its true total.
  const grouped = await db.page.groupBy({
    by: ["docType", "status"],
    where: pageScope(viewer, system.id),
    _count: { _all: true },
  });

  const rows = await db.page.findMany({
    where: pageScope(viewer, system.id, groupFilter()),
    /*
     * Space first, then path, then id.
     *
     * By space because this list crosses them and a reader is placing each row: interleaving two
     * spaces' pages by path alone reads as one jumbled list. By path within a space for
     * `index-read`'s reason — an ADR's document number is in its slug and zero-padded, so path
     * order is number order for free, and a republished page does not move. `id` breaks the tie
     * so two rows sharing a path — impossible live, reachable with a soft-deleted row — cannot
     * swap between requests.
     */
    orderBy: [{ space: { key: "asc" } }, { path: "asc" }, { id: "asc" }],
    take: MAX_SYSTEM_DOC_ROWS,
    // Explicit select, never `include`. The space is selected through the relation for its
    // columns only: `Page.spaceId` is `NOT NULL` with a foreign key, so this cannot drop a row
    // and cannot be a second copy of the space filter — the trap Phase 4 Task 3 measured, where
    // a `Map` lookup that skipped a miss left the SQL clause deletable with every test green.
    select: {
      id: true,
      path: true,
      title: true,
      docType: true,
      status: true,
      publishedAt: true,
      space: { select: { id: true, key: true, name: true, visibility: true } },
    },
  });

  const byType = new Map<DocType, SystemDocRow[]>();
  for (const row of rows) {
    const list = byType.get(row.docType);
    const mapped: SystemDocRow = {
      pageId: row.id,
      spaceKey: row.space.key,
      spaceName: row.space.name,
      path: row.path,
      title: row.title,
      status: row.status,
      publishedAt: row.publishedAt,
    };
    if (list === undefined) byType.set(row.docType, [mapped]);
    else list.push(mapped);
  }

  // Folded from the aggregate, per doc type, split by whether the group's own status filter lists
  // the status. `isListedInGroup` is the same rule the query's `groupFilter` is built from, so
  // the counts and the list cannot disagree about what "open" means.
  const listedCount = new Map<DocType, number>();
  const excludedCount = new Map<DocType, number>();
  for (const group of grouped) {
    const into = isListedInGroup(group.docType, group.status) ? listedCount : excludedCount;
    into.set(group.docType, (into.get(group.docType) ?? 0) + group._count._all);
  }

  const groups: SystemDocGroup[] = SYSTEM_GROUP_ORDER.map((docType) => {
    const spec = SYSTEM_GROUPS[docType];
    const groupRows = byType.get(docType) ?? [];
    const total = listedCount.get(docType) ?? 0;
    return {
      docType,
      heading: spec.heading,
      blurb: spec.blurb,
      rows: groupRows,
      total,
      excluded: excludedCount.get(docType) ?? 0,
      truncated: total > groupRows.length,
    };
  });

  // Spec §8's super-admin trace, on the second read surface that reaches into every space at
  // once. `auditSpaceAccess` owns whether this is auditable and the per-request dedupe; the
  // default `"request"` scope is right because this is a render — see the module docstring.
  //
  // Only spaces a listed row came from, keyed so one space audits once however many rows it
  // contributed.
  const readFrom = new Map(
    rows.map((row) => [
      row.space.id,
      { id: row.space.id, key: row.space.key, visibility: row.space.visibility },
    ]),
  );
  for (const space of readFrom.values()) await auditSpaceAccess(viewer, space);

  let documented = 0;
  for (const group of groups) documented += group.total;

  return { ok: true, system: summaryOf(system), groups, documented };
}
