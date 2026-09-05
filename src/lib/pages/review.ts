import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { writeAudit } from "@/lib/audit/log";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

/**
 * Spec §12's review cycle: the "due for review" list on `/[space]`, and the confirmation that
 * clears a page from it.
 *
 * §12 in full: *"a 'due for review' list of pages whose owner has not confirmed them within the
 * review interval (default twelve months, configurable per deployment). Confirming a review
 * updates `reviewedAt` without creating a version."*
 *
 * ## The measurement this module was designed around
 *
 * Taken before a line of it was written, because the plan's own tests would otherwise have been
 * vacuous. In the seeded corpus **every page has an `ownerId` and a `reviewedAt` of
 * `2026-08-18`**, set by `prisma/seed.ts`, and today is `2026-09-05`. So under the twelve-month
 * default **nothing in the seeded corpus is due**, the list renders empty in every space, and an
 * assertion that it is empty would pass over a query that returned nothing for any reason at all.
 * Every test of this module therefore builds its own fixture with an old anchor date, and each
 * one has a **not-due** companion in the same assertion.
 *
 * The second half of that measurement is the one that decided the rule below: **`reviewedAt` is
 * set by the seed and by nothing else.** `createPage` writes neither `ownerId` nor `reviewedAt`,
 * and `publishPage` writes neither either — so every page this product creates has
 * `reviewedAt = null` and `ownerId = null`, permanently, until someone confirms a review or an
 * administrator assigns an owner. "Never reviewed" is not an edge case here; outside the seed it
 * is the *only* state a page is ever in.
 *
 * ## So what does a null `reviewedAt` mean
 *
 * Three answers were available and the corpus rules out two of them.
 *
 * - **Not due.** Then no page created by this product is ever listed, because none of them has a
 *   `reviewedAt` to age. The feature would be dead on arrival and silently so.
 * - **Due immediately.** Literal §12 — the owner has indeed not confirmed it — and it means a
 *   page published this morning appears on a list headed "due for review". A list that is wrong
 *   about its newest entry is a list people stop reading, and the interval's purpose is
 *   staleness, not paperwork.
 * - **Measured from `publishedAt`,** which is what this module does. Publication is the last
 *   moment somebody asserted the document was correct, and it is a *stronger* assertion than a
 *   review confirmation: an author read it and shipped it. So it starts the clock, and a page
 *   never confirmed becomes due exactly one interval after it was published.
 *
 * That choice also makes the anchor **total**: every candidate row has a non-null date to compare,
 * so there is no third branch and no row that the predicate is silent about.
 *
 * ## An unpublished page is never due
 *
 * A draft has no reader, so "is this still accurate" is not yet a question anybody is being asked
 * — the author is holding it. It is also what makes the anchor above total: an unpublished page
 * has no `publishedAt`, so a rule that listed drafts would need the third branch this one does
 * not have. `publishedVersionId` **and** `publishedAt` are both required, together, because they
 * are two independent nullable columns and this project has written that lesson down twice.
 *
 * Note the asymmetry that follows, stated rather than left to be discovered: `confirmReview`
 * does **not** require a published page. See its own docstring — refusing there would be a guard
 * that no surface can fire.
 *
 * ## The predicate is stated exactly once
 *
 * There is no `isDueForReview(page)` helper in this module and that is deliberate. The reader
 * route would be its only caller — to decide whether to shout about the confirm control — and a
 * TypeScript copy of a SQL `where` is the shape Phase 4 Task 3 measured: its `byId.get()` miss
 * skipped exactly the rows the SQL clause excluded, and **deleting the SQL clause left all 24
 * tests green**. The reader therefore renders the confirm control on its own permission question
 * and says nothing about due-ness, and the due rule lives in one `where` builder that both
 * queries below share.
 */

/**
 * §17's "review interval in months".
 *
 * Validated rather than read, exactly as `maxUploadBytes` is, and the ceiling case is different:
 * there is no column to overflow, so the only illegal values are the ones that make the rule
 * meaningless. **Zero is refused**, not clamped — a zero-month interval makes every published
 * page due the instant it is published, which is the "due immediately" reading the module
 * docstring rejected, arriving through configuration instead of through code.
 *
 * The default is twelve, per §17, and it is a default in the **code**: `.env.example` and
 * `.env.test` both carry the line, but an unset or empty value is safe. That is the opposite
 * polarity from `BLOB_STORE`, which refuses to guess, and the reason is the failure this project
 * actually had — a variable added to the tracked template with no code default broke 27 tests in
 * another checkout the moment Phase 6 merged, because `.env.test` is untracked and per-checkout.
 */
export function reviewIntervalMonths(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.REVIEW_INTERVAL_MONTHS;
  if (raw === undefined || raw === "") return 12;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `REVIEW_INTERVAL_MONTHS must be a positive integer number of months, got ${JSON.stringify(
        raw,
      )}`,
    );
  }
  return value;
}

export const REVIEW_INTERVAL_MONTHS = reviewIntervalMonths();

/**
 * The moment before which an anchor date is overdue.
 *
 * **UTC, deliberately.** `setMonth` reads and writes the local calendar, so the same database and
 * the same clock would produce a cutoff that differs by up to a day between a container in UTC
 * and a laptop on `Asia/Kuala_Lumpur` — and this project has already paid for a timezone
 * assumption once, when a raw write bound a `Date` as `timestamptz` and stored `07:00Z` as
 * `15:00`. Prisma stores `DateTime` in UTC; the cutoff is computed in the same calendar.
 *
 * `setUTCMonth` normalises an overflowing day rather than throwing: twelve months back from
 * 29 February lands on 1 March, one day early. That is the whole extent of the imprecision and it
 * is accepted rather than corrected — a review nag that fires a day early once every four years
 * is not a defect worth a date library.
 */
export function reviewCutoff(now: Date, months: number = REVIEW_INTERVAL_MONTHS): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * The most rows the landing page lists. A rendering bound, not a correctness one — `total` below
 * comes from the aggregate, so a truncated list still reports how many pages are really due.
 *
 * Smaller than `MAX_SYSTEM_DOC_ROWS` because this list is a section of a landing page and not the
 * page itself: twenty overdue pages is already a backlog, and the number after it is what a space
 * admin needs rather than another two hundred rows.
 */
export const MAX_DUE_ROWS = 20;

/** One row of the due list. Enough to link it, date it and say who is being waited on. */
export type DueForReviewRow = {
  pageId: string;
  path: string;
  title: string;
  /** Null when nobody has ever confirmed it — the state every product-created page is in. */
  reviewedAt: Date | null;
  /** Non-null by the query's own filter; typed nullable because Prisma types from the schema. */
  publishedAt: Date | null;
  /** §12's subject. Null is `Page.ownerId` being null, which the seed hides and the product does not. */
  ownerName: string | null;
};

export type DueForReview = {
  rows: DueForReviewRow[];
  /** How many pages in this space are due, before `MAX_DUE_ROWS`. */
  total: number;
  /** `total` exceeded the cap, so `rows` is short and the surface must say so. */
  truncated: boolean;
  /** What the list is measuring against, so the surface can name the interval it is applying. */
  intervalMonths: number;
};

/**
 * The permission predicate, the soft-delete filter, the published-page bound and §12's own
 * staleness rule — in one place, for the list and for the count.
 *
 * One builder rather than two, which is the divergence `src/lib/systems/read.ts` argued for and
 * `src/lib/lifecycle/index-read.ts` is the cautionary tale of: with the filter dropped from the
 * aggregate alone, the list is right and the number beside it counts pages nobody can open. Here
 * there is exactly one place any of the four predicates can be deleted from.
 *
 * `visiblePage` and `readableSpace` are each passed **whole** — one as the top-level builder, one
 * as the value of the `space` relation filter — and neither is spread at any depth. The `OR` sits
 * inside a condition object handed to `visiblePage`, so it becomes one element of that function's
 * own `AND` and cannot displace `deletedAt`; a spread would have put the two at the same level
 * and silently kept only one.
 *
 * The `OR`'s two arms are §12's rule and the module docstring's fallback, in that order:
 *
 * - a page whose owner confirmed it too long ago;
 * - a page nobody has ever confirmed, published too long ago.
 *
 * They are disjoint by construction — the second requires `reviewedAt: null`, which the first
 * cannot match — so a row can never be counted twice.
 */
function dueScope(viewer: Viewer, spaceId: string, cutoff: Date): Prisma.PageWhereInput {
  return visiblePage({
    spaceId,
    // The one statement of the permission predicate on this read.
    space: readableSpace(viewer),
    // Both columns, together: "published" means `publishedVersionId`, and `publishedAt` is the
    // fallback anchor below. A query filtering on either alone survives an unpublish or a
    // rollback and yields a row whose link 404s.
    publishedVersionId: { not: null },
    publishedAt: { not: null },
    OR: [
      { reviewedAt: { lt: cutoff } },
      { reviewedAt: null, publishedAt: { lt: cutoff } },
    ],
  });
}

/**
 * §11's third section on the space landing: the pages whose review is overdue.
 *
 * Scoped to the space the URL names **and** to the spaces this viewer may read. Both, and the
 * second is not redundant with the first: the route resolves the space through
 * `getReadableSpaceByKey` before calling this, but this project's one rule for page queries is
 * that every query states its own predicate and none is guarded by call ordering.
 *
 * `now` is a parameter with a default rather than a `new Date()` inside, because "twelve months
 * ago" is the entire behaviour of this function and a test that cannot move the clock can only
 * assert it against fixtures dated relative to the same clock — which is the same value compared
 * against itself, the shape Phase 2's timezone bug hid inside.
 */
export async function listDueForReview(
  viewer: Viewer,
  spaceId: string,
  options: { now?: Date; intervalMonths?: number; limit?: number } = {},
): Promise<DueForReview> {
  const intervalMonths = options.intervalMonths ?? REVIEW_INTERVAL_MONTHS;
  const limit = options.limit ?? MAX_DUE_ROWS;
  const cutoff = reviewCutoff(options.now ?? new Date(), intervalMonths);
  const where = dueScope(viewer, spaceId, cutoff);

  const total = await db.page.count({ where });

  const rows = await db.page.findMany({
    where,
    /*
     * Never confirmed first, then longest since confirmation — and this is a **two-tier order**
     * rather than an approximation of "most overdue first". Postgres could produce the strict
     * order from `coalesce("reviewedAt", "publishedAt")`, and Prisma has no expression for it, so
     * the honest choices were raw SQL or an order that says what it means. This one says what it
     * means: a page whose owner has *never* confirmed it is the strongest case §12 describes, and
     * it is listed above a page whose confirmation has merely lapsed. Within each tier, oldest
     * first. `id` breaks the final tie so the cut at `limit` cannot shuffle between requests.
     */
    orderBy: [
      { reviewedAt: { sort: "asc", nulls: "first" } },
      { publishedAt: "asc" },
      { id: "asc" },
    ],
    take: limit,
    // Explicit select, never `include`. The owner is reached through the relation for its name
    // only; `Page.ownerId` is nullable, so this is a `LEFT JOIN` and cannot drop a row — which
    // matters, because an unowned page is the ordinary case outside the seed and an inner join
    // would have hidden every one of them while every test that seeds an owner stayed green.
    select: {
      id: true,
      path: true,
      title: true,
      reviewedAt: true,
      publishedAt: true,
      owner: { select: { name: true } },
    },
  });

  return {
    rows: rows.map((row) => ({
      pageId: row.id,
      path: row.path,
      title: row.title,
      reviewedAt: row.reviewedAt,
      publishedAt: row.publishedAt,
      ownerName: row.owner?.name ?? null,
    })),
    total,
    truncated: total > rows.length,
    intervalMonths,
  };
}

/**
 * Who §12 says has not confirmed, and who may therefore confirm.
 *
 * **The owner, or somebody who may manage the space.** Pure, and shared by the surface that
 * renders the control and by the mutation that performs it — one function, because a rule
 * implemented in two places is not yet a convention and this project has recorded that twice.
 *
 * ## Why not `EDIT`
 *
 * §12 names the **owner**, and `EDIT` is a different question. An editor may change what the page
 * says; confirming a review is a claim that what it says is still true, made by the person
 * accountable for it. If any editor could clear the list, the sentence the list is built on —
 * "pages whose owner has not confirmed them" — would be false of every row an editor had touched,
 * and the list would still be reporting the interval as though it meant something.
 *
 * ## Why `MANAGE_SPACE` is the second arm rather than a nicety
 *
 * Because `Page.ownerId` is **nullable and usually null**. `createPage` sets no owner and
 * `publishPage` sets none either, so every page this product creates is unowned; with the owner
 * arm alone, an unowned page would become due one interval after publication and then stay on the
 * list for ever, unactionable by anybody. The same hole opens for an owned page whose owner has
 * left — offboarding in this project deletes memberships and keeps the `User` row, so the owner
 * still exists, still owns the page, and can no longer sign in.
 *
 * A space admin is who answers for both. `can()` folds `isSuperAdmin` into every action, so a
 * super admin is inside this arm and needs no third one.
 *
 * Returns the authority as a string rather than a boolean, because the audit row records it: with
 * two ways to reach the same write, "who cleared this" is only half an answer.
 */
export type ConfirmAuthority = "owner" | "manage-space";

export function mayConfirmReview(
  viewer: Viewer,
  space: SpaceRef,
  page: { ownerId: string | null },
): ConfirmAuthority | null {
  // Owner first, so an owner who is also an admin is recorded as the owner — which is the
  // stronger claim and the one §12 is about.
  if (page.ownerId !== null && page.ownerId === viewer.id) return "owner";
  if (can(viewer, space, "MANAGE_SPACE")) return "manage-space";
  return null;
}

export type ConfirmReviewResult =
  | { ok: true; page: { id: string; path: string; spaceKey: string }; reviewedAt: Date }
  /** No such page, or one this viewer cannot read. The same answer, per §8. */
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "forbidden"; message: string };

/**
 * §12's other half: *"Confirming a review updates `reviewedAt` without creating a version."*
 *
 * ## What this must NOT write, and how each absence is kept
 *
 * | Not written | Why it stays that way |
 * |---|---|
 * | `PageVersion` | there is no version delegate call in this module |
 * | `GitJob` | `src/lib/git/enqueue.ts` is the only writer and this is not one of its four callers |
 * | `Page.searchVector` | the trigger recomputes it from title, headings and body — none of which this touches |
 *
 * The third is the one worth a test rather than a sentence, because it is not an absence at all:
 * `page_search_vector` is a `BEFORE INSERT OR UPDATE` trigger with **no `WHEN` clause**, so this
 * update fires it and the vector is rebuilt on every confirm. The claim is therefore
 * byte-identity of a value that was genuinely recomputed, which is a stronger property than "we
 * did not touch it" and is what `tests/integration/review.test.ts` asserts — with the non-vacuity
 * companion, in the same test, showing `reviewedAt` really moved.
 *
 * ## The write carries the predicate
 *
 * `updateMany`, not `update`, for `publishPage`'s reason: a soft delete that commits while this
 * transaction is open matches nothing, and the confirm rolls back rather than stamping a page
 * that no longer exists. A zero row count is a race this cannot commit through, so it throws.
 *
 * ## No lock, and that is a decision
 *
 * The only competitor is another confirm of the same page, and the loser's value is simply
 * overwritten by the winner's — both are legitimate confirmations a second apart, and both leave
 * an audit row saying who confirmed and when. Locking would serialise a write that has no
 * invariant spanning two rows. Contrast `publishPage`, which takes a `FOR UPDATE` row lock on the
 * draft precisely because it has one.
 *
 * ## A published page is not required, and refusing would be a guard that cannot fire
 *
 * The list only offers published pages and the reader route only renders published pages, so the
 * product cannot reach an unpublished page's confirm control at all. Adding a
 * `publishedVersionId` clause here would be a refusal no surface can produce — the shape Task 1
 * declined for the seed's repair clause — and it would leave the module unable to answer for a
 * state it never has to. What the write does refuse is the state that IS reachable: a page
 * soft-deleted between the render and the POST.
 */
export async function confirmReview(
  viewer: Viewer,
  pageId: string,
  now: Date = new Date(),
): Promise<ConfirmReviewResult> {
  return db.$transaction(async (tx) => {
    const page = await tx.page.findFirst({
      // Both helpers passed whole, neither spread. `visiblePage` owns the top level and
      // `readableSpace` is the `space` relation filter.
      where: visiblePage({ id: pageId, space: readableSpace(viewer) }),
      // Explicit select, never `include`. The space's `id` and `visibility` are exactly what
      // `can()` needs, and `key` is what the caller needs to build a URL.
      select: {
        id: true,
        path: true,
        ownerId: true,
        reviewedAt: true,
        space: { select: { id: true, key: true, visibility: true } },
      },
    });

    // Unreadable and nonexistent give the same answer, so a title cannot leak through a status
    // code. The permission branch below is about a page the viewer can already read.
    if (page === null) return { ok: false, reason: "not-found" } as const;

    const authority = mayConfirmReview(viewer, page.space, page);
    if (authority === null) {
      return {
        ok: false,
        reason: "forbidden",
        // The one thing nobody can guess is that `EDIT` is not enough, so the sentence says it.
        message:
          "Only this page's owner, or an administrator of the space, can confirm a review.",
      } as const;
    }

    // `readableSpace` here is **an equivalent mutant in practice, and is reported rather than
    // pinned by a manufactured test** — measured: deleting it leaves all twenty tests in
    // `tests/integration/review.test.ts` green, because the read four lines up already refused
    // every viewer it would refuse. It is not literally equivalent (a `SpaceMembership` deleted
    // by another transaction between the read and this write would be seen here and not there),
    // and it is kept for consistency with `publishPage`, `movePage` and `deletePage`, which all
    // restate both predicates on their writes. `visiblePage()` beside it is a different case: it
    // has a staged test and it dies.
    const updated = await tx.page.updateMany({
      where: visiblePage({ id: page.id, space: readableSpace(viewer) }),
      data: { reviewedAt: now },
    });
    // A zero row count is a real race and not an impossibility: a soft delete can commit while
    // this transaction sits on the row lock, and the predicate is then re-evaluated against a row
    // that no longer qualifies.
    //
    // **It returns rather than throwing, and that is the difference from `publishPage`.** Publish
    // throws `PageNoLongerPublishable` because by that point it has already inserted a version —
    // the only way out of a transaction that has written is to abort it. Nothing has been written
    // here: the audit row is below this line, deliberately, so an empty commit and a rollback are
    // the same observable event and the caller gets the ordinary not-found instead of a 500 for
    // a page that was legitimately deleted a millisecond ago.
    if (updated.count !== 1) return { ok: false, reason: "not-found" } as const;

    /**
     * Audited, and it is the clearest case in the product for auditing something.
     *
     * A confirm changes a page's state and leaves **no other trace at all**: no version, no git
     * job, no vector change — the three rows above say so deliberately. And `reviewedAt` is one
     * mutable column, so the next confirm destroys the record of this one. Without a row here,
     * "who said this document was still correct, and when" would be answerable only for the most
     * recent claim, on a list whose entire purpose is to hold somebody to it.
     *
     * `previousReviewedAt` is stored because it is the value this write destroys, and the gap
     * between the two is the thing an auditor is looking at. `by` records which arm of
     * `mayConfirmReview` allowed it, exactly as `space.access`'s `by` records why a super admin's
     * read was permitted — with two ways to reach one write, the actor alone is half an answer.
     * `path` is stored for the reason every page audit stores it: the page can move afterwards.
     */
    await writeAudit(tx, {
      actorId: viewer.id,
      action: "page.review",
      spaceId: page.space.id,
      pageId: page.id,
      detail: {
        path: page.path,
        by: authority,
        previousReviewedAt: page.reviewedAt === null ? null : page.reviewedAt.toISOString(),
      },
    });

    return {
      ok: true,
      page: { id: page.id, path: page.path, spaceKey: page.space.key },
      reviewedAt: now,
    } as const;
  });
}
