import { expect, test } from "@playwright/test";
import {
  db,
  formatCounts,
  HOSTILE,
  measureOverflow,
  signIn,
  snapshotCounts,
  type Counts,
} from "./support";

/**
 * The summary the bug-reporting check below sends. Named so the `afterAll` can take the row
 * back out: this suite writes to the developer's own database, and an insert with no matching
 * delete accumulates one row per run forever. `scripts/smoke.sh` has always cleaned up its
 * equivalent; this spec did not, which made "run the suite twice and compare the counts" a
 * check nobody could pass.
 */
const BUG_SUMMARY = "The table of contents skips a heading.";

// The 300-character unbreakable token this file used to declare for itself now lives in
// `support.ts`: Phase 3's lifecycle spec is the third file to need it, and a constant with
// three copies is the shape this project has twice watched a *rule* be dropped in.

/**
 * **This spec does write to the database, and it was the only one of the five with no count
 * guard.** Phase 4 Task 6 asks the suite to compare dev-database counts before and after; four
 * specs already did, and the answer for this one turned out not to be "it writes nothing". It
 * posts a real `BugReport` through the dialog and deletes it in `afterAll` — so the guard belongs
 * here like everywhere else.
 *
 * It needed `snapshotCounts` widened to see it. `BugReport` is the one table this suite writes
 * that no fixture page can reach, and it was absent from `Counts`; adding the guard without that
 * column would have produced a check that passes over the only write this file makes, which is
 * worse than the gap it closes. It also does **not** call `sweep()`, and does not need to: it
 * creates no page, no version, no draft, no redirect and no audit row (`createBugReport` is a bare
 * `db.bugReport.create` — bug reporting is deliberately unaudited), and sweeping here would delete
 * fixtures belonging to whichever spec file the single worker runs next.
 */
let baseline: Counts;

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before reader: ${formatCounts(baseline)}`);
});

test.afterAll(async () => {
  // Scoped to this suite's own summary rather than a TRUNCATE, so a developer's real reports
  // survive — the same choice the smoke script makes for the same reason.
  await db.bugReport.deleteMany({ where: { summary: BUG_SUMMARY } });
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after reader:  ${formatCounts(after)}`);
  expect(after, "the reader suite did not leave the dev database as it found it").toEqual(baseline);
  await db.$disconnect();
});

test("test login is offered only because the e2e flag is set", async ({ request }) => {
  const providers = (await (await request.get("/api/auth/providers")).json()) as Record<
    string,
    unknown
  >;
  // Both providers are present here because webServer.env sets ALLOW_TEST_LOGIN=1.
  expect(Object.keys(providers)).toEqual(
    expect.arrayContaining(["company", "test-login"]),
  );
});

test("test login rejects an email that is not a seeded user", async ({ page }) => {
  await page.goto("/api/auth/signin");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: /test login/i }).click();
  // authorize() returned null, so we are still unauthenticated.
  const response = await page.goto("/engineering");
  expect(response?.url()).toMatch(/signin/);
});

test("a member reads a page with navigation, toc and page info", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await expect(page.getByRole("heading", { level: 1, name: "MQTT contracts" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "On this page" })).toContainText("Namespace");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Engineering");
  await expect(page.getByText("Aisyah R.")).toBeVisible();
  await expect(page.locator("table")).toBeVisible();
  await expect(page.locator(".shiki")).toBeVisible();
});

test("table of contents anchors reach their heading", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await page.getByRole("navigation", { name: "On this page" }).getByText("Subscribing").click();
  await expect(page).toHaveURL(/#subscribing$/);
  await expect(page.locator("#subscribing")).toBeInViewport();
});

test("no page scrolls horizontally, whatever the content", async ({ page }) => {
  // A layout regression no unit test can catch: an unbreakable token — an autolinked URL,
  // a long identifier in a mermaid block, a wide image — widens the document, and because
  // the top bar and both rails are sticky in that same scroll container they slide out of
  // alignment. Images, paragraphs and the mermaid placeholder were each fixed separately
  // after the first two were found by hand; this asserts the class, not the instances.
  //
  // Kept, and no longer the whole story: it can only see what the seed happens to contain,
  // which is why the two injection probes below exist. This one still earns its place — it is
  // the only check that visits every route shape (space landing, one level, three levels deep,
  // a second space) with real content in real proportions.
  await signIn(page, "aisyah@example.com");

  for (const path of [
    "/engineering",
    "/engineering/architecture/mqtt-contracts",
    "/engineering/architecture/mqtt-contracts/topic-registry",
    "/handbook/welcome",
  ]) {
    await page.goto(path);
    const { overflow, width } = await measureOverflow(page);
    // A zero-width viewport makes the subtraction come out at zero as well, which reads as a
    // pass. Playwright fronts the page it drives, so this is a tripwire rather than a live
    // hazard — but it is the exact false alarm a backgrounded tab produced in Task 7.
    expect(width, `${path} reported a zero-width viewport`).toBeGreaterThan(0);
    expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBe(0);
  }
});

test("injected hostile content does not widen the reader", async ({ page }) => {
  // **The guard above was testing its corpus, not its class.** It stayed green for the whole of
  // Phase 1 while the reader overflowed 4,660px on a long heading, because no seeded page has
  // an unbreakable one; the bug surfaced only when Phase 2's preview pane rendered hostile
  // content. Injecting the hostile case tests what the suite claims to test, writes nothing to
  // the database, and would have caught it.
  //
  // Measured per element rather than all at once, so a failure names the tag that broke. All
  // three mutants were confirmed visible from here — with `doc.css`'s three guards stripped,
  // this reports h2 2609px, p 1308px, pre 1293px, and passes again once they are restored.
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  const baseline = await measureOverflow(page);
  expect(baseline.width).toBeGreaterThan(0);
  expect(baseline.overflow, "the page overflowed before anything was injected").toBe(0);

  for (const tag of ["h2", "p", "pre"] as const) {
    const overflow = await page.evaluate(
      ({ tag, token }) => {
        const body = document.querySelector(".doc .body");
        if (!body) throw new Error("no .doc .body to inject into");
        const el = document.createElement(tag);
        el.textContent = token;
        body.appendChild(el);
        // Read after the append so layout is flushed by the measurement itself.
        const measured =
          document.documentElement.scrollWidth - document.documentElement.clientWidth;
        el.remove();
        return measured;
      },
      { tag, token: HOSTILE },
    );
    expect(overflow, `a <${tag}> carrying an unbreakable token widens the reader`).toBe(0);
  }

  // And all three at once, because a guard that holds one at a time can still be defeated by
  // the widest of them setting the column's intrinsic size for the others.
  const together = await page.evaluate((token) => {
    const body = document.querySelector(".doc .body")!;
    const nodes = (["h2", "p", "pre"] as const).map((tag) => {
      const el = document.createElement(tag);
      el.textContent = token;
      body.appendChild(el);
      return el;
    });
    const measured =
      document.documentElement.scrollWidth - document.documentElement.clientWidth;
    nodes.forEach((node) => node.remove());
    return measured;
  }, HOSTILE);
  expect(together).toBe(0);

  // The probe cleans up after itself in the DOM as well: a leftover node would make every
  // later assertion in this file measure a page the product never renders.
  const after = await measureOverflow(page);
  expect(after.overflow).toBe(0);
  await expect(page.getByRole("heading", { level: 1, name: "MQTT contracts" })).toBeVisible();
});

test("an injected hostile page title does not widen the reader", async ({ page }) => {
  // The fifth shape of the class, and the one the `.body` probe above cannot see. The page
  // title is painted by the route from `Page.title` into `.doc > h1` and repeated as the last
  // breadcrumb — both **outside** `.body`, so Task 8's heading fix did not reach them.
  // Measured before the fix, at 1280px with a 300-character title: 4,321px of overflow, with
  // `.doc h1` reporting a 5,295px scrollWidth inside a 694px box. No seeded title is long
  // enough to have shown it, and a title arrives from a text input rather than from Markdown,
  // so nothing about the document's content could ever have exercised it.
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  for (const selector of [".doc > h1", '.crumbs [aria-current="page"]']) {
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
    expect(overflow, `an unbreakable title in ${selector} widens the reader`).toBe(0);
  }

  const after = await measureOverflow(page);
  expect(after.overflow).toBe(0);
  await expect(page.getByRole("heading", { level: 1, name: "MQTT contracts" })).toBeVisible();
});

test("a non-member gets not-found rather than forbidden", async ({ page }) => {
  await signIn(page, "stranger@example.com");
  const response = await page.goto("/engineering/architecture/mqtt-contracts");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("MQTT contracts");
});

test("an unpublished page is not readable even by an editor", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  const response = await page.goto("/engineering/decisions/adr-0043-prisma-migrations");
  expect(response?.status()).toBe(404);
});

test("the alpha badge and build string are visible, and a bug can be reported", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await expect(page.getByText("alpha", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/0\.1\.0\+df0ef11/)).toBeVisible();

  await page.getByRole("button", { name: "Report bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await dialog.getByLabel("What happened?").fill(BUG_SUMMARY);
  await dialog.getByRole("button", { name: "Send report" }).click();

  await expect(dialog.getByText(/Thanks/)).toBeVisible();
  // The row is real, and `afterAll` is what takes it back out.
  expect(await db.bugReport.count({ where: { summary: BUG_SUMMARY } })).toBe(1);
});
