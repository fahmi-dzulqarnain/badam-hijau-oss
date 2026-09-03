import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeScratchDirs, scratch } from "../../../tests/setup/scratch";
import {
  ALLOWED_ENV,
  DEFAULT_LOCAL_TIMEOUT_MS,
  DEFAULT_NETWORK_TIMEOUT_MS,
  commit,
  ensureRepository,
  gitConfigFromEnv,
  headSha,
  mirrorCommitMessage,
  push,
  runGit,
  stageDelete,
  stageMove,
  stageWrite,
  type GitConfig,
} from "@/lib/git/repo";

/**
 * The git seam, against real repositories.
 *
 * **Every repository in this file lives in `os.tmpdir()` and is removed by the test that made
 * it.** Nothing here runs git against the project checkout, and {@link tree} asserts that rather
 * than trusting it — this is a test file for code that spawns `git` inside a git repository, and
 * a working directory that quietly resolved to the repo root would commit the suite's fixtures
 * into the branch it is running on.
 *
 * These are integration tests in everything but name: they spawn subprocesses and touch a
 * filesystem. They need **no database**, so `npx vitest run src/lib/git/repo.test.ts` is
 * trustworthy while another checkout holds `badam_p5_test`.
 *
 * Control characters are written as **escapes** throughout (`\n`, `\t`), never as literals. A
 * literal NUL in `publish.ts` once made `rg` classify a whole module as binary and skip it.
 */

// `scratch` moved to `tests/setup/scratch.ts` when Task 6 needed the identical guarantee from
// `tests/integration/git-worker.test.ts`. Shared rather than copied: a rule implemented in two
// places is not yet a convention, and this one is "never run git inside the project checkout".
afterEach(removeScratchDirs);

/** A config whose root is a fresh temporary directory. Timeouts are short so a bug is not a hang. */
async function config(overrides: Partial<GitConfig> = {}): Promise<GitConfig> {
  return {
    root: await scratch("tree"),
    remoteUrl: null,
    branch: "main",
    committer: { name: "Badam Service", email: "service@badam.test" },
    authorFallback: { name: "Badam Fallback", email: "fallback@badam.test" },
    localTimeoutMs: 15_000,
    networkTimeoutMs: 15_000,
    binary: "git",
    ...overrides,
  };
}

/**
 * A repository at `config.root`, initialised and ready to be written to.
 *
 * The `init` runs with **no remote**, whatever the overrides say, so that a test about pushing
 * gets a local repository plus a remote to push at rather than a clone of one.
 */
async function tree(overrides: Partial<GitConfig> = {}): Promise<GitConfig> {
  const cfg = await config(overrides);
  const ensured = await ensureRepository({ ...cfg, remoteUrl: null });
  expect(ensured).toEqual({ ok: true, state: "initialised" });
  return cfg;
}

/** A bare repository to push at. No network: a local path is a real remote to git. */
async function bareRemote(): Promise<string> {
  const dir = await scratch("remote");
  const path = join(dir, "content.git");
  const cfg = await config({ root: dir });
  const run = await runGit(cfg, ["init", "--bare", "--initial-branch", "main", "--", path], {
    cwd: dir,
  });
  expect(run.ok).toBe(true);
  return path;
}

/** `git log` on one field, so an assertion names the field rather than parsing a paragraph. */
async function log(cfg: GitConfig, format: string, args: string[] = []): Promise<string> {
  const run = await runGit(cfg, ["log", `--format=${format}`, ...args]);
  if (!run.ok) throw new Error(`git log failed: ${run.stderr}${run.stdout}`);
  return run.stdout.trim();
}

async function commitCount(cfg: GitConfig): Promise<number> {
  const run = await runGit(cfg, ["rev-list", "--count", "HEAD"]);
  if (!run.ok) throw new Error(`rev-list failed: ${run.stderr}`);
  return Number(run.stdout.trim());
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const REF = { spaceKey: "engineering", path: "architecture/topic-registry" };
const PUBLISHER = { name: "Aisyah", email: "aisyah@example.com" };

/**
 * The hostile title `e2e/lifecycle.spec.ts` and `e2e/search.spec.ts` both carry, plus the half
 * this task is about: an **interior newline** followed by a line that looks like a YAML key.
 * `stripControl` keeps `\n`, and `publishPage` only trims the ends, so this is a value
 * `PageVersion.title` can genuinely hold.
 */
const HOSTILE_TITLE = `<img src=x onerror="document.title='pwned'">${"x".repeat(250)}\nstatus: ACCEPTED\t-not a flag`;

// ── gitConfigFromEnv: §17's variables, read in one place ──────────────────────────────────────

test("gitConfigFromEnv defaults every value and needs no environment at all", () => {
  const cfg = gitConfigFromEnv({});
  expect(cfg.remoteUrl).toBeNull();
  expect(cfg.branch).toBe("main");
  expect(cfg.binary).toBe("git");
  expect(cfg.localTimeoutMs).toBe(DEFAULT_LOCAL_TIMEOUT_MS);
  expect(cfg.networkTimeoutMs).toBe(DEFAULT_NETWORK_TIMEOUT_MS);
  // Absolute, because `mirrorPathOf` refuses a relative root outright.
  expect(cfg.root).toBe(resolve("content"));
});

test("gitConfigFromEnv reads §17's variables", () => {
  const cfg = gitConfigFromEnv({
    GIT_MIRROR_ROOT: "/srv/badam/content",
    GIT_REMOTE_URL: "git@example.com:docs/content.git",
    GIT_MIRROR_BRANCH: "mirror",
    GIT_COMMITTER_NAME: "Docs Bot",
    GIT_COMMITTER_EMAIL: "bot@example.com",
    GIT_AUTHOR_FALLBACK_NAME: "Unknown Publisher",
    GIT_AUTHOR_FALLBACK_EMAIL: "nobody@example.com",
    GIT_NETWORK_TIMEOUT_MS: "5000",
  });
  expect(cfg).toEqual({
    root: "/srv/badam/content",
    remoteUrl: "git@example.com:docs/content.git",
    branch: "mirror",
    committer: { name: "Docs Bot", email: "bot@example.com" },
    authorFallback: { name: "Unknown Publisher", email: "nobody@example.com" },
    localTimeoutMs: DEFAULT_LOCAL_TIMEOUT_MS,
    networkTimeoutMs: 5000,
    binary: "git",
  });
});

test("a zero, negative or unparseable timeout falls back rather than disabling the ceiling", () => {
  // `0` is the dangerous one: it is falsy, it is a number, and "no ceiling" is exactly the
  // wedged worker the ceiling exists to prevent.
  for (const raw of ["0", "-1", "", "   ", "soon", "NaN"]) {
    expect(gitConfigFromEnv({ GIT_NETWORK_TIMEOUT_MS: raw }).networkTimeoutMs).toBe(
      DEFAULT_NETWORK_TIMEOUT_MS,
    );
  }
  // Non-vacuity: the reader can see a value when there is one.
  expect(gitConfigFromEnv({ GIT_NETWORK_TIMEOUT_MS: "1234" }).networkTimeoutMs).toBe(1234);
});

// ── runGit: the exit status is captured, not hidden ───────────────────────────────────────────

test("a fresh repository answers 128 to rev-parse HEAD, rev-parse --verify HEAD and log -1", async () => {
  // The plan's measurement, asserted rather than rediscovered — and asserted *through the seam*,
  // because the way this was originally missed was a pipeline (`git rev-parse HEAD | head -2`)
  // reporting `head`'s status and printing the word HEAD over a fatal error.
  const cfg = await tree();

  for (const args of [["rev-parse", "HEAD"], ["rev-parse", "--verify", "HEAD"], ["log", "-1"]]) {
    const run = await runGit(cfg, args);
    expect({ args, ok: run.ok, code: run.code }).toEqual({ args, ok: false, code: 128 });
    expect(run.stderr).toContain("fatal:");
  }

  // Non-vacuity: the same helper reports success as success, so the block above is not passing
  // because every invocation fails.
  const ok = await runGit(cfg, ["rev-parse", "--is-inside-work-tree"]);
  expect({ ok: ok.ok, code: ok.code, stdout: ok.stdout.trim() }).toEqual({
    ok: true,
    code: 0,
    stdout: "true",
  });
});

test("runGit reports a missing binary as a spawn error rather than throwing", async () => {
  const cfg = await config({ binary: "git-that-does-not-exist" });
  await mkdir(cfg.root, { recursive: true });
  const run = await runGit(cfg, ["status"]);
  expect(run.ok).toBe(false);
  expect(run.spawnError).toContain("ENOENT");
});

// ── The child's environment ───────────────────────────────────────────────────────────────────

test("the child environment is an allowlist: LC_ALL=C, literal pathspecs, no inherited leakage", async () => {
  // Asserted through the seam by pointing `binary` at a shell, which is the only way to read the
  // environment a spawned child actually received. `GIT_DIR` is the variable that matters: in the
  // operator's shell it silently redirects every command in this module.
  const cfg = await config({ binary: "/bin/sh" });
  const before = { gitDir: process.env.GIT_DIR, marker: process.env.BADAM_TEST_MARKER };
  process.env.GIT_DIR = "/nowhere/.git";
  process.env.BADAM_TEST_MARKER = "leaked";
  try {
    const run = await runGit(
      cfg,
      ["-c", 'printf "%s|%s|%s|%s|%s" "$LC_ALL" "$LANG" "$GIT_LITERAL_PATHSPECS" "${GIT_DIR-unset}" "${BADAM_TEST_MARKER-unset}"'],
      { cwd: cfg.root },
    );
    expect(run.stdout).toBe("C|C|1|unset|unset");
  } finally {
    if (before.gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before.gitDir;
    if (before.marker === undefined) delete process.env.BADAM_TEST_MARKER;
    else process.env.BADAM_TEST_MARKER = before.marker;
  }

  // The allowlist is the complete pass-through list, and PATH has to be on it or `spawn` cannot
  // find the binary at all.
  expect([...ALLOWED_ENV]).toEqual(["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"]);
});

test("an inherited GIT_AUTHOR_NAME cannot rewrite who a commit is attributed to", async () => {
  const cfg = await tree();
  const before = process.env.GIT_AUTHOR_NAME;
  process.env.GIT_AUTHOR_NAME = "Somebody Else";
  try {
    expect((await stageWrite(cfg, REF, "# one\n")).ok).toBe(true);
    const done = await commit(cfg, { message: "one", author: PUBLISHER });
    expect(done.ok).toBe(true);
    expect(await log(cfg, "%an")).toBe("Aisyah");
  } finally {
    if (before === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = before;
  }
});

// ── ensureRepository ──────────────────────────────────────────────────────────────────────────

test("with no remote the repository is initialised, on the branch this machine's git defaults to", async () => {
  const cfg = await config();
  expect(await ensureRepository(cfg)).toEqual({ ok: true, state: "initialised" });
  const branch = await runGit(cfg, ["branch", "--show-current"]);
  expect(branch.stdout.trim()).toBe("main");

  // Idempotent: a second call finds the tree and does nothing.
  expect(await ensureRepository(cfg)).toEqual({ ok: true, state: "existing" });
});

test("with a remote configured the repository is cloned, and an empty remote is not an error", async () => {
  const remoteUrl = await bareRemote();
  const parent = await scratch("clone");
  const cfg = await config({ root: join(parent, "content"), remoteUrl });

  expect(await ensureRepository(cfg)).toEqual({ ok: true, state: "cloned" });
  expect(await exists(join(cfg.root, ".git"))).toBe(true);
  // A clone of an empty remote has no HEAD to resolve — the state §17's "re-cloned on start"
  // produces on every deploy of a brand new mirror.
  expect(await headSha(cfg)).toEqual({ ok: true, sha: null });
});

test("a directory nested inside another repository is refused, not adopted", async () => {
  // The trap this closes is specific and this project is standing in it: `content/` lives inside
  // the application's own checkout, and `git rev-parse --show-toplevel` run in a subdirectory
  // answers with the **ancestor's** root. A boolean "is this a repository?" check would say yes
  // and then commit every mirrored page into the application's source repository.
  const outer = await tree();
  const nested = join(outer.root, "content");
  await mkdir(nested, { recursive: true });
  const cfg = await config({ root: nested });

  const result = await ensureRepository(cfg);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("not-a-repository");
  expect(result.error.message).toContain(outer.root);

  // Non-vacuity, and the discrimination: the same directory *is* accepted once it is a
  // repository root in its own right, so the refusal is about nesting and not about the path.
  expect(await ensureRepository({ ...cfg, root: outer.root })).toEqual({ ok: true, state: "existing" });
});

// ── headSha ───────────────────────────────────────────────────────────────────────────────────

test("headSha reports an empty repository as no commits, and a real sha once there is one", async () => {
  const cfg = await tree();
  expect(await headSha(cfg)).toEqual({ ok: true, sha: null });

  expect((await stageWrite(cfg, REF, "# one\n")).ok).toBe(true);
  const done = await commit(cfg, { message: "one", author: PUBLISHER });
  expect(done.ok && done.committed).toBe(true);

  const head = await headSha(cfg);
  expect(head.ok).toBe(true);
  if (!head.ok) throw new Error("unreachable");
  expect(head.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(head.sha).toBe(await log(cfg, "%H", ["-1"]));
});

test("headSha does not absorb 'not a repository' — only 'no commits'", async () => {
  // The discrimination `--quiet` buys. Without it both are exit 128 and a seam that mapped 128 to
  // `null` would report a missing working tree as an empty one, and the worker would commit into
  // nothing forever.
  const cfg = await config();
  await mkdir(cfg.root, { recursive: true });
  const result = await headSha(cfg);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("git-failed");
  expect(result.error.run?.code).toBe(128);
});

// ── Writing, moving, deleting ─────────────────────────────────────────────────────────────────

test("stageWrite puts the file at <space>/<path>.md and stages it", async () => {
  const cfg = await tree();
  const written = await stageWrite(cfg, REF, "# hello\n");
  expect(written).toEqual({ ok: true, repoPath: "engineering/architecture/topic-registry.md" });

  expect(await readFile(join(cfg.root, "engineering/architecture/topic-registry.md"), "utf8")).toBe(
    "# hello\n",
  );
  const staged = await runGit(cfg, ["diff", "--cached", "--name-only"]);
  expect(staged.stdout.trim()).toBe("engineering/architecture/topic-registry.md");
});

test("a path that escapes the space directory is refused, and nothing is written", async () => {
  const cfg = await tree();
  const result = await stageWrite(cfg, { spaceKey: "engineering", path: "../handbook/welcome" }, "x\n");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("path-refused");

  // The absence assertion, and it is about the whole tree rather than one guessed filename: git
  // sees every file in the working tree, so this cannot miss an escape that landed somewhere the
  // test did not think to look.
  const files = await runGit(cfg, ["status", "--porcelain"]);
  expect(files.stdout).toBe("");

  // Its non-vacuity companion: the same helper, one path further in, does write and does stage —
  // so the emptiness above is the refusal and not an inert function.
  expect((await stageWrite(cfg, { spaceKey: "engineering", path: "handbook/welcome" }, "x\n")).ok).toBe(
    true,
  );
  const after = await runGit(cfg, ["status", "--porcelain"]);
  expect(after.stdout.trim()).toBe("A  engineering/handbook/welcome.md");
});

test("a space key that is pathspec magic is treated as a filename", async () => {
  // `Space.key` has no validation anywhere (`paths.ts` documents the measurement), and a leading
  // `:` is git's pathspec magic prefix. Without `GIT_LITERAL_PATHSPECS=1` the `git add` below
  // fails with `Invalid pathspec magic`, so this kills that mutant rather than characterising it.
  const cfg = await tree();
  const written = await stageWrite(cfg, { spaceKey: ":odd", path: "welcome" }, "x\n");
  expect(written).toEqual({ ok: true, repoPath: ":odd/welcome.md" });
  const staged = await runGit(cfg, ["diff", "--cached", "--name-only", "-z"]);
  expect(staged.stdout).toBe(":odd/welcome.md\u0000");
});

test("a move renames the tracked file, and running it twice is not a failure", async () => {
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);

  const to = { spaceKey: "engineering", path: "reference/topic-registry" };
  expect(await stageMove(cfg, REF, to)).toEqual({
    ok: true,
    from: "engineering/architecture/topic-registry.md",
    to: "engineering/reference/topic-registry.md",
    moved: true,
  });
  expect(await exists(join(cfg.root, "engineering/architecture/topic-registry.md"))).toBe(false);
  expect(await readFile(join(cfg.root, "engineering/reference/topic-registry.md"), "utf8")).toBe(
    "# body\n",
  );

  // The retry. `git mv` on a missing source exits 128 (`fatal: bad source`), so a seam that did
  // not ask the index first would turn every re-run into a permanently FAILED job.
  expect(await stageMove(cfg, REF, to)).toEqual({
    ok: true,
    from: "engineering/architecture/topic-registry.md",
    to: "engineering/reference/topic-registry.md",
    moved: false,
  });
});

test("a delete removes the tracked file, and running it twice is not a failure", async () => {
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);

  expect(await stageDelete(cfg, REF)).toEqual({
    ok: true,
    repoPath: "engineering/architecture/topic-registry.md",
    removed: true,
  });
  expect(await exists(join(cfg.root, "engineering/architecture/topic-registry.md"))).toBe(false);

  expect(await stageDelete(cfg, REF)).toEqual({
    ok: true,
    repoPath: "engineering/architecture/topic-registry.md",
    removed: false,
  });
});

// ── Commit: identity ──────────────────────────────────────────────────────────────────────────

test("the publisher is the author and the service is the committer", async () => {
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);
  expect(await log(cfg, "%an|%ae|%cn|%ce")).toBe(
    "Aisyah|aisyah@example.com|Badam Service|service@badam.test",
  );
});

test("a blank publisher name or email falls back rather than failing the job forever", async () => {
  // Not cosmetic: `User.name` is nullable, and git refuses an empty ident outright.
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const done = await commit(cfg, { message: "one", author: { name: "   ", email: "" } });
  expect(done.ok).toBe(true);
  expect(await log(cfg, "%an|%ae")).toBe("Badam Fallback|fallback@badam.test");
});

test("a GIT_AUTHOR_NAME that looks like an option is stored as a name and not parsed as one", async () => {
  // The plan's measurement, pinned — **and it kills no mutant, which is worth saying rather than
  // leaving to be assumed.** The plan asks for this assertion so that "a later refactor to
  // `--author=` string building fails here", and that turns out to be the wrong reason:
  // `--author=--upload-pack=touch /x` is still a single argv element whose content is a value, so
  // the `--author=` refactor was built and this test stayed green (all 30 did). The mutant that
  // *is* killed is one that puts the name in argv as its **own** element — and even that one git
  // consumes as `--author`'s argument. The assertion that discriminates between the two channels
  // is the next test, and this one is a characterisation of git's option parsing.
  const cfg = await tree();
  const probe = join(await scratch("probe"), "pwned");
  const hostile = { name: `--upload-pack=touch ${probe}`, email: "attacker@example.com" };

  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const done = await commit(cfg, { message: "one", author: hostile });
  expect(done.ok).toBe(true);

  // Stored verbatim, as a name.
  expect(await log(cfg, "%an")).toBe(hostile.name);
  // And nothing ran. The absence assertion.
  expect(await exists(probe)).toBe(false);

  // Its non-vacuity companion: the probe path is one a `touch` really would create, so the
  // absence above is git refusing to be an option parser and not an unwritable directory.
  await writeFile(probe, "");
  expect(await exists(probe)).toBe(true);
  await rm(probe);
});

test("a publisher whose name contains an address cannot make git record that address", async () => {
  // **This is the test the `--author=` refactor fails, and finding it corrected the plan.**
  //
  // Measured, on the two channels, with the same two values:
  //
  // - `GIT_AUTHOR_NAME='Evil <ceo@example.com>'`, `GIT_AUTHOR_EMAIL='publisher@example.com'` →
  //   `%an` is `Evil ceo@example.com` (git strips the angle brackets from a name) and `%ae` is
  //   `publisher@example.com`. The two fields cannot cross, because they are two variables.
  // - `--author=Evil <ceo@example.com> <publisher@example.com>` → `%an` is `Evil` and `%ae` is
  //   **`ceo@example.com`**. git splits on the *first* `<`, so the name has overwritten the email.
  //
  // That is not cosmetic: the author email is what a git host matches to an account, and
  // `User.name` comes from the OIDC provider's profile. A display name is not a place from which
  // someone should be able to choose whose commits these are.
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const done = await commit(cfg, {
    message: "one",
    author: { name: "Evil <ceo@example.com>", email: "publisher@example.com" },
  });
  expect(done.ok).toBe(true);

  expect(await log(cfg, "%ae")).toBe("publisher@example.com");
  expect(await log(cfg, "%an")).toBe("Evil ceo@example.com");
});

// ── Commit: the message ───────────────────────────────────────────────────────────────────────

test("the commit subject is machine-derived and the hostile title cannot forge a line", async () => {
  const cfg = await tree();
  const message = mirrorCommitMessage({
    kind: "PUBLISH",
    ref: REF,
    title: HOSTILE_TITLE,
    versionId: "clv0000000000000000000000",
  });
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message, author: PUBLISHER })).ok).toBe(true);

  // One subject line, and it names the kind and the address — never the title. A `%s` that
  // contained the title would put 300 characters of markup into every `--oneline` and every
  // notification a git host sends.
  expect(await log(cfg, "%s")).toBe('Publish "engineering/architecture/topic-registry"');

  // The title is in the body, quoted, so its interior newline is `\n` and cannot become a line
  // of its own. A "the message contains the title" assertion cannot fail on that; this can.
  const body = await log(cfg, "%b");
  expect(body.split("\n")).toEqual([
    `Title: ${JSON.stringify(HOSTILE_TITLE)}`,
    'Version: "clv0000000000000000000000"',
  ]);
  expect(body).not.toContain("\nstatus: ACCEPTED");
});

test("a move's subject names both addresses, and a publisher's note is quoted too", () => {
  expect(
    mirrorCommitMessage({
      kind: "MOVE",
      previous: REF,
      ref: { spaceKey: "engineering", path: "reference/topic-registry" },
    }),
  ).toBe(
    'Move "engineering/architecture/topic-registry" to "engineering/reference/topic-registry"\n',
  );

  expect(
    mirrorCommitMessage({ kind: "DELETE", ref: REF, note: "Retired\nSubject: forged" }),
  ).toBe(
    'Delete "engineering/architecture/topic-registry"\n\nNote: "Retired\\nSubject: forged"\n',
  );

  // An absent or blank note adds no line at all, rather than an empty `Note:`.
  expect(mirrorCommitMessage({ kind: "RESTORE", ref: REF, note: "   " })).toBe(
    'Restore "engineering/architecture/topic-registry"\n',
  );
});

// ── Commit: nothing to commit ─────────────────────────────────────────────────────────────────

test("a commit that changes nothing is a success carrying HEAD, not a failure", async () => {
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const first = await commit(cfg, { message: "one", author: PUBLISHER });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.committed).toBe(true);

  // The retry: the same job runs again, writes the same bytes, stages them, and finds a clean
  // index. git's own answer here is exit **1** with `nothing to commit, working tree clean` on
  // **stdout** and an empty stderr — a failure a seam that only read stderr would report as the
  // empty string.
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const again = await commit(cfg, { message: "one", author: PUBLISHER });
  expect(again).toEqual({ ok: true, committed: false, sha: first.sha });

  // And it created nothing: the sha the worker would record is the commit that really does
  // contain these bytes.
  expect(await commitCount(cfg)).toBe(1);
});

test("nothing to commit in a repository with no commits at all reports no sha", async () => {
  const cfg = await tree();
  expect(await commit(cfg, { message: "empty", author: PUBLISHER })).toEqual({
    ok: true,
    committed: false,
    sha: null,
  });
});

test("git's own nothing-to-commit is exit 1 with the message on stdout, not stderr", async () => {
  // Pinned because it is the fact the seam's design rests on, and because it is the half that
  // surprises: an error message built from stderr would be blank.
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);

  const run = await runGit(cfg, ["commit", "-m", "again"]);
  expect(run.code).toBe(1);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("nothing to commit");
});

// ── Push ──────────────────────────────────────────────────────────────────────────────────────

test("push with no remote configured is a success that says it pushed nothing", async () => {
  // §19: a remote is optional. Reporting this as a failure would put every job on the failed-jobs
  // page in exactly the deployment that has no remote to fix.
  const cfg = await tree();
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);
  expect(await push(cfg)).toEqual({ ok: true, pushed: false });
});

test("push sends the commit to a real remote, and pushing twice is not a failure", async () => {
  const remoteUrl = await bareRemote();
  const cfg = await tree({ remoteUrl });
  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const done = await commit(cfg, { message: "one", author: PUBLISHER });
  expect(done.ok && done.committed).toBe(true);

  expect(await push(cfg)).toEqual({ ok: true, pushed: true });

  // The remote really has it — read out of the remote, not out of the push's own output.
  const remote = await config({ root: remoteUrl });
  expect((await headSha(remote)).ok && (await headSha(remote)).ok).toBe(true);
  expect(await log(remote, "%s")).toBe("one");

  // Idempotent: git answers `Everything up-to-date` with exit 0.
  expect(await push(cfg)).toEqual({ ok: true, pushed: true });
});

test("a commit whose push fails is retried as a push, and produces exactly one commit", async () => {
  // The landmine, at the seam level: the property Task 6 needs is that a commit and a push are
  // two operations, so a failed push can be repeated without a second commit ever being made.
  const missing = join(await scratch("gone"), "nope.git");
  const cfg = await tree({ remoteUrl: missing });

  expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
  const done = await commit(cfg, { message: "one", author: PUBLISHER });
  expect(done.ok).toBe(true);
  if (!done.ok) throw new Error("unreachable");
  expect(done.committed).toBe(true);

  const failed = await push(cfg);
  expect(failed.ok).toBe(false);
  if (failed.ok) throw new Error("unreachable");
  expect(failed.error.code).toBe("git-failed");
  expect(failed.error.run?.code).toBe(128);

  // The remote comes back. The retry calls **push**, not commit, and needs nothing the first run
  // held in memory.
  const working = { ...cfg, remoteUrl: await bareRemote() };
  expect(await push(working)).toEqual({ ok: true, pushed: true });

  expect(await commitCount(cfg)).toBe(1);
  expect((await headSha(cfg)).ok && done.sha).toBe(done.sha);
  const remote = await config({ root: working.remoteUrl });
  expect(await log(remote, "%H")).toBe(done.sha);
});

// ── The timeout ───────────────────────────────────────────────────────────────────────────────

test("a hung push is killed by the network timeout rather than hanging forever", async () => {
  // A TCP peer that accepts and never answers. `git push` waits on it indefinitely — measured on
  // loopback, with no output and no error — which is a worker that never finishes and a job stuck
  // in RUNNING. No network is involved: this is 127.0.0.1 and a socket the test owns.
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");

  try {
    const cfg = await tree({
      remoteUrl: `http://127.0.0.1:${address.port}/content.git`,
      networkTimeoutMs: 750,
    });
    expect((await stageWrite(cfg, REF, "# body\n")).ok).toBe(true);
    expect((await commit(cfg, { message: "one", author: PUBLISHER })).ok).toBe(true);

    const started = Date.now();
    const result = await push(cfg);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // `timed-out`, distinctly from `git-failed`: the two are retried differently, and an operator
    // reading GitJob.lastError has to know which happened.
    expect(result.error.code).toBe("timed-out");
    expect(result.error.run?.timedOut).toBe(true);
    expect(result.error.run?.signal).toBe("SIGKILL");

    // The ceiling is the ceiling. This is generous against a busy machine and still an order of
    // magnitude under the default, so it fails if the timeout does not fire at all — which is
    // the mutant: delete the `setTimeout` and this test hangs until vitest kills the file.
    expect(elapsed).toBeLessThan(10_000);
    expect(elapsed).toBeGreaterThanOrEqual(700);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}, 30_000);

test("the timeout kills the whole process group, not only the direct child", async () => {
  // `git push` over HTTP spawns `git-remote-http`, and over SSH spawns `ssh`. Signalling only the
  // direct child leaves the grandchild holding the inherited stdio pipes, `close` never fires,
  // and the promise that was supposed to be bounded never settles. Modelled here with a shell
  // whose child outlives it, which is the same shape and is instant.
  const cfg = await config({ binary: "/bin/sh", localTimeoutMs: 300 });
  await mkdir(cfg.root, { recursive: true });

  const started = Date.now();
  const run = await runGit(cfg, ["-c", "sleep 30 | cat"], { cwd: cfg.root });
  expect(run.timedOut).toBe(true);
  expect(run.ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(5000);
}, 15_000);
