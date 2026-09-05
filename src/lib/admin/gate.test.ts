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
 * `src/lib/bugs/admin.ts` (Task 8). Task 7's `/admin/git` kept the three names Phase 5 and the
 * plan gave its modules, which this pattern cannot see — they are listed in {@link ALSO_GATED}
 * below rather than left to it.
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
 * Admin entry points that do **not** live in an `admin.ts`, swept anyway.
 *
 * **This list replaced an exemption, and the direction is the point.** Task 5 listed
 * `src/lib/git/failures.ts` here as `NOT_YET_GATED` — a claim that one file was *not* checked,
 * because `/-/mirror` was provisional and Task 7 owned folding it into `/admin/git`: *"a task that
 * changes another task's permission line without owning its tests is how a phase loses an
 * afternoon."* Task 7 owns them, so the file now calls `refuseNonAdmin` like everything else and
 * the entry inverted: from "this one is exempt" to "this one is checked even though the pattern
 * cannot see it". An exemption that outlives its reason is how a sweep quietly stops covering
 * something, so the list a reader meets here is a list of *additional* coverage and there is no
 * exemption list left to grow.
 *
 * All of them are `/admin/git`'s, and none is called `admin.ts`: the first is Phase 5's file under
 * Phase 5's name, and the others are the names Task 7's plan gives its two operator actions —
 * one surface's worth of one subject each. Renaming a module, or collapsing three into a
 * `src/lib/git/admin.ts`, to satisfy a test's pattern would be writing the code to fit its guard.
 */
const ALSO_GATED: readonly string[] = [
  "src/lib/git/failures.ts",
  "src/lib/git/retention.ts",
];

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
  const modules = [...adminModules(SRC), ...ALSO_GATED];
  expect(
    modules.flatMap(ungatedExports),
    "open the function with `const refused = refuseNonAdmin(viewer); if (refused !== null) return refused;`",
  ).toEqual([]);
});

/**
 * The hand-listed modules are real files with real entry points, which is the half a list of
 * strings cannot promise on its own.
 *
 * Without this, a typo in {@link ALSO_GATED} — or a file renamed out from under it — would make
 * the sweep above pass by reading nothing, the "guard pattern that matches nothing looks exactly
 * like a clean codebase" shape this project has now written a companion for **eight** times.
 * `ungatedExports` throws on a missing file, so the first assertion is that the list resolves at
 * all; the second is that each one actually contains a gated entry point taking a viewer, which is
 * what the sweep is looking for.
 */
test("the hand-listed modules exist and each has a gated entry point", () => {
  for (const file of ALSO_GATED) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const gated = source
      .split(/^export /m)
      .filter(
        (chunk) =>
          /^(?:async )?function \w+\(\s*\n?\s*viewer: Viewer/.test(chunk) &&
          /refuseNonAdmin\(viewer\)/.test(chunk),
      );
    expect(gated.length, `${file} states no refusal`).toBeGreaterThanOrEqual(1);
  }
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
