export type SaveDecision =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "conflict" };

/**
 * `seen` is the `updatedAt` the client last received; `current` is what the row holds now.
 *
 * Timestamps cross the wire as strings and come back from Postgres as Date objects with
 * millisecond precision, so compare epoch milliseconds — `Date === Date` is reference
 * equality and would report every save as a conflict, while `>=` would let a stale save
 * through whenever the clock ties.
 */
export function decideSave(args: {
  current: Date | null;
  seen: Date | null;
}): SaveDecision {
  if (args.current === null) return { kind: "create" };
  if (args.seen === null) return { kind: "conflict" };
  return args.current.getTime() === args.seen.getTime()
    ? { kind: "update" }
    : { kind: "conflict" };
}
