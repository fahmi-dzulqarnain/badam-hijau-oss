# Phase 1 execution status

Branch: `phase-1-foundations-reader` · Plan:
[`2026-08-21-docs-platform-phase-1-foundations-reader.md`](2026-08-21-docs-platform-phase-1-foundations-reader.md)

**Paused after Task 4's fixes landed.** Tree clean, 27 tests passing, typecheck and build
both exit 0.

| Task | State |
|---|---|
| 1. Scaffold + design tokens | Approved (2 review rounds) |
| 2. Postgres schema + test harness | Approved (2 review rounds) |
| 3. Permission module | Approved (2 review rounds) |
| 4. Page schema + filtered reads | Implemented, quality review APPROVED, fixes applied — **re-review outstanding** |
| 5. Markdown pipeline | Not started |
| 6. Page tree builder | Not started |
| 7. OIDC + viewer loader | Not started |
| 8. Build version module | Not started |
| 9. Seed script | Not started |
| 10. Reader shell | Not started |
| 11. Bug reporting | Not started |
| 12. Page reader route | Not started |
| 13. Space landing | Not started |
| 14. Playwright E2E | Not started |

## To resume

1. Re-review Task 4's fix commit `e3cb42c` — confirm `cache()` on all three functions, the
   narrowed `select`, viewer-first order, the self-guarding page query, and no regression.
2. Then Task 5, the markdown pipeline. Its ordering constraint is the whole task:
   sanitise **before** adding heading ids, or `rehype-sanitize` rewrites them to
   `user-content-*` and silently breaks every table-of-contents anchor.

## Before dispatching any task

Read its section verbatim out of the plan and diff it against current HEAD. Three times so
far, a later task's text would have reverted an earlier task's review fix — the plan was
written whole before any of it ran, so it reprints context that has since changed.

## Running the project

```bash
./scripts/setup-db.sh   # idempotent; creates the badam role, both databases, and .env.test
npm test                # 27 tests: 14 pure unit, 13 integration against real Postgres
npm run typecheck && npm run build
```

Postgres is the local Homebrew `postgresql@16` service on port 5432 — there is no container
runtime on this machine. The integration harness refuses to run unless `DATABASE_URL` names
a database ending in `_test`.

## Decisions worth not relitigating

- `readableSpace(viewer, ...and)` returns the **complete** Prisma `where` and must never be
  spread, at any depth. The spread form silently drops the permission predicate; both the
  top-level and nested-relation shapes were reproduced against Postgres.
- Every query in `src/lib/pages/repo.ts` states its own permission predicate. One rule, no
  exceptions based on call ordering.
- `React.cache()` keys on argument identity, so `loadViewer` must also be wrapped in
  `cache()` (Task 7) or the repository's memoization silently does nothing.
- Never `include:` in this codebase — Prisma expands it to a column list at generation
  time, so it starts shipping future columns with no diff to review.
- Implementers create a **new** commit, never `--amend`.
