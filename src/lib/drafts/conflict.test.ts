import { expect, test } from "vitest";
import { decideSave } from "@/lib/drafts/conflict";

const T0 = "2026-08-23T10:00:00.000Z";
const T1 = "2026-08-23T10:00:00.001Z";

/*
 * The four cases of the decision table, one test each, in the order of the table in
 * `conflict.ts`. Both nulls mean something, and the two mixed rows are the ones an
 * implementation gets wrong in opposite directions.
 */

test("no draft row and no seen is a create — a genuine first save", () => {
  expect(decideSave({ current: null, seen: null })).toEqual({ kind: "create" });
});

/**
 * The mirror of the case below, and the one this module originally got wrong: it answered
 * `create` for any null `current`, whatever the client claimed to have seen.
 *
 * A client holding a `seen` for a draft that no longer exists is not making a first save. It
 * is holding a receipt for a row that has since been published (Task 9 deletes the draft) or
 * deleted with its page (Task 12). Answering `create` writes its pre-publish text straight
 * back as a draft over the version that was just published, returns 201, and tells nobody.
 *
 * Kills: `if (args.current === null) return { kind: "create" }` — the shipped bug — and any
 * rewrite that decides on the row's existence alone.
 */
test("a seen timestamp with no draft row is vanished, not a create", () => {
  expect(decideSave({ current: null, seen: new Date(T0) })).toEqual({ kind: "vanished" });
});

/**
 * The case a naive implementation gets wrong, and the reason this module exists as its own
 * function. A client that sends no `seen` while a draft DOES exist is not a first save — it
 * is a client that lost track of what it last received, and treating that as an authoritative
 * first write silently destroys whatever the other editor put there.
 *
 * Kills: `if (args.seen === null) return { kind: "update" }`, and equally the whole line's
 * removal — with it gone, `null.getTime()` throws rather than answering, so the test fails
 * either way.
 */
test("a missing seen against an existing draft is a conflict, never an overwrite", () => {
  expect(decideSave({ current: new Date(T0), seen: null })).toEqual({ kind: "conflict" });
});

/**
 * The fourth row, stated as one test so the table is complete on its own terms: with both
 * sides present the answer turns on the instants and nothing else. The two branches under it
 * are pinned in detail by the mutation tests further down.
 */
test("with both present, matching instants update and differing ones conflict", () => {
  expect(decideSave({ current: new Date(T0), seen: new Date(T0) })).toEqual({
    kind: "update",
  });
  expect(decideSave({ current: new Date(T0), seen: new Date(T1) })).toEqual({
    kind: "conflict",
  });
});

/**
 * Kills: `args.current === args.seen`. Two Date objects carrying the same instant are the
 * shape every real save has — the client round-trips the timestamp as a string and it is
 * parsed back into a fresh object — so reference equality reports a conflict on every
 * single save and no draft is ever updatable.
 */
test("equal instants held in different Date objects are an update", () => {
  const current = new Date(T0);
  const seen = new Date(T0);
  expect(current).not.toBe(seen);
  expect(decideSave({ current, seen })).toEqual({ kind: "update" });
});

/**
 * Kills: `>=`. A stale client sends the timestamp it saw before someone else saved, so
 * `seen` is BEHIND `current` — and `current >= seen` is true, which is exactly the silent
 * overwrite the contract forbids. One millisecond apart, because that is the resolution
 * Postgres stores and therefore the smallest real gap between two saves.
 */
test("a seen timestamp one millisecond behind current is a conflict", () => {
  expect(decideSave({ current: new Date(T1), seen: new Date(T0) })).toEqual({
    kind: "conflict",
  });
});

/**
 * Kills: `<=`. The inverse skew — a `seen` ahead of the row — is not a legitimate save
 * either: nobody has ever been handed that timestamp, so it is a fabricated or corrupted
 * value and must not be allowed to write.
 */
test("a seen timestamp ahead of current is a conflict", () => {
  expect(decideSave({ current: new Date(T0), seen: new Date(T1) })).toEqual({
    kind: "conflict",
  });
});

/**
 * Kills any tolerance window an implementation might be tempted to add ("close enough
 * counts as the same save"). A save one second stale is the ordinary two-editor case.
 */
test("a seen timestamp a second behind current is a conflict", () => {
  expect(
    decideSave({
      current: new Date("2026-08-23T10:00:01.000Z"),
      seen: new Date(T0),
    }),
  ).toEqual({ kind: "conflict" });
});

/**
 * The decision is a pure read of its arguments: no clock, no module state. Calling it twice
 * with the same input has to give the same answer, or the endpoint's behaviour depends on
 * how long the request took.
 */
test("the decision does not depend on the wall clock or on call order", () => {
  const args = { current: new Date(T0), seen: new Date(T0) };
  expect(decideSave(args)).toEqual(decideSave(args));
  expect(decideSave(args)).toEqual({ kind: "update" });
});
