import {
  SLUG_MAX_LENGTH,
  validateUrlSegment,
  type UrlSegmentErrorCode,
} from "@/lib/pages/slug";

/**
 * `System.key` as a person types it into the admin form — Task 1's deferred half.
 *
 * Pure: a string in, a decision out, nothing imported from Prisma, so every rule here is
 * testable without a database. The sibling of `src/lib/pages/slug.ts`, and it borrows that
 * module's rules rather than restating them.
 *
 * ## Why this exists at all, when a CHECK constraint already narrows the column
 *
 * `prisma/migrations/20260904145856_systems_catalogue/migration.sql` carries
 * `CHECK ("key" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')`, and Task 1 said in as many words what it
 * was leaving here: *"a CHECK produces a Postgres error, not a sentence an admin can act on"*.
 * A key typed as `Hub Core` in the create form is a `P2010`/`23514` with the constraint's own
 * name in it, which tells an admin that something called `System_key_shape` is unhappy. It is a
 * 500 on a form, and the form is the only place this string is ever typed.
 *
 * So the CHECK and this function are **not** the same predicate stated twice. They have
 * different jobs and the difference is testable: the CHECK is what makes the *column* trustworthy
 * for `foldSystemKey`'s closed-vocabulary claim and for every URL builder, whatever writes to it
 * — a migration, a hand-run `UPDATE`, a future importer — and this is what makes the one surface
 * a person uses say a sentence. Deleting this function leaves the database correct and the admin
 * confused; deleting the CHECK leaves the admin happy and Task 2's lookup guessing.
 *
 * ## The rules are `validateSlug`'s, deliberately, and only the sentences are new
 *
 * The character class is *the same predicate*: one lowercase URL segment. `validateSlug` already
 * refuses uppercase, whitespace, `/`, dots and anything outside `[a-z0-9-]`, in an order chosen
 * so the most actionable rule wins — and it has eight tested messages behind it. Writing a second
 * regex here would be the failure this project keeps finding: two spellings of one rule, where
 * mutating either alone leaves a suite green.
 *
 * What is remapped is the **wording**, because `validateSlug`'s sentences are about slugs and
 * this field is not one. Two of them would be actively wrong in this form:
 *
 * - `reserved-prefix` explains that a leading hyphen is reserved for application routes. That is
 *   true of `/{space}/-/adrs` and irrelevant under `/systems/`; here a leading hyphen is refused
 *   because the CHECK refuses it, and it is refused **together with** a trailing one, which is
 *   the rule an admin needs in one sentence.
 * - `too-long` names `SLUG_MAX_LENGTH`. The cap is the same number and the reason is stated
 *   below, but a message reading "Slugs are at most 80 characters" on a field labelled *key* is
 *   a message about a different field.
 *
 * ## The one rule `validateSlug` does not have: no **trailing** hyphen
 *
 * `validateSlug` permits `adrs-`; the CHECK does not, because `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`
 * anchors both ends on an alphanumeric. That asymmetry is not an accident of this task — it is
 * Task 1's, and it is why this cannot simply *be* `validateSlug`.
 *
 * **That rule moved out of this file in Task 6, and only the sentences stayed.** It is now
 * `validateUrlSegment` in `src/lib/pages/slug.ts`, because `Space.key` obeys the identical
 * predicate — `Space_key_shape` is `System_key_shape`'s regex, character for character — and needs
 * a different set of sentences. Leaving it here would have meant a *space* key asking a
 * *system*-key function for a decision that has nothing to do with systems, or one rule written
 * out twice; this project moved `stripControl` out of `src/lib/bugs/schema.ts` on the same
 * grounds. Nothing about the decision changed: `validateUrlSegment` is this file's old body with
 * the sentences removed, and `src/lib/systems/key.test.ts` still runs the migration's own
 * re-typed regex over the same corpus, so a divergence between the two independent statements of
 * the rule is still what that test is for.
 */

/**
 * The longest key, and it is **derived from `SLUG_MAX_LENGTH` rather than typed as 80**.
 *
 * The tie is the point, and it is the reason Task 1 refused to put a number in the SQL. A system
 * key and a page slug are the same thing measured the same way: **one path segment a person
 * types**, which lands in a URL (`/systems/{key}`) and in a list a reader scans. `/systems/[key]`
 * is a path segment exactly as `/{space}/{...path}`'s last element is, so a cap that disagreed
 * with `SLUG_MAX_LENGTH` would be two answers to one question with nothing tying them together —
 * which is precisely the shape the migration's comment declines.
 *
 * **And it is not merely tidiness, which Task 3 measured.** A 300-character lowercase key is
 * legal under the CHECK today and reaches `/systems/[key]`, where it needed a CSS rule to contain
 * it: `.sys-key` is in `doc.css`'s *unbounded* group with `overflow-wrap: anywhere` and no
 * `flex: none`, and that comment says so, naming this deferral. The overflow class has bitten
 * nine times and the ninth was on this very row.
 *
 * `src/lib/systems/key.test.ts` asserts the identity rather than the value, so if a future phase
 * has a reason to move one of them apart from the other, that becomes a **decision with a failing
 * test** rather than a silent divergence.
 */
export const SYSTEM_KEY_MAX_LENGTH = SLUG_MAX_LENGTH;

/**
 * Why a key was rejected.
 *
 * Every `SlugErrorCode` is reachable through the delegation below except `reserved-prefix`, which
 * is folded into `hyphen-edge` — a leading hyphen and a trailing one are one rule here and get
 * one sentence. `hyphen-edge` is the rule Task 1's CHECK has that a slug does not.
 *
 * `path-too-long` is excluded here and handled in `messageFor` below: it belongs to `validatePath`
 * over an assembled path, `validateUrlSegment` cannot produce it, and folding it into the length
 * sentence is what keeps that switch exhaustive without a cast.
 */
export type SystemKeyErrorCode = Exclude<UrlSegmentErrorCode, "path-too-long">;

export type SystemKeyError = {
  field: "key";
  code: SystemKeyErrorCode;
  message: string;
};

export type SystemKeyValidation =
  | { ok: true; key: string }
  | { ok: false; error: SystemKeyError };

const reject = (code: SystemKeyErrorCode, message: string): SystemKeyValidation => ({
  ok: false,
  error: { field: "key", code, message },
});

/**
 * The sentence for each rule `validateSlug` decides, written for the field an admin is looking
 * at.
 *
 * A `Record` over the code union rather than a `switch` with a default, so adding a rule to
 * `validateSlug` is a **compile error here** instead of a key that silently falls through to a
 * generic sentence. That is the same reason `SYSTEM_GROUPS` is a `Record<DocType, …>`: a
 * vocabulary that grows should not be able to grow past a surface quietly.
 *
 * `path-too-long` is in the union `FieldError` declares and `validateSlug` cannot produce it — it
 * belongs to `validatePath`, over an assembled path, and a system key is never assembled into
 * one. It is handled rather than cast away, because a cast is how an exhaustiveness guarantee
 * gets quietly given up: it folds into the length sentence, which is the true thing to say about
 * a value too long for a segment however the length was measured.
 */
function messageFor(code: UrlSegmentErrorCode, key: string): SystemKeyValidation {
  switch (code) {
    case "empty":
      return reject(
        "empty",
        "Enter a key. It is the URL segment at /systems/… and the token authors write in " +
          "`systems:` frontmatter.",
      );
    // One rule, one sentence, and `validateUrlSegment` has already folded the leading-hyphen case
    // into it — `validateSlug` calls that `reserved-prefix` and explains application routes, which
    // is a different reason for a different surface.
    case "hyphen-edge":
      return hyphenEdge();
    case "too-long":
    case "path-too-long":
      return reject(
        "too-long",
        `Keys are at most ${SYSTEM_KEY_MAX_LENGTH} characters; this one is ${key.length}.`,
      );
    case "not-one-segment":
      return reject(
        "not-one-segment",
        'A key is a single URL segment, so it cannot contain "/".',
      );
    case "whitespace":
      return reject(
        "whitespace",
        "Keys cannot contain spaces or other whitespace; separate words with hyphens.",
      );
    case "path-traversal":
      return reject(
        "path-traversal",
        'A key of only dots is not a name — "." and ".." mean something else inside a URL.',
      );
    case "uppercase":
      return reject(
        "uppercase",
        `Keys are lowercase; use "${key.toLowerCase()}" instead. An author's \`systems:\` value ` +
          "is lowercased before it is looked up, so an uppercase key could never be matched.",
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

function hyphenEdge(): SystemKeyValidation {
  return reject(
    "hyphen-edge",
    "Keys cannot start or end with a hyphen; they begin and end with a letter or a digit.",
  );
}

/**
 * Validates a key an admin typed, with the message the form renders beside the input.
 *
 * The input is **not trimmed**, for `validateSlug`'s own reason: trimming would silently store a
 * key the admin never typed, and `" order-hub"` and `"order-hub"` would then be one row reachable
 * by two spellings — the `Space.key` failure Task 1's note is written against. `validateSlug`
 * answers `whitespace` for it, and that sentence says what to do.
 *
 * The success value is the key **as given**. No folding either: a key that needed folding was
 * uppercase, and uppercase is a refusal with a sentence rather than a silent correction. That is
 * the opposite direction from `foldSystemKey`, deliberately — an *author's* frontmatter value and
 * a *reader's* URL are matched against the catalogue and so are folded, while the catalogue entry
 * itself is authored here and is held to the column's own shape.
 */
export function validateSystemKey(key: string): SystemKeyValidation {
  // The whole decision, in `src/lib/pages/slug.ts` where `Space.key` reaches it too. Everything
  // below this line is wording.
  const segment = validateUrlSegment(key);
  if (!segment.ok) return messageFor(segment.code, key);

  return { ok: true, key };
}
