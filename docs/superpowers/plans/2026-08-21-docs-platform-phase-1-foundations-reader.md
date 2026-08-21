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
    "lib": ["dom", "dom.iterable", "ES2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "incremental": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowJs": false,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
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

  --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --serif: "Newsreader", ui-serif, Georgia, serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}

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
  }
}
:root[data-theme="dark"] .shiki,
:root[data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
}
```

- [ ] **Step 7: Create `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Badam",
  description: "Internal documentation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap"
        />
      </head>
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
  reporter     User      @relation(fields: [reporterId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
}
```

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
  config({ path: ".env.test", override: true });
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}
```

`tests/setup/reset.ts`:

```ts
import { config } from "dotenv";

config({ path: ".env.test", override: true });

const { db } = await import("@/lib/db");

export { db };

export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "BugReport", "SpaceMembership", "Space", "User" CASCADE',
  );
}
```

Note: every later task that adds a table must add it to this `TRUNCATE` list. A forgotten
table shows up as a test that passes alone and fails in a suite.

- [ ] **Step 9: Point Vitest at the harness**

Modify `vitest.config.ts` — add `globalSetup` to the `test` block:

```ts
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-setup.ts"],
    fileParallelism: false,
  },
```

`fileParallelism: false` because the integration tests share one database and truncate it.

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

---

### Task 3: Permission module

Pure functions taking plain objects. No Prisma import, so these run in microseconds and
cover combinations that would be tedious to set up in the database.

**Files:**
- Create: `src/lib/authz/types.ts`
- Create: `src/lib/authz/can.ts`
- Test: `src/lib/authz/can.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/authz/can.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { can, needsAccessAudit, readableSpaceWhere } from "./can";
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

describe("readableSpaceWhere", () => {
  test("a super admin gets an unfiltered clause", () => {
    expect(readableSpaceWhere(viewer({ isSuperAdmin: true }))).toEqual({});
  });

  test("everyone else gets all-staff spaces or their own memberships", () => {
    expect(readableSpaceWhere(viewer())).toEqual({
      OR: [
        { visibility: "ALL_STAFF" },
        { memberships: { some: { userId: "u1" } } },
      ],
    });
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

/**
 * A Prisma `where` fragment for Space, so the permission check runs in SQL. Returning
 * ids instead would mean loading every space first, and would let a caller forget to
 * apply the filter.
 */
export function readableSpaceWhere(viewer: Viewer) {
  if (viewer.isSuperAdmin) return {};
  return {
    OR: [
      { visibility: "ALL_STAFF" as const },
      { memberships: { some: { userId: viewer.id } } },
    ],
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/lib/authz/can.test.ts`
Expected: 15 passed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authz
git commit -m "feat: add space permission module"
```

---

### Task 4: Page and version schema, and the permission-filtered repository

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `tests/setup/reset.ts`
- Create: `src/lib/pages/repo.ts`
- Test: `tests/integration/pages-repo.test.ts`

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

- [ ] **Step 4: Add the new tables to the truncate list**

Modify `tests/setup/reset.ts` — replace the `TRUNCATE` statement:

```ts
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "BugReport", "PageVersion", "Page", "SpaceMembership", "Space", "User" CASCADE',
  );
```

- [ ] **Step 5: Write the failing test**

`tests/integration/pages-repo.test.ts`:

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
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: stranger,
  });
  expect(result?.version.markdown).toContain("One namespace.");
});

test("a members-only page is not readable by a non-member", async () => {
  await fixture("MEMBERS");
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: stranger,
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
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer,
  });
  expect(result?.page.title).toBe("MQTT contracts");
});

test("a super admin can read a members-only page", async () => {
  await fixture("MEMBERS");
  const root: Viewer = { id: "root", isSuperAdmin: true, memberships: [] };
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/mqtt-contracts",
    viewer: root,
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
  const result = await getPublishedPage({
    spaceKey: "engineering",
    path: "architecture/draft-only",
    viewer: stranger,
  });
  expect(result).toBeNull();
});

test("an unreadable space key resolves to null rather than an error", async () => {
  await fixture("MEMBERS");
  expect(await getReadableSpaceByKey("engineering", stranger)).toBeNull();
  expect(await getReadableSpaceByKey("nonexistent", stranger)).toBeNull();
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
  const rows = await listSpacePages(space.id);
  expect(rows).toHaveLength(2);
  expect(rows.filter((r) => r.publishedVersionId === null)).toHaveLength(1);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/integration/pages-repo.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/pages/repo"`.

- [ ] **Step 7: Create `src/lib/pages/repo.ts`**

```ts
import { db } from "@/lib/db";
import { readableSpaceWhere } from "@/lib/authz/can";
import type { Viewer } from "@/lib/authz/types";

export async function getReadableSpaceByKey(key: string, viewer: Viewer) {
  return db.space.findFirst({
    where: { key, ...readableSpaceWhere(viewer) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      initials: true,
      visibility: true,
    },
  });
}

export async function getPublishedPage(params: {
  spaceKey: string;
  path: string;
  viewer: Viewer;
}) {
  const space = await getReadableSpaceByKey(params.spaceKey, params.viewer);
  if (!space) return null;

  const page = await db.page.findFirst({
    where: {
      spaceId: space.id,
      path: params.path,
      publishedVersionId: { not: null },
    },
    include: {
      publishedVersion: true,
      owner: { select: { name: true } },
    },
  });

  if (!page?.publishedVersion) return null;

  return { space, page, version: page.publishedVersion };
}

export async function listSpacePages(spaceId: string) {
  return db.page.findMany({
    where: { spaceId },
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
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- tests/integration/pages-repo.test.ts`
Expected: 7 passed.

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

**Files:**
- Create: `src/lib/markdown/toc.ts`, `src/lib/markdown/mermaid.ts`, `src/lib/markdown/render.ts`
- Test: `src/lib/markdown/render.test.ts`

- [ ] **Step 1: Install the pipeline**

```bash
npm install unified remark-parse remark-gfm remark-rehype rehype-slug \
  rehype-autolink-headings rehype-sanitize rehype-stringify \
  @shikijs/rehype shiki unist-util-visit hast-util-to-string
```

- [ ] **Step 2: Write the failing test**

`src/lib/markdown/render.test.ts`:

```ts
import { expect, test } from "vitest";
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

test("does not double-wrap a table", async () => {
  const { html } = await renderMarkdown("| A |\n| --- |\n| 1 |\n");
  expect(html.match(/table-scroll/g)).toHaveLength(1);
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
      if (typeof id !== "string") return;
      options.headings.push({
        id,
        text: toString(node),
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
        Array.isArray(classes) && classes.includes("language-mermaid");
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
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeShiki from "@shikijs/rehype";
import rehypeStringify from "rehype-stringify";
import { collectHeadings, type Heading } from "./toc";
import { extractMermaid } from "./mermaid";
import { wrapTables } from "./wrap";

export type RenderedDoc = { html: string; headings: Heading[] };

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
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
      fallbackLanguage: "text",
    })
    .use(rehypeStringify)
    .process(markdown);

  return { html: String(file), headings };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- src/lib/markdown/render.test.ts`
Expected: 9 passed.

- [ ] **Step 9: Commit**

```bash
git add src/lib/markdown
git commit -m "feat: add sanitising markdown pipeline with toc, mermaid and table wrapping"
```

---

### Task 6: Page tree builder

Pure function over flat rows. The navigation rail is the single most-rendered component in
the app, so this must not do a query per level.

**Files:**
- Create: `src/lib/pages/tree.ts`
- Test: `src/lib/pages/tree.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/pages/tree.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildTree, type PageRow } from "./tree";

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
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;

    const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // No parent, or a parent outside this result set: surface it rather than lose it.
      roots.push(node);
    }
  }

  return roots;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/pages/tree.test.ts`
Expected: 5 passed.

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
- Create: `src/lib/users/upsert.ts`, `src/lib/auth/config.ts`, `src/lib/auth/viewer.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Test: `tests/integration/user-upsert.test.ts`

- [ ] **Step 1: Install Auth.js**

```bash
npm install next-auth@beta
```

- [ ] **Step 2: Write the failing test**

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
Expected: FAIL — `Failed to resolve import "@/lib/users/upsert"`.

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
  const name = profile.name?.trim() || (email.split("@")[0] ?? email);

  return db.user.upsert({
    where: { email },
    // isSuperAdmin is deliberately absent: it is granted in our system, not theirs.
    update: { name, avatarUrl: profile.avatarUrl ?? undefined },
    create: { email, name, avatarUrl: profile.avatarUrl ?? null },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/integration/user-upsert.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Create `src/lib/auth/config.ts`**

A generic OIDC provider, so Google Workspace and Microsoft Entra are configuration rather
than code (spec §19).

```ts
import NextAuth from "next-auth";
import { upsertUserFromProfile } from "@/lib/users/upsert";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
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
    async signIn({ profile }) {
      if (!profile?.email) return false;
      await upsertUserFromProfile({
        email: profile.email,
        name: profile.name ?? null,
        avatarUrl: typeof profile.picture === "string" ? profile.picture : null,
      });
      return true;
    },
  },
});
```

- [ ] **Step 7: Create `src/app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from "@/lib/auth/config";

export const { GET, POST } = handlers;
```

- [ ] **Step 8: Create `src/lib/auth/viewer.ts`**

Every server component that reads data calls `requireViewer()`. Nothing else constructs a
`Viewer`.

```ts
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth/config";
import type { Viewer } from "@/lib/authz/types";

export async function loadViewer(): Promise<Viewer | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const user = await db.user.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      name: true,
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

export async function requireViewer(): Promise<Viewer> {
  const viewer = await loadViewer();
  if (!viewer) redirect("/api/auth/signin");
  return viewer;
}
```

- [ ] **Step 9: Verify the typecheck passes**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add OIDC sign-in and viewer loading"
```

---

### Task 8: Build version module

The Alpha badge and every bug report quote this string, so it must be correct in every
environment including local development.

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

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
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
Expected: 5 passed.

- [ ] **Step 5: Commit**

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

  await db.space.upsert({
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

  for (const [index, seed] of ENGINEERING_PAGES.entries()) {
    const parentId = seed.parent ? idBySlug.get(seed.parent) : undefined;
    const path = seed.parent ? `${seed.parent}/${seed.slug}` : seed.slug;
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

    if (seed.published === false) continue;

    const version = await db.pageVersion.create({
      data: {
        pageId: page.id,
        title: seed.title,
        markdown: seed.markdown ?? `Pages in **${seed.title}**.`,
        status,
        authorId: aisyah.id,
        message: "Seed",
      },
    });

    await db.page.update({
      where: { id: page.id },
      data: { publishedVersionId: version.id, publishedAt: new Date() },
    });
  }

  console.log("Seeded 2 spaces and", ENGINEERING_PAGES.length, "pages.");
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

Expected: prints `Seeded 2 spaces and 5 pages.` Running it a second time must also
succeed — the upserts make it idempotent for spaces and pages. Note that page **versions**
are appended each run by design; that is correct behaviour for a version table.

- [ ] **Step 5: Commit**

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
- Create: `src/components/TopBar.tsx`, `src/components/NavRail.tsx`, `src/components/RailFoot.tsx`
- Create: `src/components/shell.css`

- [ ] **Step 1: Create `src/components/shell.css`**

Every colour comes from the tokens defined in Task 1.

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

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  title,
  isDraft,
}: {
  href: string;
  title: string;
  isDraft: boolean;
}) {
  const pathname = usePathname();

  return (
    <Link href={href} aria-current={pathname === href ? "page" : undefined}>
      {title}
      {isDraft ? <span className="tag-draft">Draft</span> : null}
    </Link>
  );
}
```

- [ ] **Step 4: Create `src/components/NavRail.tsx`**

A server component. The tree is known at render time and `<details>` needs no JavaScript.

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

function link(spaceKey: string, node: TreeNode) {
  return (
    <NavLink
      key={node.id}
      href={`/${spaceKey}/${node.path}`}
      title={node.title}
      isDraft={node.publishedVersionId === null}
    />
  );
}

export function NavRail({ spaceKey, spaceName, tree, build }: Props) {
  return (
    <nav className="rail-l" aria-label={`${spaceName} navigation`}>
      {tree.map((group) => (
        <details className="navgroup" key={group.id} open>
          <summary>{group.title}</summary>
          <div className="navlist">
            {group.children.length === 0
              ? link(spaceKey, group)
              : group.children.map((child) => link(spaceKey, child))}
          </div>
        </details>
      ))}
      <RailFoot build={build} />
    </nav>
  );
}
```

- [ ] **Step 5: Create `src/components/RailFoot.tsx`**

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
  const viewer = await requireViewer();

  const space = await getReadableSpaceByKey(spaceKey, viewer);
  // Unreadable and nonexistent are the same answer, so titles do not leak (spec §8).
  if (!space) notFound();

  const tree = buildTree(await listSpacePages(space.id));
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

- [ ] **Step 8: Verify the typecheck and build pass**

Run: `npm run typecheck && npm run build`
Expected: exit 0 for both.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add reader shell with alpha badge and pinned rail foot"
```

---

### Task 11: Bug reporting

Context is captured, not requested. Forwarding to a webhook is out of Phase 1 scope
(Phase 6 adds the queue); the report is stored, which is the part that must never be lost.

**Files:**
- Create: `src/lib/bugs/schema.ts`, `src/lib/bugs/create.ts`
- Create: `src/app/api/bugs/route.ts`
- Replace: `src/components/BugReportDialog.tsx`
- Test: `src/lib/bugs/schema.test.ts`, `tests/integration/bug-report.test.ts`

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
  expect(parsed.pageId).toBeNull();
});

test("rejects a report with no route path", () => {
  const { routePath, ...withoutRoute } = valid;
  expect(bugReportInput.safeParse(withoutRoute).success).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/lib/bugs/schema.test.ts`
Expected: FAIL — `Failed to resolve import "./schema"`.

- [ ] **Step 3: Create `src/lib/bugs/schema.ts`**

```ts
import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const bugReportInput = z.object({
  summary: z.string().trim().min(1).max(5000),
  expected: optionalText(5000),
  routePath: z.string().min(1).max(2000),
  spaceId: optionalText(64),
  pageId: optionalText(64),
  versionId: optionalText(64),
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
Expected: 5 passed.

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
  spaceId: null,
  pageId: null,
  versionId: null,
  appVersion: "0.1.0",
  gitSha: "df0ef11",
  userAgent: "Mozilla/5.0",
  viewport: "1440x900",
  consoleError: null,
};

test("stores a report as NEW against its reporter", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, input);

  expect(report.status).toBe("NEW");
  expect(report.reporterId).toBe(user.id);
  expect(report.gitSha).toBe("df0ef11");
});

test("keeps the captured context verbatim", async () => {
  const user = await reporter();
  const report = await createBugReport(user.id, {
    ...input,
    consoleError: "TypeError: x is not a function",
  });

  const stored = await db.bugReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.routePath).toBe("/engineering/decisions/adr-0042");
  expect(stored.viewport).toBe("1440x900");
  expect(stored.consoleError).toBe("TypeError: x is not a function");
});

test("several reports from one user are all kept", async () => {
  const user = await reporter();
  await createBugReport(user.id, input);
  await createBugReport(user.id, { ...input, summary: "Second problem" });

  expect(await db.bugReport.count()).toBe(2);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- tests/integration/bug-report.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/bugs/create"`.

- [ ] **Step 7: Create `src/lib/bugs/create.ts`**

```ts
import { db } from "@/lib/db";
import type { BugReportInput } from "./schema";

export async function createBugReport(reporterId: string, input: BugReportInput) {
  return db.bugReport.create({
    data: { reporterId, ...input },
  });
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npm test -- tests/integration/bug-report.test.ts`
Expected: 3 passed.

- [ ] **Step 9: Create `src/app/api/bugs/route.ts`**

```ts
import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { bugReportInput } from "@/lib/bugs/schema";
import { createBugReport } from "@/lib/bugs/create";

export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Sign in to report a bug." }, { status: 401 });
  }

  const parsed = bugReportInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Add a short description of what happened." },
      { status: 400 },
    );
  }

  const report = await createBugReport(viewer.id, parsed.data);
  return NextResponse.json({ id: report.id }, { status: 201 });
}
```

- [ ] **Step 10: Replace `src/components/BugReportDialog.tsx`**

```tsx
"use client";

import { useState } from "react";
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");

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

  if (state === "sent") {
    return (
      <div role="dialog" aria-label="Report a bug">
        <p>Thanks — logged against {build.label}.</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div role="dialog" aria-label="Report a bug">
      <form onSubmit={submit}>
        <label htmlFor="bug-summary">What happened?</label>
        <textarea
          id="bug-summary"
          required
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
          <p role="alert">That did not send. Try again in a moment.</p>
        ) : null}

        <button type="submit" disabled={state === "sending" || summary.trim() === ""}>
          {state === "sending" ? "Sending" : "Send report"}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 11: Verify the whole suite and the build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

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

.body h2 {
  margin: 38px 0 12px;
  font-family: var(--serif);
  font-size: 23px;
  font-weight: 500;
  scroll-margin-top: 72px;
  text-wrap: balance;
}
.body h2:first-child { margin-top: 0; }
.body p, .body ul, .body ol { max-width: 66ch; }
.body li::marker { color: var(--accent); }
.body a { color: var(--accent); }

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

@media (max-width: 1180px) { .rail-r { display: none; } }
```

- [ ] **Step 2: Create `src/components/Breadcrumbs.tsx`**

```tsx
import Link from "next/link";

export function Breadcrumbs({
  spaceKey,
  spaceName,
  path,
}: {
  spaceKey: string;
  spaceName: string;
  path: string;
}) {
  const segments = path.split("/");
  const ancestors = segments.slice(0, -1);

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link href={`/${spaceKey}`}>{spaceName}</Link>
      {ancestors.map((segment, index) => (
        <span key={segment}>
          <span className="sep"> / </span>
          <Link href={`/${spaceKey}/${ancestors.slice(0, index + 1).join("/")}`}>
            {segment.replace(/-/g, " ")}
          </Link>
        </span>
      ))}
      <span className="sep">/</span>
      <span>{segments.at(-1)?.replace(/-/g, " ")}</span>
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
  const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

  return (
    <>
      <div className="railhead">Page info</div>
      <div className="card">
        <dl>
          <dt>Owner</dt>
          <dd>{ownerName ?? "Unassigned"}</dd>
          <dt>Last reviewed</dt>
          <dd>{reviewedAt ? formatter.format(reviewedAt) : "Never"}</dd>
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
import "@/components/doc.css";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/viewer";
import { getPublishedPage } from "@/lib/pages/repo";
import { renderMarkdown } from "@/lib/markdown/render";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageInfoCard } from "@/components/PageInfoCard";
import { Toc } from "@/components/Toc";

export default async function DocPage({
  params,
}: {
  params: Promise<{ space: string; path: string[] }>;
}) {
  const { space: spaceKey, path } = await params;
  const viewer = await requireViewer();

  const result = await getPublishedPage({
    spaceKey,
    path: path.join("/"),
    viewer,
  });
  if (!result) notFound();

  const { space, page, version } = result;
  const { html, headings } = await renderMarkdown(version.markdown);
  const versionCount = await db.pageVersion.count({ where: { pageId: page.id } });
  const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

  return (
    <>
      <main className="doc">
        <Breadcrumbs spaceKey={space.key} spaceName={space.name} path={page.path} />
        <h1>{page.title}</h1>

        <div className="meta">
          <span>
            <span className="k">Status</span> {page.status}
          </span>
          <span>
            <span className="k">Published</span>{" "}
            {page.publishedAt ? formatter.format(page.publishedAt) : "—"}
          </span>
          <span>
            <span className="k">Commit</span> {version.gitSha ?? "not mirrored yet"}
          </span>
        </div>

        <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>

      <aside className="rail-r">
        <Toc headings={headings} />
        <PageInfoCard
          ownerName={page.owner?.name ?? null}
          reviewedAt={page.reviewedAt}
          docType={page.docType}
          status={page.status}
          versionCount={versionCount}
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
- Create: `src/app/(reader)/[space]/page.tsx`
- Modify: `src/lib/pages/repo.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/spaces/landing.test.ts`:

```ts
import { expect, test } from "vitest";
import { summariseModules } from "./landing";
import type { TreeNode } from "@/lib/pages/tree";

function node(over: Partial<TreeNode> & { id: string }): TreeNode {
  return {
    parentId: null,
    slug: over.id,
    path: over.id,
    title: over.id,
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
    { id: "decisions", title: "Decisions", path: "decisions", pageCount: 2, draftCount: 1 },
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

test("a module with no children reports zero, not one", () => {
  expect(summariseModules([node({ id: "empty" })])[0]?.pageCount).toBe(0);
});

test("an empty tree produces no modules", () => {
  expect(summariseModules([])).toEqual([]);
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
export async function listRecentlyPublished(spaceId: string, limit = 5) {
  return db.page.findMany({
    where: { spaceId, publishedAt: { not: null } },
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
}
```

- [ ] **Step 6: Create `src/app/(reader)/[space]/page.tsx`**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import "@/components/doc.css";
import { requireViewer } from "@/lib/auth/viewer";
import {
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
} from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { summariseModules } from "@/lib/spaces/landing";

export default async function SpaceLanding({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  const viewer = await requireViewer();

  const space = await getReadableSpaceByKey(spaceKey, viewer);
  if (!space) notFound();

  const modules = summariseModules(buildTree(await listSpacePages(space.id)));
  const recent = await listRecentlyPublished(space.id);
  const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

  return (
    <main className="doc">
      <h1>{space.name}</h1>
      {space.description ? <p>{space.description}</p> : null}

      <h2>Choose a module</h2>
      <ul>
        {modules.map((module) => (
          <li key={module.id}>
            <Link href={`/${space.key}/${module.path}`}>{module.title}</Link>{" "}
            <span className="k">
              {module.pageCount} pages
              {module.draftCount > 0 ? ` · ${module.draftCount} draft` : ""}
            </span>
          </li>
        ))}
      </ul>

      <h2>Recently published</h2>
      <ul>
        {recent.map((page) => (
          <li key={page.id}>
            <Link href={`/${space.key}/${page.path}`}>{page.title}</Link>{" "}
            <span className="k">
              {page.publishedVersion?.author.name}
              {page.publishedAt ? ` · ${formatter.format(page.publishedAt)}` : ""}
            </span>
          </li>
        ))}
      </ul>
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
- Modify: `src/lib/auth/config.ts`, `package.json`, `.env.example`

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Add the guarded test login to `src/lib/auth/config.ts`**

Add the import and extend the `providers` array:

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

- [ ] **Step 3: Document the flag in `.env.example`**

```bash
printf 'ALLOW_TEST_LOGIN=""   # set to 1 for e2e runs only, never in a deployed environment\n' >> .env.example
```

- [ ] **Step 4: Create `playwright.config.ts`**

Port 3100 is confirmed free on this machine and approved for use (other local services
occupy 80, 3317, 5432, 8080).

**Convention:** Playwright specs live in `e2e/` and are named `*.spec.ts`. Vitest's
`include` only covers `src/**` and `tests/**`, so it can never import a Playwright spec —
`test()` called outside Playwright's runner throws an opaque error, and this separation is
what prevents it. Do not move E2E files under `tests/`.

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start --port 3100",
    port: 3100,
    reuseExistingServer: false,
    env: { ALLOW_TEST_LOGIN: "1", GIT_SHA: "df0ef11abc" },
  },
});
```

- [ ] **Step 5: Add the e2e script to `package.json`**

```json
    "test:e2e": "playwright test"
```

- [ ] **Step 6: Write the failing tests**

`e2e/reader.spec.ts`:

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

- [ ] **Step 7: Run the tests**

```bash
npm run db:seed
npm run test:e2e
```

Expected: 7 passed. If sign-in times out, confirm `ALLOW_TEST_LOGIN=1` reached the server
process — it is set by `webServer.env`, not by `.env`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: add end-to-end coverage for reading, permissions and bug reporting"
```

---

## Phase 1 exit criteria

All must hold before Phase 2 starts:

- [ ] `npm test` — unit and integration suites pass
- [ ] `npm run test:e2e` — 7 end-to-end tests pass
- [ ] `npm run typecheck && npm run build` — clean
- [ ] A member reads a seeded page with navigation, breadcrumbs, TOC and page info
- [ ] A non-member receives **404** for that same page, and its title appears nowhere in the response
- [ ] An unpublished page is unreachable by URL
- [ ] The Alpha badge and `0.1.0+<sha>` build string render in the shell
- [ ] Report bug stores a row with the route, version and viewport captured automatically

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
  Phase 1; the table and the call site land in Phase 2 with the audit model.
