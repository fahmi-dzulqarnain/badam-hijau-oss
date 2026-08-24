import { describe, expect, test } from "vitest";
import {
  MAX_PATH_BYTES,
  SLUG_MAX_LENGTH,
  childPath,
  descendantPaths,
  descendantsOf,
  isInSubtree,
  validatePath,
  validateSlug,
  type FieldError,
} from "./slug";

/**
 * Every test below names the mutation it kills. That annotation is the point of the file:
 * a test that only proves the function ran survives every interesting mutant, and the only
 * reliable way to tell the two apart is to say out loud what breaking change makes it red.
 */

/** Asserts a rejection and hands back the error, so each test can pin code *and* message. */
function rejection(slug: string): FieldError<"slug"> {
  const result = validateSlug(slug);
  if (result.ok) {
    throw new Error(
      `Expected ${JSON.stringify(slug)} to be rejected, but it was accepted.`,
    );
  }
  return result.error;
}

describe("validateSlug", () => {
  // --- the rejection table, one test per row ------------------------------------------

  test("rejects the empty string", () => {
    // Kills: dropping the `slug.length === 0` guard, which lets "" fall through every
    // remaining check (none of which match) and be accepted as a slug, producing a page
    // whose path ends in a bare "/".
    const error = rejection("");
    expect(error.code).toBe("empty");
    expect(error.message).toMatch(/enter a slug/i);
  });

  test("rejects a leading hyphen, because that prefix is reserved for application routes", () => {
    // Kills: removing the `startsWith("-")` guard. `-` is inside the [a-z0-9-] character
    // class, so with this check gone "-adrs" passes validation entirely and a page can
    // claim the path "-/adrs" — shadowing the real `/[space]/-/adrs` route (spec §5.3).
    // The message is pinned in full because it is the one an editor has to be able to act
    // on without knowing anything about routing.
    const error = rejection("-adrs");
    expect(error.code).toBe("reserved-prefix");
    expect(error.message).toBe(
      "Slugs cannot start with a hyphen; that prefix is reserved for application routes.",
    );
  });

  test("rejects a bare hyphen — the reserved segment itself", () => {
    // Kills: narrowing the reserved check to `/^-[a-z0-9]/` or similar, which would admit
    // the exact segment the application route uses.
    expect(rejection("-").code).toBe("reserved-prefix");
  });

  test("rejects a slug containing a separator, because a slug is one segment", () => {
    // Kills: removing the "/" check. Without it "a/b" is not matched by [a-z0-9-] either,
    // so it would still be rejected — but with the generic character message, which tells
    // the editor nothing about nesting. Pinning the code is what keeps the two distinct.
    const error = rejection("a/b");
    expect(error.code).toBe("not-one-segment");
    expect(error.message).toContain("single path segment");
  });

  test("rejects uppercase", () => {
    // Kills: adding `i` to the character-class regex, or lowercasing the input before
    // validating. Either mutation accepts "A-Slug" and stores a path that differs from the
    // one every link is built from.
    const error = rejection("A-Slug");
    expect(error.code).toBe("uppercase");
    expect(error.message).toContain('"a-slug"');
  });

  test("rejects whitespace", () => {
    // Kills: dropping the \s check, which downgrades "a b" to the generic character
    // message; and kills any attempt to accept spaces on the theory that pageHref encodes
    // them — it does, into %20, which is not a slug anyone typed.
    const error = rejection("a b");
    expect(error.code).toBe("whitespace");
    expect(error.message).toMatch(/space/i);
  });

  test("rejects whitespace that is not a space character", () => {
    // Kills: replacing the \s test with `includes(" ")`, which lets a pasted tab or newline
    // through to the character-class branch — or, if the class regex ever gained the `m`
    // flag, straight through into a path.
    expect(rejection("a\tb").code).toBe("whitespace");
    expect(rejection("a\nb").code).toBe("whitespace");
  });

  test("does not trim: leading and trailing whitespace are rejected, not silently removed", () => {
    // Kills: adding `.trim()` to the input. Trimming stores a slug the editor never typed
    // and, worse, makes " adrs" and "adrs" collide on the unique (spaceId, path) index with
    // no message explaining why.
    expect(rejection(" adrs").code).toBe("whitespace");
    expect(rejection("adrs ").code).toBe("whitespace");
  });

  test('rejects "." and ".." as path traversal shapes', () => {
    // Kills: removing the dot-run guard. Both are caught by the character class as a
    // fallback, so a mutant that deletes this branch still rejects them — the distinct code
    // is the assertion that survives, and it is what stops "." reaching childPath, where
    // "architecture/." is a path Postgres accepts and no reader can resolve.
    expect(rejection(".").code).toBe("path-traversal");
    expect(rejection("..").code).toBe("path-traversal");
  });

  test("rejects characters outside [a-z0-9-]", () => {
    // Kills: widening the character class — adding "_", ".", ":" or \w (which is
    // [A-Za-z0-9_]) — and kills dropping the `u` flag's discipline around non-ASCII. Each
    // of these produces a path segment that needs percent-encoding to survive a URL.
    expect(rejection("a_b").code).toBe("invalid-characters");
    expect(rejection("adr:1").code).toBe("invalid-characters");
    expect(rejection("café").code).toBe("invalid-characters");
    expect(rejection("emoji🙂").code).toBe("invalid-characters");
    expect(rejection("a.b").code).toBe("invalid-characters");
  });

  test("names the offending character in the message", () => {
    // Kills: collapsing the eight messages into one shared "invalid slug" string. A form
    // that cannot say *which* character is wrong sends the editor hunting.
    expect(rejection("adr:1").message).toContain('":"');
  });

  test("names an astral character whole, not as half a surrogate pair", () => {
    // Kills: quoting `match[0][0]` instead of `match[0]`, or dropping the `u` flag. Either
    // splits 🙂 across its two UTF-16 units and renders a lone surrogate — an unpaired
    // \uD83D — into the form, which the browser draws as a replacement glyph. The message
    // then points at a character the editor cannot find in what they typed.
    expect(rejection("emoji🙂").message).toContain('"🙂"');
  });

  test(`rejects slugs longer than ${SLUG_MAX_LENGTH} characters`, () => {
    // Kills: `>=` for `>` at the boundary, dropping the length check entirely, or measuring
    // something other than the slug. A path is built by joining these, and the unique btree
    // index on (spaceId, path) has a size limit.
    const error = rejection("a".repeat(SLUG_MAX_LENGTH + 1));
    expect(error.code).toBe("too-long");
    expect(error.message).toContain(String(SLUG_MAX_LENGTH + 1));
  });

  test(`accepts exactly ${SLUG_MAX_LENGTH} characters`, () => {
    // Kills: the off-by-one in the other direction — `slug.length >= SLUG_MAX_LENGTH`,
    // which rejects a legal slug. Paired with the test above, the boundary is pinned from
    // both sides; either test alone leaves one mutant alive.
    expect(validateSlug("a".repeat(SLUG_MAX_LENGTH))).toEqual({
      ok: true,
      slug: "a".repeat(SLUG_MAX_LENGTH),
    });
  });

  // --- the accepted examples -----------------------------------------------------------

  test.each(["a", "adr-0042-mqtt-topic-naming", "v2", "2026-08-23"])(
    "accepts %j",
    (slug) => {
      // Kills: any over-eager rule. Requiring a letter first kills "2026-08-23"; requiring
      // more than one character kills "a"; banning digit-adjacent hyphens kills
      // "adr-0042-..."; requiring a hyphen kills "v2". Every one of those is a plausible
      // "tighten the slug rules" change, and each dies here.
      expect(validateSlug(slug)).toEqual({ ok: true, slug });
    },
  );

  test("accepts a trailing hyphen — the rule is about the leading position only", () => {
    // Kills: generalising the reserved-prefix guard to `/(^-|-$)/` or `.includes("-")`.
    // The reserved-route hazard is positional; over-rejecting here would block legal slugs
    // for no security gain.
    expect(validateSlug("adrs-").ok).toBe(true);
  });

  test("returns the slug unchanged on success, rather than a normalised copy", () => {
    // Kills: a validator that quietly canonicalises (lowercasing, collapsing "--", stripping
    // a trailing hyphen) and returns the rewrite. Callers write `result.slug` to the
    // database, so a silent rewrite means the stored path is not the one the form showed.
    const result = validateSlug("adr-0042--mqtt");
    expect(result).toEqual({ ok: true, slug: "adr-0042--mqtt" });
  });

  // --- properties of the error shape ---------------------------------------------------

  test("never throws: every rejection comes back as a value", () => {
    // Kills: converting any branch to `throw new Error(...)`. The create form renders these
    // against a field; a throw becomes a 500 and the editor loses what they typed.
    for (const bad of ["", "-adrs", "a/b", "A-Slug", "a b", ".", "..", "a_b", "a".repeat(200)]) {
      expect(() => validateSlug(bad)).not.toThrow();
      expect(validateSlug(bad).ok).toBe(false);
    }
  });

  test("every rejection is attributed to the slug field", () => {
    // Kills: dropping `field` from the error, or letting one branch return a bare string.
    // The form keys its error map by field name; an error with no field renders nowhere.
    for (const bad of ["", "-adrs", "a/b", "A-Slug", "a b", ".", "a_b", "a".repeat(200)]) {
      expect(rejection(bad).field).toBe("slug");
    }
  });

  test("each rejection reason has its own message", () => {
    // Kills: the single shared "Invalid slug." message — the exact regression this module
    // exists to prevent, and the one no per-row test above catches on its own, because each
    // of those only looks at one message at a time.
    const messages = ["", "-adrs", "a".repeat(81), "a/b", "a b", ".", "A-Slug", "a_b"].map(
      (bad) => rejection(bad).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  // --- check ordering: a slug can break several rules at once --------------------------

  test("the reserved-prefix message wins over uppercase and length", () => {
    // Kills: reordering the checks so a cosmetic rule reports first. "-Adrs" is uppercase
    // *and* reserved; telling the editor to lowercase it hands them "-adrs", still illegal.
    expect(rejection("-Adrs").code).toBe("reserved-prefix");
    expect(rejection(`-${"a".repeat(200)}`).code).toBe("reserved-prefix");
  });

  test("the specific shape rules win over the generic character class", () => {
    // Kills: moving the [a-z0-9-] catch-all above the named checks, which would collapse
    // four actionable messages into one. The catch-all must stay last.
    expect(rejection("A B").code).toBe("whitespace");
    expect(rejection("A/B").code).toBe("not-one-segment");
  });
});

describe("childPath", () => {
  test("a top-level page's path is just its slug", () => {
    // Kills: unconditionally prefixing, which yields "/architecture" or "null/architecture"
    // for a root page — a leading slash that no reader link or unique-index lookup expects.
    expect(childPath(null, "architecture")).toBe("architecture");
  });

  test("a child's path is the parent's path plus its slug", () => {
    // Kills: swapping the operands (`${slug}/${parentPath}`) and using a separator other
    // than "/".
    expect(childPath("architecture", "mqtt-contracts")).toBe("architecture/mqtt-contracts");
  });

  test("three levels deep, the path is built from the parent's PATH, not its slug", () => {
    // Kills: THE mutation this function exists for — deriving from `parent.slug` instead of
    // `parent.path`. Phase 1's seed did exactly that. It is indistinguishable from correct
    // at depth two (a depth-two parent's path IS its slug, so the test above stays green),
    // and wrong at depth three: the slug form returns "mqtt-contracts/topic-registry",
    // dropping the "architecture/" ancestor and silently reparenting the page to the root.
    const parentPath = childPath("architecture", "mqtt-contracts");
    expect(childPath(parentPath, "topic-registry")).toBe(
      "architecture/mqtt-contracts/topic-registry",
    );
  });

  test("four levels deep keeps every ancestor", () => {
    // Kills: a "fix" that prepends only the grandparent, or that keeps a fixed number of
    // leading segments. Depth three alone cannot distinguish "join the whole path" from
    // "join the last two segments".
    expect(childPath("architecture/mqtt-contracts/topic-registry", "retained")).toBe(
      "architecture/mqtt-contracts/topic-registry/retained",
    );
  });

  test("adds exactly one separator and no trailing one", () => {
    // Kills: `${parentPath}/${slug}/` or `${parentPath}//${slug}`. A trailing or doubled
    // slash produces a path that is unique-index-distinct from the one links resolve to,
    // so the page exists and 404s.
    const path = childPath("a", "b");
    expect(path.startsWith("/")).toBe(false);
    expect(path.endsWith("/")).toBe(false);
    expect(path.split("/")).toEqual(["a", "b"]);
  });
});

describe("descendantPaths", () => {
  const OLD = "architecture/mqtt-contracts";
  const NEW = "platform/mqtt-contracts";

  test("the moved page itself takes the new path", () => {
    // Kills: handling only strict descendants (`startsWith(oldPrefix + "/")` with no
    // equality case), which leaves the subtree root sitting at its old path while all of
    // its children move away — an orphaned parent and a broken tree.
    expect(descendantPaths(OLD, NEW, OLD)).toBe(NEW);
  });

  test("a descendant moves with it", () => {
    // Kills: returning `path` unchanged for everything, and returning `newPrefix` for
    // everything (which would flatten a whole subtree onto one path and violate the unique
    // index on the first insert).
    expect(descendantPaths(OLD, NEW, `${OLD}/topic-registry`)).toBe(
      `${NEW}/topic-registry`,
    );
  });

  test("a deeper descendant keeps its whole tail", () => {
    // Kills: rebuilding the new path from only the last segment
    // (`${newPrefix}/${basename}`), which silently promotes every grandchild to a direct
    // child and collapses siblings with the same leaf name onto one path.
    expect(descendantPaths(OLD, NEW, `${OLD}/topic-registry/retained`)).toBe(
      `${NEW}/topic-registry/retained`,
    );
  });

  test("a sibling sharing the prefix but not the boundary is left alone", () => {
    // Kills: THE mutation this function exists for — a bare `path.startsWith(oldPrefix)`
    // with no "/" boundary check. That mutant rewrites "architecture/mqtt-contracts-v2" to
    // "platform/mqtt-contracts-v2", dragging an unrelated page and its entire subtree
    // across the tree during someone else's move. Every other test in this block stays
    // green under that mutant; this one is the whole reason the boundary is checked.
    expect(descendantPaths(OLD, NEW, `${OLD}-v2`)).toBe(`${OLD}-v2`);
  });

  test("the sibling's own descendants are left alone too", () => {
    // Kills: the same missing boundary check, one level down — the case where the damage is
    // largest and least visible, because the rewritten child still looks well-formed.
    expect(descendantPaths(OLD, NEW, `${OLD}-v2/topic-registry`)).toBe(
      `${OLD}-v2/topic-registry`,
    );
  });

  test("an ancestor of the moved page is left alone", () => {
    // Kills: an inverted boundary test (`oldPrefix.startsWith(path)`), which would rewrite
    // the parent the page is moving out of.
    expect(descendantPaths(OLD, NEW, "architecture")).toBe("architecture");
  });

  test("an unrelated path is left alone", () => {
    // Kills: any unconditional rewrite, and a `replace(oldPrefix, newPrefix)` that searches
    // the whole string rather than anchoring at position 0.
    expect(descendantPaths(OLD, NEW, "handbook/welcome")).toBe("handbook/welcome");
  });

  test("only the leading occurrence is rewritten", () => {
    // Kills: `path.replaceAll(oldPrefix, newPrefix)` and a non-anchored replace. A page
    // legitimately nested at "architecture/mqtt-contracts/architecture/mqtt-contracts"
    // must have its tail preserved verbatim.
    expect(descendantPaths(OLD, NEW, `${OLD}/${OLD}`)).toBe(`${NEW}/${OLD}`);
  });

  test("a rename in place changes only the last segment", () => {
    // Kills: assuming a move always changes the parent. Renaming a slug is the same
    // operation with a same-parent target, and the descendant rewrite must still run.
    expect(descendantPaths(OLD, "architecture/mqtt", `${OLD}/topic-registry`)).toBe(
      "architecture/mqtt/topic-registry",
    );
  });

  test("moving a nested subtree up to the top level", () => {
    // Kills: a rewrite that assumes both prefixes have the same segment count, e.g. one
    // that splices segment-by-segment rather than slicing at the prefix length.
    expect(descendantPaths(OLD, "mqtt-contracts", `${OLD}/topic-registry`)).toBe(
      "mqtt-contracts/topic-registry",
    );
  });

  test("moving a top-level subtree down under a new parent", () => {
    // Kills: the same assumption in the other direction, and any use of a fixed offset
    // instead of `oldPrefix.length`.
    expect(descendantPaths("handbook", "archive/2025/handbook", "handbook/welcome")).toBe(
      "archive/2025/handbook/welcome",
    );
  });

  test("composes with childPath, so a moved parent and a new child agree", () => {
    // Kills: a divergence between the two functions — different separators, or one of them
    // gaining a leading slash. They are the only two places a path is constructed, and the
    // move path runs both.
    const moved = descendantPaths(OLD, NEW, OLD);
    expect(descendantPaths(OLD, NEW, childPath(OLD, "topic-registry"))).toBe(
      childPath(moved, "topic-registry"),
    );
  });
});

describe("validatePath", () => {
  // Kills: dropping the assembled-path check entirely, on the assumption that an 80-char
  // per-slug cap bounds the path. It does not — depth is unbounded.
  test("accepts a deep path built from legal slugs", () => {
    const path = Array.from({ length: 20 }, (_, i) => `level-${i}`).join("/");
    expect(validatePath(path).ok).toBe(true);
  });

  // Kills: the exact gap the per-slug cap leaves. Every segment here passes validateSlug.
  test("rejects a path whose segments are each legal but whose total is not", () => {
    const segment = "a".repeat(SLUG_MAX_LENGTH);
    for (const s of [segment]) expect(validateSlug(s).ok).toBe(true);
    const path = Array.from({ length: 33 }, () => segment).join("/");
    const result = validatePath(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("path-too-long");
  });

  // Kills: measuring length in UTF-16 code units instead of bytes. Slugs are ASCII today,
  // but the limit Postgres enforces is bytes, and this function must not have to change if
  // the slug charset ever widens.
  test("measures bytes, not characters", () => {
    const multibyte = "é".repeat(MAX_PATH_BYTES - 10);
    expect(multibyte.length).toBeLessThan(MAX_PATH_BYTES);
    expect(validatePath(multibyte).ok).toBe(false);
  });

  // Kills: an off-by-one that rejects exactly-at-the-limit paths.
  test("accepts a path exactly at the limit and rejects one byte more", () => {
    expect(validatePath("a".repeat(MAX_PATH_BYTES)).ok).toBe(true);
    expect(validatePath("a".repeat(MAX_PATH_BYTES + 1)).ok).toBe(false);
  });
});

describe("isInSubtree", () => {
  const ROOT = "architecture/mqtt-contracts";

  // Kills: excluding the root, which is the shape `movePage` needs — its own path is the
  // first thing the cycle check has to match, or a page could be moved under itself.
  test("the root is inside its own subtree", () => {
    expect(isInSubtree(ROOT, ROOT)).toBe(true);
  });

  test("a descendant at any depth is inside it", () => {
    expect(isInSubtree(ROOT, `${ROOT}/topic-registry`)).toBe(true);
    expect(isInSubtree(ROOT, `${ROOT}/topic-registry/retained`)).toBe(true);
  });

  // Kills: `path.startsWith(root)` with no `/` boundary — the mutation this project has
  // already shipped once, on the other side of `movePage`, with all 32 tests green.
  test("a sibling whose path merely begins with the root's is not inside it", () => {
    expect(isInSubtree(ROOT, `${ROOT}-v2`)).toBe(false);
    expect(isInSubtree(ROOT, `${ROOT}-v2/topic-registry`)).toBe(false);
  });

  test("an ancestor and an unrelated page are outside it", () => {
    expect(isInSubtree(ROOT, "architecture")).toBe(false);
    expect(isInSubtree(ROOT, "handbook/welcome")).toBe(false);
  });
});

describe("descendantsOf", () => {
  // Every field is distinguishable, because a fixture whose fields all default to the same
  // value cannot catch a field mix-up — this project's own finding.
  const rows = [
    { id: "p-arch", title: "Architecture", path: "architecture" },
    { id: "p-mqtt", title: "MQTT contracts", path: "architecture/mqtt-contracts" },
    {
      id: "p-topics",
      title: "Topic registry",
      path: "architecture/mqtt-contracts/topic-registry",
    },
    {
      id: "p-retained",
      title: "Retained messages",
      path: "architecture/mqtt-contracts/topic-registry/retained",
    },
    { id: "p-v2", title: "MQTT contracts v2", path: "architecture/mqtt-contracts-v2" },
    { id: "p-welcome", title: "Welcome", path: "welcome" },
  ];

  // Kills: hardcoding a count (or a single level) in the delete confirmation. Deleting a
  // page takes its WHOLE subtree, and an editor told "1 sub-page" about a three-level
  // subtree finds out afterwards — with restore needing an admin.
  test("returns every descendant at every depth, root excluded", () => {
    expect(descendantsOf("architecture/mqtt-contracts", rows).map((r) => r.id)).toEqual([
      "p-topics",
      "p-retained",
    ]);
  });

  // Kills: `startsWith`, again, on the surface where getting it wrong names an unrelated
  // page in a delete confirmation — the worst possible place to be wrong about scope.
  test("does not claim a sibling that shares the root's prefix", () => {
    expect(descendantsOf("architecture/mqtt-contracts", rows).map((r) => r.id)).not.toContain(
      "p-v2",
    );
  });

  test("a leaf has no descendants", () => {
    expect(descendantsOf("welcome", rows)).toEqual([]);
  });

  test("ordered by path, so a parent is listed above its own children", () => {
    expect(descendantsOf("architecture", rows).map((r) => r.path)).toEqual([
      "architecture/mqtt-contracts",
      "architecture/mqtt-contracts-v2",
      "architecture/mqtt-contracts/topic-registry",
      "architecture/mqtt-contracts/topic-registry/retained",
    ]);
  });

  // Kills: mutating the caller's array. The editor route hands this the same rows it renders
  // the parent picker from, and an in-place `sort` would reorder that picker as a side effect.
  test("does not reorder the caller's array", () => {
    const original = rows.map((r) => r.id);
    descendantsOf("architecture", rows);
    expect(rows.map((r) => r.id)).toEqual(original);
  });
});
