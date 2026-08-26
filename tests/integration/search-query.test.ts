import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage, type PublishResult } from "@/lib/pages/publish";
import { deletePage } from "@/lib/pages/delete";
import { inOneRequest } from "@/lib/audit/log";
import {
  MAX_SEARCH_RESULTS,
  RETIRED_RANK_FACTOR,
  search,
  segmentsOf,
  type SearchHit,
  type SearchResult,
} from "@/lib/search/query";
import { RETIRED_STATUSES } from "@/lib/pages/transition";
import type { DocStatus, DocType } from "@prisma/client";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Task 3's query, against the real database — the only place it can be tested.
 *
 * Every claim here is a claim about **SQL**: a `tsvector` scanned through a `GIN` index, a rank
 * multiplied down for a retired status, a headline cut out of stored text. None of it is
 * observable from application code, and a stubbed client would agree with any of it.
 *
 * The rule this file is written to, from the plan: **test the space filter with a page whose text
 * certainly matches, in a space the viewer cannot read.** A test that searches for a word no page
 * contains proves nothing at all — it passes over a query with no permission predicate, no
 * soft-delete filter and no index. So every exclusion test here has a **non-vacuity companion**
 * showing the same query finding the same page for someone, or at some moment, that it should.
 */

/** Distinctive words, one per band, so a lexeme landing in the wrong place is visible. */
const TITLE_WORD = "bunkering";
const HEADING_WORD = "reconciliation";
const BODY_WORD = "kerosene";

const documentFor = (heading: string, body: string) =>
  [`## ${heading}`, "", body, ""].join("\n");

/** A body long enough that `ts_headline` has a real window to choose. */
const bodyAbout = (word: string) =>
  `Every ${word} delivery is weighed at the gantry before the tanker leaves the depot, ` +
  "and the duty officer signs the ledger against the meter reading.";

async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const stranger = await db.user.create({
    data: { email: "stranger@example.com", name: "Nobody" },
  });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });

  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: aisyah.id, role: "EDITOR" },
  });
  // Aisyah edits in `handbook` too. Readability is not what this buys — `handbook` is
  // `ALL_STAFF`, so everyone signed in can read it — it is the EDIT permission `publishPage`
  // requires, which membership is the only source of.
  await db.spaceMembership.create({
    data: { spaceId: handbook.id, userId: aisyah.id, role: "EDITOR" },
  });

  // `memberships` names the real row: `can()` reads the in-memory list while `readableSpace`
  // filters on the `SpaceMembership` row, deliberately (PROGRESS).
  const asAisyah: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [
      { spaceId: engineering.id, role: "EDITOR" },
      { spaceId: handbook.id, role: "EDITOR" },
    ],
  };
  /** A member of nothing. `handbook` is `ALL_STAFF`, so they can still read one space. */
  const asStranger: Viewer = { id: stranger.id, isSuperAdmin: false, memberships: [] };
  /** A super admin who belongs to nothing — §8's audited case. */
  const asRoot: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };

  /** A page with a draft on it, not yet published. Every field distinguishable. */
  const drafted = async (args: {
    spaceId?: string;
    slug: string;
    title: string;
    markdown: string;
    docType?: DocType;
  }) => {
    const page = await db.page.create({
      data: {
        spaceId: args.spaceId ?? engineering.id,
        slug: args.slug,
        path: args.slug,
        title: args.title,
        docType: args.docType ?? "DOC",
        status: "DRAFT",
        createdById: aisyah.id,
      },
      select: { id: true, path: true, title: true },
    });
    await db.pageDraft.create({
      data: {
        pageId: page.id,
        title: args.title,
        markdown: args.markdown,
        updatedById: aisyah.id,
      },
    });
    return page;
  };

  /** Drafted and published in one step, which is how nearly every fixture below wants it. */
  const live = async (args: Parameters<typeof drafted>[0]) => {
    const page = await drafted(args);
    published(await publishPage(asAisyah, page.id));
    return page;
  };

  return { engineering, handbook, aisyah, asAisyah, asStranger, asRoot, drafted, live };
}

/** Narrows to the success branch, failing with the actual result if it is not one. */
function published(result: PublishResult) {
  if (!result.ok) throw new Error(`expected a publish, got ${JSON.stringify(result)}`);
  return result.page;
}

/** Narrows a `SearchResult` to its hits, failing with the refusal if there are none to have. */
function hitsOf(result: SearchResult): SearchHit[] {
  if (!result.ok) throw new Error(`expected a search, got ${JSON.stringify(result)}`);
  return result.hits;
}

/** Titles in rank order — what almost every assertion here is really about. */
const titlesOf = (result: SearchResult) => hitsOf(result).map((hit) => hit.title);

/** A snippet flattened back to plain text, so prose can be asserted without the marking. */
const textOf = (hit: SearchHit) => hit.snippet.map((segment) => segment.text).join("");

/** Just the matched runs of a snippet. */
const matchedIn = (hit: SearchHit) =>
  hit.snippet.filter((segment) => segment.match).map((segment) => segment.text);

/**
 * Retires a page with a **bare `UPDATE`**, not through publish.
 *
 * §6.4's demotion is about `Page.status`, and how the page arrived at that status is Phase 3's
 * question, not this module's. Going through `publishPage` would mean a frontmatter round trip
 * and a doc type whose vocabulary reaches the status — three moving parts between the fixture
 * and the one column the query reads.
 *
 * It is also the write Task 2 pinned: `status` is a filter and not a vector input, so the vector
 * comes out **byte-identical** and the page stays exactly as findable as it was. If this fixture
 * silently un-indexed the page, every demotion test below would pass for the wrong reason — which
 * is why each of them asserts the retired page is still *in* the results.
 */
const retire = (pageId: string, status: DocStatus = "ARCHIVED") =>
  db.page.update({ where: { id: pageId }, data: { status }, select: { id: true } });

// ── Finding a page, and what a snippet is ─────────────────────────────────────────────────

test("a body word finds the page, and the snippet marks the word it matched", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  const result = await search(f.asAisyah, { q: BODY_WORD });
  const hits = hitsOf(result);

  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    spaceKey: "engineering",
    spaceName: "Engineering",
    path: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    docType: "DOC",
    status: "CURRENT",
    isRetired: false,
  });
  expect(hits[0]!.rank).toBeGreaterThan(0);
  expect(result).toMatchObject({ truncated: false });

  // The snippet is prose from the body, with the matched word marked — and the marking is a
  // property of a segment, never markup in a string. Both halves matter: a snippet that is only
  // the matched word is useless, and a snippet with nothing marked cannot be highlighted.
  expect(matchedIn(hits[0]!)).toEqual([BODY_WORD]);
  expect(textOf(hits[0]!)).toContain("weighed at the gantry");
});

test("a page whose whole body is one Mermaid diagram has no snippet, and is still found", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: ["```mermaid", "C4Context", `  Person(cashier, "${BODY_WORD}")`, "```", ""].join(
      "\n",
    ),
  });

  const hits = hitsOf(await search(f.asAisyah, { q: TITLE_WORD }));

  expect(hits).toHaveLength(1);
  // Task 2 established that `searchText` is legitimately `""` here; `ts_headline` over `''`
  // returns `''`, and an empty segment list is the honest answer rather than a failure. A caller
  // shows the path instead — it can tell this apart from an unmarked snippet, because one is
  // empty and one is not.
  expect(hits[0]!.snippet).toEqual([]);
  // Non-vacuity for the emptiness: the diagram's label prose really is not indexed either, so
  // the page is findable by its title and by nothing else.
  expect(hitsOf(await search(f.asAisyah, { q: BODY_WORD }))).toEqual([]);
});

test("a title match on a page with prose gets an unmarked opening as its snippet", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  const hits = hitsOf(await search(f.asAisyah, { q: TITLE_WORD }));

  expect(hits).toHaveLength(1);
  // The term is absent from the body, so Postgres returns the opening of the text with nothing
  // marked. That is a page description and a good one; nothing special-cases it.
  expect(matchedIn(hits[0]!)).toEqual([]);
  expect(textOf(hits[0]!)).toContain(HEADING_WORD);
});

/**
 * A heading match gets a **marked** snippet, which is the double count's whole benefit.
 *
 * Task 3 measured that the heading double-count at `B` and `C` changes no ordering (the numbers
 * are in the module docstring), so the trigger is left alone. This test guards the other half of
 * that decision: heading text is in `searchText`, which is the only text `ts_headline` can quote
 * from, so a match in a section title has prose to be highlighted in.
 *
 * Apply the de-duplication in the **strip** instead of in the trigger — which Task 1 and Task 2
 * both warn against — and this fails: the snippet loses its marked run and a heading match reads
 * as a page whose snippet has nothing to do with the query.
 */
test("a heading match is marked in the snippet, not just counted in the rank", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: "Depot procedure",
    markdown: documentFor(
      `${HEADING_WORD} rules`,
      "The duty officer signs the ledger against the meter reading at the gantry.",
    ),
  });

  const hits = hitsOf(await search(f.asAisyah, { q: HEADING_WORD }));
  expect(hits).toHaveLength(1);
  expect(matchedIn(hits[0]!)).toEqual([HEADING_WORD]);
});

// ── The space filter: the one that matters most ───────────────────────────────────────────

test("a non-member does not find a page whose text certainly matches", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  // The non-vacuity companion, and it is the whole point of this test: the page exists, it is
  // published, and the query certainly matches it — for a member. Without this line the
  // expectation below passes over a search that is broken in every possible way.
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD }))).toEqual([
    `The ${TITLE_WORD} log`,
  ]);

  expect(hitsOf(await search(f.asStranger, { q: BODY_WORD }))).toEqual([]);
  // And not by title either — the vector's `A` band is not a way around the space filter.
  expect(hitsOf(await search(f.asStranger, { q: TITLE_WORD }))).toEqual([]);
});

test("an ALL_STAFF space is searchable by someone who belongs to nothing", async () => {
  const f = await fixture();
  await f.live({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: "Welcome aboard",
    markdown: documentFor("Getting started", bodyAbout(BODY_WORD)),
  });

  const hits = hitsOf(await search(f.asStranger, { q: BODY_WORD }));
  expect(hits.map((hit) => hit.spaceKey)).toEqual(["handbook"]);
});

test("a super admin finds pages in a members-only space they do not belong to", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  expect(titlesOf(await search(f.asRoot, { q: BODY_WORD }))).toEqual([
    `The ${TITLE_WORD} log`,
  ]);
});

test("the spaceKey filter narrows, and an unreadable key is the same answer as an unknown one", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `Engineering ${TITLE_WORD}`,
    markdown: documentFor("Depot", bodyAbout(BODY_WORD)),
  });
  await f.live({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: `Handbook ${TITLE_WORD}`,
    markdown: documentFor("Depot", bodyAbout(BODY_WORD)),
  });

  // Unfiltered, a member sees both.
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD })).sort()).toEqual([
    `Engineering ${TITLE_WORD}`,
    `Handbook ${TITLE_WORD}`,
  ]);
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD, spaceKey: "handbook" }))).toEqual([
    `Handbook ${TITLE_WORD}`,
  ]);

  // A stranger filtering to a space they cannot read gets the same answer as one filtering to a
  // space that does not exist — the 404-not-403 rule, applied to a filter.
  expect(
    hitsOf(await search(f.asStranger, { q: BODY_WORD, spaceKey: "engineering" })),
  ).toEqual([]);
  expect(hitsOf(await search(f.asStranger, { q: BODY_WORD, spaceKey: "no-such" }))).toEqual([]);
  // Non-vacuity: the same stranger, same query, a space they can read.
  expect(titlesOf(await search(f.asStranger, { q: BODY_WORD, spaceKey: "handbook" }))).toEqual([
    `Handbook ${TITLE_WORD}`,
  ]);
});

// ── Unpublished and soft-deleted never appear ───────────────────────────────────────────

test("an unpublished page does not appear in a search for its own title", async () => {
  const f = await fixture();
  const page = await f.drafted({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  // §13 attributes this exclusion to the index and Task 2 measured that wrong: the `Page` row is
  // real and carries a title-only vector, which matches this query. The `WHERE` clause is the
  // only thing hiding it, which is exactly why the trigger was left indexing drafts.
  expect(hitsOf(await search(f.asAisyah, { q: TITLE_WORD }))).toEqual([]);

  // Non-vacuity, from both sides. The vector really is there and really does match…
  const matches = await db.$queryRaw<{ matched: boolean }[]>`
    SELECT "searchVector" @@ websearch_to_tsquery('english', ${TITLE_WORD}) AS matched
      FROM "Page" WHERE "id" = ${page.id}`;
  expect(matches[0]).toEqual({ matched: true });
  // …and publishing the very same page makes the very same search find it.
  published(await publishPage(f.asAisyah, page.id));
  expect(titlesOf(await search(f.asAisyah, { q: TITLE_WORD }))).toEqual([
    `The ${TITLE_WORD} log`,
  ]);
});

test("a soft-deleted page disappears from results, having been in them", async () => {
  const f = await fixture();
  const page = await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  // The non-vacuity companion is the "before": a delete that removes a page nothing could find
  // proves nothing about the filter.
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD }))).toHaveLength(1);

  const deleted = await deletePage(f.asAisyah, page.id);
  expect(deleted.ok).toBe(true);

  expect(hitsOf(await search(f.asAisyah, { q: BODY_WORD }))).toEqual([]);
  // The row and its vector survive the soft delete — a restore must not need a reindex. So the
  // query is the only thing hiding it here too.
  const rows = await db.$queryRaw<{ matched: boolean }[]>`
    SELECT "searchVector" @@ websearch_to_tsquery('english', ${BODY_WORD}) AS matched
      FROM "Page" WHERE "id" = ${page.id}`;
  expect(rows[0]).toEqual({ matched: true });
});

// ── Ranking, and §6.4's demotion ─────────────────────────────────────────────────────────

test("a live page outranks a retired page that matches equally well", async () => {
  const f = await fixture();
  const body = bodyAbout(BODY_WORD);
  await f.live({ slug: "live-page", title: "Live procedure", markdown: documentFor("A", body) });
  const old = await f.live({
    slug: "old-page",
    title: "Old procedure",
    markdown: documentFor("A", body),
  });
  await retire(old.id);

  const hits = hitsOf(await search(f.asAisyah, { q: BODY_WORD }));

  // Demoted, not filtered — §6.4 keeps it in results.
  expect(hits.map((hit) => hit.title)).toEqual(["Live procedure", "Old procedure"]);
  expect(hits[1]).toMatchObject({ status: "ARCHIVED", isRetired: true });
  expect(hits[1]!.rank).toBeLessThan(hits[0]!.rank);
  // The multiplier is the mechanism, so pin it as one rather than as an inequality that any
  // demotion would satisfy.
  expect(hits[1]!.rank).toBeCloseTo(hits[0]!.rank * RETIRED_RANK_FACTOR, 6);
});

test("a retired page that matches far better still outranks a live one", async () => {
  const f = await fixture();
  // The retired page matches in its TITLE (weight A); the live one only in its body (weight C).
  const retired = await f.live({
    slug: "old-page",
    title: `The ${BODY_WORD} standard`,
    markdown: documentFor("Scope", "Superseded by the new depot procedure."),
  });
  await retire(retired.id, "SUPERSEDED");
  await f.live({
    slug: "live-page",
    title: "Depot procedure",
    markdown: documentFor("Scope", bodyAbout(BODY_WORD)),
  });

  const hits = hitsOf(await search(f.asAisyah, { q: BODY_WORD }));

  // A thumb on the scale, not a filter. Set `RETIRED_RANK_FACTOR` to 0 and this inverts — which
  // is the mutant this test exists to kill, because the "live first" test above passes for a
  // factor of 0 just as happily.
  expect(hits.map((hit) => hit.title)).toEqual([
    `The ${BODY_WORD} standard`,
    "Depot procedure",
  ]);
  expect(hits[0]).toMatchObject({ isRetired: true });
});

test("every retired status is demoted, not just the one the fixtures use", async () => {
  const f = await fixture();
  const body = bodyAbout(BODY_WORD);
  const live = await f.live({
    slug: "live-page",
    title: "Live procedure",
    markdown: documentFor("A", body),
  });

  // The list is imported, never retyped: a vocabulary change that adds a way to retire a
  // document cannot leave the demotion behind. `RETIRED_STATUSES` is non-empty by its own tests.
  for (const status of RETIRED_STATUSES) {
    const page = await f.live({
      slug: `page-${status.toLowerCase()}`,
      title: `Procedure ${status}`,
      markdown: documentFor("A", body),
    });
    await retire(page.id, status);

    const hits = hitsOf(await search(f.asAisyah, { q: BODY_WORD }));
    const one = hits.find((hit) => hit.pageId === page.id);
    const reference = hits.find((hit) => hit.pageId === live.id);
    expect(one, `${status} vanished from results instead of being demoted`).toBeDefined();
    expect(one!.isRetired).toBe(true);
    expect(one!.rank).toBeCloseTo(reference!.rank * RETIRED_RANK_FACTOR, 6);
    await db.page.delete({ where: { id: page.id } });
  }
});

test("two identical searches return the same order", async () => {
  const f = await fixture();
  const body = bodyAbout(BODY_WORD);
  // Three pages with identical text, so `ts_rank` cannot separate them and only the tiebreak can.
  for (const slug of ["c-page", "a-page", "b-page"]) {
    await f.live({ slug, title: `Procedure ${slug}`, markdown: documentFor("A", body) });
  }

  const first = titlesOf(await search(f.asAisyah, { q: BODY_WORD }));
  const again = titlesOf(await search(f.asAisyah, { q: BODY_WORD }));
  expect(first).toHaveLength(3);
  expect(again).toEqual(first);
});

// ── What a person types ──────────────────────────────────────────────────────────────────

test("an empty query is not a search, and says so without touching the index", async () => {
  const f = await fixture();
  await expect(search(f.asAisyah, { q: "" })).resolves.toEqual({
    ok: false,
    reason: "empty-query",
  });
  await expect(search(f.asAisyah, { q: "   " })).resolves.toEqual({
    ok: false,
    reason: "empty-query",
  });
});

test("a query with no searchable term is a different answer from no results", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  // `websearch_to_tsquery` reduces each of these to an empty `tsquery`: punctuation, a lone
  // exclusion, and a word that is nothing but stopword and apostrophe. Saying "no results for
  // `...`" would be a lie by implication — there was nothing to look for.
  for (const q of ["...", "-only", "&&&", "'"]) {
    await expect(search(f.asAisyah, { q })).resolves.toEqual({
      ok: false,
      reason: "no-terms",
    });
  }

  // A real term that matches nothing is the third sentence, and it is `ok`.
  await expect(search(f.asAisyah, { q: "helicopter" })).resolves.toEqual({
    ok: true,
    hits: [],
    truncated: false,
  });
});

test("quotes and exclusions do what a person means, and never throw", async () => {
  const f = await fixture();
  await f.live({
    slug: "together",
    title: "Adjacent words",
    markdown: documentFor("Depot", "The fuel delivery arrives at dawn with the kerosene."),
  });
  await f.live({
    slug: "apart",
    title: "Separated words",
    markdown: documentFor("Depot", "The fuel is metered and the delivery is signed for."),
  });

  // Unquoted: both, because both contain both words.
  expect(titlesOf(await search(f.asAisyah, { q: "fuel delivery" })).sort()).toEqual([
    "Adjacent words",
    "Separated words",
  ]);
  // Quoted: a phrase, so only the page where the words are adjacent.
  expect(titlesOf(await search(f.asAisyah, { q: '"fuel delivery"' }))).toEqual([
    "Adjacent words",
  ]);
  // Excluded.
  expect(titlesOf(await search(f.asAisyah, { q: `fuel -${BODY_WORD}` }))).toEqual([
    "Separated words",
  ]);
  // `OR`, which `websearch_to_tsquery` understands as a word rather than as an operator error.
  expect(titlesOf(await search(f.asAisyah, { q: `${BODY_WORD} OR metered` })).sort()).toEqual([
    "Adjacent words",
    "Separated words",
  ]);
  // And the shapes that would make `to_tsquery` raise a syntax error. The contract is that
  // nothing here throws; what they match is not the point.
  for (const q of ['fuel & | ! ( ) "', "a <-> b", ":*", '"unclosed', "--"]) {
    await expect(search(f.asAisyah, { q })).resolves.toMatchObject({});
  }
});

// ── The other two filters ───────────────────────────────────────────────────────────────

test("the docType filter narrows to one type", async () => {
  const f = await fixture();
  const body = bodyAbout(BODY_WORD);
  await f.live({ slug: "a-doc", title: "A doc", markdown: documentFor("H", body) });
  await f.live({
    slug: "a-runbook",
    title: "A runbook",
    markdown: documentFor("H", body),
    docType: "RUNBOOK",
  });

  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD })).sort()).toEqual([
    "A doc",
    "A runbook",
  ]);
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD, docType: "RUNBOOK" }))).toEqual([
    "A runbook",
  ]);
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD, docType: "ADR" }))).toEqual([]);
});

test("the status filter isolates retired pages, and excludes them", async () => {
  const f = await fixture();
  const body = bodyAbout(BODY_WORD);
  await f.live({ slug: "live-page", title: "Live procedure", markdown: documentFor("H", body) });
  const old = await f.live({
    slug: "old-page",
    title: "Old procedure",
    markdown: documentFor("H", body),
  });
  await retire(old.id);

  // §13: "the status filter isolates or excludes them". Both readings fall out of one exact
  // match, which is why there is no separate retired switch.
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD, status: "ARCHIVED" }))).toEqual([
    "Old procedure",
  ]);
  expect(titlesOf(await search(f.asAisyah, { q: BODY_WORD, status: "CURRENT" }))).toEqual([
    "Live procedure",
  ]);
});

// ── The cap ─────────────────────────────────────────────────────────────────────────────

test("more matches than the cap are truncated, and the flag says so", async () => {
  const f = await fixture();
  const aisyah = await db.user.findUniqueOrThrow({
    where: { email: "aisyah@example.com" },
    select: { id: true },
  });
  const space = f.engineering;
  const body = bodyAbout(BODY_WORD);

  // Written straight in rather than published one at a time: this test is about `LIMIT` and the
  // one extra row, and fifty-two publish transactions would pay for a property none of them are
  // being asked about. The vector still comes from the trigger, which is what makes the rows real
  // as far as the query is concerned.
  for (let n = 0; n < MAX_SEARCH_RESULTS + 2; n += 1) {
    const page = await db.page.create({
      data: {
        spaceId: space.id,
        slug: `page-${n}`,
        path: `page-${n}`,
        title: `Procedure ${n}`,
        status: "CURRENT",
        createdById: aisyah.id,
      },
      select: { id: true },
    });
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: `Procedure ${n}`,
        markdown: body,
        searchText: body,
        status: "CURRENT",
        authorId: aisyah.id,
      },
      select: { id: true },
    });
    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
      select: { id: true },
    });
  }

  const result = await search(f.asAisyah, { q: BODY_WORD });
  expect(result).toMatchObject({ truncated: true });
  expect(hitsOf(result)).toHaveLength(MAX_SEARCH_RESULTS);
});

// ── Snippets are text, and cannot become markup ─────────────────────────────────────────

test("segmentsOf keeps every character, balanced or not", () => {
  const START = "\u0002";
  const STOP = "\u0003";

  expect(segmentsOf("")).toEqual([]);
  expect(segmentsOf("plain text")).toEqual([{ text: "plain text", match: false }]);
  expect(segmentsOf(`a ${START}b${STOP} c`)).toEqual([
    { text: "a ", match: false },
    { text: "b", match: true },
    { text: " c", match: false },
  ]);
  // A match at the very start produces no empty leading run.
  expect(segmentsOf(`${START}b${STOP} c`)).toEqual([
    { text: "b", match: true },
    { text: " c", match: false },
  ]);
  // Unbalanced: the remainder is a matched run rather than text that vanished. No stored
  // document can contain either delimiter, so this is about the failure being harmless.
  expect(segmentsOf(`a ${START}b`)).toEqual([
    { text: "a ", match: false },
    { text: "b", match: true },
  ]);
  expect(segmentsOf(`a ${STOP}b`)).toEqual([{ text: `a ${STOP}b`, match: false }]);
});

test("angle brackets in a document reach the snippet as text, not as markup", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: "Comparisons",
    markdown: documentFor(
      "Limits",
      `A reading of a < b is fine, and <script>alert(1)</script> is prose about ${BODY_WORD}.`,
    ),
  });

  const hits = hitsOf(await search(f.asAisyah, { q: BODY_WORD }));
  expect(hits).toHaveLength(1);
  // `a < b` survives verbatim — the snippet is a string of text runs, and nothing in this
  // pipeline produces or consumes markup. The `<script>` element is gone long before here:
  // `searchTextOf` drops HTML nodes, which is why only its text content could ever appear.
  expect(textOf(hits[0]!)).toContain("a < b");
  expect(matchedIn(hits[0]!)).toEqual([BODY_WORD]);
});

// ── §8's super-admin trace ──────────────────────────────────────────────────────────────

test("a super admin's search into a space they do not belong to is audited, once", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });
  await f.live({
    spaceId: f.handbook.id,
    slug: "welcome",
    title: "Welcome aboard",
    markdown: documentFor("Getting started", bodyAbout(BODY_WORD)),
  });

  await inOneRequest(async () => {
    expect(hitsOf(await search(f.asRoot, { q: BODY_WORD }))).toHaveLength(2);
  });

  const rows = await db.auditLog.findMany({
    where: { action: "space.access" },
    select: { actorId: true, spaceId: true, pageId: true },
  });
  // One row, for `engineering` only: `handbook` is `ALL_STAFF`, and reading what everyone can
  // read is not an access worth a row. `needsAccessAudit` owns that decision, not this module.
  expect(rows).toEqual([{ actorId: f.asRoot.id, spaceId: f.engineering.id, pageId: null }]);
});

test("a member searching their own space is not audited", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  await inOneRequest(async () => {
    expect(hitsOf(await search(f.asAisyah, { q: BODY_WORD }))).toHaveLength(1);
  });
  // `space.access` only. The publish above wrote a `page.publish` row of its own, and counting
  // every action would make this assertion a claim about publish rather than about search.
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(0);
});

test("a super admin's search that finds nothing in a space does not audit it", async () => {
  const f = await fixture();
  await f.live({
    slug: "hydrant-ledger",
    title: `The ${TITLE_WORD} log`,
    markdown: documentFor(`${HEADING_WORD} rules`, bodyAbout(BODY_WORD)),
  });

  await inOneRequest(async () => {
    expect(hitsOf(await search(f.asRoot, { q: "helicopter" }))).toEqual([]);
  });
  // The space was enumerated — it had to be, to be searched — but nothing was read out of it.
  // Auditing the enumeration would write a row on every search a super admin ever runs.
  expect(await db.auditLog.count({ where: { action: "space.access" } })).toBe(0);
});
