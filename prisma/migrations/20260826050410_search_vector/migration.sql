-- Spec §13's search index: a weighted `tsvector` on `Page`, maintained by a trigger.
--
-- The columns and the GIN index below this line are Prisma's own output, unedited. Everything
-- from `page_search_vector` down is hand-written, because Prisma models no functions and no
-- triggers — which cuts both ways and was measured on a throwaway database before any of this
-- was written:
--
--   * a trigger created here SURVIVES every later `prisma migrate dev`. Prisma's diff cannot
--     see it, so it never generates a drop for it and never reports it as drift;
--   * a trigger created BY HAND against a database also survives, and that is the trap — it is
--     equally invisible, so it exists on the machine that ran it and on no fresh database ever
--     provisioned afterwards. A trigger that is not in a migration is not deployed;
--   * the GIN index is the opposite case. Prisma DOES model indexes, so an index created only
--     here and not declared in `schema.prisma` is diffed as an extra and the next unrelated
--     `prisma migrate dev` emits `DROP INDEX "Page_searchVector_idx"`. Reproduced: with the
--     index missing from the schema, a no-op `migrate dev` generated exactly that one statement
--     and nothing else. It is declared in `schema.prisma`, which is why the CreateIndex below
--     is Prisma's own and not hand-written.

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "searchVector" tsvector;

-- AlterTable
ALTER TABLE "PageVersion" ADD COLUMN     "searchHeadings" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '';

-- The weighting, in one place, so the two triggers below cannot disagree about it.
--
-- Weights A/B/C are §13's. The three inputs are the only three: `title` from the `Page` row,
-- `searchHeadings` and `searchText` from the version that page publishes. Everything else on
-- `Page` is deliberately absent and each absence has a reason:
--
--   * `status`, `docType`, `spaceId` are FILTERS, not text. §13 lists them as filters and Task
--     3 puts them in the `WHERE` clause, where they are exact. Indexing `ACCEPTED` as a lexeme
--     would make a page about acceptance testing match a status filter spelled as a word.
--   * `path` and `slug` are addresses. Task 1 already drew this line for link URLs — `[Runbook]
--     (https://…)` indexes "Runbook" and not the address — and a path is the same object: it is
--     assembled from slugs, which are assembled from the title, which is already at weight A.
--     Indexing it would double-count the title in a mangled, hyphen-split form.
--   * `frontmatter` is metadata. `supersedes: decisions/adr-0031` matching a search for
--     "decisions" puts a page in results over a word no reader can see on it; `searchTextOf`
--     makes the same argument at the other end of the pipeline, and the typed columns that
--     carry frontmatter are queryable as filters.
--
-- The configuration name appears three times in this file and cannot be shared with the
-- application, which is TypeScript and read long after this SQL ran. `src/lib/search/config.ts`
-- holds the same string for the query side, and an integration test reads
-- `pg_get_functiondef` on this function and fails if the two ever differ — a mismatch is an
-- index full of stems and a query asking for whole words, which reads as "no results".
--
-- IMMUTABLE is true and load-bearing: the two-argument `to_tsvector(regconfig, text)` is
-- immutable (the one-argument form is only STABLE, because it reads `default_text_search_config`
-- from the session). Writing it without the explicit configuration would make the whole function
-- session-dependent and the index it fills unreproducible.
CREATE FUNCTION page_search_vector(title text, headings text, body text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT setweight(to_tsvector('english', coalesce(title, '')), 'A')
      || setweight(to_tsvector('english', coalesce(headings, '')), 'B')
      || setweight(to_tsvector('english', coalesce(body, '')), 'C')
$$;

-- The `Page` side: BEFORE INSERT OR UPDATE, on the row's own write.
--
-- BEFORE and assigning `NEW`, rather than AFTER and issuing a second `UPDATE`: the second
-- statement would re-enter this trigger, and stopping that needs a recursion guard which is one
-- more thing to get wrong. Assigning `NEW` costs nothing and cannot loop.
--
-- Unconditional — no `WHEN` clause narrowing it to writes that touch `title` or
-- `publishedVersionId`. That is the whole reason §13 asks for a trigger rather than for
-- application code: the vector cannot drift from its row, whatever wrote the row and whether or
-- not the writer knew the column existed. A `WHEN` clause would be a fourth list of "which
-- columns feed the vector", kept in step by hand with the function above, and the day it fell
-- behind the index would go stale silently — which is the failure mode that reads to a user as
-- "that page does not exist". The cost is one indexed lookup and one `to_tsvector` per `Page`
-- write; a subtree move of forty pages pays it forty times, on a statement that is already
-- rewriting forty rows.
--
-- `publishedVersionId IS NULL` — an unpublished page — yields a vector built from the title
-- alone, and that is deliberate rather than a null vector. Task 3 owns "an unpublished draft
-- never appears in results" and states it as `publishedVersionId IS NOT NULL` in the query; if
-- this trigger left drafts unindexed instead, that predicate would be unfalsifiable — deleting
-- it would change nothing and its test would pass over a query with no such filter.
CREATE FUNCTION page_search_vector_refresh() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_headings text;
  v_body text;
BEGIN
  IF NEW."publishedVersionId" IS NOT NULL THEN
    SELECT "searchHeadings", "searchText"
      INTO v_headings, v_body
      FROM "PageVersion"
     WHERE "id" = NEW."publishedVersionId";
  END IF;

  NEW."searchVector" := page_search_vector(NEW."title", v_headings, v_body);
  RETURN NEW;
END
$$;

CREATE TRIGGER page_search_vector_refresh
BEFORE INSERT OR UPDATE ON "Page"
FOR EACH ROW
EXECUTE FUNCTION page_search_vector_refresh();

-- The `PageVersion` side, which exists for exactly one thing: a write that changes the stored
-- strip of a version some page is already publishing.
--
-- Nothing in the product does that — a version is immutable once written, and publish inserts
-- the version BEFORE it points `Page.publishedVersionId` at it, so the `Page` write above is
-- what indexes a publish. What does do it is `prisma/reindex.ts`, the backfill: it recomputes
-- `searchText`/`searchHeadings` from stored Markdown for versions that already exist. Without
-- this trigger that backfill would have to remember to touch every `Page` row afterwards, and
-- "remember to" is the application-side maintenance the whole design is refusing.
--
-- AFTER UPDATE only:
--   * not INSERT, because at insert time no `Page` row can point at the new version yet — the
--     pointer is set by a later statement, which fires the trigger above. An INSERT trigger here
--     would match zero rows on every publish, forever;
--   * not DELETE, because `PageVersion` deletion cascades from `Page`, so there is no surviving
--     row to refresh.
--
-- The `WHEN` clause and not `UPDATE OF ("searchText", "searchHeadings")`: `UPDATE OF` fires when
-- a column is *mentioned* in the SET list, which the reindex does for every row it visits
-- including the ones it leaves unchanged. `IS DISTINCT FROM` is the predicate that actually
-- matters, and stating both would be one rule in two places with only one of them testable.
--
-- The `UPDATE` below re-enters `page_search_vector_refresh`, which recomputes the same value
-- from the same three inputs — the version row it reads is this statement's own new version,
-- since that statement has already completed. Assigning it here as well is not a race with that
-- recomputation: both calls are the same IMMUTABLE function on the same arguments. It is written
-- out rather than left as a bare touch (`SET "searchVector" = NULL`) because a statement whose
-- effect depends entirely on a trigger somewhere else is the kind of line a later reader deletes.
CREATE FUNCTION page_search_vector_from_version() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "Page"
     SET "searchVector" = page_search_vector("title", NEW."searchHeadings", NEW."searchText")
   WHERE "publishedVersionId" = NEW."id";
  RETURN NULL;
END
$$;

CREATE TRIGGER page_search_vector_from_version
AFTER UPDATE ON "PageVersion"
FOR EACH ROW
WHEN (OLD."searchText" IS DISTINCT FROM NEW."searchText"
   OR OLD."searchHeadings" IS DISTINCT FROM NEW."searchHeadings")
EXECUTE FUNCTION page_search_vector_from_version();

-- Backfill. Every `Page` row that existed before this migration has a NULL vector, and a NULL
-- vector matches nothing: the seeded pages would be invisible to search on a database that was
-- not created from scratch, which passes every test and fails on first use.
--
-- Setting the column to NULL and letting the BEFORE trigger fill it is not a trick — it is the
-- backfill running through the same code path every later write will, so there is no second
-- expression here that could disagree with the function above. It also proves the trigger works
-- at migration time: if the trigger were missing or broken, every row would be left NULL rather
-- than quietly half-right.
--
-- Soft-deleted rows are included. They have a vector like any other; Task 3's query is what
-- excludes them, and a restore must not need a reindex to become searchable again.
--
-- What this cannot do is recover `PageVersion.searchText` for versions written before this
-- migration: stripping Markdown needs remark, and plpgsql cannot run it. Those rows keep the
-- `''` default, so a pre-existing page is searchable by TITLE here and by its body only once
-- `prisma/reindex.ts` has run — which `prisma/seed.ts` calls on every seed, so `npm run db:seed`,
-- `npm run smoke` and the E2E suite all close the gap without anyone remembering to.
UPDATE "Page" SET "searchVector" = NULL;

-- CreateIndex
CREATE INDEX "Page_searchVector_idx" ON "Page" USING GIN ("searchVector" tsvector_ops);
