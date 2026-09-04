# Attachments on SharePoint, and the Entra ID cutover — design

**Date:** 2026-08-26
**Status:** Approved for planning
**Supersedes:** D12 and the attachment half of the original Phase 6 in
[the platform spec](2026-08-21-internal-docs-platform-design.md)
**Becomes:** Phase 6 in [the roadmap](../plans/2026-08-21-docs-platform-roadmap.md)

## 1. Summary

Editors need to put files — screenshots above all, and screen recordings — into documents.
It was originally roadmapped as Phase 6, resting on S3-compatible object storage (D12).
The company runs Microsoft 365 and has no object storage provisioned, so the store becomes
a **SharePoint document library the platform owns**, reached over Microsoft Graph, and the
identity provider becomes **Entra ID**.

The two are deliberately decoupled. The app authenticates to Graph **as itself** using
client credentials, so no user token, no per-user consent and no refresh machinery is
involved. Entra ID SSO is then an unrelated configuration change that happens to land in
the same phase.

Uploads and downloads travel in opposite directions, which is the central decision:

- **Upload bypasses the application.** The app checks permission, mints a Graph resumable
  upload session, and hands the browser the session URL. A 400MB video never passes
  through Next.js.
- **Download goes through the application**, permission-checked against the same
  `visiblePage` / `readableSpace` predicates as any page read.

## 2. Goals

- An editor can paste, drag or pick a file in the editor and get a reference in the
  document.
- A reader sees an attachment if and only if they could read the page it belongs to.
- Uploading video does not make the application buffer video.
- The store being unreachable degrades an image, never a page.
- Local development, the integration suite and `npm run smoke` all run with no tenant
  credentials.

## 3. Non-goals

Image resizing, thumbnails or transcoding; a media browser or library UI; reusing one
attachment across pages; per-attachment permissions independent of the page; virus
scanning; rate limiting on upload or read; a durable job queue (§8); delegated Graph
access for anything, including profile photos (§4.3).

## 4. Identity: the Entra ID cutover

### 4.1 It is zero code change

[`src/lib/auth/config.ts`](../../../src/lib/auth/config.ts) registers a generic `oidc`
provider driven by `OIDC_ISSUER`. Entra ID is an OIDC issuer.

```
OIDC_ISSUER="https://login.microsoftonline.com/<tenant-id>/v2.0"
```

The **tenant-specific** issuer, never `common`. Auth.js validates `iss`, so this pins the
tenant without a separate `tid` claim check. The redirect URI is
`${AUTH_URL}/api/auth/callback/company`, fixed by the provider id `company`.

`ALLOWED_EMAIL_DOMAINS` remains the staff boundary and continues to fail closed. It also
gates B2B guests correctly, because a guest's `email` claim carries their home domain.

`isEmailVerified` in [`src/lib/users/gate.ts`](../../../src/lib/users/gate.ts) already
treats an **absent** claim as verified, with the reasoning written down. Entra ID emits no
`email_verified`, so that branch already covers this provider — it was written for exactly
this class of issuer.

### 4.2 The `email` claim is fixed at the app registration, not in code

Entra ID v2.0 does not reliably emit `email`. It emits `preferred_username`; `email`
arrives only when the directory has `mail` populated or the optional claim is configured
on the app registration. `isAllowedSignIn` returns false on a missing email and
`config.ts` does `profile!.email!`, so the failure mode is **"nobody can sign in"** —
loud, which is the intended direction.

A `preferred_username` fallback was considered and **rejected**. Microsoft documents that
claim as mutable and explicitly not an identifier, and `User.email` is `@unique` — the key
this application matches users on. A fallback would tie identity to a rotatable string,
and the row it hands over carries `isSuperAdmin`. So the optional `email` claim gets
configured on the registration and the gate is left exactly as it is.

### 4.3 One accepted regression: avatars

Entra ID sends no `picture` claim, so `avatarUrl` becomes null for everyone after the
cutover. `avatarUrl` is already nullable and the UI tolerates it.

Fetching `/me/photo/$value` would require **delegated** Graph tokens — per-user consent,
token persistence, refresh — which is the entire machinery this design avoids by
authenticating as the application. Reintroducing it for profile pictures is not a trade
worth making. Recorded as a known regression, not an oversight.

## 5. Storage

### 5.1 One library, owned by the platform, reached as the application

A single SharePoint document library. The app holds a client-credentials registration and
acquires an app-only token; the token is app-wide (there is no user in it), so one cached
token serves every request.

**The grant is `Sites.Selected`, not `Files.ReadWrite.All`.** This is the largest security
decision in the deployment and it is an operations one. `Files.ReadWrite.All` gives the
application every drive in the tenant, including every employee's personal OneDrive; a
leaked client secret would then be a tenant-wide breach. `Sites.Selected` plus a per-site
grant limits the blast radius to the one library. The plan carries the exact Graph call an
administrator runs to make the grant.

### 5.2 The drive key carries no filename and no page path

The key is `{hash(id)}/{attachmentId}.{ext}`, where the shard is two hex characters.

> **Amended twice, and the second amendment corrects the first.**
>
> This originally read `/{yyyy}/{mm}/{attachmentId}.{ext}`. Date sharding does not work:
> `id` and `createdAt` are both database defaults, so **neither is known before the row
> exists** and the key cannot be computed for the `create` that produces it. That forces
> either a second write — leaving a committed row with an empty `drivePath`, which the sweep
> would reclaim as garbage — or generating ids outside Prisma, breaking the `cuid()`
> convention every other model follows.
>
> It was then amended to `{id[0:2]}/…`, on the claim that a prefix shard "distributes more
> evenly than months do". **That claim was false, and the replacement was worse than what it
> replaced.** A Prisma `cuid()` is `"c" + Date.now().toString(36) + counter + fingerprint +
> random`: the first character is a literal `c`, and the second is the most significant
> base-36 digit of a millisecond timestamp, which turns over roughly once every two and a half
> years. Measured on twelve consecutively minted ids: **one** distinct value for the leading
> two characters against twelve for the trailing two. Every attachment for years would have
> landed in a single SharePoint folder — where `yyyy/mm` would at least have given twelve
> buckets a year.
>
> The shard is now **FNV-1a over the id, folded to 256 buckets**. Hashed rather than sliced
> from the tail, because the tail is random only by an accident of cuid v1's layout: a hash
> decorrelates the shard from whatever structure the id scheme carries, so this cannot quietly
> collapse again if that scheme changes. What is given up is human browsability of the
> library, which was date sharding's stated benefit; the library is not a browsing surface,
> and the sweep cursors on `createdAt` in Postgres, where the column actually lives.

**No filename in the path.** The original filename lives only in Postgres, for
`Content-Disposition`. Path traversal, Unicode normalisation and collisions therefore
cannot happen, rather than being defended against.

**No page path in the key.** Phase 2 built page moves, which rewrite descendant `path`
values in one statement under a space-wide advisory lock. Encoding the path would make
every move a cascading set of drive renames inside that transaction. The attachment id is
immutable, so the key is stable across any move.


### 5.3 The `BlobStore` seam survives D12

D12's interface is kept; only its implementation changes. That the seam survived a total
change of backend is reasonable evidence it was drawn in the right place.

The seam is **not** speculative generality here. This repository tests against a real
Postgres because mocks lie — but a real SharePoint tenant is not reproducible in CI or on
a laptop, and `npm run smoke` must run from nothing. An in-memory implementation is
therefore mandatory, and the interface is the seam those tests already need.

```
src/lib/blob/
  store.ts     BlobStore interface — begin session, stat, fetch range, delete
  graph.ts     SharePoint implementation over Microsoft Graph
  memory.ts    in-memory fake: tests, local development, and `npm run smoke`
  token.ts     client-credentials token, cached in memory by expiry
  select.ts    chooses implementation from env, refuses to guess
src/lib/attachments/
  policy.ts    pure: readability rule, mime allowlist, inline-vs-download. No Prisma.
  schema.ts    zod inputs, size caps
  repo.ts      Prisma. Owns every permission rule.
src/app/api/attachments/
  route.ts              POST  — check EDIT, mint upload session
  [id]/commit/route.ts  POST  — two-phase commit
  [id]/route.ts         GET, HEAD — the proxy;  DELETE — soft-delete
```

`policy.ts` imports nothing from Prisma, so the readability rule is unit-testable without
a database — the convention the roadmap fixed in Phase 1.

> **Added while writing the phase plan.** The memory implementation needs somewhere for the
> browser to `PUT` to, or the direct-upload path cannot be exercised at all and the goal above
> — that tests and `npm run smoke` run with no tenant credentials — is unreachable. So there
> is a `PUT /api/attachments/dev-upload/[token]` route, registered under exactly the
> `ALLOW_TEST_LOGIN` discipline: it refuses unless `BLOB_STORE=memory`, and a test asserts it
> 404s otherwise. Treat it with the same suspicion as the passwordless login — it is an
> unauthenticated write, and the only thing making that acceptable is that it cannot exist in
> a deployed process.

## 6. Data model

```prisma
enum AttachmentState { PENDING, COMMITTED }

model Attachment {
  id           String          @id @default(cuid())
  pageId       String
  driveItemId  String?         @unique
  drivePath    String
  filename     String
  mimeType     String
  sizeBytes    Int
  eTag         String?
  state        AttachmentState @default(PENDING)
  uploadedById String
  createdAt    DateTime        @default(now())
  deletedAt    DateTime?
  page         Page            @relation(fields: [pageId], references: [id], onDelete: Cascade)
  uploadedBy   User            @relation(fields: [uploadedById], references: [id])
  @@index([pageId])
}
```

**`state` exists because the browser uploads directly to Graph.** The application mints
the session and then never sees the bytes, so it cannot know the upload finished. A
`PENDING` row is never served and never listed. §7.2 flips it.

**`driveItemId` is nullable.** At session-mint time the item does not exist, so there is no
id to store. It is filled at commit, from a stat the application performs itself.

**`onDelete: Cascade`**, matching `Page`'s own relation to `Space`. Without it, hard-deleting
a space would be blocked by Prisma's `Restrict` default on a required relation. This is the
deliberate opposite of `BugReport`, which carries no foreign keys at all because its value
is highest once the page is gone — an attachment is worthless without its page.

**`sizeBytes` is `Int`**, which caps usable size below 2^31-1. `MAX_UPLOAD_BYTES` defaults
well under that (§9).

**No new `Action` in `can.ts`.** Attaching is editing, so it is `EDIT`. That switch is
exhaustive and security-critical, and it is where `READ` is already documented as the
module's one fail-open direction; a new arm is a change nobody needs to review.

**`Content-Type` is served from `mimeType` in Postgres, never from Graph's response.** The
mime is validated once against the allowlist at upload. Re-reading it from the store would
let whatever the store decided about a file govern how a browser interprets it.

## 7. The two paths

### 7.1 Upload — bypasses the application

`POST /api/attachments`, small JSON body `{ pageId, filename, mimeType, sizeBytes }`.

Guard order mirrors the drafts route, including rejecting a **missing** `Content-Length`
with 411 before parsing — `Number(null)` is 0, so a numeric-only cap waves an unbounded
body straight through. That reasoning is already written down in
[`src/app/api/drafts/[pageId]/route.ts`](<../../../src/app/api/drafts/[pageId]/route.ts>)
and is reused rather than restated.

1. `loadViewer()` → 401.
2. Zod: filename length, mime against the allowlist, `sizeBytes` within `MAX_UPLOAD_BYTES`.
3. `repo.beginUpload(viewer, input)` resolves the page under
   `visiblePage({ space: readableSpace(viewer) })` and returns a discriminated result,
   reusing the drafts repository's 404/403 split so the 404-not-403 line stays drawn in one
   place.
4. **Create the `Attachment` row, then mint the session.** The row id determines the drive
   key, so it must exist first. The useful consequence: a failed mint leaves the same
   `PENDING` garbage as a failed upload, so there is one cleanup path rather than two.
5. Return `{ attachmentId, uploadUrl, expiresAt }`.

**Always a resumable session, even for a 4KB PNG.** Graph offers a simple `PUT` for small
files, but that needs an app token and an app token must never reach a browser. A session
URL is pre-authenticated, so the browser holds no credential at all — one code path, and
the only capability the client ever gets is *write to this one drive item, for about
fifteen minutes*. It cannot read anything and cannot write anywhere else. That property is
what makes the asymmetry safe.

Chunks are 10MiB, an exact multiple of Graph's required 320KiB. The session exposes
`nextExpectedRanges`, so a dropped video upload resumes instead of restarting.

### 7.2 Commit

`POST /api/attachments/[id]/commit` re-checks EDIT — it does not trust the check from §7.1
step 3 — then stats the item **by the drive key the application itself derived**.

**The application never accepts a `driveItemId` from the client.** The browser receives
Graph's completion response and could report anything. Same principle as the bug-report
decision: page context is derived from `routePath`, never accepted from the client, because
a client-supplied id could name something the caller has no business naming.

If the real size disagrees with the declared one, the drive item is deleted and the row
marked deleted (400). If no item exists, the upload never completed (409). Otherwise the
row flips to `COMMITTED` with the size and eTag read back from Graph.

### 7.3 We never see the bytes, so we never sniff them

That is acceptable **only** because of the serve-time policy: `X-Content-Type-Options:
nosniff` plus a `Content-Type` drawn from the validated allowlist in Postgres. A file
declared `image/png` containing HTML is served as `image/png` with `nosniff`, and the
browser will not execute it. Without `nosniff` this asymmetry would be unsafe. Server-side
magic-byte sniffing is impossible by construction, since the bytes never pass through.

### 7.4 Read — goes through the application

`GET /api/attachments/[id]`, and `HEAD`, which video players probe with.

One query, permission compiled to SQL:

```ts
{
  deletedAt: null,
  state: "COMMITTED",
  page: visiblePage(
    { space: readableSpace(viewer) },
    { OR: [{ publishedVersionId: { not: null } }, { space: editableSpace(viewer) }] },
  ),
}
```

**The `OR` clause stops a draft leaking.** Without it, a VIEWER who guesses an id sees an
image referenced only in an unpublished draft — content the nav rail deliberately refuses
to link and `getPublishedPage` deliberately refuses to serve. An attachment is readable
when its page is published, or when the viewer could edit it.

**The two `space:` keys sit in different varargs of `visiblePage`, not in one object
literal.** In one object they would collide and one would vanish — the same failure mode
the never-spread rule exists to prevent.

#### `editableSpace`, and the super-admin trap it contains

`editableSpace` is a new sibling to `readableSpace` in
[`src/lib/authz/where.ts`](../../../src/lib/authz/where.ts). The naïve composition is
**wrong**:

```ts
// WRONG: silently denies a super admin.
readableSpace(viewer, { memberships: { some: { userId, role: { in: ["EDITOR", "ADMIN"] } } } })
```

`readableSpaceWhere` returns `{}` for a super admin, so the composed clause still demands a
membership row they do not have. `editableSpace` must make the same `isSuperAdmin`
short-circuit that `can()` makes, or the two mechanisms disagree — which is precisely the
hazard `can.ts` already warns about for a future non-reading role.

It gets the same never-spread docstring as its sibling. Per "two sources of truth for
membership, deliberately", its tests need **real** `SpaceMembership` rows: a synthetic
viewer with a self-declared membership passes `can()` while reading nothing.

#### Response

- **Range passthrough.** Forward `Range` to Graph, return 206 with `Content-Range`,
  advertise `Accept-Ranges: bytes`. Without it, seeking in a video re-downloads from zero.
- **Stream, never buffer.** The Graph body is returned as a `ReadableStream`. Buffering a
  512MB video is 512MB of heap per concurrent viewer.
- `Cache-Control: private, max-age=31536000, immutable`, `ETag` from Graph, `Vary: Cookie`.

`immutable` is honest because bytes never change for an id — a replacement is a new
attachment. **`private` is load-bearing:** `public` would let a shared corporate proxy
cache a members-only screenshot and hand it to someone with no membership.

**The cost, stated rather than discovered:** revocation applies to new fetches, not to
bytes already in a browser cache. Someone removed from a space keeps whatever they cached
until eviction. This is identical to presigned-URL behaviour and is accepted, but it is
written down here so it is a decision rather than a surprise.

### 7.5 Serving policy, and the sanitiser widening

Inline: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `video/mp4`,
`video/webm`. Everything else gets `Content-Disposition: attachment`.

**`image/svg+xml` and `text/html` are never inline.** An inline SVG is script execution
against our own origin, which is strictly worse than the same file hosted anywhere else.

**Inline video does NOT widen the sanitiser.**

> **Amended while writing the phase plan.** This section first proposed adding `<video>` to
> the sanitiser schema with a `src` allowlist. Measured against the shipped pipeline that is
> **ineffective**: [`src/lib/markdown/render.ts`](../../../src/lib/markdown/render.ts) sets
> `remarkRehype`'s `allowDangerousHtml: false`, so raw HTML is dropped *before* the sanitiser
> runs. The only way to make the schema matter — enabling raw HTML and adding `rehype-raw` —
> exposes the entire raw-HTML surface of every existing document to the sanitiser, which is a
> far larger posture change than one element justifies.

Instead, a rehype plugin runs **after** sanitisation and constructs the element itself,
exactly as `extractMermaid` already does for diagrams. The editor inserts
`![alt](/api/attachments/<id>/video)`; the plugin rewrites any `<img>` whose `src` matches
`^/api/attachments/([a-z0-9]+)/video$` into a `<video>` built from the **captured id**.

This is strictly safer than the allowlist first proposed. The `src` is not *validated*, it is
*reconstructed* from a regex capture, so an off-origin video is impossible by construction
rather than by allowlist — and the sanitiser is not touched at all, so `img` and every other
element keep exactly the posture they have today.

## 8. Deletion and retention

`DELETE /api/attachments/[id]` requires EDIT and sets `deletedAt`. Bytes remain; the read
predicate's `deletedAt: null` makes it 404 at once.

**One property comes for free.** Because the read predicate nests `visiblePage(...)` on the
page, soft-deleting a page makes its attachments unreadable, and restoring the page
restores them. Phase 2's existing delete/restore drives it with no new code. Because the
property is *emergent from the nesting*, it gets an explicit test — flatten the predicate
and it breaks silently, which is the same class of failure the never-spread rule guards.

**Retention is a script, not a queue.** `scripts/sweep-attachments.mjs`, idempotent like
`setup-db.sh`:

- `PENDING` rows older than 24h — abandoned uploads. Delete the drive item if present,
  hard-delete the row.
- Soft-deleted rows older than `ATTACHMENT_RETENTION_DAYS`. Delete the item, hard-delete
  the row.
- **Drive items with no row** — the reverse orphan, from a crash between mint and commit,
  or from a cascade. **Reported by default, deleted only under `--delete-orphans`.** A
  sweep bug that reports is a nuisance; one that deletes is data loss.

There is no job runner, so this runs by hand or by cron until the git-mirror phase builds the retry
queue it owes the git mirror. Building one now means building it against requirements that
do not exist yet, which the roadmap already warns about.

**Security does not depend on the sweep.** Readability is governed by the row's `deletedAt`
and `state`, so bytes lingering in a private library the application owns are a retention
matter, not a hole.

## 9. Configuration

```
GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET
GRAPH_DRIVE_ID              # the one target document library
BLOB_STORE                  # "graph" | "memory" — NO DEFAULT; boot fails if unset
MAX_UPLOAD_BYTES            # default 536870912 (512MB); must stay under 2^31-1
ATTACHMENT_RETENTION_DAYS   # default 30
```

**`BLOB_STORE` deliberately has no default.** Defaulting to `memory` would let a deployment
accept uploads and lose them on restart; defaulting to `graph` would break every laptop and
the smoke test. Refusing to boot is the loud failure — the same reasoning
`ALLOWED_EMAIL_DOMAINS` uses when it denies everyone on empty. `select.ts` additionally
refuses `memory` under `NODE_ENV=production` without an explicit override, mirroring the
`ALLOW_TEST_LOGIN` discipline.

`OIDC_ISSUER` changes value (§4.1). No new auth variables.

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Mime not on the allowlist | 415 before any session is minted, allowed list in the message |
| Declared size over cap | 413 before any session is minted, cap stated |
| Missing `Content-Length` on the JSON body | 411, ahead of parsing |
| Page not readable | 404, byte-identical to an id that never existed |
| Readable but not editable | 403 |
| Graph unreachable at session mint | 503, retryable; the `PENDING` row is swept. Draft text is unaffected and already saved |
| Session expires mid-upload | Browser resumes from `nextExpectedRanges`; failing that the 24h sweep reclaims, and the editor offers retry |
| Commit finds a size mismatch | 400; drive item deleted, row marked deleted |
| Commit finds no item | 409 — the upload never finished |
| **Graph unreachable on read** | **502 for the image; the page still renders.** A broken image, never a 500 |
| Attachment or its page deleted | 404 |
| Unsatisfiable `Range` | 416 |

That bolded row is the same principle the platform spec applies to the git mirror:
the remote store is never on the critical path for reading a document.

## 11. Testing

- **`policy.ts`** unit: allowlist, inline-vs-attachment, `Content-Disposition` filename
  encoding for non-ASCII names.
- **`editableSpace`** unit *and* integration against real `SpaceMembership` rows, including
  the super-admin case the naïve composition regresses silently.
- **Readability matrix** against Postgres: {non-member, VIEWER, EDITOR, ADMIN, super admin}
  × {published, draft-only} × {live, attachment-deleted, page-deleted}.
- **The emergent property gets its own test**: soft-delete the page, assert its attachments
  404.
- **`repo.ts` registered in
  [`visible.test.ts`](../../../src/lib/pages/visible.test.ts).** Note *which* shape it is:
  reading an attachment reaches a `Page` row **only through a relation filter**, naming no
  `page` delegate. That is widening #4 in that file's docstring — the case that was
  invisible to both halves of the sweep. This module is what that widening was for.
- **Sanitiser**: `<video>` with an off-origin `src` is stripped; with
  `/api/attachments/<id>` it survives; SVG is never inline; the default-schema pin still
  holds everywhere else.
- **Two-phase commit**: size mismatch rejected, missing item 409s, `PENDING` never served.
- **Range**: 206 with a correct `Content-Range`; 416 on nonsense.
- **Playwright**: paste an image, publish, read it back as another user; a non-member gets
  404 on the attachment URL.
- **Smoke** extends with upload → commit → read → non-member-404 against the memory store,
  per the roadmap's rule that every phase extends the cold-start check rather than
  replacing it.

## 12. Roadmap consequences

This becomes **Phase 6**, after the git mirror, and systems/admin shifts to 7.

**Renumbered twice, by one rule applied twice: the phase that reaches `main` first keeps its
number.** Planned and built as Phase 4, in parallel with search on a branch cut before it
landed; search merged first, so this became 5. Then the git mirror merged as its own Phase 5,
so this became 6. Both times the alternative was renumbering a phase whose plan, commits and
closed exit criteria were already written, which is the wrong direction. This branch's commit
messages therefore say "Phase 5 Task N", and its earliest ones say Phase 4.

Superseded rather than deleted, with the reason recorded in place:

- **D12** — "S3-compatible object storage for attachments from day one". The rationale
  (keep the container stateless; a mounted volume breaks past one replica) still holds and
  is still satisfied: a SharePoint library is remote state, not container state. Only the
  backend changes.
- **The original Phase 6's "S3 attachments via presigned URLs"** line in the roadmap.
- **§17's configuration paragraph** in the platform spec, rewritten for §9 above.

The `BlobStore` interface D12 argued for survives intact.

## 13. Task shape

Roughly fourteen tasks, detailed in the phase plan: Entra ID cutover (documentation and
`.env.example` only); schema and migration; `editableSpace`; `BlobStore` interface plus the
memory implementation and the `select.ts` boot guard; the Graph implementation and token
cache; `policy.ts` and `schema.ts`; `repo.ts` with its `visible.test.ts` registration;
upload and commit routes; the read proxy with Range; the sanitiser widening; editor
affordances (paste, drag, pick, progress, reference insertion); delete route and sweep
script; Playwright end-to-end; smoke extension.
