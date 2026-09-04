# Documentation platform — implementation roadmap

Spec: [`docs/superpowers/specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)

Seven phases. Each ends with software that runs, is tested, and is worth demoing. Each gets
its own plan document, written when its predecessor lands — planning phase 5 against a
codebase that does not exist yet produces a plan that gets rewritten.

| Phase | Deliverable | Spec sections | Depends on |
|---|---|---|---|
| **1. Foundations & reader** | Signed-in staff read seeded published docs: space nav, breadcrumbs, TOC, page info card. Forbidden spaces 404. | §5.1–5.2, §8, §11 (read routes), §12 | — |
| **2. Authoring** (plan: [phase-2](2026-08-23-docs-platform-phase-2-authoring.md)) | Editors create, draft, preview and publish pages in the browser. Conflict detection on concurrent drafts. Move and delete with redirects. | §5.3, §9, §14 | 1 |
| **3. Doc types & lifecycle** (plan: [phase-3](2026-08-24-docs-platform-phase-3-doc-types.md)) | ADR/RFC/runbook templates with validated frontmatter. Status vocabularies, typed relations, publish cascades, retired-document banner, generated indexes. | §6, §5.2 (`PageRelation`) | 2 |
| **4. Search & diagrams** (plan: [phase-4](2026-08-25-docs-platform-phase-4-search-diagrams.md)) | Postgres full-text search with space/type/status filters and snippets. Mermaid and C4 rendering. | §13, §12 (Mermaid) | 3 |
| **5. Git mirror** (plan: [phase-5](2026-08-26-docs-platform-phase-5-git-mirror.md)) | Publishing produces a real commit authored by the publisher. Retry queue, sha on the version, admin visibility of failures. | §10 | 2 (3 for frontmatter) |
| **6. Attachments & Entra ID** (plan: [phase-6](2026-08-26-docs-platform-phase-6-attachments.md)) | Editors attach files — screenshots, documents, screen recordings — stored in a company-owned SharePoint library over Microsoft Graph. Uploads bypass the app; downloads proxy through it, permission-checked. Identity moves to Entra ID. | [Phase 6 spec](../specs/2026-08-26-attachments-sharepoint-entra-design.md) | 2 |
| **7. Systems & admin** | Systems catalogue and facet filters. Space/member/system administration. Due-for-review workflow. | §7, §12 (review) | 3 |

**Phase 1 ends with a cold-start smoke test** (`npm run smoke`), not with the last feature.
It provisions, migrates, seeds, builds, serves and exercises the running app over HTTP —
the permission matrix, the nav depth, the draft marker, the alpha badge, and a bug report
POST — then tears down. Every later phase should extend it rather than replace it: it is
the one check that answers "does this work from nothing", which is the question asked
before a deploy and after every dependency bump.

## Ordering notes

- **Phase 1 is a walking skeleton, not a stub.** It carries the real schema, the real
  permission module and the real Markdown pipeline. Later phases add surface, not
  foundations.
- **The git mirror is deliberately late.** The spec makes git a mirror that is never on the
  critical path, so publishing works without it. Building it after authoring proves that
  property instead of asserting it.
- **Phase 3 before search** because search filters by doc type and status, which phase 3
  defines. Building search first means building it twice.
- **Systems & admin last** because the systems facet is only useful once there are documents
  to tag.
- **Attachments moved from 6 to 5, and the store changed with them.** They were roadmapped
  last on the reasoning that attachments are only useful once there is an editor to attach
  from — true, and that condition was met at the end of Phase 2. The trigger was a media
  upload need that could not be deferred; the company runs Microsoft 365 and has no object
  storage provisioned, so **D12's S3 backend became a SharePoint document library** and
  "S3 attachments via presigned URLs" left what is now Phase 7. See the
  [Phase 6 spec](../specs/2026-08-26-attachments-sharepoint-entra-design.md).

  **They have been renumbered twice, by one rule applied twice: the phase that reaches
  `main` first keeps its number.** Attachments were built as "Phase 4" in parallel with
  search, on a branch cut before search landed; search merged first, so attachments became
  5. Then the git mirror merged as its own Phase 5, so attachments became 6. Renumbering a
  shipped phase to accommodate an unmerged one rewrites closed exit criteria, which is why
  the movement is always in this direction.

- **Plan documents for Phases 1–5 call systems & admin "Phase 6", and they are not wrong so
  much as older than this table.** They were written while attachments were still the
  *other half* of that row — §17's S3 attachments and §7's systems catalogue in one phase.
  Splitting attachments out moved administration to 7. Those plans are closed, so their
  text is left as the record of what was believed when each was executed; this table is the
  current answer, and living code and specs have been updated to it.

## Phase 4 constraint: Mermaid hydration decodes what the sanitiser escaped

Phase 1's pipeline turns a ```mermaid fence into
`<div class="mermaid-source">…</div>` with the text HTML-escaped, so it is inert in the
document. Measured output for a hostile diagram label:

```
<div class="mermaid-source">graph TD\nA["&#x3C;/div>&#x3C;script>alert(1)&#x3C;/script>"]</div>
```

Phase 4 hydrates these by reading `textContent`, which **decodes the escaping** — Mermaid
receives the literal `</div><script>alert(1)</script>` as diagram source. Whether that
executes is then entirely Mermaid's decision, not ours.

So Phase 4 must set Mermaid's `securityLevel` explicitly (`"strict"`) and must not use
`innerHTML` to move the source around.

> **Correction, measured in Phase 4 Task 5 against `mermaid@11.17.2`.** Two claims in the
> sentence above were wrong, and the second one would have produced a **vacuous security test**.
>
> **`"strict"` is already Mermaid's default** — it is in `defaultConfig`, not `"loose"`. Pinning
> it explicitly is still exactly right, because a default is a dependency's decision and this one
> is load-bearing; but it is a *pin*, not a correction of an unsafe default.
>
> **And `securityLevel` does not decide whether a label is sanitised.** `sanitizeText` runs
> DOMPurify at every level, so a `<script>` in a diagram label is stripped under `"loose"` too —
> verified: the obvious hostile-label test **stays green** with the setting mutated to `"loose"`.
> What the levels actually disagree about is URL handling:
> `if (getConfig().securityLevel !== "loose") return sanitizeUrl(url)`. So the assertion that
> earns its keep is `click A href "javascript:…"`, not a script tag in a label.
>
> Nor is the click *handler* half of it: a listener is attached only by the `bindFunctions` that
> `mermaid.render` returns, and the hydration deliberately never calls it — an independent
> barrier, which therefore cannot die with this constant either. Treat the escaping in the document as protecting
the *document*, not as having sanitised the *diagram source*.

## Phase 2 landmine, measured during Phase 1

Phase 2's page move rewrites descendant `path` values. `Page_spaceId_path_key` is a bare
unique **index**, not a constraint, so `SET CONSTRAINTS ... DEFERRED` can never apply to
it — and Postgres checks it row by row *even within a single statement*. Confirmed by
probe:

- A one-statement **swap** of two sibling paths fails: `duplicate key value violates
  unique constraint "Page_spaceId_path_key"`.
- A one-statement **subtree prefix rewrite** commits cleanly, because the new path set
  shares a prefix no moving row currently holds, so it is disjoint from every unwritten
  old path.

So a subtree move is safe and a swap is not. Three rules for whoever builds it:

1. Do the descendant rewrite in **one statement**. Prisma's `updateMany` cannot use a
   column expression, so this is `$executeRaw`.
2. Reject a rename whose target path is already occupied **up front**, rather than
   attempting a two-phase shuffle.
3. Take a `pg_advisory_xact_lock` on the space id so concurrent moves in one space
   serialise, instead of deadlocking on arbitrary row-lock order.

Do **not** convert the index to a deferrable constraint pre-emptively: Prisma cannot
express `DEFERRABLE`, so it would be hand-written SQL that reads as permanent drift on
every `migrate dev`, and it is no cheaper to do now than then.

## Prisma 7 upgrade: two things already known

Prisma 7.x is available; the project stays on 6.19.3 deliberately (it typechecks clean
under TypeScript 7, and the upgrade is the change most likely to reintroduce that risk).
When it is done as its own task, two items are already on the list:

- `package.json#prisma` — the seed config key — is **deprecated and removed in Prisma 7**,
  replaced by `prisma.config.ts`. The seed currently warns about this on every test run.
- The `deepmerge-ts` advisory spans 6.13.0 through 7.10.0, so upgrading does not resolve
  it. Re-check whether `@prisma/config` has shipped a patched dependency by then.

## Conventions fixed in phase 1

These hold for every later phase. Changing one is a decision, not a detail.

- **npm**, TypeScript strict, Next.js App Router, React Server Components for reads.
- **Vitest** for unit and integration tests; **Playwright** for end-to-end.
- Integration tests run against a **real Postgres**, never a mock or SQLite. There is no
  container runtime on this machine, so that is the local Homebrew `postgresql@16` service
  on port 5432; the harness refuses to run unless `DATABASE_URL` names a database ending
  `_test`.
- Permission checks live in the **data-access layer** and compile to SQL, never a filter
  applied after fetching.
- Pure logic (permissions, tree building, lifecycle rules) lives in modules that take
  plain objects and import nothing from Prisma, so it is unit-testable without a database.
