export type SaveDecision =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "vanished" }
  | { kind: "conflict" };

/**
 * `seen` is the `updatedAt` the client last received; `current` is what the row holds now.
 *
 * Both arguments are nullable and all four combinations are answered explicitly, because
 * the two asymmetric ones are the whole point of this module:
 *
 * | `current` | `seen`   | decision   |
 * |-----------|----------|------------|
 * | null      | null     | `create`   — a genuine first save
 * | null      | non-null | `vanished` — the draft this client was editing is gone
 * | non-null  | null     | `conflict` — a client that lost track of what it last received
 * | non-null  | non-null | `update` if the instants match, `conflict` otherwise
 *
 * Neither null is an opt-out; each is a claim about the world, and a claim that disagrees
 * with the row is refused rather than obeyed. A client sending no `seen` while a draft DOES
 * exist is not a first save — it is a client that lost track, and writing would destroy
 * whatever the other editor put there. The mirror is just as dangerous and less obvious: a
 * client sending a `seen` while NO draft exists is not a first save either. Publishing
 * deletes the draft, so that client is holding a timestamp for a row that has been published
 * out from under it, and answering `create` would silently resurrect pre-publish text on top
 * of the version that just went out. Answer `vanished` and let the person decide.
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
  if (args.current === null) {
    return args.seen === null ? { kind: "create" } : { kind: "vanished" };
  }
  if (args.seen === null) return { kind: "conflict" };
  return args.current.getTime() === args.seen.getTime()
    ? { kind: "update" }
    : { kind: "conflict" };
}
