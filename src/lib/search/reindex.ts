import type { PrismaClient } from "@prisma/client";
import { searchFieldsOf } from "@/lib/search/fields";

/** What one reindex pass looked at and what it changed. */
export type ReindexReport = {
  /** `PageVersion` rows read. */
  scanned: number;
  /** Of those, the ones whose stored strip did not match a fresh one. */
  rewritten: number;
};

/**
 * How many versions are read and re-stripped per round trip.
 *
 * The whole markdown of each row is in memory at once, so this bounds memory rather than time:
 * `MAX_DRAFT_BODY_BYTES` is the cap on one document, and a hundred of them is a few megabytes.
 * The write is one statement per changed row and not a batch, deliberately — see below.
 */
const BATCH = 100;

/**
 * Recomputes `PageVersion.searchText` and `searchHeadings` from stored Markdown.
 *
 * ## Why this exists at all
 *
 * The `search_vector` migration can create the columns, the trigger and the index, and it can
 * backfill `Page.searchVector` — but it cannot fill the two text columns, because stripping
 * Markdown needs remark and plpgsql cannot run it. So every version written before that
 * migration carries the `''` default, and every page published before it is searchable by its
 * **title only**. A migration that leaves the seeded pages half-indexed is one that passes every
 * test and fails on first use, which is what this closes.
 *
 * It is not only a one-off. `searchTextOf` is a set of judgements about what a construct
 * contributes, and those judgements will be corrected — the moment one is, every stored strip is
 * a version of the old rule. Running this makes the corpus agree with the current code again,
 * which is why it recomputes and compares rather than filtering for `''`.
 *
 * ## Nothing here touches `Page`, and the vector still moves
 *
 * That is the `page_search_vector_from_version` trigger's entire job: an `UPDATE` on
 * `PageVersion` that changes either strip fires it, and it rewrites `Page.searchVector` for the
 * page publishing that version. Doing it from here instead — a second `page.update` per row —
 * would be the application maintaining the index in a second place, which is what §13's trigger
 * exists to prevent. The trigger's `WHEN` clause is also why the comparison below matters: an
 * unchanged row is not written, so it fires nothing.
 *
 * ## No permission predicate, and no soft-delete filter, both deliberate
 *
 * **No viewer.** This is a maintenance pass over the whole corpus, run from a CLI by whoever can
 * already reach the database. There is no viewer to state a predicate about, it returns two
 * integers and names no page, and it changes no fact about who may read what — the vector it
 * refreshes is filtered by `readableSpace`-derived space ids at query time, in Task 3, which is
 * the one place that question is asked.
 *
 * **No `visiblePage()`.** A soft-deleted page's version is reindexed like any other, and the
 * absence is the point rather than an oversight: Task 12 promises a restore puts a page back as
 * it was, and a page restored into a corpus that skipped it would come back searchable by title
 * and nothing else, with no signal that anything was missing. The same argument the migration's
 * backfill makes for including deleted rows.
 *
 * ## One statement per changed row
 *
 * Not a batched `updateMany`: the new value differs per row, so a batch would be one statement
 * per distinct value anyway. More to the point, the trigger is `FOR EACH ROW` and fires either
 * way, and a per-row write is what lets the count below be a count of rows actually changed
 * rather than of rows visited.
 */
export async function reindexSearchText(
  db: PrismaClient,
  options: { onBatch?: (report: ReindexReport) => void } = {},
): Promise<ReindexReport> {
  const report: ReindexReport = { scanned: 0, rewritten: 0 };

  // Keyset pagination on the primary key, not `skip`/`take`. A publish landing mid-run inserts a
  // version with a fresh cuid, and an offset would then either skip a row or read one twice;
  // ordering by id and carrying the last one seen cannot.
  let after: string | undefined;

  for (;;) {
    const versions = await db.pageVersion.findMany({
      where: after === undefined ? undefined : { id: { gt: after } },
      orderBy: { id: "asc" },
      take: BATCH,
      // Explicit select, never `include`.
      select: { id: true, markdown: true, searchText: true, searchHeadings: true },
    });
    if (versions.length === 0) break;

    for (const version of versions) {
      report.scanned += 1;
      const fields = await searchFieldsOf(version.markdown);
      if (
        fields.searchText === version.searchText &&
        fields.searchHeadings === version.searchHeadings
      ) {
        continue;
      }
      await db.pageVersion.update({
        where: { id: version.id },
        data: fields,
        select: { id: true },
      });
      report.rewritten += 1;
    }

    after = versions[versions.length - 1]?.id;
    options.onBatch?.({ ...report });
  }

  return report;
}
