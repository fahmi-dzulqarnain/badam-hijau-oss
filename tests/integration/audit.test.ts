import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { getReadableSpaceByKey } from "@/lib/pages/repo";
import { inOneRequest, writeAudit } from "@/lib/audit/log";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/**
 * Two spaces and two people: a super admin who belongs to nothing, and a member of
 * `engineering`. `handbook` is `ALL_STAFF`, which is the case the audit must NOT fire for —
 * a super admin reading it is reading what everyone can read.
 *
 * The users are **real rows**, not synthetic ids. `AuditLog.actorId` is a foreign key, so a
 * viewer whose id names no user cannot be audited at all — which is a genuine failure path
 * and gets its own test below rather than being allowed to hide inside every other one.
 */
async function fixture() {
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const member = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const secrets = await db.space.create({
    data: { key: "secrets", name: "Secrets", initials: "SE", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: member.id, role: "EDITOR" },
  });

  return {
    engineering,
    secrets,
    handbook,
    // A super admin with no memberships at all — the Phase 1 gap, exactly.
    asRoot: { id: root.id, isSuperAdmin: true, memberships: [] } satisfies Viewer,
    // `memberships` has to name the real row: `can()` reads the in-memory list while
    // `readableSpace` filters on the SpaceMembership row, deliberately (PROGRESS).
    asMember: {
      id: member.id,
      isSuperAdmin: false,
      memberships: [{ spaceId: engineering.id, role: "EDITOR" }],
    } satisfies Viewer,
  };
}

const accessRows = () =>
  db.auditLog.findMany({ where: { action: "space.access" }, orderBy: { createdAt: "asc" } });

test("a super admin reads a members-only space they do not belong to: one row", async () => {
  const f = await fixture();

  const space = await getReadableSpaceByKey(f.asRoot, "engineering");
  expect(space?.key).toBe("engineering");

  const rows = await accessRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actorId: f.asRoot.id,
    action: "space.access",
    spaceId: f.engineering.id,
    // No page: this fires when the SPACE is resolved, which happens before any page is read
    // and also on the space landing page, where there is no page to name.
    pageId: null,
  });
  // Exactly these three keys and no others. The row says a super admin read a space they are
  // not a member of; it must not also carry the actor's email, the space's description, or
  // anything about what was read. `toEqual` rather than `toMatchObject` is the point of the
  // assertion — a leak added later is an EXTRA key, which `toMatchObject` would wave through.
  expect(rows[0]!.detail).toEqual({
    key: "engineering",
    visibility: "MEMBERS",
    by: "super-admin",
  });
  // The clock, not another copy of itself.
  expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test("a member reading their own space writes none", async () => {
  const f = await fixture();

  expect(await getReadableSpaceByKey(f.asMember, "engineering")).not.toBeNull();

  expect(await db.auditLog.count()).toBe(0);
});

test("a super admin reading an ALL_STAFF space writes none", async () => {
  const f = await fixture();

  expect(await getReadableSpaceByKey(f.asRoot, "handbook")).not.toBeNull();

  expect(await db.auditLog.count()).toBe(0);
});

test("a super admin who IS a member of the space writes none", async () => {
  const f = await fixture();
  await db.spaceMembership.create({
    data: { spaceId: f.engineering.id, userId: f.asRoot.id, role: "ADMIN" },
  });
  const asRootMember: Viewer = {
    ...f.asRoot,
    memberships: [{ spaceId: f.engineering.id, role: "ADMIN" }],
  };

  expect(await getReadableSpaceByKey(asRootMember, "engineering")).not.toBeNull();

  expect(await db.auditLog.count()).toBe(0);
});

test("a miss writes nothing — a space that does not resolve was not accessed", async () => {
  const f = await fixture();

  expect(await getReadableSpaceByKey(f.asRoot, "no-such-space")).toBeNull();
  // A stranger cannot read `engineering` at all, so there is nothing to audit either. A real
  // user with no membership ROW, not the member with an emptied `memberships` array —
  // `readableSpace` filters on the row, which is the deliberate second source of truth.
  const stranger = await db.user.create({
    data: { email: "stranger@example.com", name: "Nobody" },
  });
  const asStranger: Viewer = { id: stranger.id, isSuperAdmin: false, memberships: [] };
  expect(await getReadableSpaceByKey(asStranger, "engineering")).toBeNull();

  expect(await db.auditLog.count()).toBe(0);
});

/**
 * The per-request semantics, pinned rather than implied.
 *
 * A single page view resolves the space at least twice — the space layout, then
 * `getPublishedPage` — and the reader's queries are wrapped in `React.cache()`, which is
 * inert outside an RSC render (PROGRESS). So the memoization itself cannot be verified here;
 * `inOneRequest` stands in for the request scope and everything downstream of it is real:
 * the reader's own entry point, the dedupe key, and the database.
 *
 * The next test is the other half and is the one that kills the lazy fix: a module-level
 * `Set` would pass "one row for two reads" forever and audit a super admin exactly once in
 * the lifetime of the server process.
 */
test("two reads in one request write one row, not two", async () => {
  const f = await fixture();

  await inOneRequest(async () => {
    await getReadableSpaceByKey(f.asRoot, "engineering");
    await getReadableSpaceByKey(f.asRoot, "engineering");
  });

  expect(await accessRows()).toHaveLength(1);
});

test("two reads in two requests write two rows", async () => {
  const f = await fixture();

  await inOneRequest(() => getReadableSpaceByKey(f.asRoot, "engineering"));
  await inOneRequest(() => getReadableSpaceByKey(f.asRoot, "engineering"));

  expect(await accessRows()).toHaveLength(2);
});

test("two spaces in one request write one row each", async () => {
  const f = await fixture();

  await inOneRequest(async () => {
    await getReadableSpaceByKey(f.asRoot, "engineering");
    await getReadableSpaceByKey(f.asRoot, "secrets");
    await getReadableSpaceByKey(f.asRoot, "engineering");
  });

  const rows = await accessRows();
  expect(rows.map((r) => r.spaceId).sort()).toEqual([f.engineering.id, f.secrets.id].sort());
});

/**
 * The tension in the plan, tested from both ends: a failed audit write must not turn a
 * successful read into an error page, and must not disappear quietly either.
 *
 * The failure is real, not mocked. `actorId` is a foreign key to `User`, so a viewer whose id
 * names no user makes `auditLog.create` throw an FK violation — the same shape as a dropped
 * connection, and reachable without stubbing the client. In production the write is on
 * `after()` and the response has already been sent by then; here there is no request scope, so
 * the write happens inline on the read path, which is the harsher of the two and the one worth
 * asserting.
 */
test("a failed audit does not break the read, and is logged loudly", async () => {
  const f = await fixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const ghost: Viewer = { id: "no-such-user", isSuperAdmin: true, memberships: [] };

  const space = await getReadableSpaceByKey(ghost, "engineering");

  // The read succeeded. This is the assertion the whole arrangement exists for.
  expect(space?.key).toBe("engineering");
  expect(await db.auditLog.count()).toBe(0);

  expect(errors).toHaveBeenCalledTimes(1);
  const [message] = errors.mock.calls[0]!;
  // The log line carries the row that was lost, so it can be reconstructed from logs rather
  // than merely known to have existed. Fire-and-forget would print nothing at all.
  expect(message).toContain("[audit] FAILED to write space.access");
  expect(message).toContain(`actor=no-such-user`);
  expect(message).toContain(`space=${f.engineering.id}`);
  expect(message).toContain("key=engineering");
});

test("a failed audit is attempted once per request, not retried per call", async () => {
  const f = await fixture();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const ghost: Viewer = { id: "no-such-user", isSuperAdmin: true, memberships: [] };

  await inOneRequest(async () => {
    await getReadableSpaceByKey(ghost, "engineering");
    await getReadableSpaceByKey(ghost, "engineering");
  });

  // The dedupe marks the key before attempting the write, so a second read in the same
  // request does not re-attempt a write that has already failed — one lost row, one log line.
  expect(errors).toHaveBeenCalledTimes(1);
});

test("writeAudit records exactly the fields it is given", async () => {
  const f = await fixture();
  const page = await db.page.create({
    data: {
      spaceId: f.engineering.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      createdById: f.asMember.id,
      status: "CURRENT",
    },
  });

  await writeAudit(db, {
    actorId: f.asMember.id,
    action: "page.publish",
    spaceId: f.engineering.id,
    pageId: page.id,
    detail: { path: page.path, versionId: "v1", title: "MQTT contracts" },
  });
  // `pageId` is optional, and omitting it must mean null rather than undefined-shaped
  // nonsense: this is the shape `space.access` writes.
  await writeAudit(db, {
    actorId: f.asMember.id,
    action: "space.access",
    spaceId: f.engineering.id,
    detail: { key: "engineering", visibility: "MEMBERS", by: "super-admin" },
  });

  const rows = await db.auditLog.findMany({ orderBy: { action: "asc" } });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    action: "page.publish",
    actorId: f.asMember.id,
    spaceId: f.engineering.id,
    pageId: page.id,
    detail: { path: "architecture/mqtt-contracts", versionId: "v1", title: "MQTT contracts" },
  });
  expect(rows[1]!.pageId).toBeNull();
});

/**
 * The consolidation, guarded rather than trusted.
 *
 * Task 13's job was to make one helper out of five inline `auditLog.create` calls. Nothing
 * stops the sixth mutation from writing its own — and the cost of that is not style, it is
 * that a future change to the envelope (a required column, a redaction rule, a retention tag)
 * silently applies to five call sites out of six. Same shape as the soft-delete sweep in
 * `src/lib/pages/visible.test.ts`, for the same reason.
 */
const SRC = new URL("../../src", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = join(SRC, "..");
const AUDIT_MODULE = "src/lib/audit/log.ts";

function sweep(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      // Any delegate call on AuditLog, through the client or a transaction client. Matching
      // the model rather than `create` on purpose: a future `auditLog.update` or
      // `auditLog.deleteMany` outside this module is a bigger problem than a second insert.
      if (/\b(?:db|tx)\.auditLog\.\w+\(/.test(readFileSync(full, "utf8"))) {
        found.push(relative(ROOT, full));
      }
    }
  }
  return found;
}

test("AuditLog is only ever written through writeAudit", () => {
  expect(
    sweep(SRC).filter((file) => file !== AUDIT_MODULE),
    "write the row through `writeAudit(tx, entry)` instead of a bare `auditLog.create`",
  ).toEqual([]);
});

test("the sweep can actually see a stray write", () => {
  // The guard above passes trivially if the pattern is wrong, and a pattern that matches
  // nothing looks exactly like a codebase with nothing to report. Proven against the one file
  // that does write the row: it is found, and only excluded by name.
  expect(sweep(SRC)).toEqual([AUDIT_MODULE]);
});
