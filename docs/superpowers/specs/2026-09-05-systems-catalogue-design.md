# Systems catalogue — design

**Status:** approved, 2026-09-05
**Supersedes:** §11's `/systems` address, and the single "Systems, attachments, admin" roadmap row
**Becomes:** Phase 7 in [the roadmap](../plans/2026-08-21-docs-platform-roadmap.md)
**Platform spec:** [§7 Systems facet](2026-08-21-internal-docs-platform-design.md), §5.1–5.2, §11, §13

## 1. What this phase is

A page declares the deployables it concerns — `systems: [order-hub, store-ios]` in frontmatter —
and that declaration becomes queryable: a catalogue at `/-/systems`, a page per system listing
the documentation that affects it, and the `system` filter §13 has always specified and search
has deliberately never offered.

`System` and `PageSystem` are the last two entities in §5.1 with no table. Everything else this
phase builds is a read surface over them.

## 2. Why it is first of the three, and what the other two are

The roadmap row "Systems, attachments, admin" has already lost attachments to Phase 6. What was
left is three products, not one: a catalogue, an administration area, and a review workflow.
Sized against this project's own history — phases have run 7 to 20 tasks — the row is 35 or
more. A plan that long is written whole before any of it runs, which `PROGRESS.md` already
identifies as the origin of most of Phase 6's defects.

So it splits:

| Phase | Scope |
|---|---|
| **7 — Systems catalogue** | This document. `System`, `PageSystem`, the facet, `/-/systems`, the `system` search filter. |
| **8 — Administration** | `/admin/spaces`, `/admin/systems`, `/admin/bugs`; folds in `/-/mirror` and `/{space}/-/deleted`; `GitJob` and `AuditLog` retention. The space-key validator §5.3 wants. |
| **9 — Review workflow** | Review interval, the confirm action on `reviewedAt`, the due-for-review list, the module grid, §18.2's bug webhook forwarding. |

Catalogue first because `System` and `PageSystem` are the last missing **models** — Phases 8 and
9 are surfaces over tables that already exist. It also closes a gap that is visible in the
product today: the `system` filter is absent-by-design in `src/lib/search/params.ts`,
`src/lib/search/query.ts` and the search route, each carrying a comment saying Phase 7 owns it.

Retention lands in 8 rather than here because the code already says so — `prisma/schema.prisma`
and the git-mirror plan both place it "with the rest of `/admin`".

## 3. Decisions taken

| # | Decision | Why |
|---|---|---|
| S1 | An unknown system key **refuses the publish** | Every other invalid frontmatter value already refuses. A catalogue anyone can extend by typo is not an inventory, and §7's second purpose is to be the inventory behind C4 container diagrams. |
| S2 | The catalogue is a **table**, seeded by a **data migration** | §5.2 sketches a `System` model with metadata. S1 makes an empty catalogue a hard blocker on publishing, and `prisma migrate deploy` is what a deployment runs; `db:seed` is a dev fixture it does not. |
| S3 | The facet is a **join table written at publish** | Mirrors `PageRelation` exactly: a published edge is a row, written in the publish transaction, not re-derived per read. Makes the §13 filter a join rather than a JSON containment query fighting `ts_rank`. |
| S4 | The catalogue lives at **`/-/systems`**, not `/systems` | A top-level static segment shadows any space whose key it matches. See §7 below — this supersedes the address in §11's route table. |

### S1's cost, stated rather than waved past

Until Phase 8 ships `/admin/systems`, adding a system means a super admin and `psql`. That is
accepted: the seven seeded systems in §5 cover the codebase this platform documents, and a new
deployable is a rarer event than a new document.

The refusal must name the key. `hub-cor` rejected with "unknown system" and no key is a support
question; rejected with "there is no system `hub-cor`" is self-service.

### S3's cost, likewise

A table written at publish can drift from the frontmatter it came from; deriving at read time
cannot. The alternative was measured against the one thing it had to serve — §13's filter — and
lost there: combining JSON containment with the existing `ts_rank` query is materially harder
than a join, and it would give this codebase two different answers to "where does a published
edge live" when `PageRelation` already answers it.

Drift is therefore a thing to **test for**, not a thing this design claims cannot happen. See
§10.

## 4. Domain model

```prisma
enum SystemKind { MOBILE_APP DEVICE_APP SERVICE LIBRARY }

model System {
  id          String     @id @default(cuid())
  key         String     @unique          // "order-hub" — what frontmatter names
  name        String                      // "Order hub"
  kind        SystemKind
  description String?
  repoUrl     String?
  ownerTeam   String?
  isActive    Boolean    @default(true)   // false = sunsetting, still documented
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  pages PageSystem[]
}

model PageSystem {
  pageId   String
  systemId String

  page   Page   @relation(fields: [pageId], references: [id], onDelete: Cascade)
  system System @relation(fields: [systemId], references: [id], onDelete: Cascade)

  @@id([pageId, systemId])
  @@index([systemId])
}
```

`createdAt` and `updatedAt` are additions to §5.2's sketch, for a table Phase 8 makes
admin-editable; every other field is §5.2's.

Three notes on shapes that could reasonably have gone another way:

- **`@@id([pageId, systemId])` rather than a `cuid()` id with a `@@unique`.** `PageRelation`
  takes the latter shape because it carries a `type` and its own `createdAt`, so a row is a
  thing. A `PageSystem` row is nothing but the pair; a surrogate key would be a column nothing
  reads.
- **`@@index([systemId])`** is the one `/-/systems/[key]` reads on. The composite primary key
  already indexes `pageId` for the reverse direction, so no second index is added.
- **`onDelete: Cascade` from both sides**, matching `PageRelation`. Deleting a `System` is a
  Phase 8 action, and it must not be blocked by documentation referencing it — the frontmatter
  declaration survives in `PageVersion.frontmatter` either way, which is the record.

### `isActive` does not gate declaration

A page may declare a sunsetting system, and should: the ADRs explaining why something is being
retired are the documents most worth finding. `isActive: false` changes how `/-/systems` renders
the entry, nothing else.

## 5. How the catalogue reaches a database

The seven systems §7 names, inserted by a data migration:

`store-ios`, `display-ios`, `order-hub`, `pricing-engine`, `backend`, `kiosk-bridge`, `admin-web`

**This is the first migration in this repository that writes rows** — checked, not assumed.
(`INSERT` does appear in `20260826050410_search_vector`, but as trigger DDL — `BEFORE INSERT OR
UPDATE` — not as data.) The precedent it breaks with is real and worth naming: reference data here has so far lived in code
(`src/lib/templates/*.ts` are TypeScript, not rows). Templates can be code because nothing joins
to them. A system is joined to by `PageSystem` and filtered on by search, so it is a row; and
S1 makes it a row that must exist before any author can publish a declaration.

`prisma/seed.ts` upserts the same seven, so a developer running `db:seed` against a database
that predates the migration gets them too. The seed is idempotent by upsert, matching how it
already handles users and spaces.

### The backfill is a no-op today, and is written anyway

Phase 3 accepted `systems:` keys without a catalogue, storing them in
`PageVersion.frontmatter`, and wrote a long comment saying it did so specifically to spare
Phase 7 from asking authors to retype them.

**Measured: nothing to backfill.** The seed declares no systems, all four templates print
`systems:` with nothing under it, and the development database holds **zero** published versions
with a non-empty `systems` array.

The migration backfills anyway — it is a handful of SQL over the published version of each
page, and the cost of writing it against zero rows is far below the cost of a deployment
discovering it was skipped. Keys with no matching system do not backfill; they remain in
`frontmatter`, and they surface the moment that page is next published, because S1 refuses it
then.

## 6. The publish path

`resolveSystems`, beside `resolveRelations` in `src/lib/lifecycle/`, called inside the publish
transaction.

This mirrors relations deliberately, because relations already solved the same problem: a
frontmatter key whose validity depends on **database state** rather than on shape.
`src/lib/lifecycle/schema.ts` stays pure — it keeps checking that `systems:` is text or a list
of text, non-empty and JSON-safe, and it keeps knowing nothing about Prisma. Catalogue
membership is checked where the transaction and the connection already are.

The refusal is a `PublishFieldError`, so it travels the path relation refusals already travel:
into `errors`, out through the publish route, onto the editor surface. No new error channel, no
new consumer.

```
publishPage
  └─ validateFrontmatter          shape, pure, unchanged
  └─ db.$transaction(tx)
       ├─ resolveRelations(tx)    database, unchanged
       ├─ resolveSystems(tx)      database, NEW  ─┐  every refusal decided
       ├─ …every other refusal…                   ├─ here, before any write
       ├─ version row                            ─┘
       ├─ PageRelation rows
       └─ PageSystem rows                         NEW
```

**`resolveSystems` takes `tx` and runs inside the transaction, and it must refuse before the
version insert.** Both halves are load-bearing, and `publish.ts` already carries the reasoning
for each:

- **Inside**, because a catalogue read outside the transaction resolves against a different
  snapshot than the one the `PageSystem` row commits into — the same argument that put
  `resolveRelations` on `tx`.
- **Before any write**, because a refusal inside `db.$transaction` is a `return`, and returning
  **commits**. Refusing after the version insert would have to abort by throwing, which means
  wrapping a field error in a sentinel and unwrapping it in a catch — a second control path for
  the case that is expected rather than exceptional. Every rejection in this module returns
  before a single row is written, and `PageNoLongerPublishable` stays the one mid-write abort
  there is. Adding a refusal below the insert would break that invariant quietly.

`publish.test.ts` asserts the whole snapshot on every refusal path rather than the message,
precisely because a message-only test passes against a transaction that half-committed. The
systems refusal is tested the same way.

Writing the rows is delete-then-insert scoped to the page, the same statement pair
`PageRelation` uses, so a republish that drops a system drops its row. §9 step 3's "replaces the
page's `PageSystem` rows" is satisfied literally.

**One ordering constraint:** the rows are written against the `Page`, not the `PageVersion`, so
they describe the page's *current published* facet. A page whose draft declares a system it has
not published does not appear on that system's page. That is the same rule the rest of the
product follows and needs no special handling — it is stated here because "why isn't my page
listed" is the question it will produce.

## 7. Routes, and why not the address §11 specifies

§11's table says `/systems` and `/systems/[key]`. This design uses **`/-/systems`** and
**`/-/systems/[key]`**, and the reason is a collision the git-mirror phase already measured.

A top-level static segment sits at the same depth as `[space]`, so `/systems` shadows any space
keyed `systems`. `Space.key` has no validation anywhere today, and `/search` already shadows a
space keyed `search` — existing debt that Phase 5 Task 7 declined to extend when it needed a
top-level route, choosing `/-/mirror` instead. `validateSlug` refuses any slug beginning with
`-` with its own error code and its own test, so the reservation is a rule the product already
states rather than a growing list of English words.

Extending that debt here would be the second offence, and the argument against it is the
argument Phase 5 wrote down. So: `/-/systems`.

`/admin/systems` in §11 remains Phase 8's, and it manages the catalogue rather than presenting
it — a different surface for a different audience, not a rename of this one.

### `/-/systems` — the index

Every system, active first, each with the count of documentation the viewer can read. Kind,
owning team and repo link where set.

### `/-/systems/[key]` — one system

Metadata, then the documentation grouped by doc type, as §7 asks: ADRs affecting it, its
runbooks, open RFCs. A system with nothing the viewer can read renders as itself with an empty
list, not a 404 — a system is a deployable, not a secret, and §7 says systems carry no
permissions of their own. An unknown key is a 404.

## 8. What must not leak

Systems carry no permissions; the documents attached to them carry all of them. So every list
and **every count** on these two routes is scoped to the viewer, through the same
`readableSpace` and `visiblePage` predicates the rest of the product compiles to SQL.

The count is the sharp edge and the reason this section exists. `/-/systems` saying `order-hub ·
12 documents` to a viewer who can read three of them discloses the existence of nine documents
in spaces they cannot read — the same class of leak as a 403 that confirms a page exists, which
§8 closes everywhere else with a 404. Counts are therefore computed through the predicate, not
with `_count` over the join.

No new predicate is introduced. `readableSpace` and `visiblePage` already say what may be seen;
this phase adds a join, not a rule.

## 9. Search

§13's filter, built the way `src/lib/search/params.ts` says it must be: "the parameter, the
option list and the `SearchQuery` field arrive together."

- `PARAM.system` — `system` in the query string
- `SearchQuery.system?: string` — one key, matching how `spaceKey`, `docType` and `status` each
  take one value
- The SQL gains an `EXISTS` over `PageSystem` joined to `System` on `key`
- The route renders a real control populated from the catalogue, replacing the comment that
  explains its absence

A key naming a system that does not exist returns no hits, the same answer
`spaceKey` already gives for a space that does not exist or cannot be read. One behaviour for
"nothing matches", not two.

## 10. Testing

The standard is this project's, not a lower one: every claim gets a test whose failure is
demonstrated, and the security claims get a mutation.

| Claim | How it is proven |
|---|---|
| An unknown key refuses the publish, naming the key | Integration, against a real catalogue row |
| A known key writes exactly one `PageSystem` row | Integration; republish with the key removed drops it |
| **The facet cannot drift from the frontmatter** | Publish, mutate nothing, and assert the rows equal the declaration — the test S3's cost demands |
| A viewer sees only readable documents on a system page | Integration with the foreign-editor fixture pattern Phase 6 used to catch the `editableSpace` bypass |
| **A count does not disclose unreadable documents** | Mutation: replace the predicated count with `_count` and the test must fail |
| The search filter narrows, and an unknown key returns nothing | Integration, plus the e2e spec the other filters have |
| A sunsetting system still lists its documentation | Integration |
| The migration is idempotent against a seeded database | Applied twice in a throwaway database |

The migration gets the treatment Phase 5 Task 2 established for migrations that carry data:
generated against a throwaway database, applied with `migrate deploy`, and `migrate status`
checked before any `migrate dev` — the shared-history trap `PROGRESS.md` records.

`scripts/smoke.sh` gains a systems pass: publish a page declaring a system, see it on
`/-/systems/[key]`, find it through the `system` filter, and confirm the refusal of an unknown
key over real HTTP. `counts()` gains `System` and `PageSystem`, because Phase 6's own lesson was
that a table absent from the count contract is a table whose leaks the teardown cannot see.

## 11. What this phase does NOT do

- **`/admin/systems`** — Phase 8. The catalogue is edited by migration or `psql` until then.
- **Space, member and space administration** (§11, §17) — Phase 8.
- **`GitJob` and `AuditLog` retention** — Phase 8, with `/admin`.
- **The space-key validator** §5.3 wants, which would remove the shadowing debt rather than
  route around it — Phase 8, where spaces are created.
- **Due-for-review, the module grid, bug webhook forwarding** — Phase 9.
- **C4 container diagrams generated from the catalogue.** §7 calls the catalogue the inventory
  behind them; generating the diagrams is not in any phase yet and should not be smuggled into
  this one.
- **System ownership, on-call, or links to anything outside this platform.** `ownerTeam` and
  `repoUrl` are strings that render; they are not integrations.

## 12. Supersessions

Recorded in place rather than deleted:

- **§11's `/systems` and `/systems/[key]`** — replaced by `/-/systems` and `/-/systems/[key]`,
  for the collision reason in §7 above.
- **The roadmap's single "Systems, attachments, admin" row** — already lost attachments to
  Phase 6; now splits into 7, 8 and 9 as §2 states.
- **`src/lib/lifecycle/schema.ts`'s `TODO(phase-7)`** and the three
  `Phase 7 owns the systems catalogue` comments in search — each is a promise this phase keeps,
  and each should be removed by the task that keeps it rather than left behind as a marker
  pointing at shipped code.
