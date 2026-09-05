import { expect, test } from "@playwright/test";
import {
  db,
  formatCounts,
  HOSTILE,
  measureOverflow,
  seedPublishedPage,
  signIn,
  snapshotCounts,
  sweep,
  type Counts,
} from "./support";

/**
 * Phase 7 Task 5 — `/admin/systems`, over HTTP.
 *
 * `tests/integration/systems-admin.test.ts` already asserts every rule the module owns and
 * `tests/integration/systems-admin-route.test.ts` every status code, so what is here is the four
 * things neither can show:
 *
 * 1. **The refusal is a real 404 on a real route**, not a discriminated union in a return value.
 *    This is the first `/admin` surface, so the answer three more tasks will copy is asserted
 *    against the router — and as a **discrimination**, because a 404 for someone who can see
 *    nothing proves nothing: the same URL, two signed-in people, two different status codes.
 * 2. **The whole loop an admin actually walks.** Add a system, see its reference count, be refused
 *    a delete, take the alternative the refusal offers, delete an unreferenced one. A module test
 *    can assert each step; only this can assert they are reachable from a browser.
 * 3. **The overflow class**, injected. Every value on this page is typed by a person, and Task 3's
 *    ninth shape (`flex: none` defeating `overflow-wrap`) was on this page's sibling.
 * 4. **The affordance.** Two features in this project have shipped with nothing linking to them.
 *
 * The dev baseline is `2 spaces / 7 pages / 7 systems / 0 page systems`, and this suite is the
 * first that creates `System` rows — which is exactly the leak `snapshotCounts`' `systems` column
 * was added for. Every key this file creates is listed in `E2E_SYSTEM_KEYS` and removed in
 * `afterAll`, pages first, because `PageSystem.systemId` is `Restrict`.
 */

let baseline: Counts;

/**
 * Systems this suite creates. `sweep()` knows about pages and deliberately not about systems —
 * `PageSystem.systemId` is `Restrict`, so a fixture page's facet rows go with the page and the
 * seeded catalogue is left alone. If that ever inverts, `snapshotCounts().systems` is what says so.
 */
const E2E_SYSTEM_KEYS = ["e2e-admin-system", "e2e-blocked-system", "e2e-hostile-admin"];

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before admin-systems: ${formatCounts(baseline)}`);
});

test.beforeEach(async () => {
  await sweep();
  await db.system.deleteMany({ where: { key: { in: E2E_SYSTEM_KEYS } } });
});

test.afterAll(async () => {
  await sweep();
  await db.system.deleteMany({ where: { key: { in: E2E_SYSTEM_KEYS } } });
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after admin-systems:  ${formatCounts(after)}`);
  expect(
    after,
    "the admin-systems suite did not leave the dev database as it found it",
  ).toEqual(baseline);
  await db.$disconnect();
});

/** A token shaped like the thing that actually leaks — Task 1 found this exact form on this machine. */
const TOKEN = "glpat-e2e2Fc9a61E27710c8383b47Ae178B4a";

/* -------------------------------------------------------------------------- */
/* The refusal, as a discrimination                                           */
/* -------------------------------------------------------------------------- */

/**
 * The first `/admin` route's answer to the wrong person, asserted against the router.
 *
 * A **discrimination and not an absence**: `aisyah` is an EDITOR of `engineering` and can see
 * plenty of this product, and she gets 404 from a URL that answers 200 for `admin`. An assertion
 * that only checked the 404 would pass over a route that did not exist at all — which is precisely
 * what a 404 means, and why it takes two viewers to tell the two apart.
 */
test("a member gets not-found from /admin/systems and a super admin gets the page", async ({
  page,
}) => {
  await signIn(page, "aisyah@example.com");
  const refused = await page.goto("/admin/systems");
  expect(refused?.status()).toBe(404);
  await expect(page.locator(".sys-list")).toHaveCount(0);

  /*
   * Not merely "a 404", but **the same 404 a route that does not exist gets**, word for word.
   *
   * The first version of this assertion searched the whole HTML for "forbidden" and failed —
   * Next 16 ships `forbidden()` as an API and its name is in the framework's own client bundle,
   * so the raw markup contains the word on every page in the product, 200s included. That is a
   * useful reminder rather than an annoyance: an assertion over `page.content()` is an assertion
   * about the framework as much as about this route. What a reader can actually see is the
   * rendered text, and what makes it a refusal rather than an absence is that it is identical to
   * a URL nobody ever built a route for.
   */
  const refusedText = await page.locator("body").innerText();
  expect(refusedText.toLowerCase()).not.toContain("forbidden");
  await page.goto("/no-such-space-anywhere");
  expect(await page.locator("body").innerText()).toBe(refusedText);

  await signIn(page, "admin@example.com");
  const allowed = await page.goto("/admin/systems");
  expect(allowed?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("Manage systems");
  // The seeded catalogue, so the 200 is a page and not an empty shell.
  await expect(page.locator(".sys-list > li")).toHaveCount(7);
});

test("a signed-out visitor is sent to sign in and comes back", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/admin/systems");
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=%2Fadmin%2Fsystems/);
});

/**
 * The affordance, in the task that builds the thing. Phase 2's `movePage` and Phase 4's `/search`
 * both shipped with nothing linking to them.
 *
 * It is also a second, weaker statement of who this page is for — so the test asserts both halves:
 * an admin sees the link, an editor does not, and the editor's 404 above is what makes the missing
 * link a courtesy rather than the guard.
 */
test("the catalogue links to its administration, for an admin only", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/systems");
  const link = page.getByRole("link", { name: "Manage systems" });
  await expect(link).toHaveAttribute("href", "/admin/systems");
  await link.click();
  await expect(page.locator("h1")).toHaveText("Manage systems");

  await signIn(page, "aisyah@example.com");
  await page.goto("/systems");
  await expect(page.getByRole("link", { name: "Manage systems" })).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* The loop an admin walks                                                    */
/* -------------------------------------------------------------------------- */

const row = (page: import("@playwright/test").Page, key: string) =>
  page.locator(".sys-row", { has: page.locator(".sys-key", { hasText: key }) });

async function addSystem(
  page: import("@playwright/test").Page,
  fields: { key: string; name: string; repoUrl?: string },
) {
  await page.locator(".adm-new-toggle").click();
  const form = page.locator(".adm-new form");
  await form.locator('input[name="key"]').fill(fields.key);
  await form.locator('input[name="name"]').fill(fields.name);
  if (fields.repoUrl !== undefined) {
    await form.locator('input[name="repoUrl"]').fill(fields.repoUrl);
  }
  await form.getByRole("button", { name: /add system/i }).click();
}

test("an admin adds a system, sees it, and deletes it again", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/systems");

  await addSystem(page, { key: "e2e-admin-system", name: "E2E admin system" });
  const created = row(page, "e2e-admin-system");
  await expect(created).toHaveCount(1);
  // A new system has no page naming it, which is the case `Restrict` never blocks — Task 1's
  // third argument for choosing it, visible on the row.
  await expect(created.locator(".adm-refs")).toHaveText("0 pages");

  // And it is a real row that the reader's own catalogue shows.
  await page.goto("/systems");
  await expect(page.locator(".sys-list").getByText("E2E admin system")).toHaveCount(1);

  await page.goto("/admin/systems");
  await row(page, "e2e-admin-system").getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "e2e-admin-system")).toHaveCount(0);
  expect(await db.system.findUnique({ where: { key: "e2e-admin-system" } })).toBeNull();
});

/**
 * **What a refused delete shows and offers** — Task 1's requirement, walked end to end.
 *
 * The count is on the row *before* anything is clicked, which is the prediction half; the refusal
 * states it again with the reason, which is the explanation half; and the alternative is a control
 * in the place the refusal appeared, which is the half that keeps an admin out of psql.
 */
test("a referenced system refuses to be deleted, says how many, and offers sunsetting", async ({
  page,
}) => {
  await db.system.create({
    data: { key: "e2e-blocked-system", name: "E2E blocked system", kind: "SERVICE" },
    select: { key: true },
  });
  await seedPublishedPage({
    slug: "e2e-blocking-page",
    title: "A page that names the system",
    markdown: "---\nsystems: [e2e-blocked-system]\n---\n\n# Naming it\n\nOne paragraph.\n",
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/systems");

  const blocked = row(page, "e2e-blocked-system");
  // Predicted, not discovered.
  await expect(blocked.locator(".adm-refs")).toHaveText("1 page");

  await blocked.getByRole("button", { name: "Delete" }).click();
  const message = blocked.locator(".adm-message");
  await expect(message).toContainText("1 page");
  await expect(message).toContainText("e2e-blocked-system");
  await expect(message).toContainText("sunsetting");
  // Still there — the refusal is the database's, not a client-side confirmation.
  expect(await db.system.findUnique({ where: { key: "e2e-blocked-system" } })).not.toBeNull();

  // The audited listing, behind its own control, from its own endpoint.
  await blocked.getByRole("button", { name: "Which pages?" }).click();
  await expect(blocked.locator(".adm-page-title")).toHaveText("A page that names the system");

  // The alternative, taken in the place it was offered.
  await blocked.getByRole("button", { name: /sunsetting instead/i }).click();
  await expect(row(page, "e2e-blocked-system").locator(".sys-sunset")).toHaveText("Sunsetting");
  const after = await db.system.findUniqueOrThrow({
    where: { key: "e2e-blocked-system" },
    select: { isActive: true },
  });
  expect(after.isActive).toBe(false);
});

/**
 * **The write half of the credential fix, at the surface where the paste happens.**
 *
 * Task 3's half withholds a stored URL on render; this one refuses it on write, and Phase 5's
 * lesson is that removing either alone still leaks. The non-vacuity companion is in the same test:
 * the same repository, one component removed, is accepted and rendered as a link.
 */
test("a pasted credentialed repo URL is refused at the form, and the clean one is accepted", async ({
  page,
}) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/systems");

  await addSystem(page, {
    key: "e2e-admin-system",
    name: "E2E admin system",
    repoUrl: `https://oauth2:${TOKEN}@gitlab.example.com/acme/hub/order-hub-gateway.git`,
  });

  const error = page.locator('.adm-error[data-field="repoUrl"]');
  await expect(error).toContainText("embeds a username or password");
  // Nothing of the URL comes back in the sentence, and nothing was stored.
  const html = await page.content();
  expect(html).not.toContain(TOKEN);
  expect(html).not.toContain("oauth2:");
  expect(await db.system.findUnique({ where: { key: "e2e-admin-system" } })).toBeNull();

  // The companion: the same repository without the userinfo goes in and is linked.
  await page
    .locator('.adm-new form input[name="repoUrl"]')
    .fill("https://gitlab.example.com/acme/hub/order-hub-gateway.git");
  await page.locator(".adm-new form").getByRole("button", { name: /add system/i }).click();
  const created = row(page, "e2e-admin-system");
  await expect(created.locator("a.sys-repo")).toHaveAttribute(
    "href",
    "https://gitlab.example.com/acme/hub/order-hub-gateway.git",
  );
});

/* -------------------------------------------------------------------------- */
/* The overflow class, injected                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every string on this page was typed by a person and is painted outside `.body`.
 *
 * The probe injects `HOSTILE` into the name, owning team and description, a repository URL of 300
 * unbroken characters, and a `System.key` at the cap `validateSystemKey` now enforces — plus a
 * blocking page whose title is `HOSTILE` and whose row is expanded, because the audited listing is
 * the one part of this page that paints an author's text.
 *
 * The non-vacuity companion runs first: a probe that measured a page where the hostile strings had
 * never rendered would report 0px and mean nothing. Task 4's spec makes the same check for the
 * same reason.
 */
test("the admin page does not scroll horizontally, whatever an admin typed", async ({ page }) => {
  const key = "e2e-hostile-admin";
  await db.system.create({
    data: {
      key,
      name: HOSTILE,
      kind: "SERVICE",
      ownerTeam: HOSTILE,
      description: HOSTILE,
      // Unbroken and credentialed at once, so the row is hostile in both ways: the URL is
      // withheld, and the withholding sentence is itself a long string in the same flex row.
      repoUrl: `https://oauth2:${TOKEN}@gitlab.example.com/${"y".repeat(200)}.git`,
    },
    select: { key: true },
  });
  await seedPublishedPage({
    slug: "e2e-hostile-blocker",
    title: HOSTILE,
    markdown: `---\nsystems: [${key}]\n---\n\n# Hostile\n\nOne paragraph.\n`,
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/systems");

  // Non-vacuity, before anything is measured: the hostile values are on the page, the blocking
  // list is open, and the credential sentence is the one being rendered.
  const hostile = row(page, key);
  await expect(hostile.locator(".sys-name")).toHaveText(HOSTILE);
  await expect(hostile.locator(".sys-team")).toHaveText(HOSTILE);
  await expect(hostile.locator(".sys-repo-held")).toContainText("embeds a username or password");
  await hostile.getByRole("button", { name: "Which pages?" }).click();
  await expect(hostile.locator(".adm-page-title")).toHaveText(HOSTILE);
  // The edit form too: it renders the same strings again, in inputs.
  await hostile.getByRole("button", { name: "Edit" }).click();
  await expect(hostile.locator('textarea[name="description"]')).toHaveValue(HOSTILE);

  for (const width of [1280, 860, 380]) {
    await page.setViewportSize({ width, height: 900 });
    const { overflow, width: clientWidth } = await measureOverflow(page);
    // `clientWidth` non-zero because a zero-width viewport makes the subtraction come out at zero
    // too, which reads as a pass — Phase 5 Task 7 lost time to exactly that.
    expect(clientWidth, `/admin/systems at ${width}px reported no width`).toBeGreaterThan(0);
    expect(overflow, `/admin/systems at ${width}px scrolls horizontally`).toBe(0);
  }
});
