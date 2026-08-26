import { PrismaClient } from "@prisma/client";
import { reindexSearchText } from "../src/lib/search/reindex";

/**
 * `npm run db:reindex` — recompute every stored Markdown strip.
 *
 * The runner and nothing else: the pass itself is `src/lib/search/reindex.ts`, so the seed can
 * call the same function without shelling out and so it is registered in the soft-delete guard
 * like every other module that queries the database.
 *
 * Run it after applying the `search_vector` migration to a database that already has pages, and
 * after any change to `searchTextOf`'s judgements about what a construct contributes. Safe to
 * run repeatedly and safe to interrupt: it writes only rows whose stored strip disagrees with a
 * fresh one, so a second run over an already-reindexed corpus rewrites nothing.
 */
const db = new PrismaClient();

reindexSearchText(db)
  .then(async (report) => {
    console.log(
      `Reindexed ${report.rewritten} of ${report.scanned} versions.`,
    );
    await db.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
