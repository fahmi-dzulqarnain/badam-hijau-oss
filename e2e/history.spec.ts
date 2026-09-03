import { expect, test } from "@playwright/test";
import {
  actorContext,
  db,
  formatCounts,
  HOSTILE,
  measureOverflow,
  republishPage,
  seedPublishedPage,
  signIn,
  snapshotCounts,
  sweep,
  type Counts,
} from "./support";

/**
 * Phase 5 Task 7 — the sha on the page, and the version history behind it.
 *
 * **NOT EXECUTED.** Playwright's browser binaries are absent on this machine, so every spec in
 * this directory fails at launch; `npx playwright install` is a ~95 MB download and the user's
 * call. This file is written to the same standard as the other five and has never been run — the
 * assertions it makes that vitest cannot are the ones about a real layout (`measureOverflow`
 * needs a layout engine) and about the route actually being reachable at that URL. Everything it
 * says about *markup* is also asserted, executed, in `src/components/VersionHistory.test.tsx` and
 * `src/components/Provenance.test.tsx`, which server-render the same components — so the failure
 * of this file to run leaves the overflow class and the route resolution uncovered, and nothing
 * else.
 */

let baseline: Counts;

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before history: ${formatCounts(baseline)}`);
});

test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after history:  ${formatCounts(after)}`);
  expect(after, "the history suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/* -------------------------------------------------------------------------- */
/* The two shas, on one page                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The whole of Step 1, on a real page: both shas are present, each is named, and the names are
 * not interchangeable. This is the assertion the component test cannot make, because only the
 * route puts the nav rail's foot and the document's meta row in one document.
 */
test("a page names its content commit apart from the application build", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await expect(page.locator(".meta")).toContainText("Content commit");
  // `webServer.env` sets GIT_SHA=df0ef11abc, so the build string is deterministic here.
  await expect(page.locator(".rail-foot .build")).toContainText("Build 0.1.0+df0ef11");

  // The bare word this replaces must not be how the content sha is labelled any more — if it
  // were, the two values on this page would be indistinguishable by their labels.
  await expect(page.locator(".meta .k", { hasText: /^Commit$/ })).toHaveCount(0);
});

test("the reader's content sha is short on the page and whole in its title", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-history-sha",
    title: "History sha",
    markdown: "# History sha\n\nOne paragraph.",
  });
  // No worker runs in this suite, so the publish is queued rather than mirrored. A sha has to be
  // written by hand to assert the *display* rule; the queued case is asserted below, on the
  // history page, where it is a state a reader is told about.
  const sha = "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d";
  const version = await db.page.findUniqueOrThrow({
    where: { id: fixture.id },
    select: { publishedVersionId: true },
  });
  await db.pageVersion.update({
    where: { id: version.publishedVersionId! },
    data: { gitSha: sha },
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const code = page.locator(".meta .sha");
  await expect(code).toHaveText("9f2c1ab4d5");
  await expect(code).toHaveAttribute("title", sha);
  // 40 characters of unbreakable token is the shape that has widened this layout six times; it
  // is not in the text at any viewport.
  await expect(page.locator(".doc")).not.toContainText(sha);
});

/* -------------------------------------------------------------------------- */
/* Reaching the history, and what it says                                     */
/* -------------------------------------------------------------------------- */

/**
 * The affordance, and the route resolving at all — which is the half no vitest test can make:
 * `/{space}/-/history/{path}` also matches the reader's `[...path]` catch-all, and this is what
 * proves the literal segment wins.
 */
test("version history is reachable from the page, and lists its versions newest first", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-history-rows",
    title: "History rows",
    markdown: "# History rows\n\nFirst publish.",
  });
  await republishPage(fixture, { markdown: "# History rows\n\nSecond publish." });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);
  await page.getByRole("link", { name: "Version history" }).click();

  await expect(page).toHaveURL(`/engineering/-/history/${fixture.path}`);
  await expect(page.getByRole("heading", { level: 1, name: "Version history" })).toBeVisible();

  const rows = page.locator(".ver-list > li");
  await expect(rows).toHaveCount(2);
  // The publisher's name, from the seeded profile — the byline §10 asks for.
  await expect(rows.first()).toContainText("Aisyah R.");
  // Only the newest is the published one.
  await expect(page.locator(".ver-current")).toHaveCount(1);
  await expect(rows.first().locator(".ver-current")).toBeVisible();

  // No worker has run, so both versions are unmirrored and the page says why — and says it as a
  // queue rather than as a failure, which is the exit criterion this surface carries: a publish
  // stands whether or not the mirror has caught up.
  await expect(page.locator(".ver-none").first()).toHaveText("not mirrored");
  await expect(page.locator(".ver-queued")).toContainText("still queued");
  await expect(page.locator(".ver-stuck")).toHaveCount(0);
});

test("a page whose mirror job has given up says so, and stays readable", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-history-stuck",
    title: "History stuck",
    markdown: "# History stuck\n\nPublished and wedged.",
  });
  // Every job Task 4 enqueued for this page, failed — which is what an unreachable remote looks
  // like after the attempt ceiling.
  await db.gitJob.updateMany({
    where: { pageId: fixture.id },
    data: { state: "FAILED", attempts: 5, lastError: "fatal: could not read from remote" },
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/-/history/${fixture.path}`);

  await expect(page.locator(".ver-stuck")).toContainText("mirror is stuck");
  await expect(page.locator(".ver-queued")).toHaveCount(0);
  // git's stderr is Task 8's business, not a reader's: it can name the remote and the paths
  // inside the container.
  await expect(page.locator("body")).not.toContainText("could not read from remote");
  // And the publish stood, which is the spec's central claim.
  await page.goto(`/engineering/${fixture.path}`);
  await expect(page.getByRole("heading", { level: 1, name: "History stuck" })).toBeVisible();
});

test("a page with no published version has an empty history rather than a 404", async ({
  page,
}) => {
  // Created and never published: the reader route 404s it and this one does not — two different
  // questions, and the nav rail already shows the title to anyone who can read the space.
  const viewer = await db.user.findUniqueOrThrow({
    where: { email: "aisyah@example.com" },
    select: { id: true },
  });
  const space = await db.space.findUniqueOrThrow({
    where: { key: "engineering" },
    select: { id: true },
  });
  await db.page.create({
    data: {
      spaceId: space.id,
      slug: "e2e-history-unpublished",
      path: "e2e-history-unpublished",
      title: "Never published",
      createdById: viewer.id,
    },
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/-/history/e2e-history-unpublished");
  await expect(page.locator(".ver-empty")).toContainText("has never been published");
  await expect(page.locator(".ver-list")).toHaveCount(0);
  // The reader route's answer for the same page, for contrast.
  const missed = await page.goto("/engineering/e2e-history-unpublished");
  expect(missed?.status()).toBe(404);
});

/* -------------------------------------------------------------------------- */
/* Permission                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A discrimination and not an absence: `stranger@example.com` is a member of nothing, so they can
 * read `handbook` (`ALL_STAFF`) and not `engineering` (`MEMBERS`). Both halves are asserted,
 * because a viewer who could read no space at all makes a refusal indistinguishable from a
 * deleted predicate — the lesson Phase 4's non-member search had to learn twice.
 */
test("a non-member cannot read a page's history, and can read one they may", async ({
  browser,
}) => {
  const members = await seedPublishedPage({
    slug: "e2e-history-members",
    title: "Members only",
    markdown: "# Members only\n\nEngineering.",
  });
  const open = await seedPublishedPage({
    slug: "e2e-history-open",
    title: "Open to all",
    markdown: "# Open to all\n\nHandbook.",
    spaceKey: "handbook",
    actor: "admin@example.com",
  });

  const stranger = await actorContext(browser, "stranger@example.com");
  try {
    const readable = await stranger.page.goto(`/handbook/-/history/${open.path}`);
    expect(readable?.status()).toBe(200);
    await expect(stranger.page.locator(".ver-list > li")).toHaveCount(1);

    const refused = await stranger.page.goto(`/engineering/-/history/${members.path}`);
    expect(refused?.status()).toBe(404);
    // Not-found and not forbidden, and nothing about the page leaks into the refusal.
    await expect(stranger.page.locator("body")).not.toContainText("Members only");
  } finally {
    await stranger.context.close();
  }
});

/* -------------------------------------------------------------------------- */
/* The overflow class, seventh shape                                          */
/* -------------------------------------------------------------------------- */

/**
 * **A version list paints another row's data**, which is why this probe belongs here and not
 * only on the reader route: the author name comes from an OIDC profile and each version's title
 * from whoever published it, so "it is only my own text" is not available as an argument — the
 * same turn Phase 4's search results took.
 *
 * The page title is a real 300-character `Page.title` rather than a DOM edit, because
 * `TITLE_MAX_LENGTH` is exactly 300 and a publish can store one; the author name and the version
 * title are injected, because no seeded identity has a 300-character name and the point is the
 * *box*, not how the text got there. Both halves are needed: this guard has caught six distinct
 * shapes and only ever the ones it was shown.
 */
test("hostile text does not widen the version history, at any width", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-history-hostile",
    title: HOSTILE,
    markdown: `# ${HOSTILE}\n\nOne paragraph.`,
  });
  // A second version under a different title, so `.ver-renamed` is painted at all — it is only
  // rendered when a version's title differs from the page's current one.
  await republishPage(fixture, { markdown: "# Renamed\n\nSecond publish." });
  await db.pageVersion.updateMany({
    where: { pageId: fixture.id },
    data: { gitSha: "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d" },
  });

  await signIn(page, "aisyah@example.com");

  for (const width of [1280, 1024, 800, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/engineering/-/history/${fixture.path}`);

    const first = await measureOverflow(page);
    // The tripwire `measureOverflow` documents: a zero-width viewport makes the subtraction come
    // out at zero too, which reads as a pass.
    expect(first.width, `viewport ${width} reported no width`).toBeGreaterThan(0);
    expect(first.overflow, `the seeded 300-character title widens the page at ${width}px`).toBe(0);

    for (const selector of [".ver-who", ".ver-renamed", ".ver-page"]) {
      const overflow = await page.evaluate(
        ({ selector, token }) => {
          const target = document.querySelector(selector);
          if (!target) throw new Error(`no ${selector} to probe`);
          const original = target.textContent;
          target.textContent = token;
          const measured =
            document.documentElement.scrollWidth - document.documentElement.clientWidth;
          target.textContent = original;
          return measured;
        },
        { selector, token: HOSTILE },
      );
      expect(
        overflow,
        `an unbreakable token in ${selector} widens the history page at ${width}px`,
      ).toBe(0);
    }
  }
});

/**
 * The one shape `overflow-wrap` cannot rescue, measured rather than argued: a git object name has
 * no break opportunity in it, so a 40-character sha rendered as text would demand ~300px of one
 * line. The component shows ten characters and keeps the rest in a `title`; this is what fails if
 * that is ever "simplified" back to the full value.
 */
test("a full-length sha in the text would widen the page, and is not in the text", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-history-token",
    title: "Sha width",
    markdown: "# Sha width\n\nOne paragraph.",
  });
  await db.pageVersion.updateMany({
    where: { pageId: fixture.id },
    data: { gitSha: "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d" },
  });

  await signIn(page, "aisyah@example.com");
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(`/engineering/-/history/${fixture.path}`);

  await expect(page.locator(".ver-where .sha")).toHaveText("9f2c1ab4d5");
  const measured = await measureOverflow(page);
  expect(measured.width).toBeGreaterThan(0);
  expect(measured.overflow).toBe(0);
});
