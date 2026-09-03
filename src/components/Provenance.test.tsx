import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Route } from "next";
import { RailFoot } from "./RailFoot";
import { ContentCommit, Sha } from "./Provenance";
import { buildInfo } from "@/lib/version/build";
import { BUILD_LABEL, CONTENT_COMMIT_LABEL, NOT_MIRRORED } from "@/lib/version/labels";

/**
 * Task 7 Step 1 and Step 2, asserted on rendered markup.
 *
 * **The first test in this project to server-render a component**, and the reason is that the two
 * surfaces this is about are a route (an async Server Component that reads the database, so only
 * Playwright can render it) and a nav-rail fragment. Playwright's browsers are not installed on
 * this machine, so an e2e-only assertion would have meant no executable evidence at all for the
 * one decision this task is mostly *about* — words. `renderToStaticMarkup` from `react-dom/server`
 * works under vitest's node environment, and `next/link` degrades to a plain `<a>` outside a Next
 * request, so the affordance is assertable too.
 *
 * `e2e/history.spec.ts` carries the same assertions against a real page, for when the browsers
 * are there.
 *
 * **One caveat, measured rather than assumed.** `renderToStaticMarkup` emits no hydration
 * markers, where a real Next render inserts `<!-- -->` between adjacent text children — the
 * shipped HTML for the rail foot is `Build<!-- --> <!-- -->0.1.0+df0ef11`. So an adjacency
 * assertion here is about the element tree and not about the byte sequence a browser receives;
 * `textContent` (and therefore Playwright's `toContainText`) ignores the comments, which is why
 * the e2e assertions are written against visible text. Verified by driving a real `next start`
 * against the test database — see the task record.
 */

const SHA = "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d";
const HISTORY = "/engineering/-/history/architecture/mqtt-contracts" as Route;

const railFoot = () =>
  renderToStaticMarkup(<RailFoot build={buildInfo({ GIT_SHA: "df0ef11abc" })} />);

/* -------------------------------------------------------------------------- */
/* The two shas on one page                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The discrimination, and the only test here that fails for the original defect.
 *
 * Both surfaces are rendered into one string — which is what a reader gets — and each sha has to
 * be reachable through a label the *other* one does not answer to. Asserting the labels
 * separately would pass with both of them reading `Commit`.
 */
test("a reader meets both shas at once, each named after its own repository", () => {
  const page =
    railFoot() +
    renderToStaticMarkup(<ContentCommit gitSha={SHA} historyHref={HISTORY} />);

  expect(page).toContain(CONTENT_COMMIT_LABEL);
  expect(page).toContain(BUILD_LABEL);

  // The content sha's short form and the build's sha are both on the page and are different
  // strings — so a label that fitted either value would be the whole bug.
  expect(page).toContain("9f2c1ab4d5");
  expect(page).toContain("0.1.0+df0ef11");

  // Neither value is painted with no label anywhere on the page. `Build` immediately precedes
  // the build string, and `Content commit` the content sha.
  expect(page).toMatch(new RegExp(`${BUILD_LABEL}\\s+0\\.1\\.0\\+df0ef11`));
  expect(page).toMatch(new RegExp(`${CONTENT_COMMIT_LABEL}</span>\\s*<code`));
});

test("the rail foot no longer paints the build string unlabelled", () => {
  // The mutation this kills is deleting `BUILD_LABEL` from `RailFoot` — which leaves the sha
  // there and every other assertion in this file green.
  expect(railFoot()).toContain(`${BUILD_LABEL} 0.1.0+df0ef11`);
});

/* -------------------------------------------------------------------------- */
/* The 40-character token                                                     */
/* -------------------------------------------------------------------------- */

test("a 40-character sha is painted short, with the whole value in a title", () => {
  const html = renderToStaticMarkup(<Sha value={SHA} />);
  expect(html).toBe(`<code class="sha" title="${SHA}">9f2c1ab4d5</code>`);
  // The point of the exercise: nothing 40 characters long is in the text.
  expect(html).not.toMatch(new RegExp(`>${SHA}<`));
});

test("the full sha is available without being rendered as text", () => {
  // `title` and not the element's text, because a git object name has no break opportunity in
  // it: `overflow-wrap: anywhere` cannot rescue 40 unbroken characters in a 12px gutter, which
  // is the sixth shape of this project's oldest layout bug arriving again.
  const html = renderToStaticMarkup(<Sha value={SHA} />);
  expect(html).toContain(`title="${SHA}"`);
});

/* -------------------------------------------------------------------------- */
/* A null sha is a state, not a gap                                           */
/* -------------------------------------------------------------------------- */

test("a version with no sha reads as a normal state and not as an empty value", () => {
  const html = renderToStaticMarkup(<ContentCommit gitSha={null} historyHref={HISTORY} />);
  expect(html).toContain(NOT_MIRRORED);
  // No `<code class="sha">` at all — an empty one would be the gap Step 2 forbids.
  expect(html).not.toContain('class="sha"');
  // And the label is still there, so the row says what is missing rather than just going quiet.
  expect(html).toContain(CONTENT_COMMIT_LABEL);
});

/* -------------------------------------------------------------------------- */
/* The affordance                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The link is offered in **both** states, and the unmirrored one is the case that matters:
 * every version published before Phase 5 has no sha, so a link conditional on having one would
 * be missing from exactly the pages a reader has a question about — and the history page is
 * where the question is answered.
 */
test.each([
  ["a mirrored version", SHA],
  ["an unmirrored one", null],
])("version history is reachable from %s", (_name, gitSha) => {
  const html = renderToStaticMarkup(
    <ContentCommit gitSha={gitSha} historyHref={HISTORY} />,
  );
  expect(html).toContain(`href="${HISTORY}"`);
  expect(html).toContain("Version history");
});
