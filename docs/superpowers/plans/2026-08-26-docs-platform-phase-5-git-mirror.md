# Phase 5 — Git mirror

Spec: [`../specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md)
(§10, §9 step 8, §5.2 `GitJob`, §17 configuration) ·
Roadmap: [`2026-08-21-docs-platform-roadmap.md`](2026-08-21-docs-platform-roadmap.md) ·
Phase 4: [`2026-08-25-docs-platform-phase-4-search-diagrams.md`](2026-08-25-docs-platform-phase-4-search-diagrams.md)

Branch: `phase-5-git-mirror`, cut from `main` at `8dfc7c7`. This phase lands through a PR.

**Deliverable.** Publishing produces a real commit in a content repository, authored by the
publisher, and the version carries its sha. A move renames the file; a delete removes it. The
push is optional and never blocks a publish: a failing remote leaves `gitSha = null`, retries with
backoff, and shows up on a page a super admin can read.

## Decisions taken with the user before writing this

- **Shell out to the `git` binary**, with an argv array — never a shell string. §10 says the
  mirror "runs against a local clone" and works against any host without code changes, which is a
  statement about using real git. Credentials, SSH and hooks then behave the way whoever operates
  this already expects. The cost is a subprocess seam to keep honest.
- **A standalone worker script on a schedule** — `npm run git:worker` claims, drains and exits.
  Git subprocesses and a working tree stay out of the web container's request path, backoff state
  lives in the row rather than in a running process, and a wedged worker cannot wedge the app.
- **A minimal super-admin route now**, folded into the real `/admin` in Phase 6. §10's
  "persistent failures surface on an admin page rather than only in logs" is the property that
  makes a broken mirror *noticed*, and deferring it to Phase 6 would defer exactly that.
- **Publish, move and delete all enqueue.** §9 step 8 names only publish, but `movePage` rewrites
  `Page.path`, so a publish-only mirror leaves an orphan `.md` at the old path and the tree
  quietly stops matching Postgres. Mirroring all three keeps the mirror true.

## A decision this phase has to take on its own

**The mirrored file is composed from the version row, not copied from it.** Measured:
`publishPage` stores `markdown: draft.markdown` — the author's whole document, frontmatter text
included — while `PageVersion.frontmatter` holds what validation *accepted*, which is
deliberately **not the same value** (`supersedes: decisions/adr-0031` is a scalar in the draft and
a one-element array in the column, and `publish.test.ts` pins that they differ).

So a verbatim copy and a composed file are different products, and the deciding fact is that
**`title` is a column and not part of the document text** — the ADR template's frontmatter has no
`title:` key. A verbatim mirror would produce files that cannot say what they are.

Therefore the mirror writes a canonical YAML block built from the row — title, docType, status,
space, path, version id, author, publishedAt — followed by the body with the author's frontmatter
removed. What is given up, and should be stated rather than discovered: the author's frontmatter
**comments** do not reach the mirror (the templates ship explanatory comments, and they are
scaffolding rather than content), and neither do keys the validator dropped. A test pins that
parsing a mirrored file back yields exactly the row's values.

**This needs a serializer, and there is none** — `src/lib/markdown/frontmatter.ts` exports
`splitFrontmatter` and nothing that writes. Task 1 builds it.

## What Phase 5 does NOT do

- **`/admin` proper, spaces and member administration** (§11, §17) — Phase 6. This phase ships one
  read-only list of failed jobs, not an administration surface.
- **Reading the mirror back.** Nothing imports from git; Postgres stays the live store. The mirror
  is write-only, which is what makes "never on the critical path" cheap to hold.
- **Conflict resolution or merges.** The content repository has exactly one writer. If a human
  commits into it, that is an operational fact this phase does not adjudicate — it pushes and, on
  rejection, retries and then surfaces the failure.
- **Attachments** (§17) — Phase 6 owns `BlobStore`. Only Markdown is mirrored.
- **Backfilling history.** Existing versions predate the mirror and stay `gitSha = null`. A
  reconcile pass is a Phase 6-or-later concern; say so in the admin surface rather than implying
  the tree is complete.

## Landmines

**Three different things in this codebase are called `gitSha`, and two of them are not this
phase's.** `buildInfo().gitSha` is the **application build**, read from the `GIT_SHA` env var and
truncated to 7 characters. `BugReport.gitSha` is a copy of that, captured at report time.
`PageVersion.gitSha` — the only one this phase writes — is a commit in the **content**
repository, a different repository entirely. The reader already paints a build string in the
footer, so a page will show two shas that mean different things. Name them apart in the UI, store
the content sha in full and shorten it only where it is displayed, and do not reach for
`buildInfo()` anywhere in `lib/git`.

**A page title is user-controlled and this phase puts it in two places that parse.** It goes into
YAML, where `title: ` plus a newline plus `status: ACCEPTED` would inject a second key if the
block were built by concatenation; and into a commit message, where a leading `-` or an embedded
newline changes what git sees. Use `yaml`'s serializer rather than string building, pass every
git argument as its own array element, and test with the hostile title the e2e suite already
carries. **Measured, and the reassuring half:** a `GIT_AUTHOR_NAME` of
`--upload-pack=touch /tmp/pwned` passed through the environment is stored verbatim as the author
name and is *not* parsed as an option. So environment variables are the safe channel for identity;
`--author=` string parsing is the one to avoid.

**`content/<space-key>/<path>.md` is assembled from data, so it can escape `content/`.** `Page.path`
is built from validated slugs today, but the mirror must not depend on a guarantee made three
modules away for a different reason. Resolve the final path and refuse anything that does not sit
under the working tree — with a test that feeds it `..` and asserts the refusal, not the
sanitisation.

**A pipeline hides the exit code of its first command, and this phase is made of subprocesses.**
This project has three bugs from exactly that, and it caught me again while measuring for this
plan: `git rev-parse HEAD | head -2` reported success on a fatal error. The real exit code in an
empty repository is **128** — for `rev-parse HEAD`, `rev-parse --verify HEAD` and `log -1` alike.
So: capture status directly from the spawn, never through a pipe, and treat a fresh clone with no
commits as an expected state rather than a crash.

**Commit and push are two failures, and only one of them may be retried by repeating it.** If the
commit succeeds and the push fails, re-running the job must not commit again — that is how a
mirror grows duplicate commits for one publish. Record the sha the moment the commit exists, then
treat push as a separate, idempotent step.

**Jobs for one page are order-dependent.** Two publishes queued in order and drained out of order
leave the mirror showing the older text, with `gitSha` on the newer version — a mirror that is
wrong in a way nothing notices. Drain per page in enqueue order, or make a job carry enough to
detect it has been superseded and skip.

**One working tree, so two workers corrupt it.** `git` takes its own `index.lock`, but the failure
that produces is an operational mystery rather than a clean refusal. Take a Postgres advisory lock
on the repository before touching it, the way Phases 2 and 3 lock a space.

**The working tree is not durable state** (§17: re-cloned on start). The worker must handle the
tree being absent, and `content/` must be ignored by *this* repository — a git working tree nested
inside the app's own checkout is otherwise a mess that shows up as untracked noise or, worse, as a
committed submodule.

## Conventions that carry forward

Settled in Phases 1–4. Changing one is a decision, not a detail.

- `readableSpace(...)` and `visiblePage(...)` return complete `where` objects and **must never be
  spread**. The admin surface is a query like any other and states its own predicate.
- Never `include:`; always an explicit `select:`.
- **Every module that queries the database is registered** in `src/lib/pages/visible.test.ts`.
  That guard has been too narrow **seven times** — the last was Phase 4's count contract, which
  could not see the one `BugReport` a spec wrote. Read its docstring before assuming it sees a new
  `gitJob` delegate.
- Only `src/lib/audit/log.ts` may touch the `auditLog` delegate.
- Control characters as **escapes, never literals**.
- A concurrency test that never blocks is not testing a write predicate.
- An absence assertion needs a viewer, or a fixture, that can see **something** — Phase 4's
  non-member search was near-vacuous until it became a discrimination.
- A security test that cannot fail when the setting it is about is weakened is worse than no test.
- `npm run plan:check` must report **0 drifted** before a task is closed.
- Implementers make **small commits**, never `--amend`, and stage explicit paths.

---

## Task 1: The mirrored document

Pure, no database, no git. Everything the mirror writes goes through this.

**Files:** `src/lib/git/document.ts` + tests.

- [x] **Step 1: A frontmatter serializer**

There is none. Use the `yaml` package's serializer — already a dependency at `^2.9.0`, and already
the parser behind `splitFrontmatter`, so the round trip is against the same grammar rather than
across two.

- [x] **Step 2: `mirrorDocumentOf(version)`**

The canonical block, then a blank line, then the body with the author's frontmatter removed.
Decide and document the key order — it is a diff that humans read, so it is a design choice and
not an implementation detail. Every value comes from the row; nothing is re-derived.

- [x] **Step 3: Round-trip and hostile input**

`splitFrontmatter(mirrorDocumentOf(v))` yields exactly the row's values. Then the hostile title
from `e2e/search.spec.ts` — the one carrying `<img src=x onerror=…>` and 250 characters of
punctuation — plus a title containing a newline and `status: ACCEPTED`, and assert the parsed
result has the title as **one** key and no injected second key. A test that only checks the file
"contains" the title cannot fail on injection.

---

## Task 2: Where the file goes

Pure. Separate from Task 1 because path safety is its own argument.

**Files:** `src/lib/git/paths.ts` + tests.

- [ ] **Step 1: `mirrorPathOf(root, spaceKey, path)`**

`content/<space-key>/<path>.md`. Resolve, then **verify containment** under the root and refuse
otherwise. Refuse, do not sanitise: a path that needed sanitising is a bug upstream, and silently
rewriting it hides that.

- [ ] **Step 2: Feed it the things that escape**

`..`, an absolute path, a space key with a slash, an empty path, a path that normalises to the
root itself. Each is a refusal with a reason. Pair with the ordinary case so the test is not
passing because everything is refused.

---

## Task 3: `GitJob`

**Files:** `prisma/schema.prisma`, a migration.

- [ ] **Step 1: The model**

Per spec §5.2 and `GitJobState { PENDING RUNNING FAILED DONE }`. It needs: the page, the version
for a publish, the *kind* of change, the paths involved (a move needs the old one, and the old
path is not reconstructible once `Page.path` has changed), retry state (attempts, next attempt,
last error), and enqueue order.

Adding a table means checking Phase 4's lesson: the e2e `snapshotCounts` and `scripts/smoke.sh`'s
`counts()` both enumerate tables, and Phase 4 found one blind to the only write a spec made. This
phase **does** add a table, so both contracts need it — and the smoke test writes to it.

- [ ] **Step 2: Indexes for the claim query, not for reading**

The worker's query is "the next claimable job", which is a partial-order scan by state and next
attempt. Index for that. Say in a comment which query each index serves.

---

## Task 4: Enqueue, inside the transactions that already exist

**Files:** `src/lib/git/enqueue.ts`, `src/lib/pages/publish.ts`, `move.ts`, `delete.ts` + tests.

- [ ] **Step 1: Enqueue on publish — §9 step 8, inside the same transaction**

The spec is explicit that step 8 "is committed with it". So a published version without a queued
job is not a state this system can reach, and the test for that is that a forced enqueue failure
rolls the publish back. That is the *opposite* of the "never on the critical path" property, which
is about the push — say so in the code, because the two read as contradictory.

- [ ] **Step 2: Enqueue on move and on delete**

A move carries both paths. A soft delete removes the file; **restore puts it back**, so restore
enqueues too or the mirror stays missing a page Postgres has. Check `restorePage` for what it
already does and give it the same treatment.

- [ ] **Step 3: Register with the guard that has been too narrow seven times**

`src/lib/pages/visible.test.ts`. Read its docstring first.

---

## Task 5: The git seam

**Files:** `src/lib/git/repo.ts` + tests.

- [ ] **Step 1: One place that spawns `git`**

Argv arrays, captured status, captured stderr. No shell. A helper that returns a discriminated
result rather than throwing on non-zero, because "no commits yet" (exit 128) is an expected answer
in a fresh clone and not an error.

- [ ] **Step 2: The operations, each idempotent**

Ensure a repository exists (clone, or init when there is no remote — §19: a remote is optional).
Write a file, stage it, `git mv`, `git rm`. Commit with the publisher as author through
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, with the committer being the service. Push as a **separate**
operation.

- [ ] **Step 3: The hostile identity, and the empty repository**

Both measured while planning: a `GIT_AUTHOR_NAME` beginning `--upload-pack=` is stored as a name,
not parsed as a flag — assert that, so a later refactor to `--author=` string building fails here.
And a fresh repository answers 128 to `rev-parse HEAD`; assert the seam reports that as "no
commits" rather than surfacing a crash.

- [ ] **Step 4: `content/` out of this repository's sight**

`.gitignore`. A nested working tree is otherwise committed noise.

---

## Task 6: The worker

**Files:** `src/lib/git/worker.ts`, `scripts/git-worker.ts`, `package.json` + tests.

- [ ] **Step 1: Claim a job without two workers taking it**

`FOR UPDATE SKIP LOCKED`, or a conditional state transition — and whichever it is, the test has to
**block**: a concurrency test that never blocks is not testing a write predicate. Take the
advisory lock on the repository too, and prove the second worker waits rather than corrupting the
tree.

- [ ] **Step 2: Order per page**

Two publishes drained out of order leave the mirror older than the sha recorded on the version.
Assert the ordering property directly, with two queued jobs whose correct outcome is
distinguishable — the same trap Phase 4's ranking check had to avoid, where the assertion passes
in either order.

- [ ] **Step 3: Commit, then push, then record**

Write the sha as soon as the commit exists, so a failed push is retried as a push and not as a
second commit. Prove it: fail the push, re-run, and assert **one** commit and one sha.

- [ ] **Step 4: Backoff, and a terminal state**

Attempts increment, next attempt moves out, and after the configured ceiling the job is `FAILED`
rather than retried forever. `DONE` is terminal too. Assert the publish stood throughout — the
spec's central claim is that documentation does not go down because a git host does.

- [ ] **Step 5: `npm run git:worker`**

Claims, drains, exits, with an exit code an operator can put in a cron. Nonzero when a job ended
`FAILED`, zero when there was nothing to do.

---

## Task 7: The sha on the page

**Files:** `src/components/` page info, a version history route + tests.

- [ ] **Step 1: Surface the content sha, distinctly from the build sha**

§10: the reader shows the published commit sha "so provenance is visible and a broken mirror is
noticed". The footer already shows a build string. Two shas on one page that mean different things
is a UI problem, not a data problem — label them.

- [ ] **Step 2: `gitSha = null` is a normal state and must read as one**

An unmirrored version is the expected state for every version published before this phase, and for
any publish whose push is still queued. It says "not mirrored yet", not "error", and it must not
be a gap where a value should be.

- [ ] **Step 3: Link to version history**

§10 says the reader links to it. A list of a page's versions with author, date, status and sha.
Permission is the page's own — `visiblePage`, stated here and not inherited.

---

## Task 8: Failures a super admin can see

**Files:** a route under the reader's `-` convention or a new group + tests.

- [ ] **Step 1: The list**

`FAILED` jobs with the page, the attempt count and the last error. Super admin only, and the
refusal is the project's usual **not-found** rather than forbidden — a job list is not a way to
learn which pages exist.

- [ ] **Step 2: Say what it does not cover**

Versions published before this phase carry no sha and are not failures. A page claiming to show
"the mirror's health" while silently omitting them would be worse than one that states the gap.

- [ ] **Step 3: The refusal survives deleting the other guard**

A refusal that survives deleting the guard it names is a test of some other guard. Mutation-verify
this one.

---

## Task 9: End-to-end and the smoke test

- [ ] Publishing writes a file whose content parses back to the version, in a real repository.
- [ ] A move renames it; the old path is gone and the new one holds the content.
- [ ] A delete removes it; a restore brings it back.
- [ ] A failing push leaves the publish standing, the version unmirrored, and the job retrying —
      then a working push mirrors it, with **one** commit.
- [ ] The failed-jobs page shows a persistent failure and a non-admin cannot reach it.
- [ ] `scripts/smoke.sh`: publish over HTTP, drain the worker, assert the file and the sha. Extend
      `counts()` for the new table. Prove it can fail; the exit code is the contract.

---

## Phase 5 exit criteria

- [ ] `npm test`, `npm run test:e2e`, `npm run smoke` all pass
- [ ] `npm run typecheck && npm run build` clean; `npm run plan:check` 0 drifted
- [ ] A publish produces one commit in the content repository, authored by the publisher, and the
      version carries its sha
- [ ] A move renames the mirrored file; a delete removes it; a restore returns it
- [ ] **A publish succeeds with the remote unreachable** — the version stands, `gitSha` is null,
      the job retries with backoff, and the failure is visible to a super admin
- [ ] A push that fails and then succeeds produces exactly one commit
- [ ] Two workers cannot claim one job, and cannot both hold the working tree
- [ ] Jobs for one page apply in order
- [ ] A hostile title reaches neither YAML nor a git argument as syntax
- [ ] A mirrored path cannot escape `content/`
- [ ] The reader shows the content sha, distinguishable from the build sha, and links to version
      history
- [ ] The PR is open with the phase's exit criteria in its description
