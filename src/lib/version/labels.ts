/**
 * The words a reader is shown for the two shas on one page — and the reason this is a module
 * with a test rather than two string literals in two components.
 *
 * ## The problem these labels solve
 *
 * Three different things in this codebase are called `gitSha` and **two of them can be on the
 * screen at once**:
 *
 * - `buildInfo().gitSha` — the **application build**, from the `GIT_SHA` env var, truncated to
 *   seven characters and painted in the nav rail's foot as part of `build.label`
 *   (`0.1.0+df0ef11`). It says which build of the software served the page.
 * - `PageVersion.gitSha` — a commit in the **content repository**, which is a different
 *   repository on a different host with an unrelated history. It says which mirrored commit
 *   holds the text the reader is looking at (spec §10).
 *
 * The reader route's meta row used to label the second one `Commit`, which is the failure this
 * module exists to prevent: on a page that also shows `0.1.0+df0ef11`, the bare word "Commit"
 * is a reasonable name for *either* value, so a reader comparing them would conclude the mirror
 * was broken (two shas that never agree) or that one of them was stale. Neither label may be a
 * name the other value could answer to.
 *
 * ## Why one module
 *
 * Because the property being protected is a property of the **pair**, and a pair cannot be
 * tested where each half is a literal in a different component. `labels.test.ts` asserts the two
 * are distinct, that neither contains the other, and that neither is the bare word this project
 * already shipped — which is exactly the assertion that is unwritable while the strings live at
 * their use sites. It is the same reason `DOC_INDEXES` owns the index vocabulary rather than the
 * two routes that render it.
 *
 * Nothing here imports `buildInfo()`, and nothing in `lib/git` may import this: the content sha
 * is written by the mirror and the build sha is read from the environment, and the one thing that
 * must never happen is a module that can reach both by accident.
 */

/**
 * The reader-facing name of `PageVersion.gitSha` — the commit in the content repository.
 *
 * "Content" and not "Mirror": a reader of a documentation site has met the word *content* and
 * has not necessarily met the phrase *git mirror*, which is this project's internal name for the
 * machinery rather than a description of what the value is.
 */
export const CONTENT_COMMIT_LABEL = "Content commit";

/**
 * The reader-facing name of `buildInfo().label` — the application build.
 *
 * The rail foot painted the bare value before this existed, which is the other half of the same
 * ambiguity: an unlabelled `0.1.0+df0ef11` beside a labelled commit invites the reader to decide
 * for themselves what it is.
 */
export const BUILD_LABEL = "Build";

/**
 * What a version with no content sha says.
 *
 * **Not "not mirrored yet".** The `yet` was true for the two states the plan named — every
 * version published before Phase 5 has no sha, and so does one whose push is still queued — and
 * it is a false promise for the third state Task 6 created: a `GitJob` that reached `FAILED` is
 * not going to be retried, and a `FAILED` job blocks its own page's queue, so nothing behind it
 * will be mirrored either. This wording is true in all three states and implies an error in
 * none of them; the version history page is where the three are actually told apart, because
 * distinguishing them needs a `GitJob` read that the reader route must not pay for on every page
 * view. See `listPageVersions`.
 *
 * It is a value and not an empty string for the reason Step 2 gives: an absent sha is a normal
 * state, so it must read as a state rather than as a gap where a value should be.
 */
export const NOT_MIRRORED = "not mirrored";

/**
 * How many characters of a content sha are shown.
 *
 * A git object name is **40 characters of unbreakable token**, which is precisely the shape that
 * has widened this application's layout six times. So the display is short and the full value
 * lives in a `title` attribute, which costs no width at any viewport.
 *
 * Ten rather than the build sha's seven, and the reason is not uniqueness — seven is plenty for
 * any repository this will mirror. It is that two seven-character hex strings on one page look
 * like the same *kind* of thing even when labelled, and the labels above should not be the only
 * signal. The labels are the mechanism; this is a second, redundant one.
 */
export const SHA_DISPLAY_LENGTH = 10;

/**
 * The displayed form of a content sha.
 *
 * Total on any string, including a short or empty one: it is a `String?` column written by the
 * worker from `git rev-parse HEAD`, and a reader surface that threw on an unexpected value would
 * turn a cosmetic surprise into a 500 on the hottest route in the product.
 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHA_DISPLAY_LENGTH);
}
