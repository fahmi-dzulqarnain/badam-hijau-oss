import { expect, test, type Page } from "@playwright/test";
import { db, formatCounts, HOSTILE, measureOverflow, signIn, snapshotCounts, sweep, type Counts } from "./support";

/**
 * Phase 7 Task 6 — `/admin/spaces`, over HTTP.
 *
 * `tests/integration/spaces-admin.test.ts` asserts every rule the module owns and
 * `tests/integration/spaces-admin-route.test.ts` every status code, so what is here is the four
 * things neither can show:
 *
 * 1. **The refusal is a real 404 on a real route**, asserted as a **discrimination** — the same
 *    URL, two signed-in people, two different answers — because a 404 for somebody who can see
 *    nothing proves nothing.
 * 2. **The whole loop an admin walks**, in the order they walk it: be refused a reserved key, use
 *    a legal one, see a space nobody can open, add somebody, promote them, remove the last admin
 *    and be told what that left. Task 5's e2e run found two real defects this way that no module
 *    test could — including a refusal that its own follow-up button deleted — so this walks
 *    rather than asserting each step alone.
 * 3. **The overflow class**, injected, on a surface whose every string is typed by a person.
 * 4. **The affordance.** Two features in this project have shipped with nothing linking to them.
 *
 * The dev baseline is `2 spaces / 7 pages / 7 systems / 0 page systems`, and **this suite is the
 * first that creates `Space` rows** — the leak `snapshotCounts().spaces` was always there to
 * catch. Every key this file creates is listed in `E2E_SPACE_KEYS` and removed in `afterAll`;
 * `SpaceMembership` cascades from `Space`, so deleting the space takes the memberships with it,
 * and the suite deliberately adds no member to a seeded space so no seeded membership can be
 * disturbed.
 */

let baseline: Counts;

/**
 * Spaces this suite creates. `sweep()` knows about pages and deliberately not about spaces: a
 * space is what this suite is for, and letting the shared sweep delete one by prefix would make
 * a leak look like a clean-up.
 */
const E2E_SPACE_KEYS = ["e2e-admin-space", "e2e-hostile-space"];

const removeSpaces = () => db.space.deleteMany({ where: { key: { in: E2E_SPACE_KEYS } } });

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before admin-spaces: ${formatCounts(baseline)}`);
});

test.beforeEach(async () => {
  await sweep();
  await removeSpaces();
});

test.afterAll(async () => {
  await sweep();
  await removeSpaces();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after admin-spaces:  ${formatCounts(after)}`);
  expect(
    after,
    "the admin-spaces suite did not leave the dev database as it found it",
  ).toEqual(baseline);
  await db.$disconnect();
});

const row = (page: Page, key: string) =>
  page.locator(".sys-row", { has: page.locator(".sys-key", { hasText: key }) });

/* -------------------------------------------------------------------------- */
/* The refusal, as a discrimination                                           */
/* -------------------------------------------------------------------------- */

test("a member gets not-found from /admin/spaces and a super admin gets the page", async ({
  page,
}) => {
  await signIn(page, "aisyah@example.com");
  const refused = await page.goto("/admin/spaces");
  expect(refused?.status()).toBe(404);
  await expect(page.locator(".sys-list")).toHaveCount(0);

  /*
   * Not merely "a 404", but the same 404 a route nobody built gets, word for word — and over
   * **rendered text**, never `page.content()`. Task 5 found that `not.toContain("forbidden")`
   * fails on every page in this product, 200s included: Next 16 ships `forbidden()` as an API and
   * its name is in the client bundle.
   */
  const refusedText = await page.locator("body").innerText();
  await page.goto("/no-such-space-anywhere");
  expect(await page.locator("body").innerText()).toBe(refusedText);

  await signIn(page, "admin@example.com");
  const allowed = await page.goto("/admin/spaces");
  expect(allowed?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("Manage spaces");
  // The seeded corpus, so the 200 is a page and not an empty shell.
  await expect(page.locator(".sys-list > li")).toHaveCount(2);
  await expect(row(page, "engineering").locator(".sys-kind")).toHaveText("MEMBERS");
  await expect(row(page, "handbook").locator(".sys-kind")).toHaveText("ALL_STAFF");
});

test("a signed-out visitor is sent to sign in and comes back", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/admin/spaces");
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=%2Fadmin%2Fspaces/);
});

/**
 * **The affordance.** `/admin/spaces` is reachable from the surface that shipped before it, and
 * the link lives in the layout rather than on an `/admin` index page — a layout without a page
 * creates no route, so the cross-links cost a space keyed `admin` nothing.
 */
test("the two admin surfaces link to each other, and neither adds an /admin route", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/systems");
  await page.locator(".adm-nav").getByRole("link", { name: "Spaces" }).click();
  await expect(page).toHaveURL(/\/admin\/spaces$/);
  await page.locator(".adm-nav").getByRole("link", { name: "Systems" }).click();
  await expect(page).toHaveURL(/\/admin\/systems$/);

  // `/admin` itself still resolves to `[space]` and therefore 404s, there being no space keyed
  // `admin` — the measured property Task 5 recorded and this task did not change.
  const index = await page.goto("/admin");
  expect(index?.status()).toBe(404);
});

/* -------------------------------------------------------------------------- */
/* The loop, walked in order                                                  */
/* -------------------------------------------------------------------------- */

async function fill(page: Page, form: ReturnType<Page["locator"]>, key: string) {
  await form.locator('input[name="key"]').fill(key);
  await form.locator('input[name="name"]').fill("E2E admin space");
  await form.locator('input[name="initials"]').fill("E2");
}

test("a reserved key is refused beside the input, a legal one is created, and it is unreadable until somebody is added", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/spaces");

  await page.locator(".adm-new-toggle").click();
  const form = page.locator(".adm-new form");

  // Step one: the collision this whole task is about, refused with a sentence on the field.
  await fill(page, form, "systems");
  await form.getByRole("button", { name: /add space/i }).click();
  const keyError = page.locator('.adm-error[data-field="key"]');
  await expect(keyError).toContainText("404");
  await expect(page.locator(".sys-list > li")).toHaveCount(2);

  // Step two: the same form, a legal key. The non-vacuity companion for the refusal above —
  // without it, "refused" is consistent with a form that refuses everything.
  await fill(page, form, "e2e-admin-space");
  await form.getByRole("button", { name: /add space/i }).click();
  const created = row(page, "e2e-admin-space");
  await expect(created).toHaveCount(1);
  await expect(created.locator(".adm-refs").first()).toHaveText("0 members");

  // Step three: the state a new members-only space is in, stated on the row rather than guessed.
  await expect(created.locator(".adm-note")).toContainText("nobody but a super admin");

  // Step four: the members control, which reads across a boundary and says so.
  await created.getByRole("button", { name: "Members" }).click();
  await expect(created.locator(".adm-member")).toHaveText(/Nobody is a member/);

  // Step five: the grant.
  await created.locator('input[name="email"]').fill("aisyah@example.com");
  await created.locator('select[name="role"]').selectOption("EDITOR");
  await created.getByRole("button", { name: /add member/i }).click();
  const member = created.locator(".adm-member", { hasText: "aisyah@example.com" });
  await expect(member).toHaveCount(1);
  await expect(member.locator(".adm-role")).toHaveValue("EDITOR");
  await expect(created.locator(".adm-refs").first()).toHaveText("1 member");
  await expect(created.locator(".adm-note")).toHaveCount(0);

  // Step six: the promotion, then the removal that leaves nobody able to manage the space.
  await member.locator(".adm-role").selectOption("ADMIN");
  await expect(member.locator(".adm-role")).toHaveValue("ADMIN");
  await member.getByRole("button", { name: "Remove" }).click();
  await expect(created.locator(".adm-message")).toContainText("Nobody in this space is an ADMIN");
  await expect(created.locator(".adm-refs").first()).toHaveText("0 members");
});

/**
 * **A message must survive the button it invites** — Task 5's finding, checked on this surface
 * rather than assumed to have been fixed once.
 *
 * "Members" is the control an admin reaches for straight after being told something about the
 * space, so the listing request must not clear the row's feedback. The four mutations still do.
 */
test("pressing Members does not delete the sentence the admin is acting on", async ({ page }) => {
  await db.space.create({
    data: { key: "e2e-admin-space", name: "E2E admin space", initials: "E2", visibility: "MEMBERS" },
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/spaces");
  const space = row(page, "e2e-admin-space");

  // Produce a message: widening the space says what it just did, with the page count.
  await space.getByRole("button", { name: "Edit" }).click();
  await space.locator('select[name="visibility"]').selectOption("ALL_STAFF");
  await space.getByRole("button", { name: /save/i }).click();
  const message = space.locator(".adm-message");
  await expect(message).toContainText("readable by everyone who can sign in");

  // The button the message invites. It must still be there afterwards.
  await space.getByRole("button", { name: "Members" }).click();
  await expect(space.locator(".adm-member")).toHaveCount(1);
  await expect(message).toContainText("readable by everyone who can sign in");

  // And a mutation still clears it, which is the other half — a stale sentence beside an input
  // the admin has since fixed is worse than none.
  await space.locator('input[name="email"]').fill("aisyah@example.com");
  await space.getByRole("button", { name: /add member/i }).click();
  await expect(space.locator(".adm-message")).toHaveCount(0);
});

test("a space with pages cannot be rekeyed, and the reason is on the form before anything is sent", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/spaces");

  // `engineering` is seeded with pages, so the key input is fixed and says why.
  const engineering = row(page, "engineering");
  await engineering.getByRole("button", { name: "Edit" }).click();
  await expect(engineering.locator('input[name="key"]')).toBeDisabled();
  await expect(engineering.locator(".adm-note")).toContainText("every one of their URLs");

  // The non-vacuity companion, and the discrimination: an empty space's key is editable.
  await db.space.create({
    data: { key: "e2e-admin-space", name: "E2E admin space", initials: "E2" },
  });
  await page.reload();
  const empty = row(page, "e2e-admin-space");
  await empty.getByRole("button", { name: "Edit" }).click();
  await expect(empty.locator('input[name="key"]')).toBeEnabled();
});

/* -------------------------------------------------------------------------- */
/* Overflow                                                                    */
/* -------------------------------------------------------------------------- */

test("hostile strings in a space and its member list do not widen the page", async ({ page }) => {
  const space = await db.space.create({
    data: {
      key: "e2e-hostile-space",
      name: HOSTILE,
      initials: "HS",
      description: HOSTILE,
      visibility: "MEMBERS",
    },
    select: { id: true },
  });
  const user = await db.user.findFirstOrThrow({
    where: { email: "aisyah@example.com" },
    select: { id: true },
  });
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: user.id, role: "VIEWER" },
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/spaces");

  // Non-vacuity, before anything is measured: the hostile values are on the page, the member list
  // is open, and the edit form is rendering the same strings again in inputs. A probe over a page
  // where the hostile strings never rendered reports 0px and means nothing.
  const hostile = row(page, "e2e-hostile-space");
  await expect(hostile.locator(".sys-name")).toHaveText(HOSTILE);
  await expect(hostile.locator(".sys-desc")).toHaveText(HOSTILE);
  await hostile.getByRole("button", { name: "Members" }).click();
  await expect(hostile.locator(".adm-email")).toHaveText("aisyah@example.com");
  await hostile.getByRole("button", { name: "Edit" }).click();
  await expect(hostile.locator('textarea[name="description"]')).toHaveValue(HOSTILE);

  for (const width of [1280, 860, 380]) {
    await page.setViewportSize({ width, height: 900 });
    const { overflow, width: clientWidth } = await measureOverflow(page);
    // `clientWidth` non-zero because a zero-width viewport makes the subtraction come out at zero
    // too, which reads as a pass — Phase 5 Task 7 lost time to exactly that.
    expect(clientWidth, `/admin/spaces at ${width}px reported no width`).toBeGreaterThan(0);
    expect(overflow, `/admin/spaces at ${width}px scrolls horizontally`).toBe(0);
  }
});
