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
 * `/admin/git` — Phase 5 Task 8's failures list, at the address Phase 7 Task 7 moved it to.
 *
 * What this file is for, given that `src/components/MirrorFailures.test.tsx` already renders the
 * same component and asserts the same words under vitest: four things that a server-rendered
 * component cannot show, and that are exactly the ones these tasks' decisions rest on.
 *
 * 1. **The route resolves where it is claimed to, and the old one no longer does.** `/-/mirror`
 *    was a static segment at `[space]`'s own depth; `/admin/git` is a static leaf beside
 *    `/admin/spaces` and `/admin/systems`. The move is only a move if the old URL is gone, so this
 *    file asserts the 404 rather than assuming the directory deletion took.
 * 2. **The refusal, over HTTP, by two different people.** A member is 404'd and a signed-out
 *    visitor is sent to sign in — two guards refusing two people, and the pair is the point.
 * 3. **The two operator actions, walked in the order an operator walks them** — a count, then the
 *    button that acts on it, then the count again. Task 5 and Task 6 each found a defect that no
 *    module test could see by doing exactly that, and both were "a refusal (or a sentence) must
 *    survive the button it invites".
 * 4. **The overflow measurement**, which needs a layout engine. This surface brings the class its
 *    **eighth** shape: git's stderr with a JSON argv quoted into it is a single unbroken line of
 *    several hundred characters with no space anywhere, which is not a shape any of the seven
 *    before it had.
 *
 * The `GitJob` rows here are written directly rather than produced by a failing worker. Driving
 * the worker would need a real broken remote and five real pushes per fixture, and
 * `tests/integration/git-worker.test.ts` already owns that path and asserts the states it writes;
 * what this file is about is the surface that reads them. They are counted by `snapshotCounts`
 * and taken back out by `sweep()` — `GitJob` cascades from `Page`.
 */

let baseline: Counts;

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before admin-git: ${formatCounts(baseline)}`);
});

test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after admin-git:  ${formatCounts(after)}`);
  expect(after, "the admin-git suite did not leave the dev database as it found it").toEqual(baseline);
  await db.$disconnect();
});

/** A token shaped like the thing that actually leaks: a GitHub PAT in a remote URL. */
const TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";

/**
 * A `FAILED` job whose `lastError` carries a credential, as a push against a credentialed remote
 * would have produced before `repo.ts` learned to redact.
 *
 * Written raw on purpose: this is the row the *display* guard exists for — one an older build, or
 * a hand-run `UPDATE`, could leave behind. If the fixture were redacted first, the assertion below
 * would be testing the fixture.
 */
async function failedJob(
  pageId: string,
  over: { path?: string; lastError?: string | null } = {},
) {
  return await db.gitJob.create({
    data: {
      pageId,
      kind: "PUBLISH",
      state: "FAILED",
      spaceKey: "engineering",
      path: over.path ?? "e2e-mirror-failure",
      attempts: 5,
      lastError:
        over.lastError === undefined
          ? `Pushing to the content remote: git exited 128. ` +
            `Command: ["push","--","https://badam:${TOKEN}@github.example/org/repo.git",` +
            `"HEAD:refs/heads/main"]. ` +
            `Output: fatal: Authentication failed for ` +
            `'https://badam:${TOKEN}@github.example/org/repo.git/'`
          : over.lastError,
    },
    select: { id: true },
  });
}

/* -------------------------------------------------------------------------- */
/* The route, and the collision it sits on                                    */
/* -------------------------------------------------------------------------- */

test("a super admin reaches the failures page at /admin/git", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-stuck",
    title: "Stuck page",
    markdown: "# Stuck page\n\nOne paragraph.",
  });
  await failedJob(fixture.id, { path: fixture.path });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  await expect(page.locator("h1")).toHaveText("Git mirror");
  await expect(page.locator(".mir-list")).toContainText("Stuck page");
  // The mirror address as the job captured it, which is where the file was going.
  await expect(page.locator(".mir-file").first()).toHaveText(`engineering/${fixture.path}.md`);
});

test("the old /-/mirror address is a 404, and this one is the 200", async ({ page }) => {
  /*
   * **The move, asserted as a move.** Task 7 absorbed `/-/mirror` rather than copying it, and
   * deleted the route directory — so the old URL now falls through to `[space]/[...path]` with
   * `space = "-"`, finds no such space, and answers not-found. That is the decision this pair
   * pins: a redirect would have been a route answering *every* visitor from an address that is
   * otherwise a 404, which is the shape of the system this surface's refusal exists to withhold.
   *
   * The two assertions are one discrimination rather than two absences: the same signed-in super
   * admin gets the 200 from the new address in the same test, so the 404 is the old route being
   * gone and not a session that never worked.
   */
  await signIn(page, "admin@example.com");

  const moved = await page.goto("/admin/git");
  expect(moved?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("Git mirror");

  const old = await page.goto("/-/mirror");
  expect(old?.status()).toBe(404);
  // And it is the ordinary not-found, not a redirect that happens to land somewhere: the URL did
  // not change.
  await expect(page).toHaveURL(/\/-\/mirror$/);
});

/* -------------------------------------------------------------------------- */
/* The refusal — two guards, two people                                       */
/* -------------------------------------------------------------------------- */

test("a member of a space cannot reach it, and gets not-found rather than forbidden", async ({
  page,
}) => {
  /*
   * Not-found and not 403, for the reason `e2e/reader.spec.ts` states: a job list names pages
   * across every space, and a 403 from a route that is otherwise 404 tells an ordinary member
   * that a mirror-failures page exists.
   *
   * A **discrimination**, not an absence: the same signed-in person reads a real page in the line
   * below, so the 404 is a refusal and not a session that never worked.
   */
  await signIn(page, "aisyah@example.com");

  const refused = await page.goto("/admin/git");
  expect(refused?.status()).toBe(404);

  const allowed = await page.goto("/engineering/architecture/mqtt-contracts");
  expect(allowed?.status()).toBe(200);
});

test("a signed-out visitor is sent to sign in, and comes back to this page", async ({ page }) => {
  // The *other* guard. `requireViewer` refuses a different person from the module's
  // `isSuperAdmin` check, and each has to be shown refusing on its own — a refusal that survives
  // deleting the guard it names is a test of the other one.
  await page.context().clearCookies();
  await page.goto("/admin/git");
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=%2Fadmin%2Fgit/);
});

/* -------------------------------------------------------------------------- */
/* The credential                                                             */
/* -------------------------------------------------------------------------- */

test("a credential in a stored error never reaches the browser", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-secret",
    title: "Secret page",
    markdown: "# Secret page\n\nOne paragraph.",
  });
  await failedJob(fixture.id, { path: fixture.path });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  const body = await page.content();
  expect(body).not.toContain(TOKEN);
  expect(body).not.toContain("badam:");
  /*
   * The non-vacuity companion. A page that failed to render, a row that was filtered out and a
   * redactor that ate the whole message would each pass the two assertions above; what an
   * operator actually needs off this row is still on the screen.
   */
  const error = page.locator(".mir-err");
  await expect(error).toContainText("Authentication failed");
  await expect(error).toContainText("github.example/org/repo.git");
  await expect(error).toContainText("[redacted]@github.example");
});

/* -------------------------------------------------------------------------- */
/* What it says about the states that are neither failed nor healthy          */
/* -------------------------------------------------------------------------- */

test("an empty list says nothing has given up, and says what it cannot see", async ({ page }) => {
  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  await expect(page.locator(".mir-empty")).toHaveText("No mirror job has given up.");
  const gap = page.locator(".mir-gap");
  await expect(gap).toContainText("What this list does not cover");
  await expect(gap).toContainText("Pages published before the mirror existed");
  await expect(gap).toContainText("A run that never started");
  // The claim that has to survive an empty list: this is a queue, not a reconciliation.
  await expect(gap).toContainText("does not mean the mirror has run");
});

test("a change queued behind a failure is counted on it, and a retrying one is counted apart", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-blocked",
    title: "Blocked page",
    markdown: "# Blocked page\n\nOne paragraph.",
  });
  /*
   * `seedPublishedPage` publishes, and Task 4 makes a publish enqueue — so the fixture arrives
   * with a `PENDING` job of its own, *older* than the failure written below. That is a state the
   * worker could never produce (a job is unclaimable while an earlier one for its page is
   * unfinished, so the failure could not have been claimed with that row still pending), and
   * leaving it in makes the count assert an impossible queue. Cleared, so the fixture is a state
   * the product can actually reach. Found by running this test: the count came back 3.
   */
  await db.gitJob.deleteMany({ where: { pageId: fixture.id } });
  await failedJob(fixture.id, { path: fixture.path });
  // Two changes behind the failure, and one elsewhere that is merely retrying. Distinguishable:
  // if the two counts were the same query, one of these numbers would be wrong.
  await db.gitJob.createMany({
    data: [
      {
        pageId: fixture.id,
        kind: "PUBLISH",
        state: "PENDING",
        spaceKey: "engineering",
        path: fixture.path,
        attempts: 0,
      },
      {
        pageId: fixture.id,
        kind: "MOVE",
        state: "PENDING",
        spaceKey: "engineering",
        path: fixture.path,
        fromPath: fixture.path,
        attempts: 0,
      },
    ],
  });
  const retrying = await seedPublishedPage({
    slug: "e2e-mirror-retrying",
    title: "Retrying page",
    markdown: "# Retrying page\n\nOne paragraph.",
  });
  await db.gitJob.deleteMany({ where: { pageId: retrying.id } });
  await db.gitJob.create({
    data: {
      pageId: retrying.id,
      kind: "PUBLISH",
      state: "PENDING",
      spaceKey: "engineering",
      path: retrying.path,
      attempts: 2,
    },
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  await expect(page.locator(".mir-blocked")).toContainText(
    "2 changes to this page are queued behind this",
  );
  await expect(page.locator(".mir-gap")).toContainText("One change is waiting to be retried");
  // The retrying page is a state, not a failure, so it must not be in the list.
  await expect(page.locator(".mir-list")).not.toContainText("Retrying page");
  await expect(page.locator(".mir-list")).toContainText("Blocked page");
});

/* -------------------------------------------------------------------------- */
/* The two operator actions, walked in the order an operator walks them       */
/* -------------------------------------------------------------------------- */

/**
 * The retention sweep: read the count, press the button, read the count again.
 *
 * **Walked rather than asserted step by step**, which is the lesson Tasks 5 and 6 each paid for —
 * both found a defect (a control that deleted the sentence it was answering) only by doing the
 * loop in order. The three things this pins that no module test can: the count reaches the button's
 * label, the press reaches the endpoint, and the page an operator is left looking at agrees with
 * what they were told.
 *
 * The fixture job is 200 days old because the served build reads `GIT_JOB_RETENTION_DAYS` from the
 * environment and falls back to 90 — so this is outside any window the deployment can be in, and
 * the test does not depend on which.
 */
test("the sweep counts finished jobs, deletes them, and says what it did", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-retention",
    title: "Retention page",
    markdown: "# Retention page\n\nOne paragraph.",
  });
  // `seedPublishedPage` publishes, and a publish enqueues — so the page arrives with a PENDING job
  // of its own. Cleared, so the counts below are about the row this test wrote.
  await db.gitJob.deleteMany({ where: { pageId: fixture.id } });
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  await db.gitJob.create({
    data: {
      pageId: fixture.id,
      kind: "PUBLISH",
      state: "DONE",
      spaceKey: "engineering",
      path: fixture.path,
      attempts: 1,
      createdAt: old,
      updatedAt: old,
    },
    select: { id: true },
  });

  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  // The count first: the button says how much it is about to do, which is the prediction half.
  const sweepButton = page.getByRole("button", { name: /Sweep 1 finished job$/ });
  await expect(sweepButton).toBeEnabled();

  await sweepButton.click();

  // What happened, not what was predicted.
  const message = page.locator(".git-retention .adm-message");
  await expect(message).toContainText("1 finished job deleted");
  await expect(message).toContainText("Failures and queued changes were not touched.");

  // And the page an operator is left on agrees: the row is gone and the button has nothing to do.
  await expect(page.getByRole("button", { name: "Nothing to sweep" })).toBeDisabled();
  expect(await db.gitJob.count({ where: { pageId: fixture.id } })).toBe(0);
});

/**
 * The reconcile pass, walked the same way — and it is the one that writes rows for **seeded**
 * pages, so it cleans up after itself inside the test rather than leaning on `sweep()`.
 *
 * `sweep()` deletes `e2e-` pages and the audit rows this run wrote; a `GitJob` queued for a seeded
 * page is neither, and the suite's closing count equality is what would report it. Every job with
 * an id above the one taken before the press is deleted here, which is exact rather than
 * pattern-matched.
 *
 * The seeded corpus is the fixture: seven published pages, none of them mirrored (no worker runs in
 * this suite), which is precisely the shape this pass exists for — published before anything
 * queued them.
 */
test("the reconcile pass counts unmirrored pages, queues them, and empties its own count", async ({
  page,
}) => {
  const maxBefore = (await db.gitJob.aggregate({ _max: { id: true } }))._max.id ?? 0;

  await signIn(page, "admin@example.com");
  await page.goto("/admin/git");

  const counts = page.locator(".git-reconcile .git-counts");
  await expect(counts).toContainText("no commit and");
  // The breakdown: containers and integers, which is why this read writes no audit row.
  await expect(page.locator(".git-space-key").first()).toContainText(/engineering|handbook/);

  const queueButton = page.getByRole("button", { name: /^Queue \d+ pages?$/ });
  await expect(queueButton).toBeEnabled();
  const label = await queueButton.textContent();
  const expected = Number(/\d+/.exec(label ?? "")?.[0] ?? 0);
  expect(expected).toBeGreaterThan(0);

  await queueButton.click();

  const message = page.locator(".git-reconcile .adm-message");
  await expect(message).toContainText(`${expected} pages queued for the mirror.`);
  await expect(message).toContainText("Nothing published is unmirrored and unqueued any more.");

  // Pressing again is what a bounded pass invites, so the state it leaves has to make that safe:
  // every page it queued now has an unfinished job and is no longer its business.
  await expect(page.getByRole("button", { name: "Nothing to reconcile" })).toBeDisabled();

  const queued = await db.gitJob.findMany({
    where: { id: { gt: maxBefore } },
    select: { id: true, kind: true, state: true },
  });
  expect(queued).toHaveLength(expected);
  expect(queued.every((row) => row.kind === "PUBLISH" && row.state === "PENDING")).toBe(true);

  await db.gitJob.deleteMany({ where: { id: { gt: maxBefore } } });
});

test("a member cannot press either button, because the endpoints answer them not-found", async ({
  page,
}) => {
  /*
   * The refusal has to survive the *endpoint*, not only the page: a surface that 404s while its
   * two POST routes answer anybody would be a permission check on the wrong side of the fetch.
   * Driven as real requests from a real signed-in member's browser, so the session is genuine and
   * the answer is the route's.
   *
   * A **discrimination**: the same member reads a page they are entitled to in the line below, so
   * the two 404s are refusals rather than a session that never worked.
   */
  await signIn(page, "aisyah@example.com");

  for (const url of ["/api/admin/git/retention", "/api/admin/git/reconcile"]) {
    const response = await page.request.post(url);
    expect(response.status(), url).toBe(404);
    // Not-found, never forbidden — and asserted on the body this endpoint returns rather than on
    // the page's rendered text, because `not.toContain("forbidden")` fails on every page in this
    // product: Next 16 ships `forbidden()` and its name is in the client bundle.
    expect(await response.json()).toEqual({
      error: "not-found",
      message: "That page does not exist.",
    });
  }

  const allowed = await page.goto("/engineering/architecture/mqtt-contracts");
  expect(allowed?.status()).toBe(200);
  // Nothing was queued or deleted by the two refused requests.
  expect(await db.gitJob.count()).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* The affordance                                                             */
/* -------------------------------------------------------------------------- */

test("a stuck page's history offers the failures page to an admin and to nobody else", async ({
  page,
}) => {
  /*
   * The one link into the mirror's admin surface, which is also why the old URL needs no
   * redirect: it is generated from `ADMIN_GIT_PATH` and moved with it. Shipping a feature with
   * nothing pointing at it has happened
   * twice on this project and cost a whole extra task both times, and an unconditional link would
   * be a 404 offered to exactly the readers who cannot follow it.
   */
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-affordance",
    title: "Affordance page",
    markdown: "# Affordance page\n\nOne paragraph.",
  });
  await failedJob(fixture.id, { path: fixture.path });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/-/history/${fixture.path}`);
  // The editor is told the mirror is stuck — Task 7's notice — and is offered no link.
  await expect(page.locator(".ver-stuck")).toContainText("mirror is stuck");
  await expect(page.locator(".ver-failures")).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "admin@example.com");
  await page.goto(`/engineering/-/history/${fixture.path}`);
  await page.locator(".ver-failures").click();
  await expect(page.locator("h1")).toHaveText("Git mirror");
});

/* -------------------------------------------------------------------------- */
/* Overflow — the eighth shape                                                */
/* -------------------------------------------------------------------------- */

test("no viewport is widened by a hostile title, a hostile path or git's stderr", async ({
  page,
}) => {
  /*
   * The class this project has met seven times, arriving by its eighth shape. Three of the four
   * strings here are typed by a person (title, path, space key); the fourth is git's stderr with
   * the argv quoted into it, which is a single unbroken line of several hundred characters with no
   * space in it — a shape none of the seven had, and the reason `.mir-err` needs `anywhere`
   * alongside `pre-wrap` rather than `pre-wrap` alone.
   *
   * Injected rather than hoped for: a guard that asserts a class over a fixed corpus is testing
   * the corpus, which is how the reader overflowed 4,660px for a whole phase.
   */
  const fixture = await seedPublishedPage({
    slug: "e2e-mirror-overflow",
    title: HOSTILE,
    markdown: "# Wide\n\nOne paragraph.",
  });
  await failedJob(fixture.id, {
    path: fixture.path,
    lastError: `Pushing to the content remote: git exited 128. Command: ["push","--","${HOSTILE}"].`,
  });

  await signIn(page, "admin@example.com");

  for (const width of [1280, 1024, 800, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/git");

    const measured = await measureOverflow(page);
    // The tripwire `measureOverflow` documents: a zero-width viewport makes the subtraction come
    // out at zero too, which reads as a pass.
    expect(measured.width, `viewport ${width} reported no width`).toBeGreaterThan(0);
    expect(
      measured.overflow,
      `the seeded 300-character title and error widen /admin/git at ${width}px`,
    ).toBe(0);

    // And each element that paints stored text, probed directly — the page-level measurement
    // above passes if a long string happens to land in a container that scrolls internally.
    for (const selector of [".mir-title", ".mir-file", ".mir-err", ".git-space-key"]) {
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
      expect(overflow, `${selector} widens the page at ${width}px`).toBe(0);
    }
  }
});
