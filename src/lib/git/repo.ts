import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GitJobKind } from "@prisma/client";
import { mirrorPathOf } from "@/lib/git/paths";
import { redactCredentials } from "@/lib/git/redact";

/**
 * The one place in this application that spawns `git`.
 *
 * No database, no job claiming, no backoff, no ordering — Task 6's worker owns all of that and
 * drives this. Everything here is a function of its arguments and of a working tree on disk, so
 * every operation is testable against a real repository in a temporary directory.
 *
 * ## Argv arrays, never a shell string
 *
 * `spawn(bin, args)` with no `shell: true`, so nothing here is ever parsed by `sh`. A page title,
 * a space key and a publisher's name all reach git, all three are user-controlled, and the only
 * reason none of them can become syntax is that each is its own array element. There is no
 * escaping function in this module and there must never be one: a quoting helper is the admission
 * that a string is being built where an array belongs.
 *
 * ## Exit status is the contract, and a pipe would hide it
 *
 * This project has been bitten four times by a pipeline reporting its *last* command's status,
 * and the fourth was while measuring for this very phase — `git rev-parse HEAD | head -2` printed
 * `HEAD` and exited 0 over a `fatal:`. So {@link runGit} captures `code`, `signal`, `stdout` and
 * `stderr` from the spawn itself and returns them; nothing here pipes, and nothing decides
 * anything from a message when an exit code will answer.
 *
 * `runGit` returns a result and does not throw on non-zero, because a non-zero exit is sometimes
 * the expected answer:
 *
 * | Command | Empty repository | Meaning |
 * |---|---|---|
 * | `rev-parse HEAD` | **128** (`fatal: ambiguous argument 'HEAD'`) | no commits |
 * | `rev-parse --verify HEAD` | **128** (`fatal: Needed a single revision`) | no commits |
 * | `log -1` | **128** (`fatal: your current branch 'main' does not have any commits yet`) | no commits |
 * | `rev-parse --quiet --verify HEAD` | **1**, and *nothing* on stderr | no commits |
 *
 * All four measured on `git version 2.50.1 (Apple Git-155)`. {@link headSha} uses the fourth,
 * because `--quiet` is the one form that separates "no commits" (1) from "not a repository"
 * (128) by status alone. The other three are pinned by a test anyway, so that the seam's
 * behaviour on the shape the plan warns about is asserted rather than assumed.
 *
 * ## Locale, and how output stays parseable
 *
 * Two mechanisms, and the split matters:
 *
 * - **Nothing this module *decides* on is parsed out of prose.** Exit codes, `--porcelain`-class
 *   commands and `--format=%H` carry every judgement. `git diff --cached --quiet` is the
 *   nothing-to-commit predicate rather than the words "nothing to commit"; `ls-files
 *   --error-unmatch` is the is-it-tracked predicate rather than the words "did not match".
 * - **`LC_ALL=C` and `LANG=C` are set anyway**, for the strings that end up in `GitJob.lastError`
 *   and in a log. That keeps an operator's error text stable across deployments and makes the
 *   *human* half reproducible.
 *
 * The reason both are needed rather than either: on this machine `LC_ALL=C git commit` and plain
 * `git commit` print the identical "nothing to commit, working tree clean", because Apple's build
 * ships no translations. A test that pinned that message would therefore pass here and break on
 * any git built with gettext — which is exactly the class of guard this project keeps finding too
 * narrow and silent about it. Setting `LC_ALL=C` does not make message-parsing safe; it makes the
 * messages we merely *display* deterministic.
 *
 * And one measured surprise that argues the same point from the other side: `git commit`'s
 * "nothing to commit" goes to **stdout**, with stderr completely empty. A seam that captured only
 * stderr would report a failure whose reason was the empty string.
 *
 * ## The environment is an allowlist, and identity travels through it
 *
 * The child's environment is built from nothing, not inherited. Two independent reasons:
 *
 * - **Identity must be an environment variable and never `--author=`.** Measured while planning
 *   and re-measured here: a `GIT_AUTHOR_NAME` of `--upload-pack=touch /tmp/pwned` is stored
 *   verbatim as the author's name, is not parsed as an option, and creates no file. There is no
 *   argv position where a name could be mistaken for a flag, because the name never appears in
 *   argv. `git-author-name-is-not-parsed` in the tests fails if anyone refactors to `--author=`.
 * - **An inherited environment can silently redirect git.** `GIT_DIR`, `GIT_WORK_TREE`,
 *   `GIT_INDEX_FILE` and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the operator's shell would move
 *   where the mirror is written or who it is attributed to, with no argument and no log line
 *   saying so. The worker runs from a cron and inherits whatever that has.
 *
 * {@link ALLOWED_ENV} is therefore the complete pass-through list, and everything else is set
 * here explicitly. `GIT_LITERAL_PATHSPECS=1` is one of them: without it a space key containing
 * `:` or `*` would reach `git add` as *pathspec magic* rather than as a filename, and
 * `Space.key` has no validation anywhere (`paths.ts` documents the measurement).
 *
 * ## Configuration is an argument, with one named reader beside it
 *
 * Every operation takes a {@link GitConfig}, and {@link gitConfigFromEnv} is the only function
 * that names an environment variable. That is the shape `src/lib/version/build.ts` already uses
 * — `buildInfo(env = process.env)` — and it is the shape the rest of `lib/` uses for a different
 * reason: `paths.ts` states it outright ("the root is an argument, not configuration") because a
 * module that reads `process.env` is a module a test cannot call twice with two answers.
 *
 * The alternative — reading `process.env` inside each operation — was rejected on a concrete
 * cost, not on taste. Every test in `repo.test.ts` runs against its own temporary tree with its
 * own remote and its own timeouts, several of them in the same file; with the environment as the
 * channel those would either have to mutate `process.env` (which `fileParallelism: false` makes
 * *look* safe and which Phase 1 already recorded as a trap, since importing Prisma reloads `.env`
 * over anything a test cleared) or run in separate processes. §17's variables still exist and are
 * still read — once, at the edge, by a function whose whole body is the mapping.
 *
 * ## What is deliberately not here
 *
 * - **Credentials are not assembled.** §17 lists "git remote URL and credentials" as
 *   configuration, and the credential belongs in the remote URL, an SSH key, or a credential
 *   helper — all of which are the operator's to configure and all of which real git already
 *   understands, which is the entire argument for shelling out to it. What this module does add
 *   is `GIT_TERMINAL_PROMPT=0`, so a missing credential **fails** instead of blocking forever on
 *   a prompt that no cron job can answer.
 * - **No retry, no backoff, no ordering, no locking.** All Task 6.
 * - **No `buildInfo()`.** Three unrelated things in this codebase are called `gitSha`; the one
 *   this module produces is a commit in the *content* repository. Importing the application's
 *   build sha here would be the confusion made permanent.
 */

// ── Configuration ─────────────────────────────────────────────────────────────────────────────

export type GitIdentity = {
  name: string;
  email: string;
};

export type GitConfig = {
  /** The working tree, absolute. §16 names `content/`; §17 makes it configurable. */
  root: string;
  /**
   * §19: "a git remote is available but optional; the system runs with a local repository only."
   * `null` means {@link ensureRepository} initialises rather than clones, and {@link push} is a
   * no-op that reports itself as one instead of failing.
   */
  remoteUrl: string | null;
  /** The branch the mirror lives on. `git init` on this machine defaults to `main`, measured. */
  branch: string;
  /** The service, which is the **committer** of every mirrored commit. */
  committer: GitIdentity;
  /**
   * §17's "git author fallback": used when a publisher has no name or no email. Not cosmetic —
   * git refuses an empty ident outright, so a `User` row with a blank name would otherwise turn
   * every publish by that person into a permanently failing job.
   */
  authorFallback: GitIdentity;
  /** Ceiling for operations that touch only the local disk. */
  localTimeoutMs: number;
  /** Ceiling for `clone` and `push`. See {@link DEFAULT_NETWORK_TIMEOUT_MS}. */
  networkTimeoutMs: number;
  /**
   * The binary. A string, not a path this module resolves: `PATH` lookup is `spawn`'s job and an
   * operator who needs a specific git says so here.
   */
  binary: string;
};

/**
 * Local operations are disk-bound and bounded by the size of one page, so this is a
 * *stuck-process* ceiling rather than a performance budget. Ten seconds is far past any honest
 * `git add` of a 100 KB file and far short of a job holding a worker for a shift.
 */
export const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;

/**
 * **The deliberate one.** A `git push` with no timeout is a worker that never finishes and a job
 * stuck in `RUNNING` — and it is not hypothetical: a TCP peer that accepts the connection and
 * never answers hangs `git push` indefinitely, measured on loopback, with no error and no output.
 * `GIT_TERMINAL_PROMPT=0` closes the credential-prompt half of that; nothing but a timeout closes
 * the network half.
 *
 * Sixty seconds, chosen against what it must not break and what it must catch:
 *
 * - **It must not truncate an honest push.** The mirror pushes one commit touching one small file
 *   over an already-warm clone. Even a cold TLS handshake, an SSH key exchange and a pack
 *   negotiation across a continent is seconds, not a minute.
 * - **It must be shorter than the interval a worker is scheduled on**, or two workers overlap and
 *   contend for a tree that only one may hold.
 * - **A truncated honest push costs nothing**, which is what makes erring short correct here: the
 *   commit already exists locally, so the job retries as a *push* and not as a second commit —
 *   the property {@link commit} and {@link push} are split to preserve.
 *
 * A timeout is reported as `timed-out` and never as a git failure, because the two are retried
 * differently and an operator reading `GitJob.lastError` needs to know which one happened.
 */
export const DEFAULT_NETWORK_TIMEOUT_MS = 60_000;

/** `git init` on git 2.50.1 (Apple Git-155) produces this. Measured, not assumed. */
export const DEFAULT_BRANCH = "main";

/**
 * The environment variables passed through to `git` from the process. Everything else is dropped
 * and the rest of the child's environment is set explicitly below.
 *
 * | Variable | Why it survives |
 * |---|---|
 * | `PATH` | `spawn` resolves the binary through it. |
 * | `HOME` | Where `~/.gitconfig`, `~/.ssh/known_hosts` and a credential helper's store live. |
 * | `SSH_AUTH_SOCK` | A deploy key held by an agent rather than on disk. |
 * | `GIT_SSH_COMMAND` | The documented way to point at a specific key or an `IdentitiesOnly` config, and §17's channel for SSH credentials. |
 *
 * Notably absent, and each for its own reason: `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`
 * would move where the mirror is written; `GIT_AUTHOR_*` and `GIT_COMMITTER_*` would rewrite who
 * a commit is attributed to, which is the one thing this phase promises the reader; `LC_ALL` and
 * `LANG` are set to `C` rather than inherited.
 */
export const ALLOWED_ENV = ["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"] as const;

/**
 * §17's environment variables, read in exactly one place.
 *
 * `env` is a parameter with a default rather than a direct `process.env` read, the same shape
 * `buildInfo()` uses, so a test can hand it a literal.
 *
 * `root` is completed against `process.cwd()` when relative — the one cwd-dependent line in the
 * module, and it is here rather than in an operation on purpose: resolving a relative path against
 * the process's working directory is a *process*-level decision, and `mirrorPathOf` refuses a
 * relative root outright so no operation can inherit the ambiguity.
 */
export function gitConfigFromEnv(env: Partial<NodeJS.ProcessEnv> = process.env): GitConfig {
  const trimmed = (key: string): string | null => {
    const value = env[key]?.trim();
    return value ? value : null;
  };

  const positiveInt = (key: string, fallback: number): number => {
    const raw = trimmed(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    // `Number("")` is 0 and `Number(null)` is 0 — the shape that let a chunked bug report past a
    // numeric-only `Content-Length` check in Phase 1. A non-finite or non-positive value falls
    // back rather than disabling the timeout, because "0 means no ceiling" is precisely the
    // wedged worker this constant exists to prevent.
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };

  return {
    root: resolve(trimmed("GIT_MIRROR_ROOT") ?? "content"),
    remoteUrl: trimmed("GIT_REMOTE_URL"),
    branch: trimmed("GIT_MIRROR_BRANCH") ?? DEFAULT_BRANCH,
    committer: {
      name: trimmed("GIT_COMMITTER_NAME") ?? "Badam",
      email: trimmed("GIT_COMMITTER_EMAIL") ?? "badam@localhost",
    },
    authorFallback: {
      name: trimmed("GIT_AUTHOR_FALLBACK_NAME") ?? "Badam",
      email: trimmed("GIT_AUTHOR_FALLBACK_EMAIL") ?? "badam@localhost",
    },
    localTimeoutMs: positiveInt("GIT_LOCAL_TIMEOUT_MS", DEFAULT_LOCAL_TIMEOUT_MS),
    networkTimeoutMs: positiveInt("GIT_NETWORK_TIMEOUT_MS", DEFAULT_NETWORK_TIMEOUT_MS),
    binary: trimmed("GIT_BINARY") ?? "git",
  };
}

// ── The spawn ─────────────────────────────────────────────────────────────────────────────────

/** Everything one `git` invocation produced. Nothing is discarded and nothing is thrown. */
export type GitRun = {
  /** `code === 0`. Stated as a field so a caller never re-derives it from a message. */
  ok: boolean;
  /** The process's exit status, or `null` when it was killed by a signal. */
  code: number | null;
  /** The signal that killed it, if any. `SIGKILL` accompanies every {@link GitRun.timedOut}. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The ceiling fired and the process group was killed. `code` is `null` in this case. */
  timedOut: boolean;
  /** `spawn` itself failed — the binary is missing, or the cwd does not exist. */
  spawnError: string | null;
  /** The exact argv, for a log. The binary is element 0. */
  argv: string[];
};

/**
 * Run one `git` command and report what happened.
 *
 * Never throws for a git-level failure and never for a timeout; the only way this rejects is a
 * bug in this function. Callers switch on the returned fields.
 *
 * **The process is spawned into its own process group and killed as a group.** `git push` over
 * HTTP is a parent that spawns `git-remote-http`, and over SSH one that spawns `ssh`; signalling
 * only the direct child leaves the grandchild holding the socket *and* the inherited stdio pipes,
 * so `close` never fires and the timeout that was supposed to bound the operation returns a
 * promise that never settles. `detached: true` plus `kill(-pid)` is what makes the ceiling real.
 * `SIGKILL` rather than `SIGTERM` for the same reason — a hung transport is not guaranteed to
 * honour a polite signal, and there is nothing to clean up: git's own `index.lock` is the only
 * durable artefact and the tree is re-cloned on start (§17).
 */
export async function runGit(
  config: GitConfig,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<GitRun> {
  const cwd = options.cwd ?? config.root;
  const timeoutMs = options.timeoutMs ?? config.localTimeoutMs;
  const argv = [config.binary, ...args];

  return await new Promise<GitRun>((settle) => {
    const child = spawn(config.binary, args, {
      cwd,
      // The cast is because Next augments `NodeJS.ProcessEnv` so that `NODE_ENV` is required.
      // The child's environment deliberately does not have one: it is an allowlist plus what
      // this module states, and git has no opinion about `NODE_ENV`.
      env: childEnv(options.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as const,
      detached: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | null = null;
    let done = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    // Do not hold the event loop open for the ceiling of a command that has already finished.
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({
        ok: spawnError === null && !timedOut && code === 0,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        spawnError,
        argv,
      });
    };

    child.on("error", (error: Error) => {
      spawnError = error.message;
      // `error` can fire without `close` (ENOENT on the binary), so this settles rather than
      // waiting for an exit that will not arrive.
      finish(null, null);
    });
    // `close`, not `exit`: `exit` fires when the process ends, which can be before the pipes have
    // been drained, and this function's whole job is to return what was written to them.
    child.on("close", finish);
  });
}

/**
 * Kill the whole process group. A negative pid is the POSIX "this process group" convention, and
 * it is why {@link runGit} spawns `detached`.
 *
 * Swallowing `ESRCH` is correct rather than lazy: the race where the process exits between the
 * timer firing and the kill is a normal one, and there is nothing left to kill.
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The child's environment: the allowlist, then everything this module states outright. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    // Deterministic human-readable output — see the module note on why this is not a licence to
    // parse it.
    LC_ALL: "C",
    LANG: "C",
    // A cron job cannot answer a credential prompt. Without this a missing credential is a hang,
    // which the network timeout would then report as `timed-out` — true, but three levels away
    // from the actual cause.
    GIT_TERMINAL_PROMPT: "0",
    // Every path argument is a literal filename, never pathspec magic. `Space.key` is
    // unvalidated, so `*`, `?` and a leading `:` are all reachable in a directory name.
    GIT_LITERAL_PATHSPECS: "1",
    ...extra,
  };
}

// ── Results ───────────────────────────────────────────────────────────────────────────────────

/**
 * Why an operation failed. `message` is what lands in `GitJob.lastError` and what a super admin
 * reads on Task 8's page, so it is a whole sentence and it quotes rather than summarises.
 *
 * | Code | What it means, and how Task 6 should treat it |
 * |---|---|
 * | `path-refused` | `mirrorPathOf` refused the address. A bug upstream; retrying cannot help. |
 * | `not-a-repository` | The root exists and is not the root of a git repository. Operational. |
 * | `write-failed` | The filesystem refused — `ENAMETOOLONG`, `ENOSPC`, a permission. |
 * | `timed-out` | The ceiling fired. Retryable, and the *only* code that says so unambiguously. |
 * | `git-failed` | git exited non-zero for a reason this module has not classified. |
 */
export type GitErrorCode =
  | "path-refused"
  | "not-a-repository"
  | "write-failed"
  | "timed-out"
  | "git-failed";

export type GitError = {
  code: GitErrorCode;
  message: string;
  /** The invocation, when there was one. Absent for a refusal decided before any spawn. */
  run?: GitRun;
};

export type GitResult<T> = ({ ok: true } & T) | { ok: false; error: GitError };

/** Stops one runaway `git` from putting a megabyte of output into a `text` column. */
const MAX_ERROR_OUTPUT = 4000;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_ERROR_OUTPUT
    ? `${trimmed.slice(0, MAX_ERROR_OUTPUT)}… (${trimmed.length} bytes truncated)`
    : trimmed;
}

/**
 * Turn a failed {@link GitRun} into a {@link GitError}.
 *
 * **Both streams are quoted, and that is the measured half.** `git commit` writes "nothing to
 * commit, working tree clean" to *stdout* and leaves stderr empty, so an error message built from
 * stderr alone would be blank for one of the most common failures git has.
 *
 * **And every message goes out through `redactCredentials`, which Phase 5 Task 8 added.** This
 * function is where a credential leaves the process, by two routes at once: `config.remoteUrl` is
 * an argv element of `clone` and `push`, and it is quoted whole into `Command:` below — so *any*
 * failed push writes the remote URL, credential and all, with no help from git; and git's own
 * output echoes the URL it was handed, so `Output:` carries it a second time. Task 5's decision
 * not to assemble credentials means `GIT_REMOTE_URL` may legitimately be
 * `https://user:token@host/repo.git`, which makes this a certainty rather than a possibility.
 *
 * The message is what reaches `GitJob.lastError`, `scripts/git-worker.ts`'s stdout (cron mail) and
 * Task 8's super-admin page. Redacting here means the secret never reaches any of the three; Task
 * 8 redacts again on the way *out* of the column, for the rows this function did not write. See
 * `src/lib/git/redact.ts` for why that is two transforms and not one predicate stated twice.
 *
 * `run` is attached unredacted, deliberately: it is the structured record of the invocation, it is
 * never persisted or rendered — `worker.ts` reads `error.message` and `error.code` and nothing
 * else — and a caller debugging a spawn needs the argv that was actually used.
 */
function failedRun(run: GitRun, what: string): GitError {
  if (run.spawnError !== null) {
    return {
      code: "git-failed",
      message: redactCredentials(
        `${what}: could not run ${JSON.stringify(run.argv[0])} — ${run.spawnError}`,
      ),
      run,
    };
  }
  if (run.timedOut) {
    return {
      code: "timed-out",
      message: redactCredentials(
        `${what}: git did not finish within the configured timeout and was killed. ` +
          `Command: ${JSON.stringify(run.argv)}.` +
          (run.stderr.trim() ? ` Last output: ${clip(run.stderr)}` : ""),
      ),
      run,
    };
  }
  const output = clip(`${run.stderr}\n${run.stdout}`);
  return {
    code: "git-failed",
    message: redactCredentials(
      `${what}: git exited ${run.code === null ? `on signal ${run.signal}` : String(run.code)}. ` +
        `Command: ${JSON.stringify(run.argv)}.` +
        (output ? ` Output: ${output}` : " It wrote nothing to stdout or stderr."),
    ),
    run,
  };
}

// ── Addressing ────────────────────────────────────────────────────────────────────────────────

/**
 * A page's address in the mirror, as the four mutations and `GitJob` carry it: the space key and
 * the space-relative `Page.path`, both captured at enqueue time.
 */
export type MirrorRef = {
  spaceKey: string;
  path: string;
};

/**
 * Resolve a {@link MirrorRef} through `mirrorPathOf`, so **every** filesystem and git argument in
 * this module comes out of the containment check.
 *
 * The alternative — taking the already-resolved paths as arguments — was rejected because it
 * makes the guard skippable by whoever writes the next caller, and Task 2's whole argument is
 * that the guard must not depend on a promise made elsewhere. One door.
 */
function locate(config: GitConfig, ref: MirrorRef): GitResult<{ absolutePath: string; repoPath: string }> {
  const located = mirrorPathOf(config.root, ref.spaceKey, ref.path);
  if (!located.ok) {
    return {
      ok: false,
      error: { code: "path-refused", message: located.error.message },
    };
  }
  return { ok: true, absolutePath: located.absolutePath, repoPath: located.repoPath };
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

/** What {@link ensureRepository} found or did. */
export type RepositoryState = "cloned" | "initialised" | "existing";

/**
 * Make sure `config.root` is the root of a git repository, cloning when a remote is configured
 * and initialising when one is not (§19: the remote is optional).
 *
 * Idempotent: called against a tree that is already the repository's root, it does nothing and
 * reports `existing`.
 *
 * **The containment check on an existing tree is load-bearing, and the reason is this repository.**
 * `git rev-parse --show-toplevel` run inside a *subdirectory* of a repository answers with the
 * **ancestor's** root — measured. `content/` lives inside the application's own checkout, so a
 * seam that merely asked "is this a repository?" would answer yes for an empty `content/`
 * directory and then commit every mirrored page **into the application's source repository**.
 * The check is therefore an equality against the resolved root, not a boolean.
 */
export async function ensureRepository(config: GitConfig): Promise<GitResult<{ state: RepositoryState }>> {
  const root = resolve(config.root);

  const toplevel = await runGit(config, ["rev-parse", "--show-toplevel"], { cwd: root });

  if (toplevel.ok) {
    const found = resolve(toplevel.stdout.trim());
    // **Both sides are realpaths, and this is not tidiness.** `git rev-parse --show-toplevel`
    // resolves symlinks; `path.resolve` does not. On macOS `os.tmpdir()` is `/var/folders/…`,
    // which is a symlink to `/private/var/folders/…`, so a string comparison of the two forms
    // says "this tree is nested inside a different repository" about a directory that **is** the
    // repository — and the mirror would refuse to run at all. Caught by a test, on the machine
    // this ships from.
    if ((await realpathOr(root)) === (await realpathOr(found))) return { ok: true, state: "existing" };
    return {
      ok: false,
      error: {
        code: "not-a-repository",
        message:
          `${JSON.stringify(root)} is inside the git repository at ${JSON.stringify(found)} ` +
          "rather than being one itself. Writing the mirror here would commit content into that " +
          "repository. Point GIT_MIRROR_ROOT at a directory that is not inside another checkout, " +
          "or remove it so it can be cloned afresh.",
        run: toplevel,
      },
    };
  }

  // Not a repository (or absent entirely — `spawn` fails with ENOENT on a missing cwd, which is
  // the same answer for this purpose). Create it.
  if (config.remoteUrl !== null) {
    await mkdir(dirname(root), { recursive: true });
    const cloned = await runGit(
      config,
      ["clone", "--", config.remoteUrl, root],
      { cwd: dirname(root), timeoutMs: config.networkTimeoutMs },
    );
    if (!cloned.ok) return { ok: false, error: failedRun(cloned, "Cloning the content repository") };
    return { ok: true, state: "cloned" };
  }

  await mkdir(root, { recursive: true });
  const initialised = await runGit(config, ["init", "--initial-branch", config.branch, "--", root], {
    cwd: root,
  });
  if (!initialised.ok) {
    return { ok: false, error: failedRun(initialised, "Initialising the content repository") };
  }
  return { ok: true, state: "initialised" };
}

/** A path with symlinks resolved, or the path itself when it does not exist. */
async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The sha at `HEAD`, or `null` when the repository has no commits yet.
 *
 * `null` is an **expected** state, not an error: §17 re-clones the working tree on start, and a
 * clone of an empty remote — or a fresh `git init` with no remote — has no `HEAD` to resolve. A
 * seam that surfaced that as a crash would make the first publish after every deploy a failure.
 */
export async function headSha(config: GitConfig): Promise<GitResult<{ sha: string | null }>> {
  const run = await runGit(config, ["rev-parse", "--quiet", "--verify", "HEAD"]);
  // Exit 1 with no output is `--quiet`'s "the ref does not resolve", which for `HEAD` means no
  // commits. 128 is "not a repository" and every other failure, which is not this function's to
  // absorb. Measured on git 2.50.1; without `--quiet` both cases are 128 and indistinguishable
  // by status.
  if (!run.ok) {
    if (run.code === 1 && run.stdout.trim() === "") return { ok: true, sha: null };
    return { ok: false, error: failedRun(run, "Reading HEAD") };
  }
  return { ok: true, sha: run.stdout.trim() };
}

/**
 * Write a page's mirrored file and stage it.
 *
 * Idempotent by construction: the write is a whole-file replace and `git add` on unchanged
 * content stages nothing. Re-running a job that already succeeded therefore reaches
 * {@link commit} with a clean index, which is the case that function exists to absorb.
 */
export async function stageWrite(
  config: GitConfig,
  ref: MirrorRef,
  contents: string,
): Promise<GitResult<{ repoPath: string }>> {
  const located = locate(config, ref);
  if (!located.ok) return located;

  try {
    await mkdir(dirname(located.absolutePath), { recursive: true });
    await writeFile(located.absolutePath, contents, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "write-failed",
        // `ENAMETOOLONG` arrives here, carrying the filesystem's real limit — which is exactly
        // why `paths.ts` declines to guess a total-length cap.
        message: `Writing ${JSON.stringify(located.repoPath)} failed: ${String(error)}`,
      },
    };
  }

  const added = await runGit(config, ["add", "--", located.repoPath]);
  if (!added.ok) return { ok: false, error: failedRun(added, `Staging ${JSON.stringify(located.repoPath)}`) };
  return { ok: true, repoPath: located.repoPath };
}

/**
 * Rename a page's mirrored file, staging the rename.
 *
 * `moved: false` means there was nothing at the old path to move. That is the idempotent re-run
 * of a job whose `git mv` already succeeded — and it is a success, not a failure: `git mv` on a
 * missing source exits **128** (`fatal: bad source`), which a seam that did not check first would
 * turn a retry into a permanently `FAILED` job.
 *
 * The check is `ls-files --error-unmatch`, an exit code against the index, rather than the
 * presence of the file on disk: what a rename has to move is the *tracked* path.
 */
export async function stageMove(
  config: GitConfig,
  from: MirrorRef,
  to: MirrorRef,
): Promise<GitResult<{ from: string; to: string; moved: boolean }>> {
  const source = locate(config, from);
  if (!source.ok) return source;
  const target = locate(config, to);
  if (!target.ok) return target;

  const tracked = await isTracked(config, source.repoPath);
  if (!tracked.ok) return tracked;
  if (!tracked.tracked) {
    return { ok: true, from: source.repoPath, to: target.repoPath, moved: false };
  }

  try {
    // `git mv` refuses a destination whose directory does not exist, and a move that reparents a
    // page into a new part of the tree is the normal case.
    await mkdir(dirname(target.absolutePath), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "write-failed",
        message: `Creating the directory for ${JSON.stringify(target.repoPath)} failed: ${String(error)}`,
      },
    };
  }

  const moved = await runGit(config, ["mv", "--", source.repoPath, target.repoPath]);
  if (!moved.ok) {
    return {
      ok: false,
      error: failedRun(
        moved,
        `Moving ${JSON.stringify(source.repoPath)} to ${JSON.stringify(target.repoPath)}`,
      ),
    };
  }
  return { ok: true, from: source.repoPath, to: target.repoPath, moved: true };
}

/**
 * Remove a page's mirrored file, staging the removal.
 *
 * `removed: false` means the path was not tracked, which covers both the idempotent re-run and
 * the page that was never mirrored in the first place. `git rm` on an untracked path exits 128
 * (`fatal: pathspec … did not match any files`), so the same argument as {@link stageMove}
 * applies: without the check, a retry is a permanent failure.
 */
export async function stageDelete(
  config: GitConfig,
  ref: MirrorRef,
): Promise<GitResult<{ repoPath: string; removed: boolean }>> {
  const located = locate(config, ref);
  if (!located.ok) return located;

  const tracked = await isTracked(config, located.repoPath);
  if (!tracked.ok) return tracked;
  if (!tracked.tracked) return { ok: true, repoPath: located.repoPath, removed: false };

  const removed = await runGit(config, ["rm", "--quiet", "--", located.repoPath]);
  if (!removed.ok) {
    return { ok: false, error: failedRun(removed, `Removing ${JSON.stringify(located.repoPath)}`) };
  }
  return { ok: true, repoPath: located.repoPath, removed: true };
}

/**
 * Whether a path is in the index. Exit 0 means tracked, exit 1 means not — an exit code, so no
 * message is parsed and no locale is consulted.
 */
async function isTracked(config: GitConfig, repoPath: string): Promise<GitResult<{ tracked: boolean }>> {
  const run = await runGit(config, ["ls-files", "--error-unmatch", "--", repoPath]);
  if (run.ok) return { ok: true, tracked: true };
  if (run.code === 1) return { ok: true, tracked: false };
  return { ok: false, error: failedRun(run, `Checking whether ${JSON.stringify(repoPath)} is tracked`) };
}

// ── Commit ────────────────────────────────────────────────────────────────────────────────────

export type CommitInput = {
  /** One argv element. See {@link mirrorCommitMessage}. */
  message: string;
  /** The publisher. Blank fields fall back to `config.authorFallback`. */
  author: GitIdentity;
};

/**
 * The result of a commit attempt. `committed` is the discriminator, and `sha` is populated on
 * **both** successful branches.
 */
export type CommitOutcome = {
  /** Whether this call created a commit. `false` is the nothing-to-commit case. */
  committed: boolean;
  /**
   * The commit that contains the staged content. On the `committed: false` branch that is `HEAD`
   * — see {@link commit} — and it is `null` only when the repository has no commits at all, which
   * is reachable only if there was nothing to commit in an empty repository.
   */
  sha: string | null;
};

/**
 * Commit the index, with the publisher as **author** and the service as **committer**.
 *
 * ## A commit that changes nothing is a normal case, and it is absorbed here
 *
 * Measured: with a clean index `git commit` exits **1**, writes `On branch main / nothing to
 * commit, working tree clean` to **stdout**, and writes nothing at all to stderr.
 *
 * Two routes reach it, neither a fault:
 *
 * - **A change that is not a content change.** A `MOVE`, `DELETE` or `RESTORE` job carries no
 *   version and mirrors the file as it stands, so two of them for the same page in a row leave
 *   the index clean the second time — a restore of a page that was never actually removed from
 *   the tree, or a move enqueued for a page whose file is already at the new path. (A republished
 *   `PageVersion` is *not* one of these, and the plan's "byte-identical republish" is worth
 *   correcting rather than repeating: `version` is a key in the canonical block and a new
 *   publish is a new row, so a publish of identical prose still changes the file. The identical
 *   case would need `publishPage` to reuse a version row, which it does not.)
 * - **A retry after a successful commit**, which is the one that matters. The worker commits, the
 *   push fails, the process is killed before the sha is recorded; the job runs again, rewrites the
 *   same file, stages it, and finds a clean index.
 *
 * That last case is why `sha` is `HEAD` rather than `null` on this branch, and it is not a
 * convenience: if nothing is staged relative to `HEAD`, then `HEAD`'s tree already contains
 * exactly the bytes this job wrote, so `HEAD` **is** the commit that mirrors this version. A
 * worker that records it gets the right answer after a crash without knowing a crash happened.
 *
 * ## The predicate is `git diff --cached --quiet`, not the message
 *
 * The index is asked *before* the commit is attempted, so nothing-to-commit is decided by an exit
 * code and never by prose. Measured, including the case that would otherwise need a special
 * branch: in a repository with **no commits**, `git diff --cached --quiet` still answers — 0 for
 * an empty index, 1 with a file staged — because it diffs against the empty tree rather than
 * against a `HEAD` that does not exist.
 *
 * The consequence for the caller is the one that earns the split: after this returns, a non-zero
 * exit from `git commit` is an *unclassified* failure — a rejecting hook, a refused identity —
 * and Task 6 can treat it as one instead of guessing.
 */
export async function commit(
  config: GitConfig,
  input: CommitInput,
): Promise<GitResult<CommitOutcome>> {
  const staged = await runGit(config, ["diff", "--cached", "--quiet"]);
  if (staged.ok) {
    const head = await headSha(config);
    if (!head.ok) return head;
    return { ok: true, committed: false, sha: head.sha };
  }
  if (staged.code !== 1) {
    return { ok: false, error: failedRun(staged, "Inspecting the staged changes") };
  }

  const author = withFallback(input.author, config.authorFallback);

  const run = await runGit(config, ["commit", "--quiet", "-m", input.message], {
    env: {
      // Identity travels here and nowhere else. Never `--author=`: see the module note, and the
      // test named for it.
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: config.committer.name,
      GIT_COMMITTER_EMAIL: config.committer.email,
    },
  });
  if (!run.ok) return { ok: false, error: failedRun(run, "Committing the mirrored change") };

  const head = await headSha(config);
  if (!head.ok) return head;
  return { ok: true, committed: true, sha: head.sha };
}

/**
 * A publisher's identity, with blank fields replaced. `User.name` is nullable in the schema and
 * git refuses an empty ident outright (`fatal: empty ident name … not allowed`), so without this
 * a user with no name is a job that fails forever for a reason no operator would guess.
 */
function withFallback(author: GitIdentity, fallback: GitIdentity): GitIdentity {
  return {
    name: author.name.trim() ? author.name : fallback.name,
    email: author.email.trim() ? author.email : fallback.email,
  };
}

/**
 * The commit message for one mirrored change.
 *
 * **The defence is argv, not this function.** The message is a single array element passed to
 * `-m`, so no value inside it can become an option or a second argument, whatever it contains —
 * that is what makes a title beginning `-` or `--upload-pack=` harmless.
 *
 * What this function adds is *readability under hostile input*: every interpolated value is
 * `JSON.stringify`'d, so a title containing a newline cannot forge an extra line in the body and
 * a title containing a tab arrives as `\t` rather than as invisible whitespace. `stripControl`
 * keeps `\n`, `\t` and `\r`, and `publishPage` only trims the ends, so a stored title with an
 * interior newline is a value this system can actually hold — not a hypothetical.
 *
 * The subject line is derived from the **kind and the address**, never from the title. A commit
 * subject is the one line git tooling puts everywhere (`--oneline`, a host's commit list, a
 * notification), and a 300-character title with markup in it is not a subject. The title is in
 * the body, quoted, where a human reads it.
 *
 * Measured, since it decides whether `--cleanup` is needed: with `-m`, git applies *whitespace*
 * cleanup — trailing spaces go, runs of blank lines collapse, a trailing newline is normalised —
 * and it does **not** strip `#` comment lines, which it would in editor mode. So a title starting
 * with `#` survives, and no `--cleanup=verbatim` is required to keep one.
 */
export function mirrorCommitMessage(input: {
  kind: GitJobKind;
  ref: MirrorRef;
  /** For a `MOVE`: where the file came from. */
  previous?: MirrorRef;
  title?: string;
  versionId?: string;
  /** `PageVersion.message`, the publisher's own note about the change. */
  note?: string | null;
}): string {
  const address = (ref: MirrorRef): string => JSON.stringify(`${ref.spaceKey}/${ref.path}`);
  const verb: Record<GitJobKind, string> = {
    PUBLISH: "Publish",
    MOVE: "Move",
    DELETE: "Delete",
    RESTORE: "Restore",
  };

  const subject =
    input.kind === "MOVE" && input.previous
      ? `Move ${address(input.previous)} to ${address(input.ref)}`
      : `${verb[input.kind]} ${address(input.ref)}`;

  const body: string[] = [];
  if (input.title !== undefined) body.push(`Title: ${JSON.stringify(input.title)}`);
  if (input.versionId !== undefined) body.push(`Version: ${JSON.stringify(input.versionId)}`);
  if (input.note !== undefined && input.note !== null && input.note.trim() !== "") {
    body.push(`Note: ${JSON.stringify(input.note)}`);
  }

  return body.length > 0 ? `${subject}\n\n${body.join("\n")}\n` : `${subject}\n`;
}

// ── Push ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Push the current `HEAD` to the configured remote. A **separate** operation from
 * {@link commit}, and that separation is the whole point.
 *
 * §10 promises documentation does not go down because a git host does; the corollary is that a
 * publish's commit and its push are two failures with two different retries. Re-running a job
 * whose commit succeeded and whose push failed must push, not commit again — and it can, because
 * this takes no message, no author and no file, only a repository that already has the commit.
 * The idempotence is git's own: a second push of the same commit exits **0** with `Everything
 * up-to-date`, measured.
 *
 * `pushed: false` with no error is the no-remote case (§19). It is a success because a
 * local-only deployment is a supported configuration, and reporting it as a failure would put
 * every job on Task 8's page in exactly the deployment that has no remote to fix.
 *
 * `HEAD:refs/heads/<branch>` rather than a bare branch name: the refspec states both ends, so it
 * works in a repository whose checked-out branch is not named `main` and cannot silently push
 * something other than what was just committed.
 */
export async function push(config: GitConfig): Promise<GitResult<{ pushed: boolean }>> {
  if (config.remoteUrl === null) return { ok: true, pushed: false };

  const run = await runGit(
    config,
    ["push", "--", config.remoteUrl, `HEAD:refs/heads/${config.branch}`],
    { timeoutMs: config.networkTimeoutMs },
  );
  if (!run.ok) return { ok: false, error: failedRun(run, "Pushing to the content remote") };
  return { ok: true, pushed: true };
}
