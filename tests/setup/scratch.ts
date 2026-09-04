import { resolve } from "node:path";
import { removeScratchDirs, scratchUnder } from "./scratch-dirs";

/**
 * The vitest suites' entry point to a temporary directory for a test that runs `git`, **proved
 * not to be inside this checkout**.
 *
 * Phase 5 Task 5 wrote this inside `src/lib/git/repo.test.ts`; Task 6 needs the identical
 * guarantee from `tests/integration/git-worker.test.ts`, and this project's rule is that a rule
 * implemented in two places is not yet a convention. So it lives here and both import it. It is
 * deliberately **not** a `.test.ts` file: vitest's `include` globs collect those, and a test file
 * imported by another test file has its cases registered twice.
 *
 * **Task 9 split the mechanism out into `./scratch-dirs`, and the reason is a module system rather
 * than a design.** A Playwright spec needs the same directory and the same guard, and Playwright's
 * TypeScript transform emits CommonJS, where the `import.meta.dirname` below is a *parse* error
 * that takes the whole spec file out of the run without failing it. That module therefore holds
 * the `mkdtemp`, the containment refusal and the removal list, and each runner states the project
 * root in the spelling it supports. This file is the ESM half.
 *
 * `PROJECT_ROOT` is derived from this file's own location, so moving the file cannot silently
 * point the guard somewhere harmless.
 */
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

/** A fresh temporary directory, registered for {@link removeScratchDirs}. Absolute, symlinks kept. */
export async function scratch(prefix: string): Promise<string> {
  return await scratchUnder(PROJECT_ROOT, prefix);
}

/**
 * Re-exported so the two vitest importers are unchanged by the split — and so the *state* stays
 * single: `scratch-dirs` keeps one list of directories to remove, and a second copy of that list
 * would be a directory nobody deletes.
 */
export { removeScratchDirs };
