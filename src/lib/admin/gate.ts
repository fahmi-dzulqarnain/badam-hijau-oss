import type { Viewer } from "@/lib/authz/types";

/**
 * The one refusal predicate every `/admin` surface shares — spec §11's four admin routes, §8's
 * *"a refusal is not-found"*.
 *
 * Pure: a `Viewer` in, a refusal or nothing out, nothing imported from Prisma.
 *
 * ## Why this is a module and not a line in each admin module
 *
 * Task 5 is the first `/admin` surface and Tasks 6, 7 and 8 are three more — spaces, the git
 * mirror, bug reports. A permission predicate spelled four times is what `readableSpace`'s
 * docstring exists to prevent, and this project has measured the cost twice: `resolveRedirect`
 * carried `readableSpace` in two places and **removing either one alone left all 22 tests
 * passing**, and Task 4 found the same shape arriving through a read/write pair. Four copies of
 * `if (!viewer.isSuperAdmin)` would be four places a mutation cannot be detected from, plus a
 * fifth risk nobody has yet: the surface that spells it as `can(viewer, space, "MANAGE_SPACE")`
 * over some space it happens to have to hand, which is a different predicate wearing the same
 * clothes.
 *
 * So the predicate is stated **once, here**, and `src/lib/admin/gate.test.ts` sweeps every
 * `admin.ts` module under `src/lib/` to keep it that way — the same discipline as the `writeAudit`
 * sweep in `tests/integration/audit.test.ts` and the soft-delete sweep in
 * `src/lib/pages/visible.test.ts`, both of which exist because a rule implemented in two places
 * is not yet a convention.
 *
 * ## `isSuperAdmin` and nothing else, said at the line
 *
 * `readableSpace` and `editableSpace` are **absent from every admin module on purpose**, and
 * `src/lib/git/failures.ts` wrote down why one phase early, for the `/-/mirror` that Task 7 has
 * since folded into `/admin/git`: `readableSpaceWhere` answers
 * `{}` for a super admin, so a `readableSpace(viewer)` on a surface only super admins reach is a
 * predicate that cannot fail — a filter no test can be written against. The falsifiable predicate
 * is this one, and deleting it is what a test kills.
 *
 * `can(viewer, space, "MANAGE_SPACE")` is not an alternative here for a structural reason rather
 * than a strictness one: **an admin surface may have no space at all.** §7 makes a system global
 * and permissionless, so `/admin/systems` administers rows with no `spaceId` for `can()` to be
 * asked about. A space admin is an administrator *of a space*; a person who edits the catalogue
 * every space's documents point at is not.
 *
 * ## The refusal is not-found, never forbidden
 *
 * The project's answer everywhere (§8, `e2e/reader.spec.ts`'s *"a non-member gets not-found
 * rather than forbidden"*), and on an admin route it is doing real work: a `403` from a route
 * that is otherwise `404` tells an ordinary member that `/admin/systems` exists and that they are
 * the wrong sort of person, which is the shape of the system rather than its contents but is
 * still something they were not entitled to. There is nothing here for a non-admin to be told
 * they lack permission *for*.
 *
 * The consequence for callers is that the refusal is **byte-identical to a miss**: a system id
 * that names no row and a viewer who may not look both answer `{ ok: false, reason: "not-found" }`
 * and both render `notFound()`. That is deliberate and is why `AdminRefusal` and a module's own
 * not-found share one shape.
 */

/**
 * What every admin entry point returns to a viewer who may not be here.
 *
 * A value rather than a thrown error, for `listMirrorFailures`'s reason: the route is what knows
 * whether the answer is `notFound()` (a page) or a `404` JSON body (an endpoint), and a module
 * that threw would make every caller catch to find out which refusal it was holding.
 */
export type AdminRefusal = { ok: false; reason: "not-found" };

/**
 * The predicate. `null` means "carry on" — the caller's own `ok` shape is not this module's to
 * invent.
 *
 * Used as two lines at the top of every admin entry point:
 *
 * ```ts
 * const refused = refuseNonAdmin(viewer);
 * if (refused !== null) return refused;
 * ```
 *
 * A `null`-for-allowed shape rather than a boolean, so the refusal **value** comes from here as
 * well as the decision. A `if (!isAdmin(viewer)) return { ok: false, reason: "not-found" }` at
 * four call sites would state the predicate once and the answer four times, and it is the answer
 * — not-found rather than forbidden — that this project has to keep saying out loud.
 */
export function refuseNonAdmin(viewer: Viewer): AdminRefusal | null {
  // The only permission predicate on any `/admin` surface. Delete this line and every admin
  // route in the product opens to any signed-in person — which is the single mutation
  // `src/lib/admin/gate.test.ts` and `tests/integration/systems-admin.test.ts` are written
  // against, and it is one mutation rather than four because of this file.
  if (viewer.isSuperAdmin) return null;
  return { ok: false, reason: "not-found" };
}
