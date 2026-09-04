/**
 * Take the credentials out of git's output before anybody reads it.
 *
 * ## The hole this closes, and why it is not hypothetical
 *
 * Task 5 decided, deliberately, **not** to assemble credentials: §17 lists "git remote URL and
 * credentials" as configuration, and the credential belongs in the remote URL, an SSH key or a
 * credential helper, all of which real git already understands. That decision is right and is not
 * being revisited here. Its consequence is that `GIT_REMOTE_URL` may legitimately be
 * `https://user:ghp_realtoken@github.example/org/repo.git` — and from there a token reaches a
 * `text` column by **two** routes, neither of which needs git to misbehave:
 *
 * 1. **The argv.** `failedRun` quotes `JSON.stringify(run.argv)` into every error message, and
 *    `push()`'s argv is `["push", "--", config.remoteUrl, …]`. So *any* failed push writes the
 *    remote URL, credential and all, into `GitJob.lastError` — with no help from git at all.
 * 2. **git's own output.** `fatal: Authentication failed for
 *    'https://user:ghp_realtoken@github.example/org/repo.git/'` is what git says when it is
 *    refused, and it echoes the URL it was given.
 *
 * `GitJob.lastError` is then read in three places, and each is a publication: the super-admin
 * failures page (Phase 5 Task 8), `scripts/git-worker.ts`'s stdout, which is cron mail, and the
 * column itself, which anyone with a psql prompt reads.
 *
 * ## What is redacted, and what deliberately is not
 *
 * **The whole userinfo component of any `scheme://userinfo@host` URL**, replaced by
 * {@link REDACTED}. Not the password half alone, because the most common credential form in
 * practice puts the secret in the *username* position — a GitHub PAT is
 * `https://ghp_xxx@github.com/org/repo.git` with no colon in it — so a redactor that kept the
 * username would keep the token. There is no way to tell `git` from `ghp_xxx` by looking, so both
 * go.
 *
 * The host and the path survive, which is the operationally useful half: an operator reading a
 * failure needs to know *which* remote refused, and `https://[redacted]@github.example/org/repo.git`
 * still says so.
 *
 * **scp-style remotes are not touched.** `git@github.com:org/repo.git` has no `://` and does not
 * match, and that is correct rather than a gap: the scp syntax has no password field at all, so
 * the text before the `@` is a login name and never a secret.
 *
 * ## What this cannot do, stated because a redactor that overpromises is worse than none
 *
 * It rewrites URLs. A secret that appears in git's output **outside** a URL is not recognisable as
 * a secret by any rule this module could carry — `fatal: could not read Password for …` does not
 * echo one, but a credential helper or a server-side hook could print anything. So this is a
 * guard on the one shape that is *certain* to carry the credential (the configured remote, which
 * this application itself passes to git on the command line), not a general secret scanner.
 *
 * ## Applied at both ends, and that is not the "predicate stated twice" mistake
 *
 * This runs where the message is built ({@link import("./repo").GitError}, so the secret never
 * reaches the database, the cron mail or the log) **and** again where a stored `lastError` is read
 * for display (`src/lib/git/failures.ts`). The project's rule against stating a predicate twice is
 * about *permission* predicates, where the second copy can be deleted with the whole suite green
 * because the first one already refused the row — the `resolveRedirect` shape. That is not this:
 * these are two independent transforms of two different values, and deleting either one alone
 * fails a test the other cannot cover.
 *
 * - Delete the call in `repo.ts` → `GitJob.lastError` stores the token; `repo.test.ts`'s
 *   "a failed push does not store the remote's credentials" fails.
 * - Delete the call in `failures.ts` → a row whose `lastError` already holds a token paints it;
 *   `failures.test.ts`'s "a stored credential is not painted" fails.
 *
 * The second is not a defence against the first being deleted. It is a defence against the row:
 * `lastError` is an unbounded `text` column written by a worker that has been through five
 * revisions, and a display surface that assumes its input was sanitised somewhere else is how the
 * one row written by an older build, a hand-run `UPDATE`, or a future code path that does not go
 * through `failedRun` ends up on a web page.
 */

/** What replaces a URL's userinfo. Named so a test asserts the marker and not a literal. */
export const REDACTED = "[redacted]";

/**
 * Any `scheme://userinfo@` prefix.
 *
 * The userinfo class excludes `/`, `?`, `#` and whitespace but **includes `@`**, and that is
 * deliberate: a password with a literal, unencoded `@` in it (`https://user:p@ss@host/repo`) would
 * otherwise be matched only as far as the first `@`, leaving `ss` — half the password — in the
 * output. `*` is greedy, so the match runs to the **last** `@` before the authority ends, and
 * `user:p@ss` goes as one piece.
 *
 * The `g` flag is on the pattern rather than added per call because a single git error can name
 * the remote more than once — the argv and git's own message both.
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*):\/\/[^/?#\s]*@/gi;

/**
 * Replace the userinfo of every URL in `text`.
 *
 * Total, and returns the input unchanged when there is nothing to redact — it runs on every git
 * failure, including the overwhelming majority that name no credential, so "no match" is the
 * normal case and not a signal.
 *
 * A `RegExp` with `g` carries `lastIndex` between calls, which is the classic way a shared literal
 * starts skipping matches. `String.prototype.replace` resets it to 0 before returning, so a module
 * constant is safe here — unlike `test()` or `exec()`, which do not.
 */
export function redactCredentials(text: string): string {
  return text.replace(URL_USERINFO, `$1://${REDACTED}@`);
}
