import { expect, test } from "vitest";
import { mirrorPathOf, type MirrorPathErrorCode } from "@/lib/git/paths";

/**
 * Where a page's mirrored file goes.
 *
 * Pure — no database, no git, no filesystem — so this file runs under
 * `npx vitest run src/lib/git/paths.test.ts` without a `badam_test` connection, which matters
 * while another checkout may be holding it.
 *
 * The refusals are asserted **by code and by whole path**, never by "contains". A `toContain`
 * assertion on a path cannot fail on an escape: `/srv/badam/content/engineering/../../etc/passwd`
 * contains the root.
 *
 * Every refusal case is paired with the legal corpus below, so the file cannot pass by refusing
 * everything — the failure mode a table of rejections invites.
 */

const ROOT = "/srv/badam/content";

/** The accepted answer, or a failure naming the code, so a mistaken refusal is not a type error. */
function accept(spaceKey: string, path: string, root = ROOT) {
  const result = mirrorPathOf(root, spaceKey, path);
  if (!result.ok) throw new Error(`refused ${result.error.code}: ${result.error.message}`);
  return result;
}

/** The refusal, or a failure quoting the path it wrongly accepted. */
function reject(spaceKey: string, path: string, root = ROOT) {
  const result = mirrorPathOf(root, spaceKey, path);
  if (result.ok) throw new Error(`accepted, and wrote ${result.absolutePath}`);
  return result.error;
}

// ── The ordinary case ─────────────────────────────────────────────────────────────────────

test("a nested page lands at <root>/<space>/<path>.md", () => {
  // Kills: a swapped `spaceKey`/`path`, a missing or doubled extension, and any join that drops
  // the space directory. Whole strings, so an extra or missing segment cannot hide.
  expect(accept("engineering", "architecture/topic-registry")).toEqual({
    ok: true,
    absolutePath: "/srv/badam/content/engineering/architecture/topic-registry.md",
    repoPath: "engineering/architecture/topic-registry.md",
  });
});

test("a top-level page is one segment inside the space directory", () => {
  expect(accept("handbook", "welcome")).toEqual({
    ok: true,
    absolutePath: "/srv/badam/content/handbook/welcome.md",
    repoPath: "handbook/welcome.md",
  });
});

test("repoPath and absolutePath describe the same file", () => {
  // Task 5 stages `repoPath` and writes `absolutePath`, so the two disagreeing would commit one
  // file and write another. This asserts they agree.
  //
  // **It kills no mutant, and that is worth stating rather than leaving to be assumed.**
  // `repoPath: `${spaceKey}/${path}${MIRROR_EXTENSION}`` — re-derived from the arguments instead
  // of from the verified target — passes all 21 tests, measured. It is an *equivalent* mutant,
  // and provably so: the canonicality check has already established
  // `relative(spaceDir, target) === path`, and the one-segment check that `spaceKey` is a single
  // segment, so `relative(tree, target)` cannot be anything but `${spaceKey}/${path}`. The
  // reason to derive it from `target` anyway is not testability but that it states the layout
  // once — the equivalence is a consequence of the guards above, and it would quietly stop
  // holding if one of them were relaxed.
  const { absolutePath, repoPath } = accept("engineering", "architecture/topic-registry");
  expect(absolutePath).toBe(`${ROOT}/${repoPath}`);
});

test("a space key with a space in it is accepted, because one already exists", () => {
  // `Space.key` is unvalidated (a bare `String @unique`), and this project's own
  // `restore-route.test.ts` sets a key of `eng ops` to prove `pageHref` encodes per segment. A
  // space is legal in a filename and git takes it as one argv element, so refusing it here would
  // be this module inventing a validation rule that belongs to Phase 6's space administration.
  expect(accept("eng ops", "welcome").repoPath).toBe("eng ops/welcome.md");
});

test("a root given with a trailing slash is the same root", () => {
  // Kills: comparing against the caller's string instead of `resolve(root)`. Without the
  // normalisation, `…/content/` + `/` is `…/content//`, nothing starts with it, and every call
  // is refused as escaping — a false refusal, which for this module means a mirror that stops
  // writing for a reason that is not about the page. Measured: `refused
  // space-key-outside-root: … it resolves to "/srv/badam/content/engineering", which is not below
  // "/srv/badam/content/./"`, which is the refusal reading as nonsense that a false one does.
  expect(accept("engineering", "welcome", `${ROOT}/`)).toEqual(
    accept("engineering", "welcome", `${ROOT}/./`),
  );
  expect(accept("engineering", "welcome", `${ROOT}/`).absolutePath).toBe(
    "/srv/badam/content/engineering/welcome.md",
  );
});

// ── The things that escape ────────────────────────────────────────────────────────────────

test("`..` as a path is refused, not turned into a file called `...md`", () => {
  // **The case the containment check exists for, and the one that pins the order of two lines.**
  //
  // Kills: deleting the `isStrictlyBelow(spaceDir, target)` check. Measured — 7 of the 21 tests
  // fail, and this one fails with `accepted, and wrote /srv/badam/content.md`: the working tree
  // root itself, turned into a sibling file beside the repository.
  //
  // Kills also the natural *order* mutation, appending `.md` before resolving, which is the more
  // interesting of the two because it defeats a containment check that is still there. `".." +
  // ".md"` is `"...md"`, a legal filename that resolves happily **inside** the space directory,
  // so containment sees nothing wrong. Measured: this test then fails with
  // `accepted, and wrote /srv/badam/content/engineering/...md`, and the empty path becomes
  // `/…/engineering/.md`. That is the sanitise-instead-of-refuse failure arriving by accident.
  const error = reject("engineering", "..");
  expect(error.code).toBe("path-outside-space");
  expect(error.message).toContain('"/srv/badam/content"');
});

test("a traversal that leaves the tree entirely is refused", () => {
  expect(reject("engineering", "../../../../etc/passwd").code).toBe("path-outside-space");
  expect(reject("engineering", "../other-space/welcome").code).toBe("path-outside-space");
});

test("a sibling space is as much an escape as a sibling of the tree", () => {
  // Containment is verified against the **space** directory, not only against the root, and this
  // is the case that separates the two: `../handbook/welcome` never leaves `content/`, so a check
  // that only asked "is it under the root" would accept it — and one space's publish would
  // overwrite another space's file, in a mirror where nothing looks wrong.
  //
  // Kills: `isStrictlyBelow(tree, target)` in place of `isStrictlyBelow(spaceDir, target)`
  // (measured: 5 tests fail, this one with `accepted, and wrote …/handbook/welcome.md`).
  const error = reject("engineering", "../handbook/welcome");
  expect(error.code).toBe("path-outside-space");
  expect(error.message).toContain('"/srv/badam/content/handbook/welcome"');

  // The **prefix** half of the same boundary, which the escapes above cannot see: a space named
  // `engineering-v2` starts with `engineering`, so a containment test written as a bare
  // `startsWith(parent)` accepts a page written into it. That is the off-by-one this project has
  // already had in `movePage` — the `LIKE` pattern refused to drag `mqtt-contracts-v2` along
  // while a separate `startsWith` called it a descendant, and all 32 tests passed.
  //
  // Kills: dropping the separator from `isStrictlyBelow`. Measured: without this case that
  // mutation still dies on the empty-path and `.` cases, so the prefix boundary itself was
  // untested — the same shape of gap, one function later.
  expect(reject("engineering", "../engineering-v2/welcome").code).toBe("path-outside-space");
});

test("an absolute path is refused rather than joined", () => {
  // No separate "is it absolute" check exists, deliberately: `path.resolve` discards the base for
  // an absolute second argument, so containment already sees `/etc/passwd` leave the tree. A
  // second predicate would mean the containment check could be deleted with the suite green —
  // this project's `resolveRedirect` lesson.
  expect(reject("engineering", "/etc/passwd").code).toBe("path-outside-space");
});

test("an empty path resolves to the space directory itself, and says so", () => {
  // The message distinguishes "is the directory" from "is outside it" under one code, because a
  // code is what a caller switches on and neither shape is recoverable.
  const error = reject("engineering", "");
  expect(error.code).toBe("path-outside-space");
  expect(error.message).toContain("the space directory itself");

  expect(reject("engineering", ".").code).toBe("path-outside-space");
});

test("a path that resolves inside but is not what it says is refused", () => {
  // The shapes containment **cannot** see, because they never leave the space directory. `a/../b`
  // is the interesting one: a real `..`, resolving to a legal location, which a containment-only
  // implementation accepts and writes as `b.md` — a file whose name no query for `Page.path`
  // finds. Refusing keeps the filename derivable from the row.
  //
  // Kills: dropping the `relative(spaceDir, target) !== path` check — measured, 3 tests fail
  // (this one, the table of escapes, and the class property), and all three see it through these
  // same four shapes. No other shape in the file catches it.
  expect(reject("engineering", "architecture/").code).toBe("path-not-canonical");
  expect(reject("engineering", "architecture//topic-registry").code).toBe("path-not-canonical");
  expect(reject("engineering", "architecture/./topic-registry").code).toBe("path-not-canonical");

  const error = reject("engineering", "architecture/../topic-registry");
  expect(error.code).toBe("path-not-canonical");
  expect(error.message).toContain('"topic-registry"');
});

test("a space key containing a separator is refused", () => {
  // Not an escape — `a/b` stays inside the tree — which is exactly why it needs its own check:
  // containment accepts it, and it puts the space one directory deeper than the layout says, so
  // space `a` with a page `b/welcome` and space `a/b` with a page `welcome` are one file.
  //
  // Kills: dropping the one-segment check. `\` is refused with it because `path.resolve` treats
  // it as a separator on Windows, which would make the layout platform-dependent.
  expect(reject("a/b", "welcome").code).toBe("space-key-not-one-segment");
  expect(reject("..\\..", "welcome").code).toBe("space-key-not-one-segment");
  expect(reject("../elsewhere", "welcome").code).toBe("space-key-not-one-segment");
});

test("a space key that moves the space directory is refused", () => {
  // `..` and `.` contain no separator, so the check above cannot see them: `..` would put the
  // whole space *beside* the working tree, outside the repository git commits from.
  //
  // Kills: dropping the `isStrictlyBelow(tree, spaceDir)` check — without it a key of `..`
  // resolves the space to `/srv/badam` and every containment test below it still passes, because
  // the page really is inside its (escaped) space directory.
  expect(reject("..", "welcome").code).toBe("space-key-outside-root");
  expect(reject(".", "welcome").code).toBe("space-key-outside-root");
  expect(reject("", "welcome").code).toBe("space-key-outside-root");
});

test("a relative root is refused rather than completed against the cwd", () => {
  // The one refusal that is a caller's bug rather than a row's. `path.resolve("content", …)`
  // silently answers from `process.cwd()`, which makes the mirrored location depend on where the
  // worker was started — a value no test and no caller can see.
  //
  // Kills: dropping the check. Measured, and the failure names the problem better than any
  // sentence could: `accepted, and wrote /Users/fahmi/badam-hijau/content/engineering/welcome.md`,
  // which is the *application's* checkout on the machine that ran the suite.
  const error = reject("engineering", "welcome", "content");
  expect(error.code).toBe("root-not-absolute");
  expect(error.message).toContain('"content"');
});

test("an interpolated value reaches a log as escapes, not as literals", () => {
  // Control characters are not stripped from `Space.key` anywhere, and this message ends up in
  // `GitJob.lastError` and in a log line. `JSON.stringify` is what keeps a newline from breaking
  // the line it is reported on — the project's "escapes, never literals" rule, on the output side.
  const error = reject("eng\nops/x", "welcome");
  expect(error.code).toBe("space-key-not-one-segment");
  expect(error.message).toContain('"eng\\nops/x"');
  expect(error.message).not.toContain("\n");
});

// ── The class, and the non-vacuity that makes the table above mean something ───────────────

/**
 * Legal inputs, so the refusals are discriminating and not this file's default answer.
 *
 * Some of these are shapes `validateSlug` would refuse — a leading hyphen, dots inside a segment
 * — and they belong here deliberately: this module is not a second slug validator, and adding one
 * would be the same predicate stated in two places. It refuses what makes the *location* wrong,
 * and nothing else.
 */
const LEGAL: ReadonlyArray<[string, string]> = [
  ["engineering", "welcome"],
  ["engineering", "architecture/topic-registry"],
  ["engineering", "a/b/c/d/e/f"],
  ["handbook", "welcome"],
  ["eng ops", "welcome"],
  ["engineering", "..a"],
  ["engineering", "a..b"],
  ["engineering", "-".repeat(80)],
];

/** Every escape shape, with the code that catches it. */
const REFUSED: ReadonlyArray<[string, string, MirrorPathErrorCode]> = [
  ["engineering", "..", "path-outside-space"],
  ["engineering", "../..", "path-outside-space"],
  ["engineering", "../../../../etc/passwd", "path-outside-space"],
  ["engineering", "/etc/passwd", "path-outside-space"],
  ["engineering", "//etc/passwd", "path-outside-space"],
  ["engineering", ".", "path-outside-space"],
  ["engineering", "", "path-outside-space"],
  ["engineering", "..//x", "path-outside-space"],
  ["engineering", "../engineering-v2/welcome", "path-outside-space"],
  ["engineering", "a/", "path-not-canonical"],
  ["engineering", "a//b", "path-not-canonical"],
  ["engineering", "a/./b", "path-not-canonical"],
  ["engineering", "a/../b", "path-not-canonical"],
  ["engineering", "./a", "path-not-canonical"],
  ["a/b", "welcome", "space-key-not-one-segment"],
  ["a\\b", "welcome", "space-key-not-one-segment"],
  ["..", "welcome", "space-key-outside-root"],
  [".", "welcome", "space-key-outside-root"],
  ["", "welcome", "space-key-outside-root"],
];

test("every escape shape is refused, with the code that names why", () => {
  for (const [spaceKey, path, code] of REFUSED) {
    expect({ spaceKey, path, code: reject(spaceKey, path).code }).toEqual({
      spaceKey,
      path,
      code,
    });
  }
});

test("the legal corpus is accepted, so the refusals above discriminate", () => {
  // The non-vacuity companion. Without it the whole file passes with
  // `return refuse("path-outside-space", "")` as the entire implementation.
  for (const [spaceKey, path] of LEGAL) {
    expect(accept(spaceKey, path).repoPath).toBe(`${spaceKey}/${path}.md`);
  }
});

test("no accepted path is ever outside the working tree", () => {
  // The class, asserted over both corpora rather than over the legal one — Phase 1's lesson that
  // a guard checked against a friendly fixture is testing the fixture. Injecting the hostile
  // corpus is what makes this a property and not a restatement of the table.
  let accepted = 0;
  let refused = 0;
  for (const [spaceKey, path] of [...LEGAL, ...REFUSED.map(([k, p]) => [k, p] as const)]) {
    const result = mirrorPathOf(ROOT, spaceKey, path);
    if (!result.ok) {
      refused += 1;
      continue;
    }
    accepted += 1;
    expect(result.absolutePath.startsWith(`${ROOT}/`)).toBe(true);
    expect(result.absolutePath).not.toContain("/../");
    expect(result.absolutePath.endsWith(".md")).toBe(true);
  }

  // Non-vacuity in both directions: the property is over a corpus that really contains accepted
  // and refused inputs, so it cannot pass because nothing reached the assertions.
  expect(accepted).toBe(LEGAL.length);
  expect(refused).toBe(REFUSED.length);
});

// ── Byte faithfulness ─────────────────────────────────────────────────────────────────────

test("case is neither folded nor refused, and the hazard is the filesystem's", () => {
  // Measured on this machine: APFS is case-insensitive, so `Engineering` and `engineering` —
  // two distinct rows, since `Space.key` is `@unique` and Postgres compares bytes — share one
  // directory on macOS and are two on Linux.
  //
  // This module still does not fold, because a collision is a property of **two** keys and this
  // function sees one: refusing uppercase would close the ASCII half of the class and leave
  // NFC/NFD and every other fold open, which is this project's most repeated failure. The check
  // that closes it is a folded uniqueness constraint where space keys are created — Phase 6.
  //
  // Kills: a `toLowerCase()` anywhere in the assembly, which would silently mirror two spaces to
  // one path on **every** filesystem.
  expect(accept("Engineering", "welcome").repoPath).toBe("Engineering/welcome.md");
  expect(accept("engineering", "welcome").repoPath).toBe("engineering/welcome.md");
});

test("Unicode is passed through in the bytes it arrived in", () => {
  // The same argument as case, and the same measurement: APFS is normalisation-insensitive but
  // byte-*preserving* — a file written NFC is found under NFD, and `readdir` returns the NFC
  // bytes. (APFS does not convert to NFD; HFS+ did, which is where the folklore comes from.)
  //
  // Kills: a `.normalize()` in the assembly. Written as escapes rather than as composed
  // characters so the two forms are visibly different in the source.
  // Annotated `string`, or TypeScript narrows both to literal types and calls the comparison
  // below unintentional — which is the compiler telling the truth about two *different* literals.
  const nfc: string = "caf\u00e9";
  const nfd: string = "cafe\u0301";
  expect(nfc === nfd).toBe(false);
  expect(nfc.normalize("NFD")).toBe(nfd);

  expect(accept(nfc, "welcome").repoPath).toBe(`${nfc}/welcome.md`);
  expect(accept(nfd, "welcome").repoPath).toBe(`${nfd}/welcome.md`);
  expect(accept(nfc, "welcome").repoPath).not.toBe(accept(nfd, "welcome").repoPath);
});

test("a maximally long path is not this module's to refuse", () => {
  // Stated as a test because it is a decision, not an omission. `MAX_PATH_BYTES` is 2000 and
  // `.md` adds three, while `getconf PATH_MAX /` measures **1024** on darwin against 4096 on
  // Linux — so a legal deep page can exceed `PATH_MAX` on a developer's Mac and not in
  // production. The limit belongs to the filesystem the tree is on: the write in Task 5 gets an
  // `ENAMETOOLONG` carrying the real number, and that is a job retry rather than a claim that the
  // page is malformed. A guessed cap here would refuse a page that published fine.
  const deep = Array.from({ length: 33 }, () => "x".repeat(60)).join("/");
  expect(deep.length).toBeGreaterThan(1024);

  const result = accept("engineering", deep);
  expect(result.absolutePath.length).toBeGreaterThan(1024);
  expect(result.repoPath).toBe(`engineering/${deep}.md`);
});
