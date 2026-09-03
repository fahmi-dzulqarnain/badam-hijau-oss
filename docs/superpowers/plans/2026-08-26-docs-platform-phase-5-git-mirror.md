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
`splitFrontmatter` and nothing that writes. Task 1 built it, and put it **in that file** rather
than in `src/lib/git/`: `---` is the fence `remark-frontmatter` matches, and a writer in another
module is a second, invisible declaration of the grammar that module exists to keep singular.

**Two measurements from Task 1 that the mirror depends on.** `yaml` emits **anchors and aliases by
default** for a repeated object — `{x: shared, y: shared}` becomes `x: &a1 … y: *a1`, while the
structurally identical `{x: [a,b], y: [a,b]}` writes both in full. Output that depends on object
*identity* rather than value cannot be a mirror, so `aliasDuplicateObjects: false`, plus
`lineWidth: 0` so a one-character title edit does not re-flow every following line. And the plan's
"then a blank line, then the body" was one line too many: `splitFrontmatter` removes only the
fence's own line ending, so the author's blank line is already in `body`, and the mirrored body is
now the stored body byte for byte.

**The unparseable-frontmatter question had a better answer than either the plan offered**, because
its premise was wrong: `splitFrontmatter` slices `body` from the parsed node's offset *before* any
cap or YAML error is evaluated, so the author's block is gone on the failure branch too — measured
directly. "Silently leaving the frontmatter in the body" was never reachable, so reading `body` on
both branches is right, and refusing would only mean a version publish already accepted stops
reaching the mirror because a cap was lowered afterwards.

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

## Task 1: The mirrored document ✅

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

## Task 2: Where the file goes ✅

Pure. Separate from Task 1 because path safety is its own argument.

**Files:** `src/lib/git/paths.ts` + tests.

- [x] **Step 1: `mirrorPathOf(root, spaceKey, path)`**

`content/<space-key>/<path>.md`. Resolve, then **verify containment** under the root and refuse
otherwise. Refuse, do not sanitise: a path that needed sanitising is a bug upstream, and silently
rewriting it hides that.

- [x] **Step 2: Feed it the things that escape**

`..`, an absolute path, a space key with a slash, an empty path, a path that normalises to the
root itself. Each is a refusal with a reason. Pair with the ordinary case so the test is not
passing because everything is refused.

**The order of two operations is the whole guard, and this is the finding of the task.** `".."`
plus `".md"` is `"...md"` — a legal filename that resolves **inside** the space directory. So
appending the extension *before* resolving accepts a traversal with the containment check fully
present and writes junk: measured, `/srv/badam/content/engineering/...md` where resolving first
gives `/srv/badam/content.md` and a refusal. `.md` is appended after resolution, and that order is
load-bearing rather than stylistic.

**Containment is against the space directory, not the working tree.** `../handbook/welcome` never
leaves `content/`, so a tree-level check accepts one space overwriting another space's file. There
is deliberately no separate "is absolute" or "contains `..`" test beside it — containment refuses
both, and a second copy would make the first deletable with the suite still green.

**Two limits left to the layer that knows them, as decisions rather than omissions.** Total path
length: per-component is safe (`SLUG_MAX_LENGTH` 80 against a measured `NAME_MAX` of 255) but the
total is not (`MAX_PATH_BYTES` 2000 plus `.md` plus the root, against a measured `PATH_MAX` of
**1024** on darwin). A guessed cap would refuse a page that published fine, so `ENAMETOOLONG`
carries the real limit into the job's retry path. And **no case folding**: a fold collision is a
property of *two* space keys and this function sees one, while refusing uppercase would close the
ASCII half and leave NFC/NFD and dotless `ı` open — this project's most repeated failure shape. The
check that closes it is a folded uniqueness constraint where space keys are created, which is
**Phase 6's**, and `Engineering` versus `engineering` is two rows sharing one directory on a
case-insensitive filesystem until then.

**A correction to this plan's assumption about macOS:** NFD normalisation of filenames is HFS+
behaviour. Measured on this machine's APFS, it is normalisation-*insensitive* but byte-preserving —
a file written NFC is found under NFD, and `readdir` returns the bytes as written.

---

## Task 3: `GitJob` ✅

**Files:** `prisma/schema.prisma`, a migration.

- [x] **Step 1: The model**

Per spec §5.2 and `GitJobState { PENDING RUNNING FAILED DONE }`. It needs: the page, the version
for a publish, the *kind* of change, the paths involved (a move needs the old one, and the old
path is not reconstructible once `Page.path` has changed), retry state (attempts, next attempt,
last error), and enqueue order.

Adding a table means checking Phase 4's lesson: the e2e `snapshotCounts` and `scripts/smoke.sh`'s
`counts()` both enumerate tables, and Phase 4 found one blind to the only write a spec made. This
phase **does** add a table, so both contracts need it — and the smoke test writes to it.

- [x] **Step 2: Indexes for the claim query, not for reading**

The worker's query is "the next claimable job", which is a partial-order scan by state and next
attempt. Index for that. Say in a comment which query each index serves.

**`createdAt` cannot order these rows, and the reason is worse than this plan assumed.** The plan
said two jobs enqueued in the same millisecond would tie. Measured: Prisma binds `@default(now())`
**client-side**, so the column's `DEFAULT CURRENT_TIMESTAMP` never fires, and a single `createMany`
writes **byte-identical** values — which is exactly the shape a move enqueuing one job per moved
descendant will use. The tie is guaranteed for the operation that most needs ordering, not a rare
coincidence. Hence `id Int @default(autoincrement())` as both identity and order. Rejected:
`cuid()` (not a documented monotonic sequence), `(createdAt, id)` (deterministic, but it orders the
guaranteed tie *arbitrarily* — deterministic is not correct), and a separate `seq` beside a cuid
`id` (two surrogate keys is two ways to name a row and a query that can order by the wrong one).

**What the sequence does not give, measured, and handed to Task 6 as an obligation.** Sequence
values are issued at INSERT, not COMMIT: a slow transaction holding `62009` commits *after* a fast
`62010`, so a worker claiming the lowest ready id drains the later job first with no error
anywhere. For one page the enqueues are nearly exclusive — publish takes the `PageDraft` row lock,
create and move take the space advisory lock — but a publish and a move of the same page take
**different** locks and can interleave exactly that way. `@@index([pageId, id])` exists for the
earlier-unfinished check that closes it.

**Every path is captured at enqueue, and `spaceKey` with them.** This plan's argument — that a
move's old path is unreconstructible — was too narrow. A publish enqueued before a move and
drained after it would, reading `Page.path` at drain time, write its file at the *new* path, and
the move's own job would then `git mv` a path that never existed: a correctly ordered queue still
producing a wrong tree. Capturing the path but joining the key would give a job whose address
comes from two different instants. The rule, stated once in the schema: **capture the mutable,
join the immutable.** `Page.docType` is the one join to watch — `document.ts` needs it and
`PageVersion` does not carry it, safe only while nothing updates it.

**Foreign keys go the opposite way from `BugReport` in the same schema, deliberately.** That model
holds ids *without* keys because its value is highest once the row is gone; a `GitJob` is work
rather than a record, and work for a page that no longer exists has nothing to mirror. `versionId`
cascades rather than nulling, because a publish job with no version is a job that writes an empty
file. Safe because this product has no hard delete — with the rule recorded at the line that **a
future hard delete must remove the mirrored file before the row.**

**`DONE` rows are kept, because deleting them makes success unobservable.** "The job drained" and
"no job was ever enqueued" would become the same observation, and every drain assertion in Tasks 6
and 9 would go vacuous — this project's most repeated test failure, arriving through the schema.
The cost is unbounded growth with no retention pass, deferred to Phase 6 alongside `/admin`,
because a sweep with no operator surface is a cron job nobody knows about. Measured over 60,000
finished rows, `state` leading the claim index costs 4 buffers to seek past them.

---

## Task 4: Enqueue, inside the transactions that already exist ✅

**Files:** `src/lib/git/enqueue.ts`, `src/lib/pages/publish.ts`, `move.ts`, `delete.ts` + tests.

- [x] **Step 1: Enqueue on publish — §9 step 8, inside the same transaction**

The spec is explicit that step 8 "is committed with it". So a published version without a queued
job is not a state this system can reach, and the test for that is that a forced enqueue failure
rolls the publish back. That is the *opposite* of the "never on the critical path" property, which
is about the push — say so in the code, because the two read as contradictory.

- [x] **Step 2: Enqueue on move and on delete**

A move carries both paths. A soft delete removes the file; **restore puts it back**, so restore
enqueues too or the mirror stays missing a page Postgres has. Check `restorePage` for what it
already does and give it the same treatment.

- [x] **Step 3: Register with the guard that has been too narrow seven times**

`src/lib/pages/visible.test.ts`. Read its docstring first.

Registered `reachesPage: false`: every column of every job is a value the caller already read
under its own lock, so the module reads no `Page` row. **That absence is the design, not an
oversight**, and the `why` says so — because `restorePage` enqueues for pages whose `deletedAt` was
set a statement earlier, a version that *did* read `Page` would need a deliberately soft-delete-
blind query with its own argument and test.

**A page that was never published enqueues nothing.** It has no file in the mirror, so a job for
one could only ever be a no-op — and a queue containing no-ops makes "the queue drained" and "the
mirror changed" stop being the same observation, which is this project's most repeated test
failure built into the schema on purpose. The faithful-log-of-intent role is already held by
`AuditLog`, which records every move, delete and restore regardless. Safe because
`publishedVersionId` is never cleared; a future unpublish is the line that would break it, and
`enqueueMirrorJobs` names it.

**Two corrections to this plan's account of a move, both from the code rather than argued.** It
said every rewritten row's file moves. False twice: never-published rows have no file, and
**soft-deleted descendants are rewritten too** — their delete removed their file, and their
restore writes it back at whatever path they have by then. So `movePage` filters `deletedAt ===
null`, reusing the set the redirect reclaim already computes, and a three-row subtree move can
legitimately enqueue one job. `movePage` also does not return those rows; it returns counts, and
the rows are internal.

**And a correction to how the `db`-instead-of-`tx` mistake fails.** This plan implies it always
commits independently and silently. Measured: for publish and move it *times out* instead, because
both update columns under a unique index and hold `FOR UPDATE`, which the second connection's
foreign-key check blocks on. Only delete and restore — which touch `deletedAt` under `FOR NO KEY
UPDATE` — commit silently and pass everything. So the test for the transactional property is
written against a **restore**, where the mutant fails cleanly instead of arriving as a lock
mystery.

---

## Task 5: The git seam ✅

**Files:** `src/lib/git/repo.ts` + tests.

- [x] **Step 1: One place that spawns `git`**

Argv arrays, captured status, captured stderr. No shell. A helper that returns a discriminated
result rather than throwing on non-zero, because "no commits yet" (exit 128) is an expected answer
in a fresh clone and not an error.

- [x] **Step 2: The operations, each idempotent**

Ensure a repository exists (clone, or init when there is no remote — §19: a remote is optional).
Write a file, stage it, `git mv`, `git rm`. Commit with the publisher as author through
`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, with the committer being the service. Push as a **separate**
operation.

- [x] **Step 3: The hostile identity, and the empty repository**

Both measured while planning: a `GIT_AUTHOR_NAME` beginning `--upload-pack=` is stored as a name,
not parsed as a flag — assert that, so a later refactor to `--author=` string building fails here.
And a fresh repository answers 128 to `rev-parse HEAD`; assert the seam reports that as "no
commits" rather than surfacing a crash.

- [x] **Step 4: `content/` out of this repository's sight**

`.gitignore`. A nested working tree is otherwise committed noise.

**And it is worse than noise, which this plan did not know.** `git rev-parse --show-toplevel` run
in a *subdirectory* answers with the **ancestor's** root: measured inside this checkout, a probe
directory reports `--is-inside-work-tree true` and a toplevel of `/Users/fahmi/badam-hijau`. So a
boolean "is this a repository?" check on an empty `content/` would say yes and then commit every
mirrored page into the **application's own history**. `ensureRepository` compares an equality
against the resolved root instead — on **realpaths**, because `path.resolve` does not follow
symlinks and `os.tmpdir()` is one on macOS, which made the string comparison refuse a legitimate
temporary repository.

**The hostile-identity assertion this plan asked for does not discriminate, and the one that does
is about email rather than argument parsing.** The `--upload-pack=` name is stored verbatim on both
channels — the `--author=` refactor this plan said it would catch was built, and **all 31 tests
stayed green**, because that string is one argv element whose content is a value either way. It is
kept, as a characterisation test that says so. What separates the channels is a name containing an
address, measured on both:

```
env vars:   %an=[Evil ceo@example.com]  %ae=[publisher@example.com]
--author=:  %an=[Evil]                  %ae=[ceo@example.com]
```

git splits `--author=` on the **first** `<`, so a user-controlled display name **overwrites the
author email** — and the author email is what a git host matches to an account, while `User.name`
comes from the OIDC profile. Two environment variables cannot cross fields. That is the assertion
that earns its keep.

**`GIT_LITERAL_PATHSPECS=1` is load-bearing rather than hygiene**, for the reason Task 2 already
found: `Space.key` has no validation. `git add -- ':odd/welcome.md'` exits 128 without it, and
`:odd` and `:(icase)odd` are the spellings that discriminate.

**The empty commit exits 1 with its message on *stdout* and stderr completely empty** — a seam
building its error from stderr would report a blank reason. It is absorbed by asking
`git diff --cached --quiet` *before* committing, which works with no `HEAD` at all (it diffs
against the empty tree), so a fresh clone needs no special branch. `committed: false` comes back
with **`sha` = HEAD**, because nothing staged against HEAD means HEAD already holds those bytes —
so a worker that crashed after committing gets the right sha on retry without knowing it crashed.
After that pre-check, a non-zero `git commit` is an unclassified failure and Task 6 may treat it as
one. **This plan's example of the empty commit was wrong**: a status-only republish does not reach
it, because `status` and `version` are both keys in Task 1's canonical block and `publishPage`
always writes a new version row. The reachable routes are a repeated `MOVE`/`DELETE`/`RESTORE` and
the retry-after-commit.

**Timeouts kill the process group, not the child.** `git push` spawns `git-remote-http`; signalling
only the direct child leaves the grandchild holding the inherited pipes, `close` never fires, and
the bounded promise never settles — the `kill(pid)` mutant hangs the test rather than failing it.
Sixty seconds for network operations, ten for local ones, and a zero or garbage override falls back
rather than disabling the ceiling, because "no ceiling" is the wedged worker this exists to
prevent.

---

## Task 6: The worker ✅

**Files:** `src/lib/git/worker.ts`, `scripts/git-worker.ts`, `package.json` + tests.

- [x] **Step 1: Claim a job without two workers taking it**

`FOR UPDATE SKIP LOCKED`, or a conditional state transition — and whichever it is, the test has to
**block**: a concurrency test that never blocks is not testing a write predicate. Take the
advisory lock on the repository too, and prove the second worker waits rather than corrupting the
tree.

- [x] **Step 2: Order per page**

Two publishes drained out of order leave the mirror older than the sha recorded on the version.
Assert the ordering property directly, with two queued jobs whose correct outcome is
distinguishable — the same trap Phase 4's ranking check had to avoid, where the assertion passes
in either order.

- [x] **Step 3: Commit, then push, then record**

Write the sha as soon as the commit exists, so a failed push is retried as a push and not as a
second commit. Prove it: fail the push, re-run, and assert **one** commit and one sha.

- [x] **Step 4: Backoff, and a terminal state**

Attempts increment, next attempt moves out, and after the configured ceiling the job is `FAILED`
rather than retried for ever. `DONE` is terminal too. Assert the publish stood throughout — the
spec's central claim is that documentation does not go down because a git host does.

- [x] **Step 5: `npm run git:worker`**

Claims, drains, exits, with an exit code an operator can put in a cron. Nonzero when a job ended
`FAILED`, zero when there was nothing to do.

**Step 3 as written is incompatible with this phase's own exit criteria, and the exit criteria
win.** "Record the sha as soon as the commit exists" and "a publish with the remote unreachable
leaves `gitSha` null while the job retries" cannot both hold if the sha is written between the
commit and the push. The plan's sentence turns out to be *unnecessary* rather than merely
outvoted: nothing needs recording to make the retry idempotent, because Task 5 already built that
— a retry rewrites byte-identical content, so `git add` stages nothing and `commit()` returns
`committed: false` with **`sha` = HEAD**, which its docstring says exists for exactly this. So the
sha is written after the push reports success, including the no-remote case (§19), where the local
repository *is* the mirror. Recording early would also defeat the property it was meant to
protect: a sha painted on a page for a commit that exists on one server's disk and on no remote is
a broken mirror that is **not** noticed, which is the failure §10 is about.

**The claim's observable is a skip, not a block, and the blocking half is the tree lock.** With
`FOR UPDATE SKIP LOCKED` the correct behaviour when another worker holds the row is to return
immediately, so "the test must block" cannot be a property of the claim. Two tests, and they kill
different mutants: the claim test stages the row lock and races the claim against the settle
window — the read-then-write mutant (`SELECT` the id, then `UPDATE … WHERE id = $1`) *blocks*, and
without the race it turned into a five-second suite timeout rather than a named failure, the same
shape as the `kill(pid)` mutant that hung a Task 5 test. Dropping `SKIP LOCKED` alone is an
**equivalent** mutant for correctness and is reported rather than tested for: the second worker
blocks, then re-evaluates `state = 'PENDING'` against the committed row version and matches
nothing. The genuinely blocking test is the working tree, which is the exit criterion that needed
one: a competing session holds the advisory lock, the drain is started, and the mid-flight
assertions say **nothing** has happened — not even a `.git` directory — until the release lets it
finish.

**The tree lock needs its own client, and the reason is the rule against holding a transaction
open.** A session advisory lock belongs to a connection and Prisma pins one only inside an
interactive transaction — which is precisely what may not span a sixty-second push. So the lock
lives on a `PrismaClient` with `connection_limit=1`; measured, two statements on such a client
report the same `pg_backend_pid()`. The consequence is the good half: a session lock dies with its
session, so **a worker that is killed cannot leave the tree locked** — no lease, no stale lock
file. And two arguments rather than one, because the page mutations already take
`pg_advisory_xact_lock(hashtext(spaceId))`: measured, Postgres records the one-argument form with
`objsubid = 1` and the two-argument form with `objsubid = 2`, so the two key spaces cannot
collide. Both arguments are cast in the SQL — Prisma binds a JS number as `bigint`, and
`pg_advisory_lock(bigint, integer)` is not an overload Postgres has; it type-checked, built and
passed every test that never took the lock, then answered `42883` the first time the script ran.

**`@@index([pageId, id])` does not close the whole ordering hazard, and the correction matters.**
The barrier is a `NOT EXISTS` evaluated in the claim's own snapshot, and the inversion Task 3
measured is exactly a row that **is not yet committed** — invisible, so the clause is trivially
true and the later job is claimed anyway. What the barrier does close is every case where both
rows are visible, which is the common one: a job backing off while a later job for the same page
is due now would otherwise be drained first by `ORDER BY "nextAttemptAt"`. Closing the rest needs a
visibility fence (claiming only rows older than `pg_snapshot_xmin(pg_current_snapshot())`), whose
cost is that any long transaction anywhere stalls the whole mirror — a worse failure than the one
it prevents. So the residual is made **noticed** instead: the claim also reports whether a job with
a higher id for the same page has already reached `DONE`, and such a job is failed with a message
saying so rather than applied. In normal draining it is always false.

**A `FAILED` job blocks its own page and no other.** "Unfinished" in the barrier is `state <>
'DONE'`, so `FAILED` blocks too. Stepping over it applies job 3 without job 2 — an orphan file at
an old path beside a fresh one at the new, with every job reporting success — which is the silent
wrong tree §10 exists to prevent. The cost is that one bad job freezes that page until someone
intervenes, which is what Task 8 is for. Both halves are asserted in one test, because from a
single-page fixture "blocked the page" and "wedged the worker" are indistinguishable.

**A `MOVE` whose source is not in the tree is a success that did nothing.** Reachable by the
ordinary route rather than an exotic one: every version published before this phase has no
mirrored file (the plan's own "backfilling history" non-goal), so the first move of any such page
renames a path the tree has never held. Failing it would fill Task 8's page with jobs no operator
can clear, because a `MOVE` carries `versionId: null` by design and there are no bytes to write.
Repairing it would need those bytes from a `PageVersion` **joined at drain time**, which is the
join Task 4's capture rule forbids by name — and which would mirror whatever the page's *current*
published version is, not the version the job is about. The no-op converges instead: the address
is captured per job, so the page's next `PUBLISH` writes at the path it holds by then, and the
test asserts that convergence rather than only the absence.

**Stale `RUNNING` is a reclaim keyed on `updatedAt`, and the lease is the second line of the
argument rather than the first.** The reclaim runs under the tree lock, and nothing claims without
holding it — so a `RUNNING` row seen from inside the lock belongs to a worker that no longer holds
a *session* lock, which means a process that no longer exists. The lease (ten minutes) covers only
the residue: a live worker whose lock session dropped under it. If that happens the job runs twice,
both runs write the same bytes, the second finds a clean index, and the visible cost is a duplicate
push that git answers `Everything up-to-date`. The abandoned worker's late finish writes **nothing**,
because the finish predicate is `state = 'RUNNING' AND attempts = <this claim's value>` — `attempts`
is the fencing token. And the reclaim applies the **attempt ceiling** itself, which closes a loop the
plan did not name: a job that kills the worker every time never reaches the code that writes
`FAILED`, so a reclaim that only ever wrote `PENDING` would re-run it for ever while `attempts`
climbed past the ceiling unwatched.

**`MOVE`, `DELETE` and `RESTORE` are committed by the service, not by the last publisher.** Only a
`PUBLISH` names the row whose author published those bytes; a `GitJob` captures no actor for the
other three, and `AuditLog` is what records who moved or deleted a page. Attributing a move to
whoever last published it would be a false statement about a named person in a permanent record —
and Task 5 measured why that is not cosmetic: the author email is the field a git host matches to
an account. Capturing the actor would be a column on `GitJob`, which is Task 4's file.

**Two smaller findings from writing the tests.** `already-applied` was overwriting the seam's more
specific reason for an empty index: a `MOVE` with no source and a `DELETE` with no target also
reach a clean index, and those are different facts about the tree from "this had already been
done", wanting different answers from an operator. And `src/lib/pages/visible.test.ts`'s sweep was
too narrow for the **sixth** time — both alternatives are anchored on the names `db` and `tx`, so
the worker's one-connection lock client (called `holder`) was invisible to it; the module would have
been registered *by accident* because it also makes ordinary `db.` calls. The sweep now names
`new PrismaClient` as well, which closes the category and pulls `src/lib/db.ts` into the registry.

## Task 7: The sha on the page ✅

**Files:** `src/components/` page info, a version history route + tests.

- [x] **Step 1: Surface the content sha, distinctly from the build sha**

§10: the reader shows the published commit sha "so provenance is visible and a broken mirror is
noticed". The footer already shows a build string. Two shas on one page that mean different things
is a UI problem, not a data problem — label them.

- [x] **Step 2: `gitSha = null` is a normal state and must read as one**

An unmirrored version is the expected state for every version published before this phase, and for
any publish whose push is still queued. It says "not mirrored yet", not "error", and it must not
be a gap where a value should be.

- [x] **Step 3: Link to version history**

§10 says the reader links to it. A list of a page's versions with author, date, status and sha.
Permission is the page's own — `visiblePage`, stated here and not inherited.

**Step 1 was half done and Step 2's wording turned out to be the thing that was wrong.** The
reader route already painted the content sha — `<span className="k">Commit</span>
{version.gitSha ?? "not mirrored yet"}` — so what this task actually did was fix two words. The
label `Commit` is a perfectly good name for `buildInfo().label`, which the nav rail's foot paints
on the same page, so the one thing the landmine asked for ("name them apart") was not satisfied by
a label that only one of the two values happened to be wearing. Both are now named after their
repository — `Content commit` and `Build` — and the pair lives in `src/lib/version/labels.ts`,
because *distinctness is a property of the pair* and cannot be asserted where each half is a
literal at its use site. The measured proof that this matters: with the constant reverted to
`"Commit"`, the rendered-markup test that puts both surfaces in one string **stays green** (it
asserts the constant, not the word) and only `labels.test.ts` fails. Two tests, two different
mutants — a label missing from a surface, and a label that is the wrong word.

**"not mirrored yet" was the plan's own wording and it is now false**, which is Task 6's fault
rather than Step 2's: a job that reaches `FAILED` blocks its own page's queue for ever, so `yet`
promises something that is not coming. The `yet` is gone; everything else about Step 2 was already
satisfied and was left alone.

**The reader is told about a `FAILED` job, and the decision was where rather than whether.** Not
on the reader route: that is the hottest path in the product and it would mean a `GitJob` query on
every page view to report a state that is normally empty. And not per version either, which is
the part the plan could not have known — a `MOVE`, `DELETE` or `RESTORE` job carries
`versionId: null` by design, so a page can be wedged by a failure belonging to no version at all,
with the newest version's own job sitting `PENDING` behind the barrier. "Queued" and "failed"
are then both half-true of that row. So the queue is counted **per page**, with one `groupBy`, on
the history page — a surface someone opened deliberately — and said once: stuck, or queued, never
both. `GitJob.lastError` is git's stderr and stays on Task 8's page; a reader gets the state,
which is what lets them tell somebody. §10's "a broken mirror is noticed" is satisfied by a
reader who can see the mirror is stuck without being shown a remote URL.

**The route is `/{space}/-/history/{path}`, and the two alternatives were both worse.**
`/{space}/{path}/-/history` is unrepresentable — a catch-all must be the last segment of a route.
A top-level `/history/{pageId}` would be a static segment at the same depth as `[space]`, so it
would shadow any space whose key is `history`; space keys are created by people, where `-/` is
reserved by `validateSlug` with its own error code and its own test, upstream of both
`createPage` and `movePage`. (`/search` already carries the top-level shape and shadows a space
keyed `search` — existing debt, not a pattern to extend.) The collision with `[space]/[...path]`
was **measured, not assumed**: `next build`'s `routes-manifest.json` orders
`^/([^/]+?)/\-/history/(.+?)(?:/)?$` before `^/([^/]+?)/(.+?)(?:/)?$`, and a real `next start`
driven against the test database answered `/probe/-/history/a/b` with `<h1>Version history</h1>`
at 200 while `/probe/-/history/no/such` answered 404 — which is what a catch-all match would have
given for both, since no page path can begin with `-`. The same probe is what confirmed the
queued and stuck notices and that stderr does not reach the page.

**A version list is the seventh shape of the overflow class, and the sha is the one shape
`overflow-wrap` cannot rescue.** A 40-character git object name has no break opportunity in it, so
`overflow-wrap: anywhere` still demands ~300px of one line at 12.5px monospace. The display is ten
characters with the full value in a `title`, which costs no width at any viewport — and `.sha`
keeps the wrap rule anyway, as a guard against a longer display form rather than as a live need.
Ten and not the build's seven for a reason that is not uniqueness: two seven-character hex strings
on one page look like the same kind of thing even when labelled, so the differing length is a
second, redundant signal. The labels are the mechanism.

**`renderToStaticMarkup` is available under vitest, and this task is the first to use it.** With
Playwright's browsers absent from the machine, an e2e-only assertion would have left the one
decision this task is mostly about — words — with no executable evidence at all. A route cannot be
rendered that way (async, reads the database), which is why the list is a component taking a
`PageHistory` rather than markup inside the route: a 300-character title, a null sha and a wedged
mirror are all assertable without a browser. One caveat, measured: static markup carries no
hydration markers, where the shipped HTML is `Build<!-- --> <!-- -->0.1.0+df0ef11`, so an
adjacency assertion in vitest is about the element tree and not about the bytes. `textContent`
ignores the comments, so the e2e assertions are written against visible text.

**The permission predicate is stated once and mutation-verified four ways.** `visiblePage()` owns
the top level of the one page query and `readableSpace(viewer, { key })` is its `space` relation
filter; the version read and the `GitJob` aggregate are keyed on the id that query authorised and
carry no second copy, because a copy there could be deleted with the whole suite green — the
`resolveRedirect` shape. Mutants and their failures:

- `space: { key }` (permission dropped, shape kept) → *a viewer reads the history of a page they
  can read, and not one they cannot*: `expected { ok: true, history: { …(5) } } to deeply equal
  { ok: false, reason: 'not-found' }`
- `space: readableSpace(viewer)` (shape dropped, permission kept) → *a path is resolved inside the
  space the URL names*: `expected 'Handbook copy' to be 'Engineering copy'`
- `visiblePage({…})` → a bare object → *a soft-deleted page has no history* **and** *a super
  admin's reach is not also a soft-delete bypass*, both with the same message as the first
- `where: {}` on the version read → *…and not one they cannot*: `expected [ { …(7) }, { …(7) } ]
  to have a length of 1 but got 2`; on the `GitJob` aggregate → *another page's failure is not
  this page's problem*: `expected { queued: +0, failed: 1 } to deeply equal { queued: +0,
  failed: +0 }`

**An unpublished page gets an empty history rather than a 404, which is deliberately a different
answer from the reader route's.** They are two different questions: "show me the published text"
has no answer, and "show me the version history" has the answer *none yet*. Nothing leaks by
saying so — `listSpacePages` already puts every unpublished page's title in the nav rail of anyone
who can read the space.

**Two corrections to the brief this task was given.** `pageVersion.findMany` was *not* absent from
`src/lib/` — `src/lib/search/reindex.ts` has one, and it is registered in the soft-delete guard
already. And the history route deliberately does **not** follow a `Redirect` for a moved page,
where the reader route does; `pageHistoryHref` states the trade rather than leaving it to be
discovered.

**No audit row, and the argument is that it would say nothing new.** §8's audit is about a super
admin reaching into a `MEMBERS` space, and `getReadableSpaceByKey` writes it once per request at
the space boundary — which this route crosses through the layout on the way in. A second row for
the same person and the same space on the same request makes the trail longer without making it
say anything.

**What the reader route gained, and what it deliberately did not.** The history link is in
`.meta`, not in `PageInfoCard`, for the reason the Edit link is: `doc.css` hides `.rail-r` below
1180px, so the rail is where an affordance ceases to exist on a laptop in a split window. The
rail's "Versions" count was left as a count rather than becoming a second copy of the same link —
an affordance that appears and disappears with the viewport is how a reader learns a feature
exists and then cannot find it.

**Written but not executed: `e2e/history.spec.ts`, eight tests.** Playwright's browser binaries
are absent on this machine, so every spec in that directory fails at launch and
`npx playwright install` is a ~95 MB download and the user's call. `npx playwright test --list`
loads the file and reports **49 tests in 6 files**. What is uncovered by its not running: the
horizontal-overflow *measurement* at four viewports, which needs a layout engine. Everything the
spec says about markup is asserted and executed by the two component tests.

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
