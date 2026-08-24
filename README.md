# Badam

An internal documentation platform. Markdown authoring in the browser, drafts in Postgres,
per-space permissions behind SSO.

**Status: alpha.** Two of six planned phases are complete — staff can read published docs, and
editors can create, draft, preview, publish, move and delete them. The version string and an
`alpha` badge are visible in the app, and there is a Report bug button in the nav rail.

## Running it

Needs Node 22+ and a local Postgres 16. There is no container runtime involved.

```bash
npm install
./scripts/setup-db.sh   # idempotent: creates the role, both databases, and .env.test
cp .env.example .env    # then fill in AUTH_SECRET and the OIDC credentials
npm run db:seed
npm run dev
```

Signing in locally: set `ALLOW_TEST_LOGIN=1` and use `/api/auth/signin` as
`aisyah@example.com` (an editor), `stranger@example.com` (a member of nothing — this is how
404-not-403 is demonstrated), or `admin@example.com` (a super admin). **Never set that flag in a
deployed environment**: it enables a passwordless login that inherits any seeded user's
memberships. A session minted that way is revoked the moment the flag is turned off, because the
token records which provider issued it.

## Checks

```bash
npm test              # 520 unit and integration tests against a real Postgres
npm run test:e2e      # 21 Playwright specs against a production build
npm run smoke         # 37 checks from a cold start: provision, migrate, seed, build, serve, tear down
npm run typecheck && npm run build
npm run plan:check    # reports plan documents whose code fences no longer match the code
```

`npm run smoke` is the one that answers "does this work from nothing", which is the question
asked before a deploy and after every dependency bump. It writes to the dev database and cleans
up after itself, and asserts that it did.

## How this repo is organised

Reading the docs first will save time — the design decisions and the traps are written down.

| Where | What |
|---|---|
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | The design spec: domain model, permissions, lifecycle, routes, error handling |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | The roadmap and a plan per phase, with the code fences kept in step with the code |
| [`docs/superpowers/plans/PROGRESS.md`](docs/superpowers/plans/PROGRESS.md) | Current state, and **"Decisions that should not be relitigated"** |
| `src/lib/` | Pure logic and data access. Permission checks compile to SQL here, never filter after fetching |
| `src/app/` | Routes. `(reader)` for reading, `(editor)` for authoring, `api/` for mutations |

**Read `PROGRESS.md` before changing anything in `src/lib/pages/`.** Several things in there
look like they could be simplified and cannot — the permission predicate that must never be
spread, the unique index that can never be deferred, the collision check that deliberately does
*not* filter soft-deleted rows. Each is recorded with the measurement that established it.

## Two rules that are enforced by tests, not by review

- **`readableSpace(...)` and `visiblePage(...)` return complete Prisma `where` objects and must
  never be spread.** The spread form silently drops the predicate, which is an authorization
  bypass that neither the compiler nor Prisma can see.
- **Every module that queries the database is registered in `src/lib/pages/visible.test.ts`**,
  either with soft-delete tests or with a stated reason it cannot reach a page row. That guard
  has been too narrow five times; the history is in its docstring, and it is worth reading before
  writing another one.
