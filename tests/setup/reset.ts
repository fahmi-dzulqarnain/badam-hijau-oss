import { config } from "dotenv";

// This dotenv call and the identical one in global-setup.ts are BOTH load-bearing.
// globalSetup mutates process.env in the main Vitest process and workers inherit it;
// this call covers the case where this module is what first constructs the client.
// Deleting either one as "duplication" silently retargets the whole suite.
if (config({ path: ".env.test", override: true, quiet: true }).error) {
  throw new Error(
    ".env.test not found. Refusing to run integration tests: falling back to .env " +
      "would TRUNCATE the development database. Create it with:\n" +
      "  ./scripts/setup-db.sh",
  );
}

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  throw new Error("DATABASE_URL is unset after loading .env.test.");
}
// Assert the suffix rather than the literal name, so this survives a database rename.
if (!new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error(`Refusing to run integration tests against ${databaseUrl}`);
}

// Dynamic import so the environment above is in place before PrismaClient is
// constructed. Defence in depth, not the primary guarantee — see the comment above.
const { db } = await import("@/lib/db");

export { db };

let verifiedDatabase = false;
let tables: string[] | undefined;

export async function resetDb() {
  // Last line of defence: the client could have been constructed from a stale
  // DATABASE_URL before this module evaluated. Checked once per worker.
  if (!verifiedDatabase) {
    const rows = await db.$queryRaw<{ current_database: string }[]>`
      SELECT current_database()`;
    const current = rows[0]?.current_database ?? "";
    if (!current.endsWith("_test")) {
      throw new Error(`Refusing to TRUNCATE "${current}": not a test database.`);
    }
    verifiedDatabase = true;
  }

  // Introspected rather than hardcoded, so a task that adds a table cannot forget to
  // add it here — the old failure mode was a test that passes alone and fails in a suite.
  tables ??= (
    await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `
  ).map((row) => `"${row.tablename}"`);

  if (tables.length === 0) {
    throw new Error("resetDb: no tables found. Did migrations run?");
  }

  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(", ")} CASCADE`);
}
