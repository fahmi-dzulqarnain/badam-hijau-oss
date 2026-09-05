import { expect, test } from "vitest";
import { mayConfirmReview, reviewCutoff, reviewIntervalMonths } from "@/lib/pages/review";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

/**
 * The three pure halves of spec §12's review cycle: the configured interval, the cutoff it
 * produces, and who may confirm.
 *
 * They are unit tests and not integration ones because none of the three touches the database —
 * and because the interval is read from `process.env` at import time, which is the one shape a
 * test must never assert against the ambient environment. Every case below passes a literal
 * environment object, exactly as `src/lib/attachments/schema.test.ts` does for
 * `MAX_UPLOAD_BYTES`, for the reason PROGRESS records: importing anything that touches Prisma
 * loads `.env` into `process.env`, so a test that clears a variable gets the file's value back.
 */

test("the interval defaults to twelve months, per spec §17", () => {
  expect(reviewIntervalMonths({})).toBe(12);
  // Empty is unset. `scripts/setup-db.sh` generates `.env.test` by copying `.env.example`, and
  // several variables there are deliberately `""` — an empty string reaching `Number()` is 0,
  // which would make every published page due the moment it was published.
  expect(reviewIntervalMonths({ REVIEW_INTERVAL_MONTHS: "" })).toBe(0 + 12);
});

test("a deployment may configure the interval", () => {
  expect(reviewIntervalMonths({ REVIEW_INTERVAL_MONTHS: "6" })).toBe(6);
  expect(reviewIntervalMonths({ REVIEW_INTERVAL_MONTHS: "24" })).toBe(24);
});

/**
 * Zero is the case worth its own assertion rather than a line in a loop: it is not a typo, it is
 * the "a page is due the moment it is published" reading of §12 that the module rejected, and a
 * validator that clamped it to the default would silently overrule a deployment that meant it.
 * Refusing says so loudly at boot.
 */
test("a non-positive or non-integer interval is refused, not clamped", () => {
  for (const raw of ["0", "-1", "1.5", "twelve", "12 months", "NaN"]) {
    expect(
      () => reviewIntervalMonths({ REVIEW_INTERVAL_MONTHS: raw }),
      `${raw} should be refused`,
    ).toThrow(/REVIEW_INTERVAL_MONTHS/);
  }
});

/**
 * The cutoff, in UTC.
 *
 * The interesting assertion is the last one. `setMonth` reads and writes the *local* calendar, so
 * an implementation using it would produce a different cutoff on a container in UTC and on a
 * laptop in `Asia/Kuala_Lumpur` — this project has already paid once for a `Date` bound in the
 * session zone, storing `07:00Z` as `15:00`. Comparing against a literal UTC instant is what
 * makes the difference visible; comparing the result against another computation of itself is the
 * mistake PROGRESS names as "compare a stored timestamp against the real clock".
 */
test("the cutoff is the interval before now, computed in UTC", () => {
  expect(reviewCutoff(new Date("2026-09-05T00:00:00.000Z"), 12).toISOString()).toBe(
    "2025-09-05T00:00:00.000Z",
  );
  expect(reviewCutoff(new Date("2026-09-05T11:22:33.444Z"), 6).toISOString()).toBe(
    "2026-03-05T11:22:33.444Z",
  );
  // Across a year boundary, and the time of day is carried rather than truncated: the interval
  // is a duration, not a date.
  expect(reviewCutoff(new Date("2026-01-31T23:59:59.999Z"), 1).toISOString()).toBe(
    "2025-12-31T23:59:59.999Z",
  );
});

/**
 * The one imprecision, asserted rather than left to be discovered. `setUTCMonth` normalises an
 * overflowing day forward, so twelve months back from a 29 February lands on 1 March — one day
 * early, once every four years, on a review nag. Accepted; pinned so that nobody "fixes" it into
 * something with a different failure.
 */
test("a February 29 anchor normalises forward by one day", () => {
  expect(reviewCutoff(new Date("2028-02-29T00:00:00.000Z"), 12).toISOString()).toBe(
    "2027-03-01T00:00:00.000Z",
  );
});

const SPACE: SpaceRef = { id: "sp-1", visibility: "MEMBERS" };

const viewer = (id: string, role?: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
  id,
  isSuperAdmin: false,
  memberships: role === undefined ? [] : [{ spaceId: SPACE.id, role }],
});

/**
 * ## Who may confirm — §12's "owner", and the second arm the corpus forced
 *
 * Each case names the mutant it kills, because "an EDITOR is refused" is worth nothing if some
 * other guard is what refuses them. The two arms are independently deletable and each has a case
 * below that fails only when its own arm goes.
 */
test("the owner may confirm, whatever their role in the space", () => {
  // A VIEWER who owns the page. Kills deleting the owner arm: `can(…, "MANAGE_SPACE")` is false
  // for a VIEWER, so the `manage-space` arm cannot cover this and the answer becomes null.
  expect(mayConfirmReview(viewer("u-own", "VIEWER"), SPACE, { ownerId: "u-own" })).toBe("owner");
  // And an owner who is also an ADMIN is recorded as the owner, which is the stronger claim and
  // the one §12 is about. Kills reordering the two arms.
  expect(mayConfirmReview(viewer("u-own", "ADMIN"), SPACE, { ownerId: "u-own" })).toBe("owner");
});

test("a space admin may confirm a page they do not own", () => {
  // Kills deleting the `MANAGE_SPACE` arm.
  expect(mayConfirmReview(viewer("u-adm", "ADMIN"), SPACE, { ownerId: "u-own" })).toBe(
    "manage-space",
  );
  // A super admin reaches the same arm through `can()`'s short circuit, with no membership row —
  // which is why there is no third arm here. Kills adding one.
  const root: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };
  expect(mayConfirmReview(root, SPACE, { ownerId: "u-own" })).toBe("manage-space");
});

/**
 * The refusal, and the one that carries the decision: **`EDIT` is not enough.**
 *
 * An EDITOR may rewrite this page entirely and still may not say it has been reviewed. That is
 * the whole distinction §12 draws — the list is about the *owner's* confirmation — and it is the
 * assertion that fails if `mayConfirmReview` is ever "simplified" to `can(viewer, space, "EDIT")`.
 * The non-vacuity companion is the line above it: the same EDITOR, on a page they own, is allowed.
 */
test("an EDITOR who is not the owner may not confirm", () => {
  expect(mayConfirmReview(viewer("u-ed", "EDITOR"), SPACE, { ownerId: "u-ed" })).toBe("owner");
  expect(mayConfirmReview(viewer("u-ed", "EDITOR"), SPACE, { ownerId: "u-own" })).toBeNull();
  expect(mayConfirmReview(viewer("u-ed", "EDITOR"), SPACE, { ownerId: null })).toBeNull();
});

/**
 * The unowned page — which, outside the seed, is **every page this product creates**:
 * `createPage` writes no `ownerId` and `publishPage` writes none either.
 *
 * A null owner must never match a viewer. Without the explicit null check, `page.ownerId ===
 * viewer.id` is false for any real cuid and the bug is invisible — until some caller passes a
 * viewer whose id is nullish, at which point every unowned page in the installation belongs to
 * them. Pinned here rather than argued.
 */
test("an unowned page has no owner arm, and is a space admin's to confirm", () => {
  expect(mayConfirmReview(viewer("u-any", "VIEWER"), SPACE, { ownerId: null })).toBeNull();
  expect(mayConfirmReview(viewer("u-adm", "ADMIN"), SPACE, { ownerId: null })).toBe(
    "manage-space",
  );
  const nullish = { id: null as unknown as string, isSuperAdmin: false, memberships: [] };
  expect(mayConfirmReview(nullish, SPACE, { ownerId: null })).toBeNull();
});

test("a member of nothing may not confirm, even in an ALL_STAFF space", () => {
  // ALL_STAFF grants READ and nothing else — the one place `can()`'s two predicates diverge —
  // so a signed-in stranger reading the handbook cannot confirm its pages.
  const allStaff: SpaceRef = { id: SPACE.id, visibility: "ALL_STAFF" };
  expect(mayConfirmReview(viewer("u-nobody"), allStaff, { ownerId: "u-own" })).toBeNull();
  // Non-vacuity: the same viewer, owning the page, is allowed. So "refused" here is about the
  // permission and not about the fixture being unreachable.
  expect(mayConfirmReview(viewer("u-nobody"), allStaff, { ownerId: "u-nobody" })).toBe("owner");
});
