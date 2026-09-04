import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { MAX_MIRROR_FAILURES, listMirrorFailures, type MirrorFailure } from "@/lib/git/failures";
import { inOneRequest } from "@/lib/audit/log";
import type { GitJobKind, GitJobState } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Phase 5 Task 8's query, against the real database.
 *
 * Integration and not unit, because every question here is a question about rows and about who
 * may see them: whether a soft-deleted page's failure is still listed, whether a member of a
 * space is refused, whether "queued behind a failure" counts the right rows, and whether a super
 * admin reading another space's page titles leaves an audit row. A stubbed client can be made to
 * agree with any of those, which is why it would prove none.
 *
 * The pure halves are elsewhere: the credential redactor in `src/lib/git/redact.test.ts`, and the
 * words in `src/components/MirrorFailures.test.tsx`.
 */

/**
 * Two spaces, and the same viewer can read exactly one of them.
 *
 * `engineering` is `MEMBERS` and `handbook` is `ALL_STAFF` — the seeded shape — because a refusal
 * asserted by a viewer who can see nothing at all is near-vacuous, which Phase 4 measured. The
 * member below reads `engineering`; the super admin reads both, and it is `handbook`'s
 * `ALL_STAFF` visibility that makes the audit assertions discriminate rather than fire on
 * everything.
 */
async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Root", isSuperAdmin: true },
  });
  const members = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const open = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: members.id, userId: author.id, role: "EDITOR" },
  });

  const page = async (opts: { spaceId?: string; path?: string; title?: string }) => {
    const path = opts.path ?? "architecture/mqtt-contracts";
    return await db.page.create({
      data: {
        spaceId: opts.spaceId ?? members.id,
        slug: path.split("/").pop()!,
        path,
        title: opts.title ?? "MQTT contracts",
        docType: "DOC",
        status: "CURRENT",
        createdById: author.id,
      },
      select: { id: true, path: true, title: true },
    });
  };

  /**
   * A `GitJob` written directly.
   *
   * Driving the worker to produce a `FAILED` row would take five real pushes against a broken
   * remote per fixture — `git-worker.test.ts` already owns that path and asserts the states it
   * writes. What this file is about is the *read*, so the rows are written as the worker leaves
   * them, and `minute` fixes the timestamps so no assertion depends on insert speed.
   */
  const job = async (opts: {
    pageId: string;
    kind?: GitJobKind;
    state?: GitJobState;
    spaceKey?: string;
    path?: string;
    fromPath?: string | null;
    attempts?: number;
    lastError?: string | null;
    /** Minutes past the fixed base, for both `createdAt` and `updatedAt`. */
    minute?: number;
  }) => {
    const at = new Date(Date.UTC(2026, 2, 4, 9, opts.minute ?? 0));
    return await db.gitJob.create({
      data: {
        pageId: opts.pageId,
        kind: opts.kind ?? "PUBLISH",
        state: opts.state ?? "FAILED",
        spaceKey: opts.spaceKey ?? "engineering",
        path: opts.path ?? "architecture/mqtt-contracts",
        fromPath: opts.fromPath ?? null,
        attempts: opts.attempts ?? 5,
        lastError: opts.lastError === undefined ? "Pushing: git exited 128." : opts.lastError,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true },
    });
  };

  const member: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: members.id, role: "EDITOR" }],
  };
  /** Reads `handbook` because it is `ALL_STAFF`, and `engineering` not at all. */
  const outsider: Viewer = { id: root.id, isSuperAdmin: false, memberships: [] };
  const admin: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };

  return { author, root, members, open, page, job, member, outsider, admin };
}

/**
 * The one row a single-failure fixture produced.
 *
 * `noUncheckedIndexedAccess` makes `failures[0]` possibly-undefined, and the useful half of that
 * is not the type: an assertion written against an index silently becomes vacuous when the query
 * returns nothing, which is the "absence that could not have been present" shape this project has
 * met three times. This asserts the length first, so a query that returns nothing fails here with
 * a count rather than three lines later with a type error nobody sees at runtime.
 */
function one(failures: readonly MirrorFailure[]): MirrorFailure {
  expect(failures).toHaveLength(1);
  const row = failures[0];
  if (row === undefined) throw new Error("unreachable: the assertion above would have failed");
  return row;
}

/** Unwraps, so a failed permission check reads as a named failure rather than a type error. */
async function report(viewer: Viewer) {
  const result = await listMirrorFailures(viewer);
  if (!result.ok) throw new Error(`listMirrorFailures refused: ${result.reason}`);
  return result.report;
}

/* -------------------------------------------------------------------------- */
/* Step 1 — the list                                                          */
/* -------------------------------------------------------------------------- */

test("a failed job is listed with its page, its attempts and its last error", async () => {
  const f = await fixture();
  const page = await f.page({ title: "Topic registry", path: "architecture/topic-registry" });
  await f.job({
    pageId: page.id,
    path: "architecture/topic-registry",
    attempts: 5,
    lastError: "Pushing to the content remote: git exited 128. Output: fatal: no such remote",
    minute: 12,
  });

  const { failures } = await report(f.admin);

  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({
    kind: "PUBLISH",
    spaceKey: "engineering",
    path: "architecture/topic-registry",
    pageTitle: "Topic registry",
    pageSpaceKey: "engineering",
    pagePath: "architecture/topic-registry",
    pageDeleted: false,
    attempts: 5,
    blocked: 0,
  });
  expect(one(failures).lastError).toContain("fatal: no such remote");
  // `updatedAt` is the schema's "when it was last attempted", and it is the value the page shows.
  // Asserted against the fixture's clock rather than against another copy of itself — the trap
  // `deletePage`'s timezone bug was found by.
  expect(one(failures).lastAttemptAt.toISOString()).toBe("2026-03-04T09:12:00.000Z");
});

test("only FAILED jobs are listed — a pending, running or done job is not a failure", async () => {
  const f = await fixture();
  const page = await f.page({});
  await f.job({ pageId: page.id, state: "PENDING", minute: 1 });
  await f.job({ pageId: page.id, state: "RUNNING", minute: 2 });
  await f.job({ pageId: page.id, state: "DONE", minute: 3 });

  const { failures } = await report(f.admin);
  expect(failures).toEqual([]);

  // Non-vacuity: the same query over the same page sees a row the moment one is FAILED, so the
  // empty answer above is a filter working rather than a query that finds nothing.
  await f.job({ pageId: page.id, state: "FAILED", minute: 4 });
  expect((await report(f.admin)).failures).toHaveLength(1);
});

test("the list is newest attempt first, across spaces", async () => {
  const f = await fixture();
  const older = await f.page({ path: "older", title: "Older" });
  const newer = await f.page({ spaceId: f.open.id, path: "newer", title: "Newer" });
  await f.job({ pageId: older.id, path: "older", minute: 5 });
  await f.job({ pageId: newer.id, spaceKey: "handbook", path: "newer", minute: 30 });

  const { failures } = await report(f.admin);
  // Distinguishable in both directions: two titles, two spaces, and the order is asserted rather
  // than the set — an assertion on the set passes for either ordering.
  expect(failures.map((row) => row.pageTitle)).toEqual(["Newer", "Older"]);
  expect(failures.map((row) => row.spaceKey)).toEqual(["handbook", "engineering"]);
});

test("a MOVE failure carries both addresses, so the operator can see what did not happen", async () => {
  const f = await fixture();
  const page = await f.page({ path: "architecture/new-home", title: "Moved" });
  await f.job({
    pageId: page.id,
    kind: "MOVE",
    path: "architecture/new-home",
    fromPath: "architecture/old-home",
  });

  const { failures } = await report(f.admin);
  expect(failures[0]).toMatchObject({
    kind: "MOVE",
    path: "architecture/new-home",
    fromPath: "architecture/old-home",
  });
});

test("a failed DELETE job for a soft-deleted page is listed, with the page marked deleted", async () => {
  /*
   * The soft-delete test for this module, and the reason it has no `visiblePage()`.
   *
   * A `DELETE` job's page is soft-deleted *by definition* — that is what enqueued the job — so a
   * `deletedAt: null` filter here would hide every failure of the one kind that guarantees one,
   * while the job went on blocking that page's queue for ever. The mutant is exactly that filter,
   * and it fails this test rather than merely becoming redundant.
   */
  const f = await fixture();
  const page = await f.page({ path: "retired", title: "Retired" });
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  await f.job({ pageId: page.id, kind: "DELETE", path: "retired" });

  const { failures } = await report(f.admin);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ kind: "DELETE", pageTitle: "Retired", pageDeleted: true });
});

test("changes queued behind a failure are counted on it, and another page's are not", async () => {
  /*
   * Task 6's barrier, read back. A `FAILED` job blocks its own page and no other, so the count
   * belongs to the failure and every unfinished job for that page is behind it.
   *
   * Two pages, because "counted the right rows" and "counted every unfinished row in the table"
   * are indistinguishable from a single-page fixture — the same discrimination the worker's own
   * blocking test needed.
   */
  const f = await fixture();
  const stuck = await f.page({ path: "stuck", title: "Stuck" });
  const fine = await f.page({ path: "fine", title: "Fine" });

  await f.job({ pageId: stuck.id, path: "stuck", minute: 1 });
  await f.job({ pageId: stuck.id, path: "stuck", state: "PENDING", attempts: 0, minute: 2 });
  await f.job({ pageId: stuck.id, path: "stuck", state: "PENDING", attempts: 0, minute: 3 });
  // Another page's queue keeps moving, which is the whole point of a per-page barrier.
  await f.job({ pageId: fine.id, path: "fine", state: "PENDING", attempts: 0, minute: 4 });
  await f.job({ pageId: fine.id, path: "fine", state: "DONE", minute: 5 });

  const { failures } = await report(f.admin);
  expect(one(failures).blocked).toBe(2);
});

test("a job that failed once and will be tried again is counted, not listed", async () => {
  /*
   * Step 2's third state, and the one the page has a number for. A `PENDING` job with attempts
   * spent has not given up; §10's promise is that a git host being down is not an incident.
   */
  const f = await fixture();
  const page = await f.page({ path: "retrying", title: "Retrying" });
  await f.job({ pageId: page.id, path: "retrying", state: "PENDING", attempts: 2 });
  // A never-attempted job is not "retrying" — it is simply queued, and counting it would make the
  // sentence on the page false on an ordinary busy morning.
  await f.job({ pageId: page.id, path: "retrying", state: "PENDING", attempts: 0 });

  const answer = await report(f.admin);
  expect(answer.failures).toEqual([]);
  expect(answer.retrying).toBe(1);
});

test("the list is capped, and says so", async () => {
  const f = await fixture();
  for (let n = 0; n < MAX_MIRROR_FAILURES + 2; n += 1) {
    const page = await f.page({ path: `p-${n}`, title: `Page ${n}` });
    await f.job({ pageId: page.id, path: `p-${n}`, minute: n });
  }

  const answer = await report(f.admin);
  expect(answer.failures).toHaveLength(MAX_MIRROR_FAILURES);
  expect(answer.truncated).toBe(true);
});

test("an untruncated list says it is not truncated", async () => {
  // The companion to the cap: `truncated: true` returned unconditionally passes the test above.
  const f = await fixture();
  const page = await f.page({});
  await f.job({ pageId: page.id });
  expect((await report(f.admin)).truncated).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* The credential — the sharpest thing in this task                           */
/* -------------------------------------------------------------------------- */

test("a credential stored in lastError does not come back out of the query", async () => {
  /*
   * `repo.ts` redacts on the way in, so nothing this build writes carries a token. This is the
   * guard on the **row**: a value written by an older build, by a hand-run `UPDATE`, or by a
   * future path that does not go through `failedRun`. Deleting the redaction in `failures.ts`
   * fails this test and nothing else; deleting the one in `repo.ts` fails `repo.test.ts` and not
   * this. Two transforms, two mutants, two failures — see `src/lib/git/redact.ts`.
   */
  const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
  const f = await fixture();
  const page = await f.page({});
  await f.job({
    pageId: page.id,
    lastError:
      `Pushing to the content remote: git exited 128. ` +
      `Command: ["push","--","https://badam:${token}@github.example/org/repo.git"]. ` +
      `Output: fatal: Authentication failed for 'https://badam:${token}@github.example/org/repo.git/'`,
  });

  const { failures } = await report(f.admin);
  const shown = one(failures).lastError ?? "";

  expect(shown).not.toContain(token);
  expect(shown).not.toContain("badam:");
  /*
   * The non-vacuity companion, and it is doing real work: `lastError: null`, `lastError: ""` and
   * a redactor that ate the whole message would all pass the two assertions above. What an
   * operator actually needs off this row is still here — what was attempted, what git said, and
   * which remote refused.
   */
  expect(shown).toContain("Pushing to the content remote");
  expect(shown).toContain("Authentication failed");
  expect(shown).toContain("github.example/org/repo.git");
  expect(shown).toContain("[redacted]@github.example");
});

/* -------------------------------------------------------------------------- */
/* Step 3 — the refusal                                                       */
/* -------------------------------------------------------------------------- */

test("a member of a space is refused, and reads not-found", async () => {
  /*
   * The mutation target for the `isSuperAdmin` guard, and a **discrimination** rather than an
   * absence: the same fixture the super admin reads a row out of, one line up, is refused to the
   * member. So "refused" cannot be confused with "there was nothing to show", which is how Phase
   * 4's non-member search was nearly vacuous.
   */
  const f = await fixture();
  const page = await f.page({});
  await f.job({ pageId: page.id });

  expect((await report(f.admin)).failures).toHaveLength(1);

  expect(await listMirrorFailures(f.member)).toEqual({ ok: false, reason: "not-found" });
  // And a viewer who belongs to nothing gets the same answer as one who belongs to something.
  // Two viewers, because a guard keyed on membership rather than on `isSuperAdmin` would let
  // exactly one of them through.
  expect(await listMirrorFailures(f.outsider)).toEqual({ ok: false, reason: "not-found" });
});

test("a member's own space's failure is refused too — this is not a per-space filter", async () => {
  /*
   * The mutant this kills is not "delete the guard" but "replace it with `readableSpace`": a
   * per-space filter would let an `engineering` editor read `engineering`'s failures, git's
   * stderr included, which is a remote URL and a filesystem path inside the container. The
   * refusal is about the surface, not about the rows.
   */
  const f = await fixture();
  const own = await f.page({ spaceId: f.members.id, path: "mine", title: "Mine" });
  await f.job({ pageId: own.id, path: "mine" });

  expect(await listMirrorFailures(f.member)).toEqual({ ok: false, reason: "not-found" });
});

/* -------------------------------------------------------------------------- */
/* The audit decision                                                         */
/* -------------------------------------------------------------------------- */

test("a super admin reading a failure in a MEMBERS space they do not belong to is audited once", async () => {
  /*
   * The decision, asserted: this is the same act as Phase 4's search, because the observable is
   * the same — a page title and a path out of a space the reader is not a member of.
   *
   * `inOneRequest` is the stand-in request scope `auditSpaceAccess` exports for exactly this;
   * `cache()` is inert outside an RSC render, so it is the only way the per-request dedupe is
   * testable at all.
   */
  const f = await fixture();
  const closed = await f.page({ spaceId: f.members.id, path: "closed", title: "Closed" });
  await f.job({ pageId: closed.id, path: "closed" });

  await inOneRequest(async () => {
    await listMirrorFailures(f.admin);
    // Twice in one request writes one row — the dedupe, which is `auditSpaceAccess`'s and not a
    // second copy of it here.
    await listMirrorFailures(f.admin);
  });

  const rows = await db.auditLog.findMany({
    where: { action: "space.access" },
    select: { actorId: true, spaceId: true, detail: true },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: f.root.id, spaceId: f.members.id });
});

test("an ALL_STAFF space's failure writes no audit row, and neither does a member's own space", async () => {
  /*
   * The non-vacuity companion for the row above, and the thing that makes the count meaningful:
   * `needsAccessAudit` is false for an `ALL_STAFF` space and false for a space the super admin is
   * a member of, so a call site that audited every space it touched would write rows here.
   */
  const f = await fixture();
  const openPage = await f.page({ spaceId: f.open.id, path: "open", title: "Open" });
  await f.job({ pageId: openPage.id, spaceKey: "handbook", path: "open" });

  const memberOfEverything: Viewer = {
    id: f.root.id,
    isSuperAdmin: true,
    memberships: [{ spaceId: f.members.id, role: "ADMIN" }],
  };
  const closed = await f.page({ spaceId: f.members.id, path: "closed", title: "Closed" });
  await f.job({ pageId: closed.id, path: "closed" });

  await inOneRequest(() => listMirrorFailures(memberOfEverything));

  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(0);
  // Non-vacuity: the same read by a super admin who is a member of neither writes a row for the
  // MEMBERS space and none for the ALL_STAFF one, so zero above is a predicate and not a
  // disconnected call site.
  await inOneRequest(() => listMirrorFailures(f.admin));
  const rows = await db.auditLog.findMany({
    where: { action: "space.access" },
    select: { spaceId: true },
  });
  expect(rows.map((row) => row.spaceId)).toEqual([f.members.id]);
});

test("a refused read writes no audit row at all", async () => {
  // The guard runs before the query, so a member who is refused has read nothing and there is
  // nothing to record. Stated as a test because an audit row written on a refusal would be a
  // trail that says a space was read when it was not.
  const f = await fixture();
  const page = await f.page({});
  await f.job({ pageId: page.id });

  await inOneRequest(() => listMirrorFailures(f.member));
  expect(await db.auditLog.count()).toBe(0);
});
