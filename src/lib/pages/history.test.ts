import { expect, test } from "vitest";
import { GitJobState } from "@prisma/client";
import { MAX_HISTORY_ROWS, mirrorQueueOf } from "@/lib/pages/history";

/**
 * The pure half of the version history: how a `GitJob` state becomes something a reader is told.
 *
 * The query itself is in `tests/integration/page-history.test.ts`, because every question about
 * it is a question about rows and about who may see them.
 */

test("nothing queued is the ordinary state of a page whose mirror has caught up", () => {
  expect(mirrorQueueOf([])).toEqual({ queued: 0, failed: 0 });
  expect(mirrorQueueOf([{ state: "DONE", count: 12 }])).toEqual({ queued: 0, failed: 0 });
});

test("PENDING and RUNNING are one fact to a reader, and are added together", () => {
  // Two states, one sentence: a reader has nothing to do differently about a job that has been
  // picked up and one that has not. Summed rather than reported separately so the page cannot
  // say "one queued" while two changes are outstanding.
  expect(
    mirrorQueueOf([
      { state: "PENDING", count: 2 },
      { state: "RUNNING", count: 1 },
    ]),
  ).toEqual({ queued: 3, failed: 0 });
});

test("FAILED is counted apart, because it is the state that is not coming back", () => {
  expect(
    mirrorQueueOf([
      { state: "FAILED", count: 1 },
      { state: "PENDING", count: 4 },
      { state: "DONE", count: 9 },
    ]),
  ).toEqual({ queued: 4, failed: 1 });
});

/**
 * The totality companion. `mirrorQueueOf` switches on every member of the enum and the compiler
 * enforces that — but only for the members that exist *when it is compiled*, and a
 * `GitJobState` added later would compile against a `switch` with no `default` and simply be
 * dropped from both counts at runtime. This is what fails then.
 *
 * It is also the non-vacuity companion for the three tests above: they pass identically if the
 * fold stops seeing states it is not shown.
 */
test("every GitJobState is accounted for in one of the two counts, or deliberately in neither", () => {
  const states = Object.values(GitJobState);
  expect(states).toEqual(["PENDING", "RUNNING", "FAILED", "DONE"]);

  const seen = states.map((state) => {
    const queue = mirrorQueueOf([{ state, count: 1 }]);
    return { state, counted: queue.queued + queue.failed };
  });

  // `DONE` is the one state with nothing to say — its only observable is the sha it wrote on the
  // row. Every other state is counted exactly once.
  expect(seen).toEqual([
    { state: "PENDING", counted: 1 },
    { state: "RUNNING", counted: 1 },
    { state: "FAILED", counted: 1 },
    { state: "DONE", counted: 0 },
  ]);
});

test("the render cap is a bound on rows and not on correctness", () => {
  // Stated as a test so a future pagination change has to change a number a reader can find,
  // rather than discovering the cap in the middle of a list that silently ends.
  expect(MAX_HISTORY_ROWS).toBeGreaterThan(0);
  expect(Number.isInteger(MAX_HISTORY_ROWS)).toBe(true);
});
