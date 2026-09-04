/**
 * End-to-end coverage for attachments (Phase 4, Task 18).
 *
 * The first suite to drive the whole upload → commit → read cycle over real HTTP: the browser
 * calls `POST /api/attachments` for a session URL, PUTs bytes directly to it (never through
 * this application), then `POST`s the commit so the server verifies against the store and flips
 * the row to `COMMITTED`. Reads proxy back through `GET /api/attachments/<id>`, permission
 * checked exactly like a page read.
 *
 * `BLOB_STORE=memory` in `playwright.config.ts`'s `webServer.env` is what makes any of this
 * reachable without tenant credentials: the session URL it mints points at
 * `PUT /api/attachments/dev-upload/<key>`, gated on `ALLOW_DEV_UPLOAD=1` **and** the memory
 * store. Without either flag every spec below fails at boot, which is `select.ts` working as
 * designed, not a suite bug.
 *
 * Only three identities are seeded: `aisyah@example.com` (editor of `engineering`),
 * `stranger@example.com` (member of nothing, here to demonstrate 404-not-403) and
 * `admin@example.com` (super admin, here only as "a second, different session").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { actorContext, seedPublishedPage, signIn, sweep } from "./support";

/** A 1×1 PNG, as bytes — small enough to inline and a real image, so decode is a real check. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A real, decodable H.264 MP4 — not a buffer of arbitrary bytes labelled `video/mp4`.
 *
 * That distinction is load-bearing rather than pedantic. This suite's property is "seeking
 * issues a 206", and a garbage buffer never gets that far: Chromium's media pipeline fails to
 * demux it, the element never leaves `HAVE_NOTHING`, and setting `currentTime` on a media
 * element in that state is a documented no-op — no seek algorithm runs and no network request
 * follows. The assertion would either hang on `waitForResponse` or, worse, pass for a reason
 * that has nothing to do with Range support.
 *
 * The fixture is a genuine two-second clip, generated once (via AVFoundation, moov-first) and
 * checked in at `e2e/fixtures/clip.mp4` rather than synthesised inline: a valid MP4 is a real
 * container format, not a string of bytes short enough to inline as base64 without turning this
 * file into an unreadable blob. Measured directly against this fixture and this application: on
 * load, Chromium's `preload="metadata"` (set by the render plugin) opens a `Range: bytes=0-`
 * request and **aborts it early** once it has enough to report a duration — for this file, after
 * roughly the first megabyte, a little under a second of the two. Seeking to a point in the
 * SECOND half of the clip is therefore the one time in `[0, duration)` where the browser
 * demonstrably does not already have the bytes, which is why the spec below seeks to 1.5s of a
 * 2s clip and not to the video's midpoint — 0.5s already falls inside that first megabyte and
 * would assert nothing.
 */
const MP4 = readFileSync(path.join(__dirname, "fixtures", "clip.mp4"));

// The pattern `lifecycle.spec.ts` settled on, and its reasoning applies here unchanged: not
// just an `afterEach`, because a fixture surviving a CRASHED run makes the next run's
// `createPage` fail on the unique `(spaceId, path)` index rather than starting clean.
test.beforeAll(sweep);
test.beforeEach(sweep);
test.afterAll(sweep);

/**
 * Clicks Publish and waits for the publish to actually land.
 *
 * Every other spec in this suite publishes through `seedPublishedPage`, i.e. the product's own
 * functions, so there is no established wait to copy. Clicking and navigating immediately
 * raced the POST: the reader then read the version from BEFORE the attachment reference was
 * published, which is how both of this file's original failures presented — a 404 on a
 * mis-built URL masked one and a missing `<video>` the other.
 */
async function publishAndWait(page: import("@playwright/test").Page) {
  const landed = page.waitForResponse(
    (response) => /\/api\/pages\/[^/]+\/publish$/.test(response.url()) && response.status() < 400,
  );
  await page.getByRole("button", { name: /publish/i }).click();
  await landed;
}

/** Attaches the fixture PNG through the editor and returns the attachment id from the inserted URL. */
async function attachThroughEditor(page: import("@playwright/test").Page, pageId: string) {
  await page.goto(`/edit/${pageId}`);
  await page.getByLabel(/attach/i).setInputFiles({
    name: "shot.png", mimeType: "image/png", buffer: PNG,
  });
  // The progress row disappears when the commit lands. Waiting on the reference itself would
  // pass on a half-finished upload whose bytes never arrived.
  await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: 30_000 });

  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("/api/attachments/");
  const text = await editor.innerText();
  return text.match(/\/api\/attachments\/([a-z0-9]+)/)![1];
}

test("an editor attaches an image and another member's browser renders it", async ({
  page,
  browser,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach", title: "Attach", markdown: "# Attach\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);
  await publishAndWait(page);

  // A SECOND identity, with its own cookie jar. The property is that the reader's browser
  // fetches the bytes through the proxy under the READER's session — asserting the Markdown
  // contains a URL would not test that.
  //
  // `admin@example.com` because the seed has exactly three identities: aisyah (editor),
  // stranger (member of nothing) and admin. This spec's property is "a different session
  // renders it"; whether MEMBERSHIP is what admits them is the next spec's job.
  const reader = await actorContext(browser, "admin@example.com");
  const response = await reader.page.goto(`/engineering/${fixture.path}`);
  expect(response!.status()).toBe(200);

  const image = reader.page.locator(`img[src="/api/attachments/${id}"]`);
  await expect(image).toBeVisible();
  // A 404 still renders an <img> element. Only a decoded bitmap has a naturalWidth.
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await reader.context.close();
});

test("a non-member gets 404 on the attachment URL", async ({ page, browser }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-private", title: "Private", markdown: "# Private\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);

  // `stranger@example.com` is a member of nothing — the seeded identity Phase 1 added to
  // demonstrate 404-not-403.
  const outsider = await actorContext(browser, "stranger@example.com");
  const response = await outsider.page.request.get(`/api/attachments/${id}`);
  expect(response.status()).toBe(404);
  await outsider.context.close();
});

test("an unsupported type is refused with the server's own message, and inserts nothing", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-refused", title: "Refused", markdown: "# Refused\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${fixture.id}`);

  await page.getByLabel(/attach/i).setInputFiles({
    name: "payload.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ"),
  });

  await expect(page.getByText(/cannot be attached/i)).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText("/api/attachments/");
});

test("a video plays and seeking issues a 206", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-video", title: "Video", markdown: "# Video\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${fixture.id}`);
  await page.getByLabel(/attach/i).setInputFiles({
    name: "clip.mp4", mimeType: "video/mp4", buffer: MP4,
  });
  await expect(page.getByRole("progressbar")).toHaveCount(0, { timeout: 30_000 });
  // The `/video` suffix is what the render plugin matches on.
  await expect(page.locator(".cm-content")).toContainText("/video)");
  await publishAndWait(page);

  await page.goto(`/engineering/${fixture.path}`);
  const video = page.locator("video");
  await expect(video).toBeVisible();
  // The metadata-only preload has to actually finish parsing the container before a seek means
  // anything — on `HAVE_NOTHING` a seek is a documented no-op. `duration` is set once Chromium
  // has decoded enough of a REAL mp4 to know it; a garbage buffer never reaches this state.
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.duration)).toBeGreaterThan(0);

  // A <video> element that renders but cannot seek is exactly what a Range bug produces, so the
  // 206 is the assertion, not the element. Seeking into the SECOND half of the two-second clip,
  // not its midpoint — see the comment on `MP4` above for why 0.5s does not exercise this.
  const partial = page.waitForResponse(
    (response) => response.url().includes("/api/attachments/") && response.status() === 206,
  );
  await video.evaluate((node: HTMLVideoElement) => {
    node.currentTime = 1.5;
  });
  expect((await partial).status()).toBe(206);
});

test("removing an attachment makes it 404 immediately, for the editor who owns it", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-attach-removed", title: "Removed", markdown: "# Removed\n\nBody.",
  });
  await signIn(page, "aisyah@example.com");
  const id = await attachThroughEditor(page, fixture.id);

  expect((await page.request.get(`/api/attachments/${id}`)).status()).toBe(200);
  expect((await page.request.delete(`/api/attachments/${id}`)).status()).toBe(204);
  // No cache revalidation involved: `request` is not the page's HTTP cache. The soft-delete
  // takes effect on the next fetch, which is the guarantee the design actually makes.
  expect((await page.request.get(`/api/attachments/${id}`)).status()).toBe(404);
});
