#!/usr/bin/env node
// The attachment retention sweep. Run by hand, or from cron — there is deliberately no job
// queue in this phase. The git-mirror phase owns building one, and building it here now would
// mean building it against requirements that do not exist yet.
//
//   node scripts/sweep-attachments.mjs [--dry-run] [--delete-orphans]
//
//   --dry-run          Report what the sweep would do. Makes NO writes: neither the database
//                       nor the blob store is touched. See sweep.ts's `dryRun` option — every
//                       mutation in that module is gated on it, so this is not a best-effort
//                       preview, it is the same read path a real run takes.
//   --delete-orphans   Also delete drive items with no matching row (see sweep.ts, pass 3).
//                       Off by default: a sweep bug that only REPORTS an orphan is a nuisance;
//                       one that DELETES on a bug is data loss. The default has to be the
//                       recoverable one.
//
// SECURITY DOES NOT DEPEND ON THIS SCRIPT, running, succeeding, or ever running at all.
// Whether an attachment is readable is decided by `deletedAt` and `state` on its row, checked
// in SQL on every read (`readableAttachment`, src/lib/attachments/repo.ts). Bytes left behind
// in a private, application-owned SharePoint library after their row is gone are unreachable
// through any path this application exposes to a browser — reclaiming them late, or missing a
// run entirely, is a cost and a tidiness problem, not a hole. Treat a failed or skipped sweep
// as a nuisance to fix on the next run, never as an incident.
//
// CAUTION: this script deletes rows and bytes. Point it at the development database (`.env`,
// loaded below) unless you are certain, and never run it — with or without --dry-run — against
// `badam_test` while the test suite is running: one shared local Postgres, one `badam_test`,
// no per-worktree isolation, and a concurrent `TRUNCATE` from resetDb would not be the only
// casualty.
//
// NODE_ENV must be set the way it would be for whatever database this points at (as `next
// dev`/`vitest` already do for you in those contexts) — this is a bare script, so nothing sets
// it here. `BLOB_STORE=memory` is refused outside a recognised development environment (see
// resolveStoreKind, src/lib/blob/select.ts), which matters if `.env` selects it locally.
//
// This file is plain `.mjs`, imported by plain `node`, but the logic it calls (`sweep.ts`) is
// TypeScript written against the `@/*` path alias every other module in this codebase uses.
// Plain `node` does not resolve that alias — and, on this Node version, importing an
// extensionless "@/lib/db" a SECOND file away from the one `node` was invoked on hits Node's
// OWN native (unflagged since 23.6) `.ts` handling before `tsx`'s loader gets a say, which
// resolves it as a bare CommonJS specifier and fails with `MODULE_NOT_FOUND` — reproduced
// with a two-file chain while writing this script; neither `tsImport()` nor `register()` from
// `tsx/esm/api`, called mid-process, avoided it. Running the ENTIRE process under the `tsx`
// CLI from the start (exactly how `db:seed` already runs) does not hit this, because `tsx`
// installs its loader before anything else executes. So this file re-executes itself under
// that CLI once, the same way a `#!/usr/bin/env -S node --import tsx` shebang would if `node
// scripts/sweep-attachments.mjs` invoked it — which plain `node` does not honour, so the
// re-exec is done here instead, guarded by an env var so it happens exactly once.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.__SWEEP_ATTACHMENTS_UNDER_TSX__) {
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const thisFile = fileURLToPath(import.meta.url);
  const result = spawnSync(
    process.execPath,
    [tsxCli, thisFile, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __SWEEP_ATTACHMENTS_UNDER_TSX__: "1" } },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

import { config } from "dotenv";
// Loads `.env` — the DEVELOPMENT database and the store this deployment actually uses — not
// `.env.test`. Unlike tests/setup/reset.ts, a missing file here is not fatal: a real deployment
// is expected to inject `DATABASE_URL`, `BLOB_STORE`, and friends directly into the process
// environment, with no `.env` file on disk at all, and this script has to run there too.
config({ quiet: true });

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const deleteOrphans = argv.includes("--delete-orphans");
  const unknown = argv.filter((arg) => arg !== "--dry-run" && arg !== "--delete-orphans");
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognised argument(s): ${unknown.join(", ")}. ` +
        "Only --dry-run and --delete-orphans are accepted.",
    );
  }
  return { dryRun, deleteOrphans };
}

function retentionDaysFromEnv(env) {
  const raw = env.ATTACHMENT_RETENTION_DAYS;
  const days = Number(raw);
  // No default, on purpose — the same discipline resolveStoreKind (src/lib/blob/select.ts)
  // applies to BLOB_STORE. Guessing a retention window is a policy decision this script has
  // no basis to make silently; refusing to run is the loud failure.
  if (!raw || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      `ATTACHMENT_RETENTION_DAYS must be set to a positive number, got ` +
        `${JSON.stringify(raw ?? null)}.`,
    );
  }
  return days;
}

async function main() {
  const { dryRun, deleteOrphans } = parseArgs(process.argv.slice(2));
  const retentionDays = retentionDaysFromEnv(process.env);

  const { sweepAttachments } = await import("@/lib/attachments/sweep.ts");
  const { blobStore } = await import("@/lib/blob/select.ts");

  const report = await sweepAttachments({
    store: blobStore(),
    now: new Date(),
    retentionDays,
    deleteOrphans,
    dryRun,
  });

  const tag = dryRun ? "[dry run] " : "";
  const verb = dryRun ? "would remove" : "removed";
  console.log(`${tag}abandoned uploads: ${verb} ${report.abandonedUploads}`);
  console.log(`${tag}expired (past retention): ${verb} ${report.expired}`);
  console.log(
    deleteOrphans
      ? `${tag}orphaned drive items: ${dryRun ? "would delete" : "deleted"} ${report.orphans.length}`
      : `${tag}orphaned drive items: found ${report.orphans.length}, none deleted ` +
          "(pass --delete-orphans to delete them)",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
