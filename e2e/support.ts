/**
 * Shared machinery for the Playwright specs.
 *
 * **This module talks to the DEVELOPMENT database, deliberately.** The Playwright suite drives
 * a real `next start` against `.env`, so a fixture written through Prisma here and a page read
 * through HTTP there have to be the same row — which rules out the `_test` database the vitest
 * harness truncates. The guard below is therefore the *inverse* of `tests/setup/reset.ts`'s: it
 * refuses to run against a `_test` database, because that would mean the fixtures and the
 * server are looking at two different places and every assertion here becomes meaningless.
 *
 * Because the target is the developer's own database, every row this suite writes has to be
 * taken back out again. `sweep()` is that, and `snapshotCounts()` is what proves it: the
 * authoring spec records the counts before it starts and asserts the same counts afterwards,
 * so a leak fails the run rather than accumulating quietly. Two things made that necessary
 * rather than tidy — the seed is idempotent, so it will not clean up after us, and a run that
 * leaves a page at `e2e-…` makes the *next* run's `createPage` fail on an occupied path.
 */
import { config } from "dotenv";
import { expect, type Browser, type Page } from "@playwright/test";
import type { DocStatus, DocType } from "@prisma/client";
import { db } from "@/lib/db";
import { viewerForEmail } from "@/lib/users/viewer";
import { createPage } from "@/lib/pages/create";
import { saveDraft } from "@/lib/drafts/repo";
import { publishPage } from "@/lib/pages/publish";

export { db };

// Belt and braces. Importing the Prisma client already loads `.env` into `process.env` — a
// documented Phase 1 finding — and static imports are hoisted above this line, so by the time
// it runs the value is usually already there. It is called anyway so the guard below is never
// reading an environment nothing in this file asked for.
config({ path: ".env", quiet: true });

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!databaseUrl) {
  throw new Error("DATABASE_URL is unset after loading .env. Run ./scripts/setup-db.sh.");
}
if (new URL(databaseUrl).pathname.endsWith("_test")) {
  throw new Error(
    `Refusing to run the E2E suite against ${databaseUrl}: that is the vitest database, ` +
      "which the integration harness truncates. The suite's server reads .env, so its " +
      "fixtures must be written to the same database the server serves.",
  );
}

/**
 * The marker every page this suite creates carries, in its **slug**.
 *
 * The slug and not the path: the move test renames a page and reparents it, and a path-based
 * marker would stop matching the row it was supposed to identify at exactly the moment that
 * row most needs cleaning up. Every fixture slug in this suite starts with this, including the
 * ones a move produces.
 */
export const E2E_SLUG_PREFIX = "e2e-";

/**
 * A 300-character unbreakable token — the shape that has widened this application's layout six
 * times (paragraphs, images, the mermaid placeholder, `.body` headings, the page title, and
 * Task 9's banner), and the length Phase 2 measured a 4,660-pixel reader overflow from.
 *
 * Here rather than in each spec, because it had grown a copy in `reader.spec.ts` and another in
 * `authoring.spec.ts` and Phase 3 needs a third — and 300 is not an arbitrary number: it is
 * exactly `TITLE_MAX_LENGTH`, which is what lets the lifecycle spec put it in a real `Page.title`
 * and drive the banner and the index with a row rather than with a DOM edit.
 */
export const HOSTILE = "x".repeat(300);

/**
 * When this worker started. Redirect and audit rows are swept by age as well as by page,
 * because a move writes a `Redirect` and every mutation writes an `AuditLog` — and audit rows
 * deliberately have no foreign key, so deleting the page they describe leaves them behind.
 * Anything older than this belongs to the developer and is left alone.
 */
const RUN_START = new Date();

export type Counts = {
  spaces: number;
  pages: number;
  versions: number;
  drafts: number;
  audit: number;
  redirects: number;
  relations: number;
  softDeleted: number;
};

export async function snapshotCounts(): Promise<Counts> {
  return {
    spaces: await db.space.count(),
    pages: await db.page.count(),
    versions: await db.pageVersion.count(),
    drafts: await db.pageDraft.count(),
    audit: await db.auditLog.count(),
    redirects: await db.redirect.count(),
    // Phase 3. A relation row has no `e2e-` marker of its own — it is two page ids — so this
    // count is how a leak announces itself: `PageRelation` cascades from both ends, so a
    // non-zero difference here means a fixture page survived the sweep.
    relations: await db.pageRelation.count(),
    softDeleted: await db.page.count({ where: { deletedAt: { not: null } } }),
  };
}

export function formatCounts(counts: Counts): string {
  return (
    `${counts.spaces} spaces / ${counts.pages} pages / ${counts.versions} versions / ` +
    `${counts.drafts} drafts / ${counts.audit} audit / ${counts.redirects} redirects / ` +
    `${counts.relations} relations / ${counts.softDeleted} soft-deleted`
  );
}

/**
 * Removes everything this suite creates, and is safe to call when there is nothing to remove.
 *
 * Ordering is load-bearing in two places:
 *
 * - `publishedVersionId` is nulled **before** the pages go, because it is a foreign key from
 *   `Page` to a `PageVersion` that the page's own delete cascades away. Leaving Postgres to
 *   resolve a cascade against a column pointing into the set being cascaded is not a bet worth
 *   taking when one `updateMany` settles it.
 * - `AuditLog` is swept by page id **before** the pages are deleted, because that is the last
 *   moment those ids can be read. The row has no foreign key on purpose — an audit must
 *   outlive what it describes — so nothing cascades and the ids are the only handle.
 *
 * It runs `beforeEach` as well as `afterAll`: a fixture left behind by a crashed run would
 * otherwise make the next run's `createPage` fail with `path-occupied`, which reads as a
 * product bug and is not one.
 */
export async function sweep(): Promise<void> {
  const where = { slug: { startsWith: E2E_SLUG_PREFIX } };

  await db.page.updateMany({ where, data: { publishedVersionId: null } });
  const ids = (await db.page.findMany({ where, select: { id: true } })).map((row) => row.id);

  await db.auditLog.deleteMany({
    where: { OR: [{ pageId: { in: ids } }, { createdAt: { gte: RUN_START } }] },
  });
  await db.redirect.deleteMany({
    where: {
      OR: [
        { toPageId: { in: ids } },
        { fromPath: { startsWith: E2E_SLUG_PREFIX } },
        { createdAt: { gte: RUN_START } },
      ],
    },
  });
  // Cascades to this page's versions, its draft, its children and any redirect aimed at it.
  await db.page.deleteMany({ where: { id: { in: ids } } });
}

/** The seeded space every authoring fixture is created in. */
export async function engineeringId(): Promise<string> {
  const space = await db.space.findUniqueOrThrow({
    where: { key: "engineering" },
    select: { id: true },
  });
  return space.id;
}

export async function viewerFor(email: string) {
  const viewer = await viewerForEmail(email);
  if (!viewer) throw new Error(`No seeded user ${email}. Run npm run db:seed.`);
  return viewer;
}

/**
 * Signs in through the passwordless provider `webServer.env` enables. Shared by both specs
 * rather than copied into each.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/api/auth/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /test login/i }).click();
  await expect(page).not.toHaveURL(/signin/);
}

/**
 * A second identity, with its own cookie jar.
 *
 * This is the answer to the two-editor problem Task 7 could not solve with its tooling. Task
 * 7's note — "two browser profiles are not available; two tabs share a cookie jar" — is true
 * of the browser-automation tooling used for that manual check and **not** of Playwright:
 * `browser.newContext()` is an isolated storage partition in the same browser process, so two
 * contexts hold two different `authjs.session-token` cookies and the server sees two different
 * people. No second browser, no second profile directory and no scripted actor needed.
 */
export async function actorContext(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { context, page };
}

export type Fixture = { id: string; path: string; title: string };

/**
 * A published page in `engineering`, built through the product's own three steps.
 *
 * `createPage` → `saveDraft` → `publishPage` rather than a hand-rolled `db.page.create`,
 * because the rows those three write are the rows the reader then has to cope with — a
 * `PageVersion` with a real author, a `publishedVersionId` *and* a `publishedAt`, and a draft
 * that publish removes. A fixture assembled by hand would be testing the fixture.
 *
 * The draft `createPage` leaves behind carries `markdown: ""`, and `publishPage` refuses an
 * empty draft, so the `saveDraft` in the middle is required rather than convenient.
 */
export async function seedPublishedPage(opts: {
  slug: string;
  title: string;
  markdown: string;
  parentId?: string | null;
  /** Defaults to `DOC`, which is every Phase 2 fixture. Phase 3 needs ADRs and RFCs. */
  docType?: DocType;
  /**
   * The status to publish into, when the fixture needs one its frontmatter does not ask for.
   *
   * `publishPage`'s own `options.status`, which its docstring reserves for exactly this: "a
   * test, the seed and the e2e helper". It outranks the document's `status:` line, so a fixture
   * passes one **or** writes the line, never both — the lifecycle spec drives the line through
   * the editor's picker where the point is the picker, and passes this where the point is the
   * page it is setting up.
   */
  status?: DocStatus;
}): Promise<Fixture> {
  if (!opts.slug.startsWith(E2E_SLUG_PREFIX)) {
    throw new Error(`Fixture slug "${opts.slug}" must start with "${E2E_SLUG_PREFIX}".`);
  }
  const viewer = await viewerFor("aisyah@example.com");

  const created = await createPage(viewer, {
    spaceId: await engineeringId(),
    parentId: opts.parentId ?? null,
    slug: opts.slug,
    title: opts.title,
    docType: opts.docType ?? "DOC",
  });
  if (!created.ok) throw new Error(`createPage: ${JSON.stringify(created)}`);

  // `seen` is a `Date`, not an ISO string — that is the repository's contract, and the HTTP
  // layer is what serialises it.
  const draft = await db.pageDraft.findUniqueOrThrow({
    where: { pageId: created.page.id },
    select: { updatedAt: true },
  });
  const saved = await saveDraft(viewer, created.page.id, {
    title: opts.title,
    markdown: opts.markdown,
    seen: draft.updatedAt,
  });
  if (!saved.ok) throw new Error(`saveDraft: ${JSON.stringify(saved)}`);

  const published = await publishPage(
    viewer,
    created.page.id,
    opts.status ? { status: opts.status } : {},
  );
  if (!published.ok) throw new Error(`publishPage: ${JSON.stringify(published)}`);

  return { id: created.page.id, path: published.page.path, title: opts.title };
}

/**
 * The horizontal-overflow measurement, in one place because three tests make it.
 *
 * `clientWidth` is returned alongside the overflow and asserted non-zero by every caller. A
 * viewport that reports zero width makes the subtraction come out at zero too, which reads as
 * a pass — Task 7 lost time to exactly that against a backgrounded tab. Playwright fronts each
 * page it drives, so this is a tripwire rather than a live hazard, and it costs one number.
 */
export async function measureOverflow(page: Page): Promise<{ overflow: number; width: number }> {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    width: document.documentElement.clientWidth,
  }));
}
