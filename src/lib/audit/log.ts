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
  /** The Phase 1 debt: a super admin read a `MEMBERS` space they do not belong to (spec §8). */
  | "space.access";

/**
 * Whatever can write the row. Structural on purpose, so the same helper serves the five
 * mutations — which pass their **transaction** client, because an audit row that is not
 * committed with the change it describes is a lie either way it fails — and the access
 * audit, which has no transaction to join and passes `db`.
 */
export type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

/**
 * `spaceId` is required even though the column is nullable: every event in the product so
 * far is an event *about a space*, and the space is the only column with an index that an
 * auditor can query by. A future spaceless event should widen this deliberately rather than
 * discover that `undefined` was allowed all along.
 */
export type AuditEntry = {
  actorId: string;
  action: AuditAction;
  spaceId: string;
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
 * Pays off `needsAccessAudit`, which shipped in Phase 1 with tests and no call site.
 *
 * Called from `getReadableSpaceByKey`, which every space read passes through, so this is one
 * call site rather than a rule each route has to remember — the failure mode PROGRESS records
 * twice as "a rule implemented in two places is not yet a convention".
 */
export async function auditSpaceAccess(
  viewer: Viewer,
  space: SpaceRef & { key: string },
): Promise<void> {
  if (!needsAccessAudit(viewer, space)) return;

  // NUL as the separator: it cannot occur in a cuid, so no pair of ids can collide by
  // concatenation.
  const key = `${viewer.id}\u0000${space.id}`;
  const scope = testScope.getStore() ?? requestScope();
  if (scope.has(key)) return;
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
