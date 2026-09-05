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
  viewerFor,
  type Counts,
  type Fixture,
} from "./support";

/**
 * Phase 7 Task 4 — spec §12's due-for-review list and the confirmation, over HTTP.
 *
 * What this file is for, given that `tests/integration/review.test.ts` already asserts every rule
 * the query and the mutation own: three things a vitest run cannot show.
 *
 * 1. **The list renders, and renders the right one.** With a due fixture and a not-due fixture in
 *    the same space, so what is on the screen is a discrimination rather than a section heading
 *    over nothing.
 * 2. **The control exists where a person can reach it, and only for the right person.** It is in
 *    `.meta` and not in `PageInfoCard`, because `.rail-r` is `display: none` below 1180px — a
 *    claim about CSS at three viewport widths, which is the one class of bug this project has met
 *    nine times and never caught with a unit test.
 * 3. **The round trip.** Click it, and the page leaves the list.
 *
 * ## The measurement that shapes every fixture here
 *
 * **Nothing in the seeded corpus is due**, measured: all seven seeded pages carry
 * `reviewedAt = 2026-08-18` and today is 2026-09-05, so under the twelve-month default this
 * section renders its empty sentence on `/engineering` and `/handbook` alike. An e2e test that
 * visited the landing page and saw no list could not tell "correct" from "broken", so every test
 * below backdates its own fixture — and never a seeded page: `scripts/smoke.sh` and four other
 * specs assert the dev baseline, and the brief for this task says to leave every `reviewedAt`
 * exactly where it is.
 *
 * ## Why the fixtures are written to rather than only created
 *
 * `createPage` sets neither `ownerId` nor `reviewedAt` and `publishPage` sets neither either, so a
 * fixture built through the product's own three steps is unowned and never-reviewed with a
 * `publishedAt` of *now* — which is exactly not-due, whatever the interval. The two columns are
 * therefore written directly afterwards. That is not a fixture assembling a state the product
 * cannot produce: it is a fixture fast-forwarding a clock, on a page the product did make.
 */

let baseline: Counts;

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before review: ${formatCounts(baseline)}`);
});

test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after review:  ${formatCounts(after)}`);
  expect(after, "the review suite did not leave the dev database as it found it").toEqual(
    baseline,
  );

  // The other half of "as it found it", and the one the counts cannot see: this suite confirms a
  // review, which moves a column on a row rather than creating or deleting one. Every page it
  // touches carries the `e2e-` slug and is swept above, so this asserts that no SEEDED page's
  // `reviewedAt` moved — the dev baseline the smoke script and four other specs depend on.
  const seeded = await db.page.findMany({
    where: { slug: { not: { startsWith: "e2e-" } } },
    select: { path: true, reviewedAt: true },
  });
  expect(seeded).toHaveLength(7);
  for (const page of seeded) {
    expect(page.reviewedAt?.toISOString(), `${page.path} lost its seeded reviewedAt`).toBe(
      "2026-08-18T00:00:00.000Z",
    );
  }

  await db.$disconnect();
});

/** Comfortably outside a twelve-month interval, and comfortably inside it. */
const LONG_AGO = new Date("2024-02-01T09:00:00.000Z");
const RECENTLY = new Date("2026-08-01T09:00:00.000Z");

/**
 * Publishes a page and then sets the two columns `createPage` and `publishPage` never write.
 *
 * `owned: false` leaves `ownerId` null, which is what every page this product creates actually
 * looks like — and is the case the "no button for an editor who is not the owner" test needs.
 */
async function reviewFixture(opts: {
  slug: string;
  title: string;
  reviewedAt: Date | null;
  publishedAt?: Date;
  owned?: boolean;
}): Promise<Fixture> {
  const fixture = await seedPublishedPage({
    slug: opts.slug,
    title: opts.title,
    markdown: `# ${opts.title}\n\nOne paragraph, so the publish has a body.\n`,
  });
  const aisyah = await viewerFor("aisyah@example.com");
  await db.page.update({
    where: { id: fixture.id },
    data: {
      reviewedAt: opts.reviewedAt,
      ownerId: opts.owned === false ? null : aisyah.id,
      ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
    },
  });
  return fixture;
}

/* -------------------------------------------------------------------------- */
/* The list                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The discrimination, on the real landing page: an overdue page is listed and a recently reviewed
 * one is not, in the same section, in the same render.
 *
 * Bound to the section's own `<ul>` and never to the page body — the nav rail beside it names
 * every page in the space on the same HTML, so a title-shaped needle passes for free. Phase 3
 * Task 13 shipped a banner check that stayed green with the cascade disabled entirely for exactly
 * this reason.
 */
test("the landing lists an overdue page and not a recently reviewed one", async ({ page }) => {
  await reviewFixture({
    slug: "e2e-review-overdue",
    title: "Bunkering procedure (overdue)",
    reviewedAt: LONG_AGO,
  });
  await reviewFixture({
    slug: "e2e-review-fresh",
    title: "Gantry procedure (fresh)",
    reviewedAt: RECENTLY,
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering");

  const due = page.locator("h2", { hasText: "Due for review" }).locator("xpath=following-sibling::ul[1]");
  await expect(due.locator("li")).toHaveCount(1);
  await expect(due.locator("li a")).toHaveText("Bunkering procedure (overdue)");
  // The link goes where it says, through `pageHref`.
  await expect(due.locator("li a")).toHaveAttribute("href", "/engineering/e2e-review-overdue");
  // §12's subject, named on the row.
  await expect(due.locator("li")).toContainText("Aisyah R.");
});

/**
 * The never-reviewed case, measured from `publishedAt` — which is what every page this product
 * creates is in, and is therefore the arm that will actually fire in production. Its companion is
 * the identical fixture published last month.
 */
test("a page nobody ever reviewed is listed once it is old enough, and not before", async ({
  page,
}) => {
  await reviewFixture({
    slug: "e2e-review-never-old",
    title: "Never reviewed, published long ago",
    reviewedAt: null,
    publishedAt: LONG_AGO,
  });
  await reviewFixture({
    slug: "e2e-review-never-new",
    title: "Never reviewed, published recently",
    reviewedAt: null,
    publishedAt: RECENTLY,
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering");

  const due = page.locator("h2", { hasText: "Due for review" }).locator("xpath=following-sibling::ul[1]");
  await expect(due.locator("li")).toHaveCount(1);
  await expect(due.locator("li a")).toHaveText("Never reviewed, published long ago");
  await expect(due.locator("li")).toContainText("never reviewed");
});

/**
 * The empty state, asserted only *beside* a non-empty one — `handbook` has one seeded page whose
 * review is not due, and the assertion above has already shown that a due page would be listed.
 * On its own this would be the vacuous test the whole file is written to avoid.
 */
test("a space with nothing due says so, naming the interval", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/handbook");
  await expect(page.locator("h2", { hasText: "Due for review" })).toHaveCount(1);
  await expect(page.getByText("Nothing here has gone 12 months without a review.")).toHaveCount(
    1,
  );
});

/* -------------------------------------------------------------------------- */
/* The control, and the round trip                                            */
/* -------------------------------------------------------------------------- */

/**
 * The claim `ConfirmReviewButton`'s placement rests on: the control is in `.meta`, which is hidden
 * at no width, and **not** in `.rail-r`, which `doc.css` hides entirely below 1180px.
 *
 * Asserted at three widths, including one below that breakpoint, because the failure this guards
 * is invisible at the default viewport — it is Phase 1's bug dialog inside `.rail-l` and Phase 5
 * Task 7's note about `PageInfoCard`, and no unit test can see either. The rail's own presence is
 * asserted at 1280 and its absence at 900, so "the button is still there" at 900 is a statement
 * about the button rather than about a page that rendered everything.
 */
test("the confirm control survives the width that takes the right rail away", async ({ page }) => {
  await reviewFixture({
    slug: "e2e-review-widths",
    title: "Bunkering procedure",
    reviewedAt: LONG_AGO,
  });
  await signIn(page, "aisyah@example.com");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/engineering/e2e-review-widths");
  await expect(page.locator(".rail-r")).toBeVisible();
  await expect(page.locator(".meta .doc-review")).toBeVisible();

  for (const width of [900, 380]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/engineering/e2e-review-widths");
    await expect(page.locator(".rail-r"), `the rail is still visible at ${width}px`).toBeHidden();
    await expect(
      page.locator(".meta .doc-review"),
      `the confirm control vanished at ${width}px`,
    ).toBeVisible();
  }
});

/**
 * §12's round trip, through the browser: the page is on the list, its owner confirms it on the
 * page itself, and it is gone from the list.
 *
 * The second fixture is what stops this passing over a due list that broke between the two page
 * loads — something must still be listed afterwards.
 */
test("confirming on the page takes it off the space's due list", async ({ page }) => {
  await reviewFixture({
    slug: "e2e-review-mine",
    title: "Bunkering procedure (mine)",
    reviewedAt: LONG_AGO,
  });
  await reviewFixture({
    slug: "e2e-review-other",
    title: "Gantry procedure (also due)",
    reviewedAt: LONG_AGO,
  });

  await signIn(page, "aisyah@example.com");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/engineering");
  const due = page.locator("h2", { hasText: "Due for review" }).locator("xpath=following-sibling::ul[1]");
  await expect(due.locator("li")).toHaveCount(2);

  await page.goto("/engineering/e2e-review-mine");
  // The rail's own record of the fact, before and after — the value §12 says the confirmation
  // updates, read where a person reads it.
  await expect(page.locator(".rail-r")).toContainText("1 Feb 2024");
  await page.locator(".doc-review").click();
  await expect(page.locator(".rail-r")).not.toContainText("1 Feb 2024");

  await page.goto("/engineering");
  await expect(due.locator("li")).toHaveCount(1);
  await expect(due.locator("li a")).toHaveText("Gantry procedure (also due)");
});

/**
 * The permission, over HTTP and in the HTML. `aisyah` is an `EDITOR` of `engineering` — she can
 * publish this page, move it and delete it — and on a page she does not own the control is not
 * there, because §12 is about the owner's confirmation and `EDIT` is a different question.
 *
 * The companion in the same test is the page she does own, so "absent" is about ownership and not
 * about a route that failed to render a button for anybody.
 */
test("an editor sees no confirm control on a page they do not own", async ({ page }) => {
  await reviewFixture({
    slug: "e2e-review-unowned",
    title: "Unowned procedure",
    reviewedAt: LONG_AGO,
    owned: false,
  });
  await reviewFixture({
    slug: "e2e-review-owned",
    title: "Owned procedure",
    reviewedAt: LONG_AGO,
  });

  await signIn(page, "aisyah@example.com");
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/engineering/e2e-review-unowned");
  await expect(page.locator(".doc-review")).toHaveCount(0);
  // She can still edit it, which is the whole point: the two permissions are separate.
  await expect(page.locator(".doc-edit")).toHaveCount(1);

  await page.goto("/engineering/e2e-review-owned");
  await expect(page.locator(".doc-review")).toHaveCount(1);

  // And a super admin reaches the unowned page through the MANAGE_SPACE arm, which is the reason
  // that arm exists — an unowned page must not be stuck on the list for ever.
  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  await signIn(adminPage, "admin@example.com");
  await adminPage.setViewportSize({ width: 1280, height: 900 });
  await adminPage.goto("/engineering/e2e-review-unowned");
  await expect(adminPage.locator(".doc-review")).toHaveCount(1);
  await admin.close();
});

/* -------------------------------------------------------------------------- */
/* The overflow class — injected, never hoped for                             */
/* -------------------------------------------------------------------------- */

/**
 * This task adds content to two existing routes: a list of author-typed titles and owner names on
 * the landing, and a button in the reader's `.meta` row. The class has bitten nine times in nine
 * shapes and only ever catches what it is shown, so the hostile case is **injected** — a
 * 300-character unbreakable title on a page that is due, which is a value no seeded row contains
 * and no document could ever produce.
 *
 * The button itself is deliberately not `flex: none`, which is Task 3's ninth shape: `0 0 auto`
 * takes its basis from the content width, so `overflow-wrap` cannot break anything inside it.
 */
test("neither route scrolls horizontally with a hostile title on a due page", async ({ page }) => {
  await reviewFixture({
    slug: "e2e-review-hostile",
    title: HOSTILE,
    reviewedAt: LONG_AGO,
  });

  await signIn(page, "aisyah@example.com");

  // Non-vacuity, before any measurement: the hostile string is genuinely on both routes, in the
  // markup this task added. A page that failed to render it would report zero overflow and read
  // as a pass — which is how this class stayed green over a 4,660px reader overflow for a whole
  // phase, because the suite only ever measured seeded content.
  await page.goto("/engineering");
  const due = page
    .locator("h2", { hasText: "Due for review" })
    .locator("xpath=following-sibling::ul[1]");
  await expect(due.locator("li a")).toHaveText(HOSTILE);
  await page.goto("/engineering/e2e-review-hostile");
  await expect(page.locator(".doc > h1")).toHaveText(HOSTILE);
  await expect(page.locator(".meta .doc-review")).toHaveCount(1);

  for (const width of [1280, 860, 380]) {
    await page.setViewportSize({ width, height: 900 });
    for (const url of ["/engineering", "/engineering/e2e-review-hostile"]) {
      await page.goto(url);
      const { overflow, width: clientWidth } = await measureOverflow(page);
      expect(clientWidth, `${url} at ${width}px reported no width`).toBeGreaterThan(0);
      expect(overflow, `${url} at ${width}px scrolls horizontally`).toBe(0);
    }
  }
});
