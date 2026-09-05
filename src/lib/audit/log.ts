import { AsyncLocalStorage } from "node:async_hooks";
import { cache } from "react";
import { after } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { needsAccessAudit } from "@/lib/authz/can";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

/**
 * Every `AuditLog` row in the product is written through `writeAudit`, and
 * `tests/integration/audit.test.ts` sweeps `src/` to keep that true.
 *
 * The five mutation actions were each written inline before this module existed and all five
 * agreed on the envelope — one row per mutation, inside the mutation's own transaction,
 * carrying actor, action, space, page and a JSON `detail`. Nothing about what they record
 * changed here; the envelope moved into one place and got a type.
 */
export type AuditAction =
  | "page.create"
  | "page.move"
  | "page.publish"
  | "page.delete"
  | "page.restore"
  /**
   * A page's status changed because **another** page was published — spec §6.3's cascade,
   * added by Phase 3 Task 8.
   *
   * The only action so far whose actor did not act on the page the row names, which is exactly
   * why it is its own action rather than a key inside `page.publish`'s detail: `AuditLog` is
   * indexed by `pageId`, and a page that was retired without a row of its own would be a page
   * whose history says nothing happened to it. The publish that caused it carries the mirror
   * summary, so the join reads in both directions.
   */
  | "page.cascade"
  /**
   * Spec §12's review confirmation — a page's owner (or a space admin) said the document is
   * still correct. Phase 7 Task 4.
   *
   * The action in this union with the strongest claim to being here, because it is the only
   * mutation in the product that leaves **no other trace**: it writes no `PageVersion`, enqueues
   * no `GitJob`, and leaves `Page.searchVector` byte-identical, all three deliberately. And
   * `Page.reviewedAt` is a single mutable column, so the next confirm overwrites the record of
   * this one — without a row here, "who said this was still correct, and when" is answerable
   * only for the most recent claim, on a list that exists to hold somebody to it. Contrast
   * `src/lib/git/enqueue.ts`, which writes no audit row precisely because the mutation that
   * caused it is already audited in the same transaction.
   */
  | "page.review"
  /** The Phase 1 debt: a super admin read a `MEMBERS` space they do not belong to (spec §8). */
  | "space.access"
  /**
   * The catalogue mutations on `/admin/systems` — spec §7's *"admins manage the list"*, Phase 7
   * Task 5. **The first three actions in this union that name no space**, which is why
   * `AuditEntry.spaceId` had to be widened deliberately; the argument is on that type.
   *
   * Three actions rather than one with a verb in `detail`, for `page.cascade`'s reason: an
   * auditor filters on `action`, and "who deleted a system" is a different question from "who
   * renamed one". They earn their place separately:
   *
   * - `system.create` and `system.update` are ordinary mutations, but `System` has **no
   *   `createdAt`** — Task 1 removed it on the explicit grounds that *"when was this system
   *   added, and by whom is a question `AuditLog` already answers for Task 5's mutations"*. This
   *   is that answer, and without it the claim in the schema is false.
   * - `system.update` is also where a **rename** is recorded, which Task 2 asked for by name: a
   *   `System.key` change strands the old key text inside every published version's stored
   *   frontmatter, so the row carries `previousKey` and the number of pages affected. That row is
   *   the only durable record that the two spellings were once one system.
   * - `system.delete` is the strongest case of the three. `Restrict` means a deletable system has
   *   no pages naming it, so the row leaves **no other trace at all** — no facet rows, no version
   *   history, and the `System` row itself is gone. Same standing as `page.review`, arriving from
   *   the other direction.
   *
   * What these rows deliberately do **not** carry is `repoUrl`. See `systemAuditDetail` in
   * `src/lib/systems/admin.ts`: a repo URL is a credential channel, and an audit row is a column.
   */
  | "system.create"
  | "system.update"
  | "system.delete";

/**
 * Whatever can write the row. Structural on purpose, so the same helper serves the five
 * mutations — which pass their **transaction** client, because an audit row that is not
 * committed with the change it describes is a lie either way it fails — and the access
 * audit, which has no transaction to join and passes `db`.
 */
export type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * `spaceId` is **`string | null` and not optional**, and that widening is the deliberate one this
 * type asked for.
 *
 * It used to read `spaceId: string`, with the reason written here: *"every event in the product
 * so far is an event about a space… A future spaceless event should widen this deliberately
 * rather than discover that `undefined` was allowed all along."* Phase 7 Task 5 is that event.
 * §7 says systems *"are global, not owned by a space, and carry no permissions of their own"*, and
 * `System` has no `spaceId` column — so a `system.create` row has no space to name, and inventing
 * one (the space the admin last looked at, say) would put a false answer in the column an auditor
 * filters by.
 *
 * The widening is to `string | null` rather than to `spaceId?: string` on purpose, and the
 * difference is the whole point of the original note: an **optional** key is one a caller can
 * forget, and a forgotten space on a page mutation is indistinguishable at the type level from a
 * genuinely spaceless one. Required-and-nullable makes every call site state which it is, so the
 * five page actions still cannot omit it by accident. That is the same distinction
 * `page.review`'s `previousReviewedAt` draws for a different reason — an omitted key and a null
 * one mean different things to anyone querying the column.
 *
 * The cost, stated rather than left to be found: `@@index([spaceId, createdAt])` does index NULLs
 * in Postgres, so the spaceless rows are still reachable by that index, but a query shaped
 * `where spaceId = $1` will never return them. An auditor looking for catalogue mutations filters
 * on `action`, which is what `AuditAction`'s three new values are for.
 */
export type AuditEntry = {
  actorId: string;
  action: AuditAction;
  spaceId: string | null;
  pageId?: string | null;
  detail: Prisma.InputJsonObject;
};

export async function writeAudit(tx: AuditClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      spaceId: entry.spaceId,
      pageId: entry.pageId ?? null,
      detail: entry.detail,
    },
    // Explicit select, never `include` — and `id` only, because no caller uses the row.
    select: { id: true },
  });
}

/**
 * What the access audit stores, and — the part worth reviewing — what it does not.
 *
 * The row exists to say that a super admin looked into a space they are not a member of. An
 * auditor needs four things and this row has all four: **who** (`actorId`), **when**
 * (`createdAt`), **which space** (`spaceId`), and **why it was allowed** (`by`).
 *
 * `key` and `visibility` are stored because both can change afterwards and their changing is
 * what would make the row unreadable later: a space rekeyed after the fact leaves `spaceId`
 * resolvable but unrecognisable, and a space that later becomes `ALL_STAFF` makes an
 * otherwise-correct row look like a false positive. Same reasoning as `path` in the page
 * audits. `by` is stored for the mirror case: `isSuperAdmin` can be revoked, and then nothing
 * on the row says why the read was permitted.
 *
 * Deliberately absent:
 *
 * - **The page.** Not withheld — genuinely unknown here. This fires when a space is resolved,
 *   which happens in the layout before any page is read and on the space landing page where
 *   there is no page at all. A `pageId` populated on some renders and null on others would be
 *   worse than none: an auditor cannot tell "read the space root" from "we forgot to plumb
 *   it". Per-page read auditing is a different event and a different decision.
 * - **The actor's email or name.** `actorId` is a foreign key to `User`, which carries both
 *   and stays correct. A copy in a JSON blob outlives an offboarding and cannot be corrected.
 * - **The space name or description, and the viewer's membership list.** Neither answers a
 *   question an auditor is asking, and the first is content from a space the actor was not
 *   entitled to.
 */
function accessDetail(spaceKey: string, visibility: SpaceRef["visibility"]) {
  return { key: spaceKey, visibility, by: "super-admin" } satisfies Prisma.InputJsonObject;
}

type AccessEntry = {
  actorId: string;
  spaceId: string;
  spaceKey: string;
  visibility: SpaceRef["visibility"];
};

/**
 * Writes the access row, and **cannot throw**.
 *
 * The two constraints in the plan pull against each other: it must not turn a successful read
 * into an error page, and it must not lose rows silently. They are resolved by two mechanisms
 * with two different jobs, each testable on its own:
 *
 * - `after()` (in `auditSpaceAccess` below) keeps the write off the response. That is the
 *   *latency* mechanism: nothing about the render waits on it.
 * - This `catch` is the *resilience* mechanism, and it is the one that matters when the write
 *   genuinely fails — an FK violation, a dropped connection, a full disk. Without it the
 *   throw would surface from the read on every path where `after()` is unavailable, which
 *   includes every test and script.
 *
 * "Not silent" is the `console.error`, and the log line carries **the whole row** rather than
 * just the error, so a lost audit is reconstructable from the log rather than merely known
 * about. It is one line, at error level, with a fixed prefix, so it can be alerted on.
 */
async function recordSpaceAccess(entry: AccessEntry): Promise<void> {
  try {
    await writeAudit(db, {
      actorId: entry.actorId,
      action: "space.access",
      spaceId: entry.spaceId,
      detail: accessDetail(entry.spaceKey, entry.visibility),
    });
  } catch (error) {
    console.error(
      `[audit] FAILED to write space.access — this access is now UNRECORDED. ` +
        `actor=${entry.actorId} space=${entry.spaceId} key=${entry.spaceKey} ` +
        `visibility=${entry.visibility}`,
      error,
    );
  }
}

/**
 * The audit is **per request, per (actor, space)** — not per call.
 *
 * A single page view resolves the space more than once: the space layout resolves it, then
 * `getPublishedPage` resolves it again, and a bug report resolves it a third time. Those are
 * one act of reading, and three rows a millisecond apart with identical contents would add no
 * information while making any rate-based reading of the table meaningless. Per request is
 * still per *page view* — navigating to a second page is a second request and a second row —
 * so how much a super admin read remains visible, which is the question the table exists to
 * answer.
 *
 * `cache()` is the request scope, because inside an RSC render it is the only one there is.
 * PROGRESS records that `cache()` is inert outside a render, so that link cannot be verified
 * from a unit test; the browser check on a real render is what verifies it. What *is* verified
 * is everything downstream of the scope, via `inOneRequest` below.
 */
const requestScope = cache((): Set<string> => new Set());

/**
 * A stand-in request scope, so the per-request claim is testable at all.
 *
 * Production never calls this: inside a render the store is undefined and `requestScope()`
 * answers. It exists because "exactly one row per request" is the sort of claim that is
 * asserted in a docstring and then quietly broken, and `cache()` cannot be exercised from
 * vitest. With it, the dedupe key, the ordering and the per-request *boundary* are all pinned
 * against a real database through the real reader entry point.
 */
const testScope = new AsyncLocalStorage<Set<string>>();

export function inOneRequest<T>(run: () => T): T {
  return testScope.run(new Set(), run);
}

/**
 * How long one act of reading is allowed to take, for a caller whose fan-out belongs to a
 * browser rather than to a person.
 *
 * A minute covers a page's images and a video's range requests with room to spare, and is
 * short enough that a genuinely separate visit still records. A ten-minute video scrubbed
 * throughout produces roughly ten rows rather than several hundred, which is the shape an
 * auditor can actually read.
 */
const SUBRESOURCE_WINDOW_MS = 60_000;

/**
 * Cap on tracked keys, and the eviction is deliberately blunt.
 *
 * When the map outgrows this it drops expired entries and, if that is not enough, clears
 * entirely. Clearing makes the next read of every tracked pair write a row — it OVER-reports,
 * never under-reports, which is the only direction an audit may fail in.
 */
const MAX_TRACKED_PAIRS = 5_000;

/** `(actor, space)` → the moment its window closes. */
const windowScope = new Map<string, number>();

/**
 * A second de-dup scope, for callers whose requests are sub-resources of one page view.
 *
 * **Not the request scope with a timer bolted on, and the difference is the point.** The
 * request scope collapses the three space resolutions inside one render, and its per-request
 * granularity is deliberate: "two reads in two requests write two rows" is a test, because a
 * super admin browsing five pages must read as five rows. Widening that to a time window
 * would answer "did they look" while destroying "how much".
 *
 * An attachment read is a different kind of event. A page with twelve screenshots is twelve
 * HTTP requests, and a scrubbed video is one per seek — all of them one act of reading, and
 * none of them a render, so `cache()` is inert and the request scope catches nothing.
 * Measured before this existed: twelve reads wrote twelve identical rows a millisecond apart.
 *
 * Process-wide, so N replicas may each write one row per window. That is bounded and small,
 * and it is the safe direction; exactness would cost either a `SELECT` per audited read or a
 * unique index on a time bucket, and neither buys anything an auditor asked for.
 */
function withinSubresourceWindow(key: string, now: number): boolean {
  const closes = windowScope.get(key);
  if (closes !== undefined && closes > now) return true;

  windowScope.set(key, now + SUBRESOURCE_WINDOW_MS);

  if (windowScope.size > MAX_TRACKED_PAIRS) {
    for (const [tracked, expiry] of windowScope) {
      if (expiry <= now) windowScope.delete(tracked);
    }
    if (windowScope.size > MAX_TRACKED_PAIRS) windowScope.clear();
  }
  return false;
}

/** Test isolation only: the window is module state and outlives a single test by design. */
export function resetAccessWindow(): void {
  windowScope.clear();
}

/**
 * Which fan-out the caller has.
 *
 * `"request"` — a render, where one act of reading is one request. The default, and what
 * every space read has always done.
 *
 * `"subresource"` — a request the browser made *because of* a page it already rendered: the
 * bytes behind an `<img>` or a `<video>`'s next range. One act of reading spans many of these,
 * and the caller is the only thing that knows that.
 */
export type AccessScope = "request" | "subresource";

/**
 * Pays off `needsAccessAudit`, which shipped in Phase 1 with tests and no call site.
 *
 * Called from `getReadableSpaceByKey`, which every space read passes through, so this is one
 * call site rather than a rule each route has to remember — the failure mode PROGRESS records
 * twice as "a rule implemented in two places is not yet a convention".
 */
export async function auditSpaceAccess(
  viewer: Viewer,
  space: SpaceRef & { key: string },
  accessScope: AccessScope = "request",
): Promise<void> {
  // First, so neither scope is consulted — and no key is retained — for the overwhelming
  // majority of reads, which are not audited at all.
  if (!needsAccessAudit(viewer, space)) return;

  // NUL as the separator: it cannot occur in a cuid, so no pair of ids can collide by
  // concatenation.
  const key = `${viewer.id}\u0000${space.id}`;

  // Both scopes, in the order they narrow. The request scope is inert in a route handler
  // (`cache()` only memoizes inside a render), which is exactly why the window exists.
  const scope = testScope.getStore() ?? requestScope();
  if (scope.has(key)) return;
  if (accessScope === "subresource" && withinSubresourceWindow(key, Date.now())) return;
  // Marked before the write is attempted, not after it succeeds. A retry inside the same
  // request would hit the same failure and log the same line twice.
  scope.add(key);

  const entry: AccessEntry = {
    actorId: viewer.id,
    spaceId: space.id,
    spaceKey: space.key,
    visibility: space.visibility,
  };

  try {
    // Off the response entirely: the render does not await a database write in the middle of
    // streaming HTML, and `after` runs the callback even when the render ends in `notFound()`
    // or a redirect — which matters, because a super admin who resolved the space and then
    // missed the page still read the space.
    after(() => recordSpaceAccess(entry));
    return;
  } catch {
    // `after` throws (E468) when there is no request scope: a test, a script, the seed. There
    // is no response to stay off, so the write happens here and is awaited — which is also
    // what makes it observable to the tests below.
  }
  await recordSpaceAccess(entry);
}
