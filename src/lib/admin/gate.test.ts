import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { refuseNonAdmin } from "@/lib/admin/gate";
import type { Viewer } from "@/lib/authz/types";

/**
 * The `/admin` gate: the predicate itself, and the sweep that keeps it the only one.
 *
 * Task 5 is the first of four admin surfaces. The predicate is trivial — one boolean — and that is
 * exactly why it needs a guard rather than attention: `resolveRedirect` carried `readableSpace` in
 * two places and removing either alone left 22 tests green, and Task 4 found the same shape through
 * a read/write pair. A fourth surface spelling its own `if (!viewer.isSuperAdmin)` would not fail
 * anything; it would simply stop being the thing this file can mutate.
 *
 * So there are two claims here:
 *
 * 1. **The predicate answers not-found, not forbidden**, and only for a super admin.
 * 2. **Every exported entry point of every `admin.ts` module states it**, checked by a filesystem
 *    sweep with a non-vacuity companion — the discipline `tests/integration/audit.test.ts` uses
 *    for `writeAudit` and `src/lib/pages/visible.test.ts` uses for soft delete, both of which
 *    exist because a rule implemented in two places is not yet a convention.
 */

const admin: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };
const member: Viewer = {
  id: "u-member",
  isSuperAdmin: false,
  memberships: [{ spaceId: "s-1", role: "ADMIN" }],
};

test("a super admin passes", () => {
  expect(refuseNonAdmin(admin)).toBeNull();
});

/**
 * The discriminating viewer is an **`ADMIN` of a space**, not a stranger.
 *
 * A member of nothing would be refused by any predicate at all, including one that had been
 * mutated to something weaker — the near-vacuity Phase 4 recorded for its non-member search. A
 * space `ADMIN` is the viewer `can(viewer, space, "MANAGE_SPACE")` says yes to, so this assertion
 * is what separates "administers a space" from "administers the installation", which is the
 * distinction `src/lib/admin/gate.ts` argues is structural rather than strict.
 */
test("a space ADMIN who is not a super admin is refused, and told not-found", () => {
  expect(refuseNonAdmin(member)).toEqual({ ok: false, reason: "not-found" });
});

test("the refusal is never forbidden", () => {
  const refusal = refuseNonAdmin(member);
  expect(refusal).not.toBeNull();
  // A `403` from a route that is otherwise `404` tells an ordinary member that the route exists.
  expect(JSON.stringify(refusal)).not.toContain("forbidden");
});

const SRC = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = join(SRC, "..");

/**
 * Every admin module. `admin.ts` under `src/lib/`, which is the file the plan names for each of
 * the four surfaces: `src/lib/systems/admin.ts` (Task 5), `src/lib/spaces/admin.ts` (Task 6),
 * `src/lib/bugs/admin.ts` (Task 8). Task 7's `/admin/git` absorbs `/-/mirror` and may keep
 * `src/lib/git/failures.ts`'s name instead — which this sweep would not see, so it is registered
 * by hand below rather than left to the pattern.
 */
function adminModules(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) adminModules(full, found);
    else if (entry.name === "admin.ts") found.push(relative(ROOT, full));
  }
  return found;
}

/**
 * Admin entry points that do **not** live in an `admin.ts`, listed by hand.
 *
 * `listMirrorFailures` predates this module — Phase 5 Task 8 shipped `/-/mirror` as explicitly
 * provisional, with its own `if (!viewer.isSuperAdmin)` and its own argument for it. It is not
 * rewritten here, because Task 7 owns folding that surface into `/admin/git` and a task that
 * changes another task's permission line without owning its tests is how a phase loses an
 * afternoon. It is named so the exemption is a **claim** rather than an omission — the standard
 * `visible.test.ts` sets with its `reachesPage: false` entries.
 */
const NOT_YET_GATED: Record<string, string> = {
  "src/lib/git/failures.ts":
    "Phase 5 Task 8's provisional `/-/mirror`, which Task 7 folds into `/admin/git`. It states " +
    "its own `viewer.isSuperAdmin` check with its own tests; moving it to `refuseNonAdmin` is " +
    "part of that move, not of this task.",
};

/**
 * One exported function per chunk, split on the `export` keyword at column zero.
 *
 * Crude on purpose: it needs no parser and it over-collects rather than under-collects, which is
 * the safe direction for a guard — a chunk that is not really a function has no `viewer: Viewer`
 * parameter and is skipped, while a function that has one is always seen. "Name the thing you are
 * protecting, not the syntax you expect it to be written in" is the generalisation
 * `visible.test.ts` states; the thing protected here is *an entry point that takes a viewer*.
 */
function ungatedExports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const ungated: string[] = [];
  for (const chunk of source.split(/^export /m).slice(1)) {
    const signature = /^(?:async )?function (\w+)\(([^)]*)/.exec(chunk);
    if (signature === null) continue;
    const [, name, parameters] = signature;
    if (!/viewer\s*:\s*Viewer/.test(parameters ?? "")) continue;
    // The body is everything up to the next `export`, which `split` has already cut.
    if (!/refuseNonAdmin\(viewer\)/.test(chunk)) ungated.push(`${file}#${name}`);
  }
  return ungated;
}

test("every admin entry point states the refusal through refuseNonAdmin", () => {
  const modules = adminModules(SRC).filter((file) => !(file in NOT_YET_GATED));
  expect(
    modules.flatMap(ungatedExports),
    "open the function with `const refused = refuseNonAdmin(viewer); if (refused !== null) return refused;`",
  ).toEqual([]);
});

/**
 * The non-vacuity companion, and this project has needed one **six times**: a guard pattern that
 * matches nothing looks exactly like a clean codebase.
 *
 * Two halves. The sweep finds at least one admin module and at least three gated entry points in
 * it — so the file list is real — and the chunker demonstrably *can* report a miss, proven against
 * a synthetic source rather than against a file that would have to be broken on purpose.
 */
test("the sweep can see an admin module, and would notice an ungated function", () => {
  const modules = adminModules(SRC);
  expect(modules).toContain("src/lib/systems/admin.ts");

  const gated = readFileSync(join(ROOT, "src/lib/systems/admin.ts"), "utf8")
    .split(/^export /m)
    .filter((chunk) => /^(?:async )?function \w+\(\s*\n?\s*viewer: Viewer/.test(chunk));
  expect(gated.length).toBeGreaterThanOrEqual(3);

  // The chunker, run over a module that forgot the gate. Written here rather than planted in
  // `src/`, because a guard that has to break the codebase to prove it works cannot be run twice.
  const forgetful = `export async function listThings(viewer: Viewer): Promise<void> {\n  await db.thing.findMany();\n}\n`;
  const chunks = forgetful.split(/^export /m).slice(1);
  const signature = /^(?:async )?function (\w+)\(([^)]*)/.exec(chunks[0] ?? "");
  expect(signature?.[1]).toBe("listThings");
  expect(/viewer\s*:\s*Viewer/.test(signature?.[2] ?? "")).toBe(true);
  expect(/refuseNonAdmin\(viewer\)/.test(chunks[0] ?? "")).toBe(false);
});
