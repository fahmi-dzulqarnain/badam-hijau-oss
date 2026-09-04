import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Where a page's mirrored file goes in the working tree.
 *
 * Pure: three strings in, a discriminated result out. No database, no git, no filesystem — this
 * module never stats, reads or writes anything, so every judgement below is unit-testable with a
 * literal, and it has no opinion about whether the tree, the space directory or the file already
 * exist. `src/lib/git/document.ts` decides what the file *contains*; this decides where it sits.
 *
 * The layout is the spec's: §10 writes `content/<space-key>/<path>.md`, and §16 lists `content/`
 * as the mirror's working tree — so the file is `<space-key>/<path>.md` **inside** the tree, and
 * `content/…` is that same path seen from the application's own checkout.
 *
 * ## Refuse, do not sanitise
 *
 * Every rejection below is a refusal of the whole operation, never a rewrite. A `Page.path` or a
 * `Space.key` that needed sanitising is a bug in whatever wrote the row, and quietly rewriting it
 * would produce a mirror that disagrees with Postgres about where a page lives while reporting
 * success — the failure this module exists to make impossible. A refusal lands in
 * `GitJob.lastError`, retries, and ends up on Task 8's page where a super admin reads it.
 *
 * ## Why this guard is not redundant, even though `Page.path` cannot escape today
 *
 * Measured, because the obvious reading is the wrong way round and a future reader who checks
 * `validateSlug` will otherwise conclude this module is dead code:
 *
 * - **`Page.path` cannot currently produce a traversal.** `validateSlug` refuses `/`, whitespace,
 *   any run of dots, and — as a true catch-all last check — anything outside `[a-z0-9-]`. So a
 *   dot cannot appear *inside* a segment at all, which makes `..` doubly impossible, and a
 *   `Page.path` is a `/`-joined series of `[a-z0-9-]+` segments. `createPage` and `movePage` are
 *   the only writers in the product, and both call it.
 * - **`validatePath`, despite the name, checks only byte length** (`MAX_PATH_BYTES`), not shape.
 *   It is not a second opinion about the characters.
 * - **`Space.key` has no validation anywhere.** It is a bare `String @unique` in
 *   `prisma/schema.prisma`; today the only writers are `prisma/seed.ts`'s two `space.upsert`
 *   calls and the integration fixtures — one of which sets a key of `"eng ops"`, a space
 *   character and all. Phase 7 owns space administration, which is when a human can type one.
 *
 * So the traversal this refuses cannot arrive through the half of the path everyone assumes, and
 * can arrive through the half nobody validates. That inversion is the argument for the guard: its
 * value is precisely that it does **not** depend on a guarantee made three modules away for an
 * unrelated reason — the same argument `document.ts` makes for nesting the author's frontmatter
 * under `declared` rather than trusting a key allowlist.
 *
 * ## The `.md` suffix is appended *after* resolution, and the order is load-bearing
 *
 * Measured, because the natural order silently defeats the check: `".." + ".md"` is `"...md"`, a
 * perfectly legal filename that resolves to `<space-dir>/...md` — **inside** the tree. An
 * implementation that builds `<root>/<key>/<path>.md` and then verifies containment therefore
 * *accepts* a `..` path and writes a junk file, which is the sanitise-instead-of-refuse failure
 * arriving by accident rather than by choice. Resolving the extensionless target first makes `..`
 * resolve to the space directory's parent, where containment sees it.
 *
 * Appending afterwards cannot re-open the hole: the target is already known to be strictly below
 * the space directory, and adding characters to its last segment keeps it there (the only strings
 * that could climb are `.` and `..`, and a target whose last segment were either would have been
 * refused).
 *
 * ## The root is an argument, not configuration
 *
 * §17 puts the working tree behind an environment variable and §16 names `content/`, but reading
 * either here would make this module untestable without a process environment and would give it a
 * second job. The caller states the root; Task 5 and Task 6 are where configuration is read.
 *
 * The root must be **absolute**, and that is refused rather than resolved for the same reason:
 * `path.resolve` would silently complete a relative root against `process.cwd()`, which makes the
 * answer depend on where the worker was started from — a value neither the caller nor a test can
 * see. Refusing keeps this function total *and* independent of the process, so `mirrorPathOf` is a
 * function of its arguments only.
 *
 * ## What this deliberately has no opinion about
 *
 * **Total path length: the caller's, or rather the filesystem's.** Filesystem limits are per
 * component, and the per-component side is safe — `SLUG_MAX_LENGTH` is 80 and `NAME_MAX` measured
 * 255 on this machine. The total is a different story: `MAX_PATH_BYTES` is 2000, `.md` adds three,
 * and the root adds more, while `getconf PATH_MAX /` is **1024** on darwin against 4096 on Linux.
 * So a legal 33-level-deep page can exceed `PATH_MAX` on a developer's Mac and not in production.
 * This function still declines to cap it, deliberately: the real limit belongs to the filesystem
 * the tree is on, a guessed one would refuse a page that published fine, and every refusal here
 * means "a bug upstream" — which a deeply nested page is not. The write in Task 5 gets a clean
 * `ENAMETOOLONG` carrying the true limit, and that lands in the job's retry-and-then-`FAILED`
 * path, which is where an operational limit belongs.
 *
 * **Case, and Unicode normalisation.** Both measured on this machine (APFS, darwin 25.5), and one
 * of them is not the folklore: the filesystem is case-**insensitive** (a file written as
 * `Engineering.txt` is found as `engineering.txt`) and normalisation-**insensitive but
 * byte-preserving** (a file written with NFC `é`, `c3 a9`, is found under NFD `65 cc 81`, and
 * `readdir` returns the NFC bytes that were written). APFS does not convert to NFD the way HFS+
 * did. Slugs are `[a-z0-9-]`, so `Page.path` is untouched by either; an unvalidated `Space.key`
 * is not, so `Engineering` and `engineering` are two rows sharing one directory on macOS and two
 * directories on Linux.
 *
 * This module still folds neither, and the reason is that **a collision is a property of two
 * space keys and this function sees one.** Refusing an uppercase key would close the ASCII half
 * of the class while leaving NFC/NFD — and Turkish dotless `ı`, and every other fold — wide open,
 * which is this project's most repeated failure: a guard too narrow to cover its class and silent
 * about the rest. The check that actually closes it is a uniqueness constraint on a *folded*
 * `Space.key` where both keys are visible, at the point space keys are created — Phase 7. So this
 * module is byte-faithful, a test pins that it does not fold, and the hazard is stated here
 * rather than half-addressed.
 *
 * A related one that needs no action: a NUL cannot reach a filename through this, because
 * Postgres rejects NUL in `text` and so `Space.key` cannot hold one. Other control characters
 * can — nothing strips them from a space key — and they are legal in a POSIX filename, so they
 * are passed through as written; git takes them as argv elements and quotes them in its own
 * output.
 *
 * **POSIX separators.** `Page.path` joins with `/`, and the canonicality check below compares
 * against `path.relative`'s platform separator. On Windows that comparison fails for every
 * nested page, so the module would refuse everything rather than mis-place anything — loud, not
 * silent, which is the direction this project prefers.
 */

/**
 * Why a mirror path was refused. Callers switch on this; `message` is what a human reads out of
 * `GitJob.lastError`.
 *
 * There is no `field`, unlike `slug.ts`'s `FieldError` and `frontmatter.ts`'s
 * `FrontmatterFieldError`: nothing here is attached to an input someone is typing in. By the time
 * a path is being assembled the publish has already committed, and the only reader is an operator.
 *
 * Every code below catches at least one input that no other code catches, which is the test that
 * a check is load-bearing rather than defence in depth. This project has learned twice that a
 * predicate stated in two places is not twice as safe but untestable — so there is deliberately
 * **no** separate "path is absolute" or "path contains `..`" check: containment already refuses
 * both, and a second check would mean the containment check could be deleted with the suite still
 * green.
 *
 * | Code | The shapes only it catches |
 * |---|---|
 * | `root-not-absolute` | a relative root, which `path.resolve` would complete against the cwd |
 * | `space-key-not-one-segment` | `a/b` — inside the tree, but a directory deeper than the layout, where space `a` and page `b/…` collide with it |
 * | `space-key-outside-root` | `..`, `.`, `""` — a key that moves or is the tree root itself |
 * | `path-outside-space` | `..`, `../../etc/passwd`, `/etc/passwd`, `.`, `""` |
 * | `path-not-canonical` | `a/`, `a//b`, `a/./b`, `a/../b` — resolution would have rewritten the path, and `a/../b` is the traversal that stays inside and so is invisible to containment |
 */
export type MirrorPathErrorCode =
  | "root-not-absolute"
  | "space-key-not-one-segment"
  | "space-key-outside-root"
  | "path-outside-space"
  | "path-not-canonical";

export type MirrorPathError = {
  code: MirrorPathErrorCode;
  message: string;
};

export type MirrorPathResult =
  | {
      ok: true;
      /** Absolute, for the filesystem write. */
      absolutePath: string;
      /** Relative to the working tree root, which is what a `git add`/`git mv` argument is. */
      repoPath: string;
    }
  | { ok: false; error: MirrorPathError };

/** The extension every mirrored file gets. Only Markdown is mirrored — attachments are Phase 6. */
const MIRROR_EXTENSION = ".md";

/**
 * A space key is one directory name. `\` is refused alongside `/` because `path.resolve` treats
 * it as a separator on Windows, so a key containing one would mean two different layouts on two
 * platforms — and on POSIX a backslash in a filename is legal but nothing wants it.
 */
const SEGMENT_SEPARATOR = /[/\\]/;

const refuse = (code: MirrorPathErrorCode, message: string): MirrorPathResult => ({
  ok: false,
  error: { code, message },
});

/**
 * Whether `child` sits **strictly** below `parent`. Strictness is the point: equality is what a
 * path of `""` or `"."` produces, and a mirrored file is never the directory it lives in.
 *
 * The separator has to be appended, or `…/engineering-v2` counts as being inside
 * `…/engineering` — the same off-by-one boundary `descendantPaths` exists to state once for
 * `Page.path`, and which this project has already had wrong on the other side of one function.
 * The `endsWith` guard is for a root of `/`, where the separator is already there.
 */
function isStrictlyBelow(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * The mirrored file for one page: `<root>/<spaceKey>/<path>.md`, resolved, with containment
 * verified rather than assumed.
 *
 * `path` is a `Page.path` — space-relative, `/`-joined, no extension. `root` is the working tree,
 * absolute. Interpolated values are quoted with `JSON.stringify` in every message, so a control
 * character in a space key arrives in a log as an escape rather than as a broken line.
 */
export function mirrorPathOf(root: string, spaceKey: string, path: string): MirrorPathResult {
  if (!isAbsolute(root)) {
    return refuse(
      "root-not-absolute",
      `The working tree root must be an absolute path; got ${JSON.stringify(root)}. ` +
        "A relative root would be completed against the process's working directory.",
    );
  }

  // Normalised once, so a root given with a trailing slash or an interior `.` compares against
  // the resolved paths below rather than refusing everything as escaping. `root` is already
  // absolute, so this cannot consult the cwd.
  const tree = resolve(root);

  if (SEGMENT_SEPARATOR.test(spaceKey)) {
    return refuse(
      "space-key-not-one-segment",
      `A space key is one directory name, so it cannot contain a path separator; got ` +
        `${JSON.stringify(spaceKey)}.`,
    );
  }

  const spaceDir = resolve(tree, spaceKey);
  if (!isStrictlyBelow(tree, spaceDir)) {
    return refuse(
      "space-key-outside-root",
      `The space key ${JSON.stringify(spaceKey)} does not name a directory inside the working ` +
        `tree: it resolves to ${JSON.stringify(spaceDir)}, which is not below ` +
        `${JSON.stringify(tree)}.`,
    );
  }

  // The extensionless target, so that a `..` climbs where containment can see it instead of
  // becoming the filename `...md`. See the module note; the order is the whole check.
  const target = resolve(spaceDir, path);
  if (!isStrictlyBelow(spaceDir, target)) {
    return refuse(
      "path-outside-space",
      `The page path ${JSON.stringify(path)} must name a file below the space directory, but it ` +
        (target === spaceDir
          ? `resolves to ${JSON.stringify(spaceDir)}, the space directory itself.`
          : `resolves to ${JSON.stringify(target)}, outside ${JSON.stringify(spaceDir)}.`),
    );
  }

  // Contained, but not necessarily the path we were given: `a/`, `a//b`, `a/./b` and `a/../b`
  // all resolve to somewhere legal while meaning something else than they say. Refusing rather
  // than accepting the resolved form is what keeps the mirror's filename derivable from the row
  // — a normalised path would write a file whose name no query for `Page.path` finds.
  const canonical = relative(spaceDir, target);
  if (canonical !== path) {
    return refuse(
      "path-not-canonical",
      `The page path ${JSON.stringify(path)} is not in canonical form: it resolves to ` +
        `${JSON.stringify(canonical)}. A mirrored filename must be the stored path, not a ` +
        "rewrite of it.",
    );
  }

  return {
    ok: true,
    absolutePath: target + MIRROR_EXTENSION,
    // Derived from the verified absolute path rather than re-joined from the arguments, so the
    // layout is stated once and a git argument cannot disagree with the file that was written. On
    // POSIX this is exactly `<spaceKey>/<path>.md`, and a test pins that — and, honestly,
    // re-joining `${spaceKey}/${path}` here is an **equivalent** mutant, measured: the two checks
    // above already force the two forms to agree. This is about one statement of the layout, not
    // about a bug it currently prevents.
    repoPath: relative(tree, target) + MIRROR_EXTENSION,
  };
}
