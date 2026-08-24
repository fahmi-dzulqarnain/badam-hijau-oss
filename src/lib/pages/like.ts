/**
 * `LIKE` escaping for a path prefix.
 *
 * Lifted out of `move.ts` by Task 12, unchanged, because a second module now needs the exact
 * same pattern: a soft delete matches a subtree with the same boundary rule a move does, and
 * two copies of an escaping function are two chances to fix only one of them. Phase 1's
 * standing rule — "a rule implemented in two places is not yet a convention" — cost this
 * project the draft-is-inert rule and the path-encoding rule before it was written down.
 */

/**
 * The escape character for a `LIKE` pattern. Any character would do; a backslash is
 * conventional, and being explicit is what lets `%` and `_` inside a real path be matched
 * literally.
 */
export const LIKE_ESCAPE = "\\";

/**
 * Escapes a literal string for use as a `LIKE` prefix. **The escaping and the `ESCAPE` clause
 * are one decision, not two** — either without the other is broken, so callers write
 * `LIKE ${pattern} ESCAPE '\\'` and never one without the other.
 *
 * All three metacharacters, including the escape character itself: `%` matches any run,
 * `_` matches exactly one character, and an unescaped trailing `\` would consume the `/`
 * that follows it in the pattern.
 *
 * A measurement worth keeping, because it says which half carries the weight: **the
 * `ESCAPE '\'` clause is not what makes this work.** Postgres already treats a backslash as
 * the escape character when no clause is given — `'axb' LIKE 'a\_b'` is false either way —
 * so deleting the clause from a caller changes nothing and no test can catch it (verified).
 * What the tests catch is deleting *this function*. The clause stays because it says out loud
 * which character the pattern is escaped with, and because the SQL standard does not promise
 * Postgres's default; it is documentation with teeth, not the mechanism.
 *
 * `_` is the one that bites. Slugs today are `[a-z0-9-]`, so no path can contain any of these
 * — which is exactly why this is easy to skip now and expensive to discover later. If a
 * future rule admits `_`, an unescaped pattern for `a/b_c` also matches `a/bxc` and its whole
 * subtree, and a move would drag an unrelated page across the tree while a delete would take
 * it down with the subtree. Both callers have a test that inserts such a path directly, below
 * the slug rules, so the escaping is exercised today rather than from the day the rules change.
 *
 * The inverse direction is the quiet one and it is why this cannot be left to Prisma:
 * `path: { startsWith: prefix + "/" }` escapes nothing and adds no `ESCAPE`, so for a page at
 * `probe/back\` it emits `LIKE 'probe/back\/%'`, the backslash escapes the `/`, the page's own
 * child stops matching, and the read comes back one row short **silently**. Confirmed against
 * Postgres. Any prefix query over user-controlled text has to be raw, with this applied.
 */
export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

/**
 * The one pattern a subtree read and a subtree write must share: everything strictly below
 * `path`, at a `/` boundary. The subtree root itself is matched separately (`"path" = $1`) so
 * that a caller reading it back can tell the two apart.
 *
 * Built here rather than at each call site so a read and a write cannot disagree about what
 * "in this subtree" means — which is the same bug twice over, in the direction nothing
 * notices.
 */
export function subtreePattern(path: string): string {
  return `${escapeLikeLiteral(path)}/%`;
}
