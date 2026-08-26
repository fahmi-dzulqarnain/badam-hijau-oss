# Phase 4 — Search and diagrams

Spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)
(§13, §12 Mermaid, §6.4's ranking clause, §11 `/search`) ·
Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md) ·
Phase 3: [`2026-08-24-docs-platform-phase-3-doc-types.md`](2026-08-24-docs-platform-phase-3-doc-types.md)

Branch: `phase-4-search-diagrams`, cut from `main` at `2706769`. This phase lands through a PR.

**Deliverable.** Staff search across the spaces they can read, with snippets, filtered by space,
doc type and status. Retired documents stay in results and rank below live ones. A ```mermaid
fence becomes a diagram in the browser, C4 included.

## Decisions taken before writing this

**The application strips, the trigger weights.** §13 asks for a `tsvector` "derived from … body
text stripped of Markdown syntax", "maintained by a trigger created in a raw SQL migration" —
and a plpgsql trigger cannot run remark. So the publish transaction produces plain text with the
parser that already understands the document, stores it, and a raw-SQL trigger builds the
weighted vector from stored columns whenever the row changes.

That split keeps what the trigger is *for*: the vector cannot drift from its row, including when
a write that is not a publish changes a searchable field — a Phase 3 cascade setting `status`, a
Phase 2 move changing `path`. The rejected alternative of a SQL-side regex strip fails on exactly
the input class Task 2 measured: a regex cannot see a fenced code block, so code, link URLs and
table pipes would leak into the index as noise.

## What Phase 4 does NOT do

- **The `system` filter** (§13 lists it) — Phase 6 owns the systems catalogue. The filter has
  nothing to filter on. Say so in the UI's absence, do not build a dead control.
- **`/systems`, `/admin`** (§11) — Phase 6.
- **Server-side diagram rendering.** §12 says Mermaid renders client-side, and the roadmap
  already worked the security constraint out for that shape.
- **Replacing search.** §13: *"Search lives behind `lib/search` with a narrow interface so it can
  be replaced without touching callers."* Build the seam; do not build a second backend.

## Landmines

**Hydrating a Mermaid diagram decodes what the sanitiser escaped.** Measured on the shipped
pipeline — a hostile label today renders as:

```
<div class="mermaid-source">graph TD
A["&#x3C;/div>&#x3C;script>alert(1)&#x3C;/script>"]</div>
```

Reading `textContent` **decodes that**, so Mermaid receives the literal
`</div><script>alert(1)</script>` as diagram source. Whether it executes is then Mermaid's
decision, not ours. Therefore: set `securityLevel: "strict"` explicitly — not the default
`"loose"` — and never move the source with `innerHTML`. **The escaping in the document protects
the document; it has not sanitised the diagram source.**

**Mermaid is 84 MB unpacked.** It must be a dynamic import, loaded only on a page that actually
contains a diagram, and it must not enter the bundle of any route that does not.

**A stale index is invisible.** Every failure mode of search reads as "that page does not exist".
The trigger exists so the vector cannot lag its row — but a test that only publishes and searches
proves nothing about the writes that are *not* publishes.

**This landmine originally named the wrong writes, and Task 2 measured it.** It said to prove the
vector *moves* when a cascade retires a page or a move rewrites a path. Neither is an input:
§13's formula has three terms — title, headings, body — and `status` and `path` are filters and
addresses. Measured on the dev database, both leave the vector **byte-identical**, which is
correct behaviour, so the right assertion for those two is that it comes out *unchanged* (each
with a non-vacuity companion — the cascade test has to prove the target really reached
`SUPERSEDED` first).

What genuinely goes stale is a write to **`title` or `publishedVersionId`** that does not go
through `publishPage` — a bare `UPDATE`, or a rollback repointing at an older version. Measured:
a title change makes the vector follow. That is the pair worth pinning.

**`ts_headline` runs on the stored text, and the stored text is not the document.** A snippet is
what a person reads to decide whether to click; if the strip is lossy in a way that makes
snippets unreadable, the strip is wrong, not the snippet.

## Conventions that carry forward

Settled in Phases 1–3. Changing one is a decision, not a detail.

- `readableSpace(...)` and `visiblePage(...)` return complete `where` objects and **must never be
  spread**. **Search must be filtered by readable space ids in SQL**, never filtered after
  fetching — §13 says so and so does every other read in this codebase.
- Every query states its own permission predicate; none is guarded by call ordering.
- Never `include:`; always an explicit `select:`.
- **Every module that queries the database is registered** in `src/lib/pages/visible.test.ts`.
  That guard has been too narrow **six times** — read its docstring before assuming a raw
  `$queryRaw` search is visible to it.
- Only `src/lib/audit/log.ts` may touch the `auditLog` delegate.
- Control characters as **escapes, never literals** — a literal NUL made `rg` skip a module.
- A concurrency test that never blocks is not testing a write predicate.
- A refusal that survives deleting the guard it names is a test of the other guard.
- An equivalence assertion over two derived sets needs a non-vacuity companion.
- `npm run plan:check` must report **0 drifted** before a task is closed.
- Implementers make **small commits**, never `--amend`, and stage explicit paths. Two long tasks
  in this project were lost whole to environment failures that a commit would have bounded.

---

## Task 1: Plain text from Markdown ✅

Pure, no database. Everything else in the search half depends on this being faithful.

**Files:** `src/lib/search/text.ts` + tests.

- [x] **Step 1: `searchTextOf(markdown)`**

Strip to what a person would read aloud. Reuse the existing pipeline's parser rather than a
second grammar — `splitFrontmatter` first, then a remark pass. Frontmatter is **not** indexed:
it is metadata, and `supersedes: decisions/adr-0031` matching a search for "decisions" is noise.

- [x] **Step 2: Decide, and document, what each construct contributes**

Code fences, inline code, link text versus link URL, image alt text, table cells, HTML comments.
Each is a judgement: link *text* is prose a person searches for, link *URLs* are not. State the
table in the docstring, and let the tests read as that table.

**Three constructs this list omitted, decided anyway:** footnote *definitions* are in (visible
prose at the foot of the article), footnote *reference markers* are out (they render as `[1]`),
and link reference definitions — `[ref]: https://…` — are out (they render as nothing at all).

**The two least obvious rows, and why they point opposite ways.** *Inline code is in, fenced code
is out*, and that is the snippet-versus-index trade resolved in the snippet's favour twice.
Inline code is a token inside a sentence, so dropping it indexes a hole and yields the snippet
`Call  before rendering.` — and identifiers and error codes are the highest-value thing to search
for in an engineering corpus. A fence is the reverse on both counts: removing it leaves the prose
around it whole, while keeping it fills the index with `const`/`await`/`});` and hands
`ts_headline` somebody's TypeScript as the page description.

**A ```mermaid fence contributes nothing and needs no special case** — it is a `code` node. Its
label prose is a real, accepted loss: recovering it means parsing Mermaid, which is the second
grammar this task exists to refuse.

**Headings stay in the body text**, even though Task 2 indexes them separately at weight B. That
is deliberate overlap rather than the re-derivation Task 2 warns against: `collectHeadings` takes
h2 and h3 only, so dropping headings here would leave an h1 or h4 indexed by **nothing**, and a
match in a section title with no text for `ts_headline` to draw from.

**"HTML contributes nothing" is a rule about a node, not about angle brackets.**
`After <span>inline</span>.` parses as html/text/html, so `After inline.` survives — asserted
against what `renderMarkdown` actually emits, because the plausible intuition ("strip the tags and
what they wrap") is wrong.

- [x] **Step 3: The shapes that break naive strippers**

Task 2 measured three that go the opposite way from a line scanner's guess. Here the equivalents
are a fence containing something that looks like a heading, a table whose cells contain pipes,
and a link whose text is itself a URL. Test them.

---

## Task 2: The index, and the trigger that maintains it ✅

**Files:** `prisma/schema.prisma`, a **raw SQL** migration, tests.

- [x] **Step 1: `PageVersion.searchText` and `Page.searchVector`**

The text on the version (it is a property of that published text); the vector on `Page` (it is
what a query scans, and `Page` is what carries `status`, `docType`, `spaceId` and `deletedAt`).

`tsvector` is not a Prisma scalar — it needs `Unsupported("tsvector")` and the index must be
`GIN`.

**This step originally said the GIN index must be "created in raw SQL". That instruction was
wrong, and it named precisely the case Prisma drops.** The index is declared in `schema.prisma`
and Prisma emits its own `CreateIndex`; only the trigger is hand-written inside the migration.

**Measured on a throwaway database before anything was written, and triggers and indexes turn out
to behave oppositely:**

| Object | What `prisma migrate dev` does |
|---|---|
| A trigger created **in a migration** | **Survives.** Prisma's diff cannot see it, so it is never dropped and never reported as drift |
| A trigger created **by hand** against a database | Also survives — **and that is the trap.** Equally invisible, so it exists on the machine that ran it and on no fresh database ever provisioned. **A trigger that is not in a migration is not deployed** |
| The **GIN index** | **The opposite.** Prisma *does* model indexes, so one created only in SQL is diffed as an extra and the next unrelated `migrate dev` emits `DROP INDEX "Page_searchVector_idx"` — reproduced, as the only statement of a no-op migration |

So the index is **declared in `schema.prisma`** (Prisma emits its own `CreateIndex`) while the
trigger is hand-written **inside the migration**. The dangerous half is the one that looks safe:
a by-hand trigger works perfectly on the machine that created it.

**Two triggers, with the weighting expressed once** so they cannot disagree — one on `Page` and
one on `PageVersion`, because two of the three inputs live on the version. The shared function is
`IMMUTABLE`, and that is load-bearing: the two-argument `to_tsvector(regconfig, text)` is
immutable, while the one-argument form is only `STABLE` because it reads
`default_text_search_config` from the session.

**Headings needed a new server-side entry point.** `collectHeadings` is a *hast* plugin that needs
`rehypeSlug`'s ids, so it cannot be re-derived from mdast, and nothing stored it. The render
pipeline's prefix was extracted so `headingsOf()` and `renderMarkdown()` share one processor —
the indexed headings and the table of contents are therefore the same list **by construction**,
not by an equivalence test that could go vacuous. It stops before `rehypeShiki`: **0.6 ms versus
4.8 ms**, measured, which is what the publish transaction would otherwise pay while holding a row
lock.

**The backfill runs through the trigger rather than around it.** The migration ends with
`UPDATE "Page" SET "searchVector" = NULL`, and the `BEFORE` trigger refills every row — so the
backfill exercises the same code path every later write uses, and fails loudly if the trigger is
broken. The text columns need remark, so a reindex script recomputes them and the version trigger
carries the change onto `Page`; the seed calls it, so `db:seed`, smoke and E2E all close the gap
without anyone remembering.

**A real bug, found only because a test was added past the obvious case.** The reindex cursor read
`versions[…]?.id`, and an `undefined` `after` drops the `id > …` filter — so the walk looped
forever. The walk had only ever been exercised at one row; a 101-row test caught it as
`{ scanned: 100, rewritten: 99 }`.

**Four things named as untested rather than assumed:** concurrency between the reindex and a
publish (there is an argument that no lock cycle exists, but this project's rule is that an
argument is not a staged interleaving); `search_path = ''` under some poolers, since the trigger
calls its function unqualified as every Prisma-generated object here does; whether the heading
double-count at B and C measurably distorts ranking, which is a Task 3 question with real
queries; and `ts_headline` over `searchText = ''`.

**What is deliberately not in the vector**, each with a reason rather than an omission:

- **`status`, `docType`, `spaceId` are filters, not text.** §13 lists them as filters and Task 3
  puts them in the `WHERE` clause, where they are exact. Indexing `ACCEPTED` as a lexeme would let
  a page *about acceptance testing* match a status filter spelled as a word.
- **`path` and `slug` are addresses.** Task 1 already drew this line for link URLs, and a path is
  the same object — assembled from slugs, assembled from the title, which is already at weight A.
  Indexing it would double-count the title in a hyphen-split form.
- **`frontmatter` is metadata**, for the reason Task 1 gives.

- [x] **Step 2: The trigger**

`setweight(title,'A') || setweight(headings,'B') || setweight(searchText,'C')`, on the row's own
`INSERT OR UPDATE`. Weights come from §13.

**This formula double-counts heading words**, at B and again at C, because Task 1 deliberately
keeps headings in `searchText` — see its section for why removing them re-opens an h1/h4 hole and
breaks snippets for title matches. The effect is a small extra rank push on a heading lexeme.
Know it rather than discover it in Task 3, and if it must go, **the fix belongs in the trigger,
not in the strip**.

**`searchText` can legitimately be the empty string** — a page whose entire content is one Mermaid
diagram. Publish refuses an empty *body*, but a body that is only a diagram is not empty. This
step's `NOT NULL`/backfill and Task 3's `ts_headline` must both expect `""` rather than treat it
as a failed strip.

**Headings are already extracted server-side** by `collectHeadings` — do not re-derive them.

- [x] **Step 3: Prove the trigger fires on writes that are not publishes**

The point of a trigger rather than application code. A Phase 3 cascade setting `status`, and a
Phase 2 move rewriting `path`, must both leave the vector correct. If a field is *not* in the
vector, say which and why rather than leaving it to be discovered.

- [x] **Step 4: Backfill**

Existing rows have no vector. A migration that leaves seeded pages unsearchable is one that
passes every test and fails on first use.

---

## Task 3: The query ✅

**Files:** `src/lib/search/query.ts` + integration tests. Registered in the soft-delete guard.

- [x] **Step 1: `search(viewer, { q, spaceKey?, docType?, status? })`**

`websearch_to_tsquery` — it takes what a person types, including quotes and `-exclusions`, and
does not throw on syntax a person would plausibly type. `ts_headline` for snippets.

**Filtered by readable space ids in SQL.** This is raw SQL, so `readableSpace` does not compose
into it — that is the one place in this codebase where the predicate has to be expressed twice in
two languages. **Derive the id list from `readableSpace` rather than restating its logic**, and
test that a non-member's search over a members-only space returns nothing, for a page whose text
certainly matches.

**The first version of this module was wrong, and only mutation testing found it — the most
valuable catch of the phase.** Dropping `AND p."spaceId" = ANY(...)` from the SQL left **all 24
tests green**. The cause was not the SQL: hits were assembled through a `byId.get(row.spaceId)`
lookup against a `Map` built from the readable-space read, and the miss did something — it skipped
the row. That skip was **a second copy of the space filter, in TypeScript, applied after
fetching**: the untestable-duplicate-predicate failure *and* the "never filter after fetching"
rule at once, arriving through a line that looks like care. Fixed by joining `Space` for its
columns (FK-guaranteed, so it drops no row) and deleting the lookup.

**The same trap arrived by a second route.** `PageVersion` is joined for the snippet, and an
`INNER JOIN` would exclude unpublished pages *as a side effect of wanting a snippet* — measured:
with the join made `INNER`, deleting the `WHERE` clause leaves the whole file green. So the join
is `LEFT`, with the headline coalesced at its one use, and a deliberate counterfactual mutant is
kept in the record: `LEFT → INNER` **plus** dropping the published clause passes 24 tests, which
is what justifies `LEFT`.

Worth carrying: **without that coalesce the mutation died as a `TypeError` rather than as the
assertion naming a draft in results. A mutant that dies for the wrong reason has not proven the
assertion you meant.**

- [x] **Step 2: Ranking, with retired pages demoted (§6.4)**

`ts_rank`, multiplied down for the retired statuses Phase 3 already enumerates — import that
list, do not retype it. A retired page that matches better than a live one should still be able
to outrank it; demotion is a thumb on the scale, not a filter.

**`RETIRED_RANK_FACTOR = 0.4`, derived rather than picked: it is `B/A`** — one weight band, so a
retired page must match one whole band better to draw level. Tested in both directions and once
per status over the whole imported set, so adding a retired status in Phase 3 cannot leave this
behind.

**Task 2's open question, answered: the double-count changes no ordering, and the trigger is left
alone.** Two formulas over the same three stored columns — the shipped one, and one applying
`ts_delete` to strip heading lexemes from the body band, which is what the trigger fix would have
been. Over 16 real queries drawn from the seeded titles, headings and prose: **0 order changes, 0
result-set changes**, with individual ranks moving up to 27.7%.

Sixteen queries over six pages is an absence, not a proof, so the *reason* carries the weight:
`ts_rank` saturates and the bands do not overlap.

| Quantity | Value |
|---|---|
| One `C` hit | 0.121585 |
| `C` ceiling (a word repeated 1000×) | 0.199524 |
| One `B` hit, without the double count | 0.243171 |
| One `B` hit, with it | 0.273567 (+12.5%) |
| `B`+`C` ceiling, 40 heading hits | 0.395488 |
| One `A` hit | 0.607927 |

The double count only ever adds `C` positions for a lexeme already at `B`, so it can only favour
the page `B` already favours — **it widens a gap, it cannot cross one.** No amount of body
repetition reaches a single `B` hit, and `B`+`C` tops out well below a single title hit. It is
self-limiting: +12.5% at one occurrence, +1.9% at eight, +0.4% at forty. For scale, the retired
demotion is ×0.4.

**§8's super-admin access audit is wired into search, beyond this task's brief and argued.**
`getReadableSpaceByKey` audits a space a super admin *resolves*; search resolves every readable
space at once, so without this a super admin could read titles and snippets out of every `MEMBERS`
space they do not belong to and leave no trace. It calls the existing `auditSpaceAccess` — which
owns `needsAccessAudit` and the per-request dedupe, so this is not a second copy of that rule —
and **only for spaces that produced a hit**, because auditing the enumeration would write a row
per `MEMBERS` space on every search.

- [x] **Step 3: Soft-deleted and unpublished never appear**

`deletedAt IS NULL` and a published version. §13: *"an unpublished draft never appears in
results."* Both need their own test — a draft is invisible to `getPublishedPage` but its `Page`
row is real, and the vector lives on `Page`.

**§13 attributes this to the wrong mechanism, and Task 2's backfill proves it.** The spec says the
vector is "derived from the page's **published** version … so an unpublished draft never appears
in results" — implying the index achieves the exclusion. It does not. An unpublished page has no
published version, so it gets a **title-only** vector — measured: the seeded unpublished
`adr-0043` carries a 35-byte vector that matches a search for its own title. The exclusion has to
be in the `WHERE` clause. Either filter on `publishedVersionId IS NOT NULL` here, or make the
trigger leave the vector `NULL` for an unpublished page — **decide which, and say why**, because
the second makes the index self-documenting while the first keeps all the query's rules in one
readable place.

---

## Task 4: The search route ✅

**Files:** `src/app/(reader)/search/page.tsx`, components, tests.

- [x] `/search?q=` with the filters as query parameters, so a search is a link a person can send.
- [x] Empty query, no results, and a query that is only punctuation each say something different.
- [x] The `system` filter is absent, not disabled — Phase 6 owns the catalogue.
- [x] Snippets render as **text**, never as HTML. **Discharged by Task 3, and differently from
      how this bullet imagined it.** The delimiters live in the SQL, so they are Task 3's, and
      they are parsed away *inside* `lib/search` — `search()` returns `{ text, match }[]`, and
      this route never sees a delimiter it could render by accident. The "prove it" is not a
      collision search: the delimiters are `\u0002`/`\u0003`, which the ingest `stripControl`
      (`\p{Cc}`) removes from every title and every byte of Markdown, plus a test for unbalanced
      delimiters.
- [x] **Three outcomes, not two.** Task 3 returns `empty-query`, `no-terms` (the input reduced to
      an empty tsquery — `...`, `-only`, `'`) and a successful search with no hits. Each needs its
      own sentence; collapsing them tells a person their query was fine when it was not.
- [x] **Overflow.** Results carry titles, paths and snippets — user-typed text, outside `.body`.
      That class has bitten **five** times. Inject a 300-character unbreakable token and measure
      on a fronted tab.


**The space filter has no menu, and that is where the seam rule bit.** A dropdown means
enumerating the viewer's readable spaces — a second query, which §13's narrow interface forbids.
Instead each result's space *name* is a link that narrows to it, carrying the words and the other
filters, and the narrowed page offers "Search every space". If a proper dropdown is wanted,
`lib/search` needs a `readableSpaces(viewer)` export: the space read **already happens inside
`search()`**, so it would be a returned value rather than a new query — but it widens the §13
interface, so it is a decision rather than an implementation detail.

**A test this task found weak and left in, with a comment saying so.** Its
`new Set([...]).size === 3` line **passed** under the outcome-collapsing mutant, because the two
sentences still differ by the query text they quote — only the substring assertions killed it. It
kept the weak line (it does kill a byte-identical collapse) and annotated it, rather than leaving a
near-vacuous assertion to be trusted. That is the right handling: a weak assertion labelled is
worth more than a weak assertion deleted, because the label is what stops the next reader relying
on it.

**`/search` shipped unreachable, and that is the Task 14b defect arriving a second time.** Nothing
linked to it — a feature built with no way to get to it, exactly as `movePage` shipped in Phase 2
as a library function with no caller, at the cost of a whole extra task. This task could not fix it
without breaking `plan:check` (the natural home, `TopBar.tsx`, is quoted by an in-sync whole-file
fence and implementers may not edit plans), so it escalated. **Resolved by the controller**: a
`Search` link in `TopBar`, which all three layouts render and all three sit behind
`requireViewer` — verified present on `/engineering`, on a page route, and on `/search` itself.

**And fixing it exposed this checker's known weakness on its own repository.** Adding an import
changed `TopBar.tsx`'s *first line*, so the stale fence did not become `drifted` — it slid into the
`unmatched` bin, where nothing reports it. The only signal was `in sync` falling from 51 to 50
while `unmatched` rose from 11 to 12. `plan:check` now checks for a supersession note **before**
dismissing on a first-line mismatch, so annotating a fence is meaningful rather than decorative:
`superseded` went 21 → 23 and `unmatched` 12 → 10, and planted drift in a genuinely in-sync fence
still reports (`49 in sync · 1 drifted`, naming the file).
---

## Task 5: Mermaid hydration

**Files:** `src/components/Mermaid.tsx`, `package.json`, tests.

- [ ] **Step 1: `securityLevel: "strict"`, stated explicitly and pinned by a test**

Not the default. A test asserting the configured value is the only thing standing between a
dependency upgrade and a changed default.

- [ ] **Step 2: Dynamic import, only where a diagram exists**

84 MB unpacked. Assert it is absent from the bundle of a route with no diagram — `next build`'s
output, not a claim.

- [ ] **Step 3: Never `innerHTML` for the source**

Read `textContent`, hand the string to Mermaid, insert the returned SVG through the API Mermaid
gives you. The roadmap's measurement is the test case: a label containing
`</div><script>alert(1)</script>` must produce no script element and no executed alert.

- [ ] **Step 4: A malformed diagram is an error in place, not a broken page**

§14: *"Renders as a code block with an inline error, rest of page unaffected."* One bad diagram
must not take the article with it.

- [ ] **Step 5: C4**

`C4Context` and `C4Container` are Mermaid diagram types, so they arrive with it — but they are
what §12 names, so test one rather than assuming.

---

## Task 6: End-to-end

- [ ] Search finds a seeded page by a word in its body, and the snippet contains that word.
- [ ] A non-member searching the same word gets nothing.
- [ ] A retired page appears below a live one for the same query.
- [ ] Filters narrow, and a filtered search is a shareable URL.
- [ ] A ```mermaid fence renders as an SVG; a hostile label executes nothing.
- [ ] A malformed diagram shows its error and the rest of the page still reads.
- [ ] Hostile content does not widen any new route.
- [ ] Cleanup asserted — the suite compares dev-database counts before and after.

---

## Task 7: Extend the smoke test

- [ ] Publish a page over HTTP, search for a word unique to it, assert it is found; retire it and
      assert it now ranks below a live match.
- [ ] Clean up everything, and extend the `counts()` contract if this phase adds a table.
- [ ] Prove it can fail; the exit code is the contract.

---

## Phase 4 exit criteria

- [ ] `npm test`, `npm run test:e2e`, `npm run smoke` all pass
- [ ] `npm run typecheck && npm run build` clean; `npm run plan:check` 0 drifted
- [ ] A search returns only pages in spaces the viewer can read — proven with a page whose text
      matches and whose space the viewer cannot read
- [ ] Unpublished and soft-deleted pages never appear
- [ ] Retired pages appear, demoted
- [ ] Snippets show the matched term and render as text
- [ ] The index stays correct after a write that is not a publish
- [ ] A Mermaid diagram renders, a C4 diagram renders, a hostile label executes nothing, and a
      malformed diagram does not take the page with it
- [ ] Mermaid is absent from the bundle of a route with no diagram
- [ ] The PR is open with the phase's exit criteria in its description
