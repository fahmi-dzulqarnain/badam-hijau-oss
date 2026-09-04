/**
 * End-to-end coverage of Mermaid hydration (Phase 4, Task 5) — spec §12 and §14.
 *
 * **Every claim in Task 5 is a claim about a browser, and nothing else can be asked.** The vitest
 * suite pins what a render *decides* (`src/lib/diagrams/config.test.ts`) and `npm run build` pins
 * where the library *lives* (`scripts/check-diagram-bundle.ts`). Neither can say whether a fence
 * became an SVG, whether a hostile source executed, or whether one bad diagram took the article
 * with it — those are facts about a DOM after a dynamic import resolved.
 *
 * Everything here writes to the **development** database and takes its rows back out; `support.ts`
 * says why that is the only database it can be, and the `afterAll` asserts the counts are back
 * where `beforeAll` found them. Two tests need no fixture at all: the seeded
 * `architecture/mqtt-contracts` page already carries a `C4Context` fence, which is Task 5 Step 5's
 * subject arriving through content the product already has rather than through a page invented to
 * prove a point.
 *
 * ## Two security tests, not one, and why the plan expects one
 *
 * The plan's landmine is the hostile **label** — `A["</div><script>alert(1)</script>"]` — and it is
 * exactly right about the mechanism: reading `textContent` decodes what the pipeline escaped, so
 * Mermaid receives that string literally. But measured on `mermaid@11.17.2`, a label cannot
 * distinguish `securityLevel: "strict"` from `"loose"`: `sanitizeText` runs DOMPurify at **every**
 * level, so the `<script>` is stripped either way. Mutating the constant leaves that test green.
 *
 * What the two levels genuinely disagree about is **interaction**. Flowchart's `setClickFun` opens
 * `if (getConfig().securityLevel !== "loose") return;`, so a `click A call pwn()` line is a call
 * into `window` under `loose` and nothing at all under `strict`. That is the test the constant is
 * load-bearing for, and it is why there are two here:
 *
 * - the **label** test pins the source never being written back as markup;
 * - the **click** test pins `securityLevel`.
 *
 * Reported as plan drift rather than deviated from silently. The instruction — set it explicitly,
 * pin it with a test — is unchanged; only which test kills the mutant is different.
 */
import { expect, test, type Page } from "@playwright/test";
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

/** A fence, written the way a document does. */
function fence(source: string): string {
  return ["```mermaid", source, "```"].join("\n");
}

/**
 * Everything a hostile page tries, recorded on `window` before any of the page's own script runs.
 *
 * `addInitScript` and not a `page.on("dialog")` handler alone: a dialog handler proves an `alert()`
 * did not reach the browser's dialog machinery, and says nothing about a `click … call` reaching an
 * arbitrary function. Both are recorded, and both are asserted, because they are two different
 * escapes.
 */
async function armTripwires(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __alerts: string[]; __called: string[] };
    w.__alerts = [];
    w.__called = [];
    window.alert = (message?: unknown) => {
      w.__alerts.push(String(message));
    };
    // The name a `click A call pwn()` line resolves against. Mermaid's `runFunc` walks `window` by
    // name, so this is the function a `loose` configuration would find.
    (window as unknown as { pwn: () => void }).pwn = () => {
      w.__called.push("pwn");
    };
  });
}

async function tripwires(page: Page): Promise<{ alerts: string[]; called: string[] }> {
  return page.evaluate(() => ({
    alerts: (window as unknown as { __alerts: string[] }).__alerts,
    called: (window as unknown as { __called: string[] }).__called,
  }));
}

let baseline: Counts;

test.beforeAll(async () => {
  await sweep();
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before diagrams: ${formatCounts(baseline)}`);
});

// Not just `afterEach`: a fixture surviving a crashed run makes the next run's `createPage` fail
// with `path-occupied`, which reads as a product bug and is not one.
test.beforeEach(sweep);

test.afterAll(async () => {
  await sweep();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after diagrams:  ${formatCounts(after)}`);
  expect(after, "the diagram suite did not leave the dev database as it found it").toEqual(
    baseline,
  );
  await db.$disconnect();
});

/* ------------------------------------------------------------------- it renders at all ---- */

/**
 * Task 5 Step 5: **C4, tested rather than assumed.**
 *
 * On the *seeded* page, which is the point. §12 names `C4Context` and `C4Container`, and the
 * question the plan raises is whether a diagram type needs a registration of its own — an answer
 * that would be found here or in production. It needs none: `mermaid.render` resolves the detector
 * and lazily imports the C4 renderer by itself, and the SVG comes back carrying
 * `aria-roledescription="c4"`, which is Mermaid naming the diagram type it actually built.
 *
 * The overflow measurement rides along because this is the one page in the product that has a
 * diagram without a test having put one there.
 */
test("the seeded C4 diagram renders, on the page the seed already had", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  const diagram = page.locator(".body .mermaid-source");
  await expect(diagram).toHaveCount(1);
  // `mermaid-ready` and not just "an svg exists": the class is what `doc.css` hangs the hydrated
  // styling on, so a render that painted an SVG without it would look like the dashed placeholder
  // with a diagram inside it.
  await expect(diagram).toHaveClass(/mermaid-ready/);

  const svg = diagram.locator("svg");
  await expect(svg).toHaveCount(1);
  // Mermaid's own label for what it built. A flowchart says "flowchart-v2"; this says the C4
  // renderer ran, which no assertion about the presence of an `<svg>` could distinguish.
  await expect(svg).toHaveAttribute("aria-roledescription", "c4");
  await expect(svg.locator("text", { hasText: "Cashier" }).first()).toBeVisible();

  // The source is gone from the document: it went into `mermaid.render` as a string and the SVG
  // came back in its place.
  await expect(diagram).not.toContainText("C4Context");

  const { overflow, width } = await measureOverflow(page);
  expect(width, "the reader reported a zero-width viewport").toBeGreaterThan(0);
  expect(overflow, `the seeded C4 diagram widens the reader by ${overflow}px`).toBe(0);
});

test("a flowchart fence becomes an SVG, and the theme comes from the page", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-flowchart",
    title: "Bridge retry flow",
    markdown: [
      "## Flow",
      "",
      fence(["graph TD", '  A["Publish"] --> B["Bridge"]', '  B --> C["Outlet"]'].join("\n")),
      "",
      "The bridge retries on a fixed interval.",
      "",
    ].join("\n"),
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const svg = page.locator(".body .mermaid-source.mermaid-ready svg");
  await expect(svg).toHaveCount(1);
  await expect(svg).toHaveAttribute("aria-roledescription", /flowchart/);

  /**
   * **The theme decision, asserted as a fact about the rendered SVG.**
   *
   * A Mermaid theme cannot be CSS variables — Mermaid does colour arithmetic on `themeVariables`
   * and bakes the results into a `<style>` block inside the SVG — so the only way a diagram can be
   * readable on a dark page is for the render to have read the page's own tokens. Playwright's
   * default colour scheme is light, so the check is that the SVG's baked palette contains the
   * light `--ink` from `globals.css` and not Mermaid's own default text colour.
   *
   * Stated as "the page's token is in there", not as an exhaustive palette comparison: the point is
   * that `getComputedStyle` was consulted, and a mutation replacing it with a constant palette is
   * what this fails on.
   */
  // `textContent` through `evaluate`, not `innerText`: an SVG `<style>` is an `SVGStyleElement`
  // and Playwright's `innerText` requires an `HTMLElement`.
  const style = await svg.locator("style").first().evaluate((el) => el.textContent ?? "");
  expect(style.toLowerCase(), "the diagram was not themed from the page's tokens").toContain(
    "#15201b",
  );

  // The prose after the fence is untouched — the diagram replaced its own node and nothing else.
  await expect(page.locator(".body p").last()).toHaveText("The bridge retries on a fixed interval.");
});

/**
 * **The other half of the theme decision: a viewer who switches after the diagram has rendered.**
 *
 * A rendered SVG carries baked colours, so the only correct answer is to render it again — which is
 * why the component reads every source before it writes anything back, and keeps them.
 *
 * Asserted three ways, because a partial implementation passes any one of them:
 *
 * - the new SVG's baked palette is the **dark** `--ink` and no longer the light one, so the redraw
 *   re-read the tokens rather than reusing the config it built the first time;
 * - the SVG's **id changed**, so this is a new render and not a repaint of the old one;
 * - there is still exactly **one** SVG, so the redraw replaced the diagram rather than appending a
 *   second one beside it.
 */
test("switching theme after a diagram has rendered re-renders it", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-theme",
    title: "Theme switch",
    markdown: [
      "## Flow",
      "",
      fence(["graph TD", '  A["One"] --> B["Two"]'].join("\n")),
      "",
    ].join("\n"),
  });

  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const box = page.locator(".body .mermaid-source.mermaid-ready");
  await expect(box.locator("svg")).toHaveCount(1);

  const paletteOf = async () =>
    (await box.locator("svg style").first().evaluate((el) => el.textContent ?? "")).toLowerCase();

  const lightPalette = await paletteOf();
  const lightId = await box.locator("svg").getAttribute("id");
  expect(lightPalette, "the light render did not use the light --ink").toContain("#15201b");

  await page.emulateMedia({ colorScheme: "dark" });

  // Polled, not awaited on a fixed delay: the redraw is asynchronous and its cost is a Mermaid
  // layout pass, which is not a number this test should be asserting.
  await expect
    .poll(async () => (await paletteOf()).includes("#e5ebe6"), { timeout: 10_000 })
    .toBe(true);

  const darkPalette = await paletteOf();
  expect(darkPalette, "the dark render still carries the light --ink").not.toContain("#15201b");
  expect(await box.locator("svg").getAttribute("id")).not.toBe(lightId);
  await expect(box.locator("svg"), "the redraw appended a second diagram").toHaveCount(1);
});

/* ------------------------------------------------------------------------- the landmine ---- */

/**
 * The plan's measured landmine, end to end.
 *
 * The pipeline escapes the fence's text, so the document holds
 * `A["&#x3C;/div>&#x3C;script>alert(1)&#x3C;/script>"]`. `textContent` **decodes that**, which is
 * correct — it is the diagram source the author wrote — so Mermaid is handed the literal
 * `</div><script>alert(1)</script>`.
 *
 * Three things must then be true, and they fail differently:
 *
 * - **No script element**, anywhere in the body. Mermaid's DOMPurify pass is what earns this.
 * - **No alert.** A script element that exists but did not run would still be a finding.
 * - **The diagram is still inside its own box.** This is the one that catches the source being
 *   written back as markup: `</div>` closing `.mermaid-source` and then the document's own `div`
 *   would leave a diagram that renders and a document that is structurally wrong. It is asserted as
 *   a parent relationship rather than by counting elements, because the counting version passes on
 *   a page where the escape happened to land somewhere harmless.
 */
test("a hostile label executes nothing and stays inside its own box", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-hostile-label",
    title: "Hostile label",
    markdown: [
      "## Diagram",
      "",
      fence(["graph TD", '  A["</div><script>alert(1)</script>"] --> B["fine"]'].join("\n")),
      "",
      "Everything after the diagram still reads.",
      "",
    ].join("\n"),
  });

  await armTripwires(page);
  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const box = page.locator(".body .mermaid-source");
  await expect(box).toHaveCount(1);
  // It rendered: a hostile label is a legal label, and refusing to draw it would be a different
  // bug. Mermaid escapes the text and draws a node whose caption is the literal string.
  await expect(box.locator("svg")).toHaveCount(1);

  expect(await page.locator(".body script").count(), "a script element was created").toBe(0);
  expect(await page.locator(".doc script").count(), "a script element escaped the body").toBe(0);

  const fired = await tripwires(page);
  expect(fired.alerts, "an alert() ran").toEqual([]);

  // The SVG is a descendant of the box the fence produced, so nothing closed that box early.
  expect(
    await box.locator("svg").evaluate((svg) => svg.closest(".mermaid-source") !== null),
  ).toBe(true);
  await expect(page.locator(".body p").last()).toHaveText(
    "Everything after the diagram still reads.",
  );

  const { overflow, width } = await measureOverflow(page);
  expect(width).toBeGreaterThan(0);
  expect(overflow, `a hostile diagram widens the reader by ${overflow}px`).toBe(0);
});

/**
 * **The test `securityLevel` is load-bearing for**, and finding one took three attempts.
 *
 * A `click` line has three parts a document can use, and they are not equally observable:
 *
 * - **`click X href "javascript:…"` — the mutant-killing assertion.** `formatUrl` reads
 *   `if (config.securityLevel !== "loose") return sanitizeUrl(url);`, so the scheme survives into
 *   the SVG's own `<a>` under `loose` and does not under `strict`. Nothing has to be bound and
 *   nothing has to be clicked: the difference is in the markup.
 * - **`click X call pwn()` — asserted, but not what kills the mutant.** `setClickFun` does return
 *   early under `strict`, and yet the listener it would otherwise register is attached only by the
 *   `bindFunctions` that `mermaid.render` returns — which this component deliberately never calls.
 *   Under `strict` there would be nothing to bind, so binding would mean attaching handlers that
 *   cannot exist; not calling it is a second, independent barrier. Asserted anyway, because
 *   "clicking a node calls nothing" is the claim a reader cares about, and a refactor that starts
 *   calling `bindFunctions` must not pass silently.
 * - **The `clickable` class is not a guard at all.** Measured: `setClickEvent` calls `setClickFun`,
 *   which returns early, and *then* `this.setClass(ids, "clickable")` unconditionally. The first
 *   version of this test asserted that class was absent and failed against correct behaviour — the
 *   "a guard on the rows is not a guard on the decision" family. The class records that the document
 *   asked, not that Mermaid agreed.
 *
 * **The non-vacuity companion is a second link that is allowed through.** The first version asserted
 * "no href contains `javascript:`" over every anchor, and measured what the hostile URL actually
 * produces under `strict`: an `<a>` with **no href attribute at all**. So the "no javascript:"
 * assertion was passing over an empty list, and its `hrefs.length > 0` guard is what said so. A
 * safe `https://` link on a second node is the fix — it proves the link mechanism reached the DOM
 * on this very diagram, so the hostile URL's absence is a decision rather than a missing feature.
 */
test("a click line in a document links nowhere and calls nothing", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-hostile-click",
    title: "Hostile interaction",
    markdown: [
      "## Diagram",
      "",
      fence(
        [
          "graph TD",
          '  A["Press me"] --> B["Safe link"]',
          '  B --> C["Or me"]',
          '  click A href "javascript:alert(1)"',
          '  click B href "https://example.com/ok"',
          "  click C call pwn()",
        ].join("\n"),
      ),
      "",
    ].join("\n"),
  });

  await armTripwires(page);
  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const svg = page.locator(".body .mermaid-source.mermaid-ready svg");
  await expect(svg).toHaveCount(1);

  /**
   * Every href the diagram produced, under both attribute spellings an SVG can carry one — d3 writes
   * `xlink:href`, and a future renderer writing plain `href` must not slip past.
   */
  const hrefs = await svg.evaluate((root) =>
    [...root.querySelectorAll("a")].flatMap((a) =>
      [a.getAttribute("href"), a.getAttribute("xlink:href")].filter(
        (value): value is string => value !== null,
      ),
    ),
  );

  // Non-vacuity: the safe link is here, so this diagram's links did reach the DOM.
  expect(hrefs, "the safe link never reached the DOM, so the next assertion is vacuous").toContain(
    "https://example.com/ok",
  );
  // The mutant-killing assertion.
  for (const href of hrefs) {
    expect(href.toLowerCase(), `a document-supplied URL survived as ${href}`).not.toContain(
      "javascript:",
    );
  }

  // And the callback half. The two hostile nodes only: `Safe link` is a real anchor and clicking it
  // would navigate away, which would make every assertion after it a claim about example.com.
  // `g.node` filtered by its text, and **not** a `text` element: a flowchart's labels live in a
  // `foreignObject` as HTML, so `locator("text")` finds nothing here — measured, after a 30-second
  // timeout. The seeded C4 diagram above does use SVG `<text>`, which is why the two specs differ.
  for (const label of ["Press me", "Or me"]) {
    await svg.locator("g.node", { hasText: label }).first().click({ force: true });
  }
  await expect(page).toHaveURL(new RegExp(`/engineering/${fixture.path}$`));

  const fired = await tripwires(page);
  expect(fired.called, "a document called a function on window").toEqual([]);
  expect(fired.alerts, "an alert() ran").toEqual([]);
});

/* ----------------------------------------------------------------- an error in place ---- */

/**
 * §14: *"Renders as a code block with an inline error, rest of page unaffected."*
 *
 * **Three fences, and the bad one in the middle**, which is what makes this a test of a per-diagram
 * boundary rather than of a page-level `try`. A single malformed fence on its own page cannot tell
 * the two apart: both produce "one error and no diagram". With a good diagram either side, moving
 * the `catch` out of the loop leaves diagrams one and three unrendered — and the assertion that
 * diagram *three* rendered is the one that fails, because a `for` loop that throws never reaches it.
 *
 * The source is hostile as well as malformed, deliberately. This is the one place the raw diagram
 * source is written back into the document, and it is written with `textContent`; a mutation to
 * `innerHTML` would put `</div><script>` into the page as markup, so the script-element assertion
 * covers the error path too rather than only the success path.
 */
test("a malformed diagram is an error in place, and the page around it is untouched", async ({
  page,
}) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-malformed",
    title: "Three diagrams, one broken",
    markdown: [
      "## First",
      "",
      fence(['graph TD\n  A["one"] --> B["two"]'].join("\n")),
      "",
      "## Second",
      "",
      fence('graph TD\n  A[--> B["</div><script>alert(1)</script>"'),
      "",
      "## Third",
      "",
      fence('graph LR\n  C["three"] --> D["four"]'),
      "",
      "This paragraph is the rest of the page.",
      "",
    ].join("\n"),
  });

  await armTripwires(page);
  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);

  const boxes = page.locator(".body .mermaid-source");
  await expect(boxes).toHaveCount(3);

  // First and third rendered. The third is the assertion a page-level catch cannot satisfy.
  await expect(boxes.nth(0)).toHaveClass(/mermaid-ready/);
  await expect(boxes.nth(0).locator("svg")).toHaveCount(1);
  await expect(boxes.nth(2)).toHaveClass(/mermaid-ready/);
  await expect(boxes.nth(2).locator("svg")).toHaveCount(1);

  // The middle one is a code block with an inline error.
  const failed = boxes.nth(1);
  await expect(failed).toHaveClass(/mermaid-failed/);
  await expect(failed.locator("svg")).toHaveCount(0);
  await expect(failed.locator(".mermaid-error")).toContainText("Diagram error:");
  await expect(failed.locator("pre code")).toContainText("graph TD");
  // The message is capped: Mermaid's expected-token list runs to hundreds of characters and would
  // bury the code block under it.
  const message = await failed.locator(".mermaid-error").innerText();
  expect(message.length, "the parser's whole complaint was painted").toBeLessThan(280);

  // The source went back in as text, not as markup — on the one path where hostile source is
  // written to the document at all.
  expect(await page.locator(".body script").count()).toBe(0);
  expect((await tripwires(page)).alerts).toEqual([]);
  await expect(failed.locator("pre code")).toContainText("</div><script>");

  // And the article: every heading, and the paragraph after all three fences.
  await expect(page.locator(".body h2")).toHaveCount(3);
  await expect(page.locator(".body p").last()).toHaveText("This paragraph is the rest of the page.");
  await expect(page.locator(".doc h1")).toHaveText(fixture.title);

  const { overflow, width } = await measureOverflow(page);
  expect(width).toBeGreaterThan(0);
  expect(overflow, `a failed diagram widens the reader by ${overflow}px`).toBe(0);
});

/* -------------------------------------------------------------------- no wider page ---- */

/**
 * The horizontal-overflow class, **seventh shape**, injected rather than hoped for.
 *
 * A diagram is the widest thing this application can put in a document, and no seeded page has a
 * wide one — which is exactly the situation that left a 4,660px reader overflow green for all of
 * Phase 1. `HOSTILE` is the 300-character unbreakable token the other five shapes were caught with,
 * here as three node labels, which Mermaid lays out side by side.
 *
 * Neither CSS rule can be trusted on its own and both are in play: Mermaid writes an inline
 * `max-width: NNNpx` on the SVG that outranks any selector, and the box's `overflow-x: auto`
 * establishes a formatting context whose width is its containing block's. This measures the outcome.
 */
test("a very wide diagram does not widen the page", async ({ page }) => {
  const fixture = await seedPublishedPage({
    slug: "e2e-diagram-wide",
    title: "A very wide diagram",
    markdown: [
      "## Wide",
      "",
      fence(
        [
          "graph LR",
          `  A["${HOSTILE}"] --> B["${HOSTILE}"]`,
          `  B --> C["${HOSTILE}"]`,
        ].join("\n"),
      ),
      "",
    ].join("\n"),
  });

  await signIn(page, "aisyah@example.com");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/engineering/${fixture.path}`);

  const box = page.locator(".body .mermaid-source.mermaid-ready");
  await expect(box).toHaveCount(1);
  await expect(box.locator("svg")).toHaveCount(1);

  const { overflow, width } = await measureOverflow(page);
  expect(width, "the reader reported a zero-width viewport").toBeGreaterThan(0);
  expect(overflow, `a wide diagram widens the reader by ${overflow}px`).toBe(0);

  // And the box itself stayed inside the document column, rather than the page having grown to fit
  // it — the two are indistinguishable from `scrollWidth` alone once a scroll container is involved.
  const boxWidth = await box.evaluate((el) => el.getBoundingClientRect().width);
  expect(boxWidth).toBeLessThanOrEqual(width);
});
