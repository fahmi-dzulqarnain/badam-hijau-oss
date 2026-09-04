import { spawn } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  db,
  formatCounts,
  republishPage,
  seedPublishedPage,
  signIn,
  snapshotCounts,
  sweep,
  type Counts,
} from "./support";
import { removeScratchDirs, scratchUnder } from "../tests/setup/scratch-dirs";
import { splitFrontmatter } from "@/lib/markdown/frontmatter";
import { gitConfigFromEnv, runGit, type GitConfig } from "@/lib/git/repo";
import { shortSha } from "@/lib/version/labels";

/**
 * Phase 5 Task 9 — the mirror end to end: the product's own routes, the real worker **process**,
 * a real `git` binary, a real working tree and a real remote.
 *
 * ## What this file adds that `tests/integration/git-worker.test.ts` cannot
 *
 * **A correction to this task's brief, which said nothing yet proves a real git tree.** That file
 * proves a great deal against one: it drives `git` in a temporary repository, pushes to a local
 * bare remote, and already asserts the round trip, a rename, a delete, a restore and the
 * one-commit retry. What it does *not* have, and what each test below is for:
 *
 * 1. **The worker as a process.** Every test here drains through `scripts/git-worker.ts` with
 *    `GIT_MIRROR_ROOT` and `GIT_REMOTE_URL` in its environment — `gitConfigFromEnv` and
 *    `workerConfigFromEnv` doing the reading, an exit code coming back. The integration suite
 *    calls `drainMirrorJobs(config)` with a config built in TypeScript, so the mapping from §17's
 *    variables to a drain is exercised there only by the three CLI tests, none of which reads a
 *    mirrored file.
 * 2. **The mutations over HTTP.** A move, a delete and a restore are driven through
 *    `/api/pages/{id}/{move,delete,restore}` against a production build, so the enqueue that Task
 *    4 put *inside* those transactions is proven on the request path rather than in a library call.
 * 3. **The tree and the page in one assertion.** The sha the worker committed is read out of the
 *    repository and then found on the reader route, in the `title` of the `code.sha` element — the
 *    two ends of §10's provenance claim, which no test on either side of the seam can state alone.
 * 4. **A restore *after a move***, which nothing covered: Task 4 established that a restore writes
 *    the file back at whatever path the page holds by then, and a delete-restore pair cannot tell
 *    that from a restore that re-used the publish's captured path. See the third test.
 *
 * ## Every tree is a temporary directory, and `content/` is never touched
 *
 * `tests/setup/scratch.ts` hands them out and refuses to return a path inside this checkout — the
 * guard matters here for the same reason it matters there, with one addition: `content/` in a
 * developer's working copy is gitignored but real, and a suite that wrote into it would commit
 * fixtures into whatever tree that developer happens to have. Nothing below names it.
 *
 * ## Three kinds of cleanup, because the rows are not the only residue
 *
 * `sweep()` removes the fixture pages and `GitJob` cascades from `Page`; `snapshotCounts()` proves
 * it. Neither of those sees the **files**, and neither sees a temporary bare remote — so
 * `removeScratchDirs()` runs in `afterEach`, and a crashed run leaves two directories under
 * `os.tmpdir()` rather than anything in the repository or the database.
 *
 * ## The drain summary is asserted exactly, and that is a guard rather than pedantry
 *
 * A worker drains **every** claimable job in the database it is pointed at, and that is the
 * development database here. The seed leaves none (the baseline is `0 git jobs`) and `sweep()`
 * removes the suite's own, so `1 done, 0 retrying, 0 failed` is the true summary — and if a
 * developer's own page had a job queued, the count would come back higher and say so, rather than
 * that page being mirrored into a temporary tree in silence.
 */

/** A build is served once for the file; each test spawns a worker and runs `git` several times. */
test.describe.configure({ timeout: 180_000 });

let baseline: Counts;

test.beforeAll(async () => {
  baseline = await snapshotCounts();
  console.log(`[e2e] dev DB before mirror-tree: ${formatCounts(baseline)}`);
});

test.beforeEach(sweep);
test.afterEach(removeScratchDirs);

test.afterAll(async () => {
  await sweep();
  await removeScratchDirs();
  const after = await snapshotCounts();
  console.log(`[e2e] dev DB after mirror-tree:  ${formatCounts(after)}`);
  expect(
    after,
    "the mirror-tree suite did not leave the dev database as it found it",
  ).toEqual(baseline);
  await db.$disconnect();
});

/* -------------------------------------------------------------------------- */
/* Driving git and the worker                                                 */
/* -------------------------------------------------------------------------- */

/**
 * This checkout: where the worker script is run from, and what every temporary tree is proved not
 * to be inside.
 *
 * **`__dirname` and not `import.meta.dirname`, and that is not a style choice.** Playwright's
 * TypeScript transform emits CommonJS, so `import.meta` in any form is a parse error there —
 * measured, and the failure is that the file loads as *no tests at all* (`SyntaxError: Cannot use
 * 'import.meta' outside a module`, `Total: 0 tests in 0 files`) rather than as a failing spec. It
 * is why `tests/setup/scratch.ts`, which the vitest suites reach for and which is ESM, cannot be
 * imported here and why the mechanism moved to `tests/setup/scratch-dirs.ts` with the root as an
 * argument.
 */
const PROJECT_ROOT = resolve(__dirname, "..");

/** A temporary directory, refused if it is inside {@link PROJECT_ROOT}. Never `content/`. */
async function scratch(prefix: string): Promise<string> {
  return await scratchUnder(PROJECT_ROOT, prefix);
}

/** The service identity, passed to every worker so the committer is this file's decision. */
const COMMITTER = { name: "Badam E2E Service", email: "service@badam.test" };

/**
 * A config for *reading* a tree with `git`, never for writing one.
 *
 * The worker writes through its own configuration, assembled from the environment inside the
 * child process. This is only how the assertions look at what it did — `rev-parse`, `rev-list`,
 * `log`, `ls-remote` — so `remoteUrl` is null and the identities are irrelevant.
 */
function gitIn(root: string): GitConfig {
  return {
    ...gitConfigFromEnv({}),
    root,
    remoteUrl: null,
    localTimeoutMs: 20_000,
    networkTimeoutMs: 20_000,
  };
}

/** A bare repository to push at. A local path is a real remote to git, and involves no network. */
async function bareRemote(): Promise<string> {
  const dir = await scratch("e2e-remote");
  const path = join(dir, "content.git");
  const run = await runGit(gitIn(dir), ["init", "--bare", "--initial-branch", "main", "--", path], {
    cwd: dir,
  });
  expect(run.ok, `git init --bare failed: ${run.stderr}`).toBe(true);
  return path;
}

type WorkerRun = { code: number | null; stdout: string; stderr: string };

/**
 * One run of `npm run git:worker`, as a cron would run it.
 *
 * `tsx scripts/git-worker.ts` rather than `npm run git:worker` for one reason: npm prints its own
 * banner into the output these tests read, and forwards the script's code but not its streams
 * unchanged. The script is what `package.json` points that alias at, and
 * `tests/integration/git-worker.test.ts` invokes it the same way for the same reason.
 *
 * The child inherits `process.env` — `DATABASE_URL` above all, which `e2e/support.ts` has already
 * loaded from `.env` and refused to accept if it named a `_test` database — and then everything
 * this file decides is set over the top of it.
 */
async function runWorker(env: Record<string, string>): Promise<WorkerRun> {
  return await new Promise((settle) => {
    const child = spawn("npx", ["--no", "tsx", "scripts/git-worker.ts"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: COMMITTER.name,
        GIT_COMMITTER_EMAIL: COMMITTER.email,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/** A drain that must succeed, with the summary line it must print. */
async function drain(
  opts: { root: string; remoteUrl?: string },
  summary: string,
): Promise<WorkerRun> {
  const run = await runWorker({
    GIT_MIRROR_ROOT: opts.root,
    ...(opts.remoteUrl === undefined ? {} : { GIT_REMOTE_URL: opts.remoteUrl }),
  });
  expect(run.code, `the worker exited ${run.code}: ${run.stderr}${run.stdout}`).toBe(0);
  expect(run.stdout, "the drain summary").toContain(summary);
  return run;
}

/* -------------------------------------------------------------------------- */
/* Reading the tree                                                           */
/* -------------------------------------------------------------------------- */

async function mirrored(root: string, repoPath: string): Promise<string | null> {
  try {
    return await readFile(join(root, repoPath), "utf8");
  } catch {
    return null;
  }
}

async function exists(root: string, repoPath: string): Promise<boolean> {
  try {
    await stat(join(root, repoPath));
    return true;
  } catch {
    return false;
  }
}

/** The mirrored file at `repoPath`, parsed by the grammar that wrote it. */
async function parseMirrored(root: string, repoPath: string) {
  const file = await mirrored(root, repoPath);
  if (file === null) throw new Error(`nothing mirrored at ${repoPath}`);
  const parsed = splitFrontmatter(file);
  if (!parsed.ok) throw new Error(`${repoPath} does not parse: ${parsed.error.message}`);
  return parsed;
}

async function gitOut(root: string, args: string[]): Promise<string> {
  const run = await runGit(gitIn(root), args);
  expect(run.ok, `git ${args.join(" ")} failed: ${run.stderr}`).toBe(true);
  return run.stdout.trim();
}

/** How many commits in the whole history mention this version id in their message body. */
async function commitsNaming(root: string, versionId: string): Promise<number> {
  const log = await gitOut(root, ["log", "--format=%H%x00%B%x00"]);
  return log.split(versionId).length - 1;
}

/** The newest version row of a page, with everything the mirrored file claims about it. */
async function newestVersion(pageId: string) {
  return await db.pageVersion.findFirstOrThrow({
    where: { pageId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      frontmatter: true,
      gitSha: true,
      createdAt: true,
      author: { select: { name: true, email: true } },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* A publish, in a real repository, painted on a real page                    */
/* -------------------------------------------------------------------------- */

test("a publish is mirrored as a file that parses back to the version, and the reader shows that commit", async ({
  page,
}) => {
  const root = await scratch("e2e-tree-publish");
  const remote = await bareRemote();
  const fixture = await seedPublishedPage({
    slug: "e2e-tree-publish",
    title: "Mirrored topic registry",
    markdown: "---\nsystems:\n  - mqtt-broker\n---\n\nThe body the mirror has to carry.\n",
  });

  await drain({ root, remoteUrl: remote }, "1 done, 0 retrying, 0 failed");

  /*
   * The round trip, against a row that went through a real publish rather than a literal — and
   * every expected value is read **from the row**, because the property is that the file's bytes
   * say what the version says. A test that asserted string literals here would still pass with
   * the mirror writing a different version's values, and one that only checked the file "contains
   * the title" could not fail on an injected second key at all.
   */
  const version = await newestVersion(fixture.id);
  const parsed = await parseMirrored(root, `engineering/${fixture.path}.md`);
  expect(parsed.frontmatter).toEqual({
    title: version.title,
    space: "engineering",
    path: fixture.path,
    docType: "DOC",
    status: version.status,
    version: version.id,
    author: { name: version.author.name, email: version.author.email },
    publishedAt: version.createdAt.toISOString(),
    /*
     * **`declared` is the `frontmatter` column, and asserting it against a literal was wrong.**
     * Written first as `{ systems: ["mqtt-broker"] }` — the document's own text — this failed with
     * `relations: { AMENDS: [], DECIDES: [], RELATES_TO: [], SUPERSEDES: [] }` and `status: null`
     * beside it, because the column holds what **validation accepted**, normalised buckets and
     * all, which is the value this phase decided to mirror rather than the author's text. So the
     * comparison is against the column: that is what "parses back to the version" means, and a
     * literal here would have pinned one document's shape rather than the round trip.
     */
    declared: version.frontmatter,
  });
  // The non-vacuity companion for that line: an empty `declared` on both sides would satisfy it.
  expect(parsed.frontmatter.declared).toMatchObject({ systems: ["mqtt-broker"] });
  // The stored body, byte for byte — the author's own blank line after their frontmatter
  // included, which is the property `mirrorDocumentOf` gives up a separator line to keep.
  expect(parsed.body).toBe("\nThe body the mirror has to carry.\n");

  // One commit, and it is the one the version now names.
  expect(await gitOut(root, ["rev-list", "--count", "HEAD"])).toBe("1");
  expect(version.gitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(await gitOut(root, ["rev-parse", "HEAD"])).toBe(version.gitSha);
  // The publisher authored it; the service committed it. Task 5 measured that the author email is
  // the field a git host matches to an account, so it is the half that matters.
  expect(await gitOut(root, ["log", "-1", "--format=%an|%ae|%cn|%ce"])).toBe(
    `${version.author.name}|${version.author.email}|${COMMITTER.name}|${COMMITTER.email}`,
  );
  // And it is on the remote, which is what "mirrored" means once one is configured.
  expect(await gitOut(root, ["ls-remote", "--", remote, "HEAD"])).toContain(version.gitSha!);

  /*
   * §10's other half, and the assertion neither side of the seam can make alone: the sha that is
   * in the repository is the sha the reader is shown. Bound to the `title` attribute rather than
   * to the ten visible characters, because a truncated display is satisfied by any commit sharing
   * a prefix — and the visible text is asserted beside it so the pair still says what a person
   * sees.
   */
  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);
  const sha = page.locator("code.sha");
  await expect(sha).toHaveText(shortSha(version.gitSha!));
  await expect(sha).toHaveAttribute("title", version.gitSha!);
});

/* -------------------------------------------------------------------------- */
/* A move renames the file                                                    */
/* -------------------------------------------------------------------------- */

test("a move renames the mirrored file: the old path is gone and the new one holds the content", async ({
  page,
}) => {
  const root = await scratch("e2e-tree-move");
  const destination = await seedPublishedPage({
    slug: "e2e-tree-dest",
    title: "Destination section",
    markdown: "The section the page moves into.\n",
  });
  const fixture = await seedPublishedPage({
    slug: "e2e-tree-moved",
    title: "Page that moves",
    markdown: "The body that has to travel with the rename.\n",
  });

  // No remote: §19 makes one optional, and this test is about the tree. The two publishes are two
  // jobs, which is also what makes the summary below a statement about *this* fixture.
  await drain({ root }, "2 done, 0 retrying, 0 failed");
  expect(await mirrored(root, `engineering/${fixture.path}.md`)).toContain("travel with the rename");

  // The move over HTTP, through the route that enqueues inside `movePage`'s own transaction.
  await signIn(page, "aisyah@example.com");
  const moved = await page.request.post(`/api/pages/${fixture.id}/move`, {
    data: { newParentId: destination.id, newSlug: "e2e-tree-moved" },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const newPath = (
    await db.page.findUniqueOrThrow({ where: { id: fixture.id }, select: { path: true } })
  ).path;
  expect(newPath).toBe(`${destination.path}/e2e-tree-moved`);

  await drain({ root }, "1 done, 0 retrying, 0 failed");

  // The absence, and its non-vacuity companion in the same test: a mirror that wrote nothing at
  // all would satisfy the first line and fail the second.
  expect(await exists(root, `engineering/${fixture.path}.md`)).toBe(false);
  expect(await mirrored(root, `engineering/${newPath}.md`)).toContain("travel with the rename");

  // A rename in git's own eyes, not a delete plus an add. `--find-renames` is what makes the
  // mirror's history readable through a reorganisation.
  expect(await gitOut(root, ["log", "-1", "--find-renames", "--name-status", "--format="])).toBe(
    `R100\tengineering/${fixture.path}.md\tengineering/${newPath}.md`,
  );
});

/* -------------------------------------------------------------------------- */
/* A delete removes it, and a restore brings it back where the page is NOW    */
/* -------------------------------------------------------------------------- */

test("a delete removes the mirrored file, and a restore after a move brings it back at the moved path", async ({
  page,
}) => {
  /*
   * **Why the fixture is move-then-delete-then-restore rather than delete-then-restore.** Task 4
   * established that a restore writes the file back at whatever path the page holds by *then* —
   * the mutable address is captured per job, not carried from the publish. A delete-restore pair
   * cannot tell that apart from a restore that re-used the publish's captured path, because both
   * paths are the same string. With a move in the middle they differ, and the file coming back at
   * the moved address is the discrimination.
   */
  const root = await scratch("e2e-tree-restore");
  const destination = await seedPublishedPage({
    slug: "e2e-tree-restore-dest",
    title: "Destination for a restored page",
    markdown: "The section the page moves into before it is deleted.\n",
  });
  const fixture = await seedPublishedPage({
    slug: "e2e-tree-restore",
    title: "Page that is deleted and restored",
    markdown: "The body that has to come back.\n",
  });
  await drain({ root }, "2 done, 0 retrying, 0 failed");
  const publishedPath = fixture.path;

  await signIn(page, "aisyah@example.com");
  const moved = await page.request.post(`/api/pages/${fixture.id}/move`, {
    data: { newParentId: destination.id, newSlug: "e2e-tree-restore" },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const movedPath = `${destination.path}/e2e-tree-restore`;
  await drain({ root }, "1 done, 0 retrying, 0 failed");
  expect(await mirrored(root, `engineering/${movedPath}.md`)).toContain("come back");

  // Delete as the editor: `deletePage` is EDIT, and `restorePage` is MANAGE_SPACE — the asymmetry
  // `e2e/authoring.spec.ts` drives through the UI. Both go through the routes here.
  const deleted = await page.request.post(`/api/pages/${fixture.id}/delete`);
  expect(deleted.status(), await deleted.text()).toBe(200);
  await drain({ root }, "1 done, 0 retrying, 0 failed");
  expect(await exists(root, `engineering/${movedPath}.md`)).toBe(false);

  // Restore as the super admin, who is the only seeded identity holding MANAGE_SPACE here.
  await page.context().clearCookies();
  await signIn(page, "admin@example.com");
  const restored = await page.request.post(`/api/pages/${fixture.id}/restore`);
  expect(restored.status(), await restored.text()).toBe(200);
  await drain({ root }, "1 done, 0 retrying, 0 failed");

  // Back at the address the page has **now**, with the version's own bytes — and not at the
  // address it was published at, which is the mutant this fixture exists to kill.
  const parsed = await parseMirrored(root, `engineering/${movedPath}.md`);
  const version = await newestVersion(fixture.id);
  expect(parsed.frontmatter).toMatchObject({ version: version.id, path: movedPath });
  expect(parsed.body).toContain("come back");
  expect(await exists(root, `engineering/${publishedPath}.md`)).toBe(false);

  // Four commits for four jobs, and the mirror is a history rather than a snapshot.
  expect(await gitOut(root, ["log", "--format=%s"])).toBe(
    [
      `Restore "engineering/${movedPath}"`,
      `Delete "engineering/${movedPath}"`,
      `Move "engineering/${publishedPath}" to "engineering/${movedPath}"`,
      `Publish "engineering/${publishedPath}"`,
      `Publish "engineering/${destination.path}"`,
    ].join("\n"),
  );
});

/* -------------------------------------------------------------------------- */
/* A push that fails, then works — one commit                                 */
/* -------------------------------------------------------------------------- */

test("a failing push leaves the publish standing and the version unmirrored, then one working push mirrors it with one commit", async ({
  page,
}) => {
  /*
   * **A failing push needs a remote that fails, not a missing one.** Task 5 measured that `push`
   * with no remote *configured* is a no-op success (`pushed: false`), so a test that simply left
   * `GIT_REMOTE_URL` unset would assert nothing. And a remote that is already gone on the first
   * run fails the *clone* instead, which is a whole-run `fatal` (exit 2) and not a job's failure —
   * `not-a-repository` is deliberately absent from the worker's `PERMANENT` set for that reason.
   *
   * So the sequence is the operational one: a working remote, then a remote that goes away under
   * a tree that already exists, then the same remote back again.
   */
  const root = await scratch("e2e-tree-push");
  const remote = await bareRemote();
  const fixture = await seedPublishedPage({
    slug: "e2e-tree-push",
    title: "Page whose push fails",
    markdown: "The first body, which is mirrored.\n",
  });
  await drain({ root, remoteUrl: remote }, "1 done, 0 retrying, 0 failed");

  // The remote goes away. The tree is already a repository, so `ensureRepository` reports
  // `existing` and the run reaches the push — which is the failure under test.
  await rm(remote, { recursive: true, force: true });
  await republishPage(fixture, { markdown: "The second body, whose push fails.\n" });
  const version = await newestVersion(fixture.id);

  /*
   * **The backoff is left at its default, and compressing it was a measured mistake.** With
   * `GIT_WORKER_BACKOFF_MS=1` this drain reported `0 done, 3 retrying, 0 failed` for **one** job:
   * `drainMirrorJobs` claims until nothing is claimable, and a job whose `nextAttemptAt` is a
   * millisecond out is claimable again inside the same run — so the retry a test wants to observe
   * once happens three times and spends three of the job's five attempts. Thirty seconds is the
   * default and it makes this run attempt the push exactly once; the wind-back below is what gets
   * the retry without sleeping for it.
   */
  const failing = await drain({ root, remoteUrl: remote }, "0 done, 1 retrying, 0 failed");
  expect(failing.stdout).toContain("Pushing to the content remote");

  /*
   * The exit criterion, in three parts. The publish stands, the version is not mirrored, and the
   * job is queued to try again — and the commit is already on disk, which is what makes the retry
   * a push rather than a second commit.
   */
  const midflight = await db.pageVersion.findUniqueOrThrow({
    where: { id: version.id },
    select: { gitSha: true, page: { select: { publishedVersionId: true } } },
  });
  expect(midflight.gitSha).toBeNull();
  expect(midflight.page.publishedVersionId).toBe(version.id);
  const queued = await db.gitJob.findFirstOrThrow({
    where: { versionId: version.id },
    select: { state: true, attempts: true, lastError: true },
  });
  expect({ state: queued.state, attempts: queued.attempts }).toEqual({
    state: "PENDING",
    attempts: 1,
  });
  expect(queued.lastError).toContain("Pushing to the content remote");
  expect(await commitsNaming(root, version.id)).toBe(1);

  // The reader is unharmed: the new text is published and readable, and the missing sha reads as
  // a state rather than as a gap. Documentation does not go down because a git host does.
  await signIn(page, "aisyah@example.com");
  await page.goto(`/engineering/${fixture.path}`);
  await expect(page.locator(".doc")).toContainText("The second body, whose push fails.");
  await expect(page.locator(".meta")).toContainText("not mirrored");
  await expect(page.locator("code.sha")).toHaveCount(0);

  // The remote comes back at the same address, and the job is retried as a **push**.
  const returned = await runGit(gitIn(root), [
    "init",
    "--bare",
    "--initial-branch",
    "main",
    "--",
    remote,
  ]);
  expect(returned.ok, returned.stderr).toBe(true);

  // `nextAttemptAt` is thirty seconds out, so it is wound back rather than waited for — the same
  // move `tests/integration/git-worker.test.ts` makes, and the only row this test edits by hand.
  await db.gitJob.updateMany({
    where: { versionId: version.id },
    data: { nextAttemptAt: new Date() },
  });

  await drain({ root, remoteUrl: remote }, "1 done, 0 retrying, 0 failed");

  const mirroredNow = await db.pageVersion.findUniqueOrThrow({
    where: { id: version.id },
    select: { gitSha: true },
  });
  expect(mirroredNow.gitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(await gitOut(root, ["rev-parse", "HEAD"])).toBe(mirroredNow.gitSha);
  // **One commit for one publish**, which is the property `commit` and `push` are split to hold:
  // the retry found a clean index and pushed the commit it already had. Counted by the version id
  // in the commit body rather than by the total, so a second publish's commit cannot mask a
  // duplicate of this one.
  expect(await commitsNaming(root, version.id)).toBe(1);
  expect(await gitOut(root, ["rev-list", "--count", "HEAD"])).toBe("2");
  expect(await gitOut(root, ["ls-remote", "--", remote, "HEAD"])).toContain(mirroredNow.gitSha!);

  // And the reader now shows it, which is the same value from the third source.
  await page.goto(`/engineering/${fixture.path}`);
  await expect(page.locator("code.sha")).toHaveAttribute("title", mirroredNow.gitSha!);
});
