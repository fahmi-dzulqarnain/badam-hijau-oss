/**
 * End-to-end coverage of authoring (Phase 2, Task 14).
 *
 * Every test here writes to the **development** database and takes its rows back out; see
 * `support.ts` for why that is the only database it can be and how the sweep works. The
 * `afterAll` at the bottom asserts the counts are back where `beforeAll` found them, so a leak
 * fails the run instead of making the *next* run fail on an occupied path.
 *
 * Two of these tests exist because they are the only place their property can be pinned:
 *
 * - **The redirect lookup's position in the request.** Task 11 measured that hoisting the
 *   lookup above the page read returns a 308 away from a page that renders — and that the
 *   entire vitest suite still passed, because the ordering is a property of the route, not of
 *   any function. Verified here by mutation: with the lookup hoisted this test sees 308.
 * - **Two identities at once.** The conflict banner needs a genuinely different editor name,
 *   which needs two sessions. `browser.newContext()` gives two cookie jars in one browser —
 *   see `actorContext`.
 */
import { expect, test, type Locator } from "@playwright/test";
import {
  actorContext,
  db,
  engineeringId,
  formatCounts,
  HOSTILE,
  measureOverflow,
  seedPublishedPage,
  signIn,
  snapshotCounts,
  sweep,
  viewerFor,
  type Counts,
} from "./support";
import { createPage } from "@/lib/pages/create";
import { movePage } from "@/lib/pages/move";
import { deletePage } from "@/lib/pages/delete";

// The 300-character unbreakable token — the shape that has now widened this application's layout
// six times, and the length Task 8 measured a 4,660-pixel reader overflow from. The fifth was
// found by this task; see the tail of `doc.css` and the title probe in `reader.spec.ts`. It moved
// to `support.ts` when Phase 3's lifecycle spec became the third file to need it.

/** Meaty enough that "the preview matches" is a claim about the pipeline, not about a word. */
const RICH_MARKDOWN = [
  "Intro paragraph with `inline code` and a [link](https://example.com/a/b).",
  "",
  "## A heading with an id",
  "",
  "| Segment | Owner |",
  "| --- | --- |",
  "| `outlet` | Provisioning |",
  "",
  "```ts",
  "await client.subscribe('acme/+/kiosk/#');",
  "```",
  "",
  "```mermaid",
  "C4Context",
  "```",
  "",
  "### Deeper heading",
  "",
  "Closing paragraph.",
  "",
].join("\n");

let baseline: Counts;

test.beforeAll(async () => {
  await sweep();
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before authoring: ${formatCounts(baseline)}`);
});

// Not just `afterEach`. A fixture surviving a crashed run makes the next run's `createPage`
// fail with `path-occupied`, which looks like a product bug and is not one.
test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after authoring:  ${formatCounts(after)}`);
  // The idempotence contract, asserted rather than described. The suite runs against a database
  // a person also uses, so "it cleaned up" has to be a test result and not a promise in a
  // comment — and a suite that only passes on a fresh database is a suite that fails on its
  // second run.
  expect(after, "the authoring suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/* ------------------------------------------------------------------ the headline flow ---- */

test("an editor creates a page, writes Markdown, autosaves, publishes, and a member reads it", async ({
  browser,
}) => {
  const editor = await actorContext(browser, "aisyah@example.com");

  await editor.page.goto("/new");
  await editor.page.getByLabel("Title").fill("Kiosk runbook");
  // The slug is prefilled from the title and then taken over, which is also how every fixture
  // in this file acquires the `e2e-` marker the sweep keys on.
  await expect(editor.page.getByLabel("Slug")).toHaveValue("kiosk-runbook");
  await editor.page.getByLabel("Slug").fill("e2e-kiosk-runbook");
  await editor.page.getByRole("button", { name: /create draft/i }).click();

  await expect(editor.page).toHaveURL(/\/edit\/[a-z0-9]+$/);
  const pageId = new URL(editor.page.url()).pathname.split("/").pop()!;

  // A page created this way is a draft, so it is not readable yet — the property the nav rail
  // and the reader have both relied on since Phase 1.
  const beforePublish = await editor.page.request.get("/engineering/e2e-kiosk-runbook");
  expect(beforePublish.status()).toBe(404);

  // The document lives in CodeMirror, not in React state. `fill` on the contenteditable goes
  // through `insertText`, which is the same path a paste takes, so the newlines survive — a
  // `keyboard.type` would instead hand every newline to the Markdown language's Enter binding
  // and get list markers continued for us.
  const surface = editor.page.locator(".cm-content");
  await surface.click();
  await surface.fill(RICH_MARKDOWN);

  const status = editor.page.locator(".ed-status");
  // Autosave is a 2 s debounce armed by the first edit, so there is a real interval in which
  // the indicator must say the work is not stored yet. That it says so is the assertion.
  await expect(status).toHaveText("Unsaved changes");
  await expect(status).toHaveText(/^Saved \d/, { timeout: 15_000 });

  // What landed is what was typed — the indicator is not taken on trust.
  const draft = await db.pageDraft.findUniqueOrThrow({
    where: { pageId },
    select: { markdown: true, title: true },
  });
  expect(draft.markdown).toBe(RICH_MARKDOWN);
  expect(draft.title).toBe("Kiosk runbook");

  await editor.page.getByRole("button", { name: "Publish" }).click();
  await expect(editor.page).toHaveURL(/\/engineering\/e2e-kiosk-runbook$/, {
    timeout: 15_000,
  });
  await expect(
    editor.page.getByRole("heading", { level: 1, name: "Kiosk runbook" }),
  ).toBeVisible();

  // Publish deletes the draft; the version is the durable copy.
  expect(await db.pageDraft.count({ where: { pageId } })).toBe(0);
  expect(await db.pageVersion.count({ where: { pageId } })).toBe(1);

  // Read by a *different* member, in their own session, so this is the reader's permission
  // path and not the author's cached render.
  const reader = await actorContext(browser, "admin@example.com");
  const response = await reader.page.goto("/engineering/e2e-kiosk-runbook");
  expect(response?.status()).toBe(200);
  await expect(
    reader.page.getByRole("heading", { level: 1, name: "Kiosk runbook" }),
  ).toBeVisible();
  await expect(
    reader.page.getByRole("navigation", { name: "On this page" }),
  ).toContainText("A heading with an id");

  await editor.context.close();
  await reader.context.close();
});

test("the preview pane renders exactly what the published page renders", async ({ page }) => {
  // The one thing a preview exists to rule out is preview and published output disagreeing, so
  // the assertion is string equality of the two `.body` subtrees rather than a spot check on a
  // heading. Both come from `renderMarkdown` — the editor's through `/api/preview`, the
  // reader's through the route — and if the preview ever stops going through the shared
  // pipeline this is the test that says so.
  const fixture = await seedPublishedPage({
    slug: "e2e-preview-parity",
    title: "Preview parity",
    markdown: RICH_MARKDOWN,
  });

  await signIn(page, "aisyah@example.com");

  await page.goto(`/edit/${fixture.id}`);
  const previewBody = page.locator(".ed-preview .body");
  await expect(previewBody).toBeVisible();
  // The first render is fired on mount from the same seed the view is built from; wait for it
  // to have produced something rather than comparing an empty pane to a full one.
  await expect(previewBody.locator("h2")).toBeVisible();
  await settleDiagrams(previewBody);
  const previewHtml = normaliseDiagramIds(await previewBody.innerHTML());

  await page.goto(`/engineering/${fixture.path}`);
  const publishedBody = page.locator(".doc .body");
  await settleDiagrams(publishedBody);
  const publishedHtml = normaliseDiagramIds(await publishedBody.innerHTML());

  expect(previewHtml).toBe(publishedHtml);
  // Guards the comparison itself: two empty strings are also equal.
  expect(previewHtml).toContain("<h2");
  expect(previewHtml).toContain("shiki");
  expect(previewHtml).toContain("mermaid-source");
});

/**
 * Both surfaces now hydrate their ```mermaid fences (Phase 4 Task 5), so this comparison has to
 * wait for both to reach a terminal state.
 *
 * Without it the test is a **race**, and it failed as one the first time both sides gained
 * hydration: the published page had settled to `mermaid-failed` while the preview was still showing
 * the un-hydrated placeholder, and the diff was the same fence in two different states. Waiting is
 * also the stronger assertion — the two surfaces must now agree about the *rendered diagram*, not
 * only about the markup around it, which is exactly what sharing one component is for.
 *
 * `RICH_MARKDOWN`'s fence is a bare `C4Context`, which does not parse, so both sides land on
 * `mermaid-failed`. That is deliberate on both counts: it exercises the error-in-place path from
 * this test too, and a *successful* render would put a generated `mermaid-svg-N` id in the markup.
 */
async function settleDiagrams(body: Locator): Promise<void> {
  const fences = await body.locator(".mermaid-source").count();
  for (let index = 0; index < fences; index += 1) {
    await expect(body.locator(".mermaid-source").nth(index)).toHaveClass(
      /mermaid-(ready|failed)/,
    );
  }
}

/**
 * The diagram ids are a module-level counter in `DocBody`, so the preview's are not the published
 * page's and never can be — the preview draws first, in the same browsing context.
 *
 * Normalised rather than excluded, so a diagram that *does* render still has its whole SVG compared;
 * only the ids are neutralised. There is nothing to neutralise on today's fixture, which is why this
 * is here for the next one.
 */
function normaliseDiagramIds(html: string): string {
  return html.replace(/mermaid-svg-\d+/g, "mermaid-svg-N");
}

/* --------------------------------------------------------------- the conflict contract ---- */

test("a second editor's save conflicts; Load theirs replaces the text and Keep mine wins", async ({
  browser,
}) => {
  const viewer = await viewerFor("aisyah@example.com");
  const created = await createPage(viewer, {
    spaceId: await engineeringId(),
    parentId: null,
    slug: "e2e-conflict",
    title: "Contested page",
    docType: "DOC",
  });
  if (!created.ok) throw new Error(`createPage: ${JSON.stringify(created)}`);
  const pageId = created.page.id;

  // Two cookie jars, two people. See `actorContext` for why this replaces Task 7's scripted
  // second actor: the banner has to name someone, and it can only name whoever the server
  // resolved from the session that made the earlier save.
  const aisyah = await actorContext(browser, "aisyah@example.com");
  const fahmi = await actorContext(browser, "admin@example.com");

  // Both load before either types, so both hold the same `seen`. Opening them in the other
  // order would hand the second editor an already-current timestamp and no conflict.
  await aisyah.page.goto(`/edit/${pageId}`);
  await fahmi.page.goto(`/edit/${pageId}`);
  await expect(aisyah.page.locator(".cm-content")).toBeVisible();
  await expect(fahmi.page.locator(".cm-content")).toBeVisible();

  await aisyah.page.locator(".cm-content").fill("Aisyah's first paragraph.\n");
  await expect(aisyah.page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });

  await fahmi.page.locator(".cm-content").fill("Fahmi's competing paragraph.\n");
  const banner = fahmi.page.locator(".ed-conflict");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  // The name is the whole point of two identities: with one session this reads "Fahmi D."
  // regardless of whether the conflict logic works.
  await expect(banner).toContainText("Aisyah R.");
  await expect(banner).toContainText("Your changes have not been saved");
  // Autosave suspends behind an unanswered banner rather than 409ing every two seconds.
  await expect(fahmi.page.locator(".ed-hint")).toHaveText(/Autosave is paused/);
  // Nothing was written: the refusal is a refusal, and Fahmi's text is only on his screen.
  await expect(fahmi.page.locator(".cm-content")).toContainText("Fahmi's competing paragraph.");
  expect(
    (await db.pageDraft.findUniqueOrThrow({ where: { pageId }, select: { markdown: true } }))
      .markdown,
  ).toBe("Aisyah's first paragraph.\n");

  // Load theirs: the editor is replaced by their text, and the banner goes.
  await banner.getByRole("button", { name: "Load theirs" }).click();
  await expect(fahmi.page.locator(".cm-content")).toContainText("Aisyah's first paragraph.");
  await expect(fahmi.page.locator(".cm-content")).not.toContainText("competing");
  await expect(banner).toHaveCount(0);
  await expect(fahmi.page.locator(".ed-hint")).toHaveText(/Saves automatically/);

  // Now the other resolution. Aisyah saves again, which makes Fahmi's `seen` stale a second
  // time; this time he overwrites.
  await aisyah.page.locator(".cm-content").fill("Aisyah's second paragraph.\n");
  await expect(aisyah.page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });

  await fahmi.page.locator(".cm-content").fill("Fahmi keeps his own.\n");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await banner.getByRole("button", { name: "Keep mine" }).click();
  await expect(fahmi.page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });
  await expect(banner).toHaveCount(0);

  // Keep mine is an explicit overwrite of a version he was shown, so his text and his name are
  // what the row now carries.
  const final = await db.pageDraft.findUniqueOrThrow({
    where: { pageId },
    select: { markdown: true, updatedBy: { select: { name: true } } },
  });
  expect(final.markdown).toBe("Fahmi keeps his own.\n");
  expect(final.updatedBy.name).toBe("Fahmi D.");

  await aisyah.context.close();
  await fahmi.context.close();
});

/* -------------------------------------------------------------------- move and delete ---- */

test("a moved page's old URL permanently redirects to the new one", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-move-from",
    title: "Relocatable runbook",
    markdown: "Recovery steps for the kiosk bridge.\n",
  });

  await signIn(page, "aisyah@example.com");
  expect((await page.goto(`/engineering/${fixture.path}`))?.status()).toBe(200);

  // Phase 2 ships `movePage` as a module with no HTTP surface and no UI — see the report on
  // this task. The redirect this test is about is a property of the *reader*, and it is
  // reached over HTTP; the move itself goes through the product's own function rather than a
  // hand-written `Redirect` insert, so the rows under test are the rows a move really writes.
  const moved = await movePage(await viewerFor("aisyah@example.com"), fixture.id, {
    newParentId: null,
    newSlug: "e2e-move-to",
  });
  if (!moved.ok) throw new Error(`movePage: ${JSON.stringify(moved)}`);
  expect(moved.page.path).toBe("e2e-move-to");

  // 308 and not the spec's 301, deliberately: `permanentRedirect()` emits 308, which forbids
  // an intermediary rewriting the method on the retry. Recorded as spec §14 drift by Task 11.
  const raw = await page.request.get(`/engineering/${fixture.path}`, { maxRedirects: 0 });
  expect(raw.status()).toBe(308);
  expect(raw.headers()["location"]).toBe("/engineering/e2e-move-to");

  // And it actually lands, rather than merely pointing somewhere.
  const followed = await page.goto(`/engineering/${fixture.path}`);
  expect(followed?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe("/engineering/e2e-move-to");
  await expect(page.getByRole("heading", { level: 1, name: fixture.title })).toBeVisible();
});

test("a deleted page 404s and leaves the nav rail", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-deletable",
    title: "Deletable decision",
    markdown: "This page is about to go.\n",
  });

  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering");
  const railLink = page
    .getByRole("navigation", { name: "Engineering navigation" })
    .getByRole("link", { name: fixture.title });
  await expect(railLink).toBeVisible();
  expect((await page.goto(`/engineering/${fixture.path}`))?.status()).toBe(200);

  const deleted = await deletePage(await viewerFor("aisyah@example.com"), fixture.id);
  if (!deleted.ok) throw new Error(`deletePage: ${JSON.stringify(deleted)}`);
  // A deleted root page gets no redirect: `Redirect.toPageId` is not nullable and there is no
  // surviving ancestor to aim at, so the 404 below is the answer rather than a 308 to nowhere.
  expect(deleted.page.redirectTo).toBeNull();

  const gone = await page.goto(`/engineering/${fixture.path}`);
  expect(gone?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();

  await page.goto("/engineering");
  await expect(railLink).toHaveCount(0);
  // Not only unlinked — absent. A deleted page rendered as inert text in the rail would still
  // be leaking its title, which is the same shape of leak 404-not-403 exists to close.
  await expect(page.locator("body")).not.toContainText(fixture.title);
});

/* ------------------------------------------- move, delete and restore through the UI ---- */

/*
 * The three tests below are Task 14b's own, and they are deliberately not the two above.
 *
 * Those two drive `movePage` and `deletePage` as functions, because when they were written
 * there was no route and no control to drive — the properties they pin are the reader's. These
 * three start from a URL a person can reach and end at a row in the database, so what they pin
 * is the thing Task 14b added: that the product has a way in at all. A regression that removed
 * the Edit link, the move form, the confirmation or the restore button would leave every test
 * above green.
 */

test("an editor moves a page from the editor's own surface, and the old URL redirects to it", async ({
  page,
}) => {
  const parent = await seedPublishedPage({
    slug: "e2e-ui-move-parent",
    title: "Adoptive parent",
    markdown: "The page below was moved under this one from the editor.\n",
  });
  const subject = await seedPublishedPage({
    slug: "e2e-ui-move-from",
    title: "Relocated by hand",
    markdown: "Recovery steps for the kiosk bridge.\n",
  });

  await signIn(page, "aisyah@example.com");

  // Entered through the reader, because "can an editor get to the editor" is half of what this
  // test is for: Task 14b added this link, and before it the only way to `/edit/{id}` was to
  // know a cuid.
  expect((await page.goto(`/engineering/${subject.path}`))?.status()).toBe(200);
  await page.getByRole("link", { name: "Edit this page" }).click();
  await expect(page).toHaveURL(new RegExp(`/edit/${subject.id}$`));

  // Both halves of a move in one action — a new parent and a new slug — because the path is
  // rebuilt from the pair and a form that only ever changed one of them would not show that.
  await page.getByLabel("Parent page").selectOption(parent.id);
  await page.getByLabel("Slug").fill("e2e-ui-move-to");
  await page.getByRole("button", { name: "Move page" }).click();

  const newPath = `${parent.path}/e2e-ui-move-to`;
  // The endpoint's own sentence, rendered by the surface that asked for the move. Asserting
  // the text and not just its absence of failure is what pins that the client read `path` out
  // of the response rather than assuming the slug it sent.
  await expect(page.locator(".ed-manage-done")).toContainText(`Moved to “${newPath}”`);
  await expect(page.locator(".ed-manage-done")).toContainText("The old URL now redirects here");
  await expect(page.locator(".ed-manage-error")).toHaveCount(0);

  expect(
    (await db.page.findUniqueOrThrow({ where: { id: subject.id }, select: { path: true } })).path,
  ).toBe(newPath);

  // 308, as Task 11 recorded: `permanentRedirect()` forbids an intermediary rewriting the
  // method on the retry, where the spec's 301 does not.
  const raw = await page.request.get(`/engineering/${subject.path}`, { maxRedirects: 0 });
  expect(raw.status()).toBe(308);
  expect(raw.headers()["location"]).toBe(`/engineering/${newPath}`);

  // And it lands, rather than merely pointing somewhere.
  const followed = await page.goto(`/engineering/${subject.path}`);
  expect(followed?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(`/engineering/${newPath}`);
  await expect(page.getByRole("heading", { level: 1, name: subject.title })).toBeVisible();
});

test("the delete confirmation names every sub-page that goes with the page", async ({ page }) => {
  // Three deep, not two. The count and the list are computed from `descendantsOf`, and a
  // subtree one level deep cannot tell a correct implementation from one that counts direct
  // children — or from a hardcoded 1.
  const root = await seedPublishedPage({
    slug: "e2e-ui-delete-root",
    title: "Doomed section",
    markdown: "This section and everything under it is about to go.\n",
  });
  const child = await seedPublishedPage({
    slug: "e2e-ui-delete-child",
    title: "Doomed child",
    markdown: "A page whose parent is about to be deleted.\n",
    parentId: root.id,
  });
  const grandchild = await seedPublishedPage({
    slug: "e2e-ui-delete-grandchild",
    title: "Doomed grandchild",
    markdown: "A page two levels under the one being deleted.\n",
    parentId: child.id,
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${root.id}`);

  const confirm = page.locator(".ed-manage-confirm");
  // Nothing is said until asked: the sentence is what the first click is for.
  await expect(confirm).toHaveCount(0);
  await page.getByRole("button", { name: "Delete this page…" }).click();

  await expect(confirm).toContainText("Doomed section");
  await expect(confirm).toContainText(root.path);
  // The requirement, verbatim: an editor is told what else goes, by name and by count, before
  // they can act — because restore is `MANAGE_SPACE` and they cannot undo this themselves.
  await expect(confirm).toContainText("This also deletes its 2 sub-pages:");
  for (const doomed of [child, grandchild]) {
    await expect(confirm.locator(".ed-manage-list")).toContainText(doomed.title);
    await expect(confirm.locator(".ed-manage-list")).toContainText(doomed.path);
  }

  // The first click is not destructive, and Cancel is not a promise. Asserted against the
  // database rather than the screen.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await db.page.count({ where: { id: root.id, deletedAt: null } })).toBe(1);
  expect((await page.request.get(`/engineering/${root.path}`)).status()).toBe(200);

  // The second click acts, and the count is on the button too — this is the last thing read
  // before the page goes.
  await page.getByRole("button", { name: "Delete this page…" }).click();
  await confirm.getByRole("button", { name: "Delete this page and 2 sub-pages" }).click();

  // A deleted root page has no surviving ancestor, so `redirectHref` is null and there is
  // nowhere to send the editor but the space.
  await expect(page).toHaveURL(/\/engineering$/, { timeout: 15_000 });

  expect(
    await db.page.count({
      where: { id: { in: [root.id, child.id, grandchild.id] }, deletedAt: { not: null } },
    }),
  ).toBe(3);
  for (const gone of [root, child, grandchild]) {
    expect((await page.goto(`/engineering/${gone.path}`))?.status()).toBe(404);
  }

  await page.goto("/engineering");
  await expect(page.locator("body")).not.toContainText(root.title);
  await expect(page.locator("body")).not.toContainText(grandchild.title);
});

test("restore is a space admin's, on the space's own surface, and brings the subtree back", async ({
  browser,
}) => {
  // A surviving root above the delete, so the delete writes redirects and the restore has
  // something to reclaim. Deleting the middle page is also what makes the leaf's own row
  // refusable, which is the asymmetry's second half.
  const top = await seedPublishedPage({
    slug: "e2e-ui-restore-top",
    title: "Surviving ancestor",
    markdown: "This page is never deleted.\n",
  });
  const mid = await seedPublishedPage({
    slug: "e2e-ui-restore-mid",
    title: "Restorable section",
    markdown: "This page is deleted and then restored.\n",
    parentId: top.id,
  });
  const leaf = await seedPublishedPage({
    slug: "e2e-ui-restore-leaf",
    title: "Restorable child",
    markdown: "This page goes with its parent, both ways.\n",
    parentId: mid.id,
  });

  // The delete goes through the module: this test is about the restore surface, and Aisyah's
  // half of it is already driven through the UI by the test above.
  const deleted = await deletePage(await viewerFor("aisyah@example.com"), mid.id);
  if (!deleted.ok) throw new Error(`deletePage: ${JSON.stringify(deleted)}`);
  expect(deleted.page.deleted).toBe(2);
  expect(deleted.page.redirectTo).toBe(top.path);
  expect(deleted.page.redirects).toBe(2);

  // Deleted, and its old URL now points at the ancestor that survived.
  const editor = await actorContext(browser, "aisyah@example.com");
  const bounced = await editor.page.request.get(`/engineering/${mid.path}`, { maxRedirects: 0 });
  expect(bounced.status()).toBe(308);
  expect(bounced.headers()["location"]).toBe(`/engineering/${top.path}`);

  /* The editor who deleted it cannot put it back, and is told who can. */

  await editor.page.goto("/engineering");
  // No affordance: the admin nav is its own landmark precisely so its absence is assertable.
  await expect(
    editor.page.getByRole("navigation", { name: "Engineering administration" }),
  ).toHaveCount(0);

  // Reached by URL anyway. `EDIT` is not `MANAGE_SPACE`, and the refusal names the role that
  // is — the one `forbidden` in the codebase with a sentence, because nobody can guess this.
  await editor.page.goto("/engineering/-/deleted");
  await expect(editor.page.locator(".del-empty")).toContainText(
    "Restoring a deleted page needs space admin",
  );
  await expect(editor.page.locator(".del-empty")).toContainText("Ask an admin of this space");
  await expect(editor.page.getByRole("button", { name: /^Restore / })).toHaveCount(0);
  // A list of deleted titles is a list of titles: refused means not shown, not shown greyed.
  await expect(editor.page.locator("body")).not.toContainText(mid.title);

  /* The admin can, from the nav rail they are already reading. */

  const admin = await actorContext(browser, "admin@example.com");
  await admin.page.goto("/engineering");
  await admin.page
    .getByRole("navigation", { name: "Engineering administration" })
    .getByRole("link", { name: "Deleted pages" })
    .click();
  await expect(admin.page).toHaveURL(/\/engineering\/-\/deleted$/);

  const rows = admin.page.locator(".del-list li");
  await expect(rows).toHaveCount(2);
  // The number that tells an admin whether they are looking at one delete or two.
  //
  // Filtered by title and not by path, which is not a nicety: the leaf's path *begins* with
  // the mid page's path, so a path filter matches both rows. That is the same prefix-versus-
  // boundary confusion `isInSubtree` exists for, met here in a test locator.
  await expect(rows.filter({ hasText: mid.title })).toContainText(
    "restoring it brings back 1 sub-page",
  );

  // The leaf first, and it is refused — its ancestor is still deleted, and the refusal names
  // that ancestor beside the row it refused rather than in a banner above five of them.
  await admin.page.getByRole("button", { name: `Restore ${leaf.title}` }).click();
  const error = admin.page.locator(".del-error");
  await expect(error).toContainText(mid.title);
  await expect(error).toContainText(mid.path);
  await expect(error).toContainText("Restore that page first");
  expect(await db.page.count({ where: { id: leaf.id, deletedAt: { not: null } } })).toBe(1);

  // Now the ancestor, which brings the leaf with it: the subtree the delete took, restored by
  // the one delete's own stamp.
  await admin.page.getByRole("button", { name: `Restore ${mid.title}` }).click();
  await expect(admin.page.locator(".del-empty")).toContainText(
    "Nothing in Engineering has been deleted.",
  );
  await expect(admin.page.locator(".del-list")).toHaveCount(0);

  expect(
    await db.page.count({ where: { id: { in: [mid.id, leaf.id] }, deletedAt: null } }),
  ).toBe(2);

  // Back where they were, and the redirects that pointed away from them are gone rather than
  // still shadowing the live pages underneath.
  expect(
    await db.redirect.count({
      where: { fromPath: { in: [mid.path, leaf.path] } },
    }),
  ).toBe(0);
  for (const back of [mid, leaf]) {
    const response = await admin.page.goto(`/engineering/${back.path}`);
    expect(response?.status()).toBe(200);
    expect(new URL(admin.page.url()).pathname).toBe(`/engineering/${back.path}`);
    await expect(
      admin.page.getByRole("heading", { level: 1, name: back.title }),
    ).toBeVisible();
  }

  // And in the rail again, under the ancestor that never moved.
  await admin.page.goto("/engineering");
  await expect(
    admin.page
      .getByRole("navigation", { name: "Engineering navigation" })
      .getByRole("link", { name: leaf.title }),
  ).toBeVisible();

  await editor.context.close();
  await admin.context.close();
});

/* ---------------------------------------------------- the two properties only HTTP sees ---- */

test("a dormant redirect does not shadow the live page standing at its path", async ({ page }) => {
  // A `Redirect` row and a live page can legitimately share a path: a redirect goes dormant the
  // moment something is created or moved on top of it, and a move only reclaims the ones it
  // makes live itself. So the reader must read the page FIRST and consult redirects only on a
  // miss.
  //
  // Task 11 measured the mutation — the lookup hoisted above the page read — returning a 308
  // away from a page that renders, while the whole vitest suite stayed green, because the
  // ordering is a property of the route and not of either function. This is the check that
  // sees it. Mutation-verified: with the lookup hoisted, `expect(200)` below reads 308.
  const live = await seedPublishedPage({
    slug: "e2e-shadowed",
    title: "Shadowed but live",
    markdown: "This page exists and renders.\n",
  });
  const spaceId = await engineeringId();
  const elsewhere = await db.page.findFirstOrThrow({
    where: { spaceId, path: "architecture" },
    select: { id: true, path: true },
  });
  await db.redirect.create({
    data: { spaceId, fromPath: live.path, toPageId: elsewhere.id },
    select: { id: true },
  });

  await signIn(page, "aisyah@example.com");

  const raw = await page.request.get(`/engineering/${live.path}`, { maxRedirects: 0 });
  expect(
    raw.status(),
    "the redirect lookup ran before the page read: a live page was redirected away from",
  ).toBe(200);

  const response = await page.goto(`/engineering/${live.path}`);
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(`/engineering/${live.path}`);
  await expect(page.getByRole("heading", { level: 1, name: live.title })).toBeVisible();

  // The dormant row is still there — it was shadowed, not consumed — which is what makes the
  // assertion above about ordering rather than about the row having been cleaned up.
  expect(await db.redirect.count({ where: { spaceId, fromPath: live.path } })).toBe(1);
});

test("no editor route scrolls horizontally", async ({ page }) => {
  // The guard that has caught three regressions in three shapes, pointed at the two routes
  // Phase 2 adds.
  //
  // Scope worth being honest about: `.ed-preview` is `overflow: auto` by deliberate design, so
  // hostile Markdown scrolls inside the pane and this measurement can never see a `.body`
  // wrapping regression — verified by mutation, where stripping all three `doc.css` guards left
  // both editor routes at 0 and the reader at 2,609px. What this pins is the editor *chrome*:
  // the top bar, the split grid's `minmax(0, 1fr)` tracks, the CodeMirror surface's
  // `min-width: 0` and its `lineWrapping`. The `.body` class is pinned by the injection probe
  // in `reader.spec.ts`, which is the surface everyone actually reads.
  const fixture = await seedPublishedPage({
    slug: "e2e-overflow",
    title: `Overflow probe ${HOSTILE.slice(0, 200)}`,
    markdown: [`## ${HOSTILE}`, "", HOSTILE, "", "```", HOSTILE, "```", ""].join("\n"),
  });

  await signIn(page, "aisyah@example.com");

  for (const path of ["/new", `/edit/${fixture.id}`]) {
    await page.goto(path);
    if (path.startsWith("/edit")) {
      // Measured only once the hostile content is actually on screen in both panes.
      await expect(page.locator(".cm-content")).toContainText(HOSTILE.slice(0, 40));
      await expect(page.locator(".ed-preview .body h2")).toBeVisible();
    }
    const { overflow, width } = await measureOverflow(page);
    // A zero-width viewport makes the subtraction zero too, which reads as a pass. Task 7 lost
    // time to exactly that against a backgrounded tab.
    expect(width, `${path} reported a zero-width viewport`).toBeGreaterThan(0);
    expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBe(0);
  }

  // The editor also has to survive the document being typed into it rather than loaded with
  // it, which is the case the split grid's intrinsic sizing decides.
  await page.goto(`/edit/${fixture.id}`);
  const surface = page.locator(".cm-content");
  await surface.click();
  await surface.fill(`# ${HOSTILE}\n\n${HOSTILE}\n`);
  await expect(page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });
  const typed = await measureOverflow(page);
  expect(typed.width).toBeGreaterThan(0);
  expect(typed.overflow, `the editor scrolls horizontally by ${typed.overflow}px once typed into`).toBe(0);
});

/* --------------------------------------------------------------------------- the viewer ---- */

test("a viewer sees no edit affordance and cannot reach the editor by URL", async ({ page }) => {
  // `stranger@example.com` is a member of nothing, which makes them exactly the "readable but
  // not editable" case `editable.ts` names: they can READ `handbook` because it is ALL_STAFF,
  // and they hold no role there, so `can(..., "EDIT")` is false. The seed has no VIEWER-role
  // user; this is the same authorisation outcome by the other route.
  const hidden = await seedPublishedPage({
    slug: "e2e-viewer-cannot-see",
    title: "Members only content",
    markdown: "Only engineering members read this.\n",
  });
  const welcome = await db.page.findFirstOrThrow({
    where: { space: { key: "handbook" }, path: "welcome" },
    select: { id: true },
  });

  await signIn(page, "stranger@example.com");
  await page.goto("/handbook/welcome");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  // No affordance anywhere on a page they can read. Phase 2 ships no reader-to-editor link for
  // Task 14b made this role-dependent, which it was not when first written: the reader now
  // renders an `Edit this page` link for a viewer holding EDIT, and the UI-driven move test
  // below enters the editor by clicking it. So this assertion is a real absence for this
  // viewer, not a universal one — the positive half is covered, on the critical path.
  await expect(page.locator('a[href^="/edit/"], a[href^="/new"]')).toHaveCount(0);

  // Readable but not editable: say so. They can already see the page, so naming the refusal
  // discloses nothing, and a 404 would be a lie they could disprove by clicking through.
  await page.goto(`/edit/${welcome.id}`);
  await expect(page.getByRole("heading", { name: "You cannot edit this page" })).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveCount(0);

  // Not readable at all: not-found, never forbidden. A 403 here would confirm the page exists.
  const unreadable = await page.goto(`/edit/${hidden.id}`);
  expect(unreadable?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText(hidden.title);

  // The route check authorises the render only; every write re-authorises. Posting by hand is
  // the case the form's filtered `<select>` cannot cover.
  const save = await page.request.put(`/api/drafts/${welcome.id}`, {
    headers: { "content-type": "application/json" },
    data: { title: "Rewritten", markdown: "Not mine to write.", seen: null },
  });
  expect(save.status()).toBe(403);
  const publish = await page.request.post(`/api/pages/${welcome.id}/publish`);
  expect(publish.status()).toBe(403);
  const preview = await page.request.post("/api/preview", {
    headers: { "content-type": "application/json" },
    data: { pageId: welcome.id, markdown: "# Free HTML rendering service" },
  });
  expect(preview.status()).toBe(403);

  // Creating: the form offers no space, because there is none they may edit.
  await page.goto("/new");
  await expect(page.locator(".np-empty")).toContainText("You do not have edit access");
  await expect(page.getByRole("button", { name: /create draft/i })).toHaveCount(0);

  // Nothing was written by any of the above.
  expect(await db.pageDraft.count({ where: { pageId: welcome.id } })).toBe(0);
});
