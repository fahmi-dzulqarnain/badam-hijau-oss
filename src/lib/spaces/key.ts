import { RESERVED_TOP_LEVEL_SEGMENTS } from "@/lib/pages/href";
import {
  SLUG_MAX_LENGTH,
  validateUrlSegment,
  type UrlSegmentErrorCode,
} from "@/lib/pages/slug";

/**
 * `Space.key` as a person types it into `/admin/spaces` — Phase 7 Task 6, and **the debt Phase 5
 * named three times**.
 *
 * Pure: a string in, a decision out, nothing imported from Prisma, so every rule here is testable
 * without a database. The sibling of `src/lib/systems/key.ts`, and it borrows the same decision
 * from the same place rather than restating it.
 *
 * ## What was actually wrong, and it was never only the routes
 *
 * `Space.key` has been a bare `String @unique` with no validation anywhere since Phase 1, and
 * three separate modules wrote down a consequence of that fact:
 *
 * - `src/lib/git/paths.ts`: the containment guard in `mirrorPathOf` cannot lean on the space key
 *   the way it can lean on `Page.path`, because *"`Space.key` has no validation anywhere… today
 *   the only writers are `prisma/seed.ts`'s two `space.upsert` calls and the integration fixtures
 *   — one of which sets a key of `"eng ops"`"*. That module also measured the sharper half on this
 *   machine: APFS is case-insensitive, so `Engineering` and `engineering` are **two rows sharing
 *   one directory** on a Mac and two directories on Linux, and it declined to fold because *"a
 *   collision is a property of two space keys and this function sees one"*.
 * - `src/lib/pages/href.ts`, twice: `/search`, `/-/mirror`, `/systems` and `/admin/*` are all
 *   top-level static segments, and a static segment beats every dynamic one.
 *
 * Two of those three are closed by the **column shape** and one by the **route list**, and they
 * are enforced in different places for a reason given below.
 *
 * ## The character class is a CHECK, and on a lowercase-only column `@unique` becomes folded
 *
 * `prisma/migrations/20260905…_space_key_shape/migration.sql` adds `Space_key_shape`, which is
 * `System_key_shape`'s regex character for character: `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
 *
 * That is where the **folded uniqueness** comes from, and it needed no second index. Task 1 said
 * it for `System`: *"on a lowercase-only column `@unique` **is** folded uniqueness"* — if no row
 * can hold an uppercase character then `key = lower(key)` for every row, so the existing unique
 * index on `key` is a unique index on `lower(key)`. The class is ASCII, so the Unicode half closes
 * with it: there is no NFC/NFD pair and no Turkish dotless `ı` inside `[a-z0-9-]`, which is the
 * "too narrow to cover its class and silent about the rest" failure `paths.ts` refused to commit.
 * A `CREATE UNIQUE INDEX ON "Space" (lower(key))` would have been a *second* statement of the same
 * guarantee, and the one whose removal no test could see.
 *
 * **The difference from Task 1, which is the whole risk of this step:** `System` got its CHECK in
 * the migration that created an empty table. `Space` is populated, and a CHECK against a populated
 * table fails outright if one row violates it — a failed migration mid-deploy. Both rows were
 * verified against the exact regex before the ALTER was written, in SQL rather than by eye; the
 * record is in this task's closing note, along with the two **test fixtures** that did violate it
 * and that the seeded rows said nothing about.
 *
 * ## The route list is not a CHECK, deliberately
 *
 * {@link RESERVED_TOP_LEVEL_SEGMENTS} is a property of this application's URL space: it changes
 * when a directory is added under `src/app`, and a route list in SQL would be a predicate stated
 * twice with the copy that mattered untestable — the split `validateSystemKey` already makes
 * against `System_key_shape`, one rule further along. `href.ts` carries the argument against
 * Phase 5's objection to having such a list at all, and `src/lib/spaces/key.test.ts` derives the
 * segments from the filesystem so the list cannot fall behind the routes.
 *
 * ## What the window was, and what a key created before this task can still do
 *
 * **This validates going forward and retro-validates nothing.** No migration rewrites a key: a
 * `Space.key` is the first segment of every URL in the space, it is the mirror's directory name in
 * `content/<key>/`, and it is in every link anyone has ever shared — so a repair pass would break
 * all three silently, which is the opposite of what this rule is for. The CHECK is the one thing
 * that *is* retroactive, and only because it was verified to pass first.
 *
 * So the honest statement of the window, in three parts:
 *
 * 1. **The two rows that exist are legal**, `engineering` and `handbook`, and neither is a reserved
 *    word. Verified against the regex and against this function; `key.test.ts` pins the seed's two
 *    keys so a future seed cannot introduce an illegal one.
 * 2. **A key created before this task could shadow a route, and the cost was measured per route
 *    rather than assumed.** A space keyed `systems` would have lost its landing page and every
 *    depth-one path, each answering **404 rather than falling through** to the page Postgres and
 *    the git mirror both still hold; a space keyed `admin` loses one path per admin leaf and keeps
 *    its landing page. Nothing in this product would have reported either: the page is published,
 *    the mirror has the file, and the URL is a 404.
 * 3. **A key created before this task could still be `Engineering`, or `eng ops`.** The CHECK now
 *    makes both unstorable — including by a hand-run `UPDATE` or a future importer, which is the
 *    half this function cannot reach — but it says nothing about a row that predates it. There is
 *    no such row here. Had there been one, the choice would have been a migration that fails loudly
 *    against it rather than a rule that quietly excuses it, and that is exactly what would have
 *    happened.
 */

/**
 * The longest key, **derived from `SLUG_MAX_LENGTH`** for `SYSTEM_KEY_MAX_LENGTH`'s reason and
 * asserted as an identity rather than typed as 80.
 *
 * A space key is one path segment a person types, which lands in a URL and in a directory name
 * under `content/`. The cap being the same number as a page slug's is not a coincidence to be
 * re-derived at each site — it is the same measurement — so if a future phase has a reason to move
 * one of them apart from the other, that becomes a decision with a failing test.
 *
 * There is deliberately **no length bound in the CHECK**, which is Task 1's argument unchanged:
 * retyping this number into SQL that nothing ties back to `src/lib/pages/slug.ts` is a predicate
 * stated twice with one copy untestable. The consequence is the same as `System.key`'s and is
 * stated rather than left to be found — a 300-character lowercase key passes the CHECK and is
 * refused here, so anything writing to the column outside this function can still produce one, and
 * `.spc-key` is in `doc.css`'s *unbounded* group because of it.
 */
export const SPACE_KEY_MAX_LENGTH = SLUG_MAX_LENGTH;

/**
 * Why a key was rejected.
 *
 * `UrlSegmentErrorCode` minus `path-too-long` — which belongs to `validatePath` over an assembled
 * path and is folded into the length sentence below rather than cast away — plus `reserved`, which
 * is this module's own and is the only rule here that `System.key` does not share. A system key
 * sits under a static prefix with no static siblings; a space key **is** a top-level segment.
 */
export type SpaceKeyErrorCode = Exclude<UrlSegmentErrorCode, "path-too-long"> | "reserved";

export type SpaceKeyError = {
  field: "key";
  code: SpaceKeyErrorCode;
  message: string;
};

export type SpaceKeyValidation =
  | { ok: true; key: string }
  | { ok: false; error: SpaceKeyError };

const reject = (code: SpaceKeyErrorCode, message: string): SpaceKeyValidation => ({
  ok: false,
  error: { field: "key", code, message },
});

/**
 * The sentence for each rule `validateUrlSegment` decides, written for the field an admin is
 * looking at.
 *
 * A `switch` with no `default` over the code union rather than a catch-all, for
 * `validateSystemKey`'s reason: adding a rule to `validateSlug` should be a **compile error here**
 * instead of a key that silently falls through to a generic sentence.
 *
 * Every sentence differs from the system-key one for the same field, and that is the point of
 * there being two of these functions rather than one shared message table: a key that is wrong
 * here is wrong about a *URL prefix and a directory in the git mirror*, not about frontmatter.
 */
function messageFor(code: UrlSegmentErrorCode, key: string): SpaceKeyValidation {
  switch (code) {
    case "empty":
      return reject(
        "empty",
        "Enter a key. It is the first segment of every URL in the space — /{key}/… — and the " +
          "directory the space's pages are mirrored into.",
      );
    case "hyphen-edge":
      return reject(
        "hyphen-edge",
        "Keys cannot start or end with a hyphen; they begin and end with a letter or a digit. A " +
          "leading hyphen is also the prefix this product reserves for its own routes, as in " +
          "/{key}/-/history.",
      );
    case "too-long":
    case "path-too-long":
      return reject(
        "too-long",
        `Keys are at most ${SPACE_KEY_MAX_LENGTH} characters; this one is ${key.length}.`,
      );
    case "not-one-segment":
      return reject(
        "not-one-segment",
        'A key is a single URL segment, so it cannot contain "/". Everything after the key is a ' +
          "page's own path.",
      );
    case "whitespace":
      return reject(
        "whitespace",
        "Keys cannot contain spaces or other whitespace; separate words with hyphens. A space " +
          "would be percent-encoded in every link and would be a directory name with a space in " +
          "it in the git mirror.",
      );
    case "path-traversal":
      return reject(
        "path-traversal",
        'A key of only dots is not a name — "." and ".." mean something else inside a URL and ' +
          "inside the mirror's working tree.",
      );
    case "uppercase":
      return reject(
        "uppercase",
        `Keys are lowercase; use "${key.toLowerCase()}" instead. This machine's filesystem is ` +
          "case-insensitive, so an uppercase key would be a second space sharing one mirror " +
          "directory with its lowercase twin — and two rows that a URL cannot tell apart.",
      );
    case "invalid-characters": {
      const [offending] = key.match(/[^a-z0-9-]/u) ?? [];
      return reject(
        "invalid-characters",
        `Keys use only lowercase letters, numbers and hyphens; "${offending ?? key}" is not ` +
          "allowed.",
      );
    }
  }
}

/**
 * Validates a key an admin typed, with the message the form renders beside the input.
 *
 * Two rules in two places, in this order, and the order is the contract:
 *
 * 1. **The shape**, from `validateUrlSegment` — the same decision `validateSystemKey` makes, and
 *    the same one `Space_key_shape` enforces on the column whatever writes to it.
 * 2. **The route list**, which the database does not know about. Checked *after* the shape so the
 *    more actionable message wins: `Admin` is refused as uppercase rather than as reserved,
 *    because lowercasing it is the fix a person reaches for first and they need to be told that it
 *    is *still* not available. (`-` never reaches this check at all: it is `hyphen-edge`.)
 *
 * The input is **not trimmed**, `validateSlug`'s standing rule: `" handbook"` answers `whitespace`
 * rather than silently becoming a key the admin never typed and cannot search for.
 */
export function validateSpaceKey(key: string): SpaceKeyValidation {
  const segment = validateUrlSegment(key);
  if (!segment.ok) return messageFor(segment.code, key);

  // The rule `validateSlug` alone does not close, and the measurement that says so is in
  // `href.ts`: of the seven top-level segments this application has, `validateSlug` accepts six.
  if (RESERVED_TOP_LEVEL_SEGMENTS.includes(key)) {
    return reject(
      "reserved",
      `"${key}" is a route this application already serves at the top level, so a space keyed ` +
        "that would lose pages to it — the page would still be in the database and in the git " +
        "mirror, and its URL would answer 404. Choose another key.",
    );
  }

  return { ok: true, key };
}
