import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { publishPage, type PublishResult } from "@/lib/pages/publish";
import {
  confirmReview,
  listDueForReview,
  MAX_DUE_ROWS,
  type ConfirmReviewResult,
} from "@/lib/pages/review";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Spec §12's review cycle against the real database — Phase 7 Task 4.
 *
 * ## Why every test here builds its own dates, and why none of them asserts an empty list
 *
 * Measured before this file existed: **all seven seeded pages carry an `ownerId` and a
 * `reviewedAt` of `2026-08-18`**, and today is `2026-09-05`. Under the twelve-month default
 * nothing in the corpus is due, so the list renders empty everywhere — which means "the list is
 * empty" is what a *correct* implementation and a *broken* one both produce, in the dev database
 * and in any fixture that forgets to backdate. An empty-list assertion here would be the purest
 * form of the vacuity this project has now caught four times.
 *
 * So every test names an explicit `now`, and every due fixture has a **not-due companion in the
 * same assertion**. The list assertions are on titles rather than on lengths, so "absent" always
 * comes with something present beside it.
 *
 * ## The second measurement, which chose the rule
 *
 * `reviewedAt` is written by `prisma/seed.ts` and by nothing else. `createPage` sets neither
 * `ownerId` nor `reviewedAt`; neither does `publishPage`. So outside the seed, **every page is
 * unowned and has never been reviewed** — which makes null the ordinary case rather than the edge
 * one, and rules out "null is not due" as a rule (no page this product creates would ever be
 * listed). The module measures a never-reviewed page from `publishedAt` instead, and the tests
 * for that are the pair below.
 */

/** Distinguishable per fixture, so a row attributed to the wrong page is visible in the failure. */
const DUE_TITLE = "Bunkering runbook (overdue)";
const FRESH_TITLE = "Gantry reconciliation (fresh)";

/** The clock every test reasons against. Fixed, so nothing here depends on when it is run. */
const NOW = new Date("2026-09-05T09:00:00.000Z");
/** Comfortably outside a twelve-month interval. */
const LONG_AGO = new Date("2025-06-01T09:00:00.000Z");
/** Comfortably inside it. */
const RECENTLY = new Date("2026-08-01T09:00:00.000Z");

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

async function fixture() {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const budi = await db.user.create({ data: { email: "budi@example.com", name: "Budi S." } });
  const dara = await db.user.create({ data: { email: "dara@example.com", name: "Dara M." } });
  const root = await db.user.create({
    data: { email: "admin@example.com", name: "Fahmi D.", isSuperAdmin: true },
  });
  const nobody = await db.user.create({ data: { email: "stranger@example.com", name: "Nobody" } });

  // Two MEMBERS spaces with disjoint memberships — the shape the discrimination needs — and an
  // ALL_STAFF one so a viewer who belongs to nothing can still read *something*, which is what
  // stops the stranger's assertions being about a viewer with no readable space at all.
  const alpha = await db.space.create({
    data: { key: "alpha", name: "Alpha", initials: "AL", visibility: "MEMBERS" },
  });
  const beta = await db.space.create({
    data: { key: "beta", name: "Beta", initials: "BE", visibility: "MEMBERS" },
  });
  const handbook = await db.space.create({
    data: { key: "handbook", name: "Handbook", initials: "HB", visibility: "ALL_STAFF" },
  });
  await db.spaceMembership.create({
    data: { spaceId: alpha.id, userId: aisyah.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({ data: { spaceId: alpha.id, userId: dara.id, role: "ADMIN" } });
  await db.spaceMembership.create({ data: { spaceId: beta.id, userId: budi.id, role: "EDITOR" } });

  // `memberships` names the real rows: `can()` reads this in-memory list while `readableSpace`
  // filters on the `SpaceMembership` row, deliberately, so a synthetic membership reads nothing.
  const asAisyah: Viewer = {
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: alpha.id, role: "EDITOR" }],
  };
  const asDara: Viewer = {
    id: dara.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: alpha.id, role: "ADMIN" }],
  };
  const asBudi: Viewer = {
    id: budi.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: beta.id, role: "EDITOR" }],
  };
  const asRoot: Viewer = { id: root.id, isSuperAdmin: true, memberships: [] };
  const asStranger: Viewer = { id: nobody.id, isSuperAdmin: false, memberships: [] };

  /**
   * A page in whatever review state the test needs.
   *
   * Written directly rather than through `publishPage`, for the reason `systems-read.test.ts`
   * gives: this file is about a read and a one-column write, and the states it has to construct —
   * a page published fourteen months ago, a page whose `publishedAt` is set and whose
   * `publishedVersionId` is not — are not states the authoring path can be driven into. One test
   * below does drive a real publish end to end, so the two halves are joined somewhere.
   */
  const paged = async (args: {
    spaceId?: string;
    slug: string;
    title: string;
    ownerId?: string | null;
    reviewedAt?: Date | null;
    publishedAt?: Date | null;
    /** `false` leaves `publishedVersionId` null — the page is a draft. */
    published?: boolean;
    /** Sets `publishedVersionId` without `publishedAt`, or the reverse. */
    publishedVersionId?: boolean;
  }) => {
    const spaceId = args.spaceId ?? alpha.id;
    const page = await db.page.create({
      data: {
        spaceId,
        slug: args.slug,
        path: args.slug,
        title: args.title,
        status: "CURRENT",
        createdById: aisyah.id,
        ownerId: args.ownerId === undefined ? aisyah.id : args.ownerId,
        reviewedAt: args.reviewedAt ?? null,
      },
      select: { id: true, path: true, title: true },
    });
    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: args.title,
        markdown: `# ${args.title}\n`,
        status: "CURRENT",
        authorId: aisyah.id,
      },
      select: { id: true },
    });
    const wantsVersion = args.publishedVersionId ?? args.published !== false;
    const wantsTimestamp = args.published !== false;
    await db.page.update({
      where: { id: page.id },
      data: {
        publishedVersionId: wantsVersion ? version.id : null,
        publishedAt: wantsTimestamp ? (args.publishedAt ?? RECENTLY) : null,
      },
    });
    return { ...page, versionId: version.id };
  };

  return {
    alpha,
    beta,
    handbook,
    aisyah,
    budi,
    dara,
    asAisyah,
    asBudi,
    asDara,
    asRoot,
    asStranger,
    paged,
  };
}

const titlesOf = async (viewer: Viewer, spaceId: string, now: Date = NOW) =>
  (await listDueForReview(viewer, spaceId, { now })).rows.map((row) => row.title);

function confirmed(result: ConfirmReviewResult) {
  if (!result.ok) throw new Error(`expected a confirmation, got ${JSON.stringify(result)}`);
  return result;
}

function published(result: PublishResult) {
  if (!result.ok) throw new Error(`expected a publish, got ${JSON.stringify(result)}`);
  return result.page;
}

/**
 * The stored search vector as Postgres renders it — `'bunker':1A 'kerosen':4C`.
 *
 * Raw, and it has to be: `Page.searchVector` is `Unsupported("tsvector")` and is therefore absent
 * from the generated client entirely. `search-vector.test.ts` has the same helper for the same
 * reason; it is four lines and is not shared, because exporting a test helper across two
 * integration files would make each one's failure point at the other.
 */
async function vectorOf(pageId: string): Promise<string> {
  const rows = await db.$queryRaw<{ vector: string | null }[]>`
    SELECT "searchVector"::text AS vector FROM "Page" WHERE "id" = ${pageId}`;
  const vector = rows[0]?.vector;
  if (vector === undefined) throw new Error(`no Page row ${pageId}`);
  if (vector === null) throw new Error(`Page ${pageId} has a NULL search vector`);
  return vector;
}

const reviewedAtOf = async (pageId: string) =>
  (await db.page.findUniqueOrThrow({ where: { id: pageId }, select: { reviewedAt: true } }))
    .reviewedAt;

// ── The list ──────────────────────────────────────────────────────────────────────────────

/**
 * ## The test this task exists for
 *
 * A page confirmed fifteen months ago and a page confirmed a month ago, in one space, asserted in
 * one call. Both fixtures are published, owned and readable; the **only** thing separating them
 * is the date, which is what makes this a test of the interval rather than of anything else.
 *
 * **An empty-list assertion could not have replaced it**, and that is not a stylistic point here:
 * the seeded corpus has nothing due, so `expect(rows).toEqual([])` is what the real database
 * returns today from a correct implementation, from one with the `lt` inverted to `gt`, and from
 * one whose `where` matches nothing at all.
 *
 * **The mutant it kills:** invert the staleness arm to `reviewedAt: { gt: cutoff }` and the two
 * titles swap — `expected [ 'Gantry reconciliation (fresh)' ] to deeply equal
 * [ 'Bunkering runbook (overdue)' ]`. Delete the `OR` entirely and both are listed.
 */
test("a page overdue for review is listed and a recently reviewed one is not", async () => {
  const f = await fixture();
  await f.paged({ slug: "overdue", title: DUE_TITLE, reviewedAt: LONG_AGO });
  await f.paged({ slug: "fresh", title: FRESH_TITLE, reviewedAt: RECENTLY });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE]);
});

/**
 * ## Never reviewed, and the anchor it is measured from
 *
 * The state every page this product creates is in — `createPage` writes no `reviewedAt` — so this
 * is the common case and not the exotic one. The pair is the whole argument: a page published
 * fifteen months ago and never confirmed is due; a page published last month and never confirmed
 * is not.
 *
 * **The mutant it kills:** drop the second `OR` arm (`{ reviewedAt: null, publishedAt: { lt } }`)
 * and the list is empty — which is exactly what the seeded corpus produces anyway, so this test
 * is the only thing standing between that deletion and a green suite. Change the arm's anchor to
 * something that is not `publishedAt` — say `{ reviewedAt: null }` with no date at all — and the
 * fresh page joins the list.
 */
test("a page nobody has ever reviewed is due one interval after it was published", async () => {
  const f = await fixture();
  await f.paged({
    slug: "never-old",
    title: DUE_TITLE,
    reviewedAt: null,
    publishedAt: LONG_AGO,
  });
  await f.paged({
    slug: "never-new",
    title: FRESH_TITLE,
    reviewedAt: null,
    publishedAt: RECENTLY,
  });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE]);
});

/**
 * The two tiers, in order. A page never confirmed comes before one confirmed long ago, and within
 * each tier the oldest is first — which is what the `nulls: "first"` and the `publishedAt`
 * tiebreak are for. Documented as a deliberate two-tier order rather than as an approximation of
 * "most overdue", because it is not one: the third row's effective date is older than the first's.
 */
test("never-reviewed pages are listed first, then the longest since confirmation", async () => {
  const f = await fixture();
  await f.paged({
    slug: "c",
    title: "Confirmed in 2020",
    reviewedAt: new Date("2020-01-01T00:00:00Z"),
  });
  await f.paged({
    slug: "b",
    title: "Confirmed in 2024",
    reviewedAt: new Date("2024-01-01T00:00:00Z"),
  });
  await f.paged({
    slug: "a",
    title: "Never confirmed, published 2023",
    reviewedAt: null,
    publishedAt: new Date("2023-01-01T00:00:00Z"),
  });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([
    "Never confirmed, published 2023",
    "Confirmed in 2020",
    "Confirmed in 2024",
  ]);
});

/**
 * An unpublished page is never due, and the companion is what makes the claim mean something:
 * the same row, published, is due immediately — because its `reviewedAt` was already stale.
 *
 * The rule is `publishedVersionId` **and** `publishedAt`, together, and the two extra fixtures are
 * the Phase 1 lesson stated as rows: a page carrying one column without the other is a page whose
 * link 404s or whose byline has no author, and filtering on either alone admits it.
 */
test("an unpublished page is never due, and half-published columns do not admit one", async () => {
  const f = await fixture();
  const draft = await f.paged({
    slug: "draft",
    title: "A draft nobody published",
    reviewedAt: LONG_AGO,
    published: false,
  });
  // `publishedVersionId` set, `publishedAt` null.
  await f.paged({
    slug: "half-a",
    title: "Pointer without a timestamp",
    reviewedAt: LONG_AGO,
    published: false,
    publishedVersionId: true,
  });
  // `publishedAt` set, `publishedVersionId` null — the rollback shape.
  await f.paged({
    slug: "half-b",
    title: "Timestamp without a pointer",
    reviewedAt: LONG_AGO,
    publishedAt: RECENTLY,
    publishedVersionId: false,
  });
  await f.paged({ slug: "real", title: DUE_TITLE, reviewedAt: LONG_AGO });

  // Non-vacuity in the same call: one page IS listed, so "absent" is about these three rows.
  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE]);

  // And the companion that proves the draft was excluded for being unpublished and not for some
  // other reason: publish it, and it appears.
  await db.page.update({
    where: { id: draft.id },
    data: { publishedVersionId: draft.versionId, publishedAt: RECENTLY },
  });
  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([
    "A draft nobody published",
    DUE_TITLE,
  ]);
});

/**
 * The soft-delete filter, pinned. `visiblePage()` handles it, which is exactly why it needs a
 * test — a filter nobody asserts is a filter somebody deletes.
 *
 * Both directions in one test: the page is listed, then it is not. The first half is the
 * non-vacuity companion, so a `where` that excluded everything would fail here too.
 */
test("a soft-deleted page is not due for review, having been", async () => {
  const f = await fixture();
  const page = await f.paged({ slug: "gone", title: DUE_TITLE, reviewedAt: LONG_AGO });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE]);

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([]);
  expect((await listDueForReview(f.asAisyah, f.alpha.id, { now: NOW })).total).toBe(0);
});

/**
 * The permission predicate, as a **discrimination and not an absence**.
 *
 * Two members, two `MEMBERS` spaces, one overdue page each. Both viewers see something and
 * neither sees the other's — asserted in one test, because a viewer who reads no space gets an
 * empty list from a query with no permission predicate too, which is how Phase 4's non-member
 * search was near-vacuous until it became a discrimination.
 *
 * The second half is the shape a caller could actually get wrong: `listDueForReview` takes a
 * `spaceId`, so asking for *the other space's id* is one typo away. `readableSpace` is what makes
 * that answer nothing rather than everything.
 *
 * **The mutant it kills:** delete `space: readableSpace(viewer)` from `dueScope` and the last two
 * assertions each return the other space's title.
 */
test("two viewers, two spaces, two different due lists", async () => {
  const f = await fixture();
  await f.paged({ slug: "alpha-due", title: DUE_TITLE, reviewedAt: LONG_AGO });
  await f.paged({
    spaceId: f.beta.id,
    slug: "beta-due",
    title: FRESH_TITLE,
    reviewedAt: LONG_AGO,
  });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE]);
  expect(await titlesOf(f.asBudi, f.beta.id)).toEqual([FRESH_TITLE]);

  // Each asking for the other's space: the `spaceId` matches rows, and `readableSpace` is the
  // only thing refusing them.
  expect(await titlesOf(f.asAisyah, f.beta.id)).toEqual([]);
  expect(await titlesOf(f.asBudi, f.alpha.id)).toEqual([]);
});

/**
 * The list and the count come from one `dueScope()` call, which makes the divergence
 * `index-read.ts` has to warn about unrepresentable — but "unrepresentable" is a claim about the
 * code and this is the assertion that the two numbers actually agree, including under the cap.
 *
 * `MAX_DUE_ROWS + 3` pages, so the cut is real: `rows` is capped, `total` is not, and `truncated`
 * says so. A `total` computed from `rows.length` would report the cap as the truth.
 */
test("the count is the whole backlog while the list is capped, and says so", async () => {
  const f = await fixture();
  const count = MAX_DUE_ROWS + 3;
  for (let index = 0; index < count; index += 1) {
    await f.paged({
      slug: `overdue-${index}`,
      title: `Overdue ${index}`,
      // Distinct dates, so the order is total and the cut is deterministic.
      reviewedAt: new Date(Date.UTC(2020, 0, 1 + index)),
    });
  }
  await f.paged({ slug: "fresh", title: FRESH_TITLE, reviewedAt: RECENTLY });

  const due = await listDueForReview(f.asAisyah, f.alpha.id, { now: NOW });
  expect(due.total).toBe(count);
  expect(due.rows).toHaveLength(MAX_DUE_ROWS);
  expect(due.truncated).toBe(true);
  expect(due.rows[0]?.title).toBe("Overdue 0");
  expect(due.rows.map((row) => row.title)).not.toContain(FRESH_TITLE);
});

/**
 * The interval is configuration, so the same corpus answers differently under a different one.
 * This is what §17's variable buys, and it is asserted through the parameter rather than through
 * `process.env`, because the module constant is read at import time.
 */
test("a shorter configured interval makes a page due that a longer one does not", async () => {
  const f = await fixture();
  await f.paged({ slug: "six-months-old", title: DUE_TITLE, reviewedAt: RECENTLY });

  expect(
    (await listDueForReview(f.asAisyah, f.alpha.id, { now: NOW, intervalMonths: 12 })).rows,
  ).toEqual([]);
  const strict = await listDueForReview(f.asAisyah, f.alpha.id, {
    now: NOW,
    intervalMonths: 1,
  });
  expect(strict.rows.map((row) => row.title)).toEqual([DUE_TITLE]);
  expect(strict.intervalMonths).toBe(1);
});

/**
 * §12's subject is the owner, so the row names them — and the null case is the one that matters,
 * because it is what every page this product creates looks like. Typed and returned as null
 * rather than hidden, so the surface can say "Unassigned" rather than printing a gap.
 *
 * It also pins that the owner join is a LEFT one: an inner join would drop every unowned row, and
 * every test above seeds an owner, so nothing else here would have noticed.
 */
test("an unowned page is listed, with a null owner name", async () => {
  const f = await fixture();
  await f.paged({ slug: "orphan", title: DUE_TITLE, ownerId: null, reviewedAt: LONG_AGO });
  await f.paged({ slug: "owned", title: FRESH_TITLE, reviewedAt: LONG_AGO });

  const due = await listDueForReview(f.asAisyah, f.alpha.id, { now: NOW });
  expect(due.rows.map((row) => [row.title, row.ownerName])).toEqual([
    [DUE_TITLE, null],
    [FRESH_TITLE, "Aisyah R."],
  ]);
});

// ── Confirming ────────────────────────────────────────────────────────────────────────────

/**
 * ## The claim this task is measured by
 *
 * §12: *"Confirming a review updates `reviewedAt` without creating a version."* Three things must
 * not move and one must, and all four are in one test because the interesting failure is a
 * confirmation that quietly does something else.
 *
 * The **search vector** is the assertion with the argument behind it. It is not "we did not touch
 * the column": `page_search_vector` is a `BEFORE INSERT OR UPDATE` trigger with **no `WHEN`
 * clause**, so this update fires it and the vector is genuinely recomputed from title, headings
 * and body. Byte-identity is therefore a claim that the recomputation produced the same bytes —
 * which is the property Phase 4 measured for a status change and a path rewrite, arriving here
 * from a third direction.
 *
 * The **non-vacuity companion is in the same test**: `reviewedAt` moved. Without it, a
 * `confirmReview` that returned early and wrote nothing at all would pass every other line here —
 * a vector cannot change if no statement ran.
 *
 * The publish is a real one, so the vector under test is one the product built rather than one
 * this file assembled.
 */
test("confirming writes one column: no version, no git job, and the same search vector", async () => {
  const f = await fixture();
  const page = await db.page.create({
    data: {
      spaceId: f.alpha.id,
      slug: "bunkering-ledger",
      path: "bunkering-ledger",
      title: "The bunkering log",
      status: "DRAFT",
      createdById: f.aisyah.id,
      ownerId: f.aisyah.id,
      reviewedAt: LONG_AGO,
    },
    select: { id: true },
  });
  await db.pageDraft.create({
    data: {
      pageId: page.id,
      title: "The bunkering log",
      markdown: "## Reconciliation rules\n\nEvery kerosene delivery is weighed.\n",
      updatedById: f.aisyah.id,
    },
  });
  published(await publishPage(f.asAisyah, page.id));

  const before = {
    vector: await vectorOf(page.id),
    versions: await db.pageVersion.count({ where: { pageId: page.id } }),
    jobs: await db.gitJob.count({ where: { pageId: page.id } }),
    reviewedAt: await reviewedAtOf(page.id),
  };
  // Non-vacuity for the vector itself: an empty tsvector is byte-identical to another empty one,
  // so the comparison below would hold over a page with no searchable text at all.
  expect(before.vector).toContain("bunker");
  expect(before.vector).toContain("kerosen");
  expect(before.versions).toBe(1);
  expect(before.jobs).toBe(1);

  const result = confirmed(await confirmReview(f.asAisyah, page.id, NOW));
  expect(result.reviewedAt).toEqual(NOW);

  // Byte-identical, through a value that the trigger rebuilt.
  expect(await vectorOf(page.id)).toBe(before.vector);
  // No second version, and no second mirror job — the publish's one of each is all there is.
  expect(await db.pageVersion.count({ where: { pageId: page.id } })).toBe(before.versions);
  expect(await db.gitJob.count({ where: { pageId: page.id } })).toBe(before.jobs);

  // The companion. Without this line every assertion above passes over a no-op.
  const after = await reviewedAtOf(page.id);
  expect(after).toEqual(NOW);
  expect(after).not.toEqual(before.reviewedAt);
});

/**
 * The round trip §12 describes, through the two functions a person actually touches: a page is on
 * the list, its owner confirms, and it is gone from the list — while the page beside it, which
 * nobody confirmed, stays.
 *
 * The second page is what stops this passing over a `listDueForReview` that broke between the two
 * calls.
 */
test("confirming clears the page from the due list and leaves the others on it", async () => {
  const f = await fixture();
  const mine = await f.paged({ slug: "mine", title: DUE_TITLE, reviewedAt: LONG_AGO });
  await f.paged({ slug: "theirs", title: FRESH_TITLE, reviewedAt: LONG_AGO });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([DUE_TITLE, FRESH_TITLE]);
  confirmed(await confirmReview(f.asAisyah, mine.id, NOW));
  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([FRESH_TITLE]);
});

/**
 * ## Who may confirm — and the refusal is the one to mutation-verify
 *
 * `budi` is an EDITOR of `beta` and reads nothing in `alpha`, so refusing him would prove nothing
 * about ownership: the space filter refuses him first. The viewer that separates the two guards is
 * an **EDITOR of the page's own space who does not own the page** — everything except the owner
 * arm says yes to them.
 *
 * **Mutation-verified.** With `mayConfirmReview` replaced by `can(viewer, space, "EDIT")`, this
 * test fails with `expected { ok: true, … } to deeply equal { ok: false, reason: 'forbidden', … }`
 * while every other test in this file stays green. And the refusal is `forbidden` and not
 * `not-found`, deliberately: the editor can read the page, so hiding it would send them hunting
 * for something they are looking straight at — the same distinction `restorePage` draws.
 */
test("an editor who does not own the page cannot confirm its review", async () => {
  const f = await fixture();
  const theirs = await f.paged({
    slug: "not-mine",
    title: DUE_TITLE,
    ownerId: f.dara.id,
    reviewedAt: LONG_AGO,
  });

  const refused = await confirmReview(f.asAisyah, theirs.id, NOW);
  expect(refused).toEqual({
    ok: false,
    reason: "forbidden",
    message: "Only this page's owner, or an administrator of the space, can confirm a review.",
  });
  expect(await reviewedAtOf(theirs.id)).toEqual(LONG_AGO);
  expect(await db.auditLog.count({ where: { pageId: theirs.id } })).toBe(0);

  // The non-vacuity companion: the very same viewer, on a page they own, is allowed. So the
  // refusal above is about ownership and not about `asAisyah` being unable to do anything.
  const mine = await f.paged({ slug: "mine", title: FRESH_TITLE, reviewedAt: LONG_AGO });
  expect(confirmed(await confirmReview(f.asAisyah, mine.id, NOW)).page.id).toBe(mine.id);
});

/**
 * The second arm, and the case that forced it to exist: **an unowned page**, which is what every
 * page `createPage` makes looks like. With the owner arm alone such a page becomes due one
 * interval after publication and then can never leave the list.
 *
 * The pair is the discrimination: the space's ADMIN may confirm it, an EDITOR of the same space
 * may not. Deleting the `MANAGE_SPACE` arm fails the first line; deleting the owner arm leaves
 * both lines passing, which is why the test above exists separately.
 */
test("a space admin may confirm an unowned page, and an editor still may not", async () => {
  const f = await fixture();
  const orphan = await f.paged({
    slug: "orphan",
    title: DUE_TITLE,
    ownerId: null,
    reviewedAt: LONG_AGO,
  });
  const other = await f.paged({
    slug: "orphan-two",
    title: FRESH_TITLE,
    ownerId: null,
    reviewedAt: LONG_AGO,
  });

  expect(confirmed(await confirmReview(f.asDara, orphan.id, NOW)).reviewedAt).toEqual(NOW);
  expect((await confirmReview(f.asAisyah, other.id, NOW)).ok).toBe(false);
  expect(await reviewedAtOf(other.id)).toEqual(LONG_AGO);

  // A super admin reaches the same arm through `can()`'s short circuit, with no membership row.
  expect(confirmed(await confirmReview(f.asRoot, other.id, NOW)).reviewedAt).toEqual(NOW);
});

/**
 * §8's 404-not-403 rule, on the mutation. A viewer who cannot read the space gets the same answer
 * as for a page id that never existed — so the status code cannot tell a stranger that a page
 * exists in a space they are not in.
 *
 * `asStranger` reads `handbook`, so this is not a viewer who can see nothing: the companion
 * confirms a `handbook` page they own, which is what makes the refusal above about `alpha`.
 */
test("a viewer who cannot read the space gets not-found, not forbidden", async () => {
  const f = await fixture();
  const hidden = await f.paged({ slug: "hidden", title: DUE_TITLE, reviewedAt: LONG_AGO });

  expect(await confirmReview(f.asStranger, hidden.id, NOW)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await confirmReview(f.asStranger, "no-such-page-id", NOW)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await reviewedAtOf(hidden.id)).toEqual(LONG_AGO);
});

/**
 * The soft-delete filter on the **read** — and this test alone does **not** kill removing it,
 * which was measured rather than assumed and is the most useful thing this file found.
 *
 * With `visiblePage()` dropped from `confirmReview`'s `findFirst`, all nineteen tests here stayed
 * green: the read returns the deleted row, the permission check passes for its owner, and the
 * `updateMany` below — which carries its own `visiblePage()` — matches nothing and returns exactly
 * the same `not-found`. That is the `resolveRedirect` shape arriving from a new direction, and the
 * honest report is that this assertion is a statement about the **answer**, not about which of the
 * two filters produced it. The test after it is the one that separates them.
 */
test("a soft-deleted page cannot be confirmed, and reads as not-found", async () => {
  const f = await fixture();
  const page = await f.paged({ slug: "gone", title: DUE_TITLE, reviewedAt: LONG_AGO });
  // Non-vacuity: it is confirmable right now.
  confirmed(await confirmReview(f.asAisyah, page.id, RECENTLY));

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  expect(await confirmReview(f.asAisyah, page.id, NOW)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await reviewedAtOf(page.id)).toEqual(RECENTLY);
});

/**
 * The filter on the read, separated from the filter on the write — and the separator is §8.
 *
 * The two statements agree about *whether* a soft-deleted page can be confirmed and disagree
 * about *what the refusal says*, because the read is what decides between the two failure
 * branches. Drop it and a deleted page is read successfully, `mayConfirmReview` runs against it,
 * and a viewer who is not its owner is told **forbidden** — which is a soft-deleted page
 * answering a question about itself, on a row Task 12 promises is invisible. With the filter, the
 * row is not there to have a permission question asked about it and the answer is `not-found`,
 * which is the same answer a page id that never existed gets.
 *
 * **The mutant it kills:** `where: { id: pageId, space: readableSpace(viewer) }` on the
 * `findFirst`. Measured — with that change every other test in this file passes, including the
 * one directly above, and this is the only one that fails.
 *
 * The non-vacuity companion is the second half: the same viewer, on the same page before it was
 * deleted, does get `forbidden`. So `not-found` here is the delete talking and not the permission.
 */
test("a soft-deleted page reads as not-found even for a viewer who could not confirm it", async () => {
  const f = await fixture();
  const theirs = await f.paged({
    slug: "not-mine",
    title: DUE_TITLE,
    ownerId: f.dara.id,
    reviewedAt: LONG_AGO,
  });

  // Live: the editor is refused, and told why.
  expect((await confirmReview(f.asAisyah, theirs.id, NOW)).ok).toBe(false);
  expect(await confirmReview(f.asAisyah, theirs.id, NOW)).toMatchObject({
    reason: "forbidden",
  });

  await db.page.update({ where: { id: theirs.id }, data: { deletedAt: new Date() } });

  // Deleted: the same viewer gets the answer a nonexistent id gets, with no message.
  expect(await confirmReview(f.asAisyah, theirs.id, NOW)).toEqual({
    ok: false,
    reason: "not-found",
  });
});

/**
 * The soft-delete filter on the **write**, which no test above can see: a predicate on an
 * `updateMany` is invisible unless the row changes underneath it between the read and the write.
 *
 * Staged with a held row lock rather than by timing, the way `publish.test.ts` stages its own: an
 * uncommitted `UPDATE` takes the `Page` row lock, `confirmReview` reads a page that still looks
 * live under MVCC, and then blocks on its own `updateMany`. When the delete commits, the
 * predicate is re-evaluated against a row that no longer qualifies and matches nothing.
 *
 * **The mutant it kills:** drop `visiblePage()` from that `updateMany`'s `where` and the confirm
 * stamps `reviewedAt` on a deleted page and writes an audit row for it — a page Task 12 promises
 * is invisible, carrying a fresh confirmation for Task 12's restore to hand back.
 */
test("a soft delete landing mid-confirm writes nothing and reads as not-found", async () => {
  const f = await fixture();
  const page = await f.paged({ slug: "racing", title: DUE_TITLE, reviewedAt: LONG_AGO });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`UPDATE "Page" SET "deletedAt" = now() WHERE "id" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  await settle(); // the UPDATE above holds the Page row lock, and nothing else
  const racing = confirmReview(f.asAisyah, page.id, NOW);
  await settle();

  release();
  await other;

  expect(await racing).toEqual({ ok: false, reason: "not-found" });
  expect(await reviewedAtOf(page.id)).toEqual(LONG_AGO);
  expect(await db.auditLog.count({ where: { pageId: page.id } })).toBe(0);
});

/**
 * The audit row — the whole reason `page.review` was added to `AuditAction`.
 *
 * A confirm leaves no version, no job and no vector change, and `reviewedAt` is a single mutable
 * column, so the **second** confirm is what makes the row necessary rather than tidy: without it,
 * the first confirmation is unrecoverable the moment the second happens. That is what the two
 * calls below assert — two rows, and the second one carrying the value the first one wrote.
 *
 * `by` records which arm allowed it, because with two ways to reach one write the actor alone is
 * half an answer: the same page confirmed by its owner and by an administrator are different
 * events, and only this field distinguishes them.
 */
test("each confirmation writes an audit row naming the authority and the value it replaced", async () => {
  const f = await fixture();
  const page = await f.paged({ slug: "audited", title: DUE_TITLE, reviewedAt: LONG_AGO });

  confirmed(await confirmReview(f.asAisyah, page.id, RECENTLY));
  confirmed(await confirmReview(f.asDara, page.id, NOW));

  const rows = await db.auditLog.findMany({
    where: { pageId: page.id, action: "page.review" },
    orderBy: { createdAt: "asc" },
    select: { actorId: true, action: true, spaceId: true, pageId: true, detail: true },
  });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    actorId: f.aisyah.id,
    action: "page.review",
    spaceId: f.alpha.id,
    pageId: page.id,
    detail: { path: "audited", by: "owner", previousReviewedAt: LONG_AGO.toISOString() },
  });
  // The administrator's row, carrying the owner's confirmation as the value it replaced — which
  // is the record that would be gone if this table said nothing.
  expect(rows[1]).toEqual({
    actorId: f.dara.id,
    action: "page.review",
    spaceId: f.alpha.id,
    pageId: page.id,
    detail: { path: "audited", by: "manage-space", previousReviewedAt: RECENTLY.toISOString() },
  });
});

/**
 * A page nobody has ever confirmed: `previousReviewedAt` is null and not absent. An omitted key
 * and a null one read identically in a JSON column at a glance and mean different things to
 * anyone querying it — "never reviewed" versus "this audit was written before the field existed".
 */
test("the first confirmation of a never-reviewed page records a null previous value", async () => {
  const f = await fixture();
  const page = await f.paged({
    slug: "first-time",
    title: DUE_TITLE,
    reviewedAt: null,
    publishedAt: LONG_AGO,
  });

  confirmed(await confirmReview(f.asAisyah, page.id, NOW));
  const row = await db.auditLog.findFirstOrThrow({
    where: { pageId: page.id, action: "page.review" },
    select: { detail: true },
  });
  expect(row.detail).toEqual({ path: "first-time", by: "owner", previousReviewedAt: null });
});

/**
 * An unpublished page is not *due*, and is still confirmable — the asymmetry the module docstring
 * states rather than leaves to be found.
 *
 * It is here because it is the sort of thing a later reader would "fix" by adding a
 * `publishedVersionId` clause to the write, producing a refusal no surface can reach: the list
 * only offers published pages and the reader route only renders published pages, so the product
 * has no way to confirm a draft. A guard that cannot fire is the shape Task 1 declined for the
 * seed's repair clause.
 */
test("an unpublished page is not listed but is still confirmable", async () => {
  const f = await fixture();
  const draft = await f.paged({
    slug: "draft",
    title: DUE_TITLE,
    reviewedAt: LONG_AGO,
    published: false,
  });

  expect(await titlesOf(f.asAisyah, f.alpha.id)).toEqual([]);
  expect(confirmed(await confirmReview(f.asAisyah, draft.id, NOW)).reviewedAt).toEqual(NOW);
});
