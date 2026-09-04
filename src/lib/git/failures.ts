import type { GitJobKind } from "@prisma/client";
import { db } from "@/lib/db";
import { auditSpaceAccess } from "@/lib/audit/log";
import { redactCredentials } from "@/lib/git/redact";
import type { Viewer } from "@/lib/authz/types";

/**
 * The mirror jobs that gave up — spec §10: *"persistent failures surface on an admin page rather
 * than only in logs."*
 *
 * Phase 7 owns `/admin` and will fold this in. This is one read-only list, which is what §10 asks
 * for and the whole of what this phase ships: no clearing, no retrying, no queue surgery. A button
 * that re-queued a job would be a mutation with its own audit row, its own permission argument and
 * its own concurrency question against a running worker, and none of that is Phase 5's.
 *
 * ## The permission is `isSuperAdmin`, stated here, and neither helper is used
 *
 * `readableSpace` and `visiblePage` are **absent from this module on purpose**, and both absences
 * are load-bearing rather than convenient. Stating that at the line, as the project's rule
 * requires, because an unexplained exception is how the next reader justifies a second one:
 *
 * - **No `readableSpace`.** The only viewer who reaches the query is a super admin, and
 *   `readableSpaceWhere` answers `{}` for one — so a `readableSpace(viewer)` here would be a
 *   predicate that cannot fail, which is precisely the `resolveRedirect` shape this project has
 *   measured twice: a filter nobody can delete a test with. The predicate that *does* decide who
 *   reads this is the guard below, and it is falsifiable — delete it and a member of one space
 *   reads every space's page titles.
 * - **No `visiblePage`.** A soft-deleted page is exactly what a `DELETE` job is about, so a
 *   `deletedAt: null` filter would hide the failures of the one job kind whose page is always
 *   deleted — and a `MOVE` or `PUBLISH` job for a page deleted after it was queued would vanish
 *   too, while still blocking that page's queue for ever. The soft-delete rule exists so a deleted
 *   page leaves the *product*; this is the queue, and a job is not a page. The page's deletion is
 *   reported on the row instead ({@link MirrorFailure.pageDeleted}), because an operator who
 *   cannot see it would read a stuck DELETE as a mystery.
 *
 * ## Not-found and not forbidden
 *
 * A refusal here is `{ ok: false, reason: "not-found" }`, the same answer the rest of the product
 * gives, and for the reason `e2e/reader.spec.ts` states as *"a non-member gets not-found rather
 * than forbidden"*: a job list names pages across every space, so a `403` would confirm that a
 * mirror-failures page exists and, from a route that is otherwise 404, tell an ordinary member
 * something about the shape of the system they were not entitled to. There is nothing here for a
 * non-admin to be told they lack permission *for*.
 *
 * ## The audit decision: yes, and it is the same act as a search
 *
 * §8's trace is about a super admin reading a `MEMBERS` space they do not belong to, and Phase 4
 * settled that a **search** into such a space writes one row per space that produced a hit —
 * because search "reaches into every space at once" and would otherwise let a super admin read
 * titles and paths out of every closed space with no row anywhere.
 *
 * This page has the identical observable. It paints a page **title** and a **path** — the same two
 * user-authored strings a search hit carries — for pages in every space, chosen by the mirror
 * rather than by a query string. That the reader's *intent* is operational changes nothing an
 * auditor can see afterwards: the row exists to record what a super admin learned, not why they
 * went looking. Auditing only spaces that actually produced a failure follows `search()` exactly,
 * and for its stated reason — auditing the enumeration would write rows for spaces this read
 * touched nothing in, and noise is how an audit table stops being read.
 *
 * The case for *not* auditing was that a failure list is machinery rather than content. It is
 * rejected because it is an argument about the rows' meaning and not about their contents, and
 * §8's question is the contents. A super admin who is a member of everything writes no row either
 * way — `needsAccessAudit` is what decides that, here as everywhere, and this is a call site
 * rather than a second copy of the rule.
 *
 * ## What this module deliberately does not answer
 *
 * Whether the mirror is *complete*. See {@link MirrorReport} — the queue is the only thing there
 * is a row for, and three real states leave no `FAILED` job behind. The component says so; this
 * type is shaped so it can.
 */

/**
 * The most failure rows one page renders.
 *
 * A rendering bound like `MAX_HISTORY_ROWS`, and a generous one: Task 6's per-page barrier means a
 * page can hold at most **one** `FAILED` job — once a job fails, no later job for that page is
 * claimable, so no later job can fail — so this is a bound on the number of *pages* whose mirror is
 * wedged. A deployment with 200 of those has an incident, not a list.
 */
export const MAX_MIRROR_FAILURES = 200;

/** One job that has used every attempt, with what an operator needs to act on it. */
export type MirrorFailure = {
  id: number;
  kind: GitJobKind;
  /**
   * The mirror address this job was going to write, as it was captured at enqueue time: the file
   * is `<spaceKey>/<path>.md` in the working tree. Not the page's *current* address — the job is
   * about where the file was going when the mutation happened, and a page moved since would make
   * a joined address a description of a different operation.
   */
  spaceKey: string;
  path: string;
  /** A `MOVE`'s source. Null for every other kind. */
  fromPath: string | null;
  /** The page's title now. User-controlled, up to `TITLE_MAX_LENGTH` of unbreakable token. */
  pageTitle: string;
  /**
   * Where the page is now, and the space it is in now — the pair that addresses its version
   * history. Read from the page rather than from the job's captures precisely because a link has
   * to work today, where the job's captured address describes the past.
   *
   * **Version history and not the page itself**, which is why there is no `isLinkable` here where
   * every other list in the product carries one. The reader route needs a published version and
   * 404s without one; `/-/history` deliberately answers *none yet* instead, so it is linkable for
   * every page a super admin can read — and it is also the right destination, being where this
   * page's queue state and its versions' shas are already shown.
   */
  pageSpaceKey: string;
  pagePath: string;
  /** The page is soft-deleted. Normal for a `DELETE` job; worth saying for any other kind. */
  pageDeleted: boolean;
  attempts: number;
  /** `GitJob.createdAt` — how long this has been queued. */
  queuedAt: Date;
  /** `GitJob.updatedAt`, which the schema defines as *when it was last attempted*. */
  lastAttemptAt: Date;
  /**
   * `GitJob.lastError`, **redacted** — see `src/lib/git/redact.ts`. git's stderr, plus the argv
   * this application built, which for a push contains `GIT_REMOTE_URL` verbatim and may carry a
   * credential.
   */
  lastError: string | null;
  /**
   * How many changes to this page are queued behind this failure and cannot be applied.
   *
   * Task 6's barrier makes this exact rather than approximate: a job is unclaimable while any
   * earlier job for its page is not `DONE`, so **every** unfinished job for this page is behind
   * this one. Nothing earlier can be unfinished either — this job was claimed, which means
   * everything before it had already reached `DONE`.
   */
  blocked: number;
};

/**
 * The whole answer, including the parts that are *not* failures.
 *
 * Shaped so the page can say what it does not cover, which is Step 2 of this task and the reason
 * `retrying` is here at all: a report that showed only `FAILED` rows would let an empty list read
 * as "the mirror is healthy", and three separate states make that false. Two of them have a number
 * on this type; the third has none by construction and the component says so in words.
 */
export type MirrorReport = {
  /** Newest attempt first. */
  failures: MirrorFailure[];
  /** `failures` is short — more than {@link MAX_MIRROR_FAILURES} jobs have failed. */
  truncated: boolean;
  /**
   * Jobs that have failed at least once and **will** be tried again — `PENDING` with `attempts`
   * already spent.
   *
   * Not a failure and deliberately not in the list: §10's promise is that a git host being down is
   * not an incident, so a job backing off is the system working. It is counted because a page that
   * only said "nothing has given up" would be true and misleading on a morning when the remote has
   * been refusing every push for an hour.
   *
   * Disjoint from {@link MirrorFailure.blocked} by construction, which is why the two can be shown
   * side by side without double-counting: a job blocked behind a failure has never been claimed, so
   * its `attempts` is 0, and a job with attempts spent was claimable, which means nothing earlier
   * for its page was unfinished.
   */
  retrying: number;
};

export type MirrorFailuresResult =
  | { ok: true; report: MirrorReport }
  /** Not a super admin. The same answer as "no such route", deliberately — see the docstring. */
  | { ok: false; reason: "not-found" };

export async function listMirrorFailures(viewer: Viewer): Promise<MirrorFailuresResult> {
  // The only permission predicate in this module, and the only one there is: this surface is not
  // space-scoped, so there is no space whose readability could be the question. Delete this line
  // and any signed-in person reads every space's page titles — which is the mutation
  // `tests/integration/git-failures.test.ts` runs.
  if (!viewer.isSuperAdmin) return { ok: false, reason: "not-found" };

  const rows = await db.gitJob.findMany({
    where: { state: "FAILED" },
    /*
     * Most recently attempted first. `@@index([state, nextAttemptAt, id])` serves the equality on
     * `state`; the sort is a sort, and that is accepted rather than overlooked — at most one job
     * per page can be `FAILED` (see `MAX_MIRROR_FAILURES`), so this orders a set bounded by the
     * number of wedged pages and not by the size of the table.
     *
     * `id` breaks the tie, as it does in `listPageVersions`: two jobs failing in the same
     * millisecond is a fixture rather than a product event, and a list that reorders itself
     * between two requests for no visible reason is worse than an arbitrary but fixed tiebreak.
     */
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    // One more than the cap, so truncation is known without a second count — `search()`'s shape.
    take: MAX_MIRROR_FAILURES + 1,
    // Explicit select, never `include`. `versionId` is absent deliberately: a `MOVE`, `DELETE` or
    // `RESTORE` carries none, so a version column would be empty for three kinds out of four and
    // would invite a per-version reading of a queue that is per page.
    select: {
      id: true,
      kind: true,
      spaceKey: true,
      path: true,
      fromPath: true,
      attempts: true,
      createdAt: true,
      updatedAt: true,
      lastError: true,
      pageId: true,
      page: {
        select: {
          title: true,
          path: true,
          deletedAt: true,
          // For the link, and for the audit: `auditSpaceAccess` needs the id, the key and the
          // visibility, and `needsAccessAudit` is what decides whether any of it is written.
          space: { select: { id: true, key: true, visibility: true } },
        },
      },
    },
  });

  const truncated = rows.length > MAX_MIRROR_FAILURES;
  const kept = rows.slice(0, MAX_MIRROR_FAILURES);

  // What is stuck behind each failure. One aggregate for the whole page, keyed on the page ids
  // just read — no predicate of its own, for the reason `listPageVersions` states about its own
  // second and third queries: these rows were authorised by the guard above, in this function,
  // with nothing caller-supplied in between, and a second copy of a predicate that cannot fail
  // would make neither copy testable.
  const blockedBehind = new Map<string, number>();
  if (kept.length > 0) {
    const groups = await db.gitJob.groupBy({
      by: ["pageId"],
      where: {
        pageId: { in: kept.map((row) => row.pageId) },
        // `RUNNING` is unreachable while an earlier job is `FAILED` — nothing can claim it — and
        // it is included anyway. A state that "cannot happen" and is silently dropped from a
        // count is how a number quietly starts under-reporting; including it costs nothing and
        // makes the count true of whatever the table holds.
        state: { in: ["PENDING", "RUNNING"] },
      },
      _count: { _all: true },
    });
    for (const group of groups) blockedBehind.set(group.pageId, group._count._all);
  }

  // The third state a reader has to be told about, and the cheapest of the three to be honest
  // about: a job that has failed and is still owed another attempt.
  const retrying = await db.gitJob.count({
    where: { state: "PENDING", attempts: { gt: 0 } },
  });

  const failures: MirrorFailure[] = kept.map((row) => ({
    id: row.id,
    kind: row.kind,
    spaceKey: row.spaceKey,
    path: row.path,
    fromPath: row.fromPath,
    pageTitle: row.page.title,
    pageSpaceKey: row.page.space.key,
    pagePath: row.page.path,
    pageDeleted: row.page.deletedAt !== null,
    attempts: row.attempts,
    queuedAt: row.createdAt,
    lastAttemptAt: row.updatedAt,
    // The second application of the redactor, on the way *out* of the column. `repo.ts` applies
    // it on the way in, so nothing this build writes carries a credential — this is the guard on
    // the row, for a value written by an older build, by a hand-run `UPDATE`, or by some future
    // path that does not go through `failedRun`. See `redact.ts` for why that is two transforms
    // and not one predicate stated twice.
    lastError: row.lastError === null ? null : redactCredentials(row.lastError),
    blocked: blockedBehind.get(row.pageId) ?? 0,
  }));

  // Spec §8's super-admin trace — see the docstring for why this is the same act as a search, and
  // why it is only the spaces that actually produced a row. `auditSpaceAccess` owns both the
  // decision (`needsAccessAudit`) and the per-request dedupe, and cannot throw.
  const readFrom = new Map(kept.map((row) => [row.page.space.id, row.page.space]));
  for (const space of readFrom.values()) await auditSpaceAccess(viewer, space);

  return { ok: true, report: { failures, truncated, retrying } };
}
