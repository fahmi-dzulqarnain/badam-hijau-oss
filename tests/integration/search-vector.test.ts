import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage, type PublishResult } from "@/lib/pages/publish";
import { movePage } from "@/lib/pages/move";
import { reindexSearchText } from "@/lib/search/reindex";
import { SEARCH_CONFIG } from "@/lib/search/config";
import type { DocStatus, DocType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Task 2's index, against the real database — which is the only place it can be tested.
 *
 * Every claim in this file is a claim about a **trigger**: that the vector is built when a row is
 * written, from three columns two of which live on another table, and that it stays right when
 * the writer had no idea the column existed. None of that is observable from application code —
 * a stubbed client would agree with any of it — and the whole reason §13 asks for a trigger
 * rather than for a line in `publishPage` is the class of writes `publishPage` never sees.
 *
 * **A stale index is invisible.** Every failure mode of search reads to a user as "that page does
 * not exist", so the assertions here are about the vector's contents rather than about a query
 * returning something: a test that publishes and then searches passes over an index that is
 * right by luck and stale by construction.
 */

/** Every distinctive word in the fixture, so a lexeme landing in the wrong band is visible. */
const TITLE_WORD = "bunkering";
const HEADING_WORD = "reconciliation";
const BODY_WORD = "kerosene";

/** Their `english` stems, which is what a `tsvector` actually holds. */
const TITLE_LEXEME = "bunker";
const HEADING_LEXEME = "reconcili";
const BODY_LEXEME = "kerosen";

const documentFor = (heading: string, body: string) =>
  [`## ${heading}`, "", body, ""].join("\n");

async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });

  const asAisyah: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "EDITOR" }],
  };

  /**
   * A page with a draft on it, not yet published.
   *
   * Every field is distinguishable — `slug`, `path` and `title` never share a word — so a
   * trigger reading the wrong column fails here rather than passing by coincidence. Phase 1
   * learned that from a fixture whose fields all defaulted to the node id.
   */
  const drafted = async (args: {
    slug: string;
    title: string;
    markdown: string;
    docType?: DocType;
    status?: DocStatus;
  }) => {
    const page = await db.page.create({
      data: {
        spaceId: space.id,
        slug: args.slug,
        path: args.slug,
        title: args.title,
        docType: args.docType ?? "DOC",
        status: args.status ?? "DRAFT",
        createdById: aisyah.id,
      },
      select: { id: true, path: true, title: true },
    });
    await db.pageDraft.create({
      data: {
        pageId: page.id,
        title: args.title,
        markdown: args.markdown,
        updatedById: aisyah.id,
      },
    });
    return page;
  };

  return { space, aisyah, asAisyah, drafted };
}

/** Narrows to the success branch, failing with the actual result if it is not one. */
function published(result: PublishResult) {
  if (!result.ok) throw new Error(`expected a publish, got ${JSON.stringify(result)}`);
  return result.page;
}

/**
 * The stored vector as Postgres renders it — `'bunker':1A 'kerosen':4C`.
 *
 * Raw, and it has to be: `Page.searchVector` is `Unsupported("tsvector")` and so is **absent
 * from the generated client** entirely. There is no `select` that can reach it, which is a
 * property of the design rather than an inconvenience — the column is derived, and the only
 * thing that writes it is the trigger.
 */
async function vectorOf(pageId: string): Promise<string> {
  const rows = await db.$queryRaw<{ vector: string | null }[]>`
    SELECT "searchVector"::text AS vector FROM "Page" WHERE "id" = ${pageId}`;
  const vector = rows[0]?.vector;
  if (vector === undefined) throw new Error(`no Page row ${pageId}`);
  if (vector === null) {
    throw new Error(
      `Page ${pageId} has a NULL search vector. Nothing may leave one: the trigger is ` +
        "BEFORE INSERT OR UPDATE, so a row cannot be written without one.",
    );
  }
  return vector;
}

/**
 * Lexeme → the set of weight letters it carries.
 *
 * Weights are the whole point of the formula, and a substring check on the rendered vector
 * cannot see them: `'bunker':1A` and `'bunker':1C` both contain "bunker". Parsing is what makes
 * "the title is at A" a falsifiable statement — and it is what fails when two `setweight` calls
 * are swapped, which is a mutation that changes no lexeme and no row count.
 */
function weights(vector: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of vector.matchAll(/'((?:[^']|'')*)':(\S+)/g)) {
    const lexeme = match[1]!.replace(/''/g, "'");
    const letters = found.get(lexeme) ?? new Set<string>();
    for (const position of match[2]!.split(",")) {
      // A weight-D position is rendered as a bare number with no letter.
      letters.add(position.replace(/^\d+/, "") || "D");
    }
    found.set(lexeme, letters);
  }
  return found;
}

/** The weight letters one lexeme carries, or `[]` if the vector does not hold it at all. */
const weightsOf = (vector: string, lexeme: string): string[] =>
  [...(weights(vector).get(lexeme) ?? [])].sort();

/** `ts_rank` of a page's stored vector against what a person typed. */
async function rankOf(pageId: string, query: string): Promise<number> {
  const rows = await db.$queryRaw<{ rank: number }[]>`
    SELECT ts_rank("searchVector", websearch_to_tsquery('english', ${query})) AS rank
      FROM "Page" WHERE "id" = ${pageId}`;
  const rank = rows[0]?.rank;
  if (rank === undefined) throw new Error(`no Page row ${pageId}`);
  return rank;
}

// ── The vector a publish builds ───────────────────────────────────────────────────────────

/**
 * The formula, band by band. Kills every `setweight` swap and every dropped term.
 *
 * Three separate assertions rather than one on the whole rendered string, because the string
 * also carries positions, which are an artefact of where a word happens to sit in the document
 * and would make this test fail on an unrelated edit to the fixture's prose.
 */
test("a publish weights the title A, the headings B and the body C", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });

  published(await publishPage(asAisyah, page.id));
  const vector = await vectorOf(page.id);

  expect(weightsOf(vector, TITLE_LEXEME)).toEqual(["A"]);
  // B **and** C: `searchTextOf` deliberately keeps heading text in the body text, so a heading
  // word is counted twice. Task 1 argues why removing it re-opens an h1/h4 hole and breaks
  // snippets for title matches; if it ever has to go, it goes in the trigger, not in the strip.
  expect(weightsOf(vector, HEADING_LEXEME)).toEqual(["B", "C"]);
  expect(weightsOf(vector, BODY_LEXEME)).toEqual(["C"]);
});

/**
 * The weights doing the job they exist for, at the layer Task 3 will read them from.
 *
 * The band assertions above pin where each term lands; this pins that landing there *means*
 * something. `ts_rank`'s default weights are `{D,C,B,A} = {0.1, 0.2, 0.4, 1.0}`, so a title
 * match must outrank a body match on the same page. Swap the `A` and `C` arguments in the
 * trigger and this inverts.
 */
test("a title match outranks a body match", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  const title = await rankOf(page.id, TITLE_WORD);
  const heading = await rankOf(page.id, HEADING_WORD);
  const body = await rankOf(page.id, BODY_WORD);

  expect(title).toBeGreaterThan(heading);
  expect(heading).toBeGreaterThan(body);
  // Non-vacuity: three numbers in descending order prove nothing if they are all zero.
  expect(body).toBeGreaterThan(0);
});

/**
 * The empty strip, which is a legitimate answer and not a failure.
 *
 * Publish refuses an empty *body*; a body that is only a Mermaid diagram is not empty, and
 * `searchTextOf` correctly returns `""` for it — recovering the label prose would mean parsing
 * Mermaid, which is the second grammar `src/lib/search/text.ts` exists to refuse. So this page
 * is findable by its title and by nothing else, deliberately, and the columns are
 * `NOT NULL DEFAULT ''` so that "no prose" and "not computed" are not the same value.
 */
test("a page whose whole body is one Mermaid diagram publishes, and is indexed by its title", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: ["```mermaid", "C4Context", `  Person(cashier, "${BODY_WORD}")`, "```", ""].join("\n"),
  });

  const result = published(await publishPage(asAisyah, page.id));
  const version = await db.pageVersion.findUniqueOrThrow({
    where: { id: result.versionId },
    select: { searchText: true, searchHeadings: true },
  });

  expect(version).toEqual({ searchText: "", searchHeadings: "" });
  const vector = await vectorOf(page.id);
  expect(weightsOf(vector, TITLE_LEXEME)).toEqual(["A"]);
  expect(weightsOf(vector, BODY_LEXEME)).toEqual([]);
});

/**
 * An unpublished page has a vector, and that is deliberate.
 *
 * §13 says an unpublished draft never appears in results, and Task 3 delivers it as
 * `publishedVersionId IS NOT NULL` in the query. If the trigger left drafts unindexed instead,
 * that predicate would be **unfalsifiable** — deleting it would change nothing and its test
 * would pass over a query with no such filter. The `Page` row is real; the query is what hides
 * it.
 */
test("an unpublished page is indexed by its title alone, for Task 3 to filter out", async () => {
  const { drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });

  const vector = await vectorOf(page.id);
  expect(weightsOf(vector, TITLE_LEXEME)).toEqual(["A"]);
  expect(weightsOf(vector, BODY_LEXEME)).toEqual([]);
});

// ── Writes that are not publishes ─────────────────────────────────────────────────────────

/**
 * **The reason this is a trigger and not a line in `publishPage`.**
 *
 * A raw `UPDATE` on `Page.title` — no Prisma, no application code, nothing that has ever heard
 * of a search index — and the vector follows it. That write is not hypothetical: `movePage` and
 * `deletePage` already write `Page` with `$executeRaw`, and a rename, a data repair from `psql`
 * or a future migration would all arrive the same way. With the vector maintained in publish,
 * every one of them leaves the index describing a title the page no longer has, and the page
 * goes on being findable by its old name and unfindable by its new one — silently.
 *
 * This is also the honest version of the plan's "the vector goes stale after a status change".
 * It does not: `status` is not an input to the vector — see the next test — so no write that
 * only changes `status` can make it stale. What makes it stale is a write to one of the three
 * inputs, and this is the smallest write that is one.
 */
test("a raw UPDATE of the title moves the vector, with no application code involved", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  await db.$executeRaw`UPDATE "Page" SET "title" = 'Marine gasoil register' WHERE "id" = ${page.id}`;

  const vector = await vectorOf(page.id);
  expect(weightsOf(vector, TITLE_LEXEME)).toEqual([]);
  expect(weightsOf(vector, "gasoil")).toEqual(["A"]);
  // The other two bands are untouched: they come from the version, which this write did not
  // change. A trigger that rebuilt only what it was given would blank them.
  expect(weightsOf(vector, HEADING_LEXEME)).toEqual(["B", "C"]);
  expect(weightsOf(vector, BODY_LEXEME)).toEqual(["C"]);
});

/**
 * A Phase 3 cascade — a real one, fired by publishing an ADR that supersedes another.
 *
 * `applyCascade` writes the **target's** `Page` row with `updateMany`, which is a write
 * `publishPage` makes about a page it is not publishing. The vector must come out of it
 * correct, and correct here means *unchanged*: `status` is a filter, not text.
 *
 * **`status` is deliberately not in the vector, and this is where to say so.** §13 lists it as a
 * filter and Task 3 puts it in the `WHERE` clause, where it is exact. Indexing `SUPERSEDED` as a
 * lexeme would make a page whose prose discusses superseding match a status filter spelled as a
 * word, and §6.4's demotion of retired pages is a multiplier on `ts_rank` — a thumb on the
 * scale — not a term in the vector.
 */
test("a cascade retiring a page leaves that page's vector intact", async () => {
  const { asAisyah, drafted } = await fixture();

  const target = await drafted({
    slug: "adr-0030-topic-layout",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
    docType: "ADR",
  });
  published(await publishPage(asAisyah, target.id, { status: "ACCEPTED" }));
  const before = await vectorOf(target.id);

  const successor = await drafted({
    slug: "adr-0042-topic-naming",
    title: "Topic naming",
    docType: "ADR",
    markdown: ["---", "status: ACCEPTED", `supersedes: ${target.path}`, "---", "", "Replaces it.", ""].join("\n"),
  });
  published(await publishPage(asAisyah, successor.id));

  const retired = await db.page.findUniqueOrThrow({
    where: { id: target.id },
    select: { status: true },
  });
  // Non-vacuity: an assertion that the vector is unchanged after a cascade proves nothing if no
  // cascade happened.
  expect(retired.status).toBe("SUPERSEDED");
  expect(await vectorOf(target.id)).toBe(before);
  expect(weightsOf(before, BODY_LEXEME)).toEqual(["C"]);
});

/**
 * A Phase 2 move, whose subtree rewrite is a single hand-written `$executeRaw` over `Page`.
 *
 * Same shape as the cascade and the same answer: the vector is correct after it, and correct
 * means unchanged. **`path` and `slug` are deliberately not in the vector.** Task 1 already drew
 * that line for link URLs — `[Runbook](https://…)` indexes "Runbook", not the address — and a
 * path is the same object one level up: it is assembled from slugs, which are assembled from the
 * title, which is already at weight `A`. Indexing it would double-count the title in a
 * hyphen-split form and would make every page in `architecture/` match a search for
 * "architecture".
 *
 * The new slug carries a word that appears nowhere else in the fixture, so "the path is not
 * indexed" is an assertion rather than a hope.
 */
test("a move rewriting the path leaves the vector intact, and the path is not in it", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));
  const before = await vectorOf(page.id);

  const moved = await movePage(asAisyah, page.id, {
    newParentId: null,
    newSlug: "manifold-inspection",
  });
  if (!moved.ok) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);

  expect(moved.page.path).toBe("manifold-inspection");
  expect(await vectorOf(page.id)).toBe(before);
  expect(weightsOf(before, "manifold")).toEqual([]);
  expect(weightsOf(before, "hydrant")).toEqual([]);
});

/**
 * The write nothing in the product makes yet, and the one a rollback will be.
 *
 * Repointing `publishedVersionId` at an earlier version changes what the page *says* without
 * changing a single character of it, and it is the case where application-side maintenance is
 * least likely to be remembered — there is no `searchText` in sight. The trigger reads the
 * pointer, so the index follows the pointer.
 */
test("repointing publishedVersionId at an older version re-indexes the page", async () => {
  const { asAisyah, aisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  const first = published(await publishPage(asAisyah, page.id));

  await db.pageDraft.create({
    data: {
      pageId: page.id,
      title: `The ${TITLE_WORD} log`,
      markdown: documentFor(`${HEADING_WORD} rules`, "Every drum of naphtha is weighed."),
      updatedById: aisyah.id,
    },
  });
  published(await publishPage(asAisyah, page.id));

  expect(weightsOf(await vectorOf(page.id), "naphtha")).toEqual(["C"]);
  expect(weightsOf(await vectorOf(page.id), BODY_LEXEME)).toEqual([]);

  await db.$executeRaw`
    UPDATE "Page" SET "publishedVersionId" = ${first.versionId} WHERE "id" = ${page.id}`;

  const rolled = await vectorOf(page.id);
  expect(weightsOf(rolled, BODY_LEXEME)).toEqual(["C"]);
  expect(weightsOf(rolled, "naphtha")).toEqual([]);
});

// ── The backfill ──────────────────────────────────────────────────────────────────────────

/**
 * The migration's own backfill, restated as the invariant it establishes: **no `Page` row may
 * carry a NULL vector**, whatever wrote it.
 *
 * `vectorOf` throws on NULL, so every test in this file is also an assertion of this — but only
 * for rows those tests happened to create. This one states it over the whole table, and it is
 * the shape the migration's `UPDATE "Page" SET "searchVector" = NULL` relies on: that statement
 * is a no-op unless the BEFORE trigger fills the column back in.
 */
test("no page can be left with a NULL vector", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  // The migration's backfill statement, run again. It clears the column on every row and the
  // trigger rebuilds it before the row is written.
  await db.$executeRaw`UPDATE "Page" SET "searchVector" = NULL`;

  const nulls = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM "Page" WHERE "searchVector" IS NULL`;
  expect(nulls[0]?.count).toBe(0n);
  expect(weightsOf(await vectorOf(page.id), BODY_LEXEME)).toEqual(["C"]);
});

/**
 * The half the migration cannot do, and the trigger that carries it onto `Page`.
 *
 * A version written before Phase 4 carries `searchText = ''`, because stripping Markdown needs
 * remark and plpgsql cannot run it. Blanking the columns here reproduces exactly that row, and
 * the assertion in the middle is the one that matters: at that point the page is findable by its
 * title and by **nothing else**, which is what a database that only ran the migration looks
 * like. `reindexSearchText` is what closes it, and it never touches `Page` — the
 * `page_search_vector_from_version` trigger does.
 */
test("the reindex recovers a version written before the columns existed", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  await db.$executeRaw`UPDATE "PageVersion" SET "searchText" = '', "searchHeadings" = ''`;

  const stale = await vectorOf(page.id);
  expect(weightsOf(stale, TITLE_LEXEME)).toEqual(["A"]);
  expect(weightsOf(stale, BODY_LEXEME)).toEqual([]);
  expect(weightsOf(stale, HEADING_LEXEME)).toEqual([]);

  const report = await reindexSearchText(db);
  expect(report).toEqual({ scanned: 1, rewritten: 1 });

  const fixed = await vectorOf(page.id);
  expect(weightsOf(fixed, BODY_LEXEME)).toEqual(["C"]);
  expect(weightsOf(fixed, HEADING_LEXEME)).toEqual(["B", "C"]);
});

/**
 * Re-seeding must stay free of churn — the property `prisma/seed.ts` had to be taught once
 * already, when every run added six identical versions and reshuffled "Recently published".
 *
 * The seed calls the reindex on every run, so a pass that rewrote every row would fire the
 * version trigger for every page each time. It compares instead of stamping.
 */
test("a second reindex rewrites nothing", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  expect(await reindexSearchText(db)).toEqual({ scanned: 1, rewritten: 0 });
});

/**
 * The soft-delete question this module answers by **not** filtering.
 *
 * Task 12 promises a restore puts a page back as it was. A backfill that skipped deleted rows
 * would bring it back searchable by title and nothing else, with nothing anywhere saying so —
 * the invisible-stale-index failure, delivered by a guard that looked like caution. Same
 * direction `move.ts`'s subtree read and `delete.ts`'s subtree read both go, and for the same
 * reason: a soft-deleted row is a row that is coming back.
 *
 * The delete is written directly rather than through `deletePage`, because the question here is
 * about the reindex's filter and not about delete's semantics, which `page-delete.test.ts` owns.
 */
test("the reindex covers a soft-deleted page's version too", async () => {
  const { asAisyah, drafted } = await fixture();
  const page = await drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, `Every ${BODY_WORD} delivery is weighed.`),
  });
  published(await publishPage(asAisyah, page.id));

  await db.$executeRaw`UPDATE "PageVersion" SET "searchText" = '', "searchHeadings" = ''`;
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(await reindexSearchText(db)).toEqual({ scanned: 1, rewritten: 1 });
  expect(weightsOf(await vectorOf(page.id), BODY_LEXEME)).toEqual(["C"]);
});

// ── The two things Prisma will silently take away ─────────────────────────────────────────

/**
 * The measured hazard, pinned.
 *
 * With the GIN index created only in the migration and not declared in `schema.prisma`, a
 * **no-op** `prisma migrate dev` generates one statement — `DROP INDEX "Page_searchVector_idx"` —
 * and the next unrelated migration takes the index with it. Nothing about search breaks
 * functionally; every query becomes a sequential scan, which is exactly the sort of regression
 * that ships. Reproduced on a throwaway database before the `@@index` line was written.
 */
test("the search vector has a GIN index", async () => {
  const rows = await db.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
     WHERE tablename = 'Page' AND indexname = 'Page_searchVector_idx'`;

  expect(rows).toHaveLength(1);
  expect(rows[0]?.indexdef).toContain("USING gin");
});

/**
 * The one thing about this index that cannot be shared between the two languages that maintain
 * it: the text-search configuration.
 *
 * The trigger names it in SQL that ran before any TypeScript was read; Task 3's
 * `websearch_to_tsquery` will name it from `SEARCH_CONFIG`. Mismatch them and the index holds
 * stems while the query asks for whole words — no error, no warning, just an empty result page
 * for a document that plainly contains the term.
 *
 * Three occurrences asserted, not one: the function has three `to_tsvector` calls and a single
 * mismatched band is the mutation a substring check would miss.
 */
test("the trigger builds its lexemes with the configuration the query side names", async () => {
  const rows = await db.$queryRaw<{ definition: string }[]>`
    SELECT pg_get_functiondef('page_search_vector(text,text,text)'::regprocedure) AS definition`;
  const definition = rows[0]?.definition ?? "";

  expect(definition.split(`to_tsvector('${SEARCH_CONFIG}'`)).toHaveLength(4);
  expect(definition.split("to_tsvector(")).toHaveLength(4);
});
