/**
 * Slug and path rules. Pure: plain strings in, plain values out, nothing imported from
 * Prisma, so every rule here is testable without a database.
 *
 * These three functions are the whole vocabulary the create and move paths share. Keeping
 * them here rather than inline at each call site is deliberate — Phase 1 learned twice that
 * "a rule implemented in two places is not yet a convention", once for the draft-is-inert
 * rule and once for path encoding.
 */

/** Longest slug accepted. Keeps a single path segment sane in a URL and in the nav rail.
 * It does **not** bound the assembled path — see `MAX_PATH_BYTES` and `validatePath`. */
export const SLUG_MAX_LENGTH = 80;

/**
 * Longest assembled `Page.path`, in bytes.
 *
 * Measured, because the per-slug cap does not imply this one: nesting depth is unbounded, so
 * 33 levels of legal 80-character slugs breach the index while every individual slug passes.
 * On Postgres 16 the btree index row limit is **2704 bytes**, and
 * `create unique index on t(a, b)` refused an insert at a 2700-byte second column with
 * `index row size 2744 exceeds btree version 4 maximum 2704`. The failure arrives as a raw
 * constraint violation at INSERT time, which is not a message anyone can act on.
 *
 * 2000 leaves room for the `spaceId` in the same index, per-tuple overhead, and a future
 * third column, while still allowing far deeper nesting than any real document tree.
 *
 * A caution for whoever re-measures this: probe with **incompressible** text. A first pass
 * using `repeat('x', 3000)` inserted happily and suggested there was no limit at all.
 */
export const MAX_PATH_BYTES = 2000;

/** Why a slug was rejected. Callers switch on this; the `message` is what a human reads. */
export type PathErrorCode = "path-too-long";

export type SlugErrorCode =
  | "empty"
  | "reserved-prefix"
  | "too-long"
  | "not-one-segment"
  | "whitespace"
  | "path-traversal"
  | "uppercase"
  | "invalid-characters";

/**
 * An error attached to a form field, not thrown. The create form renders `message` against
 * the input named by `field`, which is why every rejection below gets its own sentence
 * rather than a shared "invalid slug" — the editor has to be able to act on it without
 * guessing which of eight rules they broke.
 */
export type FieldError<Field extends string = string> = {
  field: Field;
  code: SlugErrorCode | PathErrorCode;
  message: string;
};

export type SlugValidation =
  | { ok: true; slug: string }
  | { ok: false; error: FieldError<"slug"> };

const reject = (code: SlugErrorCode, message: string): SlugValidation => ({
  ok: false,
  error: { field: "slug", code, message },
});

/**
 * Validates one path segment.
 *
 * The order of the checks is part of the contract: a slug can break several rules at once
 * and the caller shows exactly one message, so the most specific and most actionable rule
 * has to win. In particular:
 *
 * - The reserved-prefix check runs before everything except emptiness. `-Adrs` is both
 *   uppercase and reserved; the reserved message is the one the editor needs, because
 *   lowercasing it does not make it legal.
 * - `/`, whitespace, `.`/`..` and uppercase all run before the character-class check, which
 *   would otherwise swallow all four into one unhelpful "invalid character" sentence.
 * - The character-class check is therefore last, and is a true catch-all: anything reaching
 *   it is neither of the four named shapes.
 *
 * The input is *not* trimmed. Trimming would silently accept `" adrs"` and store a slug the
 * editor never typed; rejecting it says so instead.
 */
export function validateSlug(slug: string): SlugValidation {
  if (slug.length === 0) {
    return reject(
      "empty",
      "Enter a slug. It becomes the last segment of the page's URL.",
    );
  }

  // Security-adjacent, not style. `/[space]/-/adrs` is a real application route in Phase 3;
  // a page permitted to take the path `-/adrs` would shadow it. See spec §5.3.
  if (slug.startsWith("-")) {
    return reject(
      "reserved-prefix",
      "Slugs cannot start with a hyphen; that prefix is reserved for application routes.",
    );
  }

  if (slug.length > SLUG_MAX_LENGTH) {
    return reject(
      "too-long",
      `Slugs are at most ${SLUG_MAX_LENGTH} characters; this one is ${slug.length}.`,
    );
  }

  if (slug.includes("/")) {
    return reject(
      "not-one-segment",
      'A slug is a single path segment, so it cannot contain "/". To nest a page, choose a parent instead.',
    );
  }

  if (/\s/.test(slug)) {
    return reject(
      "whitespace",
      "Slugs cannot contain spaces or other whitespace; separate words with hyphens.",
    );
  }

  // `.` and `..` are the shapes the table names; any run of dots is caught here so the
  // traversal message wins over the generic character-class one for all of them.
  if (/^\.+$/.test(slug)) {
    return reject(
      "path-traversal",
      'A slug of only dots is not a name — "." and ".." mean "this page" and "the page above" inside a path.',
    );
  }

  if (/[A-Z]/.test(slug)) {
    return reject(
      "uppercase",
      `Slugs are lowercase kebab-case; use "${slug.toLowerCase()}" instead.`,
    );
  }

  const [offending] = slug.match(/[^a-z0-9-]/u) ?? [];
  if (offending !== undefined) {
    return reject(
      "invalid-characters",
      `Slugs use only lowercase letters, numbers and hyphens; "${offending}" is not allowed.`,
    );
  }

  return { ok: true, slug };
}

/**
 * The path a new child page gets: `slug` at the top level, `parent.path + "/" + slug`
 * beneath one.
 *
 * The argument is the parent's **`path`**, never its **`slug`**. Phase 1's seed derived it
 * from the slug, which is indistinguishable from correct down to two levels — at depth two
 * a parent's path *is* its slug — and wrong at three, where
 * `architecture/mqtt-contracts/topic-registry` came out as `mqtt-contracts/topic-registry`.
 * That is why this takes a path and why the three-level case is tested explicitly.
 */
export function childPath(parentPath: string | null, slug: string): string {
  return parentPath === null ? slug : `${parentPath}/${slug}`;
}

/**
 * The pure half of a move: given any path in the space, return what it becomes when the
 * subtree at `oldPrefix` moves to `newPrefix`. Paths outside that subtree come back
 * unchanged, so this can be mapped over every row in the space.
 *
 * The boundary is the whole point. When `architecture/mqtt-contracts` moves, the descendant
 * `architecture/mqtt-contracts/topic-registry` goes with it, but the *sibling*
 * `architecture/mqtt-contracts-v2` must not — a bare `startsWith(oldPrefix)` matches both
 * and would silently drag an unrelated page (and its own subtree) across the tree. Only the
 * subtree root itself and paths continuing with `/` are rewritten.
 */
export function descendantPaths(
  oldPrefix: string,
  newPrefix: string,
  path: string,
): string {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) {
    return newPrefix + path.slice(oldPrefix.length);
  }
  return path;
}

/**
 * Whether `path` is inside the subtree rooted at `root` — the root itself, or anything below
 * it at a `/` boundary.
 *
 * Expressed through `descendantPaths` rather than as a fresh comparison, and the empty
 * replacement prefix is what turns a rewrite into a question: a path inside the subtree comes
 * back changed, a path outside it comes back identical. So there is exactly **one**
 * implementation of the boundary rule and everything that asks the question inherits its
 * tests — `movePage`, which used to spell this out inline, and Task 14b's delete confirmation,
 * which has to name the pages that go with a page.
 *
 * That second caller is why this is a named export rather than a two-line closure repeated at
 * each site. Phase 1 learned twice that "a rule implemented in two places is not yet a
 * convention", and this project has already had the *other* half of this exact rule go wrong
 * once: `movePage`'s `LIKE` pattern correctly refused to drag `mqtt-contracts-v2` along while
 * a separate `startsWith` check called it a descendant, and all 32 tests passed.
 */
export function isInSubtree(root: string, path: string): boolean {
  return descendantPaths(root, "", path) !== path;
}

/**
 * The rows below `root`, root **excluded**, ordered by path.
 *
 * What a delete confirmation is made of: "deleting this page also deletes these". Generic over
 * the row shape so it can be handed the nav rail's own rows rather than a second query, and
 * pure so the boundary case — a sibling whose path merely starts with the same characters —
 * is tested without a database.
 */
export function descendantsOf<Row extends { path: string }>(
  root: string,
  rows: readonly Row[],
): Row[] {
  return rows
    .filter((row) => row.path !== root && isInSubtree(root, row.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; error: FieldError<"slug"> };

/**
 * Checks an **assembled** path, which `validateSlug` cannot: it sees one segment at a time
 * and depth is unbounded. Both the create path and the move path must call this after
 * building the new path and before writing it, or a deep tree fails at the index with a
 * constraint violation instead of a field message.
 *
 * The move case matters more than create: moving a subtree under a deeper parent lengthens
 * every descendant at once, so a move that looks small can breach the limit for a page the
 * user was not even looking at. Check the longest resulting descendant, not just the page
 * being moved.
 *
 * Attributed to the slug field because that is the only part of the path the user can
 * shorten from the form they are looking at.
 */
export function validatePath(path: string): PathValidation {
  const bytes = new TextEncoder().encode(path).length;
  if (bytes > MAX_PATH_BYTES) {
    return {
      ok: false,
      error: {
        field: "slug",
        code: "path-too-long",
        message:
          `The full path would be ${bytes} bytes, over the ${MAX_PATH_BYTES}-byte limit. ` +
          "Use a shorter slug, or move this page nearer the top of the space.",
      },
    };
  }
  return { ok: true, path };
}
