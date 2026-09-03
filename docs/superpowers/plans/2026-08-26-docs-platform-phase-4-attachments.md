# Phase 4 — Attachments on SharePoint, and the Entra ID cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor can put a file — screenshot, document, screen recording — into a document,
and a reader sees it if and only if they could read the page it belongs to.

**Architecture:** A SharePoint document library the platform owns, reached over Microsoft Graph
with an app-only token. Uploads bypass the application via a Graph resumable upload session
URL; downloads proxy through the application under the same `visiblePage`/`readableSpace`
predicates as any page read. Identity moves to Entra ID, which is a configuration change.

**Tech Stack:** Next.js 16 App Router, Prisma 6 / Postgres 16, Auth.js v5, zod 4, Microsoft
Graph v1.0, Vitest, Playwright.

Spec: [`../specs/2026-08-26-attachments-sharepoint-entra-design.md`](../specs/2026-08-26-attachments-sharepoint-entra-design.md) ·
Platform spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md) ·
Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md) ·
Phase 3: [`2026-08-24-docs-platform-phase-3-doc-types.md`](2026-08-24-docs-platform-phase-3-doc-types.md)

**Deliverable.** An editor pastes a screenshot into the editor and it appears in the preview and
in the published page. A non-member who guesses the URL gets a 404. A screen recording plays
inline with working seek. `npm run smoke` uploads, commits, reads and 404s a file from a cold
start with no tenant credentials.

---

## Three corrections to the spec, found while writing this plan

The spec was approved before these were measured. Each is recorded here **and amended in the
spec**, because a plan that silently disagrees with its spec makes both untrustworthy.

### 1. Inline video does NOT widen the sanitiser (spec §7.5)

The spec says the sanitiser schema gains `<video>`. Measured against the shipped pipeline, that
is **ineffective**: [`src/lib/markdown/render.ts`](../../../src/lib/markdown/render.ts) sets
`remarkRehype`'s `allowDangerousHtml: false`, so raw HTML is dropped *before* the sanitiser ever
runs. Widening the schema would change nothing, and the only way to make it matter — enabling
raw HTML and adding `rehype-raw` — exposes the entire raw-HTML surface of every existing
document to the sanitiser. That is a far larger posture change than the feature justifies.

**Instead: a rehype plugin that runs after sanitisation and constructs the element itself**,
exactly as `extractMermaid` already does for diagrams. The editor inserts
`![alt](/api/attachments/<id>/video)`; the plugin rewrites any `<img>` whose `src` matches
`^/api/attachments/([a-z0-9]+)/video$` into a `<video>` built from the **captured id**.

This is strictly safer than the allowlist the spec proposed. The `src` is not *validated*, it is
*reconstructed* from a regex capture, so an off-origin video is impossible by construction
rather than by allowlist. The sanitiser is not touched at all. Task 14.

### 2. The drive key shards on the id prefix, not on the date (spec §5.2)

The spec's key is `/{yyyy}/{mm}/{attachmentId}.{ext}`. Both `id` and `createdAt` are database
defaults, so **neither is known before the row exists** — the key cannot be computed for the
`create` that produces it. That forces either a second write (leaving a committed row with an
empty `drivePath`, which the sweep would reclaim as garbage) or generating ids outside Prisma,
breaking the `cuid()` convention every other model follows.

**Instead: `{id[0:2]}/{id}{ext}`**, computed from the id inside one transaction. Sharding is
preserved and distributes more evenly than months do. What is given up is human browsability of
the library, which was the stated reason for date sharding — the library is not a browsing
surface, and the sweep cursors on `createdAt` in Postgres, where the column actually lives.

### 3. The memory store needs a dev upload endpoint, which the spec did not account for

The browser `PUT`s chunks to a URL the store hands it. For `BLOB_STORE=memory` that URL must be
something a test, a Playwright browser and `smoke.sh` can actually `PUT` to — otherwise the
memory store cannot exercise the direct-upload path at all, and the spec's goal that "local
development, the integration suite and `npm run smoke` all run with no tenant credentials"
is unreachable.

So there is a `PUT /api/attachments/_dev-upload/[...key]` route, **registered under exactly the
`ALLOW_TEST_LOGIN` discipline**: it refuses unless `BLOB_STORE=memory`, and a test asserts it
404s otherwise. Task 7. Treat it with the same suspicion as the passwordless login.

---

## Decisions taken with the user before writing this

- **App-owned SharePoint library**, not per-user OneDrive. Files belong to the document, so they
  survive someone leaving; and an app-only token means no per-user consent, no token
  persistence, no refresh machinery.
- **Upload bypasses the app, download proxies through it.** Video bandwidth stays off Next.js on
  the way in, while the read path stays governed by SQL predicates.
- **Any file type, including video.** The expensive corner, chosen deliberately.
- **This is Phase 4**; search/diagrams, git mirror, systems/admin shift to 5, 6, 7.

## What Phase 4 does NOT do

- **Image resizing, thumbnails, transcoding, a media library UI, cross-page reuse.** Spec §3.
- **Virus scanning, rate limiting.** Spec §3. Named so the absence is a decision.
- **A durable job queue.** Retention is `scripts/sweep-attachments.mjs`, run by hand or cron.
  The git-mirror phase owns the queue, and building it here means building it against
  requirements that do not exist yet.
- **Delegated Graph tokens for anything, including profile photos.** Avatars go null after the
  cutover; spec §4.3 records why that is accepted rather than fixed.
- **Search over attachment filenames.** Phase 5 owns search.

## Landmines this phase introduces

**`editableSpace` composed naively silently denies a super admin.** `readableSpaceWhere` returns
`{}` for a super admin, so `readableSpace(v, { memberships: { some: { … } } })` leaves the
membership filter standing alone and a super admin reads nothing. It must make the same
`isSuperAdmin` short-circuit `can()` makes. Task 3 tests that case first.

**Merging the two space predicates is a directional authorization bypass.** The read predicate
needs both `readableSpace` and `editableSpace` on the page's space, and they go in **separate
varargs** of `visiblePage`, which makes a key collision structurally impossible.

Corrected during Task 3, after a reviewer measured it: two literal `space:` keys in one object
are **not** silent — that is `TS1117`, a compile error. The form tsc and Prisma cannot see is
merging them into one value, and which one wins depends on order:

```
{ space: { ...editableSpace(v), ...readableSpace(v) } }  // BYPASS: edit requirement gone
{ space: { ...readableSpace(v), ...editableSpace(v) } }  // merely over-restrictive
```

The first returned a members-only page to a VIEWER against Postgres. Watch for the merge, not
the duplicate key.

**Reading an attachment reaches `Page` only through a relation filter.** No `page` delegate token
appears anywhere in `src/lib/attachments/repo.ts`. That is widening #4 in
[`visible.test.ts`](../../../src/lib/pages/visible.test.ts)'s docstring — the shape that was
invisible to both halves of the sweep. Task 9 registers it.

**We never see the bytes, so `nosniff` is load-bearing.** The application cannot magic-byte
sniff an upload that never passes through it. A file declared `image/png` containing HTML is
safe *only* because it is served with `X-Content-Type-Options: nosniff` and a `Content-Type`
taken from the validated allowlist in Postgres. Removing either makes stored XSS reachable.

**A filename reaches an HTTP header.** `Content-Disposition` carrying a raw filename is header
injection. Strip CR, LF and quotes, and RFC 5987 percent-encode the non-ASCII form. Task 4
tests the injection case, not only the accent case.

**`Cache-Control: private` is a permission boundary.** `public` lets a shared corporate proxy
cache a members-only screenshot and serve it to a non-member.

**A commit endpoint that trusts the client's `driveItemId` trusts the client.** The browser
receives Graph's completion response. Stat by the key the application derived; never accept an
id from the request body.

## Conventions that carry forward

Settled in Phases 1–3. Changing one is a decision, not a detail.

- `readableSpace(...)`, `editableSpace(...)` and `visiblePage(...)` return complete `where`
  objects and **must never be spread**, at any nesting depth.
- Every query states its own permission predicate; none is guarded by call ordering.
- Never `include:`; always an explicit `select:`.
- **Every module that queries the database is registered** in `src/lib/pages/visible.test.ts`.
- Pure logic imports nothing from Prisma and unit-tests without a database.
- Integration tests run against a real Postgres whose `DATABASE_URL` ends `_test`.
- A concurrency test that never blocks is not testing a write predicate.
- `npm run plan:check` must report **0 drifted** before a task is closed.
- Implementers create a new commit, never `--amend`, and stage explicit paths.

**A mass test failure is interference until proven otherwise.** There is one local Postgres and
one `badam_test` database, with no per-worktree isolation, and the integration harness truncates
it between tests. Two `vitest` runs at once therefore truncate each other's fixtures, and the
symptom is dozens to hundreds of `Unique constraint failed` errors on fixed fixture values —
not a compile error, not one focused failure. Seen for real during Task 6: 146 failures, then
859/859 on an immediate re-run with nothing changed, with two orphaned vitest workers from a
previous run still alive.

So: before treating a large failure count as a regression, run `ps aux | grep vitest`, kill any
orphans, and re-run. A genuine regression from one task's change is small and specific.

**Editing a file an earlier plan quotes whole-file will trip `plan:check`, and the fix is not
to re-sync that fence.** Found during Task 3: `src/lib/authz/where.ts` and
`tests/integration/authz-where.test.ts` are quoted whole-file by the Phase 1 plan, so appending
to them reported drift. Syncing the Phase 1 fence forward would be wrong — it would turn a
"create" step into a rewrite that silently deletes the later addition, which is the exact
failure `check-plan-fences.mjs`'s own docstring says it exists to prevent. Add a
**supersession note** above the stale fence instead, naming the task that superseded it and
pointing at the live file; the checker recognises those and reports them separately.

Three later tasks in this phase will hit it, so expect it rather than rediscovering it:

| Task | File | Quoted whole-file by |
|---|---|---|
| 14 | `src/lib/markdown/render.ts` | phase-1 plan |
| 18 | `playwright.config.ts` | phase-1 plan |
| 19 | `scripts/smoke.sh` | phase-1 plan (extended by phases 2 and 3) |

## File structure

| File | Responsibility |
|---|---|
| `src/lib/blob/store.ts` | `BlobStore` interface and its value types. No I/O. |
| `src/lib/blob/memory.ts` | In-memory store: tests, local dev, smoke. |
| `src/lib/blob/graph.ts` | Microsoft Graph / SharePoint implementation. |
| `src/lib/blob/token.ts` | App-only token, cached by expiry. |
| `src/lib/blob/select.ts` | Chooses the implementation from env; refuses to guess. |
| `src/lib/attachments/policy.ts` | Pure: mime allowlist, extension, drive key, disposition. |
| `src/lib/attachments/schema.ts` | zod input and `MAX_UPLOAD_BYTES`. |
| `src/lib/attachments/repo.ts` | Prisma. Owns every permission rule. |
| `src/lib/markdown/attachment-video.ts` | Rehype plugin: `<img …/video>` → `<video>`. |
| `src/app/api/attachments/route.ts` | `POST` — begin an upload. |
| `src/app/api/attachments/[id]/commit/route.ts` | `POST` — two-phase commit. |
| `src/app/api/attachments/[id]/route.ts` | `GET`/`HEAD` proxy, `DELETE` soft-delete. |
| `src/app/api/attachments/_dev-upload/[...key]/route.ts` | `PUT`, memory store only. |
| `src/lib/editor/upload.ts` | Client transport: session, chunking, resume. |
| `src/components/AttachmentDrop.tsx` | Paste/drag/pick, progress, reference insertion. |
| `scripts/sweep-attachments.mjs` | Retention and orphan reconciliation. |

---

## Task 1: The Entra ID cutover

Documentation and configuration only. Spec §4 establishes there is no code change; this task
makes that claim checkable by someone doing the cutover.

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/ops/entra-id-and-sharepoint.md`

- [ ] **Step 1: Add the new variables to `.env.example`**

Append to `.env.example`:

```bash
# Entra ID. TENANT-SPECIFIC issuer, never `common`: Auth.js validates `iss`, so this is what
# pins the tenant. The app registration MUST emit the optional `email` claim — Entra v2.0
# does not send it by default, and `isAllowedSignIn` fails closed on a missing email, so the
# symptom is "nobody can sign in". Do NOT add a `preferred_username` fallback: Microsoft
# documents that claim as mutable and User.email is the @unique key identity is matched on.
# OIDC_ISSUER="https://login.microsoftonline.com/<tenant-id>/v2.0"

# SharePoint document library, reached with an app-only token. The app registration needs
# Sites.Selected — NOT Files.ReadWrite.All, which grants every drive in the tenant including
# every employee's personal OneDrive. See docs/ops/entra-id-and-sharepoint.md.
GRAPH_TENANT_ID=""
GRAPH_CLIENT_ID=""
GRAPH_CLIENT_SECRET=""
GRAPH_DRIVE_ID=""
# "graph" or "memory". The CODE has no default and refuses to boot on an unset or
# unrecognised value — "memory" would let a deployment accept uploads and lose them on
# restart, and "graph" would break every laptop and the smoke test, so neither is safe to
# assume. A DEPLOYMENT MUST SET THIS TO "graph". `memory` is additionally refused under
# NODE_ENV=production unless BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION=1.
#
# The value here is "memory" rather than empty on purpose: `scripts/setup-db.sh` generates
# .env.test by sed-ing this file, so an empty value here makes every attachment integration
# test throw at the first store call.
BLOB_STORE="memory"
# Bytes. Must stay under 2^31-1: Attachment.sizeBytes is an Int.
MAX_UPLOAD_BYTES="536870912"
ATTACHMENT_RETENTION_DAYS="30"
```

- [ ] **Step 2: Add the line to the environments that already exist**

`scripts/setup-db.sh` skips `.env.test` when it is already present, and nobody's `.env` is
regenerated. So add `BLOB_STORE="memory"` by hand to both, on this machine and on every other
one, before Task 7 lands. Without it the first store call throws and the failure reads like a
bug in the store rather than a missing variable — which is exactly the loud failure `select.ts`
is designed to produce, arriving at the least convenient moment.

```bash
grep -q '^BLOB_STORE=' .env      || echo 'BLOB_STORE="memory"' >> .env
grep -q '^BLOB_STORE=' .env.test || echo 'BLOB_STORE="memory"' >> .env.test
```

- [ ] **Step 3: Write the cutover runbook**

Create `docs/ops/entra-id-and-sharepoint.md` covering, in order: registering the application;
adding the redirect URI `${AUTH_URL}/api/auth/callback/company`; configuring the optional
`email` claim on the ID token; setting `ALLOWED_EMAIL_DOMAINS` to the verified domains;
requesting `Sites.Selected`; and the per-site grant, which is a `POST` an administrator makes:

```
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{ "roles": ["write"],
  "grantedToIdentities": [{ "application": { "id": "<client-id>", "displayName": "Badam" } }] }
```

State explicitly that `Sites.Selected` **without** that grant returns 403 on every call, which
is the expected intermediate state and not a misconfiguration.

- [ ] **Step 4: Note the avatar regression in `README.md`**

Under signing in, add: Entra ID sends no `picture` claim, so `avatarUrl` is null for accounts
created after the cutover. This is accepted — fetching `/me/photo/$value` needs delegated Graph
tokens, which is the machinery Phase 4 avoids by authenticating as the application.

- [ ] **Step 5: Verify nothing broke**

Run: `npm run typecheck && npm test`
Expected: PASS, unchanged counts. This task touches no code, and that is the point.

- [ ] **Step 6: Commit**

```bash
git add .env.example README.md docs/ops/entra-id-and-sharepoint.md
git commit -m "Document the Entra ID cutover and the SharePoint grant"
```

---

## Task 2: Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_attachments/migration.sql` (generated)

- [ ] **Step 1: Add the enum and model**

Add to `prisma/schema.prisma`, beside the other enums and after `model BugReport`:

```prisma
enum AttachmentState {
  PENDING
  COMMITTED
}

model Attachment {
  id           String          @id @default(cuid())
  pageId       String
  // Graph's own id, learned at commit — the item does not exist when the row is created,
  // which is why this is nullable. `drivePath` is the handle everything else uses.
  driveItemId  String?         @unique
  drivePath    String
  filename     String
  mimeType     String
  // Int, not BigInt, which caps usable size just under 2GB. MAX_UPLOAD_BYTES defaults to
  // 512MB so there is headroom, but raising it past 2^31-1 is a column-type migration rather
  // than a config change — and BigInt maps to a JS `bigint`, which `JSON.stringify` throws
  // on, so every response carrying this field would then need a cast at the boundary.
  sizeBytes    Int
  eTag         String?
  // PENDING from the moment the upload session is minted. The browser uploads directly to
  // Graph, so the application never sees the bytes and cannot know the upload finished; the
  // commit endpoint verifies against the store and flips this. A PENDING row is never served.
  state        AttachmentState @default(PENDING)
  uploadedById String
  createdAt    DateTime        @default(now())
  deletedAt    DateTime?

  // Cascade: without it, hard-deleting a page is blocked by its own attachments, via Prisma's
  // Restrict default on a required relation — the same reasoning that makes Page cascade from
  // Space. Deliberately the opposite of BugReport, which carries no foreign keys at all
  // because its value is highest once the page is gone. An attachment is worthless without
  // its page. `uploadedBy` takes the Restrict default instead, matching BugReport.reporter,
  // PageVersion.author and Page.createdBy — a person is not deleted out from under their work.
  page       Page @relation(fields: [pageId], references: [id], onDelete: Cascade)
  uploadedBy User @relation("AttachmentUploader", fields: [uploadedById], references: [id])

  @@index([pageId])
  // The sweep's abandoned-upload pass: `state = 'PENDING' AND createdAt < now() - 24h`.
  // Equality then range, which is the column order a composite index wants.
  @@index([state, createdAt])
  // The sweep's purge pass — `deletedAt` older than the retention window — which is
  // selective. NOT the read path, and do NOT delete this on the strength of Page's note
  // below: that measurement is about `deletedAt IS NULL`, which matches most of the table and
  // seq-scans either way. This index serves the inverse query, exactly as Page's own does.
  @@index([deletedAt])
}
```

- [ ] **Step 2: Add the back-relations**

Add to `model Page`, beside `relationsTo`:

```prisma
  attachments   Attachment[]
```

Add to `model User`, beside `auditEntries`:

```prisma
  attachments  Attachment[]      @relation("AttachmentUploader")
```

- [ ] **Step 3: Generate the migration**

Run: `npx prisma migrate dev --name attachments`
Expected: a new migration directory, and `Attachment` in the generated client.

- [ ] **Step 4: Verify the guard notices the new model**

Run: `npm test -- visible.test.ts`
Expected: PASS. Nothing queries `Attachment` yet, so the sweep finds no new module. This step
exists to establish the baseline the failure in Task 9 is measured against.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add the Attachment model"
```

---

## Task 3: `editableSpace`, and the super-admin trap

**Files:**
- Modify: `src/lib/authz/where.ts`
- Test: `tests/integration/authz-where.test.ts`

- [ ] **Step 1: Write the failing test — the super admin first**

Add to `tests/integration/authz-where.test.ts`. That file already imports `db, resetDb` from
`../setup/reset` and calls `beforeEach(resetDb)`, so keys can be fixed rather than randomised.
The super-admin case is written first because it is the one the naïve implementation gets wrong:

```ts
async function editSpace(visibility: "MEMBERS" | "ALL_STAFF") {
  return db.space.create({
    data: { key: "editing", name: "Editing", initials: "ED", visibility },
    select: { id: true },
  });
}

async function memberViewer(email: string, spaceId: string, role: SpaceRole): Promise<Viewer> {
  const user = await db.user.create({ data: { email, name: email }, select: { id: true } });
  // A REAL membership row. `editableSpace` filters on the row in SQL while `can()` reads
  // `Viewer.memberships` — a synthetic viewer with a self-declared membership passes the
  // second while reading nothing through the first.
  await db.spaceMembership.create({ data: { spaceId, userId: user.id, role } });
  return { id: user.id, isSuperAdmin: false, memberships: [{ spaceId, role }] };
}

async function isEditable(viewer: Viewer, spaceId: string): Promise<boolean> {
  const found = await db.space.findFirst({
    where: editableSpace(viewer, { id: spaceId }),
    select: { id: true },
  });
  return found !== null;
}

test("editableSpace admits a super admin with NO membership row", async () => {
  const space = await editSpace("MEMBERS");
  const god = await db.user.create({
    data: { email: "root@example.com", name: "Root", isSuperAdmin: true },
    select: { id: true },
  });

  // The naive composition — readableSpace(v, { memberships: { some: … } }) — is FALSE here:
  // readableSpaceWhere is {} for a super admin, so the membership filter stands alone and
  // demands a row they do not have. `can()` short-circuits on isSuperAdmin, and these two
  // mechanisms must not disagree.
  expect(await isEditable({ id: god.id, isSuperAdmin: true, memberships: [] }, space.id)).toBe(true);
});

test("editableSpace admits an EDITOR and an ADMIN, and refuses a VIEWER", async () => {
  const space = await editSpace("ALL_STAFF");
  for (const [role, expected] of [["EDITOR", true], ["ADMIN", true], ["VIEWER", false]] as const) {
    const viewer = await memberViewer(`${role.toLowerCase()}@example.com`, space.id, role);
    expect(await isEditable(viewer, space.id), role).toBe(expected);
  }
});

test("editableSpace refuses a non-member of an ALL_STAFF space", async () => {
  // ALL_STAFF grants READ to any signed-in user but never EDIT — the one place where the
  // readable and editable predicates must diverge.
  const space = await editSpace("ALL_STAFF");
  const stranger = await db.user.create({
    data: { email: "nobody@example.com", name: "Nobody" }, select: { id: true },
  });
  expect(
    await isEditable({ id: stranger.id, isSuperAdmin: false, memberships: [] }, space.id),
  ).toBe(false);
});
```

Add `editableSpace` to the file's existing import from `@/lib/authz/where`, and `SpaceRole` to
its import from `@/lib/authz/types`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- authz-where.test.ts`
Expected: FAIL — `editableSpace is not exported from '@/lib/authz/where'`.

- [ ] **Step 3: Implement it**

Append to `src/lib/authz/where.ts`:

```ts
/**
 * The edit predicate alone. Deliberately NOT exported, for the same reason as
 * `readableSpaceWhere`: composing it by spread is an authorization bug tsc cannot see.
 *
 * The `isSuperAdmin` short-circuit is load-bearing and is the whole reason this cannot be
 * written as `readableSpace(viewer, { memberships: { some: … } })`. That composition returns
 * `{ AND: [{}, { memberships: … }] }` for a super admin — the membership filter standing
 * alone — so a super admin with no row reads nothing, while `can()` says they may edit
 * everything. `can.ts` already warns that these two mechanisms must change together.
 *
 * Note what is NOT here: `visibility: "ALL_STAFF"`. An ALL_STAFF space is readable by any
 * signed-in user and editable by nobody who is not a member, which is the one place the two
 * predicates must diverge.
 *
 * This is the EDIT row of `can()`'s table and nothing else. It is NOT a `MANAGE_SPACE`
 * predicate — that needs ADMIN alone, and this admits EDITOR, so reusing it there is an
 * escalation. It is a valid `PUBLISH` predicate only because `can()` collapses PUBLISH into
 * EDIT today; if that ever splits, this needs a sibling rather than a second caller.
 */
function editableSpaceWhere(viewer: Viewer): Prisma.SpaceWhereInput {
  if (viewer.isSuperAdmin) return {};
  return {
    memberships: { some: { userId: viewer.id, role: { in: ["EDITOR", "ADMIN"] } } },
  };
}

/**
 * The only sanctioned way to filter spaces by "this viewer may edit here". Returns the
 * COMPLETE `where`, exactly like `readableSpace` — and like it, **must never be spread**, at
 * any nesting depth. Pass it directly: `where: editableSpace(v, { id })`, or nested as
 * `{ space: editableSpace(v) }`.
 *
 * Where both predicates are needed on one query they go in SEPARATE varargs of the composing
 * helper, which makes a key collision structurally impossible. Two literal `space:` keys in
 * one object are at least a compile error (TS1117); what tsc and Prisma cannot see is MERGING
 * them into one value, and it is DIRECTIONAL. Verified against Postgres:
 *
 *     { space: { ...editableSpace(v), ...readableSpace(v) } }  // BYPASS: last AND wins,
 *                                                              // the edit requirement is gone
 *     { space: { ...readableSpace(v), ...editableSpace(v) } }  // merely over-restrictive
 *
 * The first form returned a members-only page to a VIEWER. That is the shape to watch for,
 * not the duplicate key.
 */
export function editableSpace(
  viewer: Viewer,
  ...and: Prisma.SpaceWhereInput[]
): Prisma.SpaceWhereInput {
  return { AND: [editableSpaceWhere(viewer), ...and] };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- authz-where.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add src/lib/authz/where.ts tests/integration/authz-where.test.ts
git commit -m "Add editableSpace, with the super-admin short-circuit can() makes"
```

---

## Task 4: `policy.ts` — the pure serving rules

**Files:**
- Create: `src/lib/attachments/policy.ts`
- Test: `src/lib/attachments/policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/attachments/policy.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  contentDisposition,
  driveKeyFor,
  extensionFor,
  isAllowedMime,
  isInlineMime,
} from "./policy";

test("the allowlist admits rasters, video and documents", () => {
  for (const mime of ["image/png", "image/jpeg", "video/mp4", "application/pdf"]) {
    expect(isAllowedMime(mime), mime).toBe(true);
  }
});

test("SVG and HTML are allowed as UPLOADS but never served inline", () => {
  // Refusing the upload outright would be a worse trade: an SVG diagram is a legitimate
  // attachment. The safety comes from how it is SERVED, not from refusing to store it.
  expect(isAllowedMime("image/svg+xml")).toBe(true);
  expect(isInlineMime("image/svg+xml")).toBe(false);
  expect(isAllowedMime("text/html")).toBe(true);
  expect(isInlineMime("text/html")).toBe(false);
});

test("an unknown mime is refused", () => {
  expect(isAllowedMime("application/x-msdownload")).toBe(false);
  expect(isAllowedMime("")).toBe(false);
});

test("a plain filename is quoted, and inline types say inline", () => {
  expect(contentDisposition("image/png", "shot.png")).toBe('inline; filename="shot.png"');
  expect(contentDisposition("application/pdf", "report.pdf")).toBe(
    'attachment; filename="report.pdf"',
  );
});

test("a non-ASCII filename gets an RFC 5987 form alongside an ASCII fallback", () => {
  expect(contentDisposition("application/pdf", "laporan-kewangan-²⁰²⁵.pdf")).toBe(
    "attachment; filename=\"laporan-kewangan-.pdf\"; filename*=UTF-8''laporan-kewangan-%C2%B2%E2%81%B0%C2%B2%E2%81%B5.pdf",
  );
});

test("a filename cannot inject a header", () => {
  // The whole reason this function exists rather than a template literal at the call site.
  // CR and LF end a header; a bare quote ends the quoted-string and lets the rest of the
  // filename be read as further parameters.
  const hostile = 'ok".\r\nSet-Cookie: a=b\r\nX: "y.png';
  const header = contentDisposition("image/png", hostile);
  expect(header).not.toMatch(/[\r\n]/);
  expect(header.match(/"/g)).toHaveLength(2);
});

test("an empty or dot-only filename falls back to the attachment id's shape", () => {
  expect(contentDisposition("image/png", "")).toBe('inline; filename="file.png"');
  expect(contentDisposition("image/png", "..")).toBe('inline; filename="file.png"');
});

test("the drive key is a two-hex shard, the id, and the extension", () => {
  expect(driveKeyFor("ckabcdef0000", "image/png")).toMatch(/^[0-9a-f]{2}\/ckabcdef0000\.png$/);
  expect(extensionFor("video/mp4")).toBe(".mp4");
});

test("the drive key is a pure function of id and mime", () => {
  // Not of the date: `createdAt` is a database default, so it is unknown at the moment the
  // key must be computed.
  expect(driveKeyFor("aa1", "image/png")).toBe(driveKeyFor("aa1", "image/png"));
});

test("consecutively minted cuids do NOT collapse into one shard", () => {
  // The regression guard, and the whole reason the shard is hashed rather than sliced.
  // These are twelve REAL ids, minted back to back by Prisma against this schema.
  const ids = [
    "cmtacm2a80005yd0p8u3izx4i", "cmtacm2af0007yd0p9nv5e99l",
    "cmtacm2ag0009yd0pw835iijm", "cmtacm2ag000byd0pmepp3lhv",
    "cmtacm2ah000dyd0pfu2shv3k", "cmtacm2ai000fyd0p5px9y794",
    "cmtacm2aj000hyd0p9h4i7kc6", "cmtacm2ak000jyd0paoil0tdj",
    "cmtacm2ak000lyd0pb9hp209z", "cmtacm2ak000nyd0p4up54j01",
    "cmtacm2al000pyd0pvy3ct2jq", "cmtacm2al000ryd0p0tcvqx31",
  ];

  // What the code used to do, pinned so the failure is legible rather than mysterious: a
  // cuid is "c" + a base-36 millisecond timestamp + counter + fingerprint + random, so the
  // leading two characters are effectively constant for years. If THIS assertion ever fails,
  // Prisma's id format changed — which is information, not a broken test.
  expect(new Set(ids.map((id) => id.slice(0, 2))).size).toBe(1);

  const shards = new Set(ids.map((id) => driveKeyFor(id, "image/png").slice(0, 2)));
  expect(shards.size).toBe(ids.length);
});

test("a thousand near-identical ids spread across most of the bucket space", () => {
  // Tests the class rather than the corpus. The twelve ids above are a fixed sample and a
  // hash could pass them by luck; this asserts the property that matters — that ids sharing
  // a long prefix, which is exactly what sequential cuids are, still scatter.
  const ids = Array.from({ length: 1000 }, (_, i) => `cmtacm2a${String(i).padStart(6, "0")}yd0p`);
  const shards = new Set(ids.map((id) => driveKeyFor(id, "image/png").slice(0, 2)));

  // 256 buckets, 1000 draws: coupon-collector says essentially all of them should appear.
  // 200 is a floor well clear of chance, not a target.
  expect(shards.size).toBeGreaterThan(200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- policy.test.ts`
Expected: FAIL — cannot resolve `./policy`.

- [ ] **Step 3: Implement it**

Create `src/lib/attachments/policy.ts`:

```ts
/**
 * How an attachment may be uploaded and how it must be served. Pure: plain values in, plain
 * values out, nothing imported from Prisma, so every rule here unit-tests without a database.
 *
 * The serving rules are the reason it is safe that the application never sees the bytes. An
 * upload goes straight from the browser to Graph, so there is no point at which magic bytes
 * could be inspected. What makes that acceptable is entirely here: a `Content-Type` drawn from
 * this allowlist, `X-Content-Type-Options: nosniff` at the route, and an inline set that
 * excludes every format a browser will execute.
 */

/** Extension per allowed type. Membership in this map IS the allowlist. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

/**
 * Served with `Content-Disposition: inline`. Everything else downloads.
 *
 * `image/svg+xml` and `text/html` are deliberately ABSENT while remaining uploadable. An
 * inline SVG is script execution against our own origin — worse than the same file hosted
 * anywhere else, because it inherits the session. Video is present because a browser will not
 * execute an mp4, and `<video>` needs the bytes inline to play them.
 */
const INLINE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
]);

export function isAllowedMime(mimeType: string): boolean {
  return Object.hasOwn(MIME_EXTENSIONS, mimeType);
}

export function isInlineMime(mimeType: string): boolean {
  return INLINE_MIMES.has(mimeType);
}

export function extensionFor(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] ?? "";
}

/**
 * The object key, sharded on a HASH of the id rather than a slice of it.
 *
 * Not sharded on the date the spec first proposed, because `id` and `createdAt` are both
 * database defaults: neither is known when the key must be computed for the `create` that
 * produces the row.
 *
 * And **not sharded on `id.slice(0, 2)`**, which is what replaced the date and was worse than
 * what it replaced. A Prisma `cuid()` is `"c" + Date.now().toString(36) + counter + fingerprint
 * + random`, so the first character is the literal `c` and the second is the most significant
 * base-36 digit of a millisecond timestamp — which advances about once every two and a half
 * years. Measured on twelve consecutively minted ids: **one** distinct value for the leading
 * two characters, twelve for the trailing two. Every attachment for years would have landed in
 * one SharePoint folder, and `yyyy/mm` would at least have given twelve buckets a year.
 *
 * Hashing rather than slicing the tail, because the tail is only random by an accident of
 * cuid v1's layout. A hash decorrelates the shard from whatever structure the id scheme
 * happens to carry, so this does not silently collapse again if that scheme ever changes.
 */
export function driveKeyFor(attachmentId: string, mimeType: string): string {
  return `${shardFor(attachmentId)}/${attachmentId}${extensionFor(mimeType)}`;
}

/**
 * FNV-1a, 32-bit, folded to 256 buckets and rendered as two hex characters.
 *
 * Not a security hash and not required to be one — nothing here resists an adversary, and the
 * id is not a secret. Its only job is to destroy any correlation between neighbouring ids, so
 * the bucket cannot track a timestamp. 256 buckets keeps a folder well under SharePoint's
 * 5,000-item view threshold at any volume this platform will see.
 *
 * `Math.imul` because the FNV prime multiply overflows 32 bits, and plain `*` on a JS number
 * silently loses the low bits it is supposed to keep. `>>> 0` converts back to unsigned before
 * the modulo, since the XOR-and-multiply leaves a signed 32-bit value.
 */
function shardFor(attachmentId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < attachmentId.length; i += 1) {
    hash ^= attachmentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 256).toString(16).padStart(2, "0");
}

/**
 * `Content-Disposition`, safely.
 *
 * A filename is user input on its way into an HTTP header, which is header injection unless
 * something removes CR, LF and the quote that terminates a quoted-string. Both forms are
 * emitted when they differ: `filename=` for the ASCII fallback and RFC 5987 `filename*=` for
 * the real bytes, which is what every current browser prefers.
 */
export function contentDisposition(mimeType: string, filename: string): string {
  const kind = isInlineMime(mimeType) ? "inline" : "attachment";

  // Strip C0/C1 controls, quote and backslash. Everything removed here is either a header
  // terminator or a quoted-string terminator; nothing removed is meaningful in a name.
  const clean = filename.replace(/[\p{Cc}"\\]/gu, "");

  // An all-non-ASCII name reduces the fallback to nothing, and `filename=""` is not a name.
  const ascii = clean.replace(/[^\x20-\x7E]/g, "");
  const fallback = /[^.\s]/.test(ascii) ? ascii : `file${extensionFor(mimeType)}`;

  const header = `${kind}; filename="${fallback}"`;
  // Against `ascii`, NOT against `fallback`. When the name reduces to nothing usable,
  // `fallback` becomes the `file.ext` placeholder, which `clean` can never equal — so
  // comparing to it always fell through and appended a bare, empty `filename*=UTF-8''`.
  // The real question is "does this name carry non-ASCII bytes", and `clean === ascii`
  // asks exactly that. Caught by test 7 during Task 4.
  if (clean === ascii) return header;
  return `${header}; filename*=UTF-8''${encodeRFC5987(clean)}`;
}

/**
 * `encodeURIComponent` leaves `!'()*` unescaped, and RFC 5987's `attr-char` set excludes
 * them. Percent-encoding them by hand is the documented remedy.
 *
 * Two things deliberately NOT done here, established by attacking this function during
 * Task 4 rather than by reasoning about it:
 *
 * - **No length cap.** 255 non-ASCII characters produce a ~1.6KB header, which is well
 *   inside every common proxy limit. The bound lives where it belongs: `beginUploadInput`
 *   in `schema.ts` caps `filename` at 255, so an unbounded name never reaches here.
 * - **`/` is not stripped while `\` is.** That asymmetry is principled, not an oversight:
 *   `\` is the escape character inside a quoted-string, so leaving it in breaks the header's
 *   own syntax. `/` has no syntactic meaning in a header, and browsers sanitise path
 *   separators when writing a download to disk. Do not "fix" the asymmetry by stripping `/`
 *   — it would silently mangle legitimate names for no gain.
 */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- policy.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attachments/policy.ts src/lib/attachments/policy.test.ts
git commit -m "Add the attachment serving policy, with header-injection tests"
```

---

## Task 5: `schema.ts` — the upload request and its caps

**Files:**
- Create: `src/lib/attachments/schema.ts`
- Test: `src/lib/attachments/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/attachments/schema.test.ts`:

```ts
import { expect, test } from "vitest";
import { beginUploadInput, MAX_UPLOAD_BYTES, maxUploadBytes } from "./schema";

test("a well-formed request parses", () => {
  const parsed = beginUploadInput.parse({
    pageId: "ckpage1",
    filename: "shot.png",
    mimeType: "image/png",
    sizeBytes: 1024,
  });
  expect(parsed.filename).toBe("shot.png");
});

test("a mime off the allowlist is rejected here, before any session is minted", () => {
  expect(
    beginUploadInput.safeParse({
      pageId: "ckpage1", filename: "x.exe",
      mimeType: "application/x-msdownload", sizeBytes: 10,
    }).success,
  ).toBe(false);
});

test("a size over the cap, at zero, or fractional is rejected", () => {
  for (const sizeBytes of [MAX_UPLOAD_BYTES + 1, 0, -1, 1.5]) {
    expect(
      beginUploadInput.safeParse({
        pageId: "ckpage1", filename: "a.png", mimeType: "image/png", sizeBytes,
      }).success,
      String(sizeBytes),
    ).toBe(false);
  }
});

test("control characters are stripped from the filename", () => {
  const parsed = beginUploadInput.parse({
    pageId: "ckpage1", filename: "a\u0000b\r\n.png", mimeType: "image/png", sizeBytes: 1,
  });
  expect(parsed.filename).toBe("ab.png");
});

test("the default cap stays inside Attachment.sizeBytes, which is an Int", () => {
  // Postgres `integer` is 4 bytes. A cap at or above 2^31 admits a row that cannot be
  // written, and the failure would land after the upload succeeded.
  expect(MAX_UPLOAD_BYTES).toBeLessThan(2_147_483_647);
});

test("maxUploadBytes refuses a non-numeric or oversized override rather than guessing", () => {
  expect(maxUploadBytes({ MAX_UPLOAD_BYTES: "1048576" })).toBe(1_048_576);
  expect(() => maxUploadBytes({ MAX_UPLOAD_BYTES: "lots" })).toThrow(/MAX_UPLOAD_BYTES/);
  expect(() => maxUploadBytes({ MAX_UPLOAD_BYTES: "3000000000" })).toThrow(/Int/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachments/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Implement it**

Create `src/lib/attachments/schema.ts`:

```ts
import { z } from "zod";
import { isAllowedMime } from "@/lib/attachments/policy";

/**
 * The begin-upload request body. Pure, like `drafts/schema.ts`: the route owns only the HTTP
 * status codes.
 *
 * Note what this body is NOT: the file. It is four small fields describing a file the browser
 * will send straight to Graph. So unlike the draft endpoint, the `Content-Length` guard at the
 * route is bounding a few hundred bytes of JSON, not a document — the real size limit is
 * `sizeBytes` below, checked before any upload session exists.
 */

/**
 * Ceiling on `MAX_UPLOAD_BYTES`, and the reason the override is validated rather than read.
 * `Attachment.sizeBytes` is a Prisma `Int`, which is a 4-byte Postgres `integer`. A cap above
 * this admits an upload that completes and then cannot be recorded — the worst ordering, since
 * the bytes are already in the library by then.
 */
const INT_MAX = 2_147_483_647;

export function maxUploadBytes(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.MAX_UPLOAD_BYTES;
  if (raw === undefined || raw === "") return 536_870_912;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MAX_UPLOAD_BYTES must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  if (value >= INT_MAX) {
    throw new Error(
      `MAX_UPLOAD_BYTES (${value}) must stay below ${INT_MAX}: Attachment.sizeBytes is an Int`,
    );
  }
  return value;
}

export const MAX_UPLOAD_BYTES = maxUploadBytes();

/** A filename is one line in a download dialog. */
export const FILENAME_MAX_LENGTH = 255;

/**
 * Strips EVERY C0/C1 control character, `\r`/`\n`/`\t` included.
 *
 * This is deliberately not `stripControl` from `@/lib/text/control`: that function keeps
 * newline, tab and carriage return because they are the structure of a Markdown document.
 * A filename has no such structure — it is one line in a download dialog — and `\r`/`\n` in
 * a filename are exactly the classic header/log-injection vector, not content worth
 * preserving. Reusing `stripControl` here would leave them in place.
 */
function stripFilenameControl(value: string): string {
  return value.replace(/\p{Cc}/gu, "");
}

export const beginUploadInput = z.object({
  pageId: z.string().min(1).max(64),

  /**
   * Stripped of control characters on the way in, for the same reason drafts are: Postgres
   * rejects NUL outright, and a filename carrying one turns every read of the row into a
   * 500. `contentDisposition` strips again at the point of use — that is not redundancy, it
   * is the header-injection defence living next to the header.
   */
  filename: z.string().min(1).max(FILENAME_MAX_LENGTH).transform(stripFilenameControl),

  /**
   * Checked against the allowlist HERE rather than at the route, so a rejected type never
   * reaches the store and no upload session is minted for it.
   */
  mimeType: z.string().refine(isAllowedMime, { message: "unsupported file type" }),

  /**
   * DECLARED size. The commit endpoint reads the real size back from the store and refuses a
   * mismatch — this value only decides whether to offer a session at all.
   */
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

export type BeginUploadInput = z.infer<typeof beginUploadInput>;
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- attachments/schema.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/lib/attachments/schema.ts src/lib/attachments/schema.test.ts
git commit -m "Add the begin-upload schema, with the Int ceiling on the size cap"
```

---

## Task 6: `BlobStore` and the memory implementation

**Files:**
- Create: `src/lib/blob/store.ts`
- Create: `src/lib/blob/memory.ts`
- Test: `src/lib/blob/memory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/blob/memory.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { MemoryBlobStore } from "./memory";

let store: MemoryBlobStore;
beforeEach(() => {
  store = new MemoryBlobStore("http://localhost:3000");
});

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

test("a session's uploadUrl points at the dev upload route for that key", async () => {
  const session = await store.beginUpload("ab/abc.png", 5, "image/png");
  expect(session.uploadUrl).toBe("http://localhost:3000/api/attachments/_dev-upload/ab/abc.png");
  expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

test("stat is null before the bytes arrive, and reports size after", async () => {
  await store.beginUpload("ab/abc.png", 5, "image/png");
  expect(await store.stat("ab/abc.png")).toBeNull();

  await store.put("ab/abc.png", new TextEncoder().encode("hello"));
  expect(await store.stat("ab/abc.png")).toEqual({ sizeBytes: 5, eTag: '"1"' });
});

test("fetch returns the whole body when no range is asked for", async () => {
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k");
  expect(body).not.toBeNull();
  expect(body!.totalBytes).toBe(5);
  expect(body!.sizeBytes).toBe(5);
  expect(await read(body!.stream)).toBe("hello");
});

test("fetch honours an inclusive range, as HTTP defines it", async () => {
  // bytes=1-3 of "hello" is "ell" — three bytes, END INCLUSIVE. Getting this wrong by one
  // makes video seek subtly corrupt rather than broken, which is worse.
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k", { start: 1, end: 3 });
  expect(await read(body!.stream)).toBe("ell");
  expect(body!.sizeBytes).toBe(3);
  expect(body!.totalBytes).toBe(5);
});

test("a range beyond the end clamps rather than throwing", async () => {
  await store.put("k", new TextEncoder().encode("hello"));
  const body = await store.fetch("k", { start: 3, end: 99 });
  expect(await read(body!.stream)).toBe("lo");
});

test("fetch and stat are null for a key that was never written", async () => {
  expect(await store.fetch("nope")).toBeNull();
  expect(await store.stat("nope")).toBeNull();
});

test("delete removes the bytes and is idempotent", async () => {
  await store.put("k", new TextEncoder().encode("x"));
  await store.delete("k");
  await store.delete("k");
  expect(await store.stat("k")).toBeNull();
});

test("reset empties the store, because select.ts caches one instance per process", async () => {
  // `resetDb` truncates Postgres but knows nothing about this Map, so without reset() bytes
  // from one test are visible to the next — and a sweep test asserting "no orphans" would
  // pass or fail depending on file ordering.
  await store.put("k", new Uint8Array(1));
  store.reset();
  expect(await store.stat("k")).toBeNull();
});

test("list enumerates keys under a prefix, for the sweep's reverse-orphan pass", async () => {
  await store.put("ab/one.png", new Uint8Array(1));
  await store.put("ab/two.png", new Uint8Array(1));
  await store.put("cd/three.png", new Uint8Array(1));

  const keys: string[] = [];
  for await (const item of store.list("ab/")) keys.push(item.key);
  expect(keys.sort()).toEqual(["ab/one.png", "ab/two.png"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- blob/memory.test.ts`
Expected: FAIL — cannot resolve `./memory`.

- [ ] **Step 3: Write the interface**

Create `src/lib/blob/store.ts`:

```ts
/**
 * What the application needs from an object store, and nothing more.
 *
 * The seam exists for a reason that is not speculative generality: a real SharePoint tenant is
 * not reproducible in CI or on a laptop, and `npm run smoke` must run from nothing. An
 * in-memory implementation is therefore mandatory, and this is the interface those tests
 * already need. It survived a total change of backend — S3 to SharePoint — which is reasonable
 * evidence it is drawn in the right place.
 *
 * Note what is absent: any method that takes file BYTES on the way in. Uploads bypass the
 * application entirely; `beginUpload` returns a URL the browser writes to directly.
 */

/** A write capability for ONE key, for a short time. It confers no read and no other write. */
export type UploadSession = { uploadUrl: string; expiresAt: Date };

export type BlobStat = { sizeBytes: number; eTag: string | null };

/** Byte offsets, both INCLUSIVE — as HTTP `Range` defines them, not as `slice` does. */
export type BlobRange = { start: number; end: number };

export type BlobBody = {
  stream: ReadableStream<Uint8Array>;
  /** Bytes in THIS response: the range length, or the whole object. */
  sizeBytes: number;
  /** Bytes in the whole object, which `Content-Range` needs even for a partial response. */
  totalBytes: number;
  eTag: string | null;
};

export interface BlobStore {
  beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession>;
  stat(key: string): Promise<BlobStat | null>;
  /** Null when the key does not exist. A range beyond the end CLAMPS; it does not throw. */
  fetch(key: string, range?: BlobRange): Promise<BlobBody | null>;
  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;
  /** For the sweep's reverse-orphan pass — drive items with no row. */
  list(prefix: string): AsyncIterable<{ key: string }>;
}
```

- [ ] **Step 4: Write the memory implementation**

Create `src/lib/blob/memory.ts`:

```ts
import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

/**
 * In-memory store for tests, local development and `npm run smoke`.
 *
 * `beginUpload` returns a URL pointing at `/api/attachments/_dev-upload/<key>`, because the
 * direct-upload path is only exercisable if the browser has somewhere real to PUT. That route
 * is registered ONLY when `BLOB_STORE=memory`, under the same discipline as the passwordless
 * test login — see `src/lib/blob/select.ts`.
 *
 * State is per-instance and per-process, which is exactly why `select.ts` refuses this
 * implementation in production: two replicas would disagree, and a restart loses everything.
 */
export class MemoryBlobStore implements BlobStore {
  #objects = new Map<string, Uint8Array>();
  #version = 0;

  constructor(private readonly origin: string) {}

  /**
   * `sizeBytes` and `mimeType` are declared and ignored, and the declaration is not optional:
   * TypeScript checks call arity against a CLASS's own signature, not against the interface it
   * implements, and the tests call this on the concrete type. Narrowing it to `(key)` compiles
   * the class fine and then fails every call site with TS2554.
   */
  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    return {
      uploadUrl: `${this.origin}/api/attachments/_dev-upload/${key}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    };
  }

  /** Not on `BlobStore`: the dev upload route calls it, and nothing else may. */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#objects.set(key, bytes);
    this.#version += 1;
  }

  async stat(key: string): Promise<BlobStat | null> {
    const bytes = this.#objects.get(key);
    if (!bytes) return null;
    return { sizeBytes: bytes.byteLength, eTag: `"${this.#version}"` };
  }

  async fetch(key: string, range?: BlobRange): Promise<BlobBody | null> {
    const bytes = this.#objects.get(key);
    if (!bytes) return null;

    // `end` is INCLUSIVE and `subarray` is exclusive, hence the +1. Clamped rather than
    // rejected: a player asking for more than exists should get what exists.
    const slice = range
      ? bytes.subarray(range.start, Math.min(range.end + 1, bytes.byteLength))
      : bytes;

    return {
      // COPIED into a fresh array rather than passed straight in. `subarray` yields a
      // `Uint8Array<ArrayBufferLike>`, and `BodyInit` in this lib.dom requires the narrower
      // `Uint8Array<ArrayBuffer>`, so `new Response(slice)` is a TS2345. The copy is
      // acceptable precisely because this is the fake — the Graph store streams instead, and
      // a copy there would defeat the point of never buffering a video.
      stream: new Response(new Uint8Array(slice)).body!,
      sizeBytes: slice.byteLength,
      totalBytes: bytes.byteLength,
      eTag: `"${this.#version}"`,
    };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  /**
   * Not on `BlobStore`. Test isolation only: `select.ts` caches one store per process, so
   * this Map outlives `resetDb` and would carry bytes from one test into the next.
   */
  reset(): void {
    this.#objects.clear();
  }

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    for (const key of this.#objects.keys()) {
      if (key.startsWith(prefix)) yield { key };
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- blob/memory.test.ts`
Expected: PASS, all nine.

- [ ] **Step 6: Commit**

```bash
git add src/lib/blob/store.ts src/lib/blob/memory.ts src/lib/blob/memory.test.ts
git commit -m "Add the BlobStore interface and its in-memory implementation"
```

---

## Task 7: `select.ts`, and the dev upload route it gates

**Files:**
- Create: `src/lib/blob/select.ts`
- Create: `src/app/api/attachments/_dev-upload/[...key]/route.ts`
- Test: `src/lib/blob/select.test.ts`
- Test: `tests/integration/dev-upload-route.test.ts`

- [ ] **Step 1: Write the failing selection tests**

Create `src/lib/blob/select.test.ts`:

```ts
import { expect, test } from "vitest";
import { devUploadEnabled, memoryStoreEnabled, resolveStoreKind } from "./select";

test("an unset BLOB_STORE refuses to boot rather than guessing", () => {
  // Neither default is safe. "memory" lets a deployment accept uploads and lose them on
  // restart; "graph" breaks every laptop and the smoke test. "Nobody can upload" is a loud
  // failure, which is the same direction ALLOWED_EMAIL_DOMAINS chose.
  expect(() => resolveStoreKind({})).toThrow(/BLOB_STORE/);
  expect(() => resolveStoreKind({ BLOB_STORE: "" })).toThrow(/BLOB_STORE/);
});

test("an unrecognised value is refused, not treated as one of the two", () => {
  expect(() => resolveStoreKind({ BLOB_STORE: "s3" })).toThrow(/BLOB_STORE/);
  expect(() => resolveStoreKind({ BLOB_STORE: "Memory" })).toThrow(/BLOB_STORE/);
});

test("both valid values resolve outside production", () => {
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "development" })).toBe("memory");
  expect(resolveStoreKind({ BLOB_STORE: "graph", NODE_ENV: "production" })).toBe("graph");
});

test("memory is refused under any NODE_ENV that is not a known dev one", () => {
  // An ALLOWLIST, not `!== "production"`. Next only DEFAULTS NODE_ENV, so an explicitly set
  // value survives — `NODE_ENV=staging next start` warns and proceeds. Under the inverted
  // guard that combination silently accepted `memory` in a genuinely deployed process.
  //
  // The cast is the point, not a workaround: `@types/node` declares NODE_ENV as
  // `"development" | "production" | "test"`, and the runtime accepts any string at all. The
  // gap between the type and reality is precisely where the bug lived, so the test has to
  // reach past the type to reproduce it.
  for (const NODE_ENV of ["staging", "prod", "Production", "", "qa"]) {
    const env = { BLOB_STORE: "memory", NODE_ENV } as Partial<NodeJS.ProcessEnv>;
    expect(() => resolveStoreKind(env), NODE_ENV).toThrow(/BLOB_STORE="memory"/);
  }
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "development" })).toBe("memory");
  expect(resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "test" })).toBe("memory");
});

test("devUploadEnabled needs BOTH an exact 1 and the memory store", () => {
  // The route this gates is the only unauthenticated write in the application. Gating it on
  // the memory store alone made it ON by default wherever NODE_ENV was not exactly
  // "production" — the inverse of ALLOW_TEST_LOGIN's discipline. Neither flag alone opens it.
  const dev = { NODE_ENV: "development" } as const;
  expect(devUploadEnabled({ ...dev, BLOB_STORE: "memory", ALLOW_DEV_UPLOAD: "1" })).toBe(true);

  expect(devUploadEnabled({ ...dev, BLOB_STORE: "memory" })).toBe(false);
  expect(devUploadEnabled({ ...dev, BLOB_STORE: "graph", ALLOW_DEV_UPLOAD: "1" })).toBe(false);
  expect(devUploadEnabled({ ALLOW_DEV_UPLOAD: "1" })).toBe(false);
});

test("devUploadEnabled is an exact 1, like ALLOW_TEST_LOGIN, and never throws", () => {
  const base = { NODE_ENV: "development", BLOB_STORE: "memory" } as const;
  for (const value of ["true", "yes", "on", "0", "", " 1", "1 "]) {
    expect(devUploadEnabled({ ...base, ALLOW_DEV_UPLOAD: value }), value).toBe(false);
  }
  // Called on every request to the route, including where BLOB_STORE is missing entirely.
  expect(() => devUploadEnabled({})).not.toThrow();
  expect(() => devUploadEnabled({ BLOB_STORE: "nonsense", ALLOW_DEV_UPLOAD: "1" })).not.toThrow();
});

test("memory is refused in production unless explicitly overridden", () => {
  expect(() => resolveStoreKind({ BLOB_STORE: "memory", NODE_ENV: "production" })).toThrow(
    /production/,
  );
  expect(
    resolveStoreKind({
      BLOB_STORE: "memory",
      NODE_ENV: "production",
      BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION: "1",
    }),
  ).toBe("memory");
});

test("the override is an exact 1, like ALLOW_TEST_LOGIN", () => {
  for (const value of ["true", "yes", "0", " 1", ""]) {
    expect(
      () =>
        resolveStoreKind({
          BLOB_STORE: "memory",
          NODE_ENV: "production",
          BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION: value,
        }),
      value,
    ).toThrow(/production/);
  }
});

test("memoryStoreEnabled is false for graph and never throws", () => {
  // The dev upload route asks this on every request, including in a deployment where
  // BLOB_STORE is unset by mistake. It must answer "no", not crash the route.
  expect(memoryStoreEnabled({ BLOB_STORE: "graph" })).toBe(false);
  expect(memoryStoreEnabled({})).toBe(false);
  expect(memoryStoreEnabled({ BLOB_STORE: "memory", NODE_ENV: "test" })).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- blob/select.test.ts`
Expected: FAIL — cannot resolve `./select`.

- [ ] **Step 3: Implement selection**

Create `src/lib/blob/select.ts`:

```ts
import { MemoryBlobStore } from "./memory";
import { GraphBlobStore } from "./graph";
import type { BlobStore } from "./store";

export type StoreKind = "graph" | "memory";

/**
 * Which store to use, or an error.
 *
 * There is deliberately NO DEFAULT. Both candidates are unsafe as a default in opposite
 * directions: `memory` would let a deployment accept uploads and silently lose them on the
 * next restart, and `graph` would break every laptop and `npm run smoke`, neither of which
 * has tenant credentials. Refusing to boot is the loud failure — the direction
 * `ALLOWED_EMAIL_DOMAINS` already chose when it denies everyone on empty.
 */
export function resolveStoreKind(env: Partial<NodeJS.ProcessEnv> = process.env): StoreKind {
  const raw = env.BLOB_STORE;
  if (raw !== "graph" && raw !== "memory") {
    throw new Error(
      `BLOB_STORE must be "graph" or "memory", got ${JSON.stringify(raw ?? null)}. ` +
        "There is no default: see src/lib/blob/select.ts.",
    );
  }
  // An ALLOWLIST of known development environments, NOT `!== "production"`.
  //
  // The inverted form was wrong and was caught by review. Next only DEFAULTS `NODE_ENV`
  // (`process.env.NODE_ENV = process.env.NODE_ENV || defaultEnv` in its bin), so an explicitly
  // set value survives — `NODE_ENV=staging npx next start` warns and proceeds. Under the old
  // guard that combination accepted `memory` silently, in a genuinely deployed process, while
  // `.env.example` ships `BLOB_STORE="memory"` for the setup-db.sh reason. Anything that is
  // not recognisably a development environment must ask explicitly.
  if (
    raw === "memory" &&
    !DEV_ENVS.has(env.NODE_ENV ?? "") &&
    env.BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION !== "1"
  ) {
    throw new Error(
      `BLOB_STORE="memory" under NODE_ENV=${JSON.stringify(env.NODE_ENV ?? null)} loses every ` +
        "upload on restart and cannot be shared between replicas. Set " +
        "BLOB_STORE_ALLOW_MEMORY_IN_PRODUCTION=1 only if you mean it.",
    );
  }
  return raw;
}

/** Where an in-memory store needs no explanation. Everything else must opt in. */
const DEV_ENVS = new Set(["development", "test"]);

/**
 * Whether the unauthenticated dev upload route may exist.
 *
 * **This is a SECOND, positive flag, and it is deliberately not `memoryStoreEnabled()`.**
 * Selecting the memory store answers "where do bytes go"; this answers "does an
 * unauthenticated write endpoint exist", and those are different questions that were
 * originally conflated.
 *
 * The polarity is what matters, and getting it backwards is what review caught. Gating the
 * route on the memory store alone made it **on by default** in every process where `NODE_ENV`
 * was not the literal string `production` — the exact inverse of `testLoginEnabled`, which is
 * off everywhere until someone writes an exact `"1"`. This now matches that discipline: off
 * unless asked for, an exact `"1"`, and additionally requiring the memory store, so the flag
 * alone cannot open a route in a process whose bytes go to SharePoint.
 */
export function devUploadEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.ALLOW_DEV_UPLOAD === "1" && memoryStoreEnabled(env);
}

/**
 * Whether the memory store — and therefore the dev upload route — is live.
 *
 * Gated on an exact `"1"`-style match through `resolveStoreKind`, but unlike it this NEVER
 * throws: the dev upload route calls it on every request, including in a deployment where
 * `BLOB_STORE` is missing, and there the answer must be "no" rather than a 500 that reads
 * like the route exists.
 */
export function memoryStoreEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  try {
    return resolveStoreKind(env) === "memory";
  } catch {
    return false;
  }
}

let cached: BlobStore | undefined;

export function blobStore(): BlobStore {
  if (cached) return cached;
  cached =
    resolveStoreKind() === "memory"
      ? new MemoryBlobStore(process.env.AUTH_URL ?? "http://localhost:3000")
      : new GraphBlobStore();
  return cached;
}

/** The memory instance, for the dev upload route. Throws if the memory store is not selected. */
export function memoryStore(): MemoryBlobStore {
  const store = blobStore();
  if (!(store instanceof MemoryBlobStore)) throw new Error("memory store is not selected");
  return store;
}
```

- [ ] **Step 4: Write the failing route test**

Create `tests/integration/dev-upload-route.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import type { MemoryBlobStore } from "@/lib/blob/memory";

/**
 * The dev upload route is the price of the upload/download asymmetry: the browser must PUT
 * somewhere real for the memory store to exercise the direct-upload path at all. That makes it
 * the one write endpoint in the application with no authentication.
 *
 * It is gated on `devUploadEnabled()` — an explicit `ALLOW_DEV_UPLOAD=1` **and** the memory
 * store. Review caught the earlier version gating on the memory store alone, which made the
 * route ON by default in every process where `NODE_ENV` was not the literal string
 * `production`; Next only DEFAULTS that variable, so `NODE_ENV=staging next start` proceeded
 * with an open write endpoint. These tests pin the gate, not the intent.
 *
 * `vi.resetModules()` is needed so `vi.doMock` takes effect on a fresh import — NOT because
 * the route reads the flag at import time. It does not: `devUploadEnabled()` is called per
 * request, which is the stronger property. An earlier version of this comment claimed
 * otherwise, and a comment that describes a security mechanism as weaker than it is invites
 * someone to "fix" the code to match.
 */
async function put(
  key: string | string[],
  body: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const { PUT } = await import("@/app/api/attachments/_dev-upload/[...key]/route");
  const request = new Request("http://localhost/x", { method: "PUT", body, headers });
  const response = await PUT(request, {
    params: Promise.resolve({ key: Array.isArray(key) ? key : key.split("/") }),
  });
  return response.status;
}

function mockGate(enabled: boolean, store?: MemoryBlobStore) {
  vi.doMock("@/lib/blob/select", () => ({
    devUploadEnabled: () => enabled,
    memoryStore: () => store,
  }));
}

async function freshStore(): Promise<MemoryBlobStore> {
  const { MemoryBlobStore } = await import("@/lib/blob/memory");
  return new MemoryBlobStore("http://localhost");
}

test("the route 404s when the dev upload flag is off", async () => {
  vi.resetModules();
  mockGate(false);

  expect(await put("ab/abc.png", "hello")).toBe(404);
  vi.doUnmock("@/lib/blob/select");
});

test("every other method 404s too, so OPTIONS cannot confirm the route is in the build", async () => {
  // Without explicit stubs Next auto-implements the unhandled verbs — 405 for most and a 204
  // carrying `Allow: OPTIONS, PUT` for OPTIONS — either of which distinguishes a gated route
  // from an unregistered path without ever consulting the gate.
  vi.resetModules();
  mockGate(false);

  const mod = await import("@/app/api/attachments/_dev-upload/[...key]/route");
  for (const method of ["GET", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
    const response = await mod[method]();
    expect(response.status, method).toBe(404);
  }
  vi.doUnmock("@/lib/blob/select");
});

test("the route accepts a PUT and the bytes are then readable", async () => {
  vi.resetModules();
  const store = await freshStore();
  mockGate(true, store);

  expect(await put("ab/abc.png", "hello", { "content-length": "5" })).toBe(201);
  expect(await store.stat("ab/abc.png")).toMatchObject({ sizeBytes: 5 });
  vi.doUnmock("@/lib/blob/select");
});

test("a key is validated by SHAPE, so an encoded traversal cannot slip through", async () => {
  // The per-segment blacklist this replaced was bypassable and its test did not notice. Next
  // decodes catch-all segments AFTER splitting on `/`, so `..%2f..%2fetc%2fpasswd` arrives as
  // ONE array element containing real slashes and no element ever equals "..". The last two
  // cases below are exactly what that produced; they are the reason this is an allowlist.
  vi.resetModules();
  const store = await freshStore();
  mockGate(true, store);

  const rejected: (string | string[])[] = [
    "../etc/passwd",
    ["..", "etc", "passwd"],
    ["../../etc/passwd"],
    ["..\\..\\x"],
    ["x y"],
    ["..."],
    ["ab", "abc.png", "extra"],
    ["AB", "abc.png"],
    ["ab", "abc"],
  ];
  for (const key of rejected) {
    expect(await put(key, "x", { "content-length": "1" }), JSON.stringify(key)).toBe(400);
  }
  // Nothing above reached the store.
  for await (const _ of store.list("")) throw new Error("a rejected key was stored");

  vi.doUnmock("@/lib/blob/select");
});

test("a missing Content-Length is 411 and an oversized one is 413, before the body is read", async () => {
  // The same guard order the drafts route uses, and for the same reason: `Number(null)` is 0,
  // so a numeric-only cap waves a chunked body through. Without this the fake was strictly
  // MORE permissive than the real store, buffering an unbounded body into a Map that only
  // `reset()` clears.
  vi.resetModules();
  const store = await freshStore();
  mockGate(true, store);

  const { MAX_UPLOAD_BYTES } = await import("@/lib/attachments/schema");
  const { PUT } = await import("@/app/api/attachments/_dev-upload/[...key]/route");

  const bare = new Request("http://localhost/x", { method: "PUT", body: "x" });
  bare.headers.delete("content-length");
  expect(
    (await PUT(bare, { params: Promise.resolve({ key: ["ab", "abc.png"] }) })).status,
  ).toBe(411);

  expect(
    await put("ab/abc.png", "x", { "content-length": String(MAX_UPLOAD_BYTES + 1) }),
  ).toBe(413);

  vi.doUnmock("@/lib/blob/select");
});
```

- [ ] **Step 5: Implement the route**

Create `src/app/api/attachments/_dev-upload/[...key]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { memoryStore, devUploadEnabled } from "@/lib/blob/select";
import { MAX_UPLOAD_BYTES } from "@/lib/attachments/schema";

/**
 * Where the memory store's upload sessions point, and the only unauthenticated write in the
 * application. Treated with the same suspicion as the passwordless test login.
 *
 * It exists because uploads bypass the application: the browser PUTs bytes to whatever URL the
 * store hands it, so for `BLOB_STORE=memory` that URL must be something a test, a Playwright
 * browser and `scripts/smoke.sh` can actually PUT to. Without it the direct-upload path is not
 * exercisable at all and the "runs with no tenant credentials" goal is unreachable.
 *
 * **`devUploadEnabled()`, not `memoryStoreEnabled()`, and the difference is the whole safety
 * argument.** Gating on the memory store alone made this route ON by default in every process
 * where `NODE_ENV` was not the literal string `production` — and Next only DEFAULTS that
 * variable, so `NODE_ENV=staging npx next start` warns and proceeds. That is the inverse of
 * `ALLOW_TEST_LOGIN`, which is off everywhere until someone writes an exact `"1"`. Now this
 * matches: it requires an explicit `ALLOW_DEV_UPLOAD=1` **and** the memory store, so neither
 * flag alone opens a write endpoint.
 *
 * **What the gate does and does not hide.** Every request that could write is a 404. The
 * route's *presence* in a build is still detectable — an earlier version of this comment
 * claimed the 404 was "byte-identical to a route that was never registered", and that was
 * false: Next auto-implements `OPTIONS` from the userland exports, so an unregistered path and
 * a gated one answer differently. The stubs below close that by handling every method through
 * the same gate. Fingerprinting confers nothing either way, but a false claim in a security
 * comment is worse than no claim.
 */

/** `{2 hex}/{id}{ext}` — the shape `driveKeyFor` produces, and the only shape accepted. */
const DRIVE_KEY = /^[0-9a-f]{2}\/[a-z0-9]+\.[a-z0-9]+$/;

function notFound() {
  return NextResponse.json({ error: "not-found" }, { status: 404 });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!devUploadEnabled()) return notFound();

  const { key } = await params;
  const joined = key.join("/");

  // Validated against the shape a key is SUPPOSED to have, not by blacklisting `..` segments.
  // The per-segment blacklist was bypassable and its test did not notice: Next decodes
  // catch-all segments AFTER splitting on `/`, so `..%2f..%2fetc%2fpasswd` arrives as ONE
  // element containing real slashes, and a per-segment check never sees a `..` segment.
  // Harmless against the memory store's Map, but `GraphBlobStore` builds
  // `/drives/{id}/root:/{key}:`, where a traversal would walk the drive. An allowlist of the
  // one legal shape cannot be bypassed by an encoding that produces a different one.
  if (!DRIVE_KEY.test(joined)) {
    return NextResponse.json({ error: "invalid-key" }, { status: 400 });
  }

  // The same guard order the drafts route uses, for the same reason: a missing header is its
  // own rejection because `Number(null)` is 0, so a numeric-only cap waves a chunked body
  // straight through. Without this the fake was strictly MORE permissive than Graph — it
  // buffered an unbounded body into a Map that only `reset()` clears, so a large PUT
  // exhausted the heap of the very dev server the tests depend on.
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declared);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That upload is too large." },
      { status: 413 },
    );
  }

  await memoryStore().put(joined, new Uint8Array(await request.arrayBuffer()));
  return new NextResponse(null, { status: 201 });
}

/**
 * Every other method, through the same gate.
 *
 * Not dead code: without these, Next auto-implements them — unhandled verbs as 405 and
 * `OPTIONS` as a 204 carrying `Allow: OPTIONS, PUT`, both of which confirm the route module is
 * compiled into the build without ever consulting the gate. Routing them here makes the 404
 * uniform.
 */
export const GET = notFound;
export const POST = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
```

- [ ] **Step 6: Run both suites**

Run: `npm test -- blob/select.test.ts dev-upload-route.test.ts`
Expected: PASS. Note `select.ts` imports `graph.ts`, which does not exist yet — write Task 8
first if the import fails, or stub the class and let Task 8 replace it. Prefer writing Task 8
first; the ordering here is presentation, not dependency.

- [ ] **Step 7: Commit**

```bash
git add src/lib/blob/select.ts src/lib/blob/select.test.ts \
  src/app/api/attachments/_dev-upload src/lib/blob/memory.ts \
  tests/integration/dev-upload-route.test.ts
git commit -m "Select the blob store explicitly, and gate the dev upload route on it"
```

---

## Task 8: The Graph implementation and its token cache

**Files:**
- Create: `src/lib/blob/token.ts`
- Create: `src/lib/blob/graph.ts`
- Test: `src/lib/blob/token.test.ts`
- Test: `src/lib/blob/graph.test.ts`

- [ ] **Step 1: Write the failing token tests**

Create `src/lib/blob/token.test.ts`:

```ts
import { beforeEach, expect, test, vi } from "vitest";
import { GraphToken } from "./token";

const config = {
  tenantId: "t", clientId: "c", clientSecret: "s",
};

function tokenResponse(value: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: value, expires_in: expiresIn }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
});

test("the first call fetches and the second is cached", async () => {
  fetchMock.mockResolvedValue(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  expect(await token.value()).toBe("abc");
  expect(await token.value()).toBe("abc");
  // App-only tokens have no user in them, so ONE cached token serves every request in the
  // process. Refetching per request is a rate limit waiting to happen.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a token near expiry is refetched early", async () => {
  // 60s of skew, so a token is never used in the window where it might already be rejected.
  fetchMock.mockResolvedValueOnce(tokenResponse("first", 30));
  fetchMock.mockResolvedValueOnce(tokenResponse("second", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  expect(await token.value()).toBe("first");
  expect(await token.value()).toBe("second");
});

test("concurrent callers share one in-flight request", async () => {
  // Without this, a page with twelve images cold-starts twelve identical token requests.
  fetchMock.mockResolvedValue(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  await Promise.all([token.value(), token.value(), token.value()]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a failed token request does not poison the cache", async () => {
  fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
  fetchMock.mockResolvedValueOnce(tokenResponse("abc", 3600));
  const token = new GraphToken(config, fetchMock as unknown as typeof fetch);

  await expect(token.value()).rejects.toThrow(/token/i);
  // A rejected promise left in the cache would make every later call fail forever — the
  // failure mode where one blip takes the feature down until a restart.
  expect(await token.value()).toBe("abc");
});

test("the secret is never in the error message", async () => {
  // The token endpoint can echo request parameters in a failure body, and this message
  // reaches logs. So the message carries the STATUS only, never the response body.
  const secret = "super-secret-value";
  fetchMock.mockResolvedValue(new Response(`bad client_secret=${secret}`, { status: 400 }));
  const token = new GraphToken({ ...config, clientSecret: secret }, fetchMock as unknown as typeof fetch);

  const error = await token.value().then(() => null, (e: Error) => e);
  expect(error).not.toBeNull();
  expect(error!.message).toContain("400");
  expect(error!.message).not.toContain(secret);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- blob/token.test.ts`
Expected: FAIL — cannot resolve `./token`.

- [ ] **Step 3: Implement the token cache**

Create `src/lib/blob/token.ts`:

```ts
export type GraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

/** Refetch this far before real expiry, so a token is never used inside the rejection window. */
const SKEW_MS = 60_000;

/**
 * An app-only Graph token, cached in memory.
 *
 * App-wide by nature: client-credentials tokens carry no user, so one token serves every
 * request in the process. That is the whole reason this design needs no `Account` table and no
 * refresh machinery — the alternative, delegated tokens, would need both.
 *
 * The in-flight promise is shared rather than the value alone, because a page holding twelve
 * images would otherwise cold-start twelve identical token requests against an endpoint that
 * rate-limits. A REJECTED promise is cleared rather than cached: leaving it in place turns one
 * transient 401 into a permanently broken feature until the process restarts.
 */
export class GraphToken {
  #inFlight: Promise<string> | null = null;
  #value: string | null = null;
  #expiresAt = 0;

  constructor(
    private readonly credentials: GraphCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async value(): Promise<string> {
    if (this.#value && Date.now() < this.#expiresAt - SKEW_MS) return this.#value;
    if (this.#inFlight) return this.#inFlight;

    this.#inFlight = this.#request().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #request(): Promise<string> {
    const { tenantId, clientId, clientSecret } = this.credentials;
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );

    // The status only. A body from the token endpoint can echo request parameters, and this
    // message reaches logs.
    if (!response.ok) {
      throw new Error(`Graph token request failed with ${response.status}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || !body.expires_in) {
      throw new Error("Graph token response carried no access_token");
    }

    this.#value = body.access_token;
    this.#expiresAt = Date.now() + body.expires_in * 1000;
    return this.#value;
  }
}
```

- [ ] **Step 4: Write the failing store tests**

Create `src/lib/blob/graph.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { GraphBlobStore } from "./graph";

function store(fetchImpl: typeof fetch) {
  return new GraphBlobStore(
    { tenantId: "t", clientId: "c", clientSecret: "s", driveId: "d" },
    { value: async () => "TOKEN" },
    fetchImpl,
  );
}

test("beginUpload asks for a session and returns its url and expiry", async () => {
  const calls: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as string, init));
    return new Response(
      JSON.stringify({ uploadUrl: "https://upload/1", expirationDateTime: "2026-08-26T10:00:00Z" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const session = await store(fetchImpl as unknown as typeof fetch).beginUpload(
    "ab/abc.png", 5, "image/png",
  );
  expect(session.uploadUrl).toBe("https://upload/1");
  expect(session.expiresAt.toISOString()).toBe("2026-08-26T10:00:00.000Z");
  expect(calls[0]!.url).toContain("/drives/d/root:/ab/abc.png:/createUploadSession");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer TOKEN");
});

test("stat returns null on 404 and size on 200", async () => {
  const missing = vi.fn(async () => new Response("", { status: 404 }));
  expect(await store(missing as unknown as typeof fetch).stat("k")).toBeNull();

  const found = vi.fn(
    async () =>
      new Response(JSON.stringify({ size: 42, eTag: '"abc"' }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
  );
  expect(await store(found as unknown as typeof fetch).stat("k")).toEqual({
    sizeBytes: 42, eTag: '"abc"',
  });
});

test("fetch forwards a Range and reads totalBytes from Content-Range", async () => {
  // A 206 carries Content-Length for the SLICE. The total is only in Content-Range, and the
  // proxy needs it to build its own Content-Range header. Reading Content-Length as the total
  // is the bug this test exists for.
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-3");
      return new Response("ell", {
        status: 206,
        headers: { "content-range": "bytes 1-3/5", "content-length": "3", etag: '"abc"' },
      });
    },
  );

  const body = await store(fetchImpl as unknown as typeof fetch).fetch("k", { start: 1, end: 3 });
  expect(body!.sizeBytes).toBe(3);
  expect(body!.totalBytes).toBe(5);
});

test("fetch returns null on 404 rather than throwing", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
  expect(await store(fetchImpl as unknown as typeof fetch).fetch("k")).toBeNull();
});

test("a 5xx from Graph throws, so the route can answer 502 rather than 404", async () => {
  // The distinction matters: 404 says "no such attachment" and 502 says "the store is down".
  // Collapsing them makes an outage look like deletion.
  const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
  await expect(store(fetchImpl as unknown as typeof fetch).fetch("k")).rejects.toThrow(/503/);
});

test("delete treats 404 as success", async () => {
  const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
  await expect(store(fetchImpl as unknown as typeof fetch).delete("k")).resolves.toBeUndefined();
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npm test -- blob/graph.test.ts`
Expected: FAIL — cannot resolve `./graph`.

- [ ] **Step 6: Implement the Graph store**

Create `src/lib/blob/graph.ts`:

```ts
import { GraphToken, type GraphCredentials } from "./token";
import type { BlobBody, BlobRange, BlobStat, BlobStore, UploadSession } from "./store";

const GRAPH = "https://graph.microsoft.com/v1.0";

export type GraphConfig = GraphCredentials & { driveId: string };

/** Just enough of `GraphToken` to substitute in tests. */
type TokenSource = { value(): Promise<string> };

function configFromEnv(): GraphConfig {
  const required = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_DRIVE_ID"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`BLOB_STORE="graph" needs ${missing.join(", ")}`);
  }
  return {
    tenantId: process.env.GRAPH_TENANT_ID!,
    clientId: process.env.GRAPH_CLIENT_ID!,
    clientSecret: process.env.GRAPH_CLIENT_SECRET!,
    driveId: process.env.GRAPH_DRIVE_ID!,
  };
}

/**
 * A SharePoint document library, reached as the application.
 *
 * The registration holds `Sites.Selected` plus a per-site grant, NOT `Files.ReadWrite.All` —
 * see `docs/ops/entra-id-and-sharepoint.md`. That is the difference between a leaked client
 * secret exposing one library and it exposing every drive in the tenant.
 *
 * Note the error discipline: a missing item is `null` and everything else THROWS. The read
 * route turns the first into 404 and the second into 502, and collapsing them would make a
 * Graph outage look like every attachment having been deleted.
 */
export class GraphBlobStore implements BlobStore {
  readonly #config: GraphConfig;
  readonly #token: TokenSource;
  readonly #fetch: typeof fetch;

  constructor(config?: GraphConfig, token?: TokenSource, fetchImpl: typeof fetch = fetch) {
    this.#config = config ?? configFromEnv();
    this.#token = token ?? new GraphToken(this.#config, fetchImpl);
    this.#fetch = fetchImpl;
  }

  /** `/drives/{id}/root:/{key}:` — the path-addressed form, so no item id is needed. */
  #item(key: string): string {
    return `${GRAPH}/drives/${this.#config.driveId}/root:/${key}:`;
  }

  async #headers(extra: HeadersInit = {}): Promise<Headers> {
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${await this.#token.value()}`);
    return headers;
  }

  async beginUpload(key: string, sizeBytes: number, mimeType: string): Promise<UploadSession> {
    const response = await this.#fetch(`${this.#item(key)}/createUploadSession`, {
      method: "POST",
      headers: await this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "fail",
          name: key.split("/").at(-1),
        },
        // Advisory only. The commit endpoint reads the real size back and refuses a mismatch,
        // because a client that declares one size can send another.
        deferCommit: false,
        fileSize: sizeBytes,
        mimeType,
      }),
    });
    if (!response.ok) {
      throw new Error(`createUploadSession failed with ${response.status}`);
    }
    const body = (await response.json()) as { uploadUrl: string; expirationDateTime: string };
    return { uploadUrl: body.uploadUrl, expiresAt: new Date(body.expirationDateTime) };
  }

  async stat(key: string): Promise<BlobStat | null> {
    const response = await this.#fetch(`${this.#item(key)}?$select=size,eTag`, {
      headers: await this.#headers(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`stat failed with ${response.status}`);
    const body = (await response.json()) as { size: number; eTag?: string };
    return { sizeBytes: body.size, eTag: body.eTag ?? null };
  }

  async fetch(key: string, range?: BlobRange): Promise<BlobBody | null> {
    const headers = await this.#headers();
    if (range) headers.set("range", `bytes=${range.start}-${range.end}`);

    const response = await this.#fetch(`${this.#item(key)}/content`, { headers, redirect: "follow" });
    if (response.status === 404) return null;
    if (!response.ok && response.status !== 206) {
      throw new Error(`content fetch failed with ${response.status}`);
    }

    const sizeBytes = Number(response.headers.get("content-length") ?? 0);
    return {
      stream: response.body!,
      sizeBytes,
      // A 206 reports the SLICE in Content-Length; the object's real length is only in
      // Content-Range. The proxy needs the total to build its own header.
      totalBytes: totalFromContentRange(response.headers.get("content-range")) ?? sizeBytes,
      eTag: response.headers.get("etag"),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#fetch(this.#item(key), {
      method: "DELETE",
      headers: await this.#headers(),
    });
    // Already gone is the desired state, so 404 is success. Delete must be idempotent: the
    // sweep re-runs, and a second pass must not fail on work the first one finished.
    if (!response.ok && response.status !== 404 && response.status !== 204) {
      throw new Error(`delete failed with ${response.status}`);
    }
  }

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    // `children` is one folder deep, which is all the layout has: keys are `{shard}/{id}{ext}`.
    let url: string | null =
      `${GRAPH}/drives/${this.#config.driveId}/root:/${prefix.replace(/\/$/, "")}:/children?$select=name`;
    while (url) {
      const response: Response = await this.#fetch(url, { headers: await this.#headers() });
      if (response.status === 404) return;
      if (!response.ok) throw new Error(`list failed with ${response.status}`);
      const body = (await response.json()) as {
        value: { name: string }[];
        "@odata.nextLink"?: string;
      };
      for (const child of body.value) yield { key: `${prefix.replace(/\/$/, "")}/${child.name}` };
      url = body["@odata.nextLink"] ?? null;
    }
  }
}

function totalFromContentRange(header: string | null): number | null {
  const match = header?.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}
```

- [ ] **Step 7: Run both suites**

Run: `npm test -- blob/`
Expected: PASS — token, graph and memory.

- [ ] **Step 8: Commit**

```bash
git add src/lib/blob/token.ts src/lib/blob/token.test.ts \
  src/lib/blob/graph.ts src/lib/blob/graph.test.ts
git commit -m "Add the Graph blob store and its app-only token cache"
```

---

## Task 9: `repo.ts`, and the permission rules

The security core of the phase. Every rule lives here; the routes render outcomes.

**Decide `needsAccessAudit` explicitly; do not let it default by omission.** Spec §8 holds that
a super admin reading a MEMBERS space they do not belong to is legitimate but must leave a
trace, and `src/lib/pages/repo.ts` audits exactly that on the equivalent page read.
`readableAttachment` as specified below selects no space fields, so it has no hook to make that
call — while the matrix in Step 2 asserts a super admin *can* read a draft-only attachment in a
MEMBERS space they are not a member of. That is the audited case, unaudited.

Either select `space.visibility` and call `needsAccessAudit`, or record in the docstring why an
attachment read is exempt where the page read is not. Silence is the one unacceptable answer.
Raised by the Task 3 review.

**Files:**
- Create: `src/lib/attachments/repo.ts`
- Test: `tests/integration/attachments-repo.test.ts`
- Modify: `src/lib/pages/visible.test.ts`

- [ ] **Step 1: Write the fixtures**

The readability matrix and the sweep both need the same five shapes, so they share a module
rather than each growing its own. This is a deliberate deviation from the house pattern of
local `fixture()` helpers per file — two files, ~120 lines each, is where duplication starts
costing more than the shared import.

Create `tests/integration/support/attachments.ts`:

```ts
import { db } from "../setup/reset";
import { memoryStore } from "@/lib/blob/select";
import { driveKeyFor } from "@/lib/attachments/policy";
import type { SpaceRole, Viewer } from "@/lib/authz/types";

/**
 * Shared fixtures for the attachment suites.
 *
 * `resetDb` truncates Postgres but knows nothing about the memory store's Map, and
 * `select.ts` caches one store per process — so every fixture here starts by emptying it.
 * Without that, bytes from one test are visible to the next and an orphan assertion passes
 * or fails on file ordering.
 */
export function resetStore(): void {
  memoryStore().reset();
}

export type Cast = {
  spaceId: string;
  pageId: string;
  editor: Viewer;
  viewer: Viewer;
  admin: Viewer;
  stranger: Viewer;
  superAdmin: Viewer;
  editorMembershipId: string;
};

async function person(email: string, isSuperAdmin = false) {
  return db.user.create({ data: { email, name: email, isSuperAdmin }, select: { id: true } });
}

async function join(spaceId: string, email: string, role: SpaceRole) {
  const user = await person(email);
  const membership = await db.spaceMembership.create({
    data: { spaceId, userId: user.id, role },
    select: { id: true },
  });
  const viewer: Viewer = { id: user.id, isSuperAdmin: false, memberships: [{ spaceId, role }] };
  return { viewer, membershipId: membership.id };
}

/** A space, a page, and one viewer per role — published or not, as asked. */
export async function cast(opts: {
  visibility: "MEMBERS" | "ALL_STAFF";
  published: boolean;
}): Promise<Cast> {
  resetStore();

  const space = await db.space.create({
    data: { key: "attach", name: "Attachments", initials: "AT", visibility: opts.visibility },
    select: { id: true },
  });
  const author = await person("author@example.com");
  const page = await db.page.create({
    data: {
      spaceId: space.id, slug: "doc", path: "doc", title: "Doc",
      createdById: author.id, status: "DRAFT",
    },
    select: { id: true },
  });

  if (opts.published) {
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id, title: "Doc", markdown: "# Doc",
        status: "CURRENT", authorId: author.id,
      },
      select: { id: true },
    });
    // `publishedVersionId` is what the read predicate's OR tests for. Setting it directly is
    // the point: this fixture is not exercising the publish path.
    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
  }

  const editor = await join(space.id, "editor@example.com", "EDITOR");
  const viewer = await join(space.id, "viewer@example.com", "VIEWER");
  const admin = await join(space.id, "admin@example.com", "ADMIN");
  const stranger = await person("stranger@example.com");
  const root = await person("root@example.com", true);

  return {
    spaceId: space.id,
    pageId: page.id,
    editor: editor.viewer,
    viewer: viewer.viewer,
    admin: admin.viewer,
    editorMembershipId: editor.membershipId,
    stranger: { id: stranger.id, isSuperAdmin: false, memberships: [] },
    superAdmin: { id: root.id, isSuperAdmin: true, memberships: [] },
  };
}

type AttachmentOpts = {
  state?: "PENDING" | "COMMITTED";
  mimeType?: string;
  sizeBytes?: number;
  createdAt?: Date;
  deletedAt?: Date | null;
  withBytes?: boolean;
};

/** An attachment row on `pageId`, and optionally its bytes in the memory store. */
export async function attach(pageId: string, uploaderId: string, opts: AttachmentOpts = {}) {
  const {
    state = "COMMITTED", mimeType = "image/png", sizeBytes = 5,
    createdAt, deletedAt = null, withBytes = true,
  } = opts;

  const row = await db.attachment.create({
    data: {
      pageId, drivePath: "", filename: "shot.png", mimeType, sizeBytes,
      uploadedById: uploaderId, state, deletedAt,
      ...(createdAt ? { createdAt } : {}),
    },
    select: { id: true },
  });
  const drivePath = driveKeyFor(row.id, mimeType);
  await db.attachment.update({ where: { id: row.id }, data: { drivePath }, select: { id: true } });

  if (withBytes) await memoryStore().put(drivePath, new Uint8Array(sizeBytes));
  return { id: row.id, drivePath };
}

export async function drivePathOf(id: string): Promise<string> {
  const row = await db.attachment.findUniqueOrThrow({
    where: { id }, select: { drivePath: true },
  });
  return row.drivePath;
}
```

- [ ] **Step 2: Write the failing readability matrix**

Create `tests/integration/attachments-repo.test.ts`. Every row of the matrix, plus the two
properties that would otherwise break silently:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { attach, cast } from "./support/attachments";
import { memoryStore } from "@/lib/blob/select";
import {
  beginUpload, commitUpload, readableAttachment, softDeleteAttachment,
} from "@/lib/attachments/repo";

beforeEach(resetDb);

test("a published page's attachment is readable by every role, and by a non-member of ALL_STAFF", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  for (const [label, viewer] of [
    ["editor", c.editor], ["viewer", c.viewer], ["admin", c.admin],
    ["stranger", c.stranger], ["super admin", c.superAdmin],
  ] as const) {
    expect((await readableAttachment(viewer, a.id))?.id, label).toBe(a.id);
  }
});

test("a MEMBERS space hides the attachment from a non-member", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await readableAttachment(c.stranger, a.id)).toBeNull();
});

test("a DRAFT-ONLY page's attachment is hidden from a VIEWER and visible to an EDITOR", async () => {
  // The reason the OR clause exists. Without it a VIEWER who guesses an id reads an image
  // referenced only in an unpublished draft — content the nav rail refuses to link and
  // `getPublishedPage` refuses to serve.
  const c = await cast({ visibility: "ALL_STAFF", published: false });
  const a = await attach(c.pageId, c.editor.id);
  expect(await readableAttachment(c.viewer, a.id)).toBeNull();
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("a super admin reads a draft-only attachment in a MEMBERS space they do not belong to", async () => {
  // The case `editableSpace`'s short-circuit exists for. A naive composition returns null.
  const c = await cast({ visibility: "MEMBERS", published: false });
  const a = await attach(c.pageId, c.editor.id);
  expect((await readableAttachment(c.superAdmin, a.id))?.id).toBe(a.id);
});

test("that same read leaves a space.access audit row, and a member's read leaves none", async () => {
  // Spec §8, paid the same way `getReadableSpaceByKey` pays it — see the repo module's
  // docstring for why this read is the one place that hook has to live: no upstream route
  // resolves this page's space through `getReadableSpaceByKey` before fetching an attachment
  // by id, so this is the only choke point that could ever record the access.
  const c = await cast({ visibility: "MEMBERS", published: false });
  const a = await attach(c.pageId, c.editor.id);

  await readableAttachment(c.superAdmin, a.id);
  const rows = await db.auditLog.findMany({ where: { action: "space.access" } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actorId: c.superAdmin.id, spaceId: c.spaceId });

  await readableAttachment(c.editor, a.id);
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(1);
});

test("a PENDING attachment is never readable, even by the uploader", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING" });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();
});

test("a soft-deleted attachment is not readable", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await softDeleteAttachment(c.editor, a.id)).toEqual({ ok: true });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();
});

test("SOFT-DELETING THE PAGE hides its attachments, and restoring it brings them back", async () => {
  // Emergent from nesting `visiblePage()` in the predicate rather than written anywhere. It
  // is tested precisely BECAUSE it is emergent: flatten the predicate and this breaks with
  // no other symptom.
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);

  await db.page.update({
    where: { id: c.pageId }, data: { deletedAt: new Date() }, select: { id: true },
  });
  expect(await readableAttachment(c.editor, a.id)).toBeNull();

  await db.page.update({
    where: { id: c.pageId }, data: { deletedAt: null }, select: { id: true },
  });
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("a VIEWER cannot soft-delete, and the refusal does not disturb the row", async () => {
  const c = await cast({ visibility: "ALL_STAFF", published: true });
  const a = await attach(c.pageId, c.editor.id);
  expect(await softDeleteAttachment(c.viewer, a.id)).toEqual({ ok: false, reason: "not-found" });
  // `updateMany` puts the predicate in the WRITE. A read-then-write would have deleted it.
  expect((await readableAttachment(c.viewer, a.id))?.id).toBe(a.id);
});

test("beginUpload answers not-found for an unreadable page and forbidden for a readable one", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const input = { pageId: c.pageId, filename: "a.png", mimeType: "image/png", sizeBytes: 1 };
  expect(await beginUpload(c.stranger, input)).toEqual({ ok: false, reason: "not-found" });
  expect(await beginUpload(c.viewer, input)).toEqual({ ok: false, reason: "forbidden" });
});

test("beginUpload stores a drivePath in the SAME transaction as the row", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const result = await beginUpload(c.editor, {
    pageId: c.pageId, filename: "a.png", mimeType: "image/png", sizeBytes: 1,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const row = await db.attachment.findUniqueOrThrow({
    where: { id: result.attachmentId }, select: { drivePath: true, state: true },
  });
  // A committed row with an empty drivePath is garbage the sweep would reclaim, and the
  // window is invisible without this assertion.
  expect(row.drivePath).toMatch(/^..\/.+\.png$/);
  expect(row.state).toBe("PENDING");
});

test("commitUpload promotes a matching upload to COMMITTED", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", sizeBytes: 5 });
  expect((await commitUpload(c.editor, a.id)).ok).toBe(true);
  expect((await readableAttachment(c.editor, a.id))?.id).toBe(a.id);
});

test("commitUpload refuses a size mismatch, deletes the item and retires the row", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, {
    state: "PENDING", sizeBytes: 5, withBytes: false,
  });
  await memoryStore().put(a.drivePath, new Uint8Array(99));

  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "size-mismatch" });
  const row = await db.attachment.findUniqueOrThrow({
    where: { id: a.id }, select: { deletedAt: true },
  });
  expect(row.deletedAt).not.toBeNull();
  expect(await memoryStore().stat(a.drivePath)).toBeNull();
});

test("commitUpload answers not-uploaded when the item is absent", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", withBytes: false });
  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "not-uploaded" });
});

test("commitUpload re-checks EDIT rather than trusting beginUpload's check", async () => {
  // A membership can be revoked while an upload session is still live.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", sizeBytes: 5 });
  await db.spaceMembership.delete({ where: { id: c.editorMembershipId } });

  expect(await commitUpload(c.editor, a.id)).toEqual({ ok: false, reason: "not-found" });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -- attachments-repo.test.ts`
Expected: FAIL — cannot resolve `@/lib/attachments/repo`.

- [ ] **Step 4: Implement the repository**

Create `src/lib/attachments/repo.ts`:

```ts
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { editableSpace, readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { auditSpaceAccess } from "@/lib/audit/log";
import { blobStore } from "@/lib/blob/select";
import { driveKeyFor } from "@/lib/attachments/policy";
import type { BeginUploadInput } from "@/lib/attachments/schema";
import type { Viewer } from "@/lib/authz/types";

/**
 * Every permission rule for attachments. The routes translate these outcomes into status
 * codes and decide nothing.
 *
 * Note that no `page` delegate call appears anywhere in this file: reading an attachment
 * reaches a `Page` row only through a RELATION FILTER. That is the shape `visible.test.ts`
 * was widened for the fourth time — invisible to both halves of its sweep — which is why this
 * module's registration there is not a formality. `readableAttachment` also reaches `Space`
 * only through the same relation, nested one level further, for the audit hook argued below.
 */

export type ReadableAttachment = {
  id: string;
  drivePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  eTag: string | null;
};

/**
 * The read predicate, stated once.
 *
 * The `OR` is the draft rule: an attachment is readable when its page is published, or when
 * the viewer could edit it. Without it, a VIEWER who guesses an id reads an image referenced
 * only in an unpublished draft.
 *
 * `readableSpace` and `editableSpace` sit in SEPARATE varargs of `visiblePage`, which makes a
 * key collision structurally impossible. Not because a duplicate key would be silent — that
 * is a TS1117 compile error — but because MERGING them into one `space` value is not:
 * `{ ...editableSpace(v), ...readableSpace(v) }` keeps only the last `AND` and drops the edit
 * requirement, measured returning a members-only page to a VIEWER.
 */
function readablePredicate(viewer: Viewer) {
  return visiblePage(
    { space: readableSpace(viewer) },
    { OR: [{ publishedVersionId: { not: null } }, { space: editableSpace(viewer) }] },
  );
}

/**
 * **The `needsAccessAudit` decision (Task 9).**
 *
 * Spec §8 says a super admin reading a `MEMBERS` space they do not belong to is legitimate but
 * must leave a trace, and `src/lib/pages/repo.ts` pays that debt inside `getReadableSpaceByKey`
 * — the one place *every* page read passes through first. `listSpacePages` and the other
 * readers in that module deliberately do NOT audit themselves; they rely on their caller having
 * resolved the space through `getReadableSpaceByKey` earlier in the same request, and the
 * module's docstring argues that precondition explicitly rather than leaving it assumed.
 *
 * That precondition does not hold here. An attachment is fetched by its own id, not by
 * `(spaceKey, path)`, and the route that will serve it (Task 12) has no reason to resolve the
 * page's space through `getReadableSpaceByKey` first — the common case is a bare `<img src>`
 * request that never touches page resolution at all, often in a different HTTP request than
 * the page that referenced it. `readableAttachment` is therefore not "one more reader behind an
 * already-audited resolve", it is the ONLY choke point a super-admin attachment read passes
 * through. Trusting call ordering here would be exactly the gap Task 3's review flagged:
 * the audited case, unaudited.
 *
 * So this selects `page.space.{id,key,visibility}` — nested through the same relation filter
 * that already reaches `Page`, adding no new delegate call — and calls `auditSpaceAccess` for
 * every successful read. `auditSpaceAccess` itself re-checks `needsAccessAudit` and is a no-op
 * for anyone but a super admin outside their own MEMBERS space, so an ordinary editor or viewer
 * read costs nothing beyond the already-fetched columns. See
 * "that same read leaves a space.access audit row" in attachments-repo.test.ts.
 *
 * `beginUpload`, `commitUpload` and `softDeleteAttachment` are EDIT-gated, and a super admin
 * bypasses that gate the same way. This task's instruction named only the READ path, and nothing
 * downstream of it in the routes planned so far turns an edit action into a bare content
 * disclosure the way a GET does — so those three are left as they are rather than folded into
 * this decision by extension. If a later task adds an edit-only surface reachable without ever
 * resolving the space, it will need the same argument made for it, not silently inherit this one.
 */
export async function readableAttachment(
  viewer: Viewer,
  id: string,
): Promise<ReadableAttachment | null> {
  const row = await db.attachment.findFirst({
    where: { id, deletedAt: null, state: "COMMITTED", page: readablePredicate(viewer) },
    select: {
      id: true, drivePath: true, filename: true,
      mimeType: true, sizeBytes: true, eTag: true,
      page: { select: { space: { select: { id: true, key: true, visibility: true } } } },
    },
  });
  if (!row) return null;

  await auditSpaceAccess(viewer, row.page.space);

  const { page: _page, ...attachment } = row;
  return attachment;
}

export type BeginUploadResult =
  | { ok: true; attachmentId: string; uploadUrl: string; expiresAt: Date }
  /** Page absent, soft-deleted, or in a space this viewer cannot read — one answer for all. */
  | { ok: false; reason: "not-found" }
  /** Readable but not editable. Distinct on purpose: they can already see the page. */
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "store-unavailable" };

export async function beginUpload(
  viewer: Viewer,
  input: BeginUploadInput,
): Promise<BeginUploadResult> {
  const page = await db.page.findFirst({
    where: visiblePage({ id: input.pageId, space: readableSpace(viewer) }),
    select: { id: true, space: { select: { id: true, visibility: true } } },
  });
  if (!page) return { ok: false, reason: "not-found" };
  if (!can(viewer, page.space, "EDIT")) return { ok: false, reason: "forbidden" };

  // The row first, because its id determines the key — and then the key, in the SAME
  // transaction, so no committed row ever carries an empty `drivePath`. Both `id` and
  // `createdAt` are database defaults, which is why the key cannot be computed for the
  // insert that produces them.
  const attachment = await db.$transaction(async (tx) => {
    const row = await tx.attachment.create({
      data: {
        pageId: page.id,
        drivePath: "",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        uploadedById: viewer.id,
      },
      select: { id: true },
    });
    return tx.attachment.update({
      where: { id: row.id },
      data: { drivePath: driveKeyFor(row.id, input.mimeType) },
      select: { id: true, drivePath: true },
    });
  });

  try {
    const session = await blobStore().beginUpload(
      attachment.drivePath, input.sizeBytes, input.mimeType,
    );
    return {
      ok: true,
      attachmentId: attachment.id,
      uploadUrl: session.uploadUrl,
      expiresAt: session.expiresAt,
    };
  } catch {
    // The row stays PENDING and the sweep reclaims it, which is the same cleanup path a
    // failed upload takes. Deliberately not deleted here: a store that just failed is not
    // the thing to ask for a compensating delete.
    return { ok: false, reason: "store-unavailable" };
  }
}

export type CommitResult =
  | { ok: true; attachment: ReadableAttachment }
  | { ok: false; reason: "not-found" | "not-uploaded" | "size-mismatch" | "store-unavailable" };

export async function commitUpload(viewer: Viewer, id: string): Promise<CommitResult> {
  // EDIT is re-checked rather than inherited from `beginUpload`: a membership can be revoked
  // while an upload session is still live.
  const row = await db.attachment.findFirst({
    where: {
      id,
      deletedAt: null,
      page: visiblePage({ space: readableSpace(viewer) }, { space: editableSpace(viewer) }),
    },
    select: { id: true, drivePath: true, mimeType: true, sizeBytes: true, filename: true },
  });
  if (!row) return { ok: false, reason: "not-found" };

  let stat;
  try {
    // Stat by the key THIS APPLICATION derived. The browser holds Graph's completion response
    // and could report any item id; accepting one would let it name an item it does not own.
    stat = await blobStore().stat(row.drivePath);
  } catch {
    return { ok: false, reason: "store-unavailable" };
  }
  if (!stat) return { ok: false, reason: "not-uploaded" };

  if (stat.sizeBytes !== row.sizeBytes) {
    // A client that declared one size sent another. Remove the bytes and retire the row —
    // the declared size is what the cap was checked against.
    await blobStore().delete(row.drivePath).catch(() => {});
    await db.attachment.update({
      where: { id: row.id }, data: { deletedAt: new Date() }, select: { id: true },
    });
    return { ok: false, reason: "size-mismatch" };
  }

  const committed = await db.attachment.update({
    where: { id: row.id },
    data: { state: "COMMITTED", eTag: stat.eTag, sizeBytes: stat.sizeBytes },
    select: {
      id: true, drivePath: true, filename: true,
      mimeType: true, sizeBytes: true, eTag: true,
    },
  });
  return { ok: true, attachment: committed };
}

export type SoftDeleteResult = { ok: true } | { ok: false; reason: "not-found" };

export async function softDeleteAttachment(
  viewer: Viewer,
  id: string,
): Promise<SoftDeleteResult> {
  const { count } = await db.attachment.updateMany({
    where: {
      id,
      deletedAt: null,
      page: visiblePage({ space: readableSpace(viewer) }, { space: editableSpace(viewer) }),
    },
    data: { deletedAt: new Date() },
  });
  // `updateMany` so the predicate is part of the WRITE, not a read the write then trusts.
  // Zero rows is "not yours or not there" — one answer, as everywhere else.
  return count === 1 ? { ok: true } : { ok: false, reason: "not-found" };
}
```

- [ ] **Step 5: Run the matrix**

Run: `npm test -- attachments-repo.test.ts`
Expected: PASS, all twelve.

- [ ] **Step 6: Watch the soft-delete guard fail, then register the module**

Run: `npm test -- visible.test.ts`
Expected: **FAIL** — `src/lib/attachments/repo.ts` queries the database and is not registered.
That failure is the guard working; do not skip observing it.

Add to the registry in `src/lib/pages/visible.test.ts`:

```ts
  {
    module: "src/lib/attachments/repo.ts",
    reachesPage: true,
    // Reaches `Page` ONLY through a relation filter — no `page` delegate token appears in
    // the module at all. Exactly the shape widening #4 was written for.
    softDeleteTests: [
      "tests/integration/attachments-repo.test.ts",
      "SOFT-DELETING THE PAGE hides its attachments, and restoring it brings them back",
    ],
  },
```

- [ ] **Step 7: Run it again**

Run: `npm test -- visible.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/attachments/repo.ts tests/integration/attachments-repo.test.ts \
  src/lib/pages/visible.test.ts
git commit -m "Add the attachment repository and its permission predicates"
```

---

## Task 10: The begin-upload route

**Files:**
- Create: `src/app/api/attachments/route.ts`
- Test: `tests/integration/attachment-begin-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/attachment-begin-route.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import type { Viewer } from "@/lib/authz/types";

/**
 * Every test here mocks `@/lib/auth/viewer` and re-imports the route dynamically, following
 * `draft-route.test.ts`'s discipline rather than the plan fence's original shape (a single
 * static `import { POST }` at the top, with `vi.doMock` called per-test but never followed by
 * a fresh import). `vi.doMock` is not hoisted and only takes effect for modules resolved AFTER
 * it runs — a statically-imported `POST` is already bound to the real `loadViewer` by the time
 * any test body executes, so that shape mocks nothing and every request falls through to
 * next-auth's real `auth()`, which throws outside a request scope. Caught by running the
 * fence's own tests: all seven failed with the same "headers was called outside a request
 * scope" error, not the statuses under test.
 */
const asEditor: Viewer = { id: "u1", isSuperAdmin: false, memberships: [] };

function request(body: unknown, headers: Record<string, string> = {}): Request {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(payload.length), ...headers },
    body: payload,
  });
}

/**
 * Loads the route bound to a given viewer. `doUnmock` matters for the same reason it does in
 * `draft-route.test.ts`: `resetModules` clears the module registry but leaves the MOCK
 * registry standing, so a repo stub left behind by one test would otherwise apply silently to
 * the next.
 */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doUnmock("@/lib/attachments/repo");
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/attachments/route")).POST;
}

test("401 without a session", async () => {
  const POST = await routeAs(null);
  expect((await POST(request({}))).status).toBe(401);
});

test("411 when Content-Length is absent, before the body is parsed", async () => {
  // `Number(null)` is 0, so a numeric-only cap waves an unbounded body through. Same
  // reasoning as the drafts route, and the same status.
  const POST = await routeAs(asEditor);
  const stripped = new Request("http://localhost/api/attachments", { method: "POST", body: "{}" });
  stripped.headers.delete("content-length");
  expect((await POST(stripped)).status).toBe(411);
});

test("415 for a mime off the allowlist, and no session is minted", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  const begin = vi.fn();
  vi.doMock("@/lib/attachments/repo", () => ({ beginUpload: begin }));
  const { POST } = await import("@/app/api/attachments/route");

  const response = await POST(
    request({ pageId: "p", filename: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 1 }),
  );
  expect(response.status).toBe(415);
  expect(begin).not.toHaveBeenCalled();
});

test("413 for a size over the cap, with the cap in the message", async () => {
  const POST = await routeAs(asEditor);
  const response = await POST(
    request({ pageId: "p", filename: "a.png", mimeType: "image/png", sizeBytes: 999_999_999_9 }),
  );
  expect(response.status).toBe(413);
  expect((await response.json()).message).toMatch(/\d/);
});

test("404 and 403 come from the repository, not from the route", async () => {
  for (const [reason, status] of [["not-found", 404], ["forbidden", 403]] as const) {
    vi.resetModules();
    vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
    vi.doMock("@/lib/attachments/repo", () => ({
      beginUpload: async () => ({ ok: false, reason }),
    }));
    const { POST: handler } = await import("@/app/api/attachments/route");
    expect((await handler(request(valid()))).status).toBe(status);
  }
});

test("503 when the store is unavailable, and the message says retry", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  vi.doMock("@/lib/attachments/repo", () => ({
    beginUpload: async () => ({ ok: false, reason: "store-unavailable" }),
  }));
  const { POST: handler } = await import("@/app/api/attachments/route");
  const response = await handler(request(valid()));
  expect(response.status).toBe(503);
  expect((await response.json()).message).toMatch(/again/i);
});

test("201 returns the session, and never the app token", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asEditor }));
  vi.doMock("@/lib/attachments/repo", () => ({
    beginUpload: async () => ({
      ok: true, attachmentId: "a1",
      uploadUrl: "https://upload/1", expiresAt: new Date("2026-08-26T10:00:00Z"),
    }),
  }));
  const { POST: handler } = await import("@/app/api/attachments/route");
  const response = await handler(request(valid()));

  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body).toEqual({
    attachmentId: "a1", uploadUrl: "https://upload/1",
    expiresAt: "2026-08-26T10:00:00.000Z",
  });
  // The session URL is pre-authenticated; an app token must never leave the server.
  expect(JSON.stringify(body)).not.toMatch(/bearer|access_token/i);
});

function valid() {
  return { pageId: "p", filename: "a.png", mimeType: "image/png", sizeBytes: 10 };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachment-begin-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement the route**

Create `src/app/api/attachments/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { beginUpload } from "@/lib/attachments/repo";
import { beginUploadInput, MAX_UPLOAD_BYTES } from "@/lib/attachments/schema";
import { isAllowedMime } from "@/lib/attachments/policy";

/**
 * Begin an upload. A translation layer and nothing more: `beginUpload` owns the permission
 * rules and the 404-not-403 line, and returns a discriminated result covering every outcome.
 *
 * The body is FOUR SMALL FIELDS, not the file. The `Content-Length` guard below is bounding a
 * few hundred bytes of JSON; the real size limit is `sizeBytes`, checked before any upload
 * session exists so a rejected file never reaches the store.
 */

/** Generous for four fields, and small enough that no body is buffered to reject one. */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to attach a file." },
      { status: 401 },
    );
  }

  // A missing header is its own rejection and must come first: a chunked request omits it,
  // `Number(null)` is 0, and a numeric-only cap lets an unbounded body through.
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declared);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That request is too large." },
      { status: 413 },
    );
  }

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = beginUploadInput.safeParse(raw);
  if (!parsed.success) {
    // The two rejections a person can act on get their own status and their own message. An
    // unsupported type and an oversized file are both "invalid" to zod, and both are useless
    // to a user as a bare 400.
    if (typeof raw?.mimeType === "string" && !isAllowedMime(raw.mimeType)) {
      return NextResponse.json(
        { error: "unsupported-type", message: `${raw.mimeType} cannot be attached.` },
        { status: 415 },
      );
    }
    if (typeof raw?.sizeBytes === "number" && raw.sizeBytes > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error: "too-large",
          message: `That file is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1_048_576)}MB limit.`,
        },
        { status: 413 },
      );
    }
    return NextResponse.json(
      { error: "invalid", message: "That upload could not be read." },
      { status: 400 },
    );
  }

  const result = await beginUpload(viewer, parsed.data);
  if (result.ok) {
    return NextResponse.json(
      {
        attachmentId: result.attachmentId,
        uploadUrl: result.uploadUrl,
        expiresAt: result.expiresAt.toISOString(),
      },
      { status: 201 },
    );
  }

  switch (result.reason) {
    // Byte-identical to a page id that never existed — same branch, deliberately.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page could not be found." },
        { status: 404 },
      );
    case "forbidden":
      return NextResponse.json(
        { error: "forbidden", message: "You cannot edit this page." },
        { status: 403 },
      );
    case "store-unavailable":
      return NextResponse.json(
        {
          error: "store-unavailable",
          message: "File storage is not responding. Your text is saved — try the file again.",
        },
        { status: 503 },
      );
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- attachment-begin-route.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/attachments/route.ts tests/integration/attachment-begin-route.test.ts
git commit -m "Add the begin-upload route"
```

---

## Task 11: The commit route

**Files:**
- Create: `src/app/api/attachments/[id]/commit/route.ts`
- Test: `tests/integration/attachment-commit-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/attachment-commit-route.test.ts`:

```ts
import { expect, test, vi } from "vitest";

function post(body = "{}"): Request {
  return new Request("http://localhost/api/attachments/a1/commit", { method: "POST", body });
}
const params = { params: Promise.resolve({ id: "a1" }) };

async function handler() {
  return (await import("@/app/api/attachments/[id]/commit/route")).POST;
}

test("401 without a session", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => null }));
  expect((await (await handler())(post(), params)).status).toBe(401);
});

test("the route ignores a driveItemId in the body", async () => {
  // The browser holds Graph's completion response and could report any item. The repository
  // stats by the key the application derived, and the route must not pass anything through.
  const commit = vi.fn(async () => ({ ok: true, attachment: attachment() }));
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({ commitUpload: commit }));

  await (await handler())(post(JSON.stringify({ driveItemId: "01ATTACKER" })), params);
  expect(commit).toHaveBeenCalledWith({ id: "u" }, "a1");
});

test("200 returns the reference the editor inserts, with the video path for a video", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    commitUpload: async () => ({
      ok: true,
      attachment: { ...attachment(), mimeType: "video/mp4", filename: "clip.mp4" },
    }),
  }));

  const body = await (await (await handler())(post(), params)).json();
  // `/video` is what the render plugin matches on to build a <video> element. An image gets
  // the bare URL.
  expect(body).toEqual({
    id: "a1", url: "/api/attachments/a1/video",
    filename: "clip.mp4", mimeType: "video/mp4", kind: "video",
  });
});

test("each failure reason gets its own status", async () => {
  for (const [reason, status] of [
    ["not-found", 404], ["not-uploaded", 409],
    ["size-mismatch", 400], ["store-unavailable", 503],
  ] as const) {
    vi.resetModules();
    vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
    vi.doMock("@/lib/attachments/repo", () => ({ commitUpload: async () => ({ ok: false, reason }) }));
    expect((await (await handler())(post(), params)).status, reason).toBe(status);
  }
});

function attachment() {
  return {
    id: "a1", drivePath: "a1/a1.png", filename: "shot.png",
    mimeType: "image/png", sizeBytes: 5, eTag: '"1"',
  };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachment-commit-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement the route**

Create `src/app/api/attachments/[id]/commit/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { commitUpload } from "@/lib/attachments/repo";
import { isInlineMime } from "@/lib/attachments/policy";

/**
 * The second half of the two-phase upload. The browser calls this once its direct upload to
 * Graph finishes, and the application verifies rather than believes.
 *
 * **The request body is ignored entirely.** There is deliberately no schema: everything this
 * endpoint needs is the id in the path and the viewer's session, and the one thing a client
 * might usefully send — Graph's item id — is the one thing that must not be trusted. Same
 * principle as bug-report context, which is derived from `routePath` and never accepted.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to attach a file." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const result = await commitUpload(viewer, id);

  if (result.ok) {
    const { attachment } = result;
    const video = attachment.mimeType.startsWith("video/") && isInlineMime(attachment.mimeType);
    return NextResponse.json({
      id: attachment.id,
      // The `/video` suffix is what the render plugin matches to build a <video> element.
      // Images get the bare URL and stay ordinary Markdown images.
      url: `/api/attachments/${attachment.id}${video ? "/video" : ""}`,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      kind: video ? "video" : isInlineMime(attachment.mimeType) ? "image" : "file",
    });
  }

  switch (result.reason) {
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That upload could not be found." },
        { status: 404 },
      );
    case "not-uploaded":
      // 409, not 404: the row exists and the caller may edit it — the bytes never arrived.
      // A 404 would send a client that just uploaded looking for the wrong problem.
      return NextResponse.json(
        { error: "not-uploaded", message: "The file did not finish uploading. Try again." },
        { status: 409 },
      );
    case "size-mismatch":
      return NextResponse.json(
        { error: "size-mismatch", message: "The uploaded file did not match its declared size." },
        { status: 400 },
      );
    case "store-unavailable":
      return NextResponse.json(
        { error: "store-unavailable", message: "File storage is not responding. Try again." },
        { status: 503 },
      );
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- attachment-commit-route.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/attachments/[id]/commit" tests/integration/attachment-commit-route.test.ts
git commit -m "Add the commit route, which verifies rather than believes"
```

---

## Task 12: The read proxy

**Files:**
- Create: `src/app/api/attachments/[id]/route.ts`
- Test: `tests/integration/attachment-read-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/attachment-read-route.test.ts`:

```ts
import { expect, test, vi } from "vitest";

const params = { params: Promise.resolve({ id: "a1" }) };

async function route() {
  return import("@/app/api/attachments/[id]/route");
}

function mockStore(overrides: Record<string, unknown> = {}) {
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
      ...overrides,
    }),
  }));
}

function mockReadable(mimeType = "image/png") {
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.png", filename: "shot.png",
      mimeType, sizeBytes: 5, eTag: '"1"',
    }),
  }));
}

test("401 without a session", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => null }));
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(401);
});

test("404 when the predicate refuses, byte-identical to a missing id", async () => {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({ readableAttachment: async () => null }));
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(404);
});

test("200 streams the bytes with the stored type, nosniff, and a PRIVATE immutable cache", async () => {
  vi.resetModules();
  mockReadable();
  mockStore();
  const response = await (await route()).GET(new Request("http://x/a1"), params);

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("hello");
  // The type comes from Postgres, never from the store: the mime was validated once at
  // upload, and this is what makes never seeing the bytes safe.
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  // `private` is a permission boundary. `public` would let a shared corporate proxy cache a
  // members-only screenshot and hand it to a non-member.
  expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(response.headers.get("content-disposition")).toBe('inline; filename="shot.png"');
});

test("an SVG downloads instead of rendering", async () => {
  vi.resetModules();
  mockReadable("image/svg+xml");
  mockStore();
  const response = await (await route()).GET(new Request("http://x/a1"), params);
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
});

test("a Range request gets 206 with a correct Content-Range", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async (_key: string, range?: { start: number; end: number }) => {
        expect(range).toEqual({ start: 1, end: 3 });
        return { stream: new Response("ell").body!, sizeBytes: 3, totalBytes: 5, eTag: '"1"' };
      },
    }),
  }));

  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=1-3" } }), params,
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 1-3/5");
  expect(response.headers.get("content-length")).toBe("3");
});

test("an open-ended range resolves against the stored size", async () => {
  // `bytes=2-` is what a video player actually sends when seeking.
  vi.resetModules();
  mockReadable("video/mp4");
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async (_key: string, range?: { start: number; end: number }) => {
        expect(range).toEqual({ start: 2, end: 4 });
        return { stream: new Response("llo").body!, sizeBytes: 3, totalBytes: 5, eTag: '"1"' };
      },
    }),
  }));
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=2-" } }), params,
  );
  expect(response.status).toBe(206);
});

test("416 for a range that starts past the end", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  mockStore();
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "bytes=99-100" } }), params,
  );
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */5");
});

test("an unparseable Range is IGNORED, not rejected", async () => {
  // RFC 9110: a syntactically invalid Range is ignored and the whole representation sent.
  vi.resetModules();
  mockReadable();
  mockStore();
  const response = await (await route()).GET(
    new Request("http://x/a1", { headers: { range: "furlongs=1-2" } }), params,
  );
  expect(response.status).toBe(200);
});

test("HEAD answers with the headers and no body", async () => {
  vi.resetModules();
  mockReadable("video/mp4");
  mockStore();
  const response = await (await route()).HEAD(new Request("http://x/a1", { method: "HEAD" }), params);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("5");
  expect(await response.text()).toBe("");
});

test("502 when the store throws, so an outage does not read as deletion", async () => {
  vi.resetModules();
  mockReadable();
  mockStore({ fetch: async () => { throw new Error("503"); } });
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(502);
});

test("404 when the row exists but the store has no bytes", async () => {
  vi.resetModules();
  mockReadable();
  mockStore({ fetch: async () => null });
  expect((await (await route()).GET(new Request("http://x/a1"), params)).status).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachment-read-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement the proxy**

Create `src/app/api/attachments/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { readableAttachment, softDeleteAttachment } from "@/lib/attachments/repo";
import { blobStore } from "@/lib/blob/select";
import { contentDisposition } from "@/lib/attachments/policy";
import type { ReadableAttachment } from "@/lib/attachments/repo";

/**
 * The read side of the asymmetry: bytes go through the application so that the same
 * `visiblePage`/`readableSpace` predicates that govern a page read govern its files.
 *
 * The bytes are STREAMED, never buffered. Buffering a 512MB video is 512MB of heap per
 * concurrent viewer, and `<video>` would still work — until two people watched at once.
 */

const YEAR = 31_536_000;

async function serve(request: Request, id: string, withBody: boolean) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to view this file." },
      { status: 401 },
    );
  }

  const attachment = await readableAttachment(viewer, id);
  // One answer for absent, soft-deleted, PENDING, page-deleted and unreadable-space. A
  // distinguishable 403 would confirm the file exists, which is the leak §8 closes.
  if (!attachment) {
    return NextResponse.json(
      { error: "not-found", message: "That file could not be found." },
      { status: 404 },
    );
  }

  const range = parseRange(request.headers.get("range"), attachment.sizeBytes);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "content-range": `bytes */${attachment.sizeBytes}`, "accept-ranges": "bytes" },
    });
  }

  let body;
  try {
    body = await blobStore().fetch(attachment.drivePath, range ?? undefined);
  } catch {
    // 502, not 404: a Graph outage must not read as every attachment having been deleted.
    // The page itself still renders — this is one broken image, never a 500.
    return NextResponse.json(
      { error: "store-unavailable", message: "File storage is not responding." },
      { status: 502 },
    );
  }
  if (!body) {
    return NextResponse.json(
      { error: "not-found", message: "That file could not be found." },
      { status: 404 },
    );
  }

  const headers = commonHeaders(attachment, body.eTag);
  headers.set("content-length", String(body.sizeBytes));
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${body.totalBytes}`);
  }

  return new NextResponse(withBody ? body.stream : null, {
    status: range ? 206 : 200,
    headers,
  });
}

function commonHeaders(attachment: ReadableAttachment, eTag: string | null): Headers {
  const headers = new Headers();
  // From Postgres, never from the store. The mime was validated once against the allowlist at
  // upload; letting the store decide would let a file's own metadata pick its interpretation.
  headers.set("content-type", attachment.mimeType);
  // Load-bearing: the application never sees the bytes, so a file declared `image/png` may
  // contain anything. `nosniff` is what stops a browser deciding it is HTML and running it.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", contentDisposition(attachment.mimeType, attachment.filename));
  headers.set("accept-ranges", "bytes");
  // `private` is a permission boundary, not a hint: `public` lets a shared proxy cache a
  // members-only screenshot and serve it to a non-member. `immutable` is honest because bytes
  // never change for an id — a replacement is a new attachment.
  //
  // The trade, recorded in spec §7.4: revocation applies to new fetches, not to bytes already
  // in a browser cache.
  headers.set("cache-control", `private, max-age=${YEAR}, immutable`);
  headers.set("vary", "Cookie");
  if (eTag) headers.set("etag", eTag);
  return headers;
}

/**
 * `Range`, or null to send everything, or "unsatisfiable" for 416.
 *
 * A syntactically invalid header is IGNORED rather than rejected, which RFC 9110 requires —
 * rejecting it would break a client that sent a range unit we do not implement. Only a
 * well-formed range that cannot be satisfied is a 416. `bytes=2-` is the form a video player
 * actually sends when seeking, so the open end resolves against the stored size.
 *
 * Two conforming choices this makes implicitly, stated so they read as decisions:
 *
 * - **A multi-range header is ignored, not partially served.** `bytes=1-2, 4-4` fails this
 *   regex and falls through to a full 200. RFC 9110 §14.2 does not require multipart/byteranges
 *   support, and answering the whole representation is explicitly permitted. Serving only the
 *   first sub-range would also conform and is strictly more surprising.
 * - **An over-long range clamps to a 206, not a 200.** `bytes=0-99` on a 5-byte object answers
 *   `206` with `Content-Range: bytes 0-4/5`, even though the clamped range is the whole object.
 *   Also permitted, and it keeps every satisfiable range on one code path.
 *
 * Measured, and the reason `bytes=-0` is separated out: a suffix length of zero is unsatisfiable
 * by definition, while `bytes=0-0` is an ordinary one-byte request. They must not collapse.
 */
function parseRange(
  header: string | null,
  totalBytes: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // A suffix range — `bytes=-500` means the LAST 500 bytes, not the first.
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, totalBytes - length), end: totalBytes - 1 };
  }

  const start = Number(rawStart);
  if (start >= totalBytes) return "unsatisfiable";
  const end = rawEnd === "" ? totalBytes - 1 : Math.min(Number(rawEnd), totalBytes - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, (await params).id, true);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return serve(request, (await params).id, false);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to remove this file." },
      { status: 401 },
    );
  }

  const result = await softDeleteAttachment(viewer, (await params).id);
  if (result.ok) return new NextResponse(null, { status: 204 });
  return NextResponse.json(
    { error: "not-found", message: "That file could not be found." },
    { status: 404 },
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- attachment-read-route.test.ts`
Expected: PASS, all eleven.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/attachments/[id]/route.ts" tests/integration/attachment-read-route.test.ts
git commit -m "Add the attachment read proxy, with Range and a private immutable cache"
```

---

## Task 13: The `/video` reference, and a matching path segment

The read route answers `/api/attachments/[id]`. The editor inserts
`/api/attachments/[id]/video` for a video, so the render plugin has something to match. That
URL must serve the same bytes.

**Files:**
- Create: `src/app/api/attachments/[id]/video/route.ts`
- Test: `tests/integration/attachment-video-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/attachment-video-route.test.ts`:

```ts
import { expect, test, vi } from "vitest";

test("the /video path serves the same bytes as the bare path", async () => {
  // It exists so the render plugin has a Markdown-expressible discriminator. Re-implementing
  // the proxy here would be a second copy of the permission check — the one thing that must
  // not be duplicated.
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.mp4", filename: "clip.mp4",
      mimeType: "video/mp4", sizeBytes: 5, eTag: '"1"',
    }),
  }));
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
    }),
  }));

  const { GET } = await import("@/app/api/attachments/[id]/video/route");
  const response = await GET(new Request("http://x/a1/video"), {
    params: Promise.resolve({ id: "a1" }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
});

test("a non-video attachment is still served, not refused", async () => {
  // The suffix is a routing hint from the editor, not an assertion about the file. Refusing a
  // mismatch would break a document whose video was replaced by an image.
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => ({ id: "u" }) }));
  vi.doMock("@/lib/attachments/repo", () => ({
    readableAttachment: async () => ({
      id: "a1", drivePath: "a1/a1.png", filename: "s.png",
      mimeType: "image/png", sizeBytes: 5, eTag: '"1"',
    }),
  }));
  vi.doMock("@/lib/blob/select", () => ({
    blobStore: () => ({
      fetch: async () => ({
        stream: new Response("hello").body!, sizeBytes: 5, totalBytes: 5, eTag: '"1"',
      }),
    }),
  }));

  const { GET } = await import("@/app/api/attachments/[id]/video/route");
  expect((await GET(new Request("http://x"), { params: Promise.resolve({ id: "a1" }) })).status)
    .toBe(200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachment-video-route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Implement it by re-export**

Create `src/app/api/attachments/[id]/video/route.ts`:

```ts
/**
 * `/api/attachments/{id}/video` serves exactly what `/api/attachments/{id}` serves.
 *
 * The suffix exists so a Markdown image reference can carry a discriminator the render plugin
 * can match — `![clip](/api/attachments/abc/video)` becomes a `<video>` element while
 * `![shot](/api/attachments/abc)` stays an `<img>`. Markdown has no other way to say
 * "this one is a video".
 *
 * Re-exported rather than reimplemented. A second copy of this handler would be a second copy
 * of the permission check, and the two would eventually disagree — the failure this repository
 * has already had once, with the never-spread predicate.
 */
export { GET, HEAD } from "../route";
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- attachment-video-route.test.ts`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/attachments/[id]/video" tests/integration/attachment-video-route.test.ts
git commit -m "Serve /api/attachments/[id]/video from the same handler"
```

---

## Task 14: The render plugin, and why the sanitiser is not touched

Spec correction #1. The spec's schema widening is ineffective — `allowDangerousHtml: false`
drops raw HTML before the sanitiser runs — and enabling raw HTML to make it matter is a far
larger change than the feature justifies.

**Files:**
- Create: `src/lib/markdown/attachment-video.ts`
- Modify: `src/lib/markdown/render.ts`
- Test: `src/lib/markdown/render.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/markdown/render.test.ts`:

```ts
test("a /video attachment reference becomes a <video> element", async () => {
  const { html } = await renderMarkdown("![clip](/api/attachments/abc123/video)");
  expect(html).toContain('<video src="/api/attachments/abc123/video"');
  expect(html).toContain("controls");
  expect(html).not.toContain("<img");
});

test("an ordinary attachment reference stays an <img>", async () => {
  const { html } = await renderMarkdown("![shot](/api/attachments/abc123)");
  expect(html).toContain('<img src="/api/attachments/abc123"');
  expect(html).not.toContain("<video");
});

test("the alt text survives as an accessible label", async () => {
  const { html } = await renderMarkdown("![a demo](/api/attachments/abc123/video)");
  expect(html).toContain('aria-label="a demo"');
});

test("an off-origin src is never turned into a video, whatever it claims", async () => {
  // The src is RECONSTRUCTED from the captured id, not validated and passed through, so
  // there is no allowlist to get wrong.
  for (const src of [
    "https://evil.test/api/attachments/abc/video",
    "//evil.test/api/attachments/abc/video",
    "/api/attachments/../../evil/video",
    "/api/attachments/abc/video?x=1",
    "javascript:alert(1)//api/attachments/abc/video",
  ]) {
    const { html } = await renderMarkdown(`![x](${src})`);
    expect(html, src).not.toContain("<video");
  }
});

test("raw HTML is still dropped, sanitiser untouched", async () => {
  // The pipeline's posture is unchanged: `allowDangerousHtml` stays false, so this plugin
  // adds a video element WITHOUT opening the raw-HTML surface of every document.
  const { html } = await renderMarkdown('<video src="/api/attachments/abc/video"></video>');
  expect(html).not.toContain("<video");
  const script = await renderMarkdown("<script>alert(1)</script>");
  expect(script.html).not.toContain("<script");
});

test("a video reference inside a code fence is not transformed", async () => {
  const { html } = await renderMarkdown("```\n![x](/api/attachments/abc/video)\n```");
  expect(html).not.toContain("<video");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- render.test.ts`
Expected: FAIL on the first three — no `<video>` is produced.

- [ ] **Step 3: Write the plugin**

Create `src/lib/markdown/attachment-video.ts`:

```ts
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";

/**
 * Turns `![alt](/api/attachments/<id>/video)` into a `<video>` element.
 *
 * Markdown cannot express a video, and the obvious remedy — allowing raw `<video>` through
 * the sanitiser — does not work here: `remarkRehype` runs with `allowDangerousHtml: false`, so
 * raw HTML is dropped before the sanitiser ever sees it. Making the schema matter would mean
 * enabling raw HTML and adding `rehype-raw`, which exposes the entire raw-HTML surface of
 * every existing document. That is a much larger change than one element is worth.
 *
 * So this runs AFTER sanitisation and constructs the element itself, exactly as
 * `extractMermaid` does for diagrams. The consequence is the useful part: `src` is
 * **reconstructed from the captured id**, never validated and passed through, so an
 * off-origin video is impossible by construction rather than by allowlist. The sanitiser is
 * not modified at all.
 *
 * Anchored at both ends, and the id class is deliberately narrow — cuid is lowercase
 * alphanumeric. A query string, a traversal segment or a scheme cannot match.
 */
const VIDEO_SRC = /^\/api\/attachments\/([a-z0-9]+)\/video$/;

export function attachmentVideo() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "img" || index === undefined || !parent) return;

      const src = node.properties?.src;
      if (typeof src !== "string") return;
      const match = src.match(VIDEO_SRC);
      if (!match) return;

      const alt = typeof node.properties?.alt === "string" ? node.properties.alt : "";

      parent.children[index] = {
        type: "element",
        tagName: "video",
        properties: {
          // Rebuilt from the capture. Whatever the document wrote, this is what ships.
          src: `/api/attachments/${match[1]}/video`,
          controls: true,
          preload: "metadata",
          // A video has no alt attribute, so the author's alt text becomes the accessible
          // name rather than being silently discarded.
          ...(alt ? { "aria-label": alt } : {}),
        },
        children: [],
      } satisfies Element;
    });
  };
}
```

- [ ] **Step 4: Wire it into the pipeline**

In `src/lib/markdown/render.ts`, import it and add it beside `extractMermaid`:

```ts
    .use(extractMermaid)
    .use(attachmentVideo)
```

Add a note above the `schema` declaration recording why it is unchanged:

```ts
// Deliberately NOT widened for `<video>`. The spec first proposed adding the element here;
// measured against this pipeline that is inert, because `allowDangerousHtml: false` drops raw
// HTML before the sanitiser runs. `attachmentVideo` builds the element after sanitisation
// from a regex-captured id instead — see that module. Nothing about this schema changes for
// attachments.
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- render.test.ts`
Expected: PASS, including every pre-existing test — the schema is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/lib/markdown/attachment-video.ts src/lib/markdown/render.ts \
  src/lib/markdown/render.test.ts
git commit -m "Build <video> after sanitisation instead of widening the schema"
```

---

## Task 15: The upload transport

Client-side. Session, chunking, resume — no UI.

**Files:**
- Create: `src/lib/editor/upload.ts`
- Test: `src/lib/editor/upload.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/editor/upload.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { CHUNK_BYTES, uploadAttachment } from "./upload";

function file(bytes: number, type = "image/png"): File {
  return new File([new Uint8Array(bytes)], "shot.png", { type });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

test("the chunk size is an exact multiple of Graph's 320KiB quantum", () => {
  // Graph rejects a non-final chunk that is not a multiple of 320KiB. 10MiB is 32 of them.
  expect(CHUNK_BYTES % (320 * 1024)).toBe(0);
});

test("a small file still goes through a resumable session", async () => {
  // Graph offers a simple PUT under 4MB, but that needs an APP TOKEN, and an app token must
  // never reach a browser. One code path, and the client holds no credential.
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(json({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" }));

  const result = await uploadAttachment(
    { pageId: "p", file: file(10) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result.ok).toBe(true);
  expect(fetchImpl.mock.calls[1][0]).toBe("https://up/1");
});

test("a large file is chunked, with correct inclusive Content-Range on each part", async () => {
  const ranges: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") {
      ranges.push(new Headers(init?.headers).get("content-range")!);
      return new Response(null, { status: 202 });
    }
    return json({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" });
  });

  const size = CHUNK_BYTES + 1000;
  await uploadAttachment(
    { pageId: "p", file: file(size) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );

  expect(ranges).toEqual([
    `bytes 0-${CHUNK_BYTES - 1}/${size}`,
    `bytes ${CHUNK_BYTES}-${size - 1}/${size}`,
  ]);
});

test("progress is reported per chunk and ends at 1", async () => {
  const seen: number[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") return new Response(null, { status: 202 });
    return json({ id: "a1", url: "/api/attachments/a1", filename: "s.png", kind: "image" });
  });

  await uploadAttachment(
    { pageId: "p", file: file(CHUNK_BYTES * 2) },
    { fetchImpl: fetchImpl as unknown as typeof fetch, onProgress: (p) => seen.push(p) },
  );
  expect(seen.at(-1)).toBe(1);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

test("a failed chunk is retried from nextExpectedRanges rather than restarted", async () => {
  // The reason video upload is survivable on a flaky connection. Restarting a 400MB upload
  // from zero is the difference between a retry and a lost afternoon.
  let attempts = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/attachments") {
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    if (String(input) === "https://up/1") {
      if (init?.method === "GET") {
        return json({ nextExpectedRanges: [`${CHUNK_BYTES}-`] });
      }
      attempts += 1;
      if (attempts === 2) return new Response(null, { status: 500 });
      return new Response(null, { status: 202 });
    }
    return json({ id: "a1", url: "/api/attachments/a1", filename: "s.png", kind: "image" });
  });

  const result = await uploadAttachment(
    { pageId: "p", file: file(CHUNK_BYTES * 2) },
    { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result.ok).toBe(true);
  // Queried the session for where to resume rather than starting over.
  expect(fetchImpl.mock.calls.some(([, init]) => (init as RequestInit)?.method === "GET")).toBe(true);
});

test("a rejected begin surfaces the server's message unchanged", async () => {
  const fetchImpl = vi.fn(async () =>
    json({ error: "unsupported-type", message: "application/x-msdownload cannot be attached." }, 415),
  );
  const result = await uploadAttachment(
    { pageId: "p", file: file(10) }, { fetchImpl: fetchImpl as unknown as typeof fetch },
  );
  expect(result).toEqual({
    ok: false, message: "application/x-msdownload cannot be attached.",
  });
});

test("an abort signal stops the upload without committing", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/attachments") {
      controller.abort();
      return json({ attachmentId: "a1", uploadUrl: "https://up/1", expiresAt: "z" });
    }
    throw new Error("should not reach the upload");
  });

  const result = await uploadAttachment(
    { pageId: "p", file: file(10) },
    { fetchImpl: fetchImpl as unknown as typeof fetch, signal: controller.signal },
  );
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- editor/upload.test.ts`
Expected: FAIL — cannot resolve `./upload`.

- [ ] **Step 3: Implement the transport**

Create `src/lib/editor/upload.ts`:

```ts
/**
 * Browser-side upload transport: begin, chunk straight to the store, commit.
 *
 * The bytes never touch this application on the way in. `POST /api/attachments` returns a
 * pre-authenticated session URL and the browser writes to it directly, which is what keeps a
 * 400MB screen recording out of Next.js's heap. The only capability the client ever holds is
 * *write to this one item, for about fifteen minutes*.
 */

/**
 * 10MiB — exactly 32 × 320KiB.
 *
 * Graph rejects a non-final chunk whose length is not a multiple of 320KiB, so this is not a
 * tuning knob to round off. Larger chunks mean fewer round trips and a coarser resume point.
 */
export const CHUNK_BYTES = 10 * 1024 * 1024;

export type UploadedAttachment = {
  id: string;
  url: string;
  filename: string;
  kind: "image" | "video" | "file";
};

export type UploadResult =
  | { ok: true; attachment: UploadedAttachment }
  | { ok: false; message: string };

export type UploadOptions = {
  fetchImpl?: typeof fetch;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

export async function uploadAttachment(
  { pageId, file }: { pageId: string; file: File },
  { fetchImpl = fetch, onProgress, signal }: UploadOptions = {},
): Promise<UploadResult> {
  const begun = await fetchImpl("/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pageId,
      filename: file.name,
      // A browser leaves `type` empty for an unrecognised extension. Sending the empty string
      // is correct: the server's allowlist rejects it with a message about the type, which is
      // the true reason, rather than this guessing one.
      mimeType: file.type,
      sizeBytes: file.size,
    }),
    signal,
  });

  if (!begun.ok) {
    // The server's own wording, unchanged. It knows the cap and the allowlist; restating them
    // here would be a second copy that drifts.
    const body = await begun.json().catch(() => null);
    return { ok: false, message: body?.message ?? "That file could not be attached." };
  }

  const { attachmentId, uploadUrl } = (await begun.json()) as {
    attachmentId: string;
    uploadUrl: string;
  };

  let offset = 0;
  while (offset < file.size) {
    if (signal?.aborted) return { ok: false, message: "Upload cancelled." };

    const end = Math.min(offset + CHUNK_BYTES, file.size);
    const response = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        // INCLUSIVE end, and the total after the slash — the form Graph requires.
        "content-range": `bytes ${offset}-${end - 1}/${file.size}`,
      },
      body: file.slice(offset, end),
      signal,
    });

    if (response.ok) {
      offset = end;
      onProgress?.(offset / file.size);
      continue;
    }

    // Ask the session where it actually got to rather than assuming this chunk was lost.
    // Restarting a large upload from zero is the failure this whole branch exists to avoid.
    const resumed = await resumeOffset(fetchImpl, uploadUrl, signal);
    if (resumed === null || resumed <= offset) {
      return { ok: false, message: "The upload was interrupted. Try again." };
    }
    offset = resumed;
    onProgress?.(offset / file.size);
  }

  const committed = await fetchImpl(`/api/attachments/${attachmentId}/commit`, {
    method: "POST",
    signal,
  });
  if (!committed.ok) {
    const body = await committed.json().catch(() => null);
    return { ok: false, message: body?.message ?? "The upload could not be finished." };
  }

  return { ok: true, attachment: (await committed.json()) as UploadedAttachment };
}

/** The first byte the session still wants, from `nextExpectedRanges`. */
async function resumeOffset(
  fetchImpl: typeof fetch,
  uploadUrl: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const response = await fetchImpl(uploadUrl, { method: "GET", signal }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as
    | { nextExpectedRanges?: string[] }
    | null;
  const first = body?.nextExpectedRanges?.[0];
  if (!first) return null;
  const start = Number(first.split("-")[0]);
  return Number.isInteger(start) ? start : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- editor/upload.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add src/lib/editor/upload.ts src/lib/editor/upload.test.ts
git commit -m "Add the chunked, resumable upload transport"
```

---

## Task 16: The editor surface

**Files:**
- Create: `src/components/AttachmentDrop.tsx`
- Modify: `src/components/Editor.tsx`
- Modify: `src/components/editor.css`
- Test: `src/lib/editor/reference.test.ts`
- Create: `src/lib/editor/reference.ts`

- [ ] **Step 1: Write the failing tests for the pure part**

The reference text is pure and gets its own module, so it tests without a DOM. Create
`src/lib/editor/reference.test.ts`:

```ts
import { expect, test } from "vitest";
import { referenceFor } from "./reference";

test("an image becomes an image reference", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "shot.png", kind: "image" }))
    .toBe("![shot.png](/api/attachments/a1)");
});

test("a video uses the /video url the render plugin matches", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1/video", filename: "clip.mp4", kind: "video" }))
    .toBe("![clip.mp4](/api/attachments/a1/video)");
});

test("a document becomes a link, not an image", () => {
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "report.pdf", kind: "file" }))
    .toBe("[report.pdf](/api/attachments/a1)");
});

test("a filename containing brackets or parens cannot break out of the reference", () => {
  // Otherwise a file called `a](x` rewrites the document's link structure — the Markdown
  // equivalent of the header-injection case in policy.ts.
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "a](x).png", kind: "image" }))
    .toBe("![a\\]\\(x\\).png](/api/attachments/a1)");
});

test("a newline in a filename is replaced, not escaped", () => {
  // A newline ends the reference outright; there is no escape for it in link text.
  expect(referenceFor({ id: "a1", url: "/api/attachments/a1", filename: "a\nb.png", kind: "image" }))
    .toBe("![a b.png](/api/attachments/a1)");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- editor/reference.test.ts`
Expected: FAIL — cannot resolve `./reference`.

- [ ] **Step 3: Implement the reference builder**

Create `src/lib/editor/reference.ts`:

```ts
import type { UploadedAttachment } from "./upload";

/**
 * The Markdown an upload inserts.
 *
 * The escaping is the same class of problem as `Content-Disposition`: a filename is user input
 * being spliced into a structured syntax. `a](x).png` unescaped rewrites the document's link
 * structure from inside the label.
 */
export function referenceFor(attachment: UploadedAttachment): string {
  const label = attachment.filename
    // No escape exists for a newline inside link text — it simply ends the construct — so it
    // is replaced rather than escaped.
    .replace(/[\r\n]+/g, " ")
    .replace(/([[\]()\\])/g, "\\$1");

  // An image or a video both use the image form: the render plugin rewrites the `/video` one
  // into a <video> element after sanitisation.
  const prefix = attachment.kind === "file" ? "" : "!";
  return `${prefix}[${label}](${attachment.url})`;
}
```

- [ ] **Step 4: Run it**

Run: `npm test -- editor/reference.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Build the component**

Create `src/components/AttachmentDrop.tsx`. Everything here is independent of the editor's
internals — the single integration point is the `onInsert` callback, which Step 6 wires to a
splice at the cursor.

```tsx
"use client";

import { useCallback, useRef, useState } from "react";
import { uploadAttachment } from "@/lib/editor/upload";
import { referenceFor } from "@/lib/editor/reference";

type Job = { name: string; progress: number; error?: string };

/**
 * Paste, drag or pick a file; upload it; hand back the Markdown reference.
 *
 * Knows nothing about the editor beyond `onInsert`. The bytes go straight from here to the
 * store — this component never posts a file to this application.
 */
export function AttachmentDrop({
  pageId,
  onInsert,
  children,
}: {
  pageId: string;
  onInsert: (markdown: string) => void;
  children: React.ReactNode;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const aborts = useRef(new Map<string, AbortController>());

  const run = useCallback(
    async (files: File[]) => {
      // SEQUENTIAL, not concurrent. Four parallel 400MB uploads saturate the link and every
      // progress bar stalls together; one at a time is slower in aggregate and far more
      // legible to the person watching it.
      for (const file of files) {
        const controller = new AbortController();
        aborts.current.set(file.name, controller);
        setJobs((current) => [...current, { name: file.name, progress: 0 }]);

        const result = await uploadAttachment(
          { pageId, file },
          {
            signal: controller.signal,
            onProgress: (fraction) =>
              setJobs((current) =>
                current.map((job) =>
                  job.name === file.name ? { ...job, progress: fraction } : job,
                ),
              ),
          },
        );
        aborts.current.delete(file.name);

        if (result.ok) {
          // A trailing newline, so the next paste does not concatenate onto this reference.
          onInsert(`${referenceFor(result.attachment)}\n`);
          setJobs((current) => current.filter((job) => job.name !== file.name));
        } else {
          // The server's wording, verbatim — it knows the cap and the allowlist. And the
          // loop continues: one refused file must not abandon the rest.
          setJobs((current) =>
            current.map((job) =>
              job.name === file.name ? { ...job, error: result.message } : job,
            ),
          );
        }
      }
    },
    [pageId, onInsert],
  );

  return (
    <div
      className={dragging ? "attach-drop attach-drop--over" : "attach-drop"}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        // Files win over text. A screenshot pasted from the clipboard also carries an empty
        // `text/plain` part in several browsers, so taking the text first silently drops the
        // image — and the person sees nothing happen at all.
        if (files.length === 0) return;
        event.preventDefault();
        void run(files);
      }}
      onDragOver={(event) => {
        // Required on dragover as well as drop. Without it the browser NAVIGATES to the
        // dropped file and the draft is left behind unsaved.
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void run(Array.from(event.dataTransfer.files));
      }}
    >
      {children}

      <label className="attach-pick">
        Attach a file
        <input
          type="file"
          multiple
          // The accessible name the e2e specs target, and the affordance for anyone who
          // cannot drag.
          aria-label="Attach a file"
          onChange={(event) => {
            void run(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </label>

      {jobs.length > 0 && (
        <ul className="attach-jobs">
          {jobs.map((job) => (
            <li key={job.name} className={job.error ? "attach-job attach-job--error" : "attach-job"}>
              <span className="attach-job__name">{job.name}</span>
              {job.error ? (
                <>
                  <span role="alert">{job.error}</span>
                  <button type="button" onClick={() => setJobs((c) => c.filter((j) => j !== job))}>
                    Dismiss
                  </button>
                </>
              ) : (
                <>
                  <progress value={job.progress} max={1} aria-label={`Uploading ${job.name}`} />
                  <button type="button" onClick={() => aborts.current.get(job.name)?.abort()}>
                    Cancel
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Note the two comments marked as browser behaviour: `onDragOver` needing `preventDefault`, and
a clipboard screenshot arriving alongside an empty `text/plain`. Both are the kind of thing
that looks like a redundant line and is not.

- [ ] **Step 6: Wire it into `Editor.tsx` and style the progress rows in `editor.css`**

The editor already owns the draft text and the autosave scheduler; `onInsert` splices at the
selection and marks the draft dirty so the existing scheduler saves it. Do not add a second
save path.

- [ ] **Step 7: Verify by hand, then by build**

Run: `npm run dev`, open an editor, paste a screenshot, confirm the reference appears, the
preview renders it, and publishing keeps it.
Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/editor/reference.ts src/lib/editor/reference.test.ts \
  src/components/AttachmentDrop.tsx src/components/Editor.tsx src/components/editor.css
git commit -m "Add the editor's attachment surface"
```

---

## Task 17: The sweep

**Files:**
- Create: `scripts/sweep-attachments.mjs`
- Test: `tests/integration/attachment-sweep.test.ts`
- Create: `src/lib/attachments/sweep.ts`

The logic lives in `src/lib/attachments/sweep.ts` so it is testable; the script is an entry
point that parses flags and prints.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/attachment-sweep.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { attach, cast } from "./support/attachments";
import { memoryStore } from "@/lib/blob/select";
import { sweepAttachments } from "@/lib/attachments/sweep";

beforeEach(resetDb);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

function sweep(overrides: { deleteOrphans?: boolean } = {}) {
  return sweepAttachments({
    store: memoryStore(), now: new Date(), retentionDays: 30, ...overrides,
  });
}

const exists = async (id: string) =>
  (await db.attachment.findUnique({ where: { id }, select: { id: true } })) !== null;

test("a PENDING row older than the grace period is removed, with its bytes", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(25 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(1);
  expect(await exists(a.id)).toBe(false);
  expect(await memoryStore().stat(a.drivePath)).toBeNull();
});

test("a PENDING row inside the grace period is left alone", async () => {
  // An upload in progress right now is PENDING. Reclaiming it deletes a file mid-upload.
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(2 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(0);
  expect(await exists(a.id)).toBe(true);
});

test("a soft-deleted row past retention is removed, and one inside it is kept", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const past = await attach(c.pageId, c.editor.id, { deletedAt: ago(31 * DAY) });
  const recent = await attach(c.pageId, c.editor.id, { deletedAt: ago(3 * DAY) });

  expect((await sweep()).expired).toBe(1);
  expect(await exists(past.id)).toBe(false);
  expect(await exists(recent.id)).toBe(true);
});

test("a COMMITTED, undeleted row is NEVER touched, whatever its age", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  const a = await attach(c.pageId, c.editor.id, { createdAt: ago(900 * DAY) });

  const report = await sweep();
  expect(report.expired + report.abandonedUploads).toBe(0);
  expect(await exists(a.id)).toBe(true);
});

test("an orphaned drive item is REPORTED and not deleted by default", async () => {
  // A sweep bug that reports is a nuisance; one that deletes is data loss. The default has
  // to be the recoverable one.
  await cast({ visibility: "MEMBERS", published: true });
  await memoryStore().put("zz/nosuchrow.png", new Uint8Array(1));

  expect((await sweep()).orphans).toEqual(["zz/nosuchrow.png"]);
  expect(await memoryStore().stat("zz/nosuchrow.png")).not.toBeNull();
});

test("orphans are deleted only when explicitly asked", async () => {
  await cast({ visibility: "MEMBERS", published: true });
  await memoryStore().put("zz/nosuchrow.png", new Uint8Array(1));

  await sweep({ deleteOrphans: true });
  expect(await memoryStore().stat("zz/nosuchrow.png")).toBeNull();
});

test("an item belonging to a live row is not an orphan", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  await attach(c.pageId, c.editor.id);
  expect((await sweep()).orphans).toEqual([]);
});

test("the sweep is idempotent", async () => {
  const c = await cast({ visibility: "MEMBERS", published: true });
  await attach(c.pageId, c.editor.id, { state: "PENDING", createdAt: ago(25 * HOUR) });

  expect((await sweep()).abandonedUploads).toBe(1);
  // Second pass finds nothing, and in particular does not fail on the item it already
  // deleted — `delete` is idempotent for exactly this reason.
  expect((await sweep()).abandonedUploads).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- attachment-sweep.test.ts`
Expected: FAIL — cannot resolve `@/lib/attachments/sweep`.

- [ ] **Step 3: Implement the sweep**

Create `src/lib/attachments/sweep.ts` with `sweepAttachments(options)` returning
`{ abandonedUploads, expired, orphans }`, in three passes:

1. `state: "PENDING"` and `createdAt` older than 24h — delete the drive item, then the row.
   The grace period exists because an upload in progress right now is `PENDING`.
2. `deletedAt` older than `retentionDays` — delete the drive item, then the row.
3. Every key under each shard prefix that has no matching row — collect into `orphans`, and
   delete only when `deleteOrphans` is set.

Order matters in passes 1 and 2: **bytes first, row second.** The reverse leaves an item with
no row, which pass 3 then reports as an orphan — turning a completed deletion into a permanent
warning. Delete is idempotent, so a crash between the two is safe to re-run.

- [ ] **Step 4: Write the script entry point**

Create `scripts/sweep-attachments.mjs`: parse `--delete-orphans` and `--dry-run`, read
`ATTACHMENT_RETENTION_DAYS`, call `sweepAttachments`, print a one-line summary per pass, and
exit non-zero only on an error. Document at the top that there is no job runner yet, so this
runs by hand or by cron, and that security does not depend on it — readability is governed by
the row's `deletedAt` and `state`, so lingering bytes are a retention matter.

- [ ] **Step 5: Run the tests and the script**

Run: `npm test -- attachment-sweep.test.ts`
Expected: PASS, all eight.
Run: `node scripts/sweep-attachments.mjs --dry-run`
Expected: a summary, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/attachments/sweep.ts scripts/sweep-attachments.mjs \
  tests/integration/attachment-sweep.test.ts
git commit -m "Add the attachment retention sweep"
```

---

## Task 18: End-to-end

**Files:**
- Create: `e2e/attachments.spec.ts`

- [ ] **Step 1: Write the specs**

First, add `BLOB_STORE` to the Playwright server's environment in `playwright.config.ts`:

```ts
    env: { ALLOW_TEST_LOGIN: "1", GIT_SHA: "df0ef11abc", BLOB_STORE: "memory" },
```

Without it every spec fails at boot, which is `select.ts` working as designed.

Create `e2e/attachments.spec.ts`. Five specs, and each asserts the property rather than a
proxy for it:

```ts
import { expect, test } from "@playwright/test";
import { actorContext, seedPublishedPage, signIn, sweep } from "./support";

/** A 1×1 PNG, as bytes — small enough to inline and a real image, so decode is a real check. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

test.afterEach(sweep);

/** Attaches a file through the editor and returns the attachment id from the inserted URL. */
async function attachThroughEditor(page: import("@playwright/test").Page, pageId: string) {
  await page.goto(`/edit/${pageId}`);
  await page.getByLabel(/attach/i).setInputFiles({
    name: "shot.png", mimeType: "image/png", buffer: PNG,
  });
  // The progress row disappears when the commit lands. Waiting on the reference itself would
  // pass on a half-finished upload whose bytes never arrived.
  await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: 30_000 });

  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("/api/attachments/");
  const text = await editor.innerText();
  return text.match(/\/api\/attachments\/([a-z0-9]+)/)![1];
}

test("an editor attaches an image and another member's browser renders it", async ({
  page, browser,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach", title: "Attach", markdown: "# Attach\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);
  await page.getByRole("button", { name: /publish/i }).click();

  // A SECOND identity, with its own cookie jar. The property is that the reader's browser
  // fetches the bytes through the proxy under the READER's session — asserting the Markdown
  // contains a URL would not test that.
  //
  // `admin@example.com` because the seed has exactly three identities: aisyah (editor),
  // stranger (member of nothing) and admin. This spec's property is "a different session
  // renders it"; whether MEMBERSHIP is what admits them is the next spec's job.
  const reader = await actorContext(browser, "admin@example.com");
  const response = await reader.page.goto(fixture.path);
  expect(response!.status()).toBe(200);

  const image = reader.page.locator(`img[src="/api/attachments/${id}"]`);
  await expect(image).toBeVisible();
  // A 404 still renders an <img> element. Only a decoded bitmap has a naturalWidth.
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await reader.context.close();
});

test("a non-member gets 404 on the attachment URL", async ({ page, browser }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-private", title: "Private", markdown: "# Private\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);

  // `stranger@example.com` is a member of nothing — the seeded identity Phase 1 added to
  // demonstrate 404-not-403.
  const outsider = await actorContext(browser, "stranger@example.com");
  const response = await outsider.page.request.get(`/api/attachments/${id}`);
  expect(response.status()).toBe(404);
  await outsider.context.close();
});

test("an unsupported type is refused with the server's own message, and inserts nothing", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-refused", title: "Refused", markdown: "# Refused\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${fixture.id}`);

  await page.getByLabel(/attach/i).setInputFiles({
    name: "payload.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ"),
  });

  await expect(page.getByText(/cannot be attached/i)).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("/api/attachments/");
});

test("a video plays and seeking issues a 206", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-video", title: "Video", markdown: "# Video\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${fixture.id}`);
  await page.getByLabel(/attach/i).setInputFiles({
    name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(64 * 1024, 1),
  });
  await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: 30_000 });
  // The `/video` suffix is what the render plugin matches on.
  await expect(page.locator(".cm-content")).toContainText("/video)");
  await page.getByRole("button", { name: /publish/i }).click();

  await page.goto(fixture.path);
  const video = page.locator("video");
  await expect(video).toBeVisible();

  // A <video> element that renders but cannot seek is exactly what a Range bug produces, so
  // the 206 is the assertion, not the element.
  const partial = page.waitForResponse(
    (response) => response.url().includes("/api/attachments/") && response.status() === 206,
  );
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 0.5;
  });
  expect((await partial).status()).toBe(206);
});

test("removing an attachment makes it 404 immediately, for the editor who owns it", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-removed", title: "Removed", markdown: "# Removed\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);

  expect((await page.request.get(`/api/attachments/${id}`)).status()).toBe(200);
  expect((await page.request.delete(`/api/attachments/${id}`)).status()).toBe(204);
  // No cache revalidation involved: `request` is not the page's HTTP cache. The soft-delete
  // takes effect on the next fetch, which is the guarantee the design actually makes.
  expect((await page.request.get(`/api/attachments/${id}`)).status()).toBe(404);
});
```

Extend `sweep()` in `e2e/support.ts` to remove `Attachment` rows for `e2e-` pages, or
`snapshotCounts` drifts and every later spec run starts dirty.

- [ ] **Step 2: Run them**

Run: `npm run test:e2e -- attachments.spec.ts`
Expected: PASS. `webServer.env` must set `BLOB_STORE=memory`, or every spec fails at boot —
which is `select.ts` working.

- [ ] **Step 3: Commit**

```bash
git add e2e/attachments.spec.ts playwright.config.ts
git commit -m "Add end-to-end coverage for attachments"
```

---

## Task 19: Extend the smoke test

**Files:**
- Modify: `scripts/smoke.sh`

- [ ] **Step 1: Add the attachment pass**

After the doc-lifecycle pass, add a pass that: signs in as `aisyah@example.com`; `POST`s to
`/api/attachments` for the smoke page with a small PNG; `PUT`s the bytes to the returned
`uploadUrl`; `POST`s the commit; `GET`s the attachment and asserts 200 with
`content-type: image/png` and `cache-control` containing `private`; `GET`s it as
`stranger@example.com` and asserts **404**; and asserts a `Range` request returns 206.

Set `BLOB_STORE=memory` in the script's environment, beside `ALLOW_TEST_LOGIN=1`, with a
comment that the memory store is the only reason this runs without tenant credentials.

- [ ] **Step 2: Extend the teardown**

The pass inserts an `Attachment` row. Add it to `sweep` and to `counts`, or the final
before/after assertion fails — which is that guard working. Update the teardown comment: it
enumerates what each phase adds, and an unlisted model is how the next person is misled.

- [ ] **Step 3: Update the header comment**

`scripts/smoke.sh`'s header lists what each phase added. Add Phase 4's pass.

- [ ] **Step 4: Run it**

Run: `npm run smoke`
Expected: SMOKE PASSED, with the new checks counted. Confirm the before/after database counts
match — a leaked `Attachment` row means the sweep is incomplete.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.sh
git commit -m "Add the attachment pass to the smoke test (Phase 4 Task 19)"
```

---

## Task 20: Close the phase

- [ ] **Step 1: Renumber the roadmap**

In `docs/superpowers/plans/2026-08-21-docs-platform-roadmap.md`, insert Phase 4 (attachments
and the Entra cutover) and shift search/diagrams, git mirror and systems/admin to 5, 6, 7.
Remove "S3 attachments via presigned URLs" from what is now Phase 7 and note where it went.

- [ ] **Step 2: Amend the superseded spec entries**

In `docs/superpowers/specs/2026-08-21-internal-docs-platform-design.md`: mark **D12** as
superseded by the Phase 4 spec, keeping its rationale — a SharePoint library is remote state,
not container state, so the stateless-container argument still holds and is still satisfied.
Rewrite §17's configuration paragraph against §9 of the new spec.

- [ ] **Step 3: Update `PROGRESS.md`**

Record: phases complete, the new test counts, and add to "Decisions that should not be
relitigated" —

- `editableSpace` must short-circuit on `isSuperAdmin`, exactly as `can()` does; the naïve
  composition through `readableSpace` silently denies a super admin.
- Attachment readability nests `visiblePage`, so page delete and restore govern it. That is
  emergent, not written, and has its own test.
- The sanitiser is **not** widened for `<video>`. `allowDangerousHtml: false` means raw HTML
  never reaches it, so the element is built after sanitisation from a regex-captured id.
- `BLOB_STORE` has no default, in either direction.
- `Cache-Control: private` on the attachment proxy is a permission boundary.

- [ ] **Step 4: Run everything**

```bash
npm run typecheck && npm test && npm run test:e2e && npm run smoke && npm run plan:check && npm run build
```

Expected: all green, and `plan:check` reporting **0 drifted**. Reconcile any fence in this plan
that no longer matches the code it quotes — the plan is kept true, not archived.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers
git commit -m "Close Phase 4"
```

---

## Exit criteria

- An editor pastes a screenshot into the editor; it appears in the preview, in the published
  page, and in another member's browser.
- A non-member requesting the attachment URL directly gets **404**, not 403.
- An attachment on a draft-only page is invisible to a VIEWER and visible to an EDITOR and to a
  super admin with no membership.
- Soft-deleting the page hides its attachments; restoring it brings them back.
- A video plays and **seeks**, with the seek issuing a 206.
- An SVG downloads rather than rendering; the response carries `nosniff`.
- A filename containing `"`, CRLF, `]` or `(` produces neither a broken header nor broken
  Markdown.
- `BLOB_STORE` unset refuses to boot; `memory` in production refuses without the override.
- The dev upload route 404s whenever the memory store is not selected.
- `npm run smoke` uploads, commits, reads, 404s a non-member and ranges — from a cold start,
  with no tenant credentials — and leaves the database at the counts it found.
- `npm run plan:check` reports 0 drifted.
