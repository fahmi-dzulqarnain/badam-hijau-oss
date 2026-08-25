/**
 * End-to-end coverage of doc types and lifecycle (Phase 3, Task 12).
 *
 * Everything here writes to the **development** database and takes its rows back out; `support.ts`
 * says why that is the only database it can be, and the `afterAll` below asserts the counts are
 * back where `beforeAll` found them — including `PageRelation`, which Phase 3 adds and which is
 * the row with no `e2e-` marker of its own.
 *
 * ## What only an end-to-end test can say here
 *
 * The vitest suite already proves each mechanism in isolation: the template validates against its
 * own schema, `checkRelations` refuses a cycle, `applyCascade` writes a status, `retirementNotice`
 * builds a banner, `listDocTypePages` filters. What none of them can prove is that the **chain**
 * holds across the three boundaries this phase spans — the create form's `docType` reaching a
 * template, the picker's document edit surviving autosave into the publish that reads it, and the
 * cascade's write landing on a *different* page's reader render. Every test below crosses at least
 * one of those.
 *
 * ## Which half of a flow is driven through the UI, and why it is not all of it
 *
 * The rule this file follows is the one `authoring.spec.ts` settled: **drive through the product's
 * own surface the thing being pinned, and seed the rest.** So the supersede test authors its
 * second ADR through `/new` and the editor, because the picker-writes-the-document mechanism and
 * the dormant-cascade notice exist nowhere else and cannot be reached from a module call; the
 * `DECIDES` test seeds both pages and reads the result over HTTP, because what it pins is the
 * cascade's effect on the RFC's reader, and the publish surface is already driven by the test
 * above it. Driving every publish through CodeMirror would add a minute of debounce waiting to
 * assert a button that another test in this file already asserts.
 */
import { expect, test } from "@playwright/test";
import {
  db,
  engineeringId,
  formatCounts,
  HOSTILE,
  measureOverflow,
  republishPage,
  seedPublishedPage,
  signIn,
  snapshotCounts,
  sweep,
  viewerFor,
  type Counts,
} from "./support";
import { createPage } from "@/lib/pages/create";
import { templateFor } from "@/lib/templates/load";

/** The body of an ADR, below whatever frontmatter a test gives it. */
const ADR_BODY = [
  "## Context",
  "",
  "The kiosk bridge retries on a fixed interval, so a slow outlet queues behind it.",
  "",
  "## Decision",
  "",
  "Back off exponentially, capped at one minute.",
  "",
  "## Consequences",
  "",
  "Recovery is slower in the common case and bounded in the bad one.",
  "",
].join("\n");

const RFC_BODY = [
  "## Summary",
  "",
  "Move topic registration out of the bridge and into the provisioning service.",
  "",
  "## Motivation",
  "",
  "Two services write the same registry today and neither owns it.",
  "",
].join("\n");

/** A document with a frontmatter block, written the way an author writes one. */
function withFrontmatter(keys: readonly string[], body: string): string {
  return ["---", ...keys, "---", "", body].join("\n");
}

let baseline: Counts;

test.beforeAll(async () => {
  await sweep();
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before lifecycle: ${formatCounts(baseline)}`);
});

// Not just `afterEach`: a fixture surviving a crashed run makes the next run's `createPage` fail
// with `path-occupied`, which reads as a product bug and is not one.
test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after lifecycle:  ${formatCounts(after)}`);
  expect(after, "the lifecycle suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/* ------------------------------------------------------ the template, and the first publish ---- */

test("an ADR opens on its template, and the unfilled template publishes and reads", async ({
  page,
}) => {
  // **The template is shipped as a `.ts` module for a reason no unit test can see.** Task 4
  // measured that `readFileSync(new URL("./adr.md", import.meta.url))` builds, passes from an API
  // route, and then hands the RSC layer a *browser* URL with no file behind it — so a template
  // reaching the draft is a claim about the server-rendered `/new` action specifically, and it is
  // only checkable from here. Publishing it unchanged is Task 4 Step 3's requirement over HTTP:
  // the product must not ship a template that cannot be published.
  await signIn(page, "aisyah@example.com");

  await page.goto("/new");
  await page.getByLabel("Title").fill("Retry policy for the kiosk bridge");
  await page.getByLabel("Slug").fill("e2e-adr-template");
  await page.getByLabel("Doc type").selectOption("ADR");
  await page.getByRole("button", { name: /create draft/i }).click();

  await expect(page).toHaveURL(/\/edit\/[a-z0-9]+$/);
  const pageId = new URL(page.url()).pathname.split("/").pop()!;

  // The draft *is* the template — not a placeholder the editor paints, which would vanish on the
  // first keystroke and leave an empty page. Asserted against the row rather than against the
  // editor, because CodeMirror only mounts the lines it is showing: `## Consequences` is below the
  // fold on a 720-pixel viewport and genuinely absent from the DOM, so a `toContainText` sweep of
  // `.cm-content` would be testing the window height.
  const draft = await db.pageDraft.findUniqueOrThrow({
    where: { pageId },
    select: { markdown: true },
  });
  expect(draft.markdown).toBe(templateFor("ADR"));
  const surface = page.locator(".cm-content");
  for (const line of ["## Context", "supersedes:", "decides:"]) {
    await expect(surface).toContainText(line);
  }
  await expect(page.locator(".ed-bar")).toContainText("ADR");

  // The bug this phase inherited, seen from the surface that renders it: `---` became a thematic
  // break and the keys became a heading. The preview pane is the first place an author meets it.
  const previewBody = page.locator(".ed-preview .body");
  await expect(previewBody.locator("h2").first()).toContainText("Context");
  await expect(previewBody).not.toContainText("supersedes:");
  expect(await previewBody.locator("hr").count()).toBe(0);

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/engineering\/e2e-adr-template$/, { timeout: 15_000 });

  // `FIRST_PUBLISH.ADR`. Nothing asked for a status — the template ships `status:` empty — so the
  // publish enters the ADR vocabulary at its head rather than refusing for want of one.
  await expect(page.locator(".meta")).toContainText("PROPOSED");
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: pageId }, select: { status: true } })).status,
  ).toBe("PROPOSED");

  const body = page.locator(".doc .body");
  await expect(body).toContainText("What forced a decision");
  // Frontmatter never appears in a rendered body or a table of contents — a Phase 3 exit
  // criterion, asserted on the published page and not only on the parser.
  await expect(body).not.toContainText("supersedes:");
  expect(await body.locator("hr").count()).toBe(0);
  const toc = page.getByRole("navigation", { name: "On this page" });
  await expect(toc).toContainText("Context");
  await expect(toc).not.toContainText("status");

  // Nothing was declared, so neither surface renders: no banner, no relation list.
  expect(await page.locator(".retired").count()).toBe(0);
  expect(await page.locator(".rels").count()).toBe(0);
});

/* --------------------------------------------------------- supersede, dormant and the banner ---- */

test("a second ADR supersedes the first: dormant at PROPOSED, retired at ACCEPTED, still readable", async ({
  page,
}) => {
  const first = await seedPublishedPage({
    slug: "e2e-adr-first",
    title: "Fixed-interval retry",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:"], ADR_BODY),
  });

  await signIn(page, "aisyah@example.com");

  await page.goto("/new");
  await page.getByLabel("Title").fill("Exponential backoff for the bridge");
  await page.getByLabel("Slug").fill("e2e-adr-second");
  await page.getByLabel("Doc type").selectOption("ADR");
  await page.getByRole("button", { name: /create draft/i }).click();
  await expect(page).toHaveURL(/\/edit\/[a-z0-9]+$/);
  const secondId = new URL(page.url()).pathname.split("/").pop()!;

  const surface = page.locator(".cm-content");
  await surface.click();
  // `fill` goes through `insertText`, which is the paste path — a `keyboard.type` would hand every
  // newline to the Markdown language's Enter binding.
  await surface.fill(withFrontmatter(["status:", `supersedes: ${first.path}`], ADR_BODY));
  await expect(page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });

  /* The first publish lands at PROPOSED, so the relation is recorded and nothing is retired. */

  await page.getByRole("button", { name: "Publish" }).click();

  const dormant = page.locator(".ed-dormant");
  await expect(dormant).toBeVisible({ timeout: 15_000 });
  await expect(dormant).toContainText("Published as PROPOSED");
  await expect(dormant).toContainText(`supersedes: ${first.path}`);
  await expect(dormant).toContainText("that page is unchanged");
  await expect(dormant).toContainText("It moves to SUPERSEDED on the publish that accepts this");
  // A message on a component about to be replaced is a message nobody reads: this is the one
  // successful publish that does not navigate.
  expect(new URL(page.url()).pathname).toBe(`/edit/${secondId}`);

  // The row is written and the other page is untouched — which is exactly the state the notice
  // exists to explain, and the state that reads as a bug without it.
  expect(
    await db.pageRelation.count({
      where: { fromId: secondId, toId: first.id, type: "SUPERSEDES" },
    }),
  ).toBe(1);
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } })).status,
  ).toBe("ACCEPTED");

  // The notice's own way out, and the reader it lands on shows the stored direction of the
  // relation while the target is still in force.
  await page.getByRole("link", { name: "Open the published page" }).click();
  await expect(page).toHaveURL(/\/engineering\/e2e-adr-second$/);
  const rels = page.locator(".rels");
  await expect(rels).toContainText("Supersedes");
  await expect(rels).toContainText(first.title);

  // And the target reads normally: no banner, still ACCEPTED.
  await page.goto(`/engineering/${first.path}`);
  expect(await page.locator(".retired").count()).toBe(0);
  await expect(page.locator(".meta")).toContainText("ACCEPTED");

  /* Now the publish that accepts it, driven by the picker — which writes the document. */

  await page.goto(`/engineering/e2e-adr-second`);
  await page.getByRole("link", { name: "Edit this page" }).click();
  await expect(page).toHaveURL(new RegExp(`/edit/${secondId}$`));

  await page.getByLabel("Publish as").selectOption("ACCEPTED");
  // The whole mechanism, visible: the picker does not send a status, it edits the `status:` line
  // the next publish will read. If it ever starts sending one instead, this is what says so.
  await expect(page.locator(".cm-content")).toContainText("status: ACCEPTED");
  await expect(page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });

  await page.getByRole("button", { name: "Publish" }).click();
  // No dormant entry this time, so this publish navigates.
  await expect(page).toHaveURL(/\/engineering\/e2e-adr-second$/, { timeout: 15_000 });
  await expect(page.locator(".meta")).toContainText("ACCEPTED");

  /* The cascade landed on a page this browser never opened for writing. */

  const retired = await db.page.findUniqueOrThrow({
    where: { id: first.id },
    select: { status: true },
  });
  expect(retired.status).toBe("SUPERSEDED");
  // The cascade wrote its own audit row, on the page it changed — not on the page that published.
  expect(
    await db.auditLog.count({ where: { pageId: first.id, action: "page.cascade" } }),
  ).toBe(1);

  const response = await page.goto(`/engineering/${first.path}`);
  expect(response?.status()).toBe(200);
  await expect(page.locator(".meta")).toContainText("SUPERSEDED");

  const banner = page.locator(".retired");
  await expect(banner).toContainText("This document has been superseded.");
  await expect(banner).toContainText("Superseded by");
  await expect(banner).toContainText("Exponential backoff for the bridge");
  await expect(banner).toContainText("Everything below still reads as it was written.");
  // §6.4's promise, asserted rather than described: history, not an error state. The body is
  // whole, the table of contents still works, and the banner is a sibling above it.
  const body = page.locator(".doc .body");
  await expect(body).toContainText("Back off exponentially, capped at one minute.");
  await expect(body).toContainText("Recovery is slower in the common case");
  await expect(page.getByRole("navigation", { name: "On this page" })).toContainText("Decision");

  // The replacement is one click away, and it is a real link because it is published.
  await banner.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/engineering\/e2e-adr-second$/);
});

/* -------------------------------------------------------------- an ADR decides an RFC ---- */

test("an ADR decides an RFC, and the RFC closes with a banner naming the decision", async ({
  page,
}) => {
  const rfc = await seedPublishedPage({
    slug: "e2e-rfc-registry",
    title: "Registry ownership",
    docType: "RFC",
    markdown: withFrontmatter(["status:"], RFC_BODY),
  });
  // `FIRST_PUBLISH.RFC`, not `DRAFT`: an RFC that has been published is readable, and `DRAFT` is a
  // destination for no type.
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: rfc.id }, select: { status: true } })).status,
  ).toBe("IN_REVIEW");

  /*
   * **And it has to be accepted before anything can close it**, which is the plan's landmine
   * holding: the cascade's own transition goes through `PUBLISHABLE_INTO`, and an RFC at
   * `IN_REVIEW` cannot reach `CLOSED` — `IN_REVIEW → ACCEPTED → CLOSED` is the vocabulary. A
   * decision naming it while it is still in review is refused with a sentence saying so, rather
   * than writing a status the vocabulary forbids. Measured: this test's first draft published the
   * ADR straight at an `IN_REVIEW` RFC and got `cascade-illegal-transition` back.
   *
   * The status comes from the RFC's own `status:` line here, which is the second half of the
   * frontmatter wiring — the picker writes that line, and this is the same line arriving from a
   * document instead of from a control.
   */
  await republishPage(rfc, { markdown: withFrontmatter(["status: ACCEPTED"], RFC_BODY) });
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: rfc.id }, select: { status: true } })).status,
  ).toBe("ACCEPTED");

  const adr = await seedPublishedPage({
    slug: "e2e-adr-decides",
    title: "Provisioning owns the registry",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:", `decides: ${rfc.path}`], ADR_BODY),
  });

  // The cascade is `CLOSED`, from a different vocabulary than the ADR's own — which is the half a
  // same-doc-type rule would get wrong, and the reason `DECIDES` has its own cascade row.
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: rfc.id }, select: { status: true } })).status,
  ).toBe("CLOSED");

  await signIn(page, "aisyah@example.com");

  const response = await page.goto(`/engineering/${rfc.path}`);
  expect(response?.status()).toBe(200);
  await expect(page.locator(".meta")).toContainText("CLOSED");

  const banner = page.locator(".retired");
  await expect(banner).toContainText("This proposal is closed.");
  // "Decided by", not "Superseded by": the label is derived from the relation type that retired
  // it, so a page cannot be explained by the wrong relation.
  await expect(banner).toContainText("Decided by");
  await expect(banner).toContainText(adr.title);
  await expect(page.locator(".doc .body")).toContainText(
    "Two services write the same registry today",
  );

  // The forward direction, on the ADR.
  await page.goto(`/engineering/${adr.path}`);
  await expect(page.locator(".rels")).toContainText("Decides");
  await expect(page.locator(".rels")).toContainText(rfc.title);
  expect(await page.locator(".retired").count()).toBe(0);

  // The RFC index only appears in the rail once the space holds an RFC — Task 10's
  // discoverability, which was absent until it was asked for.
  await page.goto("/engineering");
  await expect(
    page.getByRole("navigation", { name: "Engineering indexes" }).getByRole("link", {
      name: "Proposals",
    }),
  ).toBeVisible();
});

/* ------------------------------------------------------------------ the generated indexes ---- */

test("the generated index lists ADRs, filters by status, and names an unknown filter back", async ({
  page,
}) => {
  const old = await seedPublishedPage({
    slug: "e2e-adr-idx-old",
    title: "Registry in the bridge",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:"], ADR_BODY),
  });
  const current = await seedPublishedPage({
    slug: "e2e-adr-idx-new",
    title: "Registry in provisioning",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:", `supersedes: ${old.path}`], ADR_BODY),
  });
  // A never-published ADR, which the index lists as inert text — the nav rail already shows it to
  // the same audience, and linking it would 404 for everyone.
  const draft = await createPage(await viewerFor("aisyah@example.com"), {
    spaceId: await engineeringId(),
    parentId: null,
    slug: "e2e-adr-idx-draft",
    title: "Registry ownership, being drafted",
    docType: "ADR",
  });
  if (!draft.ok) throw new Error(`createPage: ${JSON.stringify(draft)}`);

  await signIn(page, "aisyah@example.com");

  // Reached the way a reader reaches it, not by typing a URL.
  await page.goto("/engineering");
  await page
    .getByRole("navigation", { name: "Engineering indexes" })
    .getByRole("link", { name: "Decision records" })
    .click();
  await expect(page).toHaveURL(/\/engineering\/-\/adrs$/);

  const rows = page.locator(".idx-row");
  await expect(rows.filter({ hasText: old.title })).toContainText("SUPERSEDED");
  await expect(rows.filter({ hasText: current.title })).toContainText("ACCEPTED");
  const draftRow = rows.filter({ hasText: "Registry ownership, being drafted" });
  await expect(draftRow).toContainText("DRAFT");
  await expect(draftRow).toContainText("Draft");
  // Listed, and not a link: `getPublishedPage` requires a published version.
  expect(await draftRow.getByRole("link").count()).toBe(0);
  // The published ones are links, and they land.
  await expect(rows.filter({ hasText: current.title }).getByRole("link")).toHaveAttribute(
    "href",
    `/engineering/${current.path}`,
  );

  /* Filtering, from the vocabulary rather than from a list. */

  const filter = page.getByRole("navigation", { name: "Filter decision records by status" });
  // Every status the ADR vocabulary can hold, whether or not a page is at it — including the
  // `DRAFT` that `publishableStatuses` correctly leaves out and this filter has to offer.
  for (const status of ["DRAFT", "PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED", "DEPRECATED"]) {
    await expect(filter.getByRole("link", { name: new RegExp(`^${status} `) })).toBeVisible();
  }
  // And nothing from another type's vocabulary.
  await expect(filter).not.toContainText("NEEDS_REVIEW");
  await expect(filter).not.toContainText("CLOSED");

  await filter.getByRole("link", { name: /^SUPERSEDED / }).click();
  await expect(page).toHaveURL(/\?status=SUPERSEDED$/);
  await expect(page.locator(".idx-row")).toHaveCount(1);
  await expect(page.locator(".idx-row")).toContainText(old.title);
  // The filter is a filter: the seeded `adr-0042` is ACCEPTED and must not be in this list.
  // Scoped to the list: the seeded ADR's title is also in the nav rail beside it, correctly —
  // the rail is the space's page tree and is not filtered by anything this URL says.
  await expect(page.locator(".idx-list")).not.toContainText("MQTT topic naming");

  await page.goto("/engineering/-/adrs?status=DRAFT");
  await expect(page.locator(".idx-row").filter({ hasText: current.title })).toHaveCount(0);
  await expect(page.locator(".idx-row").filter({ hasText: "being drafted" })).toHaveCount(1);

  // A status no ADR is at is a truthful page with a way back, not an empty list.
  await page.goto("/engineering/-/adrs?status=DEPRECATED");
  await expect(page.locator(".idx-empty")).toContainText("No decision record in Engineering is at");
  await expect(page.locator(".idx-row")).toHaveCount(0);
  await page.getByRole("link", { name: /^Show all / }).click();
  await expect(page).toHaveURL(/\/engineering\/-\/adrs$/);
  await expect(page.locator(".idx-row").filter({ hasText: old.title })).toHaveCount(1);

  // An unrecognised value is named back rather than silently ignored — a typed URL that quietly
  // shows everything is indistinguishable from a broken filter.
  await page.goto("/engineering/-/adrs?status=SUPERCEDED");
  await expect(page.locator(".idx-note")).toContainText(
    "“SUPERCEDED” is not a status a decision record can be in",
  );
  await expect(page.locator(".idx-row").filter({ hasText: current.title })).toHaveCount(1);

  // The other index, in a space with no RFCs: an explanation, not an empty list.
  await page.goto("/engineering/-/rfcs");
  await expect(page.locator(".idx-empty")).toContainText("Nothing in Engineering is a proposal yet");
  expect(await page.locator(".idx-filter").count()).toBe(0);
});

/* ---------------------------------------------------------------------- the refusals ---- */

test("a supersede cycle is refused, with a message placed against the line that caused it", async ({
  page,
}) => {
  const older = await seedPublishedPage({
    slug: "e2e-cycle-a",
    title: "Decision A",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:"], ADR_BODY),
  });
  // Published at PROPOSED, so the row is written and nothing is retired — which is what makes the
  // cycle reachable at all: the graph gains the edge whether or not the cascade fires.
  const newer = await seedPublishedPage({
    slug: "e2e-cycle-b",
    title: "Decision B",
    docType: "ADR",
    markdown: withFrontmatter(["status:", `supersedes: ${older.path}`], ADR_BODY),
  });
  expect(
    await db.pageRelation.count({ where: { fromId: newer.id, toId: older.id } }),
  ).toBe(1);

  await signIn(page, "aisyah@example.com");
  await page.goto(`/edit/${older.id}`);

  const surface = page.locator(".cm-content");
  await surface.click();
  await surface.fill(withFrontmatter(["status:", `supersedes: ${newer.path}`], ADR_BODY));
  await expect(page.locator(".ed-status")).toHaveText(/^Saved \d/, { timeout: 15_000 });

  await page.getByRole("button", { name: "Publish" }).click();

  const refusal = page.locator(".ed-publish-error");
  await expect(refusal).toBeVisible({ timeout: 15_000 });
  await expect(refusal).toContainText("Not published. One thing needs fixing:");
  await expect(refusal).toContainText(`\`${newer.path}\` already supersedes this page`);
  await expect(refusal).toContainText("every document in it would retire the next");
  // Placed against the offending line, which is as close to "against the key" as a surface whose
  // frontmatter is prose in one textarea can get. Line 3: fence, `status:`, `supersedes:`.
  const where = refusal.getByRole("button", { name: /^line \d+ · supersedes:$/ });
  await expect(where).toHaveText("line 3 · supersedes:");

  // And the control does what it says: the line is selected in the editor.
  await where.click();
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toContain(
    `supersedes: ${newer.path}`,
  );

  // A refusal is a refusal. Nothing was written, nothing navigated, and the graph is as it was.
  expect(new URL(page.url()).pathname).toBe(`/edit/${older.id}`);
  expect(await db.pageRelation.count({ where: { fromId: older.id } })).toBe(0);
  expect(await db.pageVersion.count({ where: { pageId: older.id } })).toBe(1);
  expect(
    (await db.page.findUniqueOrThrow({ where: { id: older.id }, select: { status: true } })).status,
  ).toBe("ACCEPTED");
});

/* ------------------------------------------------------------------- hostile content ---- */

/**
 * A title that is hostile in both of the ways a title can be, in one string.
 *
 * The 300-character unbreakable run is the shape that has widened this layout six times, most
 * recently on Task 9's banner. The markup in front of it is the other question a surface painting
 * user-typed text outside `.body` has to answer — the banner and the index rows are the only two
 * places in Phase 3 where **one page's** text is painted on **another page's** render, which is
 * exactly where "it is only my own title" stops being an argument.
 *
 * 293 characters, under `TITLE_MAX_LENGTH`.
 */
const HOSTILE_TITLE = `<img src=x onerror="document.title='pwned'">${HOSTILE.slice(0, 250)}`;

test("hostile content in a banner and an index neither widens the page nor renders as markup", async ({
  page,
}) => {
  // The guard that has caught six shapes only catches what it is shown. Both surfaces below take
  // their text from a *different* page's row, and neither is inside `.body`, so `doc.css`'s
  // Markdown guards do not reach them — `.rel-row`/`.rel-title` and `.idx-row`/`.idx-title`/
  // `.idx-path` carry their own, and this is what says so.
  const retired = await seedPublishedPage({
    slug: "e2e-hostile-target",
    title: "Ordinary decision",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:"], ADR_BODY),
  });
  // A path as unbreakable as the title, because the index paints both — and a slug is capped at
  // 80 characters where a title is capped at 300, so they are two different injections.
  const hostileSlug = `e2e-${"x".repeat(76)}`;
  const replacement = await seedPublishedPage({
    slug: hostileSlug,
    title: HOSTILE_TITLE,
    docType: "ADR",
    status: "ACCEPTED",
    markdown: withFrontmatter(["status:", `supersedes: ${retired.path}`], ADR_BODY),
  });
  expect(replacement.path).toBe(hostileSlug);

  await signIn(page, "aisyah@example.com");

  /* The banner, on a page whose own title is perfectly ordinary. */

  await page.goto(`/engineering/${retired.path}`);
  const banner = page.locator(".retired");
  await expect(banner).toContainText("This document has been superseded.");
  // The token is really there — a probe that measures a page not carrying the hostile content is
  // the "guard testing its corpus" failure this whole test exists to avoid.
  await expect(banner.locator(".rel-title")).toContainText(HOSTILE.slice(0, 200));

  const withBanner = await measureOverflow(page);
  // A zero-width viewport makes the subtraction come out at zero too, which reads as a pass.
  expect(withBanner.width, "the reader reported a zero-width viewport").toBeGreaterThan(0);
  expect(
    withBanner.overflow,
    `a retired banner naming a 300-character title widens the reader by ${withBanner.overflow}px`,
  ).toBe(0);

  // Text, not markup: no element was created from the title, and its `onerror` never ran.
  expect(await banner.locator("img").count()).toBe(0);
  await expect(banner.locator(".rel-title")).toContainText("<img src=x");
  expect(await page.title()).not.toBe("pwned");

  /* The index, which paints the same title and an unbreakable path beside it. */

  await page.goto("/engineering/-/adrs");
  const row = page.locator(".idx-row").filter({ hasText: hostileSlug });
  await expect(row).toContainText(HOSTILE.slice(0, 200));
  await expect(row.locator(".idx-path")).toHaveText(hostileSlug);
  expect(await page.locator(".idx-list img").count()).toBe(0);
  expect(await page.title()).not.toBe("pwned");

  const withIndex = await measureOverflow(page);
  expect(withIndex.width, "the index reported a zero-width viewport").toBeGreaterThan(0);
  expect(
    withIndex.overflow,
    `an index row carrying a hostile title and path widens the page by ${withIndex.overflow}px`,
  ).toBe(0);

  /* And the one string on this page that comes off the URL rather than out of a row. */

  await page.goto(`/engineering/-/adrs?status=${HOSTILE}`);
  const note = page.locator(".idx-note");
  // Capped at `MAX_ECHOED_STATUS` before it is painted, which is a third mechanism again — React
  // escapes it, `doc.css` wraps it, and the cap is what stops ten kilobytes of somebody else's
  // text being painted above the list at all.
  await expect(note).toContainText("is not a status a decision record can be in");
  expect((await note.innerText()).length).toBeLessThan(200);

  const withEcho = await measureOverflow(page);
  expect(withEcho.width).toBeGreaterThan(0);
  expect(
    withEcho.overflow,
    `an echoed status filter widens the index by ${withEcho.overflow}px`,
  ).toBe(0);
});
