import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  if (config({ path: ".env.test", override: true }).error) {
    throw new Error(
      ".env.test not found. Refusing to migrate: falling back to .env would run " +
        "migrations against the development database. Create it with:\n" +
        "  ./scripts/setup-db.sh",
    );
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
    throw new Error(
      `Refusing to migrate "${databaseUrl || "<unset>"}": not a test database.`,
    );
  }

  // `--no` stops npx fetching an arbitrary Prisma version from the registry if
  // node_modules is stale — that version would decide which migrations run.
  // The `env` option that used to be here was inert: execSync already defaults to
  // process.env, so setting DATABASE_URL to its own value did nothing.
  execSync("npx --no prisma migrate deploy", { stdio: "inherit" });
}
