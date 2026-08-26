import type { DocStatus, DocType } from "@prisma/client";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import { auditSpaceAccess } from "@/lib/audit/log";
import { RETIRED_STATUSES, isRetired } from "@/lib/pages/transition";
import { SEARCH_CONFIG } from "@/lib/search/config";
import type { Viewer } from "@/lib/authz/types";

/**
 * Spec §13's search, and the seam it names: *"Search lives behind `lib/search` with a narrow
 * interface so it can be replaced without touching callers."*
 *
 * This module **is** that interface. `SearchQuery` in, `SearchResult` out, and nothing
 * Postgres-shaped crosses either boundary — no `tsvector`, no `tsquery`, no rendered headline
 * markup, no Prisma types beyond the two enums that are the product's own vocabulary. A caller
 * cannot tell from the types that there is a `GIN` index behind this, which is what "replaceable
 * without touching callers" has to mean if it is to mean anything. There is deliberately **no
 * second backend**: the plan says build the seam, not build two implementations of it.
 *
 * ## The permission predicate is expressed twice, in two languages — the only one in this
 * codebase that is
 *
 * §13 and §8 both require the space filter to be **in the query** rather than applied to fetched
 * rows, and this query is raw SQL, because `tsvector`, `ts_rank` and `ts_headline` have no Prisma
 * expression. `readableSpace` returns a Prisma `where` and does not compose into raw SQL.
 *
 * So the readable set is **derived** from `readableSpace`, not restated: one `db.space.findMany`
 * under the real predicate, and the ids it returns are bound into `spaceId = ANY(...)`. A second
 * copy of "`ALL_STAFF` **or** a membership row" written out in SQL would be the failure this
 * project has already measured twice — `resolveRedirect`'s nested duplicate and the plan's
 * Task 5/Task 6 duplicate — where mutating away *either* copy leaves the whole suite green,
 * because the other one is still refusing. Derivation means there is exactly one statement of
 * the predicate and deleting the `ANY(...)` clause fails loudly: a non-member starts finding
 * pages in a members-only space.
 *
 * The space read is also where the filter chip's space comes from, so `spaceKey` is passed to
 * `readableSpace` as an extra condition rather than compared in SQL. A filter naming a space the
 * viewer cannot read and a filter naming a space that does not exist therefore give the same
 * answer — no hits — which is the 404-not-403 rule (§8) applied to a filter.
 *
 * ## Three exclusions, each stated exactly once, each mutation-verified
 *
 * | Rule | Where it lives | What happens if it is deleted |
 * |---|---|---|
 * | Only readable spaces | `spaceId = ANY(${ids})` | a non-member finds a members-only page |
 * | No soft-deleted pages | `p."deletedAt" IS NULL` | a deleted page is searchable |
 * | No unpublished drafts | `p."publishedVersionId" IS NOT NULL` | a draft matches its own title |
 *
 * `deletedAt IS NULL` is `visiblePage()` written in SQL, and that is the one restatement here
 * that is safe: it is a single column compared to a single value, with no branch that the two
 * spellings could disagree about. `readableSpace` is the opposite — a top-level `OR` over a
 * relation — which is why that one is derived and this one is not.
 *
 * ## The unpublished exclusion is in the `WHERE` clause, and the `JOIN` is `LEFT` to keep it
 * falsifiable
 *
 * §13 claims the index delivers this — *"derived from the page's published version … so an
 * unpublished draft never appears in results"* — and it does not. Task 2 measured it: a page with
 * no published version still gets a **title-only** vector, and the seeded unpublished ADR matches
 * a search for its own title. So the exclusion is here, and the choice between the two places it
 * could live went the way the migration's own comment argues for: **the query, not a `NULL`-ing
 * trigger.** A trigger that left drafts unindexed would make this predicate *unfalsifiable* —
 * delete the line and nothing changes, and its test passes over a query that has no such filter.
 * All of the query's rules being readable in one `WHERE` clause is the smaller benefit; the
 * decisive one is that each rule can be shown to be doing its job.
 *
 * The same argument decides the join. `PageVersion` is joined for one reason — `ts_headline` needs
 * the stored strip — and an `INNER JOIN` would exclude unpublished pages *as a side effect of
 * wanting a snippet*, re-creating the exact unfalsifiability the trigger decision avoided. `LEFT`
 * makes the `WHERE` clause the only thing excluding a draft. The FK guarantees the row exists for
 * every page that passes that clause, so nothing downstream has to cope with a missing version.
 *
 * ## Retired pages are demoted, not filtered — §6.4
 *
 * `RETIRED_STATUSES` is imported and bound as a parameter, never retyped: it is a transcription
 * of §6.4's six names living in `src/lib/pages/transition.ts`, and a second copy in SQL would go
 * stale the first time the vocabulary grows a way to retire a document. See
 * `RETIRED_RANK_FACTOR` for why the multiplier is what it is.
 *
 * ## Not `React.cache()`d
 *
 * Its argument is an object literal, so a cache would never hit while looking as though it did —
 * the same call `src/lib/lifecycle/index-read.ts` makes.
 */

/**
 * The most hits one search returns.
 *
 * A rendering bound, not a correctness one: Phase 4 has no pagination, and §13 sizes this whole
 * design at "a few thousand pages", where a single-word query can plausibly match most of the
 * corpus. The query asks for one more row than this so `truncated` can be a fact rather than a
 * guess — the alternative, a second `count(*)` over the same `@@` predicate, would scan the index
 * twice to learn one boolean.
 */
export const MAX_SEARCH_RESULTS = 50;

/**
 * What a retired page's rank is multiplied by — §6.4: retired documents *"stay in results but are
 * demoted in ranking"*.
 *
 * **0.4, which is one weight band.** `ts_rank`'s default weights are
 * `{D, C, B, A} = {0.1, 0.2, 0.4, 1.0}`, so `B / A` is 0.4 and `C / B` is 0.5: multiplying by 0.4
 * costs a retired page a little more than one band. That is the property worth having and it is
 * why the number is derived from the weights rather than picked for feel — the demotion is
 * legible as *"a retired page has to match one whole band better to draw level with a live one"*.
 *
 * A thumb on the scale, not a filter, and both directions are pinned by tests: a retired page and
 * a live page matching equally well come back live-first, and a retired page matching in its
 * **title** still outranks a live page matching only in its **body**. A factor of 0 would be a
 * filter wearing a multiplier's clothes, and §6.4 explicitly wants these pages found.
 */
export const RETIRED_RANK_FACTOR = 0.4;

/**
 * The delimiters `ts_headline` wraps a matched term in, and they are **control characters**.
 *
 * §13 asks for `ts_headline`, which returns one string with the matches marked in it. Everything
 * downstream renders text and never HTML, so `<b>` — Postgres's default — would be the worst
 * available choice: it invites exactly one `dangerouslySetInnerHTML` and it collides with page
 * content, because a document may legitimately contain the characters `<b>`.
 *
 * `\u0002`/`\u0003` (STX/ETX) cannot collide, and that is provable rather than hopeful:
 * `src/lib/text/control.ts` strips `\p{Cc}` from every title and every byte of Markdown on the
 * way in, so no stored document can contain either one. Written as escapes and never as literals
 * — a literal NUL in `publish.ts` once made `rg` classify the module as binary and skip it.
 *
 * And the delimiters are parsed away here, in `segmentsOf`, so what leaves this module is a list
 * of `{ text, match }` runs. A caller cannot render a snippet as markup by accident, because
 * there is no markup to render — which is a stronger guarantee than any choice of delimiter.
 * Even a delimiter that *did* somehow collide could only mis-mark which run is emphasised.
 */
const HEADLINE_START = "\u0002";
const HEADLINE_STOP = "\u0003";

/**
 * `ts_headline`'s options, assembled once.
 *
 * `MaxFragments=0` selects the single-window behaviour: one passage containing as many query
 * terms as it can, rather than several `...`-joined fragments. One window is what a result row
 * has space for, and a fragment delimiter would be a second thing to render as text.
 *
 * `MaxWords`/`MinWords` bound the passage; `ShortWord=3` keeps a window from starting on "the".
 * `HighlightAll=FALSE` because highlighting the whole document is what happens when the term is
 * absent from the text — see `SearchHit.snippet` for why the term can be absent at all.
 */
const HEADLINE_OPTIONS =
  `StartSel=${HEADLINE_START}, StopSel=${HEADLINE_STOP}, ` +
  "MaxWords=35, MinWords=15, ShortWord=3, HighlightAll=FALSE, MaxFragments=0";

/** What a person typed, and the filters §13 lists. */
export type SearchQuery = {
  /** Raw, as typed. Quotes and `-exclusions` are `websearch_to_tsquery`'s job, not a caller's. */
  q: string;
  /**
   * Narrow to one space, by key. A space the viewer cannot read and a space that does not exist
   * give the same answer — no hits — because both resolve to an empty readable set.
   */
  spaceKey?: string;
  docType?: DocType;
  /**
   * One status. §13: *"the status filter isolates or excludes them"* — asking for `SUPERSEDED`
   * isolates retired ADRs, asking for `CURRENT` excludes every retired page. Both fall out of an
   * exact match, so there is no separate retired switch.
   *
   * §13 also lists a `system` filter. Phase 6 owns the systems catalogue, so there is nothing to
   * filter on; the absence is deliberate and this comment is where it is recorded.
   */
  status?: DocStatus;
};

/** One run of a snippet. `match` runs are what the query matched. */
export type SnippetSegment = { text: string; match: boolean };

export type SearchHit = {
  pageId: string;
  spaceKey: string;
  spaceName: string;
  path: string;
  title: string;
  docType: DocType;
  status: DocStatus;
  /** §6.4, derived through `isRetired` rather than re-tested against a list of names. */
  isRetired: boolean;
  publishedAt: Date | null;
  /** After the retired demotion. Exposed so a caller can show or debug the ordering. */
  rank: number;
  /**
   * The passage a person reads to decide whether to click, split into plain and matched runs.
   *
   * Drawn from `PageVersion.searchText` — the published body with Markdown stripped — which is
   * the only stored text a snippet could come from and, as the plan's landmine says, *not the
   * document*. Headings are in it too (Task 1 keeps them in the body strip), so a heading match
   * has prose to be quoted from.
   *
   * **Two cases where no run is a `match`, and they are different:**
   *
   * - The match was in the **title** only, so the query's terms are absent from the body. Postgres
   *   then returns the opening of the text, unmarked — which is a page description, and a good
   *   one. Nothing here has to special-case it.
   * - The page has **no prose at all** — `searchText` is `""`, which Task 2 established is a
   *   legitimate value for a page whose entire content is one Mermaid diagram. `ts_headline` over
   *   `''` returns `''`, and this array is then **empty**. That is the answer, not a failure: the
   *   page is findable by its title and there is nothing to quote. A caller renders its path or
   *   its title instead, and can tell the two cases apart because one is empty and one is not.
   */
  snippet: SnippetSegment[];
};

export type SearchResult =
  | {
      ok: true;
      hits: SearchHit[];
      /** `MAX_SEARCH_RESULTS` was exceeded, so `hits` is short. */
      truncated: boolean;
    }
  | {
      ok: false;
      /**
       * Three outcomes and not two, because §11's `/search` has to say three different things.
       *
       * - `empty-query` — nothing was typed. No database work at all.
       * - `no-terms` — something was typed and it contains no searchable word: `...`, `-only`,
       *   `it's` on its own (measured: `websearch_to_tsquery` reduces all three to an empty
       *   `tsquery`). "No results for `...`" would be a lie by implication; there was nothing to
       *   look for.
       *
       * A query with terms that matches nothing is `ok: true` with no hits, which is the third
       * sentence and a genuinely different one.
       */
      reason: "empty-query" | "no-terms";
    };

/** The raw row, before space identity and the snippet are attached. */
type HitRow = {
  pageId: string;
  spaceId: string;
  path: string;
  title: string;
  docType: DocType;
  status: DocStatus;
  publishedAt: Date | null;
  rank: number;
  headline: string;
};

/**
 * Splits a `ts_headline` result on the delimiters above.
 *
 * Written as a scan rather than a `split`, because an unbalanced delimiter must not lose text: a
 * `\u0002` with no `\u0003` after it makes the remainder one matched run rather than throwing
 * away everything after it. No stored document can contain either character (see
 * `HEADLINE_START`), so this is about the failure being harmless rather than about it happening.
 *
 * Empty runs are dropped, so a match at the very start of the passage does not produce a leading
 * `{ text: "", match: false }` that every caller would have to filter.
 */
export function segmentsOf(headline: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let rest = headline;
  let match = false;

  while (rest !== "") {
    const delimiter = match ? HEADLINE_STOP : HEADLINE_START;
    const at = rest.indexOf(delimiter);
    const text = at === -1 ? rest : rest.slice(0, at);
    if (text !== "") segments.push({ text, match });
    if (at === -1) break;
    rest = rest.slice(at + delimiter.length);
    match = !match;
  }

  return segments;
}

/**
 * Search across the spaces this viewer can read — spec §13.
 *
 * Two statements, and the split is not incidental. The first parses what the person typed; the
 * second searches. `websearch_to_tsquery` therefore appears **once** in this module, and its
 * output — Postgres's own canonical `tsquery` text, verified to round-trip — is what the search
 * statement binds. So the `@@` test, the `ts_rank` and the `ts_headline` are provably asking for
 * the same thing, rather than three calls that agree because someone kept them in step.
 *
 * It also means a query with no searchable term costs one trivial statement and never touches
 * `Page`.
 */
export async function search(viewer: Viewer, query: SearchQuery): Promise<SearchResult> {
  const { q, spaceKey, docType, status } = query;

  // Before anything else, and before any database work: nothing typed is not a failed search.
  if (q.trim() === "") return { ok: false, reason: "empty-query" };

  const parsed = await db.$queryRaw<{ tsquery: string }[]>`
    SELECT websearch_to_tsquery(${SEARCH_CONFIG}::regconfig, ${q})::text AS "tsquery"`;
  const tsquery = parsed[0]?.tsquery ?? "";
  // `websearch_to_tsquery` never throws on syntax a person would plausibly type — quotes,
  // `-exclusions`, a bare `OR`, stray operators — it reduces what it cannot use to an empty
  // query. That is the whole reason §13 names it rather than `to_tsquery`, and an empty result
  // is a different sentence from "no results".
  if (tsquery === "") return { ok: false, reason: "no-terms" };

  // The permission predicate, stated once, in Prisma, through the only sanctioned helper. Passed
  // whole and never spread, at any nesting depth. `spaceKey` rides along as an extra condition
  // so an unreadable key and an unknown key are the same answer.
  const spaces = await db.space.findMany({
    where:
      spaceKey === undefined
        ? readableSpace(viewer)
        : readableSpace(viewer, { key: spaceKey }),
    // Explicit select, never `include`. `visibility` is here for the access audit below.
    select: { id: true, key: true, name: true, visibility: true },
  });
  const byId = new Map(spaces.map((space) => [space.id, space]));

  // Bound as an array parameter rather than interpolated. An empty array is not a special case:
  // `= ANY('{}')` matches no row, so a viewer who can read nothing finds nothing by the same
  // mechanism as everyone else, and there is no early return whose deletion would be invisible.
  const spaceIds = [...byId.keys()];
  const retired = [...RETIRED_STATUSES];

  const rows = await db.$queryRaw<HitRow[]>`
    SELECT p."id"            AS "pageId",
           p."spaceId"       AS "spaceId",
           p."path"          AS "path",
           p."title"         AS "title",
           p."docType"::text AS "docType",
           p."status"::text  AS "status",
           p."publishedAt"   AS "publishedAt",
           ts_rank(p."searchVector", ${tsquery}::tsquery)
             * CASE WHEN p."status"::text = ANY(${retired}) THEN ${RETIRED_RANK_FACTOR}::float4
                    ELSE 1::float4 END AS "rank",
           ts_headline(
             ${SEARCH_CONFIG}::regconfig,
             v."searchText",
             ${tsquery}::tsquery,
             ${HEADLINE_OPTIONS}
           ) AS "headline"
      FROM "Page" p
      -- LEFT, not INNER: see the module docstring. An inner join would exclude unpublished pages
      -- as a side effect of wanting a snippet, and the WHERE clause below would then be
      -- unfalsifiable.
      LEFT JOIN "PageVersion" v ON v."id" = p."publishedVersionId"
     WHERE p."searchVector" @@ ${tsquery}::tsquery
       AND p."spaceId" = ANY(${spaceIds})
       AND p."deletedAt" IS NULL
       AND p."publishedVersionId" IS NOT NULL
       AND (${docType ?? null}::text IS NULL OR p."docType"::text = ${docType ?? null}::text)
       AND (${status ?? null}::text IS NULL OR p."status"::text = ${status ?? null}::text)
     -- publishedAt then id after the rank, so equal ranks come back in a stable order rather
     -- than in whatever order the index scan produced. A result list that reshuffles between
     -- two identical searches reads as a broken product.
     ORDER BY "rank" DESC, p."publishedAt" DESC NULLS LAST, p."id" ASC
     LIMIT ${MAX_SEARCH_RESULTS + 1}`;

  const truncated = rows.length > MAX_SEARCH_RESULTS;
  const hits: SearchHit[] = [];
  /** The spaces this search actually read something out of — the audit's subject, below. */
  const read = new Set<string>();
  for (const row of rows.slice(0, MAX_SEARCH_RESULTS)) {
    // Every row's space came out of the readable set above, so this cannot miss. Skipping rather
    // than asserting keeps a hypothetical miss a missing row instead of a 500 — but it is not a
    // silent filter either: nothing else can put a row here.
    const space = byId.get(row.spaceId);
    if (space === undefined) continue;
    read.add(row.spaceId);
    hits.push({
      pageId: row.pageId,
      spaceKey: space.key,
      spaceName: space.name,
      path: row.path,
      title: row.title,
      docType: row.docType,
      status: row.status,
      isRetired: isRetired(row.status),
      publishedAt: row.publishedAt,
      rank: row.rank,
      snippet: segmentsOf(row.headline),
    });
  }

  // Spec §8's super-admin trace, on the one read surface that reaches into every space at once.
  //
  // `getReadableSpaceByKey` audits a space a super admin *resolves*; search resolves all of them
  // at once, so without this a super admin could read titles and snippets out of every `MEMBERS`
  // space they do not belong to and leave no row anywhere. `auditSpaceAccess` owns the decision
  // about whether an access is auditable (`needsAccessAudit`) and the per-request dedupe, so this
  // is a call site and not a second copy of that rule — and it cannot throw, by construction.
  //
  // Only spaces that actually **produced a hit**. Auditing the enumeration instead would write a
  // row for every `MEMBERS` space on every search, whether or not the search read anything out of
  // it — which is noise, and noise is how an audit table stops being read.
  for (const spaceId of read) {
    const space = byId.get(spaceId);
    if (space !== undefined) await auditSpaceAccess(viewer, space);
  }

  return { ok: true, hits, truncated };
}
