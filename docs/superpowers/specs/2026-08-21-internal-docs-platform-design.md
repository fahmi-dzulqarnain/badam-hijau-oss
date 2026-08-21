# Internal documentation platform — design

**Date:** 2026-08-21
**Status:** Approved for planning
**Working name:** Badam
**Release posture:** Alpha (see §18)

## 1. Summary

An internal documentation platform for the company. Postgres is the live store; git is
the published audit trail. Readers get server-rendered pages with space navigation,
breadcrumbs and a per-page table of contents. Editors write Markdown in the browser with
live preview, drafts save continuously, and publishing writes an immutable version row
and a git commit in the same action.

Content is organised into **spaces** (Engineering, HR, Sales). A space is the permission
boundary and holds a nested page tree. Deployable systems (Store iOS, Display, Hub, backend)
are a **facet** applied across spaces, not folders.

Reference for information architecture and reading experience:
`https://pistacy.io/doc/user-manual/getting-started.html`.

## 2. Goals

- One place to find engineering, operational and company documentation, searchable.
- Architecture decisions (ADR) and proposals (RFC) as first-class documents with a
  real lifecycle, not prose conventions.
- Non-technical staff can write and publish without touching a repo.
- Documentation stays readable and portable if the application is retired.
- Stale documentation is visible rather than silently wrong.

## 3. Non-goals for v1

Comments and inline discussion; approval or review workflows before publish; real-time
collaborative editing; notifications and subscriptions; public or customer-facing
sharing; usage analytics; WYSIWYG rich-text editing; internationalisation; product
version selectors (v1/v2 docs); AI-assisted search or generation.

All are additive later. None is required for the system to be useful.

## 4. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | Markdown authoring with in-browser editing | Non-technical staff must not need a repo checkout; Markdown keeps content portable |
| D2 | Drafts in Postgres, git commit on publish | Fast saves without merge conflicts; git gives immutable history and provenance |
| D3 | SSO via generic OIDC, per-space read/edit permissions | Matches how the company is organised; avoids a per-page ACL model |
| D4 | Next.js + TypeScript + Postgres + Prisma | Team already writes TypeScript; relational storage suits permission and search queries |
| D5 | v1 includes search, Mermaid/C4 diagrams, ADR/RFC/runbook templates | These are the reasons the system gets adopted rather than bypassed |
| D6 | Space landing pages | A space opens on a map of modules, not page one of a manual |
| D7 | Page info card in the reader rail | Surfaces owner and review age, which is what makes staleness actionable |
| D8 | Document lifecycle modelled as typed relations between pages | An RFC closes into an ADR; an ADR is superseded by an ADR. Both sides must never drift |
| D9 | Systems are a facet, not a folder | A single ADR can legitimately affect Hub, kiosk and POS |
| D10 | One draft per page with optimistic concurrency | Conflict detection is sufficient; co-editing is not worth the complexity in v1 |
| D11 | Postgres full-text search | Adequate to a few thousand pages; no second datastore to operate |
| D12 | S3-compatible object storage for attachments from day one | Keeps the container stateless; a mounted volume breaks the moment there is more than one replica |
| D13 | Ship as an alpha, with in-product bug reporting from day one | Early users will hit rough edges; the cost of a bug going unreported is higher than the cost of the button |

## 5. Domain model

### 5.1 Entities

- **User** — identity from OIDC. `email`, `name`, `avatarUrl`, `isSuperAdmin`.
- **Space** — permission and ownership boundary. `key` (URL segment, e.g. `engineering`),
  `name`, `description`, `initials`, `visibility`.
- **SpaceMembership** — `(spaceId, userId, role)` where role is `VIEWER | EDITOR | ADMIN`.
- **Page** — a node in a space's tree. Carries current published state.
- **PageDraft** — exactly one per page. The live editing buffer.
- **PageVersion** — immutable published snapshot. Carries the git sha once mirrored.
- **PageRelation** — typed directed edge between pages.
- **System** — a deployable or library. Facet applied to pages.
- **PageSystem** — join between Page and System.
- **Template** — seeded document template per doc type.
- **Attachment** — uploaded file belonging to a page. `blobKey`, `filename`, `mimeType`,
  `sizeBytes`, `uploadedById`.
- **Redirect** — old path to page, created when a page moves.
- **AuditLog** — actor, action, target, metadata.
- **GitJob** — queued mirror work with retry state.
- **BugReport** — an in-product bug report with its captured context (§18.2).

### 5.2 Prisma sketch

Illustrative, not final. Field names are normative; indexes and relation scalars are for
the implementer to complete.

```prisma
enum SpaceVisibility { MEMBERS ALL_STAFF }
enum SpaceRole       { VIEWER EDITOR ADMIN }
enum DocType         { DOC ADR RFC RUNBOOK }

enum DocStatus {
  DRAFT IN_REVIEW PROPOSED ACCEPTED CLOSED
  SUPERSEDED DEPRECATED REJECTED WITHDRAWN
  CURRENT NEEDS_REVIEW ARCHIVED
}

enum RelationType { SUPERSEDES DECIDES AMENDS RELATES_TO }
enum SystemKind   { MOBILE_APP DEVICE_APP SERVICE LIBRARY }
enum GitJobState  { PENDING RUNNING FAILED DONE }

model Page {
  id                 String     @id @default(cuid())
  spaceId            String
  parentId           String?
  slug               String
  path               String      // materialised, e.g. "decisions/adr-0042-mqtt-topic-naming"
  title              String
  docType            DocType     @default(DOC)
  status             DocStatus   @default(DRAFT)
  position           Int         @default(0)
  ownerId            String?     // team lead or author responsible for review
  reviewedAt         DateTime?
  publishedVersionId String?     @unique
  publishedAt        DateTime?
  createdById        String
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt

  @@unique([spaceId, path])
  @@unique([spaceId, parentId, slug])
  @@index([spaceId, status])
}

model PageVersion {
  id           String   @id @default(cuid())
  pageId       String
  title        String
  markdown     String
  frontmatter  Json
  status        DocStatus
  authorId     String
  message      String?
  gitSha       String?
  createdAt    DateTime @default(now())

  @@index([pageId, createdAt])
}

model PageDraft {
  pageId        String   @id
  title         String
  markdown      String
  frontmatter   Json
  baseVersionId String?
  updatedById   String
  updatedAt     DateTime @updatedAt
}

model PageRelation {
  id        String       @id @default(cuid())
  fromId    String
  toId      String
  type      RelationType
  createdAt DateTime     @default(now())

  @@unique([fromId, toId, type])
  @@index([toId, type])
}

model System {
  id           String     @id @default(cuid())
  key          String     @unique   // "store-ios", "order-hub", "display-ios"
  name         String
  kind         SystemKind
  description  String?
  repoUrl      String?
  ownerTeam    String?
  isActive     Boolean    @default(true)
}
```

### 5.3 Paths and moves

`Page.path` is materialised and unique per space. Moving a page rewrites the paths of all
descendants in one transaction and writes a `Redirect` row for every old path. Reads
resolve a miss against `Redirect` before returning 404, so links and bookmarks survive
reorganisation.

Route segments beginning `-` are reserved for application routes and rejected as slugs.

## 6. Document lifecycle

### 6.1 Status vocabulary per doc type

Vocabulary and legal transitions live in code (`lib/lifecycle/vocab.ts`), not in the
editable template body, and are enforced on publish.

| Doc type | States |
|---|---|
| `ADR` | `PROPOSED` → `ACCEPTED` → `SUPERSEDED` / `DEPRECATED`; or `REJECTED` |
| `RFC` | `DRAFT` → `IN_REVIEW` → `ACCEPTED` → `CLOSED`; or `WITHDRAWN` / `REJECTED` |
| `RUNBOOK`, `DOC` | `CURRENT` → `NEEDS_REVIEW` → `ARCHIVED` |

A page that has never been published sits at `DRAFT` whatever its doc type. The first
publish must move it into that type's vocabulary — an ADR to `PROPOSED` or `ACCEPTED`, a
runbook to `CURRENT`. `DRAFT` is therefore legal as an origin state for every type and as
a destination for none.

### 6.2 Relations

Relations are stored **one direction only** and the inverse is derived at read time, so
the two sides can never disagree.

| Type | Meaning | Inverse shown as |
|---|---|---|
| `SUPERSEDES` | ADR A replaces ADR B | "Superseded by A" |
| `DECIDES` | ADR A settles RFC R | "Decided by A" |
| `AMENDS` | A modifies part of B without replacing it | "Amended by A" |
| `RELATES_TO` | Non-directional reference | "Related" |

### 6.3 Cascade on publish

Publishing a page applies the declared relations and their consequences in the same
transaction as the version write:

- `supersedes: ADR-0031` → creates the relation and sets ADR-0031 `status = SUPERSEDED`.
- `decides: RFC-0004` → creates the relation and sets RFC-0004 `status = CLOSED`.

One action, both sides. Status is never maintained by hand in two places.

Guardrails: a page cannot supersede itself; cycle detection rejects a supersede chain
that loops; `SUPERSEDES` is only legal between two pages of the same doc type; `DECIDES`
is only legal from `ADR` to `RFC`; the source page must reach `ACCEPTED` for a cascade to
fire, so a draft cannot retire a live decision.

### 6.4 Reading a retired document

A page whose status is `SUPERSEDED`, `DEPRECATED`, `CLOSED`, `WITHDRAWN`, `REJECTED` or
`ARCHIVED` renders a banner above the body naming the replacement and the date it stopped
being in force. The body stays fully readable as history. It remains editable by editors
so it can be annotated, and it is demoted in search ranking (see §13) rather than hidden.

## 7. Systems facet

Systems are global, not owned by a space, and carry no permissions of their own. Pages
declare `systems: [order-hub, kiosk-bridge, store-ios]` in frontmatter.

Each system gets a generated page at `/systems/[key]` showing its metadata (kind, owning
team, repo, active or sunsetting) and auto-listed documentation grouped by doc type: ADRs
affecting it, its runbooks, open RFCs. This doubles as a lightweight service catalogue
and as the inventory behind C4 container diagrams.

Spaces and systems are deliberately separate axes. A space per deployable would duplicate
memberships across a dozen spaces and force every cross-system ADR into an arbitrary home.

Seeded systems: `store-ios`, `display-ios`, `order-hub`, `pricing-engine`, `backend`,
`kiosk-bridge`, `admin-web`. Admins manage the list.

## 8. Permissions

`Space.visibility` is `ALL_STAFF` (any signed-in user may read) or `MEMBERS`
(membership required). Editing always requires an `EDITOR` or `ADMIN` membership.

Two pure functions in `lib/authz`, unit-tested with no database types in their signatures:

- `readableSpaceIds(user): string[]`
- `can(user, space, action): boolean` for `READ | EDIT | PUBLISH | MANAGE_SPACE`

Enforcement rules:

- Checks live in the data-access layer, not in components, so no route can forget one.
- Search and every listing filter by `spaceId IN readableSpaceIds(user)` in the query
  itself, never after fetching.
- A space or page the user cannot read returns **404, not 403**, so titles do not leak
  through status codes.
- `isSuperAdmin` grants `MANAGE_SPACE` everywhere. When a super-admin reads a
  `MEMBERS` space they are not a member of, that access is written to `AuditLog`.
- Editors publish directly. There is no approval gate in v1 (see non-goals).

## 9. Editing and drafts

One `PageDraft` per page. The editor autosaves on a 2 second debounce.

Concurrency: every save sends the `updatedAt` it last saw. A mismatch returns HTTP 409
with the other editor's name, their timestamp, and both texts. The editor shows a conflict
banner offering "keep mine" or "load theirs". A save is never silently discarded and never
silently overwrites.

Publishing validates frontmatter against the template's schema (zod) and the status
transition against the lifecycle vocabulary before anything is written.

Publish transaction, all or nothing:

1. Validate frontmatter and status transition.
2. Insert `PageVersion`.
3. Update `Page` (title, status, `publishedVersionId`, `publishedAt`) and its
   `PageSystem` rows.
4. Upsert declared `PageRelation` rows.
5. Apply lifecycle cascades (§6.3).
6. Refresh the search vector.
7. Write `AuditLog`.
8. Enqueue a `GitJob`.

Steps 1–7 are one Prisma transaction. Step 8 is committed with it and processed
asynchronously.

## 10. Git mirror

A worker drains `GitJob`, writing `content/<space-key>/<path>.md` with YAML frontmatter,
committing with the publishing user as author and pushing to the configured remote. It
runs against a local clone; the remote is optional, so the system works with GitHub,
GitLab or a self-hosted host without code changes.

**Git is a mirror and never on the critical path.** If the push fails, the publish has
already succeeded; the version keeps `gitSha = null`, the job retries with backoff, and
persistent failures surface on an admin page rather than only in logs. Documentation does
not go down because a git host does.

The reader surfaces the published commit sha on the page and links to version history, so
provenance is visible and a broken mirror is noticed.

## 11. Routes

| Route | Purpose |
|---|---|
| `/` | Home: readable spaces, recent activity across them |
| `/[space]` | Space landing: modules, recently published, due for review |
| `/[space]/[...path]` | Page reader |
| `/[space]/-/adrs`, `/-/rfcs` | Generated indexes, filterable by status |
| `/systems`, `/systems/[key]` | System catalogue and per-system documentation |
| `/search?q=` | Search results |
| `/edit/[pageId]`, `/new` | Editor |
| `/admin/spaces`, `/admin/systems`, `/admin/git`, `/admin/bugs` | Administration |

## 12. Reading and content pipeline

`remark-parse` → `remark-gfm` → `remark-frontmatter` → `rehype-slug` →
`rehype-autolink-headings` → `rehype-sanitize` → `rehype-shiki`.

Headings are extracted server-side into the table of contents. Fenced ` ```mermaid `
blocks are rendered client-side, which covers `C4Context` and `C4Container` diagrams.
Internal links are resolved against page paths at publish time; broken links are reported
as warnings and do not block publishing.

Rendered HTML for the published version is cached and invalidated on publish.

Reader layout, as approved in the mockup: sticky top bar with search; left rail with space
switcher and collapsible page tree showing draft chips; centre column at roughly a
66-character measure; right rail with table of contents and page info card (owner, last
reviewed, template, lifecycle, link to version history). Tables, code blocks and diagrams
scroll inside their own containers so the page never scrolls sideways.

Space landing, as approved: space header with page and editor counts, a module grid, a
recently-published list, and a "due for review" list of pages whose owner has not
confirmed them within the review interval (default twelve months, configurable per
deployment). Confirming a review updates `reviewedAt` without creating a version.

## 13. Search

Postgres full-text search. A `tsvector` column on `Page` is derived from the page's
**published** version — title, headings, and body text stripped of Markdown syntax —
weighted `A`, `B` and `C` respectively. It is maintained by a trigger created in a raw SQL
migration, so an unpublished draft never appears in results. Queries use `websearch_to_tsquery` and `ts_headline` for snippets, always filtered
by readable space ids. Filters: space, doc type, status, system. Retired documents (§6.4) stay in
results but are demoted in ranking; the status filter isolates or excludes them.

This is adequate to a few thousand pages. Search lives behind `lib/search` with a narrow
interface so it can be replaced without touching callers.

## 14. Error handling

| Situation | Behaviour |
|---|---|
| Not signed in | Redirect to the OIDC provider |
| No read permission | 404 with the standard not-found page |
| Draft save conflict | 409, conflict banner, keep mine / load theirs |
| Invalid frontmatter or illegal transition | Publish rejected, field-level messages in the editor |
| Git push failure | Publish stands, `gitSha = null`, retry with backoff, admin visibility |
| Malformed Mermaid block | Renders as a code block with an inline error, rest of page unaffected |
| Attachment too large or wrong type | Rejected before a presigned URL is issued, with the limit stated in the message |
| Object storage unreachable | Upload fails with a retryable message; page text is unaffected and already saved |
| Bug webhook unreachable | Report is already stored; forwarding retries in the background and the reporter sees success |
| Page moved | Old path resolves via `Redirect`, 301 to the new path |

## 15. Testing

- **Unit (Vitest):** `can()` and `readableSpaceIds()` across visibility and role
  combinations; lifecycle transition and cascade rules including self-supersede and cycle
  rejection; Markdown pipeline (sanitisation of hostile HTML, TOC extraction, Mermaid
  passthrough); path, slug and move logic including descendant rewrite and redirect
  creation.
- **Integration (real Postgres):** the publish transaction end to end — version row,
  cascade applied to the superseded page, search vector refreshed, git job enqueued;
  rollback leaves no partial state; draft conflict returns 409; search returns only
  readable spaces.
- **Git publisher:** against a temporary local bare repository. Real commits, no network.
  Includes a forced push failure asserting the publish still stands and the job retries.
- **E2E (Playwright):** a viewer reads a page and receives 404 on a forbidden space; an
  editor drafts, previews and publishes, and the superseded ADR then shows its banner.
- **Seed script** with the Engineering space, ADR/RFC/runbook examples and the system
  catalogue, so the application is explorable on first run and E2E has fixtures.

## 16. Project structure

```
src/
  app/
    (reader)/[space]/page.tsx            # space landing
    (reader)/[space]/[...path]/page.tsx  # page reader
    (reader)/systems/[key]/page.tsx
    (editor)/edit/[pageId]/page.tsx
    admin/…
    api/…
  lib/
    auth/          # OIDC provider config, session
    authz/         # can(), readableSpaceIds() — pure
    pages/         # service + repository
    lifecycle/     # vocabulary, transitions, cascades
    markdown/      # render, toc, sanitize
    search/
    systems/
    git/           # publisher, job queue
    templates/
    blob/          # BlobStore interface + S3 implementation, presigning
    bugs/          # report capture, context collection, webhook forwarding
    version/       # app version + git sha, read once at startup
  components/      # nav tree, toc, page info, editor, diagram
prisma/
  schema.prisma
  migrations/      # includes raw SQL for the tsvector trigger
content/           # git mirror working tree
```

Files stay focused: routes are thin and delegate to `lib`; permission checks sit in the
data-access layer; each `lib` module exposes a small interface and is testable alone.

## 17. Deployment and configuration

A single Docker image, Postgres, and S3-compatible object storage. Migrations run on
deploy.

**Attachments go to object storage from day one** — no mounted volume, so the application
container stays stateless and horizontal scaling does not break uploads. Access is behind
a `BlobStore` interface with an S3 implementation (AWS S3, or MinIO where the company
self-hosts). Uploads and downloads use presigned URLs so file bytes never pass through the
application; the bucket itself stays private. `Attachment.blobKey` is the object key, and
delete-on-page-delete is a queued job rather than a synchronous call, on the same
"never block the user on a remote store" principle as the git mirror.

Configuration by environment variable: database URL, OIDC issuer / client id / client
secret, session secret, git remote URL and credentials, git author fallback, S3 endpoint /
region / bucket / access key / secret key, presigned URL lifetime, maximum upload size,
review interval in months, `GIT_SHA` build argument, and optional `BUG_WEBHOOK_URL`.

The git working tree remains local to the container and is re-cloned on start, so it is
also not durable state.

## 18. Alpha posture and bug reporting

The first release is labelled **alpha** in the product, not only in a changelog. Readers
should know they are on early software, and reporting a problem must be cheaper than
tolerating it.

### 18.1 Version surfacing

- The brand block in the top bar carries an **Alpha** chip.
- The foot of the left rail shows the build as `0.<minor>.<patch>+<short-sha>`, read from
  `package.json` and the `GIT_SHA` build argument. This is the string bug reports quote,
  so it must be present in every environment including local development.

### 18.2 Report a bug

A **Report bug** button is pinned to the **bottom of the left navigation rail**, present on
every reader and editor route so it is reachable from wherever the problem was seen.

Clicking it opens a modal with two fields: "What happened?" (required) and "What did you
expect?" (optional). Everything else is captured automatically, because a reporter who has
to gather context reports less:

route path, space key, page id, published version id, reporter id, app version and git
sha, viewport size, user agent, and the most recent client-side console error if one
occurred in the session.

Reports are written to a `BugReport` row with status `NEW | TRIAGED | CLOSED`, listed for
admins at `/admin/bugs`. If `BUG_WEBHOOK_URL` is configured, forwarding to Slack, Jira or
Teams happens as a **queued job**, never inline — the same rule as the git mirror. A
reporter is never blocked, and never shown a failure, because an outbound integration is
down.

This is a signal channel, not a support system: no threading, no replies, no
notifications in alpha. Those are non-goals (§3).

```prisma
enum BugStatus { NEW TRIAGED CLOSED }

model BugReport {
  id           String    @id @default(cuid())
  reporterId   String
  summary      String                    // "What happened?"
  expected     String?                   // "What did you expect?"
  routePath    String
  spaceId      String?
  pageId       String?
  versionId    String?
  appVersion   String
  gitSha       String?
  userAgent    String
  viewport     String                    // "1440x900"
  consoleError String?
  status       BugStatus @default(NEW)
  createdAt    DateTime  @default(now())

  @@index([status, createdAt])
}
```

### 18.3 What alpha does not excuse

Permission checks, the publish transaction and lifecycle cascades are correctness, not
polish. Alpha means unfinished surface and missing features — it does not mean a document
can leak across a space boundary or a decision can silently stay live after being
superseded.

## 19. Assumptions

- The OIDC provider is configured at deploy time; Google Workspace and Microsoft Entra
  both work through the generic provider without code changes.
- A git remote is available but optional; the system runs with a local repository only.
- Scale target is a few thousand pages and low hundreds of staff.
- Content is English; no internationalisation in v1.
- Publishing rights are granted by space membership; no approval workflow is expected.
