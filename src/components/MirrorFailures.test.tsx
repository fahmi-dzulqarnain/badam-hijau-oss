import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MirrorFailures } from "./MirrorFailures";
import { dateTimeFormat } from "@/lib/format";
import { TITLE_MAX_LENGTH } from "@/lib/drafts/schema";
import type { MirrorFailure, MirrorReport } from "@/lib/git/failures";

/**
 * The failed-jobs list, rendered.
 *
 * Task 7 established the shape: the route reads the database, so nothing short of a browser can
 * render it, and a pure component taking a `MirrorReport` renders here with
 * `renderToStaticMarkup`. That is what gives the thing this task is mostly about — the **words**,
 * and specifically the words about what the page does *not* show — executable evidence instead of
 * a Playwright assertion. `next/link` degrades to a plain `<a>` outside a Next request.
 *
 * `e2e/admin-git.spec.ts` carries what needs a layout engine: the horizontal-overflow measurement.
 */

/** 300 characters with no break opportunity — `TITLE_MAX_LENGTH`, so a real publish can store it. */
const HOSTILE = "x".repeat(TITLE_MAX_LENGTH);
/** Markup that would escape the document if anything here interpolated raw HTML. */
const INJECTION = '</p><script>alert("xss")</script>';
const TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";

/** Two timestamps that are distinguishable in any zone, so a swapped pair fails. */
const QUEUED = new Date("2026-03-04T09:12:00Z");
const LAST_TRIED = new Date("2026-03-04T09:40:00Z");

function failure(over: Partial<MirrorFailure> = {}): MirrorFailure {
  return {
    id: 1,
    kind: "PUBLISH",
    spaceKey: "engineering",
    path: "architecture/topic-registry",
    fromPath: null,
    pageTitle: "Topic registry",
    pageSpaceKey: "engineering",
    pagePath: "architecture/topic-registry",
    pageDeleted: false,
    attempts: 5,
    queuedAt: QUEUED,
    lastAttemptAt: LAST_TRIED,
    lastError: "Pushing to the content remote: git exited 128. Output: fatal: no such remote",
    blocked: 0,
    ...over,
  };
}

function report(over: Partial<MirrorReport> = {}): MirrorReport {
  return {
    failures: over.failures ?? [failure()],
    truncated: over.truncated ?? false,
    retrying: over.retrying ?? 0,
  };
}

const render = (r: MirrorReport) => renderToStaticMarkup(<MirrorFailures report={r} />);

/* -------------------------------------------------------------------------- */
/* Step 1 — what a row says                                                   */
/* -------------------------------------------------------------------------- */

test("a failure names the kind, the page, the mirror address, the attempts and the error", () => {
  const html = render(report());

  expect(html).toContain("PUBLISH");
  expect(html).toContain("Topic registry");
  expect(html).toContain("engineering/architecture/topic-registry.md");
  expect(html).toContain("Gave up after 5 attempts");
  /*
   * `updatedAt` is "when it was last attempted", and an attempt count with no timestamp cannot
   * tell a job failing now from one that gave up last week — the schema says so at the column.
   *
   * Formatted through `dateTimeFormat` rather than written as a literal, because `dateTimeFormat`
   * pins no zone (deliberately — `src/lib/format.ts` argues it, so two surfaces cannot disagree
   * about which day a publish happened) and this machine is `Asia/Kuala_Lumpur`, where a 09:40Z
   * fixture renders as 16:40. That is not "comparing a value against a copy of itself": the two
   * timestamps are eight minutes apart in the fixture, so the mutant this kills is the one that
   * matters here — the two slots swapped, or one field rendered twice.
   */
  expect(html).toContain(`last tried ${dateTimeFormat.format(LAST_TRIED)}`);
  expect(html).toContain(`queued ${dateTimeFormat.format(QUEUED)}`);
  expect(dateTimeFormat.format(LAST_TRIED)).not.toBe(dateTimeFormat.format(QUEUED));
  expect(html).toContain("fatal: no such remote");
});

test("the page links to its version history, which answers for an unpublished page too", () => {
  const html = render(report());
  expect(html).toContain('href="/engineering/-/history/architecture/topic-registry"');
});

test("a soft-deleted page is named as deleted and is not linked", () => {
  // The history route requires a page `visiblePage()` accepts, so a link here would 404 — the
  // draft-is-inert rule arriving at its sixth site.
  const html = render(report({ failures: [failure({ kind: "DELETE", pageDeleted: true })] }));

  expect(html).toContain("page deleted");
  expect(html).not.toContain("/-/history/");
  // Non-vacuity: the row is still rendered and still names the page.
  expect(html).toContain("Topic registry");
  expect(html).toContain("DELETE");
});

test("a MOVE names both addresses", () => {
  const html = render(
    report({
      failures: [
        failure({ kind: "MOVE", path: "new/home", fromPath: "old/home", pageDeleted: false }),
      ],
    }),
  );
  expect(html).toContain("engineering/new/home.md");
  expect(html).toContain("engineering/old/home.md");
});

test("a singular attempt and a singular blocked change are not pluralised", () => {
  // Phase 2 fixed `page/pages` and left `draft` singular directly beside it, because the seed has
  // exactly one draft and every by-hand check looked right. Every count on this surface is
  // checked at 1 and at more than 1.
  const one = render(report({ failures: [failure({ attempts: 1, blocked: 1 })] }));
  expect(one).toContain("Gave up after 1 attempt");
  expect(one).not.toContain("1 attempts");
  expect(one).toContain("One change to this page is");
  expect(one).toContain("One page has stopped mirroring.");

  const many = render(
    report({ failures: [failure({ attempts: 5, blocked: 4 }), failure({ id: 2 })] }),
  );
  expect(many).toContain("Gave up after 5 attempts");
  expect(many).toContain("4 changes to this page are");
  expect(many).toContain("2 pages have stopped mirroring.");
});

test("a failure with nothing queued behind it says nothing about blocking", () => {
  // The companion to the assertion above: a sentence rendered unconditionally would pass it.
  const html = render(report({ failures: [failure({ blocked: 0 })] }));
  expect(html).not.toContain("queued behind this");
});

test("a FAILED job with no recorded error reads as a missing error, not an empty one", () => {
  const html = render(report({ failures: [failure({ lastError: null })] }));
  expect(html).toContain("git said nothing that was recorded");
});

test("a truncated list says so, and an untruncated one does not", () => {
  expect(render(report({ truncated: true }))).toContain("There are more.");
  expect(render(report({ truncated: false }))).not.toContain("There are more.");
});

/* -------------------------------------------------------------------------- */
/* Step 2 — what it does not cover                                            */
/* -------------------------------------------------------------------------- */

test("the empty state says nothing has given up, and never that the mirror is healthy", () => {
  /*
   * The failure Step 2 is about, in the one place a reader is most inclined to believe a
   * completeness claim. "No failures" is not "everything is mirrored": nothing here compares the
   * repository against the database.
   */
  const html = render(report({ failures: [] }));

  expect(html).toContain("No mirror job has given up.");
  expect(html).not.toMatch(/health|up to date|everything is mirrored/i);
});

test("the gap section is rendered even when there is nothing wrong", () => {
  // Unconditional, unlike every other note in this codebase, and this is the assertion that pins
  // the exception: it explains what is *not* on the screen, so it is needed most in exactly the
  // state a conditional version would hide it.
  const html = render(report({ failures: [] }));
  expect(html).toContain("What this list does not cover");
});

/**
 * **The sentence Phase 7 Task 7 had to correct, pinned in its corrected form.**
 *
 * Phase 5 wrote *"this is the mirror's queue, not a reconciliation"* and this test asserted the
 * phrase. Task 7 built the reconcile pass, which made the sentence false — and a page that told a
 * reader the gap could not be closed, two sections below a button that closes it, would be exactly
 * the "surface that lies about its own coverage" this whole section exists to prevent.
 *
 * So the assertion moved with the wording, and it asserts **both halves**: what changed (they can
 * be reconciled, by a person, deliberately) and what did not (nothing compares the repository
 * against the database, so an empty failures list is still not "every page is mirrored"). Dropping
 * the second half would leave a page claiming more coverage than it has, which is the same defect
 * pointing the other way.
 */
test("it says versions from before the mirror existed are reconcilable, not failures", () => {
  const html = render(report());
  expect(html).toContain("Pages published before the mirror existed");
  expect(html).toContain("nothing queued them");
  expect(html).toContain("reconcilable");
  // Still true, and the half that must survive the correction: this list compares nothing.
  expect(html).toContain("compares nothing against the repository");
  expect(html).toContain("is not \u201Cevery page is mirrored\u201D");
  // And the claim that is now false is gone rather than merely joined by a truer one.
  expect(html).not.toContain("not a reconciliation");
});

test("it says a change that will be retried is not here, and counts them", () => {
  // The three plurals, because "3 changes is waiting" is the defect this project has shipped once.
  expect(render(report({ retrying: 0 }))).toContain("Nothing is waiting to be retried right now.");
  expect(render(report({ retrying: 1 }))).toContain("One change is waiting to be retried");
  expect(render(report({ retrying: 7 }))).toContain("7 changes are waiting to be retried");
});

test("it says changes queued behind a failure are counted rather than listed", () => {
  expect(render(report())).toContain("Changes queued behind a failure");
});

test("it says a run that never started fails no job and leaves this list unchanged", () => {
  /*
   * The gap the plan did not name and `worker.ts` does: `not-a-repository` is deliberately a
   * whole-**run** condition and not a job's, so a mirror pointed at the wrong directory fails
   * nothing and this page stays empty while nothing has been mirrored at all. Without this
   * sentence the empty state is actively misleading in exactly the deployment that is most broken.
   */
  const html = render(report({ failures: [] }));
  expect(html).toContain("A run that never started");
  expect(html).toContain("does not mean the mirror has run");
});

/* -------------------------------------------------------------------------- */
/* Hostile content                                                            */
/* -------------------------------------------------------------------------- */

test("a hostile title, path and space key are escaped and stay inside guarded elements", () => {
  const html = render(
    report({
      failures: [
        failure({
          pageTitle: INJECTION,
          spaceKey: HOSTILE,
          path: HOSTILE,
          pagePath: HOSTILE,
          pageSpaceKey: HOSTILE,
        }),
      ],
    }),
  );

  // React escaped it: the literal tag is not in the markup, and the text is.
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;/p&gt;&lt;script&gt;");
  // The 300-character token is inside `.mir-file`, which carries `overflow-wrap: anywhere`.
  expect(html).toContain(`class="mir-file">${HOSTILE}/${HOSTILE}.md<`);
  // And the link is per-segment encoded, so a path with a `#` or a space cannot break it —
  // `pageHistoryHref`'s rule, which three link sites have each had to learn.
  expect(html).toContain(`href="/${HOSTILE}/-/history/${HOSTILE}"`);
});

test("git's stderr is painted as text inside the guarded element, whatever it contains", () => {
  const html = render(
    report({
      failures: [
        failure({
          lastError: `line one\nline two ${INJECTION} ${HOSTILE}`,
        }),
      ],
    }),
  );

  expect(html).not.toContain("<script>");
  expect(html).toContain('class="mir-err"');
  // `.mir-err` carries `pre-wrap` for git's newlines *and* `anywhere` for the argv line that has
  // none; the newline survives into the markup, which is what `pre-wrap` is there to render.
  expect(html).toContain("line one\nline two");
});

test("the component does not redact — that is the query's job, and this pins where it lives", () => {
  /*
   * The negative half of the redaction decision, and it is a real assertion rather than a
   * formality: if the component redacted, a second surface added later — a JSON endpoint, a CLI,
   * an export — could take the raw column by not knowing about this file. `listMirrorFailures` is
   * the one door, and `tests/integration/git-failures.test.ts` is where the token is proven not to
   * come through it.
   */
  const html = render(report({ failures: [failure({ lastError: `token ${TOKEN}` })] }));
  expect(html).toContain(TOKEN);
});
