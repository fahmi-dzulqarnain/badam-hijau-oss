/**
 * End-to-end coverage of `/search` (Phase 4, Task 4).
 *
 * Everything here writes to the **development** database and takes its rows back out; `support.ts`
 * says why that is the only database it can be, and the `afterAll` below asserts the counts are
 * back where `beforeAll` found them.
 *
 * ## What only an end-to-end test can say about this route
 *
 * The vitest suite already proves both halves in isolation: `search-query.test.ts` pins the SQL —
 * who may see what, the demotion, the exclusions — and `params.test.ts` pins the URL contract and
 * the three-outcome mapping. Neither can say anything about the two properties that *are* the
 * route:
 *
 * - **A search is a link a person can send.** That is a claim about a URL surviving a round trip
 *   through a browser and a second, differently-authenticated session — not about a function
 *   returning a string. The shareability test therefore opens the URL it produced in a fresh
 *   context with its own cookie jar.
 * - **A snippet is text.** `search()` returns `{ text, match }[]`, and what matters is that the
 *   rendered page has a `<mark>` element and no element the *content* asked for. Only a real DOM
 *   can be asked that.
 *
 * The overflow probe is here for the reason every other one is: the guard that has caught six
 * shapes of that class only catches what it is shown, and no seeded page carries a 300-character
 * unbreakable token. It is injected as a real row.
 */
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
 * Words that appear nowhere in the seeded corpus, one per test that needs a needle.
 *
 * A needle drawn from the seeded pages would make every assertion below depend on what the seed
 * happens to contain, and "3 pages match" would break the day someone adds a page. Each of these
 * is a single unstemmed English word, so `websearch_to_tsquery` reduces it to itself and the
 * `<mark>` is over the whole word rather than over a stem of it.
 */
const NEEDLE = {
  body: "ziggurat",
  shared: "peninsular",
  ranked: "quokka",
  titleOnly: "narwhal",
  hostile: "cassowary",
  /** Seeded into `engineering` **and** `handbook`, so one query reaches across both. */
  bothSpaces: "marmoset",
  /** Seeded only into `engineering`, so `stranger` must get the no-hits sentence for it. */
  membersOnly: "wombat",
} as const;

/** A body a person would write, with the needle in prose rather than in a heading. */
function bodyAbout(needle: string): string {
  return [
    "## Context",
    "",
    `The ${needle} bridge retries on a fixed interval, so a slow outlet queues behind it and`,
    "the kiosk sees a stale price for as long as the queue takes to drain.",
    "",
    "## Decision",
    "",
    "Back off exponentially, capped at one minute.",
    "",
  ].join("\n");
}

let baseline: Counts;

test.beforeAll(async () => {
  await sweep();
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before search: ${formatCounts(baseline)}`);
});

// Not just `afterEach`: a fixture surviving a crashed run makes the next run's `createPage` fail
// with `path-occupied`, which reads as a product bug and is not one.
test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after search:  ${formatCounts(after)}`);
  expect(after, "the search suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/* ------------------------------------------------------------------ finding a page ---- */

test("a word in a published body finds the page, and the snippet marks the word", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-search-body",
    title: "Retry policy for the kiosk bridge",
    markdown: bodyAbout(NEEDLE.body),
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.body}`);

  const rows = page.locator(".q-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator(".q-title")).toHaveText(fixture.title);
  await expect(rows.locator(".q-path")).toHaveText(fixture.path);
  await expect(rows.locator(".q-status")).toHaveText("CURRENT");
  await expect(rows.locator(".q-space")).toHaveText("Engineering");

  // The snippet is the passage a person reads to decide whether to click, and the term inside it
  // is an element — not markup that arrived in a string. `search()` parsed the `ts_headline`
  // delimiters away, so there is nothing on this route that a `dangerouslySetInnerHTML` could
  // render even if someone reached for one.
  const mark = rows.locator(".q-snippet mark");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText(NEEDLE.body);
  // Prose around the match, so the snippet is a passage rather than the bare term.
  await expect(rows.locator(".q-snippet")).toContainText("retries on a fixed interval");

  // A result is a way in, not just an answer.
  await rows.locator(".q-title").click();
  await expect(page).toHaveURL(new RegExp(`/engineering/${fixture.path}$`));
  await expect(page.locator(".doc h1")).toHaveText(fixture.title);
});

test("a page with no prose is found by its title and says it has nothing to quote", async ({
  page,
}) => {
  // `searchText` is legitimately `""` for a page whose whole content is one diagram — Task 2
  // established that and Task 3's `SearchHit.snippet` documents the empty array it produces. This
  // is the one shape where the row has to say something instead of showing a passage, and it is
  // unreachable from the seeded corpus.
  const fixture = await seedPublishedPage({
    slug: "e2e-search-diagram",
    title: `The ${NEEDLE.titleOnly} topology`,
    markdown: ["```mermaid", "graph TD", "  A[Bridge] --> B[Broker]", "```", ""].join("\n"),
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.titleOnly}`);

  const row = page.locator(".q-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".q-title")).toHaveText(fixture.title);
  await expect(row.locator(".q-nosnippet")).toHaveText("This page has no body text to quote.");
});

/* ------------------------------------------------- who may see what, from the other side ---- */

/**
 * A token that exists in exactly one place in the whole database — the title of the members-only
 * fixture — so "it appears nowhere on this page" is a statement about one row and not about the
 * seeded corpus. Never searched for; it is only ever asserted absent.
 */
const MEMBERS_ONLY_SENTINEL = "orrery";

/**
 * Phase 4 Task 6's non-member bullet — *"a non-member searching the same word gets nothing"* —
 * implemented as a **discrimination** rather than as an absence, because the plan's own wording
 * would otherwise be near-vacuous here.
 *
 * ## Why the obvious version of this test proves almost nothing
 *
 * `search()` has no early return for an empty readable set. The ids go into
 * `AND p."spaceId" = ANY(${spaceIds})` and an empty array makes that clause false for every row
 * **naturally** — deliberately, so there is no early return whose deletion would be invisible. The
 * consequence for a test is that a viewer with *no* readable space finds nothing whether or not
 * the filter discriminates correctly: `= ANY('{}')` and a deleted clause over a one-space database
 * are indistinguishable from the outside.
 *
 * `stranger@example.com` is not that viewer. `handbook` is `ALL_STAFF`, so stranger can read
 * exactly **one** of the two seeded spaces — which is what forces the `ANY(...)` to do work rather
 * than to be trivially false. So the same word is seeded into both spaces and the assertion is a
 * **count**, not an absence.
 *
 * ## The mutant this kills
 *
 * Delete `AND p."spaceId" = ANY(${spaceIds})` from `src/lib/search/query.ts` and stranger's search
 * for `bothSpaces` returns **2** rows instead of 1 — measured — with the members-only title, path
 * and space name all painted on the page, and the count sentence reading "2 pages match" instead
 * of "One page matches". The engineering-only half of the test dies too, on the same mutant: the
 * no-hits sentence becomes a result row. The editor's half of the test is *unaffected* by that
 * mutation, which is exactly why it is here — it is the non-vacuity companion, proving both
 * needles really match a published page before anything concludes from stranger not finding one.
 *
 * ## Getting the right absence for the wrong reason
 *
 * The route has three sentences and two of them would be a lie here. A needle seeded only into
 * `engineering` must produce the **no-hits** sentence for stranger — "No page matches" — and not
 * "Nothing typed yet" (`empty-query`) and not "a search that was never made" (`no-terms`). A
 * refusal that arrives because the query never ran is a test of the parser, not of the space
 * filter, so the sentence is asserted rather than the emptiness.
 */
test("a non-member sees only the space they can read, and the members-only page is nowhere on the page", async ({
  page,
  browser,
}) => {
  const members = await seedPublishedPage({
    slug: "e2e-search-members",
    title: `Retry policy for the ${MEMBERS_ONLY_SENTINEL} bridge`,
    markdown: [
      bodyAbout(NEEDLE.bothSpaces),
      `The ${NEEDLE.membersOnly} switch is set per outlet.`,
      "",
    ].join("\n"),
  });
  // `handbook` is `ALL_STAFF`, and `ALL_STAFF` grants read and not edit — so this fixture cannot
  // be authored by the `engineering` editor every other fixture in this file uses. The super admin
  // is the only seeded identity that holds `EDIT` there; `seedPublishedPage` argues why, and
  // pairing them wrongly fails naming both the actor and the space.
  const allStaff = await seedPublishedPage({
    spaceKey: "handbook",
    actor: "admin@example.com",
    slug: "e2e-search-allstaff",
    title: "Claiming expenses",
    markdown: bodyAbout(NEEDLE.bothSpaces),
  });

  // ---- the non-vacuity companion: both needles really do match a published page ----
  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.bothSpaces}`);
  await expect(page.locator(".q-row")).toHaveCount(2);
  // Unordered: both matches are in the `C` band over near-identical prose, so which one ranks
  // higher is a density detail this test has no business pinning. What it pins is that the word
  // reaches across a space boundary for someone who can read both sides of it.
  expect((await page.locator(".q-space").allInnerTexts()).sort()).toEqual([
    "Company handbook",
    "Engineering",
  ]);
  await page.goto(`/search?q=${NEEDLE.membersOnly}`);
  await expect(page.locator(".q-row")).toHaveCount(1);
  await expect(page.locator(".q-title")).toHaveText(members.title);

  // ---- and now the same two searches as someone who can read one of the two spaces ----
  const stranger = await actorContext(browser, "stranger@example.com");
  try {
    await stranger.page.goto(`/search?q=${NEEDLE.bothSpaces}`);

    const rows = stranger.page.locator(".q-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".q-title")).toHaveText(allStaff.title);
    await expect(rows.locator(".q-space")).toHaveText("Company handbook");
    // Not in a count either. The route prints one, and a filter that hides a row from the list
    // while counting it would be a leak in the shape this project has already been bitten by —
    // a number is an answer about pages the viewer may not know exist.
    await expect(stranger.page.locator(".q-count")).toHaveText(
      `One page matches “${NEEDLE.bothSpaces}”.`,
    );

    // Nowhere in the DOM: not in a row, not in a note, not in the count, not in the nav. Three
    // separate strings, because the row paints three — and the sentinel is a token that exists in
    // exactly one place in the database, so this cannot pass by the seed happening to be quiet.
    const body = stranger.page.locator("body");
    await expect(body).not.toContainText(MEMBERS_ONLY_SENTINEL);
    await expect(body).not.toContainText(members.title);
    await expect(body).not.toContainText(members.path);

    // ---- the right absence, for the right reason ----
    await stranger.page.goto(`/search?q=${NEEDLE.membersOnly}`);
    await expect(stranger.page.locator(".q-row")).toHaveCount(0);
    const sentence = await stranger.page.locator(".q-empty").innerText();
    // The no-hits sentence, and neither of the other two. A search that was never made and a
    // search that found nothing are different claims, and only one of them is true here.
    expect(sentence).toContain(`No page matches “${NEEDLE.membersOnly}”`);
    expect(sentence).not.toContain("Nothing typed yet");
    expect(sentence).not.toContain("never made");
    await expect(body).not.toContainText(MEMBERS_ONLY_SENTINEL);
    await expect(body).not.toContainText(members.title);
  } finally {
    await stranger.context.close();
  }
});

/* ------------------------------------------------------------- three outcomes, three sentences ---- */

test("nothing typed, nothing searchable, and nothing found say three different things", async ({
  page,
}) => {
  await signIn(page, "aisyah@example.com");

  await page.goto("/search");
  const nothingTyped = await page.locator(".q-empty").innerText();

  // `...` reduces to an empty `tsquery`, so no search was made. Telling this person "no results"
  // would say their query was fine when it was not.
  await page.goto("/search?q=...");
  const noTerms = await page.locator(".q-empty").innerText();

  await page.goto(`/search?q=${NEEDLE.body}`);
  const noHits = await page.locator(".q-empty").innerText();

  // **This line is weaker than it looks, and mutation testing is what said so.** Collapsing
  // `no-terms` into the no-hits branch leaves the two sentences *distinct* — one quotes `...` and
  // the other quotes the needle — so the set is still size 3 and this assertion passes. It kills
  // only the collapse that produces byte-identical text. The substring assertions below are what
  // actually killed the mutant: the `no-terms` page read "No page matches “...”.", which is the
  // exact lie the plan names.
  expect(new Set([nothingTyped, noTerms, noHits]).size, "three outcomes collapsed").toBe(3);
  expect(nothingTyped).toContain("Nothing typed yet");
  expect(noTerms).toContain("There is nothing to search for in “...”");
  expect(noTerms).toContain("a search that was never made");
  expect(noHits).toContain(`No page matches “${NEEDLE.body}”`);
  // The third sentence is a *found nothing*, so it must not claim the query was unusable.
  expect(noHits).not.toContain("never made");
});

/* --------------------------------------------------------------- filters, and a shareable URL ---- */

test("filters narrow the results, and the narrowed URL reproduces them for someone else", async ({
  page,
  browser,
}) => {
  const decision = await seedPublishedPage({
    slug: "e2e-search-adr",
    title: "Back off exponentially",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: bodyAbout(NEEDLE.shared),
  });
  await seedPublishedPage({
    slug: "e2e-search-doc",
    title: "Bridge operations",
    markdown: bodyAbout(NEEDLE.shared),
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.shared}`);
  await expect(page.locator(".q-row")).toHaveCount(2);

  // The space filter's only control: a result names its space, and the name narrows to it. There
  // is no menu, because enumerating readable spaces is a second query this route does not make.
  await page.locator(".q-space").first().click();
  await expect(page).toHaveURL(/space=engineering/);
  await expect(page.locator(".q-note")).toContainText("Narrowed to the space engineering");
  await expect(page.locator(".q-row")).toHaveCount(2);

  // The doc type comes off the form, and the space has to survive it — a filter silently dropped
  // by the next submit is the same defect as one dropped from a link.
  await page.locator("select[name=type]").selectOption("ADR");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".q-row")).toHaveCount(1);
  await expect(page.locator(".q-title")).toHaveText(decision.title);

  const shared = page.url();
  const url = new URL(shared);
  expect(url.searchParams.get("q")).toBe(NEEDLE.shared);
  expect(url.searchParams.get("space")).toBe("engineering");
  expect(url.searchParams.get("type")).toBe("ADR");

  // **The claim, tested as a claim.** A second browser context is a second cookie jar, so this is
  // the same URL arriving at a different session — which is what sending a link means. It is the
  // super admin rather than the same person, so the URL is doing the work and not a warm cache.
  const other = await actorContext(browser, "admin@example.com");
  try {
    await other.page.goto(shared);
    await expect(other.page.locator(".q-row")).toHaveCount(1);
    await expect(other.page.locator(".q-title")).toHaveText(decision.title);
    await expect(other.page.locator("select[name=type]")).toHaveValue("ADR");
    await expect(other.page.locator(".q-note")).toContainText("Narrowed to the space engineering");
  } finally {
    await other.context.close();
  }
});

/* ------------------------------------------------------------------------- §6.4's demotion ---- */

test("a retired page stays in the results, with its status, below a live one", async ({ page }) => {
  // Both bodies are the same prose, so both match in the same weight band and the *only* thing
  // that can order them is the retired demotion. The needle is deliberately absent from both
  // titles: a title hit is band A and would drown the effect being measured.
  const live = await seedPublishedPage({
    slug: "e2e-search-live",
    title: "Current bridge policy",
    markdown: bodyAbout(NEEDLE.ranked),
  });
  const retired = await seedPublishedPage({
    slug: "e2e-search-retired",
    title: "Earlier bridge policy",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: bodyAbout(NEEDLE.ranked),
  });
  // `ACCEPTED → SUPERSEDED`: an ADR cannot be published straight into a terminal status from
  // `DRAFT`, so the retirement is a second publish, exactly as the product does it.
  await republishPage(retired, { markdown: bodyAbout(NEEDLE.ranked), status: "SUPERSEDED" });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.ranked}`);

  const rows = page.locator(".q-row");
  await expect(rows).toHaveCount(2);
  // Present, which is the half §6.4 cares about most: a person searching for a decision has to be
  // able to find the one that was superseded.
  await expect(rows.nth(1).locator(".q-title")).toHaveText(retired.title);
  await expect(rows.nth(1).locator(".q-status")).toHaveText("SUPERSEDED");
  // And below the live one, which is the other half — and this assertion cannot pass by accident.
  // The retirement is a *second* publish, so the retired page carries the later `publishedAt`, and
  // `publishedAt DESC` is the tiebreak the query falls back to at equal rank. Take the demotion
  // out and these two swap: the retired page would come first.
  await expect(rows.nth(0).locator(".q-title")).toHaveText(live.title);

  // The status filter isolates them — §13: *"the status filter isolates or excludes them"*.
  await page.locator("select[name=status]").selectOption("SUPERSEDED");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".q-row")).toHaveCount(1);
  await expect(page.locator(".q-title")).toHaveText(retired.title);
});

/* --------------------------------------------------------------------- hostile content ---- */

/**
 * A title that is hostile in both of the ways a title can be, in one string — the same shape
 * `lifecycle.spec.ts` uses, for the same reason: a search result paints **another** page's title
 * on this page's render, which is exactly where "it is only my own text" stops being an argument.
 *
 * 293 characters, under `TITLE_MAX_LENGTH`.
 */
const HOSTILE_TITLE = `<img src=x onerror="document.title='pwned'">${HOSTILE.slice(0, 250)}`;

test("hostile titles, paths and echoed filters neither widen the page nor render as markup", async ({
  page,
}) => {
  // A slug is capped at 80 characters where a title is capped at 300, so the path and the title
  // are two different injections and both are painted on a result row.
  const hostileSlug = `e2e-${"x".repeat(76)}`;
  const fixture = await seedPublishedPage({
    slug: hostileSlug,
    title: HOSTILE_TITLE,
    markdown: bodyAbout(NEEDLE.hostile),
  });
  expect(fixture.path).toBe(hostileSlug);

  await signIn(page, "aisyah@example.com");
  await page.goto(`/search?q=${NEEDLE.hostile}`);

  const row = page.locator(".q-row");
  await expect(row).toHaveCount(1);
  // The token is really on the page. A probe that measures a page not carrying the hostile
  // content is the "guard testing its own corpus" failure this test exists to avoid.
  await expect(row.locator(".q-title")).toContainText(HOSTILE.slice(0, 200));
  await expect(row.locator(".q-path")).toHaveText(hostileSlug);

  // Text, not markup: no element was created from the title, and its `onerror` never ran.
  expect(await page.locator(".q-list img").count()).toBe(0);
  expect(await page.title()).not.toBe("pwned");

  const withRow = await measureOverflow(page);
  expect(withRow.width, "the search route reported a zero-width viewport").toBeGreaterThan(0);
  expect(
    withRow.overflow,
    `a result carrying a hostile title and path widens the page by ${withRow.overflow}px`,
  ).toBe(0);

  // And the strings that come off the URL rather than out of a row: the query is echoed into a
  // sentence and an unrecognised filter is named back, both capped before they are painted.
  await page.goto(`/search?q=${HOSTILE}&status=${HOSTILE}&space=${HOSTILE}`);
  await expect(page.locator(".q-empty")).toContainText("No page matches");
  const notes = page.locator(".q-note");
  await expect(notes.filter({ hasText: "is not a status" })).toBeVisible();
  for (const text of await page.locator(".q-empty, .q-note").allInnerTexts()) {
    expect(text.length, "an echoed value was painted in full").toBeLessThan(250);
  }

  const withEcho = await measureOverflow(page);
  expect(withEcho.width).toBeGreaterThan(0);
  expect(
    withEcho.overflow,
    `an echoed query and filter widen the search page by ${withEcho.overflow}px`,
  ).toBe(0);
});
