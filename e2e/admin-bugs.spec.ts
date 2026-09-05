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
 * `/admin/bugs` — Phase 7 Task 8's triage inbox, and the fourth admin surface.
 *
 * What this file is for, given that `tests/integration/bugs-admin.test.ts` already drives the
 * module against the same database: four things a module test cannot show, and they are exactly
 * the ones this task's decisions rest on.
 *
 * 1. **The route resolves, and two guards refuse two different people** — a signed-in member gets
 *    not-found and a signed-out visitor is sent to sign in. The endpoint behind the buttons is
 *    refused separately, on its **JSON body**, because Task 5 measured that
 *    `not.toContain("forbidden")` fails on every page in this product: Next 16 ships `forbidden()`
 *    and its name is in the client bundle.
 * 2. **The three states of a captured page reach a reader as three different sentences.** That is
 *    Step 2, and a module test can only assert the discriminated union — whether a *person* can
 *    tell a recoverable page from a lost one is a property of the rendered page.
 * 3. **The triage loop walked in the order a triager walks it** — a count, the button that acts on
 *    it, then the count again. Tasks 5 and 6 each found a defect no module test could see by doing
 *    exactly that, and Task 7 applied the lesson before it bit a third time.
 * 4. **The overflow measurement**, which needs a layout engine, and which this surface brings the
 *    class at a scale none of the nine shapes before it had: `consoleError` is bounded at **5000
 *    characters** by `src/lib/bugs/schema.ts`, and it is pasted console output, so an unbreakable
 *    5000-character token is a realistic value and not a contrived one.
 *
 * ## This suite cleans up its own `BugReport` rows, and nothing else would
 *
 * `sweep()` removes `e2e-` pages and this run's audit rows; a `BugReport` is neither — it has no
 * page to cascade from and no slug to match. `reader.spec.ts` is the only other spec that writes
 * one and it deletes it by summary in its own `afterAll`, which is the precedent this follows: every
 * report here carries {@link MARKER} in its summary and is deleted by it. The closing count equality
 * is what would report a miss, and `Counts.bugReports` has existed since Phase 4 Task 6 precisely
 * because that write was once invisible to it.
 */

let baseline: Counts;

/** In the summary, because that is the only column of this table a sweep can match on. */
const MARKER = "e2e-bug";

const clearReports = () => db.bugReport.deleteMany({ where: { summary: { contains: MARKER } } });

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before admin-bugs: ${formatCounts(baseline)}`);
});

test.beforeEach(async () => {
  await sweep();
  await clearReports();
});

test.afterAll(async () => {
  await clearReports();
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after admin-bugs:  ${formatCounts(after)}`);
  expect(after, "the admin-bugs suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/**
 * A report, written directly.
 *
 * The endpoint would only ever produce ids that resolve — `resolveReportContext` derives them by
 * reading the rows — so the state this file is about cannot be reached through the writer, exactly
 * as `e2e/admin-git.spec.ts`'s credentialed `lastError` cannot. A fixture produced by the guard is
 * a test of the fixture.
 */
async function report(over: {
  summary: string;
  routePath?: string;
  spaceId?: string | null;
  pageId?: string | null;
  versionId?: string | null;
  consoleError?: string | null;
  status?: "NEW" | "TRIAGED" | "CLOSED";
}) {
  const reporter = await db.user.findUniqueOrThrow({
    where: { email: "aisyah@example.com" },
    select: { id: true },
  });
  return await db.bugReport.create({
    data: {
      reporterId: reporter.id,
      summary: over.summary,
      expected: "It should not do that.",
      routePath: over.routePath ?? "/engineering",
      spaceId: over.spaceId ?? null,
      pageId: over.pageId ?? null,
      versionId: over.versionId ?? null,
      appVersion: "0.1.0",
      gitSha: "abc1234",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      viewport: "1440x900",
      consoleError: over.consoleError ?? null,
      status: over.status ?? "NEW",
    },
    select: { id: true },
  });
}

const engineeringId = async () =>
  (await db.space.findUniqueOrThrow({ where: { key: "engineering" }, select: { id: true } })).id;

/* -------------------------------------------------------------------------- */
/* The route, and the two guards                                              */
/* -------------------------------------------------------------------------- */

test("a super admin reaches the triage inbox at /admin/bugs", async ({ page }) => {
  await report({ summary: `${MARKER} the rail loses the third level` });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/bugs");

  await expect(page.locator("h1")).toHaveText("Bug reports");
  await expect(page.locator(".rep-list")).toContainText("the rail loses the third level");
  // The reporter, which is half of why this list writes a `space.access` row when the space is one
  // the admin does not belong to.
  await expect(page.locator(".rep-who")).toContainText("aisyah@example.com");
});

test("the layout links to it, and /admin is still a 404", async ({ page }) => {
  /*
   * The affordance ships with the thing — this project has twice shipped a feature nothing linked
   * to. The link lives in the layout because **a layout without a page creates no route**, so
   * `/admin` still resolves to `[space]` and a space keyed `admin` keeps its landing page.
   */
  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");
  await page.getByRole("link", { name: "Bug reports" }).click();
  await expect(page.locator("h1")).toHaveText("Bug reports");

  const index = await page.goto("/admin");
  expect(index?.status()).toBe(404);
});

test("a member of a space cannot reach it, and gets not-found rather than forbidden", async ({
  page,
}) => {
  /*
   * A **discrimination**, not an absence: the same signed-in person reads a real page in the line
   * below, so the 404 is a refusal and not a session that never worked. And the refusal is
   * asserted against the stronger claim Task 5 established — it is *identical* to the answer for a
   * URL nobody built a route for — rather than over `page.content()`, which cannot say anything
   * about the word "forbidden" in this product.
   */
  await report({ summary: `${MARKER} not for members` });
  await signIn(page, "aisyah@example.com");

  const refused = await page.goto("/admin/bugs");
  expect(refused?.status()).toBe(404);
  const refusedText = await page.locator("body").innerText();

  const nowhere = await page.goto("/admin/no-such-surface");
  expect(nowhere?.status()).toBe(404);
  expect(await page.locator("body").innerText()).toBe(refusedText);

  const allowed = await page.goto("/engineering/architecture/mqtt-contracts");
  expect(allowed?.status()).toBe(200);
});

test("a signed-out visitor is sent to sign in, and comes back to this page", async ({ page }) => {
  // The *other* guard. `requireViewer` refuses a different person from the module's
  // `isSuperAdmin` check, and each has to be shown refusing on its own — a refusal that survives
  // deleting the guard it names is a test of the other one.
  await page.context().clearCookies();
  await page.goto("/admin/bugs");
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=%2Fadmin%2Fbugs/);
});

test("a member cannot triage, because the endpoint answers them not-found", async ({ page }) => {
  /*
   * The refusal has to survive the *endpoint*, not only the page: a surface that 404s while its
   * PATCH route answers anybody would be a permission check on the wrong side of the fetch.
   * Asserted on the **JSON body** rather than on rendered text, for the reason Task 5 measured.
   */
  const filed = await report({ summary: `${MARKER} refused triage` });
  await signIn(page, "aisyah@example.com");

  const response = await page.request.patch(`/api/admin/bugs/${filed.id}`, {
    data: { status: "CLOSED" },
  });
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({
    error: "not-found",
    message: "That page does not exist.",
  });

  const allowed = await page.goto("/engineering/architecture/mqtt-contracts");
  expect(allowed?.status()).toBe(200);

  const after = await db.bugReport.findUniqueOrThrow({
    where: { id: filed.id },
    select: { status: true },
  });
  expect(after.status).toBe("NEW");
});

/* -------------------------------------------------------------------------- */
/* Step 2: three states of a captured page, as three sentences                */
/* -------------------------------------------------------------------------- */

/**
 * **The whole of Step 2, as a reader meets it.**
 *
 * Three reports in one list: a live published page, a **soft-deleted** one and an **absent** one.
 * The middle and the last are the pair that must not read alike — one is a `restorePage` away from
 * being back, the other is gone — and the live one beside them is the non-vacuity companion,
 * because a page that rendered nothing at all would satisfy "the deleted one says deleted".
 *
 * The absent case is reached with an id that names no row, which is the only way to reach it: this
 * product has no hard delete, so nothing in the UI can produce one. Said here rather than implied,
 * because a fixture that looks like a user journey and is not is how a gap gets believed closed.
 */
test("a live page links, a soft-deleted page says so, and an absent one leaves only the route", async ({
  page,
}) => {
  const spaceId = await engineeringId();
  const live = await seedPublishedPage({
    slug: "e2e-bug-live",
    title: "Live under triage",
    markdown: "# Live under triage\n\nOne paragraph.",
  });
  const taken = await seedPublishedPage({
    slug: "e2e-bug-taken-down",
    title: "Taken down",
    markdown: "# Taken down\n\nOne paragraph.",
  });
  await db.page.update({
    where: { id: taken.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });

  await report({
    summary: `${MARKER} against a live page`,
    spaceId,
    pageId: live.id,
    routePath: `/engineering/${live.path}`,
  });
  await report({
    summary: `${MARKER} against a page taken down`,
    spaceId,
    pageId: taken.id,
    routePath: `/engineering/${taken.path}`,
  });
  await report({
    summary: `${MARKER} against a page that is gone`,
    spaceId,
    pageId: "cnosuchpage000000000000",
    routePath: "/engineering/architecture/mqtt-contracts",
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/bugs");

  const rowFor = (summary: string) =>
    page.locator(".rep-list > li").filter({ hasText: summary }).first();

  // A live page is a link, and it is built by `pageHref` from the page's own space key and path —
  // never from `routePath`, which is the one client-supplied string on the row.
  const liveRow = rowFor("against a live page");
  await expect(liveRow.locator("a.rep-page")).toHaveAttribute(
    "href",
    `/engineering/${live.path}`,
  );

  // Soft-deleted: flagged, named, and explicitly recoverable. No link.
  const takenRow = rowFor("against a page taken down");
  await expect(takenRow.locator(".adm-deleted")).toHaveText("Deleted");
  await expect(takenRow).toContainText("Taken down");
  await expect(takenRow.locator(".rep-note")).toContainText("soft-deleted, not gone");
  await expect(takenRow.locator("a.rep-page")).toHaveCount(0);

  // Absent: no title to show, and the route is what is left — which is the schema's whole argument
  // for the missing foreign key, arriving on a screen.
  const goneRow = rowFor("against a page that is gone");
  await expect(goneRow.locator(".rep-gone-text")).toContainText("No page with this id exists");
  await expect(goneRow.locator(".rep-route")).toHaveText(
    "/engineering/architecture/mqtt-contracts",
  );
  await expect(goneRow.locator("a.rep-page")).toHaveCount(0);
  // And the two are genuinely different sentences, which is the property that would be lost if the
  // resolution grew a `deletedAt: null` filter.
  await expect(goneRow).not.toContainText("soft-deleted, not gone");
});

/* -------------------------------------------------------------------------- */
/* The triage loop, walked in the order a triager walks it                    */
/* -------------------------------------------------------------------------- */

/**
 * Read the count, press the button, read the count again — and then follow the filter that count
 * labels.
 *
 * **Walked rather than asserted step by step**, which is the lesson Tasks 5 and 6 each paid for:
 * both found a control that deleted the sentence it was answering, and both found it only by doing
 * the loop in order. The three things this pins that no module test can: the count reaches the
 * tab, the press reaches the endpoint, and the page the triager is left looking at agrees with
 * what they were told.
 *
 * The filter is a **navigation** and not an in-page listing control, so it legitimately replaces
 * the feedback rather than deleting it mid-act — which is why this surface cannot reproduce Tasks
 * 5 and 6's defect in its own shape, and the walk is what establishes that rather than a comment.
 */
test("the inbox counts a new report, triages it, and the counts and the filter follow", async ({
  page,
}) => {
  const filed = await report({ summary: `${MARKER} triage me`, status: "NEW" });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/bugs");

  // The count first — the prediction half, on the tab the button is about to move a row between.
  const newTab = page.locator(".rep-filter a").filter({ hasText: "New" });
  await expect(newTab.locator(".adm-refs")).toHaveText("1");
  await expect(page.locator(".rep-filter a").filter({ hasText: "Triaged" }).locator(".adm-refs")).toHaveText("0");

  const row = page.locator(".rep-list > li").filter({ hasText: "triage me" }).first();
  await expect(row.locator(".rep-status")).toHaveText("New");
  await row.getByRole("button", { name: "Mark triaged" }).click();

  // What happened, and where the durable record of it is.
  await expect(row.locator(".adm-message")).toContainText("Moved from New to Triaged");
  await expect(row.locator(".adm-message")).toContainText("audit trail");

  // The page the triager is left on agrees: the chip, the counts and the disabled control.
  await expect(row.locator(".rep-status")).toHaveText("Triaged");
  await expect(newTab.locator(".adm-refs")).toHaveText("0");
  const triagedTab = page.locator(".rep-filter a").filter({ hasText: "Triaged" });
  await expect(triagedTab.locator(".adm-refs")).toHaveText("1");
  await expect(row.getByRole("button", { name: "Triaged", exact: true })).toBeDisabled();

  // And the filter that count labels actually filters.
  await triagedTab.click();
  await expect(page).toHaveURL(/\/admin\/bugs\?status=TRIAGED$/);
  await expect(page.locator(".rep-list > li")).toHaveCount(1);
  await page.locator(".rep-filter a").filter({ hasText: "New" }).click();
  await expect(page.locator(".rep-empty")).toHaveText("No report is new.");

  const stored = await db.bugReport.findUniqueOrThrow({
    where: { id: filed.id },
    select: { status: true },
  });
  expect(stored.status).toBe("TRIAGED");
});

test("an unknown status in the query string shows the whole list rather than a 404", async ({
  page,
}) => {
  // A query string is a view of a resource and not its identity, so an unrecognised one is ignored.
  await report({ summary: `${MARKER} still listed` });

  await signIn(page, "admin@example.com");
  const response = await page.goto("/admin/bugs?status=banana");
  expect(response?.status()).toBe(200);
  await expect(page.locator(".rep-list")).toContainText("still listed");
});

/* -------------------------------------------------------------------------- */
/* Overflow — the ninth shape, at five thousand characters                    */
/* -------------------------------------------------------------------------- */

/**
 * The class this project has met nine times, arriving at a scale none of them had.
 *
 * `consoleError` is bounded at **5000 characters** by `src/lib/bugs/schema.ts` and is pasted
 * console output — so a single unbroken line of that length is a realistic value and not a
 * contrived one, and it is more than sixteen times the 300-character `HOSTILE` every earlier probe
 * used. `summary`, `expected` and `routePath` are hostile too, and the page title on the linked
 * page is `HOSTILE`, so every element on the row that paints stored text has something to paint.
 *
 * Injected rather than hoped for: a guard that asserts a class over a fixed corpus is testing the
 * corpus, which is how the reader overflowed 4,660px for a whole phase.
 *
 * Counter-checked rather than trusted — see the assertion at the end, which reproduces the ninth
 * shape on this surface by making one element unable to shrink.
 */
const CONSOLE_FLOOD = "x".repeat(5000);

test("no viewport is widened by a 5000-character console error, a hostile route or a hostile title", async ({
  page,
}) => {
  const spaceId = await engineeringId();
  const wide = await seedPublishedPage({
    slug: "e2e-bug-overflow",
    title: HOSTILE,
    markdown: "# Wide\n\nOne paragraph.",
  });
  await report({
    summary: `${MARKER} ${HOSTILE}`,
    routePath: `/${HOSTILE}`,
    spaceId,
    pageId: wide.id,
    versionId: HOSTILE,
    consoleError: CONSOLE_FLOOD,
  });

  await signIn(page, "admin@example.com");

  for (const width of [1280, 1024, 800, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/bugs");

    // The non-vacuity half first: the hostile strings are genuinely on the screen, so a 0px
    // measurement is a guard holding rather than a page that failed to render them.
    await expect(page.locator(".rep-console")).toContainText("xxxxxxxxxx");
    await expect(page.locator(".rep-route")).toContainText("xxxxxxxxxx");

    const measured = await measureOverflow(page);
    // The tripwire `measureOverflow` documents: a zero-width viewport makes the subtraction come
    // out at zero too, which reads as a pass.
    expect(measured.width, `viewport ${width} reported no width`).toBeGreaterThan(0);
    expect(
      measured.overflow,
      `the 5000-character console error widens /admin/bugs at ${width}px`,
    ).toBe(0);

    // And each element that paints stored text, probed directly with the long token — the
    // page-level measurement above passes if a long string happens to land in a container that
    // scrolls internally.
    for (const selector of [
      ".rep-summary",
      ".rep-route",
      ".rep-console",
      ".rep-ua",
      ".rep-page",
      ".rep-file",
      ".rep-version",
      ".adm-email",
    ]) {
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
        { selector, token: CONSOLE_FLOOD },
      );
      expect(overflow, `${selector} widens the page at ${width}px`).toBe(0);
    }
  }

  /*
   * **The counter-check**, because a probe that has never seen the failure it is written for is a
   * probe nobody should trust. Task 3's ninth shape is `flex: none` on a box that paints stored
   * text: `overflow-wrap: anywhere` cannot break a token inside a box that is not allowed to
   * shrink, so the box takes its basis from its content and the document widens with it. Applied
   * to `.rep-summary`, the same page that measured 0px above measures **32,989px at 1280px** —
   * seven times the 4,660px reader overflow that started this class, because the token is 5000
   * characters and not 300.
   */
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/bugs");
  const reproduced = await page.evaluate((token) => {
    const target = document.querySelector(".rep-summary");
    if (!(target instanceof HTMLElement)) throw new Error("no .rep-summary to probe");
    target.textContent = token;
    target.style.flex = "none";
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  }, CONSOLE_FLOOD);
  expect(
    reproduced,
    "the overflow probe cannot see the shape it exists for — `flex: none` should widen the page",
  ).toBeGreaterThan(0);
});
