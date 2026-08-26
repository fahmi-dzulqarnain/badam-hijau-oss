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
proves nothing about the writes that are *not* publishes. Prove the vector moves when a cascade
retires a page and when a move rewrites a path.

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

## Task 2: The index, and the trigger that maintains it

**Files:** `prisma/schema.prisma`, a **raw SQL** migration, tests.

- [ ] **Step 1: `PageVersion.searchText` and `Page.searchVector`**

The text on the version (it is a property of that published text); the vector on `Page` (it is
what a query scans, and `Page` is what carries `status`, `docType`, `spaceId` and `deletedAt`).

`tsvector` is not a Prisma scalar — it needs `Unsupported("tsvector")` and the index must be
`GIN`, created in raw SQL. Confirm what `prisma migrate dev` does with an `Unsupported` column
before building on it; if it cannot round-trip, say so and adjust rather than fighting it.

- [ ] **Step 2: The trigger**

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

- [ ] **Step 3: Prove the trigger fires on writes that are not publishes**

The point of a trigger rather than application code. A Phase 3 cascade setting `status`, and a
Phase 2 move rewriting `path`, must both leave the vector correct. If a field is *not* in the
vector, say which and why rather than leaving it to be discovered.

- [ ] **Step 4: Backfill**

Existing rows have no vector. A migration that leaves seeded pages unsearchable is one that
passes every test and fails on first use.

---

## Task 3: The query

**Files:** `src/lib/search/query.ts` + integration tests. Registered in the soft-delete guard.

- [ ] **Step 1: `search(viewer, { q, spaceKey?, docType?, status? })`**

`websearch_to_tsquery` — it takes what a person types, including quotes and `-exclusions`, and
does not throw on syntax a person would plausibly type. `ts_headline` for snippets.

**Filtered by readable space ids in SQL.** This is raw SQL, so `readableSpace` does not compose
into it — that is the one place in this codebase where the predicate has to be expressed twice in
two languages. **Derive the id list from `readableSpace` rather than restating its logic**, and
test that a non-member's search over a members-only space returns nothing, for a page whose text
certainly matches.

- [ ] **Step 2: Ranking, with retired pages demoted (§6.4)**

`ts_rank`, multiplied down for the retired statuses Phase 3 already enumerates — import that
list, do not retype it. A retired page that matches better than a live one should still be able
to outrank it; demotion is a thumb on the scale, not a filter.

- [ ] **Step 3: Soft-deleted and unpublished never appear**

`deletedAt IS NULL` and a published version. §13: *"an unpublished draft never appears in
results."* Both need their own test — a draft is invisible to `getPublishedPage` but its `Page`
row is real, and the vector lives on `Page`.

---

## Task 4: The search route

**Files:** `src/app/(reader)/search/page.tsx`, components, tests.

- [ ] `/search?q=` with the filters as query parameters, so a search is a link a person can send.
- [ ] Empty query, no results, and a query that is only punctuation each say something different.
- [ ] The `system` filter is absent, not disabled — Phase 6 owns the catalogue.
- [ ] Snippets render as **text**, never as HTML. `ts_headline` returns markup with its own
      delimiters; choose delimiters that cannot collide with page content and prove it.
- [ ] **Overflow.** Results carry titles, paths and snippets — user-typed text, outside `.body`.
      That class has bitten **five** times. Inject a 300-character unbreakable token and measure
      on a fronted tab.

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
