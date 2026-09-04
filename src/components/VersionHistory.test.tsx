import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VersionHistory } from "./VersionHistory";
import { TITLE_MAX_LENGTH } from "@/lib/drafts/schema";
import type { PageHistory, PageVersionRow } from "@/lib/pages/history";
import { NOT_MIRRORED } from "@/lib/version/labels";
import { MIRROR_FAILURES_PATH } from "@/lib/pages/href";

/**
 * The version history list, rendered.
 *
 * Server-rendered rather than driven in a browser, because the route that renders this reads the
 * database and Playwright's browsers are not installed on this machine — see
 * `Provenance.test.tsx` for the whole argument. `e2e/history.spec.ts` carries the overflow
 * *measurement*, which needs a real layout engine and cannot be done here; what can be done here
 * is everything about what the markup says, including with hostile content in it.
 */

/**
 * A 300-character unbreakable token — `TITLE_MAX_LENGTH`, so it is a title a real publish can
 * store, and the shape that has widened this application's layout six times. `e2e/support.ts`
 * exports the same value as `HOSTILE` for the specs; that module imports Playwright, so it
 * cannot be imported here.
 */
const HOSTILE = "x".repeat(TITLE_MAX_LENGTH);

/** Markup that would escape the document if anything on this page interpolated raw HTML. */
const INJECTION = '</p><script>alert("xss")</script>';

const SHA = "9f2c1ab4d5e6f70819a2b3c4d5e6f7089a1b2c3d";

function row(over: Partial<PageVersionRow> = {}): PageVersionRow {
  return {
    id: `v-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date("2026-03-04T09:30:00Z"),
    status: "CURRENT",
    renamedTo: null,
    authorName: "Aisyah R.",
    gitSha: SHA,
    isPublished: false,
    ...over,
  };
}

function history(over: Partial<PageHistory> = {}): PageHistory {
  return {
    page: {
      id: "p1",
      title: "MQTT contracts",
      path: "architecture/mqtt-contracts",
      status: "CURRENT",
      docType: "DOC",
      isLinkable: true,
      ...over.page,
    },
    rows: over.rows ?? [row({ isPublished: true })],
    total: over.total ?? 1,
    truncated: over.truncated ?? false,
    mirror: over.mirror ?? { queued: 0, failed: 0 },
  };
}

const render = (h: PageHistory) =>
  renderToStaticMarkup(<VersionHistory spaceKey="engineering" history={h} />);

/* -------------------------------------------------------------------------- */
/* What a row says                                                            */
/* -------------------------------------------------------------------------- */

test("a version row carries its date, author, status and content sha", () => {
  const html = render(
    history({
      rows: [
        row({
          createdAt: new Date("2026-03-04T09:30:00Z"),
          authorName: "Aisyah R.",
          status: "CURRENT",
          isPublished: true,
        }),
      ],
    }),
  );

  expect(html).toContain("4 Mar 2026");
  expect(html).toContain("Aisyah R.");
  expect(html).toContain("CURRENT");
  // Short form on the page, whole value in the tooltip.
  expect(html).toContain(`title="${SHA}"`);
  expect(html).toContain(">9f2c1ab4d5<");
  expect(html).not.toMatch(new RegExp(`>${SHA}<`));
});

/**
 * A time and not only a date, and this is the test that says why the format exists: two versions
 * published on one day are the ordinary case, and three rows all reading `4 Mar 2026` would make
 * the list look arbitrarily ordered.
 */
test("two versions from the same day are distinguishable", () => {
  const html = render(
    history({
      rows: [
        row({ createdAt: new Date("2026-03-04T14:05:00Z") }),
        row({ createdAt: new Date("2026-03-04T09:30:00Z") }),
      ],
      total: 2,
    }),
  );
  const times = [...html.matchAll(/4 Mar 2026, (\d\d:\d\d)/g)].map((m) => m[1]);
  expect(times).toHaveLength(2);
  expect(times[0]).not.toBe(times[1]);
});

test("the rows are painted in the order they are given, newest first", () => {
  const html = render(
    history({
      rows: [
        row({ authorName: "Newest author" }),
        row({ authorName: "Oldest author" }),
      ],
      total: 2,
    }),
  );
  expect(html.indexOf("Newest author")).toBeLessThan(html.indexOf("Oldest author"));
});

test("the published version is marked, and the others are not", () => {
  const html = render(
    history({
      rows: [row({ isPublished: true }), row({ isPublished: false })],
      total: 2,
    }),
  );
  expect([...html.matchAll(/published now/g)]).toHaveLength(1);
});

test("a version published under a different title says so", () => {
  const html = render(
    history({ rows: [row({ renamedTo: "Topic naming (old)" })] }),
  );
  expect(html).toContain("Topic naming (old)");
});

/* -------------------------------------------------------------------------- */
/* Another row's data, on this page                                           */
/* -------------------------------------------------------------------------- */

/**
 * The landmine this surface arrives with: a version list paints text somebody else typed. An
 * author name comes from the OIDC profile and a version's title from whoever published it, so
 * Phase 4's lesson applies unchanged — "it is only my own text" stopped being an argument the
 * moment a list showed a space's other members' rows.
 */
test("a hostile title and a hostile author name are rendered as text, not as markup", () => {
  const html = render(
    history({
      page: { title: INJECTION } as PageHistory["page"],
      rows: [row({ authorName: INJECTION, renamedTo: INJECTION })],
    }),
  );

  // React escapes; the assertion is that nothing on this page opts out of it with
  // `dangerouslySetInnerHTML`. `DocBody` is the one component in the product that does, and it
  // is safe only because `renderMarkdown` sanitises.
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  // And the text is actually present — an escaping assertion that passes because the value was
  // dropped altogether proves nothing.
  expect(html).toContain("alert(&quot;xss&quot;)");
});

test("a 300-character token is present in full, for the layout guard to measure", () => {
  const html = render(
    history({
      page: { title: HOSTILE } as PageHistory["page"],
      rows: [row({ authorName: HOSTILE, renamedTo: HOSTILE })],
    }),
  );
  // Three separate sites, each of which is user-controlled text outside `.body`: the lead's page
  // name, the author, and the renamed-to title. All three are in the markup, which is what makes
  // `e2e/history.spec.ts`'s `measureOverflow` a measurement of something.
  expect([...html.matchAll(new RegExp(HOSTILE, "g"))]).toHaveLength(3);
});

/* -------------------------------------------------------------------------- */
/* The three reasons a sha can be null                                        */
/* -------------------------------------------------------------------------- */

test("an unmirrored version says so, and the page explains what that means", () => {
  const html = render(history({ rows: [row({ gitSha: null })] }));
  expect(html).toContain(NOT_MIRRORED);
  expect(html).toContain("published before this site mirrored to git");
});

/**
 * The non-vacuity companion for the test above: the explanation is not a standing disclaimer, so
 * "the page explains it" has to be false when there is nothing to explain. A note rendered under
 * a list where every row has a sha is the kind of sentence a reader learns to skip — and it would
 * be the only sentence on the page that could never be wrong.
 */
test("the explanation is absent when every version is mirrored", () => {
  const html = render(history({ rows: [row({ gitSha: SHA })] }));
  expect(html).not.toContain("published before this site mirrored to git");
  expect(html).not.toContain(NOT_MIRRORED);
});

test("a failed mirror job is said out loud, and the publish is said to stand", () => {
  const html = render(history({ mirror: { queued: 0, failed: 1 } }));
  expect(html).toContain("mirror is stuck");
  // The spec's central claim, on the surface a reader is looking at: documentation does not go
  // down because a git host does.
  expect(html).toContain("everything here is published and readable");
});

test("a queued mirror reads as waiting rather than as broken", () => {
  const html = render(history({ mirror: { queued: 2, failed: 0 } }));
  expect(html).toContain("2 changes to this page are");
  expect(html).not.toContain("stuck");
});

test("one queued change is one sentence, not a count of one", () => {
  const html = render(history({ mirror: { queued: 1, failed: 0 } }));
  expect(html).toContain("One change to this page is");
});

/**
 * `failed` outranks `queued` rather than being listed beside it, and this is the assertion that
 * pins the reason: Task 6's barrier means a failed job blocks every later job for the same page,
 * so anything queued behind it is queued *because* of the failure. Two sentences would invite a
 * reader to wait for something that is not coming.
 */
test("a page that is both wedged and backed up is described as wedged", () => {
  const html = render(history({ mirror: { queued: 3, failed: 1 } }));
  expect(html).toContain("mirror is stuck");
  expect(html).not.toContain("3 changes to this page are");
});

test("nothing is said about the mirror when there is nothing to say", () => {
  const html = render(history({ mirror: { queued: 0, failed: 0 } }));
  expect(html).not.toContain("stuck");
  expect(html).not.toContain("still queued");
});

/* -------------------------------------------------------------------------- */
/* The two real edge cases                                                    */
/* -------------------------------------------------------------------------- */

test("a page with exactly one version renders a list of one and no truncation note", () => {
  const html = render(history({ rows: [row({ isPublished: true })], total: 1 }));
  expect([...html.matchAll(/<li>/g)]).toHaveLength(1);
  expect(html).not.toContain("most recent of");
});

test("a page that was never published has an empty history and an inert title", () => {
  const html = render(
    history({
      page: { title: "Draft only", isLinkable: false } as PageHistory["page"],
      rows: [],
      total: 0,
    }),
  );
  expect(html).toContain("has never been published");
  // No link, for the reason the nav rail and the breadcrumbs render an unpublished ancestor as
  // text: the reader route requires a published version, so the link would 404 for everyone.
  expect(html).not.toContain('href="/engineering/');
  expect(html).toContain("Draft only");
});

test("a truncated list says how short it is", () => {
  const html = render(
    history({ rows: [row(), row()], total: 240, truncated: true }),
  );
  expect(html).toContain("Showing the 2 most recent of 240 versions");
});

test("the page name links back to the page, encoded per segment", () => {
  const html = render(
    history({
      page: { path: "architecture/mqtt contracts" } as PageHistory["page"],
    }),
  );
  expect(html).toContain('href="/engineering/architecture/mqtt%20contracts"');
});

/* -------------------------------------------------------------------------- */
/* The affordance into Phase 5 Task 8's failures page                         */
/* -------------------------------------------------------------------------- */

test("a stuck mirror offers the failures page when the viewer may read it", () => {
  const html = renderToStaticMarkup(
    <VersionHistory
      spaceKey="engineering"
      history={history({ mirror: { queued: 0, failed: 1 } })}
      failuresHref={MIRROR_FAILURES_PATH}
    />,
  );
  expect(html).toContain('href="/-/mirror"');
  expect(html).toContain("What failed");
});

test("the link is absent for a viewer who cannot read it, and absent when nothing is stuck", () => {
  /*
   * Two absences and one shared companion. `/-/mirror` is super-admin only and 404s for everybody
   * else, so a link rendered unconditionally would be a dead end shown to precisely the readers
   * who cannot follow it — and a link on a healthy page would point at a list with nothing on it.
   * The route decides the first; the notice's own condition decides the second.
   */
  const notAdmin = render(history({ mirror: { queued: 0, failed: 1 } }));
  expect(notAdmin).toContain("mirror is stuck");
  expect(notAdmin).not.toContain("/-/mirror");

  const nothingWrong = renderToStaticMarkup(
    <VersionHistory
      spaceKey="engineering"
      history={history({ mirror: { queued: 0, failed: 0 } })}
      failuresHref={MIRROR_FAILURES_PATH}
    />,
  );
  expect(nothingWrong).not.toContain("/-/mirror");
});
