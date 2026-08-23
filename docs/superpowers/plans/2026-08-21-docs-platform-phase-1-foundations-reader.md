# Documentation Platform — Phase 1: Foundations & Reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in staff can read seeded published documentation — space navigation, breadcrumbs, table of contents, page info card — with a space they lack permission for returning 404, an Alpha build badge, and a working Report bug button.

**Architecture:** Next.js App Router with React Server Components for all reads. Postgres via Prisma is the only datastore. Permission logic lives in a pure `lib/authz` module that returns a Prisma `where` fragment, so every check compiles into SQL rather than filtering after fetch. Markdown is rendered server-side through a unified pipeline that sanitises before it adds heading ids, so anchors are ours and untrusted HTML never survives.

**Tech Stack:** TypeScript (strict), Next.js App Router, React, Prisma + Postgres 16 (Docker), Auth.js v5 generic OIDC, unified/remark/rehype + Shiki, Zod, Vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-08-21-internal-docs-platform-design.md`](../specs/2026-08-21-internal-docs-platform-design.md) — sections §5.1–5.2, §8, §11 (read routes), §12, §18.

**Environment deviation:** the plan was written assuming Docker. This machine has no
container runtime, so Phase 1 runs against the local Homebrew `postgresql@16` service on
port 5432, provisioned by `scripts/setup-db.sh`. Spec §17 still calls for Docker in
deployment; only local development differs.

**Working rule for whoever executes this plan:** create a **new commit** for every change,
including review fixes. Never `git commit --amend`. Amending is only safe when nothing has
landed on top, and plan-document commits land between tasks — an amend has already folded
a source change into a docs commit once. A longer history costs nothing; a mixed commit
costs a bisect.

**Known divergence from the spec, deliberate:** §8 names a function `readableSpaceIds`. This plan implements `readableSpaceWhere(viewer)` returning a Prisma filter instead, because returning ids would require loading every space first and would let a caller forget to apply them. Same guarantee, enforced in SQL.

---

### Task 1: Project scaffold and design tokens

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Modify: `.gitignore`

**Conventions this task fixes for the whole project:** npm is the package manager, and
`package-lock.json` **is committed** — reproducible installs matter more than a tidy diff.

**Why `tsconfig.json` looks the way it does.** Next 16 forces `"jsx": "react-jsx"` (logged
as a mandatory change) and appends `.next/dev/types/**/*.ts` to `include`. The committed
config already satisfies both, so builds do **not** rewrite it and `git status` stays
clean. Remove either and Next will put it back — so if a build ever does dirty this file,
that is real drift worth reading, not noise to ignore.

**`skipLibCheck: true` is load-bearing.** Turning it off surfaces six pre-existing errors
from Next's own `.d.ts` files and from chai/vitest. Do not "tighten" it in a later task.

This task produces configuration, not behaviour, so it has no test. It is verified by a
typecheck and a production build — both must pass before you commit.

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
npm init -y
npm install next react react-dom
npm install -D typescript @types/node @types/react @types/react-dom vitest
```

- [ ] **Step 2: Replace the `scripts` block in `package.json`**

Also set `"private": true` and `"version": "0.1.0"` — Task 8 reads that version string.

> **Superseded snapshot.** Later tasks add to this file — the markdown pipeline (5),
> OIDC (7), the seed (9), Playwright (14) and the smoke test (15). Read `package.json`
> for the current version. Syncing this fence forward would have Task 1 install tools it
> has no use for yet.

```json
{
  "name": "badam",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "next typegen && tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

`next typegen` is not decoration. Without it, `tsc --noEmit` on a fresh clone silently
skips route checking entirely: `next-env.d.ts` imports `./.next/types/routes.d.ts`, and
when that file is absent `skipLibCheck` swallows the unresolved import, so `typedRoutes`
degrades to a no-op with no warning. A bad `Link href` then passes typecheck and only
fails at build.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": [
      "dom",
      "dom.iterable",
      "ES2024"
    ],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowJs": false,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": [
        "./src/*"
      ]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts"
  ],
  "exclude": [
    "node_modules"
  ]
}
```

- [ ] **Step 4: Create `next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
};

export default nextConfig;
```

- [ ] **Step 5: Create `vitest.config.ts`**

> **Superseded snapshot.** Task 2 adds `globalSetup` and `fileParallelism`; Task 14 adds
> the `next-auth` inline entry. Read `vitest.config.ts` for the current version.

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
```

- [ ] **Step 6: Create `src/app/globals.css` with the approved design tokens**

These are the tokens from the approved mockup. Every colour in the application comes from
this block — never a literal, and never a colour whose only definition sits inside a media
query, which would render one theme's text on the other theme's background.

```css
:root {
  color-scheme: light dark;
  --ground: #F7F9F6;
  --surface: #FFFFFF;
  --surface-2: #F1F5F0;
  --ink: #15201B;
  --ink-2: #4E5F56;
  --ink-3: #7C8B82;
  --line: #DFE7DF;
  --line-strong: #C6D2C7;
  --accent: #2C6A4C;
  --accent-ink: #1F4E37;
  --accent-wash: #E8F1EA;
  --amber: #8E5D11;
  --amber-wash: #FAF0DD;
  --code-bg: #F1F5F0;

  --sans: var(--font-plex-sans), ui-sans-serif, system-ui, -apple-system, sans-serif;
  --serif: var(--font-newsreader), ui-serif, Georgia, serif;
  --mono: var(--font-plex-mono), ui-monospace, Menlo, monospace;
}

:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0F1513;
    --surface: #151D19;
    --surface-2: #1B2521;
    --ink: #E5EBE6;
    --ink-2: #9EAEA4;
    --ink-3: #78887E;
    --line: #26312C;
    --line-strong: #37473F;
    --accent: #7FC79D;
    --accent-ink: #A9DDC0;
    --accent-wash: #18291F;
    --amber: #D6A452;
    --amber-wash: #27210F;
    --code-bg: #101713;
  }
}

:root[data-theme="dark"] {
  --ground: #0F1513;
  --surface: #151D19;
  --surface-2: #1B2521;
  --ink: #E5EBE6;
  --ink-2: #9EAEA4;
  --ink-3: #78887E;
  --line: #26312C;
  --line-strong: #37473F;
  --accent: #7FC79D;
  --accent-ink: #A9DDC0;
  --accent-wash: #18291F;
  --amber: #D6A452;
  --amber-wash: #27210F;
  --code-bg: #101713;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; }

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}

/* Shiki dual-theme: the light colour is inline, the dark one is a CSS variable. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .shiki,
  :root:not([data-theme="light"]) .shiki span {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
    font-style: var(--shiki-dark-font-style) !important;
    font-weight: var(--shiki-dark-font-weight) !important;
    text-decoration: var(--shiki-dark-text-decoration) !important;
  }
}
:root[data-theme="dark"] .shiki,
:root[data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}
```

- [ ] **Step 7: Create `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Badam",
  description: "Internal documentation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} ${newsreader.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 8: Create `src/app/page.tsx` as a temporary home**

The real home page (a list of readable spaces) is Phase 2 work. This exists so the build
has a root route.

```tsx
export default function Home() {
  return <main style={{ padding: 32 }}>Badam</main>;
}
```

- [ ] **Step 9: Append build output to `.gitignore`**

```bash
printf 'next-env.d.ts\ntsconfig.tsbuildinfo\ntest-results/\nplaywright-report/\n' >> .gitignore
```

- [ ] **Step 10: Verify the typecheck and build pass**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. The build prints a route table containing `/`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with design tokens"
```

---

### Task 2: Postgres, Prisma schema, and the integration test harness

**Files:**
- Create: `scripts/setup-db.sh`, `.env.example`, `.env`, `.env.test`
- Create: `prisma/schema.prisma`, `src/lib/db.ts`
- Create: `tests/setup/global-setup.ts`, `tests/setup/reset.ts`
- Create: `tests/integration/spaces.test.ts`
- Modify: `vitest.config.ts`, `package.json`

**Environment note:** this machine has no container runtime, so Postgres is the local
Homebrew `postgresql@16` service on port **5432**, not a container on 5433. The role
`badam` and the databases `badam` / `badam_test` already exist — Step 1 records how, and
is idempotent so it is safe to re-run.

- [ ] **Step 1: Create `scripts/setup-db.sh`**

This replaces the `docker-compose.yml` the plan originally called for. It is committed so
the next developer can reproduce the database without guessing.

```bash
#!/usr/bin/env bash
# Creates the badam role and its two databases on a local Postgres.
# Idempotent: safe to run repeatedly.
set -euo pipefail
cd "$(dirname "$0")/.."

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"

psql -h "$PGHOST" -p "$PGPORT" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'badam') THEN
    CREATE ROLE badam LOGIN PASSWORD 'badam' CREATEDB;
  END IF;
END
$$;
SQL

for name in badam badam_test; do
  if psql -h "$PGHOST" -p "$PGPORT" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$name'" | grep -q 1; then
    echo "$name already exists"
  else
    createdb -h "$PGHOST" -p "$PGPORT" -O badam "$name"
    echo "created $name"
  fi
done

# The integration harness refuses to run without .env.test, because falling back to
# .env would truncate the development database.
if [ -f .env.test ]; then
  echo ".env.test already exists"
elif [ -f .env.example ]; then
  sed 's|/badam?schema|/badam_test?schema|' .env.example > .env.test
  echo "created .env.test"
else
  echo "warning: .env.example is missing, cannot create .env.test" >&2
fi
```

Make it executable: `chmod +x scripts/setup-db.sh`

- [ ] **Step 2: Verify the databases are reachable as the `badam` role**

```bash
./scripts/setup-db.sh
PGPASSWORD=badam psql -h localhost -p 5432 -U badam -d badam_test -tAc "select current_database();"
```

Expected: the script reports both databases exist, and the query prints `badam_test`.
If the connection is refused, the Homebrew service is down — `brew services restart
postgresql@16` and check `/opt/homebrew/var/log/postgresql@16.log`.

- [ ] **Step 3: Create the env files**

`.env.example` is committed; `.env` and `.env.test` are not (`.env*` is already ignored).

```bash
cat > .env.example <<'EOF'
# Copy to .env. Run ./scripts/setup-db.sh to also create .env.test for the test suite.
DATABASE_URL="postgresql://badam:badam@localhost:5432/badam?schema=public"
AUTH_SECRET="generate-with-openssl-rand-base64-32"
OIDC_ISSUER="https://accounts.google.com"
OIDC_CLIENT_ID=""
OIDC_CLIENT_SECRET=""
GIT_SHA=""
EOF
cp .env.example .env
sed 's|/badam?schema|/badam_test?schema|' .env.example > .env.test
```

Then set `AUTH_SECRET` in `.env` to the output of `openssl rand -base64 32`.

- [ ] **Step 4: Install Prisma and the test tooling**

```bash
npm install @prisma/client zod
npm install -D prisma dotenv
```

**Pre-authorised fallback:** the scaffold installed **TypeScript 7.x**, the native
compiler line. Prisma's generated client depends on heavy TS 5-era type machinery. If
`npm run typecheck` fails on generated Prisma types (not on your own code), pin
`typescript` to `^5.9`, reinstall, re-run, and report that you did. Do not spend time
working around a compiler incompatibility.

- [ ] **Step 5: Create `prisma/schema.prisma`**

`BugReport` is here rather than in a later task because §18 makes bug reporting part of the
alpha from day one, and adding it now avoids a second migration.

> **Superseded snapshot.** Task 4 adds `Page`, `PageVersion`, `DocType` and `DocStatus`.
> Read `prisma/schema.prisma` for the current version.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum SpaceVisibility {
  MEMBERS
  ALL_STAFF
}

enum SpaceRole {
  VIEWER
  EDITOR
  ADMIN
}

enum BugStatus {
  NEW
  TRIAGED
  CLOSED
}

model User {
  id           String            @id @default(cuid())
  email        String            @unique
  name         String
  avatarUrl    String?
  isSuperAdmin Boolean           @default(false)
  createdAt    DateTime          @default(now())
  memberships  SpaceMembership[]
  bugReports   BugReport[]
}

model Space {
  id          String            @id @default(cuid())
  key         String            @unique
  name        String
  description String?
  initials    String
  visibility  SpaceVisibility   @default(MEMBERS)
  createdAt   DateTime          @default(now())
  memberships SpaceMembership[]
}

model SpaceMembership {
  id      String    @id @default(cuid())
  spaceId String
  userId  String
  role    SpaceRole @default(VIEWER)
  space   Space     @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  user    User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([spaceId, userId])
  @@index([userId])
}

model BugReport {
  id           String    @id @default(cuid())
  reporterId   String
  summary      String
  expected     String?
  routePath    String
  // spaceId/pageId/versionId are captured context, deliberately without foreign keys:
  // their value is highest when the referenced page is gone, so SetNull would erase the
  // only clue and Restrict/Cascade would block deletion or destroy the report. routePath
  // is the durable breadcrumb. These are DERIVED SERVER-SIDE from routePath through the
  // permission-filtered repository (see src/lib/bugs/context.ts) and never accepted from
  // the client, so they cannot be forged and need no validation. Readers must still
  // tolerate a dangling id, since the page may be deleted later.
  spaceId      String?
  pageId       String?
  versionId    String?
  appVersion   String
  gitSha       String?
  userAgent    String
  viewport     String
  consoleError String?
  status       BugStatus @default(NEW)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  reporter     User      @relation(fields: [reporterId], references: [id])

  @@index([status, createdAt])
  @@index([reporterId])
}
```

**No `onDelete: Cascade` on `reporter`, deliberately.** Deleting a user must not delete
their bug reports — the value is in the captured context, and an offboarded employee's
reports are exactly the ones worth keeping. Prisma's default `Restrict` makes a future
offboarding path fail loudly and force a deliberate decision. `Cascade` stays correct on
both `SpaceMembership` relations. `@@index([reporterId])` is explicit because Postgres
does not auto-index foreign key columns.

- [ ] **Step 6: Run the first migration**

```bash
npx prisma migrate dev --name init
```

Expected: creates `prisma/migrations/<timestamp>_init/migration.sql` and generates the
client.

- [ ] **Step 7: Create `src/lib/db.ts`**

The global cache stops Next's dev server from opening a new pool on every hot reload.

```ts
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
```

- [ ] **Step 8: Create the test harness**

`tests/setup/global-setup.ts`:

```ts
import { execSync } from "node:child_process";
import { config } from "dotenv";

export default function setup() {
  if (config({ path: ".env.test", override: true, quiet: true }).error) {
    throw new Error(
      ".env.test not found. Refusing to migrate: falling back to .env would run " +
        "migrations against the development database. Create it with:\n" +
        "  ./scripts/setup-db.sh",
    );
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
    throw new Error(
      `Refusing to migrate "${databaseUrl || "<unset>"}": not a test database.`,
    );
  }

  // `--no` stops npx fetching an arbitrary Prisma version from the registry if
  // node_modules is stale — that version would decide which migrations run.
  // The `env` option that used to be here was inert: execSync already defaults to
  // process.env, so setting DATABASE_URL to its own value did nothing.
  execSync("npx --no prisma migrate deploy", { stdio: "inherit" });
}
```

`tests/setup/reset.ts`:

```ts
import { config } from "dotenv";

// This dotenv call and the identical one in global-setup.ts are BOTH load-bearing.
// globalSetup mutates process.env in the main Vitest process and workers inherit it;
// this call covers the case where this module is what first constructs the client.
// Deleting either one as "duplication" silently retargets the whole suite.
if (config({ path: ".env.test", override: true, quiet: true }).error) {
  throw new Error(
    ".env.test not found. Refusing to run integration tests: falling back to .env " +
      "would TRUNCATE the development database. Create it with:\n" +
      "  ./scripts/setup-db.sh",
  );
}

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  throw new Error("DATABASE_URL is unset after loading .env.test.");
}
// Assert the suffix rather than the literal name, so this survives a database rename.
if (!new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error(`Refusing to run integration tests against ${databaseUrl}`);
}

// Dynamic import so the environment above is in place before PrismaClient is
// constructed. Defence in depth, not the primary guarantee — see the comment above.
const { db } = await import("@/lib/db");

export { db };

let verifiedDatabase = false;
let tables: string[] | undefined;

export async function resetDb() {
  // Last line of defence: the client could have been constructed from a stale
  // DATABASE_URL before this module evaluated. Checked once per worker.
  if (!verifiedDatabase) {
    const rows = await db.$queryRaw<{ current_database: string }[]>`
      SELECT current_database()`;
    const current = rows[0]?.current_database ?? "";
    if (!current.endsWith("_test")) {
      throw new Error(`Refusing to TRUNCATE "${current}": not a test database.`);
    }
    verifiedDatabase = true;
  }

  // Introspected rather than hardcoded, so a task that adds a table cannot forget to
  // add it here — the old failure mode was a test that passes alone and fails in a suite.
  tables ??= (
    await db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `
  ).map((row) => `"${row.tablename}"`);

  if (tables.length === 0) {
    throw new Error("resetDb: no tables found. Did migrations run?");
  }

  await db.$executeRawUnsafe(`TRUNCATE TABLE ${tables.join(", ")} CASCADE`);
}
```

Note: every later task that adds a table must add it to this `TRUNCATE` list. A forgotten
table shows up as a test that passes alone and fails in a suite.

- [ ] **Step 9: Point Vitest at the harness**

Modify `vitest.config.ts` — add `globalSetup` to the `test` block:

```ts
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    globalSetup: ["tests/setup/global-setup.ts"],
    fileParallelism: false,
  },
```

`fileParallelism: false` because the integration tests share one database and truncate it.
This also serialises the pure unit tests in Tasks 3, 5, 6, 8 and 13. Measured cost is a
couple of hundred milliseconds — the suite's real cost is `globalSetup` shelling out to
the Prisma CLI (~1.6s). Splitting into Vitest `test.projects` (a parallel `unit` project
with no `globalSetup`, an `integration` project keeping both settings) is the right
eventual fix; do it when there are enough unit tests to notice, not now.
**Keep the `{ts,tsx}` globs exactly as they already are** — Task 1 widened them so a
`.test.tsx` file cannot be silently skipped. Narrowing them back to `.ts` is a regression.

- [ ] **Step 10: Write the failing test**

`tests/integration/spaces.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";

beforeEach(resetDb);

test("a space can be created with a member and read back", async () => {
  const user = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      visibility: "MEMBERS",
      memberships: { create: { userId: user.id, role: "EDITOR" } },
    },
    include: { memberships: true },
  });

  expect(space.key).toBe("engineering");
  expect(space.memberships).toHaveLength(1);
  expect(space.memberships[0]?.role).toBe("EDITOR");
});

test("a user cannot hold two memberships in the same space", async () => {
  const user = await db.user.create({
    data: { email: "wei@example.com", name: "Wei L." },
  });
  const space = await db.space.create({
    data: { key: "hr", name: "People", initials: "HR" },
  });

  await db.spaceMembership.create({ data: { spaceId: space.id, userId: user.id } });

  await expect(
    db.spaceMembership.create({ data: { spaceId: space.id, userId: user.id } }),
  ).rejects.toThrow();
});
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test -- tests/integration/spaces.test.ts`
Expected: 2 passed. If the run fails with "database badam_test does not exist", re-run
`./scripts/setup-db.sh`.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: add Postgres schema for users, spaces and bug reports"
```

**Accepted audit finding — do not "fix" it.** Installing the Prisma CLI brings
`deepmerge-ts <8.0.0` (GHSA-ggr8-5vv4-36mx, high, stack exhaustion on recursive object
graphs) via `@prisma/config`. It stays, because:

- `prisma` is a devDependency — the CLI, not the production runtime.
- The vulnerable path merges our own config file, not attacker-controlled input.
- `npm audit fix --force` *downgrades* prisma to 6.12.0, a breaking change.
- The advisory range spans 6.13.0 to 7.10.0, so upgrading to Prisma 7.x does not fix it
  either. There is no version that is both current and unaffected.

Re-evaluate when `@prisma/config` ships a patched `deepmerge-ts`. Do not run
`npm audit fix --force` in any later task.

---

### Task 3: Permission module

Pure functions taking plain objects. No Prisma import, so these run in microseconds and
cover combinations that would be tedious to set up in the database.

**Files:**
- Create: `src/lib/authz/types.ts`
- Create: `src/lib/authz/can.ts`
- Create: `src/lib/authz/where.ts`
- Test: `src/lib/authz/can.test.ts`
- Test: `tests/integration/authz-where.test.ts`

**Why the query fragment is a separate file with a composing helper.** An earlier draft
exported `readableSpaceWhere(viewer)` returning a bare `{ OR: [...] }` to be **spread**
into a caller's `where`. That is an authorization bypass: object spread merges by key, so
any caller who also needs a top-level `OR` silently deletes the permission predicate.
Reproduced against Postgres — a non-member read a `MEMBERS` space title through an
ordinary search query, and neither `tsc` nor Prisma can detect it, because the duplicate
key collapses in the object literal before Prisma is called. The predicate is now private
and reached only through `readableSpace(viewer, ...and)`, which returns the complete
`where` clause and `AND`s extra conditions so they can never collide.

**Residual risk, measured and accepted.** The collision moved rather than disappeared: a
caller who spreads the result *and* supplies their own top-level `AND` still drops the
predicate. Verified against Postgres — the composed form returns `open`, the spread-with-
`AND` form returns `open,secret`. This is strictly narrower than the original hole (search
wants `OR`, which is now safe) and is guarded by the doc comment on `readableSpace`, which
is the only guard TypeScript and Prisma permit. The structural cure — query-level helpers
that own the `where` so callers never hold the fragment — is deliberately deferred: it is
over-engineering for Phase 1's two call sites. Escalate to it if a third appears.

- [ ] **Step 1: Write the failing test**

`src/lib/authz/can.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { can, needsAccessAudit } from "./can";
import type { SpaceRef, Viewer } from "./types";

const openSpace: SpaceRef = { id: "s-open", visibility: "ALL_STAFF" };
const closedSpace: SpaceRef = { id: "s-closed", visibility: "MEMBERS" };

function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return { id: "u1", isSuperAdmin: false, memberships: [], ...overrides };
}

describe("READ", () => {
  test("any signed-in user may read an all-staff space", () => {
    expect(can(viewer(), openSpace, "READ")).toBe(true);
  });

  test("a non-member may not read a members-only space", () => {
    expect(can(viewer(), closedSpace, "READ")).toBe(false);
  });

  test("a viewer-role member may read a members-only space", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "VIEWER" }] });
    expect(can(v, closedSpace, "READ")).toBe(true);
  });

  test("membership in another space grants nothing here", () => {
    const v = viewer({ memberships: [{ spaceId: "s-other", role: "ADMIN" }] });
    expect(can(v, closedSpace, "READ")).toBe(false);
  });
});

describe("EDIT and PUBLISH", () => {
  test("a viewer-role member cannot edit", () => {
    const v = viewer({ memberships: [{ spaceId: "s-open", role: "VIEWER" }] });
    expect(can(v, openSpace, "EDIT")).toBe(false);
    expect(can(v, openSpace, "PUBLISH")).toBe(false);
  });

  test("an editor can edit and publish", () => {
    const v = viewer({ memberships: [{ spaceId: "s-open", role: "EDITOR" }] });
    expect(can(v, openSpace, "EDIT")).toBe(true);
    expect(can(v, openSpace, "PUBLISH")).toBe(true);
  });

  test("readable does not imply editable in an all-staff space", () => {
    expect(can(viewer(), openSpace, "EDIT")).toBe(false);
  });
});

describe("MANAGE_SPACE", () => {
  test("a space admin can manage it", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "ADMIN" }] });
    expect(can(v, closedSpace, "MANAGE_SPACE")).toBe(true);
  });

  test("an editor cannot manage the space", () => {
    const v = viewer({ memberships: [{ spaceId: "s-closed", role: "EDITOR" }] });
    expect(can(v, closedSpace, "MANAGE_SPACE")).toBe(false);
  });
});

describe("super admin", () => {
  const superUser = viewer({ id: "root", isSuperAdmin: true });

  test("holds every action everywhere", () => {
    for (const action of ["READ", "EDIT", "PUBLISH", "MANAGE_SPACE"] as const) {
      expect(can(superUser, closedSpace, action)).toBe(true);
    }
  });

  test("reading a members-only space they do not belong to is audited", () => {
    expect(needsAccessAudit(superUser, closedSpace)).toBe(true);
  });

  test("reading an all-staff space is not audited", () => {
    expect(needsAccessAudit(superUser, openSpace)).toBe(false);
  });

  test("a member super admin is not audited", () => {
    const member = viewer({
      id: "root",
      isSuperAdmin: true,
      memberships: [{ spaceId: "s-closed", role: "ADMIN" }],
    });
    expect(needsAccessAudit(member, closedSpace)).toBe(false);
  });

  test("an ordinary user is never audited", () => {
    expect(needsAccessAudit(viewer(), closedSpace)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/authz/can.test.ts`
Expected: FAIL — `Failed to resolve import "./can"`.

- [ ] **Step 3: Create `src/lib/authz/types.ts`**

```ts
export type SpaceRole = "VIEWER" | "EDITOR" | "ADMIN";
export type SpaceVisibility = "MEMBERS" | "ALL_STAFF";
export type Action = "READ" | "EDIT" | "PUBLISH" | "MANAGE_SPACE";

export type Membership = { spaceId: string; role: SpaceRole };

export type Viewer = {
  id: string;
  isSuperAdmin: boolean;
  memberships: Membership[];
};

export type SpaceRef = { id: string; visibility: SpaceVisibility };
```

- [ ] **Step 4: Create `src/lib/authz/can.ts`**

```ts
import type { Action, SpaceRef, SpaceRole, Viewer } from "./types";

function roleIn(viewer: Viewer, spaceId: string): SpaceRole | undefined {
  return viewer.memberships.find((m) => m.spaceId === spaceId)?.role;
}

export function can(viewer: Viewer, space: SpaceRef, action: Action): boolean {
  if (viewer.isSuperAdmin) return true;

  const role = roleIn(viewer, space.id);

  switch (action) {
    // Every current SpaceRole grants read, so any membership suffices. This is the one
    // fail-open direction in the module: a future role that must NOT confer read
    // (PENDING, INVITED, BLOCKED) has to change this line and the predicate in
    // where.ts together, or the two mechanisms will silently disagree.
    case "READ":
      return space.visibility === "ALL_STAFF" || role !== undefined;
    case "EDIT":
    case "PUBLISH":
      return role === "EDITOR" || role === "ADMIN";
    case "MANAGE_SPACE":
      return role === "ADMIN";
  }
}

/**
 * A super admin reading a members-only space they do not belong to is legitimate but
 * must leave a trace (spec §8).
 */
export function needsAccessAudit(viewer: Viewer, space: SpaceRef): boolean {
  return (
    viewer.isSuperAdmin &&
    space.visibility === "MEMBERS" &&
    roleIn(viewer, space.id) === undefined
  );
}

```

- [ ] **Step 5: Create `src/lib/authz/where.ts`**

Separate file so `can.ts` stays free of database types and unit-testable in isolation.

```ts
import type { Prisma } from "@prisma/client";
import type { Viewer } from "./types";

/**
 * The readability predicate alone. Deliberately NOT exported: it contains a top-level
 * `OR`, so spreading it into a caller's `where` that also has `OR` would silently
 * delete one of them — a total authorization bypass that neither tsc nor Prisma can
 * detect. Compose through `readableSpace` instead.
 */
function readableSpaceWhere(viewer: Viewer): Prisma.SpaceWhereInput {
  if (viewer.isSuperAdmin) return {};
  return {
    OR: [
      { visibility: "ALL_STAFF" },
      { memberships: { some: { userId: viewer.id } } },
    ],
  };
}

/**
 * The only sanctioned way to query spaces. Returns the COMPLETE `where` clause, so a
 * caller cannot build a query and forget the filter. Extra conditions go in `and` and are
 * nested, so they can never collide with the predicate.
 *
 * Pass it DIRECTLY as `where` — never spread it, at any nesting depth. Correct:
 * `where: readableSpace(v, { key })` and `where: { spaceId, space: readableSpace(v) }`.
 * Broken: `{ ...readableSpace(v), AND: [...] }` and, identically,
 * `{ space: { ...readableSpace(v), AND: [...] } }` — the spread replaces this function's
 * own top-level `AND` and the predicate vanishes. Both forms were verified against
 * Postgres to return members-only rows to a non-member. TypeScript and Prisma accept
 * both, so this comment is the only guard.
 *
 * If a third Space query site ever needs conditions this signature cannot express, do not
 * reach for a spread — move composition up a level into a `findReadableSpaces(viewer,
 * args)` helper that owns the `where` entirely, so callers never touch the fragment.
 */
export function readableSpace(
  viewer: Viewer,
  ...and: Prisma.SpaceWhereInput[]
): Prisma.SpaceWhereInput {
  return { AND: [readableSpaceWhere(viewer), ...and] };
}
```

The `Prisma.SpaceWhereInput` annotation is load-bearing beyond documentation: without it
the inferred type is a literal union, and a caller can spread the *Space* predicate into a
`Page` or `User` query and get past `tsc`. It also makes a typo'd field name an error at
the definition site instead of a runtime surprise.

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `npm test -- src/lib/authz/can.test.ts`
Expected: 14 passed.

The predicate is covered behaviourally in `tests/integration/authz-where.test.ts`
instead. Asserting its literal object shape with `toEqual` was actively harmful: those
assertions passed while a caller bypassed the predicate entirely, and would have failed
on the correct fix even though behaviour was identical.

- [ ] **Step 7: Write the composition and drift tests**

These need real SQL, so they are integration tests. The first is the regression test for
the bypass described above — the only test that would have caught it. The second pins
`can()` and the SQL predicate together, so a later phase cannot add an editable-space
predicate that disagrees with `can(..., "EDIT")` without a failure.

`tests/integration/authz-where.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { can } from "@/lib/authz/can";
import { readableSpace } from "@/lib/authz/where";
import type { SpaceRef, Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };
const root: Viewer = { id: "u-root", isSuperAdmin: true, memberships: [] };

async function fixture() {
  const member = await db.user.create({
    data: { email: "member@example.com", name: "Member" },
  });
  const open = await db.space.create({
    data: {
      key: "handbook",
      name: "Handbook planning",
      initials: "HB",
      visibility: "ALL_STAFF",
    },
  });
  const closed = await db.space.create({
    data: {
      key: "layoffs",
      name: "Layoffs 2027 planning",
      initials: "LO",
      visibility: "MEMBERS",
    },
  });
  return { member, open, closed };
}

test("a caller's own OR cannot displace the permission predicate", async () => {
  await fixture();

  // The natural way to write space search. Written as a spread of a bare `OR` fragment,
  // this returned the MEMBERS space to a non-member.
  const rows = await db.space.findMany({
    where: readableSpace(stranger, {
      OR: [{ name: { contains: "planning" } }, { key: { contains: "planning" } }],
    }),
    select: { key: true },
  });

  const keys = rows.map((row) => row.key);
  expect(keys).toContain("handbook");
  expect(keys).not.toContain("layoffs");
});

test("a super admin sees members-only spaces through the same helper", async () => {
  await fixture();

  const rows = await db.space.findMany({
    where: readableSpace(root),
    select: { key: true },
  });

  expect(rows.map((row) => row.key).sort()).toEqual(["handbook", "layoffs"]);
});

test("can(READ) agrees with the SQL predicate for every viewer and visibility", async () => {
  const { member, open, closed } = await fixture();
  await db.spaceMembership.create({
    data: { spaceId: closed.id, userId: member.id, role: "VIEWER" },
  });

  const viewers: { label: string; viewer: Viewer }[] = [
    { label: "stranger", viewer: stranger },
    { label: "super admin", viewer: root },
    {
      label: "member of the closed space",
      viewer: {
        id: member.id,
        isSuperAdmin: false,
        memberships: [{ spaceId: closed.id, role: "VIEWER" }],
      },
    },
  ];

  for (const { label, viewer } of viewers) {
    const rows = await db.space.findMany({
      where: readableSpace(viewer),
      select: { id: true },
    });
    const visible = new Set(rows.map((row) => row.id));

    for (const space of [open, closed]) {
      const ref: SpaceRef = { id: space.id, visibility: space.visibility };
      expect(
        visible.has(space.id),
        `${label} / ${space.key}: can() and the SQL predicate disagree`,
      ).toBe(can(viewer, ref, "READ"));
    }
  }
});
```

- [ ] **Step 8: Prove the regression test catches the bug**

Temporarily change the first test's `where` to the old broken shape:

```ts
    where: { ...readableSpace(stranger), OR: [{ name: { contains: "planning" } }] },
```

Run it and confirm it FAILS by returning `layoffs`. Restore the correct version
afterwards. A regression test never observed failing is not evidence of anything.

- [ ] **Step 9: Commit**

```bash
git add src/lib/authz tests/integration/authz-where.test.ts
git commit -m "feat: add space permission module"
```

---

### Task 4: Page and version schema, and the permission-filtered repository

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/pages/repo.ts`
- Test: `tests/integration/pages-repo.test.ts`

**`tests/setup/reset.ts` needs no change.** An earlier draft of this task edited a
hardcoded `TRUNCATE` list here. Task 2 replaced that list with a `pg_tables` introspection
precisely so this edit would never be needed again — new tables are picked up
automatically. Editing it back to a literal list is a regression.

`docType` and `status` are in this migration even though Phase 3 owns the lifecycle logic,
because adding enum columns later is a migration this saves.

- [ ] **Step 1: Add the enums and models to `prisma/schema.prisma`**

```prisma
enum DocType {
  DOC
  ADR
  RFC
  RUNBOOK
}

enum DocStatus {
  DRAFT
  IN_REVIEW
  PROPOSED
  ACCEPTED
  CLOSED
  SUPERSEDED
  DEPRECATED
  REJECTED
  WITHDRAWN
  CURRENT
  NEEDS_REVIEW
  ARCHIVED
}

model Page {
  id                 String    @id @default(cuid())
  spaceId            String
  parentId           String?
  slug               String
  path               String
  title              String
  docType            DocType   @default(DOC)
  status             DocStatus @default(DRAFT)
  position           Int       @default(0)
  ownerId            String?
  reviewedAt         DateTime?
  publishedVersionId String?   @unique
  publishedAt        DateTime?
  createdById        String
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  space            Space         @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  parent           Page?         @relation("PageTree", fields: [parentId], references: [id], onDelete: Cascade)
  children         Page[]        @relation("PageTree")
  owner            User?         @relation("PageOwner", fields: [ownerId], references: [id])
  createdBy        User          @relation("PageCreatedBy", fields: [createdById], references: [id])
  versions         PageVersion[] @relation("PageVersions")
  publishedVersion PageVersion?  @relation("PagePublishedVersion", fields: [publishedVersionId], references: [id])

  @@unique([spaceId, path])
  @@index([spaceId, status])
  @@index([spaceId, parentId])
}

model PageVersion {
  id          String    @id @default(cuid())
  pageId      String
  title       String
  markdown    String
  frontmatter Json      @default("{}")
  status      DocStatus
  authorId    String
  message     String?
  gitSha      String?
  createdAt   DateTime  @default(now())

  page        Page  @relation("PageVersions", fields: [pageId], references: [id], onDelete: Cascade)
  author      User  @relation("PageVersionAuthor", fields: [authorId], references: [id])
  publishedOn Page? @relation("PagePublishedVersion")

  @@index([pageId, createdAt])
}
```

Note on uniqueness: the spec sketches `@@unique([spaceId, parentId, slug])`. That is
**not** included, because Postgres treats `NULL` as distinct — it would silently fail to
protect top-level siblings, which is exactly the case most likely to collide.
`@@unique([spaceId, path])` is the real guarantee, and it covers every depth.

- [ ] **Step 2: Add the back-relations to `User` and `Space`**

Prisma will not generate without these. Add to `model User`:

```prisma
  pagesOwned   Page[]        @relation("PageOwner")
  pagesCreated Page[]        @relation("PageCreatedBy")
  pageVersions PageVersion[] @relation("PageVersionAuthor")
```

Add to `model Space`:

```prisma
  pages Page[]
```

- [ ] **Step 3: Migrate**

```bash
npx prisma migrate dev --name pages
```

Expected: a new migration directory and a regenerated client.

- [ ] **Step 4: Confirm the test harness picked up the new tables**

Nothing to edit. `resetDb` introspects `pg_tables`, so `Page` and `PageVersion` are
truncated automatically. Confirm it rather than assuming:

```bash
npm test -- tests/integration/spaces.test.ts
```

Expected: still 2 passed. If a later test leaks rows between files, the introspection is
the first thing to check — but it should need no maintenance.

- [ ] **Step 5: Write the failing test**

`tests/integration/pages-repo.test.ts`:

> **Superseded snapshot.** Task 13 adds the `listRecentlyPublished` tests. Read
> `tests/integration/pages-repo.test.ts` for the current version.

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { getPublishedPage, getReadableSpaceByKey, listSpacePages } from "@/lib/pages/repo";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

async function fixture(visibility: "MEMBERS" | "ALL_STAFF") {
  const author = await db.user.create({
    data: { email: "author@example.com", name: "Aisyah R." },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt-contracts",
      path: "architecture/mqtt-contracts",
      title: "MQTT contracts",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "## Topics\n\nOne namespace.",
      status: "CURRENT",
      authorId: author.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });
  return { author, space, page, version };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

test("an all-staff page is readable by a non-member", async () => {
  await fixture("ALL_STAFF");
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result?.version.markdown).toContain("One namespace.");
});

test("a members-only page is not readable by a non-member", async () => {
  await fixture("MEMBERS");
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result).toBeNull();
});

test("a members-only page is readable by a member", async () => {
  const { space, author } = await fixture("MEMBERS");
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "VIEWER" },
  });
  const viewer: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  };
  const result = await getPublishedPage(viewer, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result?.page.title).toBe("MQTT contracts");
});

test("a super admin can read a members-only page", async () => {
  await fixture("MEMBERS");
  const root: Viewer = { id: "root", isSuperAdmin: true, memberships: [] };
  const result = await getPublishedPage(root, {
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
  });
  expect(result).not.toBeNull();
});

test("an unpublished page is not readable even by a member", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  await db.page.create({
    data: {
      spaceId: space.id,
      slug: "draft-only",
      path: "architecture/draft-only",
      title: "Draft only",
      createdById: author.id,
    },
  });
  const result = await getPublishedPage(stranger, {
    spaceKey: "engineering",
    path: "architecture/draft-only",
  });
  expect(result).toBeNull();
});

test("an unreadable space key resolves to null rather than an error", async () => {
  await fixture("MEMBERS");
  expect(await getReadableSpaceByKey(stranger, "engineering")).toBeNull();
  expect(await getReadableSpaceByKey(stranger, "nonexistent")).toBeNull();
});

test("listSpacePages returns every page including unpublished ones", async () => {
  const { space, author } = await fixture("ALL_STAFF");
  await db.page.create({
    data: {
      spaceId: space.id,
      slug: "wip",
      path: "architecture/wip",
      title: "WIP",
      createdById: author.id,
    },
  });
  const rows = await listSpacePages(stranger, space.id);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.publishedVersionId === null)).toHaveLength(1);
});

test("listSpacePages returns nothing for a space the viewer cannot read", async () => {
  const { space } = await fixture("MEMBERS");
  expect(await listSpacePages(stranger, space.id)).toEqual([]);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/integration/pages-repo.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/pages/repo"`.

- [ ] **Step 7: Create `src/lib/pages/repo.ts`**

> **Superseded snapshot.** Task 12 narrows the select; Task 13 appends
> `listRecentlyPublished`. Read `src/lib/pages/repo.ts` for the current version.

```ts
import { cache } from "react";
import { db } from "@/lib/db";
import { readableSpace } from "@/lib/authz/where";
import type { Viewer } from "@/lib/authz/types";

/**
 * Resolves a space the viewer may read, or null. Unreadable and nonexistent give the
 * same answer, so a title cannot leak through a status code (spec §8).
 *
 * TODO(phase-2): call needsAccessAudit(viewer, space) on the result and write to
 * AuditLog. Every page read must resolve its space through here first, which makes this
 * the right wiring point — but that is a precondition on callers, not a property of this
 * module: listSpacePages applies its own permission filter without passing through here.
 */
export const getReadableSpaceByKey = cache(async (viewer: Viewer, key: string) => {
  return db.space.findFirst({
    where: readableSpace(viewer, { key }),
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      initials: true,
      visibility: true,
    },
  });
});

/**
 * One rule for this whole module: every query states its own permission predicate, even
 * when the caller has already resolved a readable space. A reader should never have to
 * work out whether a query is guarded by its own filter or by call ordering.
 */
export const getPublishedPage = cache(
  async (viewer: Viewer, params: { spaceKey: string; path: string }) => {
    const space = await getReadableSpaceByKey(viewer, params.spaceKey);
    if (!space) return null;

    const page = await db.page.findFirst({
      where: {
        spaceId: space.id,
        path: params.path,
        publishedVersionId: { not: null },
        space: readableSpace(viewer),
      },
      // Explicit select, never `include`. Prisma expands `include: true` into a column
      // list at generation time, so `include` would silently start shipping every column
      // a later phase adds — starting with Phase 2's cached render on PageVersion.
      select: {
        id: true,
        title: true,
        path: true,
        status: true,
        docType: true,
        publishedAt: true,
        reviewedAt: true,
        owner: { select: { name: true } },
        publishedVersion: { select: { id: true, markdown: true, gitSha: true } },
      },
    });

    if (!page?.publishedVersion) return null;

    const { publishedVersion, ...rest } = page;
    return { space, page: rest, version: publishedVersion };
  },
);

export const listSpacePages = cache(async (viewer: Viewer, spaceId: string) => {
  return db.page.findMany({
    where: { spaceId, space: readableSpace(viewer) },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: {
      id: true,
      parentId: true,
      slug: true,
      path: true,
      title: true,
      status: true,
      docType: true,
      publishedVersionId: true,
    },
  });
});
```

**Three things here are load-bearing, not style.**

`cache()` gives request-level memoization, but **only inside a real React Server Component
render**, and it is worth knowing exactly when it does nothing:

- Under the default module condition — which is what Vitest, Route Handlers, Server Actions
  and any plain Node context resolve — React's shipped `cache` is a pure passthrough:
  `function (fn) { return function () { return fn.apply(null, arguments); }; }`. It never
  memoizes, and never throws. Verified by reading `node_modules/react/cjs/
  react.development.js` and by observing two identical queries from two calls with the same
  argument reference.
- Under the `react-server` condition with an active render dispatcher, it keys through a
  per-argument `WeakMap`/`Map` chain — so memoization is by argument **identity**, not
  value. Two structurally-equal but distinct `Viewer` objects both miss.

Two consequences. First, this is why Task 7 wraps `loadViewer` in `cache()`: one render must
yield one `Viewer` *object*, or every lookup here misses even in RSC. Second, **do not try
to verify this memoization from a unit test** — it is inert there by design, and a test
asserting one query would fail for reasons that have nothing to do with this code.

The measured saving it will deliver once Tasks 10–13 render for real: five queries per
reader render, two of them byte-identical, and four of five duplicated on the landing
route.

Explicit `select` rather than `include`: Prisma expands `include: true` into a column list
at generation time, so `include` would silently begin shipping Phase 2's cached-render
column on every page read, with no diff to review.

Every query carries its own predicate. An earlier draft justified omitting it from the page
query because the space had been resolved two lines above. That was safe but unstateable —
the module argued both sides of its own rule twenty lines apart, which makes the next query
site a coin flip.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/integration/pages-repo.test.ts`
Expected: 8 passed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add page schema and permission-filtered page reads"
```

---

### Task 5: Markdown rendering pipeline

Sanitising runs **before** heading ids are added. Doing it the other way round means
`rehype-sanitize` rewrites our ids to `user-content-*`, silently breaking every table of
contents anchor.

**What each defence actually stops** — measured by running six payloads through the
pipeline, then again with `rehypeSanitize` removed:

| Vector | Stopped by |
|---|---|
| `<script>`, `<img onerror>`, `<div onclick>`, `<iframe>`, raw `<a href="javascript:">` | `remarkRehype({ allowDangerousHtml: false })` — raw HTML never enters the hast tree |
| `[link](javascript:alert(1))`, `![x](data:text/html;base64,…)` | **`rehypeSanitize` alone** — remark parses these into real elements, and only the sanitiser strips the scheme |

**Known collision, deliberately not fixed.** `rehype-slug` runs after the sanitiser and
knows nothing about the footnote ids `remark-gfm` has already baked into the tree, so a
heading whose slug happens to equal one of them produces a duplicate DOM id:

- `## Footnote label` → `id="footnote-label"`, colliding with the generated
  `<h2 class="sr-only" id="footnote-label">` that every footnote's `aria-describedby`
  points at.
- `## User content fn 1` → `id="user-content-fn-1"`, colliding with the footnote item
  `<li id="user-content-fn-1">` the footnote reference links to — so the link jumps to the
  heading instead of the note.

The available fix is a `prefix` on `rehype-slug`, namespacing heading ids away from
footnote ids entirely. Declined: it would turn every anchor into `#h-context`, and on a
documentation site anchors get copied into tickets and chat, so uglier permalinks
everywhere is a worse trade than a collision that needs a heading titled exactly "Footnote
label" or "User content fn 1". Revisit only if someone actually hits it.

**Accepted limitation.** An image-only heading (`## ![Architecture](a.png)`) stringifies to
empty text, so `rehype-slug` gives it `id=""`, `rehype-autolink-headings` skips it, and it
gets no table-of-contents entry. It stays unlinkable. Do not invent a fallback id for it.

**Invariant Phase 4 depends on.** `.mermaid-source` and `.table-scroll` can only ever be
produced by these plugins: `defaultSchema` does not allow `className` on `*` or on `div`,
so a document author cannot forge either class even if raw HTML were later enabled. Phase
4's hydration selector therefore cannot be pointed at author-controlled content.

So the sanitiser is load-bearing, but for a narrower reason than "it removes script tags":
its unique job is dangerous URL schemes in **legitimately parsed Markdown**. The
consequence to carry forward: if a later phase ever sets `allowDangerousHtml: true` to let
authors write inline HTML, `rehypeSanitize` becomes the *only* defence for all six vectors,
and its schema — currently `defaultSchema` plus a `className` allowance on `code` — would
need reviewing as a security boundary rather than a formatting detail.

**Files:**
- Create: `src/lib/markdown/toc.ts`, `src/lib/markdown/mermaid.ts`,
  `src/lib/markdown/wrap.ts`, `src/lib/markdown/render.ts`
- Test: `src/lib/markdown/render.test.ts`

- [ ] **Step 1: Install the pipeline**

```bash
npm install unified remark-parse remark-gfm remark-rehype rehype-slug \
  rehype-autolink-headings rehype-sanitize rehype-stringify \
  @shikijs/rehype shiki unist-util-visit hast-util-to-string
```

**Two pre-authorised deviations**, so neither costs a round trip:

1. `toc.ts`, `mermaid.ts` and `wrap.ts` all `import type { … } from "hast"`, whose types
   live in `@types/hast`. It is normally hoisted as a transitive dependency of
   `hast-util-to-string`. If `npm run typecheck` cannot resolve it, add it explicitly:
   `npm install -D @types/hast`.
2. `rehypeShiki`'s option for handling an unrecognised code language may be named
   `fallbackLanguage` or `defaultLanguage` depending on the installed `@shikijs/rehype`.
   The test "an unknown code language does not throw" is the arbiter — use whichever name
   the installed version accepts, and report which.

- [ ] **Step 2: Write the failing test**

`src/lib/markdown/render.test.ts`:

```ts
import { expect, test } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { wrapTables } from "./wrap";
import { renderMarkdown } from "./render";

test("renders headings with stable ids and collects them for the table of contents", async () => {
  const { html, headings } = await renderMarkdown(
    "## Context\n\nSome prose.\n\n### Topic structure\n\n## Decision\n",
  );

  expect(headings).toEqual([
    { id: "context", text: "Context", depth: 2 },
    { id: "topic-structure", text: "Topic structure", depth: 3 },
    { id: "decision", text: "Decision", depth: 2 },
  ]);
  expect(html).toContain('id="context"');
  expect(html).not.toContain("user-content-");
});

test("does not collect h1, because the page title is the h1", async () => {
  const { headings } = await renderMarkdown("# Page title\n\n## Real section\n");
  expect(headings.map((h) => h.id)).toEqual(["real-section"]);
});

test("strips script tags and event handlers", async () => {
  const { html } = await renderMarkdown(
    'Text <script>alert(1)</script> more\n\n<img src="x" onerror="alert(1)">\n',
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).toContain("Text");
});

test("renders GFM tables", async () => {
  const { html } = await renderMarkdown(
    "| Segment | Owner |\n| --- | --- |\n| outlet | Provisioning |\n",
  );
  expect(html).toContain("<table>");
  expect(html).toContain("Provisioning");
});

test("highlights fenced code with Shiki", async () => {
  const { html } = await renderMarkdown('```ts\nconst a: number = 1;\n```\n');
  expect(html).toContain('class="shiki');
  expect(html).toContain("--shiki-dark");
});

test("extracts mermaid blocks instead of highlighting them", async () => {
  const source = "C4Context\n  Person(u, \"Cashier\")\n";
  const { html } = await renderMarkdown("```mermaid\n" + source + "```\n");

  expect(html).toContain('class="mermaid-source"');
  expect(html).not.toContain("language-mermaid");
  expect(html).toContain("C4Context");
});

test("an unknown code language does not throw", async () => {
  await expect(
    renderMarkdown("```notalanguage\nsomething\n```\n"),
  ).resolves.toBeTruthy();
});

test("wraps tables in a horizontal scroll container", async () => {
  const { html } = await renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  expect(html).toContain('<div class="table-scroll"><table>');
});

test("wrapTables is idempotent when applied twice to one tree", async () => {
  const html = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(wrapTables)
      .use(wrapTables)
      .use(rehypeStringify)
      .process("| A |\n| --- |\n| 1 |\n"),
  );
  expect(html.match(/table-scroll/g)).toHaveLength(1);
});

test("every internal anchor has a matching id", async () => {
  const { html } = await renderMarkdown(
    "Text[^1] and more[^two]\n\n[^1]: first\n\n[^two]: second\n",
  );
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);

  expect(hrefs.length).toBeGreaterThan(0);
  expect(hrefs.filter((href) => !ids.includes(href))).toEqual([]);
});

test("the generated footnotes heading is not a table of contents entry", async () => {
  const { headings } = await renderMarkdown(
    "## Real section\n\nText[^1]\n\n[^1]: note\n",
  );
  expect(headings.map((h) => h.text)).toEqual(["Real section"]);
});

test("a heading with no text yields no table of contents entry", async () => {
  const { headings } = await renderMarkdown(
    "## ![Architecture](a.png)\n\n## Real\n",
  );
  expect(headings.map((h) => h.text)).toEqual(["Real"]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/lib/markdown/render.test.ts`
Expected: FAIL — `Failed to resolve import "./render"`.

- [ ] **Step 4: Create `src/lib/markdown/toc.ts`**

```ts
import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { Root } from "hast";

export type Heading = { id: string; text: string; depth: 2 | 3 };

/**
 * Collects h2 and h3 into the array it is given. h1 is excluded: the page title is the
 * document's only h1 and is rendered outside the body.
 */
export function collectHeadings(options: { headings: Heading[] }) {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;

      const id = node.properties?.id;
      // An empty id is a real case, not a defensive check: an image-only heading such as
      // `## ![Architecture](a.png)` stringifies to "" because hast-util-to-string ignores
      // alt text. rehype-autolink-headings skips those, so collecting one would put a
      // blank row in the table of contents linking to `#`.
      if (typeof id !== "string" || id === "") return;

      // remark-gfm appends its own `<h2 class="sr-only" id="…footnote-label">Footnotes</h2>`
      // to any document with footnotes. It is a real h2 with an id, so without this it
      // becomes a phantom entry pointing at a visually hidden heading. The class is
      // machine-generated and unforgeable — the sanitiser strips `class` from author HTML.
      const classes = node.properties?.className;
      if (Array.isArray(classes) && classes.includes("sr-only")) return;

      const text = toString(node);
      if (text.trim() === "") return;

      options.headings.push({
        id,
        text,
        depth: node.tagName === "h2" ? 2 : 3,
      });
    });
  };
}
```

- [ ] **Step 5: Create `src/lib/markdown/mermaid.ts`**

```ts
import { visit } from "unist-util-visit";
import { toString } from "hast-util-to-string";
import type { Element, Root } from "hast";

/**
 * Replaces a ```mermaid fence with <div class="mermaid-source">…</div> before the
 * highlighter runs, so Shiki never sees a language it cannot parse. The client-side
 * renderer added in Phase 4 hydrates these nodes.
 */
export function extractMermaid() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || index === undefined || !parent) return;

      const code = node.children.find(
        (child): child is Element =>
          child.type === "element" && child.tagName === "code",
      );
      if (!code) return;

      const classes = code.properties?.className;
      const isMermaid =
        Array.isArray(classes) &&
        classes.some((c) => String(c).toLowerCase() === "language-mermaid");
      if (!isMermaid) return;

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["mermaid-source"] },
        children: [{ type: "text", value: toString(code) }],
      } satisfies Element;
    });
  };
}
```

- [ ] **Step 6: Create `src/lib/markdown/wrap.ts`**

A wide table must scroll inside its own box, never widen the page (spec §12). CSS alone
cannot do this — the wrapper has to exist in the tree.

```ts
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";

export function wrapTables() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || index === undefined || !parent) return;
      if (
        parent.type === "element" &&
        Array.isArray(parent.properties?.className) &&
        parent.properties.className.includes("table-scroll")
      ) {
        return;
      }

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["table-scroll"] },
        children: [node],
      } satisfies Element;
    });
  };
}
```

- [ ] **Step 7: Create `src/lib/markdown/render.ts`**

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeShiki from "@shikijs/rehype";
import rehypeStringify from "rehype-stringify";
import { collectHeadings, type Heading } from "./toc";
import { extractMermaid } from "./mermaid";
import { wrapTables } from "./wrap";

export type RenderedDoc = { html: string; headings: Heading[] };

const schema: Options = {
  ...defaultSchema,
  // clobberPrefix defaults to "user-content-", but remark-gfm ALREADY prefixes footnote
  // ids and their hrefs. Sanitising then prefixes the ids a second time while leaving the
  // hrefs untouched, so every footnote link and backref dangles. Emptying it loses
  // nothing: the sanitiser runs before rehype-slug, so heading ids are never prefixed
  // anyway, and footnote ids are the only ids it currently touches.
  clobberPrefix: "",
  attributes: {
    ...defaultSchema.attributes,
    // Byte-identical to hast-util-sanitize 5's current default. Kept as an explicit pin
    // against an upstream widening, not as a change — and it is what forces the `Options`
    // annotation above.
    code: [["className", /^language-./]],
  },
};

export async function renderMarkdown(markdown: string): Promise<RenderedDoc> {
  const headings: Heading[] = [];

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    // Sanitise first, then add our own ids — otherwise sanitising rewrites them.
    .use(rehypeSanitize, schema)
    .use(rehypeSlug)
    .use(collectHeadings, { headings })
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(extractMermaid)
    .use(wrapTables)
    .use(rehypeShiki, {
      themes: { light: "github-light", dark: "github-dark" },
      // Without this, Shiki loads all 346 bundled grammars: 4.2s and +80MB on the first
      // render in a process. An unlisted language degrades to `fallbackLanguage` rather
      // than throwing, which the "unknown code language" test already covers.
      langs: [
        "ts", "tsx", "js", "jsx", "json", "yaml",
        "bash", "sql", "swift", "prisma", "md", "dockerfile",
      ],
      fallbackLanguage: "text",
    })
    .use(rehypeStringify)
    .process(markdown);

  return { html: String(file), headings };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- src/lib/markdown/render.test.ts`
Expected: **12 passed.**

- [ ] **Step 9: Commit**

```bash
git add src/lib/markdown
git commit -m "feat: add sanitising markdown pipeline with toc, mermaid and table wrapping"
```

---

### Task 6: Page tree builder

Pure function over flat rows. The navigation rail is the single most-rendered component in
the app, so this must not do a query per level.

**It must also survive a `parentId` cycle.** `Page.parentId` is a self-referential foreign
key and Postgres does not prevent `a → b → a`. In a naive implementation every member of a
cycle gets attached to a parent, none is reachable from a root, and the function returns
`[]` — the whole navigation rail vanishes silently, with no error anywhere. Task 13's
`countDescendants` also recurses with no depth limit, so a cycle would hang the render
thread mid-SSR. Nothing creates cycles in Phase 1 (it is read-only), but Phase 2's page
move is precisely the operation that could, and a silent empty nav is the worst way to
find out.

**Files:**
- Create: `src/lib/pages/tree.ts`
- Test: `src/lib/pages/tree.test.ts`

`status` and `docType` are declared as `string` here. That is valid — Prisma generates
`DocStatus` as a string union, so the assignment works and keeps working as later phases
add members. The cost is that a component switching on status gets no exhaustiveness
check. If that becomes a real need, `import type { $Enums } from "@prisma/client"` is
type-only and leaves `buildTree` pure; do it while this file is small rather than after.

**Verified exhaustively.** The committed implementation was swept over every `parentId`
graph on 1–5 nodes crossed with every input permutation — **948,524 cases** — asserting on
each that no node is its own ancestor, every input row appears exactly once, and the
caller's rows are not mutated. All pass, in ~12s. The reason it holds is worth knowing,
because it is not obvious from the code: `parentId` is one edge per node, so the graph is
*functional* and each component has **at most one** cycle. Two cycles sharing a node, or a
figure-eight, are unconstructible — which is why cutting a single edge per component
suffices.

**Measured cost of the cycle guard.** The promotion loop re-walks reachability after each
promotion, so it is quadratic — but only in the number of *distinct* cycles, and the
constant is small:

| Input | Time | Roots |
|---|---|---|
| One 500-node cycle | 0.5 ms | 1 |
| 250 separate 2-node cycles (500 nodes) | 4.3 ms | 250 |
| 1000 separate 2-node cycles (2000 nodes) | 54.8 ms | 1000 |
| Healthy 2000-node tree | 0.5 ms | 1 |

4× the nodes gave 12.7× the time, so the quadratic is real. It is also irrelevant in
practice: the worst row is a 2000-page space in which *every* page sits in its own cycle.
The healthy path — which is every real render — pays one extra linear walk. Do not
optimise this without a reproduction that matters.

- [ ] **Step 1: Write the failing test**

`src/lib/pages/tree.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildTree, type PageRow, type TreeNode } from "./tree";

function row(over: Partial<PageRow> & { id: string }): PageRow {
  return {
    parentId: null,
    slug: over.id,
    path: over.id,
    title: over.id,
    status: "CURRENT",
    docType: "DOC",
    publishedVersionId: "v",
    ...over,
  };
}

test("nests children under their parent, preserving input order", () => {
  const tree = buildTree([
    row({ id: "architecture" }),
    row({ id: "c4", parentId: "architecture" }),
    row({ id: "mqtt", parentId: "architecture" }),
    row({ id: "runbooks" }),
  ]);

  expect(tree.map((n) => n.id)).toEqual(["architecture", "runbooks"]);
  expect(tree[0]?.children.map((n) => n.id)).toEqual(["c4", "mqtt"]);
  expect(tree[1]?.children).toEqual([]);
});

test("nests to arbitrary depth", () => {
  const tree = buildTree([
    row({ id: "a" }),
    row({ id: "b", parentId: "a" }),
    row({ id: "c", parentId: "b" }),
  ]);
  expect(tree[0]?.children[0]?.children[0]?.id).toBe("c");
});

test("a row whose parent is missing is treated as top level rather than dropped", () => {
  const tree = buildTree([row({ id: "orphan", parentId: "gone" })]);
  expect(tree.map((n) => n.id)).toEqual(["orphan"]);
});

test("a parent appearing after its child still nests correctly", () => {
  const tree = buildTree([row({ id: "child", parentId: "parent" }), row({ id: "parent" })]);
  expect(tree.map((n) => n.id)).toEqual(["parent"]);
  expect(tree[0]?.children.map((n) => n.id)).toEqual(["child"]);
});

test("an empty input produces an empty tree", () => {
  expect(buildTree([])).toEqual([]);
});

/**
 * Collects every occurrence. Throws if a node repeats on its own ancestor path (a live
 * cycle) or is reached twice by different paths (a duplicate) — either would hang or
 * double-count a recursive consumer such as Task 13's summariseModules.
 *
 * An earlier version used a `seen` set and `continue`, which is the same guard buildTree
 * uses internally — so it terminated on any structure and could not detect the very thing
 * its docstring claimed. A mutant with one line removed from buildTree returned a
 * genuinely circular tree and still passed both cycle tests.
 */
function collectIds(tree: TreeNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: TreeNode, path: Set<string>) => {
    if (path.has(node.id)) throw new Error(`cycle: ${node.id} is its own ancestor`);
    ids.push(node.id);
    const next = new Set(path).add(node.id);
    for (const child of node.children) visit(child, next);
  };
  for (const root of tree) visit(root, new Set());
  return ids.sort();
}

test("a parentId cycle still yields every row, reachable and finite", () => {
  const tree = buildTree([
    row({ id: "a", parentId: "b" }),
    row({ id: "b", parentId: "a" }),
  ]);

  // The bug this guards: a naive build attaches both to each other, leaves no roots, and
  // returns [] - the navigation rail vanishes with nothing logged.
  expect(tree.length).toBeGreaterThan(0);
  expect(collectIds(tree)).toEqual(["a", "b"]);
});

test("a three-node cycle mixed with a real subtree keeps both", () => {
  const tree = buildTree([
    row({ id: "root" }),
    row({ id: "leaf", parentId: "root" }),
    row({ id: "x", parentId: "z" }),
    row({ id: "y", parentId: "x" }),
    row({ id: "z", parentId: "y" }),
  ]);

  expect(collectIds(tree)).toEqual(["leaf", "root", "x", "y", "z"]);
  expect(tree.find((n) => n.id === "root")?.children.map((n) => n.id)).toEqual(["leaf"]);
});

test("a page that is its own parent becomes a childless root", () => {
  const tree = buildTree([row({ id: "self", parentId: "self" })]);
  expect(tree.map((n) => n.id)).toEqual(["self"]);
  expect(tree[0]?.children).toEqual([]);
});

test("a subtree hanging below a cycle keeps its shape", () => {
  const tree = buildTree([
    row({ id: "a", parentId: "b" }),
    row({ id: "b", parentId: "a" }),
    row({ id: "c", parentId: "a" }),
    row({ id: "d", parentId: "c" }),
  ]);

  expect(collectIds(tree)).toEqual(["a", "b", "c", "d"]);
  expect(tree).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/pages/tree.test.ts`
Expected: FAIL — `Failed to resolve import "./tree"`.

- [ ] **Step 3: Create `src/lib/pages/tree.ts`**

```ts
export type PageRow = {
  id: string;
  parentId: string | null;
  slug: string;
  path: string;
  title: string;
  status: string;
  docType: string;
  publishedVersionId: string | null;
};

export type TreeNode = PageRow & { children: TreeNode[] };

export function buildTree(rows: PageRow[]): TreeNode[] {
  // Keyed by id, so duplicate rows collapse to one node. Iterating this map rather than
  // `rows` below is what makes that safe: pushing the same node object twice would build
  // a structure a recursive consumer cannot walk.
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // No parent, or a parent outside this result set: surface it rather than lose it.
      roots.push(node);
    }
  }

  // Everything reachable by walking down from the roots. The `seen` guard is what makes
  // this terminate on a cyclic graph rather than looping forever.
  const walkFromRoots = (): Set<string> => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      for (const child of node.children) stack.push(child);
    }
    return seen;
  };

  // A parentId cycle leaves every member attached to a parent and none reachable from a
  // root, so without this the function would return an empty tree and the navigation rail
  // would silently disappear.
  let reachable = walkFromRoots();
  for (const node of nodes.values()) {
    if (reachable.has(node.id)) continue;

    // Climb to the cycle blocking this node and cut a member of *that*, rather than
    // promoting this node. Promoting the first unreachable row instead would flatten any
    // healthy subtree hanging below the cycle into extra top-level entries, and which
    // rows got flattened would depend on the query's ordering — the same logical tree
    // gave 1 root or 3 roots depending on input order.
    const climbed = new Set<string>();
    let onCycle = node;
    while (!climbed.has(onCycle.id)) {
      climbed.add(onCycle.id);
      const next = onCycle.parentId === null ? undefined : nodes.get(onCycle.parentId);
      if (!next) break;
      onCycle = next;
    }

    const parent =
      onCycle.parentId === null ? undefined : nodes.get(onCycle.parentId);
    if (parent) {
      parent.children = parent.children.filter((child) => child.id !== onCycle.id);
    }
    roots.push(onCycle);
    reachable = walkFromRoots();
  }

  return roots;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/pages/tree.test.ts`
Expected: **9 passed.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/pages/tree.ts src/lib/pages/tree.test.ts
git commit -m "feat: add page tree builder"
```

---

### Task 7: OIDC authentication and the viewer loader

Users live in our own `User` table, not Auth.js adapter tables — the identity provider is
the source of truth for identity, and we only need the local row for memberships.
Sessions are JWTs, so there is no session table to maintain.

**Files:**
- Create: `src/lib/users/upsert.ts`, `src/lib/users/gate.ts`, `src/lib/users/viewer.ts`
- Create: `src/lib/auth/config.ts`, `src/lib/auth/viewer.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Test: `tests/integration/user-upsert.test.ts`, `src/lib/users/gate.test.ts`,
  `tests/integration/viewer.test.ts`

**Why three files under `src/lib/users/` rather than one auth module.** The two decisions
that matter for security — *who may sign in* (`gate.ts`) and *what a signed-in person can
see* (`viewer.ts`) — are pure and Auth.js-free, so both are testable without instantiating
NextAuth inside Vitest. `src/lib/auth/` holds only the thin wiring on top. Verified: the
transitive import graph of `users/viewer.ts` is `@/lib/db` → `@prisma/client` plus
`@/lib/authz/types`, with no `next-auth` anywhere.

- [ ] **Step 1: Install Auth.js**

```bash
npm install next-auth@beta
```

Installed and verified against `next-auth@5.0.0-beta.32` / `@auth/core@0.41.3`, which
needed no API adaptation. `@auth/core`'s base `Profile` already declares
`email_verified?: boolean | null`, so no type workaround is required for it.

- [ ] **Step 2: Write the failing upsert test**

`tests/integration/user-upsert.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { upsertUserFromProfile } from "@/lib/users/upsert";

beforeEach(resetDb);

test("creates a user on first sign-in", async () => {
  const user = await upsertUserFromProfile({
    email: "nurul@example.com",
    name: "Nurul H.",
    avatarUrl: "https://example.com/n.png",
  });

  expect(user.email).toBe("nurul@example.com");
  expect(user.isSuperAdmin).toBe(false);
  expect(await db.user.count()).toBe(1);
});

test("updates the display name and avatar on later sign-ins without duplicating", async () => {
  await upsertUserFromProfile({ email: "wei@example.com", name: "Wei L." });
  const updated = await upsertUserFromProfile({
    email: "wei@example.com",
    name: "Wei Ling",
    avatarUrl: "https://example.com/w.png",
  });

  expect(updated.name).toBe("Wei Ling");
  expect(updated.avatarUrl).toBe("https://example.com/w.png");
  expect(await db.user.count()).toBe(1);
});

test("does not reset super-admin status on sign-in", async () => {
  const created = await upsertUserFromProfile({ email: "root@example.com", name: "Root" });
  await db.user.update({ where: { id: created.id }, data: { isSuperAdmin: true } });

  const again = await upsertUserFromProfile({ email: "root@example.com", name: "Root" });
  expect(again.isSuperAdmin).toBe(true);
});

test("falls back to the email local part when the provider sends no name", async () => {
  const user = await upsertUserFromProfile({ email: "noname@example.com", name: null });
  expect(user.name).toBe("noname");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/integration/user-upsert.test.ts`
Expected: FAIL — cannot resolve `@/lib/users/upsert`.

- [ ] **Step 4: Create `src/lib/users/upsert.ts`**

```ts
import { db } from "@/lib/db";

export type OidcProfile = {
  email: string;
  name: string | null;
  avatarUrl?: string | null;
};

export async function upsertUserFromProfile(profile: OidcProfile) {
  const email = profile.email.toLowerCase();
  const providedName = profile.name?.trim();
  const fallbackName = email.split("@")[0] ?? email;

  return db.user.upsert({
    where: { email },
    // isSuperAdmin is deliberately absent: it is granted in our system, not theirs. Note
    // this stops the flag being SET, but not an existing privileged row being adopted —
    // that is what the email_verified check in the sign-in gate is for.
    //
    // Both fields use `undefined` to mean "leave alone", so a provider that stops sending
    // a name or a picture preserves what we already have instead of overwriting it.
    update: { name: providedName || undefined, avatarUrl: profile.avatarUrl ?? undefined },
    create: { email, name: providedName || fallbackName, avatarUrl: profile.avatarUrl ?? null },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/integration/user-upsert.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Create `src/lib/users/gate.ts`**

This is the staff boundary. Spec §8 treats "signed in" as "staff", so whatever this admits
can read every `ALL_STAFF` space. It is pure so that boundary is directly testable.

```ts
export type SignInClaims = {
  email?: string | null;
  /** Deliberately `unknown`: this claim's runtime type varies by IdP. */
  emailVerified?: unknown;
};

export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an email claim counts as verified.
 *
 * The claim is not universally boolean — Auth.js types Okta's as `string` and Apple's as
 * `"true" | true` — so a strict `=== false` check would let the string "false" through as
 * if the claim were absent. That matters because the upsert matches on email: an issuer
 * willing to assert an unverified address hands over the matching row, including its
 * isSuperAdmin flag.
 *
 * An ABSENT claim is treated as verified. The OIDC spec makes it optional and several
 * legitimate providers never send it; rejecting absence would lock out real staff.
 *
 * Precisely: only `false` and the string "false" are rejections. That covers every
 * shape Auth.js's own provider types declare — boolean for Google, `string` for Okta,
 * `"true" | true` for Apple. Anything else present is accepted, which is deliberate:
 * inventing handling for shapes no provider documents would be guessing.
 */
export function isEmailVerified(claim: unknown): boolean {
  if (claim === false) return false;
  if (typeof claim === "string" && claim.trim().toLowerCase() === "false") return false;
  return true;
}

/**
 * Whether an OIDC profile may sign in at all. This is the staff boundary: spec §8 treats
 * "signed in" as "staff", so every ALL_STAFF space is readable by anyone this returns
 * true for.
 *
 * Fails closed on an empty allowlist. OIDC_ISSUER defaults to a multi-tenant issuer, so
 * without a domain check the boundary rests entirely on the IdP application being scoped
 * "internal" — a setting this codebase can neither see nor test. "Nobody can sign in" is
 * a loud failure; "everybody can" is a silent one.
 */
export function isAllowedSignIn(claims: SignInClaims, allowedDomains: string[]): boolean {
  const email = claims.email?.trim().toLowerCase();
  if (!email) return false;

  if (!isEmailVerified(claims.emailVerified)) return false;

  const domain = email.split("@")[1];
  if (!domain) return false;

  return allowedDomains.includes(domain);
}
```

- [ ] **Step 7: Write and run the gate tests**

`src/lib/users/gate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { isAllowedSignIn, isEmailVerified, parseAllowedDomains } from "./gate";

const allowed = ["company.example", "contractors.company.example"];

describe("isAllowedSignIn", () => {
  test("admits a listed domain", () => {
    expect(isAllowedSignIn({ email: "aisyah@company.example" }, allowed)).toBe(true);
  });

  test("rejects an unlisted domain", () => {
    expect(isAllowedSignIn({ email: "stranger@gmail.com" }, allowed)).toBe(false);
  });

  test("fails closed when the allowlist is empty", () => {
    expect(isAllowedSignIn({ email: "aisyah@company.example" }, [])).toBe(false);
  });

  test("rejects an explicitly unverified email", () => {
    expect(
      isAllowedSignIn({ email: "root@company.example", emailVerified: false }, allowed),
    ).toBe(false);
  });

  test("accepts a provider that omits email_verified", () => {
    expect(
      isAllowedSignIn({ email: "root@company.example", emailVerified: undefined }, allowed),
    ).toBe(true);
  });

  test("matches domain and email case-insensitively", () => {
    expect(isAllowedSignIn({ email: "Aisyah@Company.Example" }, allowed)).toBe(true);
  });

  test("rejects a missing or blank email", () => {
    expect(isAllowedSignIn({ email: null }, allowed)).toBe(false);
    expect(isAllowedSignIn({ email: "   " }, allowed)).toBe(false);
  });

  test("rejects a value with no domain part", () => {
    expect(isAllowedSignIn({ email: "notanemail" }, allowed)).toBe(false);
  });

  test("does not match a domain by suffix", () => {
    expect(isAllowedSignIn({ email: "x@evilcompany.example" }, allowed)).toBe(false);
  });

  test("rejects the string \"false\", which Okta-shaped providers send", () => {
    expect(isAllowedSignIn({ email: "root@company.example", emailVerified: "false" }, allowed)).toBe(false);
  });

  test("accepts the string \"true\", which Apple-shaped providers send", () => {
    expect(isAllowedSignIn({ email: "a@company.example", emailVerified: "true" }, allowed)).toBe(true);
  });
});

describe("isEmailVerified", () => {
  test("only an explicit falsy assertion is a rejection", () => {
    expect(isEmailVerified(false)).toBe(false);
    expect(isEmailVerified("false")).toBe(false);
    expect(isEmailVerified("FALSE")).toBe(false);
    expect(isEmailVerified("  false  ")).toBe(false);
  });

  test("absent or affirmative claims are accepted", () => {
    expect(isEmailVerified(undefined)).toBe(true);
    expect(isEmailVerified(null)).toBe(true);
    expect(isEmailVerified(true)).toBe(true);
    expect(isEmailVerified("true")).toBe(true);
  });
});

describe("parseAllowedDomains", () => {
  test("trims, lowercases and drops empties", () => {
    expect(parseAllowedDomains(" Company.Example , ,contractors.co ")).toEqual([
      "company.example",
      "contractors.co",
    ]);
  });

  test("an unset variable yields an empty list, which denies everyone", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
  });
});
```

Run: `npm test -- src/lib/users/gate.test.ts`
Expected: 15 passed.

- [ ] **Step 8: Create `src/lib/auth/config.ts`**

A generic OIDC provider, so Google Workspace and Microsoft Entra are configuration rather
than code (spec §19).

> **Superseded snapshot.** Task 10 adds the test-login provider and the `prov` JWT claim
> that revokes its sessions. Read `src/lib/auth/config.ts` for the current version.

```ts
import NextAuth from "next-auth";
import { isAllowedSignIn, parseAllowedDomains } from "@/lib/users/gate";
import { upsertUserFromProfile } from "@/lib/users/upsert";

const allowedDomains = parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS);

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Required outside recognised platforms. Auth.js otherwise defaults trustHost to
  // NODE_ENV !== "production", so this passes in dev and every auth endpoint returns 500
  // UntrustedHost in the Docker deployment — where next-auth swallows the 500 and returns
  // a null session, making the symptom "everyone is logged out" rather than an error.
  trustHost: true,
  session: {
    strategy: "jwt",
    // Auth.js re-encodes the token with a fresh expiry on every session read, so this is a
    // rolling window, not a fixed one. At the 30-day default, an account revoked upstream
    // keeps reading documentation for a month. Re-auth is a silent redirect through a live
    // IdP session, so eight hours costs the user nothing.
    maxAge: 60 * 60 * 8,
  },
  providers: [
    {
      id: "company",
      name: "Company SSO",
      type: "oidc",
      issuer: process.env.OIDC_ISSUER,
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
    },
  ],
  callbacks: {
    async signIn({ account, profile }) {
      // Task 14's test-login provider is already gated by ALLOW_TEST_LOGIN and resolves
      // only users the seed created, so the domain allowlist does not apply to it.
      if (account?.provider === "test-login") return true;

      // Ordering is load-bearing: returning false AFTER upserting would still create the
      // row, so the gate must come first.
      if (!isAllowedSignIn(
        { email: profile?.email, emailVerified: profile?.email_verified },
        allowedDomains,
      )) {
        return false;
      }

      await upsertUserFromProfile({
        email: profile!.email!,
        name: profile?.name ?? null,
        avatarUrl: typeof profile?.picture === "string" ? profile.picture : null,
      });
      return true;
    },
  },
});
```

**`trustHost: true` is not optional.** Auth.js defaults it to `NODE_ENV !== "production"`,
so without it dev works, all tests pass, and every auth endpoint returns 500
`UntrustedHost` in the Docker deployment. `next-auth` then *swallows* that 500 and returns
a null session, so the symptom is "everyone is logged out" rather than an error, and the
real cause appears only in server logs. Measured: before, `/api/auth/providers` and
`/api/auth/session` both 500; after, both 200.

Also set `AUTH_URL` in deployment. It pins the request origin to the canonical host, so a
forwarded `Host` header cannot rewrite the OIDC `redirect_uri` — `trustHost` alone leaves
you trusting whatever the proxy sends.

- [ ] **Step 9: Create `src/app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from "@/lib/auth/config";

export const { GET, POST } = handlers;
```

- [ ] **Step 10: Create `src/lib/users/viewer.ts`**

The database half of viewer loading, deliberately free of any Auth.js import. This is the
only place a `Viewer` is constructed, and it is what `can()` and `readableSpace()` consume.

```ts
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/types";

export async function viewerForEmail(email: string): Promise<Viewer | null> {
  const user = await db.user.findUnique({
    // Lower-cased on both write (upsertUserFromProfile) and read, because the unique index
    // on email is a plain btree: providers vary in the case they return, and without this
    // the same person could resolve to two identities with different membership sets.
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      isSuperAdmin: true,
      memberships: { select: { spaceId: true, role: true } },
    },
  });
  if (!user) return null;

  return {
    id: user.id,
    isSuperAdmin: user.isSuperAdmin,
    memberships: user.memberships,
  };
}
```

- [ ] **Step 11: Write and run the viewer tests**

`tests/integration/viewer.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { viewerForEmail } from "@/lib/users/viewer";

beforeEach(resetDb);

test("carries every membership the user holds", async () => {
  const user = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const engineering = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN" },
  });
  const people = await db.space.create({
    data: { key: "people", name: "People", initials: "PP" },
  });
  await db.spaceMembership.create({
    data: { spaceId: engineering.id, userId: user.id, role: "EDITOR" },
  });
  await db.spaceMembership.create({
    data: { spaceId: people.id, userId: user.id, role: "VIEWER" },
  });

  const viewer = await viewerForEmail("aisyah@example.com");

  expect(viewer?.id).toBe(user.id);
  expect(viewer?.isSuperAdmin).toBe(false);
  expect(viewer?.memberships).toHaveLength(2);
  expect(viewer?.memberships.map((m) => m.role).sort()).toEqual(["EDITOR", "VIEWER"]);
});

test("matches the email case-insensitively", async () => {
  await db.user.create({ data: { email: "wei@example.com", name: "Wei L." } });
  expect(await viewerForEmail("WEI@Example.COM")).not.toBeNull();
});

test("returns null when a signed-in email has no local user row", async () => {
  expect(await viewerForEmail("ghost@example.com")).toBeNull();
});

test("carries super-admin status through", async () => {
  await db.user.create({
    data: { email: "root@example.com", name: "Root", isSuperAdmin: true },
  });
  expect((await viewerForEmail("root@example.com"))?.isSuperAdmin).toBe(true);
});
```

Run: `npm test -- tests/integration/viewer.test.ts`
Expected: 4 passed.

- [ ] **Step 12: Create `src/lib/auth/viewer.ts`**

Every server component that reads data calls `requireViewer()`. Nothing else constructs a
`Viewer`.

```ts
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/config";
import { viewerForEmail } from "@/lib/users/viewer";
import type { Viewer } from "@/lib/authz/types";

/**
 * Wrapped in `cache()` so one render sees one Viewer OBJECT, not just one equal value.
 * The repository's own `cache()` calls key on argument identity, so a fresh Viewer per
 * call would miss every time and silently make that memoization useless. Note `cache()`
 * only memoizes inside a real RSC render — it is a passthrough everywhere else.
 */
export const loadViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return viewerForEmail(email);
});

export async function requireViewer(callbackUrl?: string): Promise<Viewer> {
  const viewer = await loadViewer();
  if (!viewer) {
    // Relative paths only. Auth.js clamps to the origin as well, but rejecting
    // protocol-relative "//evil.example" belongs at the boundary we own rather than
    // relying on a downstream library's guard.
    const safe =
      typeof callbackUrl === "string" &&
      callbackUrl.startsWith("/") &&
      !callbackUrl.startsWith("//");
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(safe ? callbackUrl : "/")}`);
  }
  return viewer;
}
```

- [ ] **Step 13: Verify the typecheck AND the build pass**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

**The build matters here specifically.** This task adds a route handler that instantiates
NextAuth at module scope, and Next collects route modules during the build — with
`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` empty. Confirmed that `next-auth@beta.32` does
not validate the provider eagerly, so this passes; the check stays because a version bump
could change it, and the failure would otherwise surface in an unrelated later task.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat: add OIDC sign-in and viewer loading"
```

---

### Task 8: Build version module

The Alpha badge and every bug report quote this string, so it must be correct in every
environment including local development.

**`GIT_SHA` must reach the container at runtime, not only at build time.** Spec §18.1 calls
it a build argument, but `buildInfo` takes `env` as a parameter, so Next cannot statically
inline it — it is a genuine runtime read. A Dockerfile that declares `ARG GIT_SHA` without
promoting it produces `0.1.0+dev` in production: a build string that is present and wrong,
which is worse than one that is missing, because every bug report will quote it. The
deployment needs both:

```dockerfile
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
```

**`Partial<NodeJS.ProcessEnv>`, not `NodeJS.ProcessEnv`.** Base `@types/node` declares
`interface ProcessEnv extends Dict<string> {}`, which `{}` satisfies — but **Next augments
that interface with a required `NODE_ENV`**, so every test that passes `{}` or
`{ GIT_SHA }` fails with `TS2741: Property 'NODE_ENV' is missing`. Measured, by reverting
the annotation and running the typecheck. This will recur anywhere else an env parameter is
typed.

**Client components must import only the type.** `RailFoot` and `BugReportDialog` use
`import type { BuildInfo }`, which is erased at compile time. A value import would pull
`package.json` — dependency list and all — into the client bundle.

**Files:**
- Create: `src/lib/version/build.ts`
- Test: `src/lib/version/build.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/version/build.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildInfo } from "./build";

test("shortens the git sha to seven characters", () => {
  const info = buildInfo({ GIT_SHA: "df0ef11a9c4e5b6d7f8091a2b3c4d5e6f7081920" });
  expect(info.gitSha).toBe("df0ef11");
  expect(info.label).toBe(`${info.version}+df0ef11`);
});

test("falls back to a dev label when no sha is provided", () => {
  expect(buildInfo({}).label).toMatch(/\+dev$/);
  expect(buildInfo({}).gitSha).toBeNull();
});

test("treats a blank sha as absent", () => {
  expect(buildInfo({ GIT_SHA: "   " }).gitSha).toBeNull();
});

test("reports the package version", () => {
  expect(buildInfo({}).version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("is always marked alpha in this phase", () => {
  expect(buildInfo({}).channel).toBe("alpha");
});

test("reads the ambient environment when called with no argument", () => {
  // Every other test passes an explicit env, so without this the default parameter is
  // never exercised — someone could change it to `{}` and no test would notice, and the
  // production path is precisely the one that relies on it.
  const previous = process.env.GIT_SHA;
  process.env.GIT_SHA = "abcdef1234567";
  try {
    expect(buildInfo().gitSha).toBe("abcdef1");
  } finally {
    if (previous === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = previous;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/version/build.test.ts`
Expected: FAIL — `Failed to resolve import "./build"`.

- [ ] **Step 3: Create `src/lib/version/build.ts`**

```ts
import pkg from "../../../package.json";

export type BuildInfo = {
  version: string;
  gitSha: string | null;
  label: string;
  channel: "alpha";
};

export function buildInfo(env: Partial<NodeJS.ProcessEnv> = process.env): BuildInfo {
  const raw = env.GIT_SHA?.trim();
  const gitSha = raw && raw.length > 0 ? raw.slice(0, 7) : null;

  return {
    version: pkg.version,
    gitSha,
    label: `${pkg.version}+${gitSha ?? "dev"}`,
    channel: "alpha",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/version/build.test.ts`
Expected: **6 passed.**

- [ ] **Step 5: Verify the typecheck and build pass**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

This task introduces the project's first JSON import, so the build is where a Turbopack or
`resolveJsonModule` problem would surface. Every other task runs it; this one previously
did not.

- [ ] **Step 6: Commit**

```bash
git add src/lib/version
git commit -m "feat: add build version module"
```

---

### Task 9: Seed script

Without this, nothing in the next four tasks can be looked at. The seed deliberately
includes an **unreadable** space and an **unpublished** page, so the permission and
publish filters are visible in the running app and not only in tests.

**Files:**
- Create: `prisma/seed.ts`
- Modify: `package.json`

- [ ] **Step 1: Install the seed runner**

```bash
npm install -D tsx
```

- [ ] **Step 2: Add the seed configuration to `package.json`**

Add a top-level `prisma` key and a script:

```json
  "prisma": { "seed": "tsx prisma/seed.ts" },
  "scripts": {
    "db:seed": "tsx prisma/seed.ts"
  }
```

Merge the `db:seed` entry into the existing `scripts` block rather than replacing it.

- [ ] **Step 3: Create `prisma/seed.ts`**

```ts
import { PrismaClient, type DocStatus, type DocType } from "@prisma/client";

const db = new PrismaClient();

// Fixed, not `new Date()`. Re-running the seed must leave the database in the same state it
// was already in, and a moving timestamp reorders "Recently published" on every run.
const PUBLISHED_EPOCH = new Date("2026-08-20T09:00:00Z");
const publishedAtFor = (index: number) =>
  new Date(PUBLISHED_EPOCH.getTime() + index * 60_000);

/**
 * Publishes a version only when the content actually differs from what is already
 * published. The naive form — always `pageVersion.create` — is not idempotent: every seed
 * run manufactured a fresh version for all six pages, so the history filled with identical
 * "Seed" entries and `publishedAt` jumped forward each time.
 */
async function publishSeedVersion(opts: {
  pageId: string;
  title: string;
  markdown: string;
  status: DocStatus;
  authorId: string;
  publishedAt: Date;
}): Promise<void> {
  const page = await db.page.findUniqueOrThrow({
    where: { id: opts.pageId },
    select: {
      publishedVersion: { select: { title: true, markdown: true, status: true } },
    },
  });

  const current = page.publishedVersion;
  if (
    current &&
    current.title === opts.title &&
    current.markdown === opts.markdown &&
    current.status === opts.status
  ) {
    return;
  }

  const version = await db.pageVersion.create({
    data: {
      pageId: opts.pageId,
      title: opts.title,
      markdown: opts.markdown,
      status: opts.status,
      authorId: opts.authorId,
      message: "Seed",
    },
  });

  await db.page.update({
    where: { id: opts.pageId },
    data: { publishedVersionId: version.id, publishedAt: opts.publishedAt },
  });
}

type SeedPage = {
  slug: string;
  title: string;
  parent?: string;
  docType?: DocType;
  status?: DocStatus;
  markdown?: string;
  published?: boolean;
};

const ENGINEERING_PAGES: SeedPage[] = [
  { slug: "architecture", title: "Architecture" },
  {
    slug: "mqtt-contracts",
    title: "MQTT contracts",
    parent: "architecture",
    markdown: [
      "The normative list of kiosk topics.",
      "",
      "## Namespace",
      "",
      "Every message uses `acme/{outlet}/{domain}/{entity}/{event}`.",
      "",
      "| Segment | Owner |",
      "| --- | --- |",
      "| `outlet` | Provisioning |",
      "| `domain` | Architecture |",
      "",
      "## Subscribing",
      "",
      "```ts",
      "await client.subscribe(`acme/${outlet}/kiosk/+/#`);",
      "```",
      "",
      "## Diagram",
      "",
      "```mermaid",
      "C4Context",
      '  Person(cashier, "Cashier")',
      "```",
      "",
    ].join("\n"),
  },
  { slug: "decisions", title: "Decisions" },
  {
    slug: "adr-0042-mqtt-topic-naming",
    title: "MQTT topic naming for kiosk events",
    parent: "decisions",
    docType: "ADR",
    status: "ACCEPTED",
    markdown: [
      "## Context",
      "",
      "Kiosk topics grew organically across three outlet generations.",
      "",
      "## Decision",
      "",
      "Adopt one hierarchical namespace for every kiosk message.",
      "",
      "## Consequences",
      "",
      "- Provisioning a new outlet needs no code change.",
      "- Every publisher must be redeployed before the bridge is removed.",
      "",
    ].join("\n"),
  },
  {
    // Three levels deep, deliberately. The navigation rail renders recursively, and
    // nothing else in the seed goes past two levels — so without this page the recursion
    // is unexercised and a regression to a fixed two-level render would leave this page
    // invisible in the rail while still reachable by URL, with nothing failing.
    slug: "topic-registry",
    title: "Topic registry",
    parent: "mqtt-contracts",
    markdown: [
      "Who owns which topic prefix.",
      "",
      "## Registry",
      "",
      "| Prefix | Owner |",
      "| --- | --- |",
      "| `acme/+/kiosk` | Kiosk |",
      "| `acme/+/loyalty` | Loyalty |",
      "",
    ].join("\n"),
  },
  {
    slug: "adr-0043-prisma-migrations",
    title: "Prisma migration policy",
    parent: "decisions",
    docType: "ADR",
    published: false,
  },
];

async function main() {
  const fahmi = await db.user.upsert({
    where: { email: "efcorporates@gmail.com" },
    update: {},
    create: {
      email: "efcorporates@gmail.com",
      name: "Fahmi D.",
      isSuperAdmin: true,
    },
  });

  const aisyah = await db.user.upsert({
    where: { email: "aisyah@example.com" },
    update: {},
    create: { email: "aisyah@example.com", name: "Aisyah R." },
  });

  // Signs in successfully but is a member of nothing. Proves 404-not-403 in the browser.
  await db.user.upsert({
    where: { email: "stranger@example.com" },
    update: {},
    create: { email: "stranger@example.com", name: "Sam Stranger" },
  });

  const engineering = await db.space.upsert({
    where: { key: "engineering" },
    update: {},
    create: {
      key: "engineering",
      name: "Engineering",
      initials: "EN",
      visibility: "MEMBERS",
      description:
        "How the POS platform is built, decided, and recovered when it breaks.",
      memberships: {
        create: [
          { userId: aisyah.id, role: "EDITOR" },
          { userId: fahmi.id, role: "ADMIN" },
        ],
      },
    },
  });

  const handbook = await db.space.upsert({
    where: { key: "handbook" },
    update: {},
    create: {
      key: "handbook",
      name: "Company handbook",
      initials: "CH",
      visibility: "ALL_STAFF",
      description: "Policies and process everyone can read.",
    },
  });

  const idBySlug = new Map<string, string>();
  // Paths are built from the parent's PATH, not its slug. Deriving from the slug only
  // works two levels deep: a third level would get `mqtt-contracts/topic-registry`
  // instead of `architecture/mqtt-contracts/topic-registry`, which is silently wrong and
  // breaks every lookup for that page.
  const pathBySlug = new Map<string, string>();

  for (const [index, seed] of ENGINEERING_PAGES.entries()) {
    const parentId = seed.parent ? idBySlug.get(seed.parent) : undefined;
    const parentPath = seed.parent ? pathBySlug.get(seed.parent) : undefined;
    const path = parentPath ? `${parentPath}/${seed.slug}` : seed.slug;
    const status = seed.status ?? "CURRENT";

    const page = await db.page.upsert({
      where: { spaceId_path: { spaceId: engineering.id, path } },
      update: {},
      create: {
        spaceId: engineering.id,
        parentId: parentId ?? null,
        slug: seed.slug,
        path,
        title: seed.title,
        docType: seed.docType ?? "DOC",
        status,
        position: index,
        ownerId: aisyah.id,
        createdById: aisyah.id,
        reviewedAt: new Date("2026-08-18T00:00:00Z"),
      },
    });
    idBySlug.set(seed.slug, page.id);
    pathBySlug.set(seed.slug, path);

    if (seed.published === false) continue;

    await publishSeedVersion({
      pageId: page.id,
      title: seed.title,
      markdown: seed.markdown ?? `Pages in **${seed.title}**.`,
      status,
      authorId: aisyah.id,
      publishedAt: publishedAtFor(index),
    });
  }

  // The handbook needs at least one readable page, or a viewer who belongs to nothing
  // signs in and sees an empty shell — which demonstrates the permission model badly and
  // leaves the ALL_STAFF read path with nothing to exercise in the browser or in E2E.
  const welcome = await db.page.upsert({
    where: { spaceId_path: { spaceId: handbook.id, path: "welcome" } },
    update: {},
    create: {
      spaceId: handbook.id,
      slug: "welcome",
      path: "welcome",
      title: "Welcome",
      position: 0,
      ownerId: fahmi.id,
      createdById: fahmi.id,
      reviewedAt: new Date("2026-08-18T00:00:00Z"),
      status: "CURRENT",
    },
  });

  await publishSeedVersion({
    pageId: welcome.id,
    title: "Welcome",
    markdown: [
      "Everything in this space is readable by anyone who can sign in.",
      "",
      "## Finding things",
      "",
      "Spaces group documentation by the team that owns it. If a space is not listed,",
      "you are not a member of it — ask its owner for access.",
      "",
    ].join("\n"),
    status: "CURRENT",
    authorId: fahmi.id,
    publishedAt: publishedAtFor(ENGINEERING_PAGES.length),
  });

  console.log(
    `Seeded 2 spaces and ${ENGINEERING_PAGES.length + 1} pages.`,
  );
}

main()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
```

- [ ] **Step 4: Run the seed and verify the counts**

```bash
npm run db:seed
```

**What re-running actually updates, which is not obvious.** Both upserts pass
`update: {}`, so existing `Page` rows are never modified — but the `PageVersion` is created
unconditionally and `publishedVersionId` is repointed at it. So while iterating on Tasks
10–13:

- Editing a page's **markdown** in the seed and re-running **does** take effect, via a new
  published version.
- Editing its **title**, `docType`, `status` or `position` does **not** — those live on
  `Page`, which `update: {}` leaves alone. Delete the row, or change `update`, if you need
  one of those to move.

Expected: prints `Seeded 2 spaces and 7 pages.` Running it a second time must also
succeed — the upserts make it idempotent for spaces and pages. Note that page **versions**
are appended each run by design; that is correct behaviour for a version table.

- [ ] **Step 5: Prove the seeded data reads back through the repository**

This is the first point in the plan where the schema, the seed, the permission predicate
and the read layer all run together, so verify the join rather than assuming it. Write a
throwaway script, run it against the **development** database, and delete it afterwards:

```ts
// scratch-verify.ts — delete after running
import { getPublishedPage, listSpacePages } from "@/lib/pages/repo";
import type { Viewer } from "@/lib/authz/types";

const stranger: Viewer = { id: "nobody", isSuperAdmin: false, memberships: [] };

const open = await getPublishedPage(stranger, { spaceKey: "handbook", path: "welcome" });
console.log("ALL_STAFF page readable by a non-member:", open !== null);

const closed = await getPublishedPage(stranger, {
  spaceKey: "engineering",
  path: "architecture/mqtt-contracts",
});
console.log("MEMBERS page readable by a non-member:", closed !== null, "(must be false)");

// Resolve the real space id first: passing "" would return [] trivially and prove nothing.
const { db } = await import("@/lib/db");
const engineering = await db.space.findUniqueOrThrow({ where: { key: "engineering" } });

console.log(
  "engineering pages a stranger can list:",
  (await listSpacePages(stranger, engineering.id)).length,
  "(must be 0)",
);
console.log(
  "engineering pages a member can list:",
  (await listSpacePages(
    // A REAL member id. readableSpace filters on the SpaceMembership row in SQL, not on
    // the Viewer.memberships array — a synthetic id with a self-declared membership
    // matches nothing and returns 0, which looks identical to a broken query.
    { id: (await db.user.findUniqueOrThrow({ where: { email: "aisyah@example.com" } })).id,
      isSuperAdmin: false,
      memberships: [{ spaceId: engineering.id, role: "EDITOR" }] },
    engineering.id,
  )).length,
  "(must be 6)",
);
```

Run with `npx tsx scratch-verify.ts`. Expected: `true`, `false`, `0`, `6`. The last two are
the pair that matters — a zero from both would look like success while actually meaning the
query is broken for everyone. If the first line is
`false`, the seed did not publish the handbook page; if the second is `true`, the
permission predicate is not reaching the seeded data and nothing later in Phase 1 can be
trusted.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add seed data for the engineering and handbook spaces"
```

---

### Task 10: Reader shell — top bar, navigation rail, pinned rail foot

The rail foot is pinned to the bottom of the navigation (spec §18.2) and carries the build
string plus **Report bug**. The button is wired to a dialog in Task 11; this task renders
it disabled-free but inert so the shell can be reviewed on its own.

**Files:**
- Create: `src/app/(reader)/[space]/layout.tsx`
- Create: `src/app/(reader)/[space]/page.tsx` (a placeholder — Task 13 replaces it)
- Create: `src/components/TopBar.tsx`, `src/components/NavLink.tsx`,
  `src/components/NavRail.tsx`, `src/components/RailFoot.tsx`
- Create: `src/components/BugReportDialog.tsx` (a placeholder — Task 11 replaces it)
- Create: `src/components/shell.css`

**This task has no unit tests for the components, by design** — they are layout, and the
project has no DOM test environment. The recursive rail is therefore verified by the build
and by actually loading the page, which is why the seed contains a page three levels deep:
a regression to a fixed two-level render would otherwise leave that page invisible in the
rail while still reachable by URL, with nothing failing anywhere.

**Five of this task's files were later superseded — the fences below are a record of Task
10, not of HEAD.** Task 11 rewrote `RailFoot` and `BugReportDialog` and added the compact
trigger to `TopBar`; Tasks 11 and 12 both extended `shell.css`; Task 12 added the `doc.css`
import to the layout. Only `NavLink.tsx`, `NavRail.tsx` and the placeholder `page.tsx` still
match the code exactly. Read the later task for the current shape of the rest.

**The test-login provider moves here, not Task 14.** Without it there is no way to
authenticate at all — real OIDC credentials are empty — so Tasks 10, 12 and 13 would be
built and reviewed blind, and the first sight of the running application would come four
tasks later. That is the late-integration risk the phase ordering exists to avoid. Task 14
then only adds the Playwright config and the specs.

- [ ] **Step 0: Create the test-login provider and its flag**

`src/lib/auth/test-login.ts` — the flag as a pure function, so the **negative** case is
directly testable. Asserting that the provider *is* offered when the flag is set is the
easy half; what actually matters is proving a passwordless login that inherits any seeded
user's memberships — including a super admin's — is absent by default.

```ts
/**
 * Whether the passwordless test-login provider should be registered. Gated on an exact
 * "1" rather than any truthy string: a stray `ALLOW_TEST_LOGIN=false` in a deployed
 * environment must not enable it.
 */
export function testLoginEnabled(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.ALLOW_TEST_LOGIN === "1";
}
```

`src/lib/auth/test-login.test.ts`:

```ts
import { expect, test } from "vitest";
import { testLoginEnabled } from "./test-login";

test('enabled only by an exact "1"', () => {
  expect(testLoginEnabled({ ALLOW_TEST_LOGIN: "1" })).toBe(true);
});

test("disabled when unset — the default a deployment inherits", () => {
  expect(testLoginEnabled({})).toBe(false);
});

test("disabled for every other value, including truthy-looking ones", () => {
  for (const value of ["0", "", "false", "true", "yes", "on", " 1"]) {
    expect(testLoginEnabled({ ALLOW_TEST_LOGIN: value })).toBe(false);
  }
});
```

Then wire it into `src/lib/auth/config.ts`. Extract the OIDC literal so both branches can
reference it, and register the credentials provider **only** when the flag is on —
registration is the gate, not just a check inside `authorize`:

```ts
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { testLoginEnabled } from "@/lib/auth/test-login";

const allowTestLogin = testLoginEnabled();

const oidcProvider = {
  id: "company",
  name: "Company SSO",
  type: "oidc" as const,
  issuer: process.env.OIDC_ISSUER,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
};

const testProvider = Credentials({
  id: "test-login",
  name: "Test login",
  credentials: { email: { label: "Email", type: "email" } },
  async authorize(credentials) {
    if (!allowTestLogin) return null;
    const email = String(credentials?.email ?? "").trim().toLowerCase();
    if (!email) return null;
    const user = await db.user.findUnique({ where: { email } });
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },
});
```

and replace the `providers` array with:

```ts
  providers: allowTestLogin ? [oidcProvider, testProvider] : [oidcProvider],
```

The `signIn` callback already short-circuits the domain allowlist for
`account?.provider === "test-login"`, which is required because seeded users are
`@example.com`. Do not remove that line.

Set `ALLOW_TEST_LOGIN=1` in your local `.env` and add it to `.env.example` documented as
**e2e and local development only, never a deployed environment**.

- [ ] **Step 1: Create `src/components/shell.css`**

Every colour comes from the tokens defined in Task 1.

> **Superseded snapshot.** Task 11 appends the bug-reporting styles and Task 12 the
> reader-route rules. Read `src/components/shell.css` for the current version.

```css
.topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 54px;
  padding: 0 18px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.brand { display: flex; align-items: center; gap: 9px; }
.brand-name { font-family: var(--serif); font-size: 17px; font-weight: 500; }

.brand-channel {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--amber);
  background: var(--amber-wash);
  border: 1px solid var(--amber);
  border-radius: 3px;
  padding: 2px 6px;
}

.shell {
  display: grid;
  grid-template-columns: 262px minmax(0, 1fr) 236px;
  align-items: start;
}

.rail-l {
  position: sticky;
  top: 54px;
  align-self: start;
  height: calc(100vh - 54px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 16px 12px 0;
  background: var(--surface);
  border-right: 1px solid var(--line);
}

.rail-foot {
  margin-top: auto;
  position: sticky;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px 0 12px;
  background: var(--surface);
  border-top: 1px solid var(--line);
}

.bugbtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 7px;
}
.bugbtn:hover {
  color: var(--accent-ink);
  background: var(--accent-wash);
  border-color: var(--accent);
}

.build {
  padding-left: 2px;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--ink-3);
}
.build-channel { color: var(--amber); }

.navgroup > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
  cursor: pointer;
  list-style: none;
  border-radius: 5px;
}
.navgroup > summary::-webkit-details-marker { display: none; }

.navlist {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: 4px;
  padding: 2px 0 8px 10px;
  border-left: 1px solid var(--line);
}
.navlist a {
  padding: 5px 9px;
  font-size: 13.5px;
  color: var(--ink-2);
  text-decoration: none;
  border-radius: 5px;
}
.navlist a:hover { color: var(--ink); background: var(--surface-2); }
.navlist a[aria-current="page"] {
  font-weight: 600;
  color: var(--accent-ink);
  background: var(--accent-wash);
  box-shadow: inset 2px 0 0 var(--accent);
}

/* Nested groups: each level indents via its own .navlist border. */
.navlist .navgroup > summary { padding-left: 9px; text-transform: none; letter-spacing: 0.02em; font-family: var(--sans); font-size: 13px; }

.tag-draft {
  margin-left: 6px;
  font-family: var(--mono);
  font-size: 9.5px;
  text-transform: uppercase;
  color: var(--amber);
  background: var(--amber-wash);
  border: 1px solid var(--amber);
  border-radius: 3px;
  padding: 1px 5px;
}

@media (max-width: 1180px) { .shell { grid-template-columns: 262px minmax(0, 1fr); } }
@media (max-width: 860px)  { .shell { grid-template-columns: minmax(0, 1fr); } .rail-l { display: none; } }
```

- [ ] **Step 2: Create `src/components/TopBar.tsx`**

> **Superseded snapshot.** Task 11 adds the compact bug button; its fence in that task is
> the current file.

```tsx
import type { BuildInfo } from "@/lib/version/build";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Create `src/components/NavLink.tsx`**

The rail is rendered by the space layout, which does not know which child route is
active. Rather than thread a path down, the link reads it itself. This is the only reason
any part of the rail is a client component.

`typedRoutes: true` is on, so a bare `string` href does not satisfy `Link`. These hrefs are
built from database values and can never be statically known literals, so the cast is forced
rather than a shortcut — `typedRoutes` still checks every literal href elsewhere.

```tsx
"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, title }: { href: string; title: string }) {
  const pathname = usePathname();

  return (
    <Link href={href as Route} aria-current={pathname === href ? "page" : undefined}>
      {title}
    </Link>
  );
}
```

- [ ] **Step 4: Create `src/components/NavRail.tsx`**

A server component. The tree is known at render time and `<details>` needs no JavaScript.

**It renders recursively, and that is a correctness requirement rather than elegance.**
`buildTree` returns arbitrary depth. An earlier draft rendered exactly two levels, which
would have left a three-deep page **absent from the navigation rail while still reachable
by URL** — nothing errors, nothing logs, the page is simply invisible. That is the worst
failure mode available in a documentation reader. A group node also links to itself, since
group pages carry their own content (the seed's `architecture` page does) and would
otherwise be unreachable from the rail.

> **Superseded snapshot.** Task 13 replaces the inline path encoder with the shared
> `pageHref`. Read `src/components/NavRail.tsx` for the current version.

```tsx
import type { TreeNode } from "@/lib/pages/tree";
import type { BuildInfo } from "@/lib/version/build";
import { NavLink } from "./NavLink";
import { RailFoot } from "./RailFoot";

type Props = {
  spaceKey: string;
  spaceName: string;
  tree: TreeNode[];
  build: BuildInfo;
};

function NavNode({ spaceKey, node }: { spaceKey: string; node: TreeNode }) {
  const isDraft = node.publishedVersionId === null;
  // `Page.path` has no format constraint, so a slug containing `#`, `?` or a space would
  // silently produce a broken link without this — one the `Route` cast in NavLink makes
  // untypecheckable, since the string is opaque to typedRoutes either way.
  const href = `/${spaceKey}/${node.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  // A draft has no published version, so getPublishedPage would 404 it. Show that the
  // page exists — members should know a draft is in flight — but do not offer a link
  // that cannot work.
  const renderSelf = (title: string) =>
    isDraft ? (
      <span className="navdraft">
        {title}
        <span className="tag-draft">Draft</span>
      </span>
    ) : (
      <NavLink href={href} title={title} />
    );

  if (node.children.length === 0) return renderSelf(node.title);

  return (
    <details className="navgroup" open>
      <summary>{node.title}</summary>
      <div className="navlist">
        {renderSelf("Overview")}
        {node.children.map((child) => (
          <NavNode key={child.id} spaceKey={spaceKey} node={child} />
        ))}
      </div>
    </details>
  );
}

export function NavRail({ spaceKey, spaceName, tree, build }: Props) {
  return (
    <div className="rail-l">
      <nav aria-label={`${spaceName} navigation`}>
        {tree.map((node) => (
          <NavNode key={node.id} spaceKey={spaceKey} node={node} />
        ))}
      </nav>
      <RailFoot build={build} />
    </div>
  );
}
```

- [ ] **Step 5: Create `src/components/RailFoot.tsx`**

> **Superseded snapshot.** Task 11 extracts the button into `BugReportButton` so the
> dialog state lives in one client component; the shipped `RailFoot` renders that instead
> of owning `useState` itself. Read `src/components/RailFoot.tsx` for the current version.

```tsx
"use client";

import { useState } from "react";
import type { BuildInfo } from "@/lib/version/build";
import { BugReportDialog } from "./BugReportDialog";

export function RailFoot({ build }: { build: BuildInfo }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rail-foot">
      <button type="button" className="bugbtn" onClick={() => setOpen(true)}>
        Report bug
      </button>
      <span className="build">
        {build.label} &middot; <span className="build-channel">{build.channel}</span>
      </span>
      {open ? <BugReportDialog build={build} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
```

- [ ] **Step 6: Create a placeholder `src/components/BugReportDialog.tsx`**

Task 11 replaces this file entirely. It exists now so the shell typechecks.

> **Superseded snapshot** — a placeholder, so the shell has something to render. Task 11
> ships the real dialog and its fence there is the current file.

```tsx
"use client";

import type { BuildInfo } from "@/lib/version/build";

export function BugReportDialog({ onClose }: { build: BuildInfo; onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Report a bug">
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
```

- [ ] **Step 7: Create `src/app/(reader)/[space]/layout.tsx`**

> **Superseded snapshot.** Task 12 revises this layout. Read
> `src/app/(reader)/[space]/layout.tsx` for the current version.

```tsx
import { notFound } from "next/navigation";
import "@/components/shell.css";
import { requireViewer } from "@/lib/auth/viewer";
import { getReadableSpaceByKey, listSpacePages } from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { buildInfo } from "@/lib/version/build";
import { NavRail } from "@/components/NavRail";
import { TopBar } from "@/components/TopBar";

export default async function SpaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  // Passing the destination is what makes a deep link from Slack or a ticket survive a
  // cold visit. Without it the callback cookie is the bare origin and the reader lands on
  // the placeholder home page instead of the page they asked for.
  const viewer = await requireViewer(`/${spaceKey}`);

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  // Unreadable and nonexistent are the same answer, so titles do not leak (spec §8).
  if (!space) notFound();

  const tree = buildTree(await listSpacePages(viewer, space.id));
  const build = buildInfo();

  return (
    <>
      <TopBar build={build} />
      <div className="shell">
        <NavRail
          spaceKey={space.key}
          spaceName={space.name}
          tree={tree}
          build={build}
        />
        {children}
      </div>
    </>
  );
}
```

- [ ] **Step 7b: Create a placeholder `src/app/(reader)/[space]/page.tsx`**

Task 13 overwrites this. It ships now for the same reason the `BugReportDialog` placeholder
does: without it the shell cannot be reached at all.

```tsx
export default function SpacePlaceholder() {
  return <main className="doc" />;
}
```

**A layout does not render on its own.** Measured: with no `page.tsx` matching the segment,
Next never invokes the layout — it serves the built-in 404 in ~16 ms, far too fast for the
Prisma queries in `getReadableSpaceByKey`, and the HTML contains neither the top bar nor the
rail. Without a page beneath it this task would ship a shell nothing can reach and no later
task could verify. The `doc` class arrives with Task 12's `doc.css`; an unstyled empty
`<main>` here is intentional.

- [ ] **Step 8: Verify the typecheck and build pass**

Run: `npm run typecheck && npm run build`
Expected: exit 0 for both.

- [ ] **Step 9: Actually load the page and confirm the rail renders three levels**

A build proves it compiles, not that it renders. With `ALLOW_TEST_LOGIN=1`, start the dev
server, sign in through `/api/auth/signin` as `aisyah@example.com` (an `EDITOR` member of
`engineering`), then fetch `/engineering` and confirm in the returned HTML:

- `architecture`, `architecture/mqtt-contracts` **and**
  `architecture/mqtt-contracts/topic-registry` all appear as links. The third is the whole
  point — it only appears if the rail recursed.
- `Prisma migration policy` carries the `Draft` chip (it is the unpublished page).
- The brand shows `alpha`, and the rail foot shows the build label.

Then fetch `/engineering` **signed out** and confirm a redirect to
`/api/auth/signin?callbackUrl=%2Fengineering` — the destination must survive.

Paste the evidence for each. If `topic-registry` is missing, the rail is not recursing and
the build passing means nothing.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add reader shell with alpha badge and pinned rail foot"
```

---

### Task 11: Bug reporting

Context is captured, not requested. Forwarding to a webhook is out of Phase 1 scope
(Phase 6 adds the queue); the report is stored, which is the part that must never be lost.

**Files:**
- Create: `src/lib/bugs/schema.ts`, `src/lib/bugs/context.ts`, `src/lib/bugs/create.ts`
- Create: `src/app/api/bugs/route.ts`
- Create: `src/components/BugReportButton.tsx`
- Modify: `src/components/RailFoot.tsx`, `src/components/TopBar.tsx`,
  `src/components/shell.css`
- Replace: `src/components/BugReportDialog.tsx`

**The button has to survive the rail disappearing.** Below 860px `.rail-l` is
`display: none`, which took the Report bug button with it — so on a phone there was no way
to report anything. Spec §18.2 wants it "reachable from wherever the problem was seen", so
the trigger and its dialog move into one client component used twice: in the rail foot
(the approved placement, wide screens) and in the top bar (visible only below 860px). They
are never both on screen, so two independent instances are simpler than lifting state.

**The dialog is an overlay, not inline.** Rendered inside `.rail-foot` it would be a form
with two textareas squeezed into a 238px column.
- Test: `src/lib/bugs/schema.test.ts`, `tests/integration/bug-context.test.ts`,
  `tests/integration/bug-report.test.ts`

**Page context is derived, never accepted.** The client sends only what it alone knows —
what happened, the route, the viewport, the user agent, the build. Which space, page and
version that route refers to is resolved on the server through the permission-filtered
repository. Two reasons: a client-supplied `pageId` could name a page in a space the
reporter cannot read, which an admin would then see in the report list; and deriving it
means there is nothing to validate, so no validation can be forgotten.

- [ ] **Step 1: Write the failing validation test**

`src/lib/bugs/schema.test.ts`:

```ts
import { expect, test } from "vitest";
import { bugReportInput } from "./schema";

const valid = {
  summary: "The TOC jumps to the wrong heading",
  routePath: "/engineering/decisions/adr-0042-mqtt-topic-naming",
  appVersion: "0.1.0",
  userAgent: "Mozilla/5.0",
  viewport: "1440x900",
};

test("accepts a minimal report", () => {
  expect(bugReportInput.parse(valid).summary).toBe(valid.summary);
});

test("rejects an empty summary", () => {
  expect(bugReportInput.safeParse({ ...valid, summary: "   " }).success).toBe(false);
});

test("caps the summary so a paste cannot fill the column", () => {
  const long = "x".repeat(5001);
  expect(bugReportInput.safeParse({ ...valid, summary: long }).success).toBe(false);
});

test("optional fields default to null rather than undefined", () => {
  const parsed = bugReportInput.parse(valid);
  expect(parsed.expected).toBeNull();
  expect(parsed.consoleError).toBeNull();
});

test("silently ignores client-supplied page context", () => {
  // The client must not be able to attach these. Zod strips unknown keys by default, so
  // this asserts the schema is not accidentally widened to passthrough later.
  const parsed = bugReportInput.parse({
    ...valid,
    pageId: "forged",
    spaceId: "forged",
    versionId: "forged",
  }) as Record<string, unknown>;

  expect(parsed.pageId).toBeUndefined();
  expect(parsed.spaceId).toBeUndefined();
  expect(parsed.versionId).toBeUndefined();
});

test("rejects a report with no route path", () => {
  const { routePath, ...withoutRoute } = valid;
  expect(bugReportInput.safeParse(withoutRoute).success).toBe(false);
});

test("strips a NUL byte, which Postgres would reject outright", () => {
  const parsed = bugReportInput.parse({ ...valid, summary: "before\0after" });
  expect(parsed.summary).toBe("beforeafter");
});

test("keeps newlines and tabs, which carry meaning in a pasted trace", () => {
  const parsed = bugReportInput.parse({ ...valid, summary: "line one\n\tindented" });
  expect(parsed.summary).toBe("line one\n\tindented");
});

test("keeps a zero-width joiner, so emoji sequences survive", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  expect(bugReportInput.parse({ ...valid, summary: family }).summary).toBe(family);
});

test("keeps bidi marks, so right-to-left text keeps its direction", () => {
  const mixed = "\u200F" + "سعر: 5" + "\u200E";
  expect(bugReportInput.parse({ ...valid, summary: mixed }).summary).toBe(mixed);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/lib/bugs/schema.test.ts`
Expected: FAIL — `Failed to resolve import "./schema"`.

- [ ] **Step 3: Create `src/lib/bugs/schema.ts`**

> **Superseded snapshot.** Phase 2's Task 5 needed the same control-character strip for
> Markdown, so `stripControl` was extracted to `src/lib/text/control.ts` and this file now
> imports it. The fence below still shows the inline copy. Read
> `src/lib/bugs/schema.ts` for the current version.

```ts
import { z } from "zod";

// Postgres rejects NUL outright (22021), turning a legal JSON body into a 500 no retry can
// clear — and this endpoint exists to receive pasted console output, where stray control
// bytes come from. Strip the C0/C1 control block only: newline, tab and carriage return
// carry meaning in a trace, and \p{Cf} (zero-width joiners, bidi marks) is deliberately
// left alone — stripping it silently breaks ZWJ emoji sequences and right-to-left text.
const stripControl = (value: string) =>
  value.replace(/\p{Cc}/gu, (ch) =>
    ch === "\n" || ch === "\t" || ch === "\r" ? ch : "",
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? stripControl(v) : null));

export const bugReportInput = z.object({
  summary: z.string().trim().min(1).max(5000).transform(stripControl),
  expected: optionalText(5000),
  routePath: z.string().min(1).max(2000),
  // No spaceId/pageId/versionId here, deliberately. They are derived server-side from
  // routePath (src/lib/bugs/context.ts). Accepting them from the client would let a
  // reporter tag a report with a page from a space they cannot read, which an admin would
  // then see in the report list.
  appVersion: z.string().min(1).max(64),
  gitSha: optionalText(64),
  userAgent: z.string().min(1).max(1000),
  viewport: z.string().regex(/^\d{1,5}x\d{1,5}$/),
  consoleError: optionalText(5000),
});

export type BugReportInput = z.infer<typeof bugReportInput>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/lib/bugs/schema.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Write the failing storage test**

`tests/integration/bug-report.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { createBugReport } from "@/lib/bugs/create";

beforeEach(resetDb);

async function reporter() {
  return db.user.create({
    data: { email: "reporter@example.com", name: "Reporter" },
  });
}

const input = {
  summary: "The TOC jumps to the wrong heading",
  expected: null,
  routePath: "/engineering/decisions/adr-0042",
  appVersion: "0.1.0",
  gitSha: "df0ef11",
  userAgent: "Mozilla/5.0",
  viewport: "1440x900",
  consoleError: null,
};

const noContext = { spaceId: null, pageId: null, versionId: null };

test("stores a report as NEW against its reporter", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, input, noContext);

  expect(report.status).toBe("NEW");
  expect(report.reporterId).toBe(user.id);
  expect(report.gitSha).toBe("df0ef11");
});

test("keeps the captured context verbatim", async () => {
  const user = await reporter();
  const report = await createBugReport(
    user.id,
    { ...input, consoleError: "TypeError: x is not a function" },
    noContext,
  );

  const stored = await db.bugReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.routePath).toBe("/engineering/decisions/adr-0042");
  expect(stored.viewport).toBe("1440x900");
  expect(stored.consoleError).toBe("TypeError: x is not a function");
});

test("stores the server-derived context alongside the report", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, input, {
    spaceId: "sp-1",
    pageId: "pg-1",
    versionId: "ver-1",
  });

  const stored = await db.bugReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.spaceId).toBe("sp-1");
  expect(stored.pageId).toBe("pg-1");
  expect(stored.versionId).toBe("ver-1");
});

test("several reports from one user are all kept", async () => {
  const user = await reporter();
  await createBugReport(user.id, input, noContext);
  await createBugReport(user.id, { ...input, summary: "Second problem" }, noContext);

  expect(await db.bugReport.count()).toBe(2);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- tests/integration/bug-report.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/bugs/create"`.

- [ ] **Step 6b: Create `src/lib/bugs/context.ts`**

```ts
import { getPublishedPage, getReadableSpaceByKey } from "@/lib/pages/repo";
import type { Viewer } from "@/lib/authz/types";

export type ReportContext = {
  spaceId: string | null;
  pageId: string | null;
  versionId: string | null;
};

const NONE: ReportContext = { spaceId: null, pageId: null, versionId: null };

/**
 * Works out which space and page a report came from, using the route the reporter was on.
 *
 * Derived here rather than accepted from the client, deliberately. A client-supplied
 * pageId could name a page in a space the reporter cannot read, and an admin reading the
 * report list would then see an id that leaked out of a space that reporter had no access
 * to. Resolving through the permission-filtered repository makes that impossible by
 * construction — and removes any need to validate these at all.
 *
 * Returns nulls rather than throwing. A report from an unrecognised route is still worth
 * keeping, and routePath is the durable breadcrumb either way.
 *
 * `split("/").filter(Boolean)` collapses repeated and leading/trailing slashes, so
 * "//engineering////architecture//mqtt" and "engineering/architecture/mqtt" (no leading
 * slash) resolve to the same context as the canonical route. The derived value is
 * therefore "a route that normalises to this page", not "the route the reporter was on
 * verbatim" — harmless, since the space predicate still gates everything below, but worth
 * knowing before reading routePath as an exact match.
 */
export async function resolveReportContext(
  viewer: Viewer,
  routePath: string,
): Promise<ReportContext> {
  const [spaceKey, ...rest] = routePath.split("/").filter(Boolean);
  if (!spaceKey) return NONE;

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) return NONE;

  if (rest.length === 0) {
    return { spaceId: space.id, pageId: null, versionId: null };
  }

  const found = await getPublishedPage(viewer, { spaceKey, path: rest.join("/") });
  if (!found) return { spaceId: space.id, pageId: null, versionId: null };

  return { spaceId: space.id, pageId: found.page.id, versionId: found.version.id };
}
```

- [ ] **Step 6c: Write and run the context tests**

`tests/integration/bug-context.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { resolveReportContext } from "@/lib/bugs/context";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

const stranger: Viewer = { id: "nobody", isSuperAdmin: false, memberships: [] };

async function fixture() {
  const author = await db.user.create({
    data: { email: "author@example.com", name: "Author" },
  });
  const space = await db.space.create({
    data: { key: "engineering", name: "Engineering", initials: "EN", visibility: "MEMBERS" },
  });
  const page = await db.page.create({
    data: {
      spaceId: space.id,
      slug: "mqtt",
      path: "architecture/mqtt",
      title: "MQTT",
      createdById: author.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT",
      markdown: "hi",
      status: "CURRENT",
      authorId: author.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });

  const member: Viewer = {
    id: author.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  };
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: author.id, role: "VIEWER" },
  });

  return { space, page, version, member };
}

test("resolves space, page and version from a page route", async () => {
  const { space, page, version, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering/architecture/mqtt")).toEqual({
    spaceId: space.id,
    pageId: page.id,
    versionId: version.id,
  });
});

test("resolves the space alone from a space route", async () => {
  const { space, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering")).toEqual({
    spaceId: space.id,
    pageId: null,
    versionId: null,
  });
});

test("gives a non-member nothing, even for a real page", async () => {
  await fixture();

  // The whole point: a reporter cannot attach context from a space they cannot read.
  expect(await resolveReportContext(stranger, "/engineering/architecture/mqtt")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
});

test("returns nulls for an unrecognised route rather than throwing", async () => {
  const { member } = await fixture();

  expect(await resolveReportContext(member, "/")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
  expect(await resolveReportContext(member, "/nonexistent/page")).toEqual({
    spaceId: null,
    pageId: null,
    versionId: null,
  });
});

test("keeps the space when the page path does not resolve", async () => {
  const { space, member } = await fixture();

  expect(await resolveReportContext(member, "/engineering/gone/missing")).toEqual({
    spaceId: space.id,
    pageId: null,
    versionId: null,
  });
});
```

Run: `npm test -- tests/integration/bug-context.test.ts`
Expected: 5 passed.

- [ ] **Step 7: Create `src/lib/bugs/create.ts`**

```ts
import { db } from "@/lib/db";
import type { ReportContext } from "./context";
import type { BugReportInput } from "./schema";

export async function createBugReport(
  reporterId: string,
  input: BugReportInput,
  context: ReportContext,
) {
  return db.bugReport.create({
    data: { reporterId, ...input, ...context },
  });
}
```

**Measured cost: 5 queries per report**, including the `Space` lookup twice —
`resolveReportContext` resolves the space, then `getPublishedPage` resolves it again. Both
are `cache()`-wrapped, but an API route handler is not an RSC render, so that memoization is
inert here (see Task 4's note). It also loads the page owner's name, which a report does not
need. Left alone deliberately: bug reports are rare, and the alternative is a bespoke query
that duplicates the permission predicate — trading five cheap queries for a second place
the predicate could drift.

`context` is a separate parameter rather than folded into `input` so the type system keeps
the two apart: `input` is client-supplied and validated, `context` is server-derived and
trusted. Merging them would make it possible to pass a client value where a derived one
belongs without anything complaining.

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -- tests/integration/bug-report.test.ts`
Expected: 4 passed.

- [ ] **Step 9: Create `src/app/api/bugs/route.ts`**

```ts
import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { bugReportInput } from "@/lib/bugs/schema";
import { resolveReportContext } from "@/lib/bugs/context";
import { createBugReport } from "@/lib/bugs/create";

export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Sign in to report a bug." }, { status: 401 });
  }

  // 128KB. The schema's own limits allow ~18,100 UTF-16 code units across all fields, and
  // Zod counts units while Content-Length counts UTF-8 BYTES — so a maximum-length report
  // in a 3-bytes-per-unit script (CJK) is ~54KB, and a 32KB cap rejected it outright. This
  // is still four orders of magnitude below the ~300MB that exhausts a memory-capped
  // container, which is the only thing this guard exists to stop.
  const MAX_BODY_BYTES = 131_072;

  // Reject on the declared size before reading the body: request.json() buffers and
  // parses everything first, so a single large POST can exhaust a memory-capped
  // container. A MISSING length is rejected too — a chunked body omits it entirely, and
  // Number(null) is 0, which would otherwise slip under any numeric cap. Real clients
  // send it: a browser fetch with a JSON.stringify body sets Content-Length.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return NextResponse.json(
      { error: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declaredLength);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That report is too large." }, { status: 413 });
  }

  const parsed = bugReportInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Add a short description of what happened." },
      { status: 400 },
    );
  }

  const context = await resolveReportContext(viewer, parsed.data.routePath);
  const report = await createBugReport(viewer.id, parsed.data, context);
  return NextResponse.json({ id: report.id }, { status: 201 });
}
```

- [ ] **Step 9b: Create `src/components/BugReportButton.tsx`**

Owns the open/closed state so both placements are self-contained.

```tsx
"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import type { BuildInfo } from "@/lib/version/build";
import { BugReportDialog } from "./BugReportDialog";

export function BugReportButton({
  build,
  className,
}: {
  build: BuildInfo;
  className: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Report bug
      </button>
      {/* Portalled to the body deliberately. Rendered as a sibling of the trigger, the
          rail instance's overlay sits inside .rail-l — which is display:none below 860px,
          taking the open dialog and the user's typed text with it, since position:fixed
          does not escape a display:none ancestor. */}
      {open
        ? createPortal(
            <BugReportDialog build={build} onClose={() => setOpen(false)} />,
            document.body,
          )
        : null}
    </>
  );
}
```

- [ ] **Step 9c: Use it in both placements**

`src/components/RailFoot.tsx` loses its own state and becomes:

```tsx
import type { BuildInfo } from "@/lib/version/build";
import { BugReportButton } from "./BugReportButton";

export function RailFoot({ build }: { build: BuildInfo }) {
  return (
    <div className="rail-foot">
      <BugReportButton build={build} className="bugbtn" />
      <span className="build">
        {build.label} &middot; <span className="build-channel">{build.channel}</span>
      </span>
    </div>
  );
}
```

Note it is no longer a client component — `BugReportButton` is.

`src/components/TopBar.tsx` gains the narrow-screen trigger:

```tsx
import type { BuildInfo } from "@/lib/version/build";
import { BugReportButton } from "./BugReportButton";

export function TopBar({ build }: { build: BuildInfo }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-name">Badam</span>
        <span className="brand-channel">{build.channel}</span>
      </div>
      {/* Only rendered below 860px, where the rail and its own button are hidden. */}
      <BugReportButton build={build} className="bugbtn-compact" />
    </header>
  );
}
```

- [ ] **Step 9d: Add the dialog and compact-button styles to `src/components/shell.css`**

```css
/* Only reachable below 860px, where .rail-l (and its Report bug button) is hidden. */
.bugbtn-compact { display: none; }

@media (max-width: 860px) {
  .bugbtn-compact {
    display: block;
    margin-left: auto;
    padding: 6px 10px;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink);
    cursor: pointer;
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
    border-radius: 6px;
  }
}

.bugdim {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, var(--ink) 38%, transparent);
}

.bugcard {
  width: min(460px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 11px;
}

.bugcard h2 {
  margin: 0 0 4px;
  font-family: var(--serif);
  font-size: 20px;
  font-weight: 500;
}

.bugcard .bughint {
  margin: 0 0 16px;
  font-size: 12.5px;
  color: var(--ink-3);
}

.bugcard label {
  display: block;
  margin-bottom: 5px;
  font-size: 13px;
  font-weight: 500;
}

.bugcard textarea {
  width: 100%;
  min-height: 76px;
  margin-bottom: 14px;
  padding: 9px 11px;
  font: inherit;
  font-size: 13.5px;
  color: var(--ink);
  resize: vertical;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 7px;
}

.bugcard .bugactions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.bugcard button {
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 7px 13px;
  cursor: pointer;
  border-radius: 7px;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--ink);
}

.bugcard button[type="submit"] {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--ground);
}
.bugcard button[type="submit"]:disabled { opacity: 0.5; cursor: default; }

.bugcard .bugerror { margin: 0 0 12px; font-size: 13px; color: var(--amber); }
```

- [ ] **Step 10: Replace `src/components/BugReportDialog.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import type { BuildInfo } from "@/lib/version/build";

type State = "editing" | "sending" | "sent" | "failed";

export function BugReportDialog({
  build,
  onClose,
}: {
  build: BuildInfo;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const [summary, setSummary] = useState("");
  const [expected, setExpected] = useState("");
  const [state, setState] = useState<State>("editing");

  // Escape closes. Deliberately not a focus trap — more than an alpha needs — but a dialog
  // that cannot be dismissed from the keyboard is worse than one that is merely imperfect.
  // Gated on state so Escape cannot unmount mid-submit: the row would still be created, the
  // user would never see "Thanks", and the natural next move is to file it twice.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state !== "sending") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, state]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");

    // Only what the client alone knows. Which space, page and version this route refers to
    // is resolved on the server, so a reporter cannot attach context from a space they
    // cannot read.
    const response = await fetch("/api/bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary,
        expected: expected || null,
        routePath: pathname,
        appVersion: build.version,
        gitSha: build.gitSha,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      }),
    }).catch(() => null);

    setState(response?.ok ? "sent" : "failed");
  }

  return (
    <div className="bugdim">
      <div className="bugcard" role="dialog" aria-label="Report a bug">
        {state === "sent" ? (
          <>
            <h2>Thanks</h2>
            <p className="bughint">Logged against {build.label}.</p>
            <div className="bugactions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2>Report a bug</h2>
            <p className="bughint">
              The page you are on, your browser, the window size and the build are attached
              automatically.
            </p>

            <label htmlFor="bug-summary">What happened?</label>
            <textarea
              id="bug-summary"
              required
              autoFocus
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />

            <label htmlFor="bug-expected">What did you expect?</label>
            <textarea
              id="bug-expected"
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
            />

            {state === "failed" ? (
              <p className="bugerror" role="alert">
                That did not send. Try again in a moment.
              </p>
            ) : null}

            <div className="bugactions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={state === "sending" || summary.trim() === ""}
              >
                {state === "sending" ? "Sending" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
```

The hint line is not decoration. §18.2 captures the route, user agent, viewport and build
without asking, so the person filing the report should be told that rather than discovering
it later.

- [ ] **Step 11: Verify the whole suite, the build, and a real report**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green — 95 tests (80 existing + 6 schema + 5 context + 4 storage).

Then prove the round trip, because none of those tests exercise the route handler:

1. Start the server with `ALLOW_TEST_LOGIN=1`, sign in as `aisyah@example.com`, and POST to
   `/api/bugs` from **a page route** — `{"summary":"smoke","routePath":"/engineering/architecture/mqtt-contracts","appVersion":"0.1.0","userAgent":"probe","viewport":"800x600"}`.
   Expect 201, then query the row and confirm `spaceId`, `pageId` **and** `versionId` are
   populated — that is the server-side derivation working.
2. POST the same body while signed in as `stranger@example.com`. Expect 201 (the report is
   still worth keeping) but all three context columns **null** — a non-member must not be
   able to attach that page's identity.
3. POST while signed out. Expect **401**.
4. POST with `{"summary":"   "}`. Expect **400**.

Paste the row contents for 1 and 2.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: add in-product bug reporting"
```

---

### Task 12: Page reader route

**Files:**
- Create: `src/app/(reader)/[space]/[...path]/page.tsx`
- Create: `src/components/Breadcrumbs.tsx`, `src/components/Toc.tsx`, `src/components/PageInfoCard.tsx`
- Create: `src/components/doc.css`
- Create: `src/app/not-found.tsx`

- [ ] **Step 1: Create `src/components/doc.css`**

> **Superseded snapshot.** Task 13 appended the `.landing` rules and Phase 2's Task 8 appended
> a heading overflow guard, so the fence below is a prefix of the shipped file, not all of it.
> Read `src/components/doc.css` for the current version.

```css
.doc { min-width: 0; max-width: 820px; padding: 30px 44px 72px; }

.crumbs {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
}
.crumbs a { text-decoration: none; }
.crumbs .sep { color: var(--line-strong); }
.crumbs ol { display: contents; list-style: none; margin: 0; padding: 0; }
.crumbs li { display: contents; }

.doc h1 {
  margin: 0 0 10px;
  font-family: var(--serif);
  font-size: 35px;
  font-weight: 500;
  line-height: 1.18;
  letter-spacing: -0.015em;
  text-wrap: balance;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  margin: 6px 0 26px;
  padding: 11px 0 13px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
  color: var(--ink-2);
}
.meta .k {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--ink-3);
}

.body :is(h1, h2, h3, h4) { scroll-margin-top: 72px; }
.body h1 { margin: 34px 0 12px; font-family: var(--serif); font-size: 23px; font-weight: 500; }
.body h2 {
  margin: 38px 0 12px;
  font-family: var(--serif);
  font-size: 23px;
  font-weight: 500;
  text-wrap: balance;
}
.body h2:first-child { margin-top: 0; }
.body h3 { margin: 26px 0 8px; font-family: var(--serif); font-size: 18px; font-weight: 500; }
.body p, .body ul, .body ol { max-width: 66ch; }
.body li::marker { color: var(--accent); }
.body a { color: var(--accent); }
/* Heading anchors come from rehype-autolink-headings. Without this every section title
   in the product paints accent-green and underlined. */
.body :is(h1, h2, h3, h4, h5, h6) a { color: inherit; text-decoration: none; }
.body img { max-width: 100%; height: auto; }
/* An unbreakable token — an autolinked URL, a long identifier — otherwise widens the whole
   document, and because the top bar and both rails are sticky in that same scroll
   container, they slide out of alignment with each other. `anywhere` rather than
   `break-word` because it also constrains intrinsic sizing, which is what stops the grid
   column being widened in the first place. `pre` already self-scrolls. */
.body :is(p, li, dd, td, th, blockquote) { overflow-wrap: anywhere; }
.body .sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.body pre {
  overflow-x: auto;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.75;
}
.body :not(pre) > code {
  padding: 1px 5px;
  font-family: var(--mono);
  font-size: 0.88em;
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.table-scroll { overflow-x: auto; }
.body table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.body th, .body td { padding: 9px 13px; text-align: left; border-bottom: 1px solid var(--line); }
.body th {
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  background: var(--surface-2);
}

.rail-r {
  position: sticky;
  top: 54px;
  align-self: start;
  height: calc(100vh - 54px);
  overflow-y: auto;
  padding: 30px 16px 32px;
  border-left: 1px solid var(--line);
}
.railhead {
  margin-bottom: 10px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.toc { display: flex; flex-direction: column; gap: 1px; margin-bottom: 26px; }
.toc a {
  padding: 5px 10px;
  font-size: 12.5px;
  color: var(--ink-2);
  text-decoration: none;
  border-left: 2px solid var(--line);
  overflow-wrap: anywhere;
}
.toc a.depth-3 { padding-left: 20px; }

.card {
  padding: 12px 13px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.card dl { display: grid; gap: 9px; margin: 0; }
.card dt {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.card dd { margin: 2px 0 0; font-size: 12.5px; }

.body .mermaid-source {
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  color: var(--ink-3);
  background: var(--surface-2);
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  overflow-x: auto;
  overflow-wrap: anywhere;
}
.body blockquote {
  margin: 18px 0;
  padding: 2px 0 2px 14px;
  color: var(--ink-2);
  border-left: 2px solid var(--line-strong);
}
.body hr { margin: 28px 0; border: 0; border-top: 1px solid var(--line); }
.body .contains-task-list { list-style: none; padding-left: 0; }

/* Paired with shell.css's `.shell` column collapse at the same width — change one and
   check the other, or the right rail and the grid column it depends on fall out of sync. */
@media (max-width: 1180px) { .rail-r { display: none; } }
```

- [ ] **Step 2: Create `src/components/Breadcrumbs.tsx`**

> **Superseded snapshot.** Task 13 replaces the local encoder with the shared `pageHref`.
> Read `src/components/Breadcrumbs.tsx` for the current version.

```tsx
import Link from "next/link";
import type { Route } from "next";

type Ancestor = { path: string; title: string; isLinkable: boolean };

const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

export function Breadcrumbs({
  spaceKey,
  spaceName,
  ancestors,
  title,
}: {
  spaceKey: string;
  spaceName: string;
  ancestors: Ancestor[];
  title: string;
}) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        <li>
          <Link href={`/${encodeURIComponent(spaceKey)}` as Route}>{spaceName}</Link>
        </li>
        {ancestors.map((ancestor) => (
          <li key={ancestor.path}>
            <span className="sep">/</span>
            {ancestor.isLinkable ? (
              <Link
                href={`/${encodeURIComponent(spaceKey)}/${encodePath(ancestor.path)}` as Route}
              >
                {ancestor.title}
              </Link>
            ) : (
              <span>{ancestor.title}</span>
            )}
          </li>
        ))}
        <li>
          <span className="sep">/</span>
          <span aria-current="page">{title}</span>
        </li>
      </ol>
    </nav>
  );
}
```

- [ ] **Step 3: Create `src/components/Toc.tsx`**

```tsx
import type { Heading } from "@/lib/markdown/toc";

export function Toc({ headings }: { headings: Heading[] }) {
  if (headings.length === 0) return null;

  return (
    <>
      <div className="railhead">On this page</div>
      <nav className="toc" aria-label="On this page">
        {headings.map((heading) => (
          <a key={heading.id} href={`#${heading.id}`} className={`depth-${heading.depth}`}>
            {heading.text}
          </a>
        ))}
      </nav>
    </>
  );
}
```

- [ ] **Step 4: Create `src/components/PageInfoCard.tsx`**

```tsx
import { dateFormat } from "@/lib/format";

export function PageInfoCard({
  ownerName,
  reviewedAt,
  docType,
  status,
  versionCount,
}: {
  ownerName: string | null;
  reviewedAt: Date | null;
  docType: string;
  status: string;
  versionCount: number;
}) {
  return (
    <>
      <div className="railhead">Page info</div>
      <div className="card">
        <dl>
          <dt>Owner</dt>
          <dd>{ownerName ?? "Unassigned"}</dd>
          <dt>Last reviewed</dt>
          <dd>{reviewedAt ? dateFormat.format(reviewedAt) : "Never"}</dd>
          <dt>Type</dt>
          <dd>{docType}</dd>
          <dt>Lifecycle</dt>
          <dd>{status}</dd>
          <dt>Versions</dt>
          <dd>{versionCount}</dd>
        </dl>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Create `src/app/not-found.tsx`**

```tsx
export default function NotFound() {
  return (
    <main style={{ padding: 48, maxWidth: "60ch" }}>
      <h1>Not found</h1>
      <p>
        This page does not exist, or it lives in a space you do not have access to. Ask the
        space owner for access.
      </p>
    </main>
  );
}
```

- [ ] **Step 6: Create `src/app/(reader)/[space]/[...path]/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { getPublishedPage, listSpacePages } from "@/lib/pages/repo";
import { renderMarkdown } from "@/lib/markdown/render";
import { dateFormat } from "@/lib/format";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageInfoCard } from "@/components/PageInfoCard";
import { Toc } from "@/components/Toc";

export default async function DocPage({
  params,
}: {
  params: Promise<{ space: string; path: string[] }>;
}) {
  const { space: spaceKey, path } = await params;
  // The full path is the right value at this call site, but note it rarely decides the
  // redirect: on a cold load the space layout also runs and its own requireViewer — which
  // has only the space key — will usually redirect first. Passing the full path here is
  // correct rather than effective, and becomes effective if the layout's auth call is ever
  // moved or removed.
  const viewer = await requireViewer(`/${spaceKey}/${path.join("/")}`);

  const result = await getPublishedPage(viewer, {
    spaceKey,
    path: path.join("/"),
  });
  if (!result) notFound();

  const { space, page, version } = result;
  const { html, headings } = await renderMarkdown(version.markdown);

  // Cache hit: the layout already called this with the same viewer object in this render.
  const rows = await listSpacePages(viewer, space.id);
  const byPath = new Map(rows.map((row) => [row.path, row]));

  const segments = page.path.split("/");
  const ancestors = segments.slice(0, -1).map((_, index) => {
    const path = segments.slice(0, index + 1).join("/");
    const row = byPath.get(path);
    return {
      path,
      title: row?.title ?? path.split("/").pop()!.replace(/-/g, " "),
      // An unpublished ancestor would 404, exactly as NavRail's draft entries would —
      // so it is shown as text, not offered as a link.
      isLinkable: row?.publishedVersionId != null,
    };
  });

  return (
    <>
      <main className="doc">
        <Breadcrumbs
          spaceKey={space.key}
          spaceName={space.name}
          ancestors={ancestors}
          title={page.title}
        />
        <h1>{page.title}</h1>

        <div className="meta">
          <span>
            <span className="k">Status</span> {page.status}
          </span>
          <span>
            <span className="k">Published</span>{" "}
            {page.publishedAt ? dateFormat.format(page.publishedAt) : "—"}
          </span>
          <span>
            <span className="k">Commit</span> {version.gitSha ?? "not mirrored yet"}
          </span>
        </div>

        {/* `dangerouslySetInnerHTML` is safe here only because `renderMarkdown` sanitises. If
            that pipeline is ever changed to skip `rehype-sanitize`, this becomes stored XSS —
            the test in Task 5 Step 2 is what guards it. */}
        <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>

      <aside className="rail-r" aria-label="Page information">
        <Toc headings={headings} />
        <PageInfoCard
          ownerName={page.owner?.name ?? null}
          reviewedAt={page.reviewedAt}
          docType={page.docType}
          status={page.status}
          versionCount={page._count.versions}
        />
      </aside>
    </>
  );
}
```

`dangerouslySetInnerHTML` is safe here only because `renderMarkdown` sanitises. If that
pipeline is ever changed to skip `rehype-sanitize`, this becomes stored XSS — the test in
Task 5 Step 2 is what guards it.

- [ ] **Step 7: Verify the page renders against seeded data**

```bash
npm run build && npm run dev
```

Then sign in and open `/engineering/architecture/mqtt-contracts`. Expected: title, status
metadata, a highlighted TypeScript block, a rendered table, the table of contents listing
"Namespace / Subscribing / Diagram", and the page info card showing Aisyah R. as owner.

- [ ] **Step 7b: Load the page and confirm what the build cannot tell you**

Task 10 established that a passing build says nothing about whether a page renders. With
`ALLOW_TEST_LOGIN=1`, sign in as `aisyah@example.com` and fetch
`/engineering/architecture/mqtt-contracts`. Confirm in the HTML:

- The `h1` is the page title, and the breadcrumb links back to the space.
- The table of contents lists **Namespace**, **Subscribing** and **Diagram**, and each
  `href="#…"` has a matching `id` in the body — the anchors must actually resolve.
- The seeded GFM table is wrapped in `<div class="table-scroll">`.
- The ` ```ts ` fence rendered through Shiki (`class="shiki"`), and the ` ```mermaid ` fence
  became `class="mermaid-source"` rather than a highlighted code block.
- The page info card shows the owner (`Aisyah R.`) and a version count.
- The nav rail marks this page `aria-current="page"`.

Then check the failure paths, which are the ones that matter:

- The unpublished ADR — `/engineering/decisions/adr-0043-prisma-migrations` — returns
  **404**, not a rendered page.
- The three-deep page `/engineering/architecture/mqtt-contracts/topic-registry` returns 200.
- As `stranger@example.com`, the same MQTT page returns **404** and its title appears
  nowhere in the response body.

Paste the evidence. If the TOC anchors do not match the body ids, the Markdown pipeline's
sanitise-before-slug ordering has regressed and the table of contents is silently broken.

**Known: a 404 renders nothing in the server HTML.** Measured against a production build —
every 404 source returns an empty shell, `<div hidden=""><!--$--><!--/$--></div>`, with the
not-found content present only in the RSC flight payload:

| 404 source | Server HTML contains "Not found" |
|---|---|
| `notFound()` from the page (unpublished ADR) | no |
| `notFound()` from the space layout (hidden space) | no |
| Next's own unmatched route (`/totally/unrouted/thing`) | no |

The third row is the point: that path never touches our code, so this is Next 16 streaming
the not-found boundary for client hydration rather than anything this task did. A real
browser renders it correctly after hydration; `curl` and any no-JS client see a blank page
with a 404 status. Acceptable for an internal alpha, and **not worth fighting** — but two
consequences to respect:

- Task 14's Playwright assertion on the "Not found" heading works because it drives a real
  browser. Do not rewrite it as an HTML fetch.
- Task 15's smoke test asserts 404 **status codes only**, never 404 body text. Keep it that
  way.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add page reader with breadcrumbs, toc and page info"
```

---

### Task 13: Space landing page

**Files:**
- Create: `src/lib/spaces/landing.ts`
- Test: `src/lib/spaces/landing.test.ts`
- Replace: `src/app/(reader)/[space]/page.tsx` (Task 10 shipped a placeholder here)
- Modify: `src/lib/pages/repo.ts`

Its fix round reached further than the list above, all of it driven by review findings:
- Create: `src/lib/pages/href.ts` + `src/lib/pages/href.test.ts` — one `pageHref(spaceKey,
  path)`. The landing page interpolated `Page.path` raw while `NavRail` and `Breadcrumbs`
  each carried their own per-segment encoder, so the same slug could produce a working link
  in one place and a broken one two inches away.
- Modify: `src/components/NavRail.tsx`, `src/components/Breadcrumbs.tsx` — both now import
  the shared helper and their local copies are gone. **This supersedes the fences for those
  two files in Task 10**; read the source, not those fences. One behaviour change, toward
  the safer copy: NavRail did not encode the space key and now does.
- Modify: `src/components/doc.css` — `.landing` rules for the muted count text, the inert
  draft module, and `overflow-wrap` on list items. `.doc` is not `.body`, so these items sat
  outside the markdown pipeline's overflow guard.
- Modify: `tests/integration/pages-repo.test.ts` — `listRecentlyPublished` shipped with no
  test at all, the only permission-bearing query in `repo.ts` without one.

- [ ] **Step 1: Write the failing test**

`src/lib/spaces/landing.test.ts`:

```ts
import { expect, test } from "vitest";
import { summariseModules } from "./landing";
import type { TreeNode } from "@/lib/pages/tree";

function node(over: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    parentId: null,
    // `slug`, `path` and `title` all defaulted to `over.id`, which made three distinct
    // fields indistinguishable: a summary reading `module.slug` where it means
    // `module.path` — every module link pointing at a wrong URL — passed the whole suite.
    // Each default is now distinct from the other two.
    slug: `${over.id}-slug`,
    path: `docs/${over.id}`,
    title: `${over.id} title`,
    status: "CURRENT",
    docType: "DOC",
    publishedVersionId: "v",
    children: [],
    ...over,
  };
}

test("counts published and draft descendants per module", () => {
  const modules = summariseModules([
    node({
      id: "decisions",
      title: "Decisions",
      children: [
        node({ id: "adr-1", parentId: "decisions" }),
        node({ id: "adr-2", parentId: "decisions" }),
        node({ id: "adr-3", parentId: "decisions", publishedVersionId: null }),
      ],
    }),
  ]);

  expect(modules).toEqual([
    {
      id: "decisions",
      title: "Decisions",
      path: "docs/decisions",
      isDraft: false,
      pageCount: 2,
      draftCount: 1,
    },
  ]);
});

test("counts nested descendants at any depth", () => {
  const modules = summariseModules([
    node({
      id: "a",
      children: [node({ id: "b", parentId: "a", children: [node({ id: "c", parentId: "b" })] })],
    }),
  ]);
  expect(modules[0]?.pageCount).toBe(2);
});

test("counts a draft nested below the top level, not just an immediate child", () => {
  const modules = summariseModules([
    node({
      id: "a",
      children: [
        node({
          id: "b",
          parentId: "a",
          children: [node({ id: "c", parentId: "b", publishedVersionId: null })],
        }),
      ],
    }),
  ]);
  expect(modules[0]?.draftCount).toBe(1);
  expect(modules[0]?.pageCount).toBe(1);
});

test("a module with no children reports zero, not one", () => {
  expect(summariseModules([node({ id: "empty" })])[0]?.pageCount).toBe(0);
});

test("summarises every module, not just the first", () => {
  const modules = summariseModules([
    node({ id: "architecture" }),
    node({ id: "decisions" }),
    node({ id: "runbooks" }),
  ]);
  expect(modules.map((m) => m.id)).toEqual(["architecture", "decisions", "runbooks"]);
});

test("the link path comes from `path`, not `slug`", () => {
  const modules = summariseModules([
    node({
      id: "topic-registry",
      slug: "topic-registry",
      path: "architecture/mqtt-contracts/topic-registry",
    }),
  ]);
  expect(modules[0]?.path).toBe("architecture/mqtt-contracts/topic-registry");
});

test("a module with no published version of its own is flagged as a draft", () => {
  expect(summariseModules([node({ id: "wip", publishedVersionId: null })])[0]?.isDraft).toBe(
    true,
  );
});

test("a published module is not a draft merely because a child is", () => {
  const modules = summariseModules([
    node({
      id: "decisions",
      children: [node({ id: "adr-1", parentId: "decisions", publishedVersionId: null })],
    }),
  ]);
  expect(modules[0]?.isDraft).toBe(false);
  expect(modules[0]?.draftCount).toBe(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/lib/spaces/landing.test.ts`
Expected: FAIL — `Failed to resolve import "./landing"`.

- [ ] **Step 3: Create `src/lib/spaces/landing.ts`**

```ts
import type { TreeNode } from "@/lib/pages/tree";

export type ModuleSummary = {
  id: string;
  title: string;
  path: string;
  /**
   * The module itself has no published version. `getPublishedPage` requires one, so a link
   * to it would 404 for everyone including admins — the landing page renders it as inert
   * text, exactly as the nav rail does.
   */
  isDraft: boolean;
  pageCount: number;
  draftCount: number;
};

function countDescendants(node: TreeNode): { published: number; drafts: number } {
  let published = 0;
  let drafts = 0;

  for (const child of node.children) {
    if (child.publishedVersionId === null) drafts += 1;
    else published += 1;

    const nested = countDescendants(child);
    published += nested.published;
    drafts += nested.drafts;
  }

  return { published, drafts };
}

export function summariseModules(tree: TreeNode[]): ModuleSummary[] {
  return tree.map((module) => {
    const counts = countDescendants(module);
    return {
      id: module.id,
      title: module.title,
      path: module.path,
      isDraft: module.publishedVersionId === null,
      pageCount: counts.published,
      draftCount: counts.drafts,
    };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/lib/spaces/landing.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the recent-pages query to `src/lib/pages/repo.ts`**

Append to the file:

```ts
export const listRecentlyPublished = cache(
  async (viewer: Viewer, spaceId: string, limit = 5) => {
    return db.page.findMany({
      // `publishedAt` and `publishedVersionId` are two independent nullable columns with no
      // constraint tying them together, so "published" has to be stated as both. Filtering
      // on the timestamp alone would survive an unpublish or a rollback (Phase 2) and yield
      // a row whose link 404s and whose byline has no author.
      where: {
        spaceId,
        publishedAt: { not: null },
        publishedVersionId: { not: null },
        space: readableSpace(viewer),
      },
      orderBy: { publishedAt: "desc" },
      take: limit,
      select: {
        id: true,
        title: true,
        path: true,
        publishedAt: true,
        publishedVersion: { select: { author: { select: { name: true } } } },
      },
    });
  },
);
```

- [ ] **Step 6: Replace the placeholder `src/app/(reader)/[space]/page.tsx`**

Task 10 shipped a stub here so the shell was reachable. Overwrite it.

**Do not import `doc.css` here.** Task 12 moved that import into the space layout, because
importing it from a page route made `.doc` compute differently on a hard load than on a
soft navigation to the same route. The layout already provides it.

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { pageHref } from "@/lib/pages/href";
import {
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
} from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { summariseModules } from "@/lib/spaces/landing";
import { dateFormat } from "@/lib/format";

export default async function SpaceLanding({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  const viewer = await requireViewer(`/${spaceKey}`);

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) notFound();

  const modules = summariseModules(buildTree(await listSpacePages(viewer, space.id)));
  const recent = await listRecentlyPublished(viewer, space.id);

  return (
    <main className="doc landing">
      <h1>{space.name}</h1>
      {space.description ? <p>{space.description}</p> : null}

      <h2>Choose a module</h2>
      {modules.length === 0 ? (
        <p className="k">This space has no pages yet.</p>
      ) : (
        <ul>
          {modules.map((module) => (
            <li key={module.id}>
              {/* A draft module has no published version, so getPublishedPage would 404 a
                  link to it — for admins too. Show that it exists, as the nav rail does,
                  but do not offer a link that cannot work. */}
              {module.isDraft ? (
                <span className="landingdraft">
                  {module.title}
                  <span className="tag-draft">Draft</span>
                </span>
              ) : (
                <Link href={pageHref(space.key, module.path)}>{module.title}</Link>
              )}{" "}
              {module.pageCount > 0 || module.draftCount > 0 ? (
                <span className="k">
                  {/* A childless module is just a page — a count of 0 next to a working link
                      reads as "empty section", so it is omitted entirely rather than shown as
                      zero. summariseModules counts descendants, which is correct; this is a
                      presentation decision. */}
                  {module.pageCount > 0
                    ? `${module.pageCount} ${module.pageCount === 1 ? "page" : "pages"}`
                    : ""}
                  {module.pageCount > 0 && module.draftCount > 0 ? " · " : ""}
                  {module.draftCount > 0
                    ? `${module.draftCount} ${module.draftCount === 1 ? "draft" : "drafts"}`
                    : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h2>Recently published</h2>
      {recent.length === 0 ? (
        <p className="k">Nothing has been published in this space yet.</p>
      ) : (
        <ul>
          {recent.map((page) => (
            <li key={page.id}>
              <Link href={pageHref(space.key, page.path)}>{page.title}</Link>{" "}
              <span className="k">
                {/* listRecentlyPublished's `where` requires both publishedVersionId and
                    publishedAt to be non-null, but Prisma types relations and nullable
                    columns from the schema, not from the filter — so these stay optional to
                    the compiler and the render stays total rather than asserting. */}
                {page.publishedVersion?.author.name}
                {page.publishedAt ? ` · ${dateFormat.format(page.publishedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

The landing page is deliberately plain markup in Phase 1 — the module grid and the
due-for-review list from the approved mockup arrive with Phase 6, which owns `reviewedAt`.

- [ ] **Step 7: Verify the build and the page**

Run: `npm run build`
Expected: exit 0, and the route table lists `/[space]` and `/[space]/[...path]`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add space landing page with module summaries"
```

---

### Task 14: End-to-end tests

Signing in through a real identity provider is not testable in CI, so a credentials
provider is added behind an environment flag. The first test asserts the flag is off by
default — a test-only sign-in path that ships enabled is a security hole, so it gets a
test of its own.

**Files:**
- Create: `playwright.config.ts`, `e2e/reader.spec.ts`
- Modify: `package.json`
- Already done in earlier tasks, do **not** redo: the test-login provider in
  `src/lib/auth/config.ts` (Task 10) and the `ALLOW_TEST_LOGIN` entry in `.env.example`

- [x] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [x] **Step 2: Add the guarded test login to `src/lib/auth/config.ts`** — ALREADY SHIPPED

> **Superseded by Task 10.** The provider exists. The fence below is the *original* Task 14
> text and no longer matches the shipped code: the flag is named `allowTestLogin`, not
> `testLoginEnabled`. Read `src/lib/auth/config.ts` for the truth; do not apply this fence.

The original text read:

```ts
import Credentials from "next-auth/providers/credentials";
import { db } from "@/lib/db";

const testLoginEnabled = process.env.ALLOW_TEST_LOGIN === "1";

const testProvider = Credentials({
  id: "test-login",
  name: "Test login",
  credentials: { email: { label: "Email", type: "email" } },
  async authorize(credentials) {
    if (!testLoginEnabled) return null;
    const email = String(credentials?.email ?? "").toLowerCase();
    const user = await db.user.findUnique({ where: { email } });
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },
});
```

Then in the `NextAuth({ ... })` call, replace the `providers` array with:

```ts
  providers: testLoginEnabled ? [oidcProvider, testProvider] : [oidcProvider],
```

and extract the existing OIDC object literal into `const oidcProvider = { ... }` above the
`NextAuth` call so both branches can reference it.

**The test-login provider already exists** — it was moved into Task 10 so the interface
could be seen while it was being built, along with `testLoginEnabled` and its three unit
tests covering the negative case. This task only adds the Playwright config and specs. Do
not create the provider again.

**Two things this task must not lose.** The `signIn` callback short-circuits the domain
allowlist for `account?.provider === "test-login"` — seeded users are `@example.com`, which
is not a company domain, so removing that line silently breaks every E2E sign-in with a
`false` return and no error. And the suite needs a genuine **negative** assertion that the
provider is absent when the flag is unset: the existing test only proves it is present when
the flag *is* set, which is the easy half. A unit test that clears `ALLOW_TEST_LOGIN`,
imports the config fresh, and asserts `test-login` is not among the providers is the piece
that actually guards against shipping a passwordless super-admin login.

- [x] **Step 3: Document the flag in `.env.example`** — ALREADY SHIPPED

`.env.example` already carries an `ALLOW_TEST_LOGIN` entry with a stronger warning than the
one this step appends, plus the note that `AUTH_SECRET` must be distinct per environment.
Running the original `printf >> .env.example` would append a weaker duplicate. Verify with
`grep -n ALLOW_TEST_LOGIN .env.example` and move on.

- [x] **Step 4: Create `playwright.config.ts`**

Port 3100 is confirmed free on this machine and approved for use (other local services
occupy 80, 3317, 5432, 8080).

**Convention:** Playwright specs live in `e2e/` and are named `*.spec.ts`. Vitest's
`include` only covers `src/**` and `tests/**`, so it can never import a Playwright spec —
`test()` called outside Playwright's runner throws an opaque error, and this separation is
what prevents it. Do not move E2E files under `tests/`.

One addition beyond the original: `webServer.timeout`. The command builds before it serves
and a cold Next build here exceeds Playwright's 60s default, which fails the whole run
before a single test starts.

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start --port 3100",
    port: 3100,
    reuseExistingServer: false,
    // The command builds before it serves, and a cold Next build here takes longer than
    // the 60s default — which fails the whole run before a single test starts.
    timeout: 300_000,
    env: { ALLOW_TEST_LOGIN: "1", GIT_SHA: "df0ef11abc" },
  },
});
```

- [x] **Step 5: Add the e2e script to `package.json`**

```json
    "test:e2e": "playwright test"
```

- [x] **Step 6: Write the failing tests**

`e2e/reader.spec.ts`:

**One assertion to watch.** In `a non-member gets not-found rather than forbidden`, the
`404` status and the "does not leak the title" assertion were both verified by hand against
a running server and hold. The `Not found` **heading** assertion was not: the 404 response
body is an empty shell, because `notFound()` under Next 16 streaming leaves the content to
the client render. `src/app/not-found.tsx` does contain `<h1>Not found</h1>`, so a real
browser will very likely satisfy it — but if it fails, fix it by asserting what the browser
actually renders. **Do not weaken the `not.toContainText("MQTT contracts")` assertion beside
it** — that one is the security property this test exists for.

```ts
import { expect, test } from "@playwright/test";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/api/auth/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /test login/i }).click();
  await expect(page).not.toHaveURL(/signin/);
}

test("test login is offered only because the e2e flag is set", async ({ request }) => {
  const providers = (await (await request.get("/api/auth/providers")).json()) as Record<
    string,
    unknown
  >;
  // Both providers are present here because webServer.env sets ALLOW_TEST_LOGIN=1.
  expect(Object.keys(providers)).toEqual(
    expect.arrayContaining(["company", "test-login"]),
  );
});

test("test login rejects an email that is not a seeded user", async ({ page }) => {
  await page.goto("/api/auth/signin");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: /test login/i }).click();
  // authorize() returned null, so we are still unauthenticated.
  const response = await page.goto("/engineering");
  expect(response?.url()).toMatch(/signin/);
});

test("a member reads a page with navigation, toc and page info", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await expect(page.getByRole("heading", { level: 1, name: "MQTT contracts" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "On this page" })).toContainText("Namespace");
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Engineering");
  await expect(page.getByText("Aisyah R.")).toBeVisible();
  await expect(page.locator("table")).toBeVisible();
  await expect(page.locator(".shiki")).toBeVisible();
});

test("table of contents anchors reach their heading", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await page.getByRole("navigation", { name: "On this page" }).getByText("Subscribing").click();
  await expect(page).toHaveURL(/#subscribing$/);
  await expect(page.locator("#subscribing")).toBeInViewport();
});

test("no page scrolls horizontally, whatever the content", async ({ page }) => {
  // A layout regression no unit test can catch: an unbreakable token — an autolinked URL,
  // a long identifier in a mermaid block, a wide image — widens the document, and because
  // the top bar and both rails are sticky in that same scroll container they slide out of
  // alignment. Images, paragraphs and the mermaid placeholder were each fixed separately
  // after the first two were found by hand; this asserts the class, not the instances.
  await signIn(page, "aisyah@example.com");

  for (const path of [
    "/engineering",
    "/engineering/architecture/mqtt-contracts",
    "/engineering/architecture/mqtt-contracts/topic-registry",
    "/handbook/welcome",
  ]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBe(0);
  }
});

test("a non-member gets not-found rather than forbidden", async ({ page }) => {
  await signIn(page, "stranger@example.com");
  const response = await page.goto("/engineering/architecture/mqtt-contracts");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("MQTT contracts");
});

test("an unpublished page is not readable even by an editor", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  const response = await page.goto("/engineering/decisions/adr-0043-prisma-migrations");
  expect(response?.status()).toBe(404);
});

test("the alpha badge and build string are visible, and a bug can be reported", async ({ page }) => {
  await signIn(page, "aisyah@example.com");
  await page.goto("/engineering/architecture/mqtt-contracts");

  await expect(page.getByText("alpha", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/0\.1\.0\+df0ef11/)).toBeVisible();

  await page.getByRole("button", { name: "Report bug" }).click();
  const dialog = page.getByRole("dialog", { name: "Report a bug" });
  await dialog.getByLabel("What happened?").fill("The table of contents skips a heading.");
  await dialog.getByRole("button", { name: "Send report" }).click();

  await expect(dialog.getByText(/Thanks/)).toBeVisible();
});
```

- [x] **Step 7: Add the negative unit test that no Playwright test can cover**

The prose at the top of this task calls this "the piece that actually guards against
shipping a passwordless super-admin login", and then no step creates it. Playwright cannot:
`webServer.env` sets `ALLOW_TEST_LOGIN=1`, so every E2E run exercises the flag-on case only.
The three existing tests in `src/lib/auth/test-login.test.ts` cover the flag *parser*, not
the `providers` array.

Shipped as `src/lib/auth/providers.test.ts` — three tests. Two things had to be discovered
to make it work, both worth carrying forward:

- **`next-auth` must be inlined for vitest.** It imports `next/server`, which Vite's node
  resolution cannot satisfy from an externalised dependency, so the auth config is otherwise
  unimportable from a test. `vitest.config.ts` now carries
  `server: { deps: { inline: ["next-auth", "@auth/core"] } }`.
- **Clearing the env var does not work, and fails *open*.** `config.ts` imports the Prisma
  client, and **importing Prisma loads `.env` into `process.env`** — which sets
  `ALLOW_TEST_LOGIN=1` straight back, after the test deleted it and before the config reads
  it. The test then passes for the wrong reason on a broken build. Measured, not assumed.
  The flag-off case therefore stubs the helper module (`vi.doMock("./test-login", …)`)
  rather than the environment. The `"true"` case can still go through the environment,
  because dotenv does not overwrite a variable that is already set.

  Generalise this: **any test that clears an env var also present in `.env` and then imports
  anything touching Prisma has the same hole.**

Verified to fail: making the providers array unconditional kills both negative tests, with
`expected [ 'company', 'test-login' ] to not include 'test-login'`.

- [x] **Step 8: Run the tests**

```bash
npm run db:seed
npm run test:e2e
```

Result: **8 passed** in 4.9s against a production build, and the vitest suite went 125 → 128.

Two notes from the run:
- The `Not found` heading assertion **passes**. The 404 body is an empty shell in the initial
  HTML, so this was flagged as uncertain above; the client render supplies the heading.
- The overflow guard was verified to fail: forcing a wide element produced
  `/engineering scrolls horizontally by 1026px`, naming the offending route.
- The bug-reporting spec inserts a real `BugReport` row into the **dev** database. Delete it
  after a run — `delete from "BugReport" where summary = '…'` — or the row accumulates.

If sign-in times out, confirm `ALLOW_TEST_LOGIN=1` reached the server process — it is set by
`webServer.env`, not by `.env`.

- [x] **Step 9: Commit**

Stage explicit paths only — `git add -A` once swept a live subagent's in-flight work into an
unrelated commit on this project.

```bash
git add playwright.config.ts e2e/ package.json package-lock.json src/lib/auth/test-login.test.ts
git commit -m "test: add end-to-end coverage for reading, permissions and bug reporting"
```

---

### Task 15: Smoke test

The last task, and the only one that exercises the whole system as a system. Everything
before it tests a layer: Vitest covers pure logic and the repository, Playwright drives two
browser journeys. Nothing yet answers the question you actually ask before a deploy or
after a dependency bump — **does this work from a cold start?**

It is deliberately not a browser test. Playwright already owns those, needs a browser
binary, and is slow. This is plain HTTP against a production build: provision, migrate,
seed, build, serve, authenticate, assert, tear down. One command, no browser, exits
non-zero on the first failure.

**Files:**
- Create: `scripts/smoke.sh`
- Modify: `package.json` (add `npm run smoke`)

**What it does to the dev database.** This is the one test that deliberately writes to
`badam` rather than `badam_test`, because a cold start is what it is testing. It runs
`setup-db.sh`, `migrate deploy` and the seed, then files a bug report. Two consequences:
re-running the seed publishes a **new `PageVersion`** for each page, so version counts grow
with every run while the 2-spaces/7-pages invariant holds; and the bug report must be
cleaned up, which the Teardown step below does.

- [x] **Step 1: Create `scripts/smoke.sh`**

**Two defects were baked into the fence below when it was first written**, both now fixed in
it: three lines carried `'"'"'`-style shell-escaping artifacts left over from the heredoc that
generated them, so the script would not parse at all; and `prisma db execute --stdin` needs
`--schema prisma/schema.prisma`, or it exits with "Either --url or --schema must be
provided". The fence is now byte-identical to the shipped `scripts/smoke.sh`.

```bash
#!/usr/bin/env bash
# End-to-end smoke test. Provisions, seeds, builds, serves and exercises the running app
# over HTTP. Answers "does a cold start work", which no other test does.
#
#   ./scripts/smoke.sh
#
# Requires ALLOW_TEST_LOGIN=1 — it authenticates as seeded users. Never run against a
# deployed environment: it seeds data and expects the passwordless login.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3998}"
BASE="http://localhost:$PORT"
JAR="$(mktemp)"
LOG="$(mktemp)"
SERVER=""
FAILURES=0

cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  rm -f "$JAR" "$LOG"
}
trap cleanup EXIT

step()  { printf "\n\033[1m== %s\033[0m\n" "$1"; }
ok()    { printf "  \033[32mok\033[0m   %s\n" "$1"; }
fail()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAILURES=$((FAILURES + 1)); }

expect_status() { # url expected label
  local got
  got=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" "$BASE$1")
  [ "$got" = "$2" ] && ok "$3 ($1 -> $got)" || fail "$3 ($1 -> $got, wanted $2)"
}

expect_body() { # url needle label
  curl -s -b "$JAR" "$BASE$1" | grep -q -- "$2" \
    && ok "$3" || fail "$3 (no match for '$2' at $1)"
}

sign_in() { # email
  : > "$JAR"
  local csrf
  csrf=$(curl -s -c "$JAR" "$BASE/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
  curl -s -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/api/auth/callback/test-login" \
    -d "email=$1" -d "csrfToken=$csrf" -d "json=true"
  curl -s -b "$JAR" "$BASE/api/auth/session" | grep -q "$1" \
    && ok "signed in as $1" || fail "could not sign in as $1"
}

step "Provision"
./scripts/setup-db.sh > /dev/null
npx --no prisma migrate deploy > /dev/null
ok "database ready and migrated"

step "Seed"
npm run db:seed 2>&1 | grep -q "Seeded" && ok "seeded" || fail "seed did not report success"

step "Build"
npm run build > "$LOG" 2>&1 && ok "production build" || { cat "$LOG"; fail "build"; exit 1; }

step "Serve"
ALLOW_TEST_LOGIN=1 npx next start --port "$PORT" > "$LOG" 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "$BASE/" && break; sleep 1; done
curl -s -o /dev/null "$BASE/" && ok "listening on $PORT" || { cat "$LOG"; fail "server did not start"; exit 1; }

step "Signed out"
: > "$JAR"
[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/engineering")" = "307" ] \
  && ok "reader redirects to sign-in" || fail "reader did not redirect when signed out"
curl -s -D - -o /dev/null "$BASE/engineering" | grep -qi "callbackUrl" \
  && ok "redirect carries a callbackUrl" || fail "redirect lost the callbackUrl"

step "Member of engineering"
sign_in "aisyah@example.com"
expect_status "/engineering" 200 "members-only space readable by a member"
expect_status "/handbook"    200 "all-staff space readable"
expect_body "/engineering" "topic-registry" "rail reaches three levels deep"
expect_body "/engineering" "tag-draft"      "unpublished page marked as a draft"
expect_body "/engineering" "brand-channel"  "alpha badge present"

step "Member of nothing"
sign_in "stranger@example.com"
expect_status "/engineering" 404 "members-only space hidden (404, not 403)"
expect_status "/handbook"    200 "all-staff space still readable"
curl -s -b "$JAR" "$BASE/engineering" | grep -qi "MQTT" \
  && fail "a hidden space leaked a page title" || ok "no page titles leaked from the hidden space"

step "Bug reporting"
sign_in "aisyah@example.com"
code=$(curl -s -b "$JAR" -o /dev/null -w "%{http_code}" -X POST "$BASE/api/bugs" \
  -H "Content-Type: application/json" \
  -d '{"summary":"smoke test","routePath":"/engineering","appVersion":"0.0.0","userAgent":"smoke","viewport":"800x600"}')
[ "$code" = "201" ] && ok "bug report accepted" || fail "bug report POST returned $code"

step "Teardown"
# The bug-reporting check above inserts a real row. Remove it, or every smoke run leaves
# one behind. Scoped to this run's summary rather than a TRUNCATE, so a developer's own
# reports survive.
printf "delete from \"BugReport\" where summary = 'smoke test';" \
  | npx --no prisma db execute --stdin --schema prisma/schema.prisma > /dev/null 2>&1 \
  && ok "removed the smoke bug report" || fail "could not clean up the smoke bug report"

step "Result"
if [ "$FAILURES" -eq 0 ]; then
  printf "\n\033[32mSMOKE PASSED\033[0m\n"
else
  printf "\n\033[31mSMOKE FAILED: %s check(s)\033[0m\n" "$FAILURES"
  exit 1
fi
```

Make it executable: `chmod +x scripts/smoke.sh`

- [x] **Step 2: Add the script to `package.json`**

```json
    "smoke": "./scripts/smoke.sh"
```

- [x] **Step 3: Run it**

```bash
npm run smoke
```

Result: every check `ok`, ending in `SMOKE PASSED`, exit 0. Fifteen checks across provision,
seed, build, serve, signed-out redirect, member reads, non-member 404-not-403 with no title
leak, bug reporting, and teardown.

- [x] **Step 4: Prove it can fail**

A smoke test that has never failed is not evidence. Done: inverting the stranger's expected
status from 404 to 200 produced

```
  FAIL members-only space hidden (404, not 403) (/engineering -> 404, wanted 200)

SMOKE FAILED: 1 check(s)
```

and **exit code 1**. Restored, re-run, `SMOKE PASSED` and exit code 0. The exit code is the
part that matters for CI and is easy to lose to a pipe — `npm run smoke | tail` reports
tail's status, not the script's.

- [x] **Step 5: Commit**

Stage explicit paths only — `git add -A` once swept a live subagent's in-flight work into an
unrelated commit on this project.

```bash
git add scripts/smoke.sh package.json
git commit -m "test: add cold-start smoke test"
```

## Phase 1 exit criteria

All verified on 23 Aug 2026, at commit `77b64f6`:

- [x] `npm test` — **128 passing, 18 files** (88 unit, 40 integration)
- [x] `npm run test:e2e` — **8 passing** against a production build on port 3100
- [x] `npm run smoke` — **15 checks, `SMOKE PASSED`, exit 0** from a cold start
- [x] `npm run typecheck && npm run build` — both exit 0
- [x] A member reads a seeded page with navigation, breadcrumbs, TOC and page info
- [x] A non-member receives **404** for that same page, and its title appears nowhere in
      the response
- [x] An unpublished page is unreachable by URL, including by an editor
- [x] The Alpha badge and `0.1.0+df0ef11` build string render in the shell
- [x] Report bug stores a row with the route, version and viewport captured automatically —
      confirmed by inspecting the stored row: `routePath /engineering/architecture/
      mqtt-contracts`, `appVersion 0.1.0`, `viewport 1280x720`, the browser's real user
      agent, the signed-in reporter, and a `pageId` the **server** resolved from the route
      to "MQTT contracts". Nothing in that row came from a client-supplied identifier.

Two guards were additionally proven able to fail, since a green test that cannot fail is
not evidence: registering `test-login` unconditionally kills the provider tests, and forcing
a wide element produces `/engineering scrolls horizontally by 1026px`.

**Phase 1 is complete.**

## Two sources of truth for membership, deliberately

`can(viewer, space, action)` reads `viewer.memberships` — the in-memory array. But
`readableSpace(viewer)` filters on `SpaceMembership.userId` **in SQL**, ignoring that array
entirely. Discovered when a verification script built a synthetic viewer with a
self-declared membership and got zero rows back: a fabricated membership cannot conjure a
readable space.

For Phase 1 this is purely a strength — the read path does not trust the session's copy of
anything, so a stale or forged `Viewer` still cannot read a space the database says it may
not. Two consequences to carry forward:

- **Testing the read path requires a real `SpaceMembership` row.** A hand-built `Viewer`
  will silently return nothing, which reads as a broken query rather than a missing
  fixture.
- **Phase 2's write path is different.** `EDIT` and `PUBLISH` go through `can()`, which
  *does* trust the array. That is safe only because `viewerForEmail` is the single
  construction site and builds it from the database in the same request. If a second
  construction site ever appears, the write path loses the guarantee the read path keeps.

## Offboarding, which is not what you would guess

Established by probing the running server. Deleting a `User` row is **not** offboarding:
the next sign-in upserts it straight back, with `isSuperAdmin: false` and no memberships.
(Prisma's `Restrict` on `BugReport.reporterId` blocks the delete outright once the user has
filed one, anyway.) And because Auth.js re-encodes the JWT with a fresh expiry on every
session read, the session window is *rolling* — revoking upstream does not sign anyone out.

The correct sequence, in this order:

1. **Delete the user's `SpaceMembership` rows.** The only step that takes effect
   immediately, and it works precisely because memberships are read per request rather than
   baked into the token.
2. **Revoke at the IdP.** Stops future sign-ins only.
3. **Leave the `User` row alone.** It carries authorship on `PageVersion` and `BugReport`.

`session.maxAge` is 8 hours, so step 2 becomes effective within a working day rather than
the 30-day default. A durable in-app kill switch — `User.disabledAt`, checked in
`viewerForEmail` and never cleared by the upsert — belongs in Phase 2 alongside `AuditLog`.

## Rejected on evidence: `import "server-only"`

A review recommended adding `import "server-only"` to `src/lib/pages/repo.ts` so an
accidental client-component import fails with a clear error. Checked: the package is not
installed (`ERR_MODULE_NOT_FOUND`), and outside the `react-server` resolution condition it
resolves to a module that throws by design — so adding it breaks the Vitest run, which
imports this file directly. Do not add it in a later task without also solving the test
resolution.

## Migration convention, learned in Task 2

The `bug_report_retention` migration added `updatedAt TIMESTAMP(3) NOT NULL` with no
default. That succeeded only because both databases were empty. Every later phase adds
columns to tables holding real data, where the same SQL fails outright.

So: **a new NOT NULL column on a populated table needs a default, or a three-step
migration** (add nullable, backfill, set NOT NULL). Prisma will warn, and that warning
must be read rather than clicked through. This matters from Phase 2 onward, where
`PageDraft`, `PageRelation`, `System` and the search vector all land on live tables.

## Carried into later phases

Named here so they are not mistaken for oversights:

- **Bug webhook forwarding** (§18.2) — Phase 6, with the job queue.
- **Mermaid rendering** — Phase 4. Phase 1 extracts the blocks into `.mermaid-source`
  nodes; nothing draws them yet.
- **Module grid and due-for-review** on the landing page — Phase 6, which owns
  `reviewedAt` workflows. Phase 1 ships the plain list.
- **`/admin/bugs`** — Phase 6. Reports are stored and readable via `psql` until then.
- **Home page at `/`** listing readable spaces — Phase 2.
- **Cached rendered HTML per published version** (§12) — Phase 2, alongside the publish
  transaction that is the natural invalidation point. Phase 1 renders on each request,
  which is correct but not fast.
- **`AuditLog` and `needsAccessAudit` wiring** — the function and its tests exist in
  Phase 1; the table and the call site land in Phase 2 with the audit model. State this
  as an **accepted risk, not an oversight**: for the whole of Phase 1, super-admin reads
  of `MEMBERS` spaces go unaudited, and the reader is the only surface Phase 1 ships, so
  that is precisely the window in which such reads will happen. A `TODO(phase-2)` marks
  the wiring point in `src/lib/pages/repo.ts` so it is discoverable from the code.
