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
 * Phase 7 Task 3 — `/systems` and `/systems/[key]`, over HTTP.
 *
 * What this file is for, given that `tests/integration/systems-read.test.ts` already asserts every
 * rule the query owns: four things a vitest run cannot show.
 *
 * 1. **The seeded corpus renders.** Three of the seven seeded systems have no `repoUrl` and
 *    `kiosk-bridge` is seeded `isActive: false` **on purpose**, so §7's "active or sunsetting"
 *    and "no repository" both exist in real data rather than only in a fixture. Task 1 said in as
 *    many words that Task 3 must render them from the corpus, because "a guard that asserts a
 *    class over a fixed corpus is testing the corpus" — the inverse of which is that a class the
 *    corpus *does* contain should be asserted against it.
 * 2. **The overflow class, ninth shape.** It needs a layout engine, and it needs the hostile case
 *    **injected**: this surface paints an admin-typed system name, owning team, description and
 *    repository URL, plus an author's title, path and space name from a space the viewer may
 *    never have opened. The probe found a real 515px overflow at 1280px before `doc.css` grew the
 *    rules beside `.sys-key`.
 * 3. **A credentialed `repoUrl` never reaches the browser.** Task 1 handed this task one end of
 *    Phase 5 Task 8's finding, and Phase 5's lesson was that removing either end alone still
 *    leaks — so this end is asserted where the leak would happen, in the HTML.
 * 4. **The affordance.** Two features have shipped in this project with nothing linking to them.
 *    The top bar's link is asserted here rather than assumed.
 *
 * The two-viewer discrimination is deliberately **not** here. It needs two spaces with disjoint
 * memberships and the seeded corpus has one `MEMBERS` space and one `ALL_STAFF` one, so an e2e
 * version would either be near-vacuous or need a third space — which would disturb the
 * `2 spaces / 7 pages` baseline every other suite and `scripts/smoke.sh` assert. It lives in
 * `tests/integration/systems-read.test.ts`, against real SQL, where it can have two.
 */

let baseline: Counts;

/** Systems this suite creates. Not swept by slug — `sweep()` knows about pages. */
const E2E_SYSTEM_KEYS = ["e2e-hostile-system"];

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before systems: ${formatCounts(baseline)}`);
});

test.beforeEach(sweep);

test.afterAll(async () => {
  // Pages first, then the systems: `PageSystem.systemId` is `onDelete: Restrict` (Task 1), so a
  // system with a fixture still naming it refuses to be deleted — which is the constraint working,
  // and it would surface here as a failed teardown rather than as a leak.
  await sweep();
  await db.system.deleteMany({ where: { key: { in: E2E_SYSTEM_KEYS } } });
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after systems:  ${formatCounts(after)}`);
  expect(after, "the systems suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/** A token shaped like the thing that actually leaks — Task 1 found this exact form on this machine. */
const TOKEN = "glpat-e2eF292c6912E7710c838347Ae178B4a";

/* -------------------------------------------------------------------------- */
/* The catalogue, over the seeded corpus                                      */
/* -------------------------------------------------------------------------- */

test("the catalogue lists the seeded systems, with §7's metadata", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  const response = await page.goto("/systems");
  expect(response?.status()).toBe(200);

  await expect(page.locator("h1")).toHaveText("Systems");
  // Bound to the list's own markup and not to the page body, for the reason Phase 3 Task 13
  // recorded: a title-shaped needle anywhere on a reader page passes for free.
  const list = page.locator(".sys-list");
  for (const key of [
    "store-ios",
    "display-ios",
    "order-hub",
    "pricing-engine",
    "backend",
    "kiosk-bridge",
    "admin-web",
  ]) {
    await expect(list.locator(".sys-key", { hasText: key })).toHaveCount(1);
  }
  // §7's kind and owning team, on a row bound to its own key.
  const hubCore = page.locator(".sys-row", { has: page.locator(".sys-key", { hasText: "order-hub" }) });
  await expect(hubCore.locator(".sys-kind")).toHaveText("LIBRARY");
  await expect(hubCore.locator(".sys-team")).toHaveText("Hub");
  await expect(hubCore.locator("a.sys-repo")).toHaveAttribute(
    "href",
    "https://git.acme-corp.dev/acme/hub/order-hub-gateway.git",
  );
});

test("the two states the seed put in the corpus on purpose both render", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/systems");

  // `kiosk-bridge` is seeded `isActive: false` because the seeded ADR already says the bridge
  // is on its way out — §7's "active or sunsetting", with both branches in real data.
  const bridge = page.locator(".sys-row", {
    has: page.locator(".sys-key", { hasText: "kiosk-bridge" }),
  });
  await expect(bridge.locator(".sys-sunset")).toHaveText("Sunsetting");

  // `backend` has no `repoUrl`: there is no checkout of it on this machine, and the seed's own
  // comment says a wrong link in a service catalogue is worse than no link.
  const backend = page.locator(".sys-row", {
    has: page.locator(".sys-key", { hasText: "backend" }),
  });
  await expect(backend.locator(".sys-repo-none")).toHaveText("No repository recorded");
  await expect(backend.locator("a.sys-repo")).toHaveCount(0);

  // The non-vacuity companion for both: an active system with a repository, on the same page, so
  // "no badge" and "no link" cannot be a page that rendered nothing.
  const posIos = page.locator(".sys-row", {
    has: page.locator(".sys-key", { hasText: "store-ios" }),
  });
  await expect(posIos.locator(".sys-sunset")).toHaveCount(0);
  await expect(posIos.locator("a.sys-repo")).toHaveCount(1);
});

test("a sunsetting system's own page says so, and its groups are still there", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  const response = await page.goto("/systems/kiosk-bridge");
  expect(response?.status()).toBe(200);

  await expect(page.locator("h1")).toHaveText("Kiosk bridge");
  await expect(page.locator(".sys-sunset-note")).toContainText("being sunsetted");
  // Task 2 decided a page may declare a sunsetting system, because the documents that most need
  // the facet are the ones written about a retirement. A page that hid the groups for one would
  // be that decision undone on the read side.
  await expect(page.locator(".sys-empty")).toHaveCount(1);
});

test("an unknown system key is not-found, and a mixed-case one resolves", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  expect((await page.goto("/systems/no-such-system"))?.status()).toBe(404);
  // `foldSystemKey`, the same fold Task 2 applies to an author's `systems:` value.
  expect((await page.goto("/systems/ORDER-HUB"))?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText("Order hub");
});

/* -------------------------------------------------------------------------- */
/* A page declares a system and lands on its page                             */
/* -------------------------------------------------------------------------- */

test("a published page's declared system puts it on that system's page, in its group", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-systems-runbook",
    title: "Gantry weighing procedure",
    markdown: "---\nsystems: [order-hub]\n---\n\n# Gantry\n\nWeigh before departure.\n",
    docType: "RUNBOOK",
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/systems/order-hub");

  // Bound to the group's own list, not to the page: the heading, the blurb and the lead all name
  // the system, so a body-level needle would pass with the query returning nothing.
  const runbooks = page.locator(".sys-group", { has: page.getByRole("heading", { name: "Runbooks" }) });
  const row = runbooks.locator(".sys-doc", { hasText: "Gantry weighing procedure" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".sys-space")).toHaveText("Engineering");
  await expect(row.locator(".sys-path")).toHaveText(fixture.path);
  // And the link goes where it says.
  await expect(row.locator("a.sys-title")).toHaveAttribute(
    "href",
    `/engineering/${fixture.path}`,
  );

  // The other groups are present and empty, which is what makes "grouped by doc type" a shape
  // rather than a coincidence of what happens to be written.
  for (const heading of ["Decisions", "Open RFCs", "Other documentation"]) {
    const group = page.locator(".sys-group", { has: page.getByRole("heading", { name: heading }) });
    await expect(group.locator(".sys-none-row")).toHaveCount(1);
  }
  // The heading is honest about what it excludes, in the words `groups.ts` derives.
  const rfcs = page.locator(".sys-group", { has: page.getByRole("heading", { name: "Open RFCs" }) });
  await expect(rfcs.locator(".sys-blurb")).toContainText("IN_REVIEW");
  await expect(rfcs.locator(".sys-blurb")).toContainText("CLOSED");
});

/* -------------------------------------------------------------------------- */
/* The overflow class, ninth shape — injected, never hoped for                */
/* -------------------------------------------------------------------------- */

test("neither route scrolls horizontally, whatever an admin and an author typed", async ({
  page,
}) => {
  await db.system.create({
    data: {
      key: "e2e-hostile-system",
      name: HOSTILE,
      kind: "SERVICE",
      ownerTeam: HOSTILE,
      description: HOSTILE,
      // A credentialed URL that is ALSO 300 unbroken characters, so the row is hostile in both
      // ways at once — and the assertion below can tell "not linked" from "not rendered".
      repoUrl: `https://oauth2:${TOKEN}@gitlab.example.com/${"y".repeat(200)}.git`,
    },
    select: { key: true },
  });
  const fixture = await seedPublishedPage({
    slug: "e2e-hostile-page",
    title: HOSTILE,
    markdown: "---\nsystems: [e2e-hostile-system]\n---\n\n# Hostile\n\nOne paragraph.\n",
  });
  expect(fixture.title).toBe(HOSTILE);

  await signIn(page, "aisyah@example.com");

  for (const width of [1280, 860, 380]) {
    await page.setViewportSize({ width, height: 900 });
    for (const url of ["/systems", "/systems/e2e-hostile-system"]) {
      await page.goto(url);
      const { overflow, width: clientWidth } = await measureOverflow(page);
      // `clientWidth` is asserted non-zero because a zero-width viewport makes the subtraction
      // come out at zero too, which reads as a pass — Phase 5 Task 7 lost time to exactly that.
      expect(clientWidth, `${url} at ${width}px reported no width`).toBeGreaterThan(0);
      expect(overflow, `${url} at ${width}px scrolls horizontally`).toBe(0);
    }
  }
});

test("a credentialed repoUrl is neither linked nor printed", async ({ page }) => {
  // The system this needs is created by the test above; recreated here so this test does not
  // depend on file ordering, and `create` would collide if it survived — `sweep()` does not touch
  // systems, so it is removed first.
  await db.system.deleteMany({ where: { key: "e2e-hostile-system" } });
  await db.system.create({
    data: {
      key: "e2e-hostile-system",
      name: "Leaky system",
      kind: "SERVICE",
      repoUrl: `https://oauth2:${TOKEN}@gitlab.example.com/acme/hub/order-hub-gateway.git`,
    },
    select: { key: true },
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/systems/e2e-hostile-system");

  const html = await page.content();
  expect(html).not.toContain(TOKEN);
  expect(html).not.toContain("oauth2:");
  // Withheld, not redacted: the host does not appear either, because a redaction is a
  // transformation of a secret and this surface has no reason to hold one.
  expect(html).not.toContain("gitlab.example.com");
  await expect(page.locator("a.sys-repo")).toHaveCount(0);

  /*
   * The non-vacuity companion. A page that failed to render, a system that was filtered out and a
   * redactor that ate the whole row would each pass the four assertions above; what a reader
   * needs is still on the screen, and it says what to do.
   */
  await expect(page.locator("h1")).toHaveText("Leaky system");
  await expect(page.locator(".sys-repo-held")).toContainText("embeds a username or password");
});

/* -------------------------------------------------------------------------- */
/* Guards, and the affordance                                                 */
/* -------------------------------------------------------------------------- */

test("a signed-out visitor is sent to sign in, and comes back to the system they asked for", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/systems/order-hub");
  await expect(page).toHaveURL(/\/api\/auth\/signin\?callbackUrl=%2Fsystems%2Forder-hub/);
});

test("the top bar reaches the catalogue from inside a space", async ({ page }) => {
  // Two features have shipped in this project with nothing linking to them — `movePage` and
  // `/search` — and both were found late by asking "can a person get to this?" rather than by a
  // test. This is that question, asked in the task that builds the thing.
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering");
  await page.getByRole("link", { name: "Systems" }).click();
  await expect(page).toHaveURL(/\/systems$/);
  await expect(page.locator("h1")).toHaveText("Systems");
});
