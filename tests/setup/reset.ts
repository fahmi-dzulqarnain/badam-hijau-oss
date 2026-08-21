import { config } from "dotenv";

config({ path: ".env.test", override: true });

const { db } = await import("@/lib/db");

export { db };

export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "BugReport", "SpaceMembership", "Space", "User" CASCADE',
  );
}
