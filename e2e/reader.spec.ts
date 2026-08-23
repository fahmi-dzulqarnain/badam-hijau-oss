import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/api/auth/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /test login/i }).click();
  await expect(page).not.toHaveURL(/signin/);
}

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
  await signIn(page, "aisyah@example.com");

  for (const path of [
    "/engineering",
    "/engineering/architecture/mqtt-contracts",
    "/engineering/architecture/mqtt-contracts/topic-registry",
    "/handbook/welcome",
  ]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBe(0);
  }
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
  await dialog.getByLabel("What happened?").fill("The table of contents skips a heading.");
  await dialog.getByRole("button", { name: "Send report" }).click();

  await expect(dialog.getByText(/Thanks/)).toBeVisible();
});
