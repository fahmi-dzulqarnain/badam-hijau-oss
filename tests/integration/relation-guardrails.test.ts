import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import {
  MAX_SUPERSEDE_WALK,
  checkRelations,
  type RelationCheck,
} from "@/lib/lifecycle/relations";
import type { ResolvedRelation } from "@/lib/lifecycle/resolve";
import type { DocStatus, DocType, RelationType } from "@prisma/client";

beforeEach(resetDb);

/**
 * The half of Task 6's guardrails that is a question about rows: does the **stored** supersede
 * graph already come back to this page?
 *
 * Every chain here is closed in Postgres, not in a mock, and that is deliberate. A cycle test
 * that cannot actually loop is the shape this project has been caught by once already: Phase 1's
 * tree-builder cycle tests could not detect a cyclic result until they were mutation-tested,
 * because the helper they used to build the fixture quietly refused to produce a cycle. So the
 * fixture here writes `PageRelation` rows directly — the rows Task 7 will write — and the walk
 * has to survive them.
 *
 * The doc-type rules and the cascade gate need no database and live in
 * `src/lib/lifecycle/relations.test.ts`.
 */

async function fixture() {
  const author = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "ALL_STAFF" },
  });

  /**
   * One ADR, at a distinguishable path. `title` and `slug` differ from each other and from the
   * path, so a query that read one where it meant another cannot pass by coincidence.
   */
  const adr = async (
    number: string,
    opts: { docType?: DocType; status?: DocStatus; deleted?: boolean } = {},
  ) =>
    db.page.create({
      data: {
        spaceId: space.id,
        slug: `adr-${number}-decision`,
        path: `decisions/adr-${number}-decision`,
        title: `ADR-${number} A decision`,
        docType: opts.docType ?? "ADR",
        status: opts.status ?? "ACCEPTED",
        createdById: author.id,
        deletedAt: opts.deleted === true ? new Date() : null,
      },
      select: { id: true, path: true, docType: true, status: true },
    });

  return { author, space, adr };
}

/** The `PageRelation` rows a previous publish would have left behind. */
async function edge(fromId: string, toId: string, type: RelationType = "SUPERSEDES") {
  await db.pageRelation.create({ data: { fromId, toId, type } });
}

type PageRow = { id: string; path: string; docType: DocType; status: DocStatus };

/** What `resolveRelations` hands over for a page it resolved. */
const declares = (
  page: PageRow,
  type: RelationType = "SUPERSEDES",
): ResolvedRelation => ({ type, ref: page.path, page });

function check(
  source: { id: string; docType?: DocType; publishingInto?: DocStatus },
  relations: ResolvedRelation[],
): Promise<RelationCheck> {
  return checkRelations(db, {
    source: {
      id: source.id,
      docType: source.docType ?? "ADR",
      publishingInto: source.publishingInto ?? "ACCEPTED",
    },
    relations,
  });
}

function passed(result: RelationCheck) {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}`);
  return result.relations;
}

function theRefusal(result: RelationCheck) {
  if (result.ok) throw new Error(`expected a refusal, passed: ${JSON.stringify(result)}`);
  expect(result.errors).toHaveLength(1);
  return result.errors[0]!;
}

// ---------------------------------------------------------------------------
// The legal case, and what it hands to Task 8
// ---------------------------------------------------------------------------

test("an ADR superseding another ADR passes, carrying the cascade Task 8 applies", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");

  const relations = passed(await check(source, [declares(target)]));

  expect(relations).toEqual([
    {
      type: "SUPERSEDES",
      ref: target.path,
      page: target,
      // Spec §6.3's first cascade, and the only thing Task 8 needs from this module.
      cascade: "SUPERSEDED",
    },
  ]);
});

test("the supersede cascade is gated on the publish reaching ACCEPTED", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");

  // PROPOSED is where an ADR's first publish lands, so this is the common case rather than an
  // edge one: the relation is written, and the target keeps its status until this ADR is
  // accepted.
  const proposed = passed(
    await check({ ...source, publishingInto: "PROPOSED" }, [declares(target)]),
  );
  expect(proposed[0]?.cascade).toBeNull();

  const accepted = passed(
    await check({ ...source, publishingInto: "ACCEPTED" }, [declares(target)]),
  );
  expect(accepted[0]?.cascade).toBe("SUPERSEDED");
});

// ---------------------------------------------------------------------------
// Cycle detection, over rows that really loop
// ---------------------------------------------------------------------------

test("a target that already supersedes this page is refused", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  // The shortest loop there is, and the one a walk starting a level too deep would miss.
  await edge(target.id, source.id);

  const error = theRefusal(await check(source, [declares(target)]));

  expect(error.code).toBe("supersede-cycle");
  expect(error.key).toBe("supersedes");
  expect(error.ref).toBe(target.path);
  expect(error.message).toContain("already supersedes this page");
  expect(error.message).toContain("would close the loop");
});

test("a loop through a chain of pages is refused, walked from the rows and not the frontmatter", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  const middle = await adr("0029");
  const deeper = await adr("0028");

  // target → 0029 → 0028 → source. Every one of these edges was written by a different
  // publish; the frontmatter being checked describes only the edge source → target.
  await edge(target.id, middle.id);
  await edge(middle.id, deeper.id);
  await edge(deeper.id, source.id);

  expect(theRefusal(await check(source, [declares(target)])).code).toBe("supersede-cycle");
});

test("a cycle is refused even when the cascade would not fire", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  await edge(target.id, source.id);

  // The relation row is written whether or not the cascade fires (Task 7), so the graph gains
  // the edge either way. Gating the walk on the cascade would store the cycle at PROPOSED and
  // only refuse it at the publish that accepted the ADR — by which time it is already there.
  expect(
    theRefusal(await check({ ...source, publishingInto: "PROPOSED" }, [declares(target)])).code,
  ).toBe("supersede-cycle");
});

test("a supersede chain that does not come back is not a cycle", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  const older = await adr("0029");
  const oldest = await adr("0028");

  // A real lineage: the target retired the one before it, which retired the one before that.
  // Nothing points back at the page being published.
  await edge(target.id, older.id);
  await edge(older.id, oldest.id);

  expect(passed(await check(source, [declares(target)]))[0]?.cascade).toBe("SUPERSEDED");
});

test("a loop elsewhere in the graph does not refuse this publish, and does not hang", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  const a = await adr("0029");
  const b = await adr("0028");

  // target → a → b → a. A loop the walk passes *through* and that does not include the page
  // being published, so the honest answer is "no cycle here" — the publish is legal.
  //
  // This is the test that pins the visited set as the thing that bounds the walk rather than
  // merely detects the loop: without it the walk oscillates a → b → a forever, and the budget
  // turns that into a `chain-too-long` refusal instead of this pass. Cycle detection is
  // untouched by that mutation, which is exactly why it needs its own test.
  await edge(target.id, a.id);
  await edge(a.id, b.id);
  await edge(b.id, a.id);

  const relations = passed(await check(source, [declares(target)]));
  expect(relations[0]?.cascade).toBe("SUPERSEDED");
});

test("a relation of another type back to this page is not a supersede cycle", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  // `related:` is legal between any two pages and costs nothing to write, so without the `type`
  // filter in SQL it would be a way to make every supersede publish fail.
  await edge(target.id, source.id, "RELATES_TO");

  expect(passed(await check(source, [declares(target)]))[0]?.cascade).toBe("SUPERSEDED");
});

test("a cycle through a soft-deleted page is still refused", async () => {
  const { adr } = await fixture();
  const source = await adr("0031");
  const target = await adr("0030");
  const gone = await adr("0029", { deleted: true });

  // target → (deleted) → source. The walk reads `PageRelation` only and never joins `Page`, so
  // it is blind to page state — and that blindness is the correct one rather than a missing
  // filter. A soft-deleted page can be restored, relations are only ever checked at publish
  // time, and a cycle admitted now because one member was in the bin would never be looked at
  // again. This is the test that entitles the `reachesPage: false` registration in
  // `src/lib/pages/visible.test.ts`.
  await edge(target.id, gone.id);
  await edge(gone.id, source.id);

  expect(theRefusal(await check(source, [declares(target)])).code).toBe("supersede-cycle");
});

// ---------------------------------------------------------------------------
// The bound: a pathologically long chain that does NOT loop
// ---------------------------------------------------------------------------

test("a chain longer than the walk's budget is refused as too long, not as a cycle", async () => {
  const { space, author, adr } = await fixture();
  const source = await adr("0031");

  // One straight, acyclic chain of MAX_SUPERSEDE_WALK + 1 edges. It terminates on its own — a
  // visited set is not what saves it — but only after one round trip per level, inside the
  // publish transaction and holding its row lock. That is a different failure from a loop and
  // gets a different answer.
  const links = MAX_SUPERSEDE_WALK + 1;
  await db.page.createMany({
    data: Array.from({ length: links + 1 }, (_, i) => ({
      spaceId: space.id,
      slug: `link-${i}`,
      path: `chain/link-${i}`,
      title: `Link ${i} of a very long lineage`,
      docType: "ADR" as const,
      status: "SUPERSEDED" as const,
      createdById: author.id,
    })),
  });
  const chain = await db.page.findMany({
    where: { spaceId: space.id, path: { startsWith: "chain/" } },
    select: { id: true, path: true, docType: true, status: true },
  });
  const ordered = chain.sort(
    (a, b) => Number(a.path.split("-")[1]) - Number(b.path.split("-")[1]),
  );
  await db.pageRelation.createMany({
    data: ordered.slice(0, -1).map((page, i) => ({
      fromId: page.id,
      toId: ordered[i + 1]!.id,
      type: "SUPERSEDES" as const,
    })),
  });

  const head = ordered[0]!;
  const error = theRefusal(await check(source, [declares(head)]));
  expect(error.code).toBe("chain-too-long");
  // Not reported as a cycle: there is no loop in this graph, and saying "cycle" would send an
  // author looking for one.
  expect(error.message).toContain(`more than ${MAX_SUPERSEDE_WALK} superseded pages`);
  // It says a loop could not be *ruled out*, which is what happened, and never that one is
  // there — an author sent looking for a cycle in an acyclic chain has been told the wrong
  // thing about their own document.
  expect(error.message).toContain("cannot rule out a loop");
  expect(error.message).not.toContain("already supersedes this page");

  // And the boundary, from the same chain: one page further down, exactly MAX_SUPERSEDE_WALK
  // pages are reachable, and the publish is allowed. Without this the test above would pass for
  // a budget of zero.
  expect(passed(await check(source, [declares(ordered[1]!)]))[0]?.cascade).toBe("SUPERSEDED");
});

test("the budget is shared across the whole check, not granted per reference", async () => {
  const { space, author, adr } = await fixture();
  const source = await adr("0031");

  // Two separate chains, each comfortably inside the budget on its own, together over it. A
  // per-reference budget would let 20 declared targets buy 20 walks and put the transaction's
  // real exposure at 20 × MAX_SUPERSEDE_WALK.
  const half = Math.floor(MAX_SUPERSEDE_WALK / 2) + 2;
  await db.page.createMany({
    data: [0, 1].flatMap((branch) =>
      Array.from({ length: half }, (_, i) => ({
        spaceId: space.id,
        slug: `branch-${branch}-link-${i}`,
        path: `chain-${branch}/link-${i}`,
        title: `Branch ${branch} link ${i}`,
        docType: "ADR" as const,
        status: "SUPERSEDED" as const,
        createdById: author.id,
      })),
    ),
  });

  const heads: ResolvedRelation[] = [];
  for (const branch of [0, 1]) {
    const pages = (
      await db.page.findMany({
        where: { spaceId: space.id, path: { startsWith: `chain-${branch}/` } },
        select: { id: true, path: true, docType: true, status: true },
      })
    ).sort((a, b) => Number(a.path.split("-")[2]) - Number(b.path.split("-")[2]));
    await db.pageRelation.createMany({
      data: pages.slice(0, -1).map((page, i) => ({
        fromId: page.id,
        toId: pages[i + 1]!.id,
        type: "SUPERSEDES" as const,
      })),
    });
    heads.push(declares(pages[0]!));
  }

  // Either chain on its own, with a fresh budget, is legal. So the refusal below comes from the
  // sharing and not from one chain being over the bound by itself.
  expect(passed(await check(source, [heads[0]!]))).toHaveLength(1);
  expect(passed(await check(source, [heads[1]!]))).toHaveLength(1);

  const result = await check(source, heads);
  expect(result.ok).toBe(false);
  // The first reference is inside the budget and passes; the second exhausts what is left. The
  // refusal names the second one, which is the honest answer — the check ran out of budget
  // there — and it is why the error carries the `ref` the author wrote.
  const errors = result.ok ? [] : result.errors;
  expect(errors.map((e) => e.code)).toEqual(["chain-too-long"]);
  expect(errors[0]?.ref).toBe(heads[1]?.ref);
});
