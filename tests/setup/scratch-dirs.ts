import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Temporary directories for tests that run `git`, and the guard that they are not in this
 * checkout — **written without `import.meta`, which is the whole reason this file exists.**
 *
 * `tests/setup/scratch.ts` held all of this until Phase 5 Task 9 needed the same guarantee from a
 * Playwright spec, and the brief for that task said to reuse it. It cannot be reused as it was:
 * that module derives the project root from `import.meta.dirname`, vitest runs it as ESM where
 * that is defined, and **Playwright's TypeScript transform emits CommonJS, where any `import.meta`
 * is a parse error** — measured, with `SyntaxError: Cannot use 'import.meta' outside a module` and
 * `Total: 0 tests in 0 files`, which is a whole spec file silently absent rather than a failure.
 *
 * So the mechanism lives here — one `mkdtemp`, one containment refusal, one list of directories to
 * remove — and *where the checkout is* is the caller's to state, in whichever spelling its runner
 * supports: `scratch.ts` passes an `import.meta.dirname`-derived root for vitest, and a Playwright
 * spec passes a `__dirname`-derived one. The rule is implemented once; only the anchor differs.
 */

/**
 * Directories handed out and not yet removed. Module-level rather than per-file because
 * `fileParallelism: false` (and Playwright's `workers: 1`) means one file runs at a time, and a
 * leaked temporary tree from a failed assertion is a directory nobody deletes.
 */
const made: string[] = [];

/**
 * A fresh temporary directory, **proved not to be inside `projectRoot`**. Absolute, symlinks kept.
 *
 * The guard is the point rather than the `mkdtemp`. These are tests for code whose whole job is to
 * spawn `git` and write files, running *inside* a git repository, and a working directory that
 * quietly resolved to the project root would commit the suite's fixtures into the branch under
 * test. Task 5 measured the shape that makes that plausible: `git rev-parse --show-toplevel` run
 * in a subdirectory answers with the **ancestor's** root, so "am I in a repository?" is `true`
 * everywhere under this checkout.
 */
export async function scratchUnder(projectRoot: string, prefix: string): Promise<string> {
  const root = resolve(projectRoot);
  const dir = await mkdtemp(join(tmpdir(), `badam-git-${prefix}-`));
  const real = resolve(dir);
  if (real === root || real.startsWith(root + "/")) {
    throw new Error(`Refusing to run git tests inside the project checkout: ${real}`);
  }
  made.push(dir);
  return real;
}

/** Remove everything {@link scratchUnder} has handed out. Call from an `afterEach`. */
export async function removeScratchDirs(): Promise<void> {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
}
