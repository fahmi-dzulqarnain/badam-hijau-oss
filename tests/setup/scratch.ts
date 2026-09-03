import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A temporary directory for a test that runs `git`, **proved not to be inside this checkout**.
 *
 * Phase 5 Task 5 wrote this inside `src/lib/git/repo.test.ts`; Task 6 needs the identical
 * guarantee from `tests/integration/git-worker.test.ts`, and this project's rule is that a rule
 * implemented in two places is not yet a convention. So it lives here and both import it. It is
 * deliberately **not** a `.test.ts` file: vitest's `include` globs collect those, and a test file
 * imported by another test file has its cases registered twice.
 *
 * The guard is the point rather than the `mkdtemp`. These are tests for code whose whole job is to
 * spawn `git` and write files, running *inside* a git repository, and a working directory that
 * quietly resolved to the project root would commit the suite's fixtures into the branch under
 * test. Task 5 measured the shape that makes that plausible: `git rev-parse --show-toplevel` run
 * in a subdirectory answers with the **ancestor's** root, so "am I in a repository?" is `true`
 * everywhere under this checkout.
 *
 * `PROJECT_ROOT` is derived from this file's own location, so moving the file cannot silently
 * point the guard somewhere harmless.
 */
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Directories handed out and not yet removed. Module-level rather than per-file because
 * `fileParallelism: false` means one file runs at a time, and a leaked temporary tree from a
 * failed assertion is a directory nobody deletes.
 */
const made: string[] = [];

/** A fresh temporary directory, registered for {@link removeScratchDirs}. Absolute, symlinks kept. */
export async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `badam-git-${prefix}-`));
  const real = resolve(dir);
  if (real === PROJECT_ROOT || real.startsWith(PROJECT_ROOT + "/")) {
    throw new Error(`Refusing to run git tests inside the project checkout: ${real}`);
  }
  made.push(dir);
  return real;
}

/** Remove everything {@link scratch} has handed out. Call from an `afterEach`. */
export async function removeScratchDirs(): Promise<void> {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
}
