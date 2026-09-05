import { Prisma, SystemKind } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { refuseNonAdmin, type AdminRefusal } from "@/lib/admin/gate";
import { auditSpaceAccess, writeAudit } from "@/lib/audit/log";
import { TITLE_MAX_LENGTH } from "@/lib/drafts/schema";
import { stripControl } from "@/lib/text/control";
import { repoLinkOf, type RepoLink, type RepoWithheldReason } from "@/lib/systems/repo-url";
import { validateSystemKey } from "@/lib/systems/key";
import type { Viewer } from "@/lib/authz/types";

/**
 * `/admin/systems` — spec §7's *"admins manage the list"*, Phase 7 Task 5.
 *
 * The first `/admin` surface in the product, so three things here are patterns rather than local
 * choices, and Tasks 6, 7 and 8 will copy them: the refusal comes from `src/lib/admin/gate.ts`
 * and is stated nowhere else; `readableSpace` and `visiblePage` are **absent, at the line, with
 * reasons**; and the audited act is a *listing*, never a count.
 *
 * ## The permission predicate is `refuseNonAdmin` and there is no other
 *
 * Every exported function below opens with the same two lines, and `src/lib/admin/gate.test.ts`
 * sweeps for an admin module that forgets them. What is deliberately **not** here:
 *
 * - **No `readableSpace`.** `readableSpaceWhere` answers `{}` for a super admin, so nesting it on
 *   `listBlockingPages`'s query would be a predicate that cannot fail — `src/lib/git/failures.ts`
 *   wrote this down for `/-/mirror` (now `/admin/git`), and `resolveRedirect` is the project's
 *   measured case of a
 *   filter nobody can delete a test with. It would also be **wrong**, not merely inert: the job of
 *   that listing is to name the pages that block a delete, and a page in a space the admin is not
 *   a member of blocks it exactly as hard as one they can read. A filtered list would disagree
 *   with the count beside it and with the database's own refusal.
 * - **No `visiblePage`.** Same shape, and the sharper of the two. `PageSystem.pageId` is `Cascade`
 *   from `Page` and this product has **no hard delete** — `deletePage` sets `Page.deletedAt` — so
 *   a soft-deleted page keeps its facet rows and keeps blocking the `Restrict`. Hiding it would
 *   produce the one thing this surface exists to prevent: a refusal whose stated cause is a list
 *   the admin has already dealt with. The deletion is reported on the row instead
 *   ({@link BlockingPage.deleted}), exactly as `MirrorFailure.pageDeleted` is.
 *
 * That second point has a consequence the surface has to carry: **the reference count here is not
 * the number `/systems/[key]` shows.** That page excludes soft-deleted and unpublished pages by
 * design; this one counts every `PageSystem` row, because every one of them is a row the foreign
 * key will refuse over.
 *
 * ## The audit line, and it is Task 1's, unchanged
 *
 * Task 1 drew it in the schema: *"Showing the number needs no audit; showing the titles does."* A
 * count across spaces the admin cannot read is one integer with no page identity in it — the same
 * thing `src/lib/systems/read.ts` already decided needs no row when a truncated group contributes
 * to a count. A **title and a path** are the two user-authored strings a search hit carries, which
 * is the observable §8 is about, so `listBlockingPages` calls `auditSpaceAccess` once per space
 * that produced a row and `listSystemsForAdmin` calls it never.
 *
 * `auditSpaceAccess` owns both the decision (`needsAccessAudit`) and the dedupe, so this is a call
 * site and not a second copy of that rule; the default `"request"` scope is right because this is
 * one act of reading by a person, not a browser fetching sub-resources.
 *
 * ## Two validators, one predicate each, and neither is a second copy of the other
 *
 * `validateSystemKey` (`src/lib/systems/key.ts`) is the character class and the length cap, and it
 * borrows `validateSlug`'s rules rather than restating them. `repoLinkOf`
 * (`src/lib/systems/repo-url.ts`) is the credential and scheme decision, and this module **reuses
 * it rather than writing a second URL parser** — Task 3 built it pure explicitly so this task
 * could. Phase 5's lesson is that a two-ended fix leaks if either end is removed; the ends are
 * Task 3's *withhold on render* and this module's *refuse on write*, and each has its own test.
 *
 * The sentences differ between the two ends and the predicate does not, which is the same split
 * `validateSystemKey` makes against `validateSlug`. `REPO_WITHHELD_SENTENCE` explains a URL that
 * is **already stored** and tells an admin to come here and rotate the token;
 * {@link REPO_REFUSED_SENTENCE} explains one that is **being typed** and never reaches the column.
 * Neither of them repeats the URL, in any form.
 */

/**
 * Longest `System.description`.
 *
 * Not derived from anything, because nothing it resembles is measured the same way: this is a
 * catalogue blurb rendered as one paragraph in a list row — not a document (`MAX_DRAFT_BODY_BYTES`
 * bounds those) and not a label (`TITLE_MAX_LENGTH` bounds those, and `name` and `ownerTeam` use
 * it). A thousand characters is a long paragraph: enough for "what this is and who to ask", short
 * enough that the row stays a row. Unlike `MAX_PATH_BYTES` there is no index limit underneath it
 * to measure against, and the honest statement of its job is that it bounds a column with no other
 * bound.
 */
export const SYSTEM_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Longest `System.repoUrl`.
 *
 * A cap on a URL rather than on prose, chosen against what a real remote looks like: the deepest
 * GitLab group path in the checkouts on this machine is under 120 characters, and the longest
 * thing anyone legitimately pastes here is a repository address. It exists because the column is
 * otherwise unbounded and this value is painted, unbroken, into a flex row — Task 3's ninth
 * overflow shape was on this very surface, from a 300-character string in a box that could not
 * shrink.
 */
export const SYSTEM_REPO_URL_MAX_LENGTH = 500;

/** Which input a message is about. The form renders each one against its own field. */
export type SystemField = "key" | "name" | "kind" | "ownerTeam" | "description" | "repoUrl";

export type SystemFieldError = {
  field: SystemField;
  code: string;
  message: string;
};

/**
 * What this surface says instead of accepting a repository URL, one sentence per reason.
 *
 * Here and not in `repo-url.ts` beside `REPO_WITHHELD_SENTENCE`, because the two answer different
 * questions for different people: that one is read by anybody on `/systems`, about a value already
 * in the database, and this one is read by the admin who is typing. The **decision** is shared —
 * one `repoLinkOf` call — and only the wording is per-surface, which is the same split
 * `validateSystemKey` makes when it remaps `validateSlug`'s messages.
 *
 * The credential sentence deliberately does not repeat the URL, not even its host. It is the one
 * string on this form most likely to be a live token, and an error message is rendered, logged
 * and screenshotted.
 */
export const REPO_REFUSED_SENTENCE: Record<RepoWithheldReason, string> = {
  credentials:
    "That repository URL embeds a username or password, so it was not stored. Paste the plain " +
    "https address with nothing before the @ — and rotate the token, because it has been in " +
    "your clipboard and is probably in your shell history.",
  scheme:
    "A repository URL must be an http or https address, because it is rendered as a link for " +
    'every reader. An ssh remote ("git@host:group/repo.git") has no browsable form here; use ' +
    "the web URL for the same repository.",
  unparseable: "That is not a URL. It needs a scheme, as in https://example.com/group/repo.git.",
};

/** A new system, as the create form submits it. Empty strings mean "no value". */
export type SystemInput = {
  key: string;
  name: string;
  kind: SystemKind;
  ownerTeam: string;
  description: string;
  repoUrl: string;
};

/**
 * An edit, and it is a **patch**: an absent key is one this request is not changing.
 *
 * Not a full replacement, and the deciding field is `repoUrl`. A replacement form has to prefill
 * every input, which would mean sending the stored `repoUrl` to the browser — and the whole of
 * Task 3's half of the credential fix is that a URL carrying userinfo is *not printed*, not even
 * to a super admin, because printing it is what puts it in a rendered page, a screenshot and a
 * browser history. A form that prefilled it would undo the render-side end of the two-ended fix on
 * the one page whose job is to repair it.
 *
 * The second thing it buys is the offer beside a refused delete: setting `isActive = false` is one
 * field, and a replacement would make that one click resubmit five values it never read.
 */
export type SystemPatch = {
  key?: string;
  name?: string;
  kind?: SystemKind;
  ownerTeam?: string;
  description?: string;
  repoUrl?: string;
  isActive?: boolean;
};

/** One catalogue row as an admin sees it: §7's metadata, plus what stands in a delete's way. */
export type AdminSystemRow = {
  id: string;
  key: string;
  name: string;
  kind: SystemKind;
  ownerTeam: string | null;
  description: string | null;
  isActive: boolean;
  /**
   * Never the raw column. `repoLinkOf` decides whether it may be rendered, on this surface too: a
   * value stored by an older build, or by a hand-run `UPDATE`, is exactly what the render-side
   * half of the two-ended fix is for, and an admin page is not exempt from it.
   */
  repo: RepoLink;
  /**
   * `PageSystem` rows naming this system — **every one of them**, soft-deleted and unpublished
   * pages included, because every one is a row `onDelete: Restrict` will refuse over.
   *
   * This is the number that makes Task 1's decision operable: a delete that will be refused is
   * *predicted* here rather than discovered at the button. It is deliberately not the number
   * `/systems/[key]` renders, which is smaller — see the module docstring.
   */
  references: number;
};

export type AdminSystemsResult = { ok: true; systems: AdminSystemRow[] } | AdminRefusal;

/**
 * The whole catalogue, in key order — the same order `listSystems` uses and for the same reason:
 * `key` is the identity, unique and folded by Task 1's CHECK, and `name` is explicitly not unique.
 *
 * **No audit row.** This reads `System` and a `_count` over `PageSystem`; it names no page, no
 * path and no space, so there is nothing here §8 is about. Task 1's line, applied.
 */
export async function listSystemsForAdmin(viewer: Viewer): Promise<AdminSystemsResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const rows = await db.system.findMany({
    orderBy: { key: "asc" },
    // Explicit select, never `include`. The `_count` is served by `@@index([systemId, pageId])`,
    // which Task 1 added covering for exactly this question — the table has two columns, so the
    // count is answered from the index with no heap access.
    select: {
      id: true,
      key: true,
      name: true,
      kind: true,
      ownerTeam: true,
      description: true,
      isActive: true,
      repoUrl: true,
      _count: { select: { pages: true } },
    },
  });

  return {
    ok: true,
    systems: rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      ownerTeam: row.ownerTeam,
      description: row.description,
      isActive: row.isActive,
      repo: repoLinkOf(row.repoUrl),
      references: row._count.pages,
    })),
  };
}

/** One page standing in the way of a delete. Enough to find it, and nothing else. */
export type BlockingPage = {
  pageId: string;
  spaceKey: string;
  spaceName: string;
  path: string;
  title: string;
  /**
   * The page is soft-deleted. It still holds a `PageSystem` row and still blocks the delete, so
   * hiding it would make this list disagree with both the count and the database — see the module
   * docstring. Reported instead, because an admin who cannot see it reads a blocked delete with
   * nothing visible blocking it as a bug in the product.
   */
  deleted: boolean;
};

export type BlockingPagesResult =
  | { ok: true; key: string; pages: BlockingPage[]; truncated: boolean }
  | AdminRefusal;

/**
 * The most pages one refusal names. A rendering bound like `MAX_MIRROR_FAILURES`: a system with
 * more than this many documents is not one an admin is about to delete by hand, and the surface
 * says the list is short rather than pretending it is whole.
 */
export const MAX_BLOCKING_PAGES = 200;

/**
 * The pages that block deleting a system — **the audited half of Task 1's line.**
 *
 * Its own entry point rather than columns on `listSystemsForAdmin`, and that is the whole design:
 * the count ships with every row and costs nothing, while the titles are fetched only when an
 * admin asks for them and write an audit row when they do. Folding these columns into the list
 * would audit a page view of the catalogue as though it were a read of every space in the
 * installation, which is how an audit table stops being read.
 *
 * `readableSpace` and `visiblePage` are both absent, deliberately and for different reasons — see
 * the module docstring. Both absences change what this returns, so neither is a convenience.
 */
export async function listBlockingPages(
  viewer: Viewer,
  systemId: string,
): Promise<BlockingPagesResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const system = await db.system.findUnique({
    where: { id: systemId },
    select: { key: true },
  });
  // The same answer as "you may not look", byte for byte — one shape for a miss and for a refusal.
  if (system === null) return { ok: false, reason: "not-found" };

  const rows = await db.pageSystem.findMany({
    where: { systemId },
    // One more than the cap, so truncation is known without a second count — `search()`'s shape.
    take: MAX_BLOCKING_PAGES + 1,
    /*
     * By space, then path, then page id: the ordering `getSystemDocumentation` argues for, because
     * a reader placing rows from several spaces at once needs them grouped, and `pageId` breaks
     * the final tie so the cut cannot shuffle between two requests.
     */
    orderBy: [{ page: { space: { key: "asc" } } }, { page: { path: "asc" } }, { pageId: "asc" }],
    // Explicit select, never `include`. The page is reached through the relation for its columns
    // only; `PageSystem.pageId` is `NOT NULL` with a foreign key, so this cannot drop a row and
    // cannot become a second copy of a filter — the trap Phase 4 Task 3 measured.
    select: {
      pageId: true,
      page: {
        select: {
          path: true,
          title: true,
          deletedAt: true,
          space: { select: { id: true, key: true, name: true, visibility: true } },
        },
      },
    },
  });

  const truncated = rows.length > MAX_BLOCKING_PAGES;
  const kept = rows.slice(0, MAX_BLOCKING_PAGES);

  // Spec §8's super-admin trace. This is the cross-boundary read Task 1 named: a title and a path
  // out of a space the admin may not belong to. One row per space that produced a listed row, as
  // `search` and `getSystemDocumentation` both decided it — `auditSpaceAccess` owns whether it is
  // auditable at all, and cannot throw.
  const readFrom = new Map(
    kept.map((row) => [
      row.page.space.id,
      { id: row.page.space.id, key: row.page.space.key, visibility: row.page.space.visibility },
    ]),
  );
  for (const space of readFrom.values()) await auditSpaceAccess(viewer, space);

  return {
    ok: true,
    key: system.key,
    pages: kept.map((row) => ({
      pageId: row.pageId,
      spaceKey: row.page.space.key,
      spaceName: row.page.space.name,
      path: row.page.path,
      title: row.page.title,
      deleted: row.page.deletedAt !== null,
    })),
    truncated,
  };
}

/** One validated input: the value a column gets, or the sentence a form renders. */
type FieldOutcome<T> = { ok: true; value: T } | { ok: false; error: SystemFieldError };

/**
 * Free text on its way to a column: control characters out.
 *
 * The one silent transform in this module, and it is not optional — Postgres rejects NUL outright
 * (22021), which would turn a paste from a terminal into a 500 no retry can clear. `\p{Cc}` and
 * never `\p{C}`, for the reason `src/lib/text/control.ts` records at length.
 *
 * There is deliberately **no trim**. `validateSystemKey` refuses whitespace in a key outright, and
 * for the free-text columns a leading space is stored as typed rather than corrected, which is
 * `validateSlug`'s standing rule: a value the admin never typed is a value nobody can search for.
 */
function clean(value: string): string {
  return stripControl(value);
}

function keyField(raw: string): FieldOutcome<string> {
  const validated = validateSystemKey(clean(raw));
  return validated.ok ? { ok: true, value: validated.key } : { ok: false, error: validated.error };
}

function nameField(raw: string): FieldOutcome<string> {
  const name = clean(raw);
  if (name.trim() === "") {
    return {
      ok: false,
      error: {
        field: "name",
        code: "empty",
        message: "Enter a name. It is the label /systems and every system page shows.",
      },
    };
  }
  if (name.length > TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        field: "name",
        code: "too-long",
        message: `A name is at most ${TITLE_MAX_LENGTH} characters; this one is ${name.length}.`,
      },
    };
  }
  return { ok: true, value: name };
}

/** The two nullable text columns. An empty string is `null`, not `""`: the column is optional. */
function textField(
  field: "ownerTeam" | "description",
  label: string,
  raw: string,
  max: number,
): FieldOutcome<string | null> {
  const value = clean(raw);
  if (value.length > max) {
    return {
      ok: false,
      error: {
        field,
        code: "too-long",
        message: `${label} is at most ${max} characters; this one is ${value.length}.`,
      },
    };
  }
  return { ok: true, value: value === "" ? null : value };
}

/**
 * **The write half of the credential fix**, and one `repoLinkOf` call rather than a second URL
 * parser.
 *
 * Task 3 built that module pure precisely so this task could reuse it; two spellings of one
 * predicate is the failure this project keeps finding. An empty value is `absent` and passes.
 *
 * Every `withheld` reason refuses, not only `credentials`. The scheme allowlist matters as much on
 * the way in as on the way out — a stored `javascript:` URL is script execution in an `href`, not
 * a broken link — and refusing it here is what makes Task 3's guard a second line of defence
 * rather than the only one.
 *
 * The stored value is `href` and not the typed string, for `repoLinkOf`'s own reason: the parsed
 * form is the one whose scheme and userinfo were just checked, so nothing that was inspected can
 * differ from what is written.
 */
function repoField(raw: string): FieldOutcome<string | null> {
  const value = clean(raw);
  if (value.length > SYSTEM_REPO_URL_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        field: "repoUrl",
        code: "too-long",
        message:
          `A repository URL is at most ${SYSTEM_REPO_URL_MAX_LENGTH} characters; this one is ` +
          `${value.length}.`,
      },
    };
  }
  const repo = repoLinkOf(value);
  if (repo.kind === "withheld") {
    return {
      ok: false,
      error: {
        field: "repoUrl",
        code: `repo-${repo.reason}`,
        message: REPO_REFUSED_SENTENCE[repo.reason],
      },
    };
  }
  return { ok: true, value: repo.kind === "link" ? repo.href : null };
}

/**
 * What an audit row says about a system, and what it deliberately leaves out.
 *
 * **`repoUrl` is not here.** Phase 5 Task 8's finding was that a credential reaches a column
 * through the string this application builds, and an `AuditLog.detail` is a column. The refusal
 * above means no *new* credentialed URL can be stored — but a row copying `repoUrl` would mean
 * that the day anybody relaxes that refusal, or edits a row written by an older build, the secret
 * lands in a second table that nothing redacts and that is designed to outlive the row it
 * describes. Leaving it out costs an auditor nothing they asked for: *that* the URL changed is on
 * the row, and the value itself is on `System`.
 *
 * `description` and `ownerTeam` are out for the reason `space.access` omits a space's description:
 * they are content, and the question an audit answers is who changed what, and when.
 */
function auditFields(fields: Iterable<string>): string[] {
  return [...fields].sort();
}

export type SystemWriteResult =
  | { ok: true; id: string; key: string; renamedFrom: string | null; references: number }
  | { ok: false; reason: "invalid"; errors: SystemFieldError[] }
  | AdminRefusal;

/**
 * The `key` is already taken, as a field error rather than a 500.
 *
 * Caught from Postgres rather than pre-checked with a `findUnique`, which is the same split
 * `validateSystemKey` makes against Task 1's CHECK — except that here there is no sentence the
 * database can produce at all, so the catch *is* the mechanism. A pre-check would be a second
 * statement of a uniqueness rule the unique index already enforces, and it would still be wrong
 * under a race: two admins creating `order-hub` a millisecond apart both pass a pre-check, and one
 * of them gets the 500 anyway.
 */
function duplicateKey(key: string): SystemFieldError {
  return {
    field: "key",
    code: "key-taken",
    message:
      `The catalogue already has a system keyed "${key}". Keys are unique — and lowercase, so ` +
      "this is its only spelling.",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Add a system — §7's "admins manage the list", the create half.
 *
 * Every field is reported at once rather than one per round trip: this is one form with six inputs
 * submitted together, so a first-error-wins rule would make an admin correct a six-field row six
 * times. `validateSlug`'s ordering argument applies *within* a field, and `validateSystemKey`
 * keeps it.
 *
 * The insert and the audit row share a transaction, because an audit row that is not committed
 * with the change it describes is a lie either way it fails — `writeAudit`'s own docstring, and
 * the reason the five page mutations pass their transaction client.
 */
export async function createSystem(
  viewer: Viewer,
  input: SystemInput,
): Promise<SystemWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const key = keyField(input.key);
  const name = nameField(input.name);
  const ownerTeam = textField("ownerTeam", "An owning team", input.ownerTeam, TITLE_MAX_LENGTH);
  const description = textField(
    "description",
    "A description",
    input.description,
    SYSTEM_DESCRIPTION_MAX_LENGTH,
  );
  const repoUrl = repoField(input.repoUrl);

  // One condition rather than five, so TypeScript narrows all five below it — and so the caller
  // gets every sentence at once.
  if (!key.ok || !name.ok || !ownerTeam.ok || !description.ok || !repoUrl.ok) {
    return {
      ok: false,
      reason: "invalid",
      errors: [key, name, ownerTeam, description, repoUrl].flatMap((outcome) =>
        outcome.ok ? [] : [outcome.error],
      ),
    };
  }

  const columns = {
    key: key.value,
    name: name.value,
    kind: input.kind,
    ownerTeam: ownerTeam.value,
    description: description.value,
    repoUrl: repoUrl.value,
  };

  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.system.create({
        data: columns,
        // Explicit select, never `include`.
        select: { id: true, key: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        // Null and not omitted: §7 makes a system global, so there is no space to name. See
        // `AuditEntry` for why the type was widened to require the decision rather than allow the
        // key to be forgotten.
        spaceId: null,
        action: "system.create",
        detail: { key: columns.key, name: columns.name, kind: columns.kind },
      });

      // A new system has no page naming it — the whole of Task 1's argument for why `Restrict`
      // blocks nothing that deletion is *for*. A literal rather than a count of a table nothing
      // has had a chance to write to.
      return { ok: true, id: created.id, key: created.key, renamedFrom: null, references: 0 };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "invalid", errors: [duplicateKey(columns.key)] };
    }
    throw error;
  }
}

/**
 * Edit a system — §7's manage, and Task 2's rename question.
 *
 * ## Renaming a key is allowed, warned about, and audited on the row that changed
 *
 * Task 2 named the consequence: `PageSystem` rows are by id and survive a rename, but a published
 * version's stored `frontmatter` still holds the **old key text**, so republishing such a page is
 * refused by `resolveSystems` as naming a system the catalogue does not have. Three answers were
 * available — refuse the rename, warn with a count, or allow it and rely on the audit row — and
 * this is the second and third together.
 *
 * **Refusing would make a key immutable for ever the moment one page named it**, and there is no
 * escape hatch behind it: `Restrict` refuses the delete-and-recreate an admin would fall back on,
 * so a typo noticed after the first publish would be permanent. That is a worse failure than the
 * one it avoids, and an unrecoverable one rather than a loud one.
 *
 * **And the breakage a rename causes is loud, bounded, and already has a message.**
 * `resolveSystems` refuses the republish with a `PublishFieldError` on `systems:` that lists the
 * catalogue, so the author meets a sentence naming the fix on the line that needs it — this is not
 * the silent-drop failure Phase 3 recorded and Task 2 closed. It is bounded because the affected
 * set is exactly {@link AdminSystemRow.references}, which the surface shows on every row *before*
 * the edit form is opened: predicted rather than discovered, the standard Task 1 set for the
 * refused delete.
 *
 * What this deliberately does **not** do is rewrite anybody's frontmatter. A published version is
 * what an author wrote and what the mirror committed; editing it from an admin form would be a
 * mutation with no author, no version and no diff — and Task 2 already declined the mirror image
 * of it ("nothing re-resolves a published version until someone republishes"). The rename is
 * recorded with `previousKey` and the count, which is the durable record that the two spellings
 * were once one system.
 */
export async function updateSystem(
  viewer: Viewer,
  systemId: string,
  patch: SystemPatch,
): Promise<SystemWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const errors: SystemFieldError[] = [];
  const data: Prisma.SystemUpdateInput = {};

  /**
   * Applies one patched field, or collects its sentence. An absent field is one this request is
   * not changing — see {@link SystemPatch} for why an edit is a patch and not a replacement.
   *
   * The closure is what keeps the rules stated once: `keyField`, `nameField`, `textField` and
   * `repoField` are the same functions `createSystem` calls, so a create and an edit cannot
   * disagree about what a legal key or an acceptable repository URL is.
   */
  const apply = <T>(
    raw: string | undefined,
    validate: (raw: string) => FieldOutcome<T>,
    write: (value: T) => void,
  ): void => {
    if (raw === undefined) return;
    const outcome = validate(raw);
    if (outcome.ok) write(outcome.value);
    else errors.push(outcome.error);
  };

  apply(patch.key, keyField, (value) => {
    data.key = value;
  });
  apply(patch.name, nameField, (value) => {
    data.name = value;
  });
  apply(
    patch.ownerTeam,
    (raw) => textField("ownerTeam", "An owning team", raw, TITLE_MAX_LENGTH),
    (value) => {
      data.ownerTeam = value;
    },
  );
  apply(
    patch.description,
    (raw) => textField("description", "A description", raw, SYSTEM_DESCRIPTION_MAX_LENGTH),
    (value) => {
      data.description = value;
    },
  );
  apply(patch.repoUrl, repoField, (value) => {
    data.repoUrl = value;
  });
  // `kind` and `isActive` carry no rule of their own: the wire schema has already refused anything
  // outside `SystemKind`, and a boolean is a boolean. Assigning them here rather than validating
  // them is the honest version of "every value is legal for every system", which is the property
  // `prisma/seed.ts` relies on for its `update: {}`.
  if (patch.kind !== undefined) data.kind = patch.kind;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;

  if (errors.length > 0) return { ok: false, reason: "invalid", errors };

  try {
    return await db.$transaction(async (tx) => {
      const before = await tx.system.findUnique({
        where: { id: systemId },
        // Explicit select, never `include`. `_count` is read inside the transaction so the number
        // in the audit row describes the same instant as the rename it is about.
        select: { key: true, name: true, kind: true, _count: { select: { pages: true } } },
      });
      // The same answer as "you may not look" — one shape for a miss and for a refusal.
      if (before === null) return { ok: false, reason: "not-found" } as const;

      const renamed = data.key !== undefined && data.key !== before.key;

      const updated = await tx.system.update({
        where: { id: systemId },
        data,
        select: { id: true, key: true, name: true, kind: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        spaceId: null,
        action: "system.update",
        detail: {
          key: updated.key,
          name: updated.name,
          kind: updated.kind,
          // Which columns this request actually wrote. `repoUrl` appears by name and never by
          // value — see `auditFields`.
          fields: auditFields(Object.keys(data)),
          /*
           * Null and not absent when nothing was renamed, for `page.review`'s reason: an omitted
           * key and a null one mean different things to anyone querying the column, and "was this
           * row ever renamed" is the question this field exists to answer.
           */
          previousKey: renamed ? before.key : null,
          // Only meaningful on a rename, and it is the number that says what the rename cost:
          // every one of these pages holds the OLD key in its published frontmatter and will be
          // refused on its next republish until somebody edits that line.
          strandedPages: renamed ? before._count.pages : 0,
        },
      });

      return {
        ok: true,
        id: updated.id,
        key: updated.key,
        renamedFrom: renamed ? before.key : null,
        references: before._count.pages,
      } as const;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // `data.key` is a string here by construction: a unique violation on this table can only be
      // `System_key_key`, and the only write that sets `key` is the `apply` above.
      return {
        ok: false,
        reason: "invalid",
        errors: [duplicateKey(typeof data.key === "string" ? data.key : "")],
      };
    }
    throw error;
  }
}

export type DeleteSystemResult =
  | { ok: true; key: string }
  /**
   * The database refused it. Everything the surface needs to say so **and to offer the
   * alternative in the same place** — which is what Task 1 said this task owed, on the grounds
   * that "a refusal that names no alternative is how an admin ends up in psql".
   */
  | {
      ok: false;
      reason: "referenced";
      key: string;
      name: string;
      references: number;
      /** Already sunsetting, so the offer below is not the thing to show. */
      isActive: boolean;
      message: string;
    }
  | AdminRefusal;

/**
 * Remove a system — and be refused by `PageSystem.systemId`'s `Restrict` when pages name it.
 *
 * ## The refusal comes from the database, and there is deliberately no pre-check
 *
 * The obvious shape is `if (count > 0) return referenced` before the delete. It is not written:
 * the foreign key is the authority, so a pre-check would be the same predicate stated twice with
 * the copy that mattered untestable — deleting the pre-check would change nothing an assertion can
 * see, because the catch produces the identical answer. That is the `resolveRedirect` shape, which
 * this project has measured twice. It would also still be wrong, since a publish committing
 * between the check and the delete makes the check a lie. So the delete is attempted, `P2003` is
 * caught, and the count is read **after** the refusal, where it describes the state that actually
 * refused.
 *
 * Prediction is not given up by that: {@link AdminSystemRow.references} ships with every row on the
 * list, so an admin sees the number before reaching for the button. Task 1 asked for both, and
 * they are two mechanisms — one predicts, one explains.
 *
 * ## The alternative is offered in the same result
 *
 * `isActive` already exists, and Task 1's argument for `Restrict` leans on it: *"a system that
 * should stop appearing has a state for that, so deletion is for a row created in error"*. So the
 * refusal carries `isActive`, and the surface renders a control that sets it to `false` through
 * {@link updateSystem} — one click, in the place the refusal appeared.
 */
export async function deleteSystem(
  viewer: Viewer,
  systemId: string,
): Promise<DeleteSystemResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const system = await db.system.findUnique({
    where: { id: systemId },
    // Read before the delete because the row is about to stop existing: this is the one mutation
    // in this module whose audit detail cannot be reconstructed afterwards from anything.
    select: { id: true, key: true, name: true, kind: true, isActive: true },
  });
  if (system === null) return { ok: false, reason: "not-found" };

  try {
    await db.$transaction(async (tx) => {
      await tx.system.delete({ where: { id: systemId }, select: { id: true } });
      await writeAudit(tx, {
        actorId: viewer.id,
        spaceId: null,
        action: "system.delete",
        detail: { key: system.key, name: system.name, kind: system.kind },
      });
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      // The foreign key violation `onDelete: Restrict` raises. The transaction rolls back with it,
      // so no audit row survives for a delete that did not happen.
      error.code === "P2003"
    ) {
      const references = await db.pageSystem.count({ where: { systemId } });
      return {
        ok: false,
        reason: "referenced",
        key: system.key,
        name: system.name,
        references,
        isActive: system.isActive,
        message: refusalSentence(system.key, references, system.isActive),
      };
    }
    throw error;
  }

  return { ok: true, key: system.key };
}

/**
 * The refused-delete sentence, built here so the module and the surface cannot disagree about it —
 * `REPO_WITHHELD_SENTENCE`'s reason, and `confirmReview`'s.
 *
 * It says three things, in the order an admin acts on them: what refused, how much, and what to do
 * instead. The count is spelled out rather than left to the row above, because a refusal that says
 * "some pages" is not a checkable claim — the same standard Task 3 applied to its excluded-RFC
 * count.
 */
function refusalSentence(key: string, references: number, isActive: boolean): string {
  const pages = references === 1 ? "1 page" : `${references} pages`;
  const instead = isActive
    ? "A system that should stop appearing has a state for that: mark it sunsetting instead, " +
      "which keeps every page's facet intact and flags it everywhere the system is shown."
    : "It is already marked sunsetting, which is the state for a system that should stop " +
      "appearing; deleting a row is only for one created in error.";
  return (
    `${pages} name "${key}" in their frontmatter, so the database refuses to delete it — a facet ` +
    "row is a projection of what an author wrote, and removing it would leave those documents " +
    `saying they belong to a system that no longer exists. ${instead}`
  );
}

/**
 * The wire shape of the admin form, and **shape only** — no rule this module owns is repeated
 * here.
 *
 * The split is the one `src/lib/bugs/schema.ts` and `src/lib/drafts/schema.ts` already draw: Zod
 * answers "is this JSON the right sort of object", and the field functions above answer "may this
 * be a system", with a `SystemFieldError` per input that a form renders beside the field. Putting
 * the length caps or the URL rule in here as well would be the same predicate in two places, and
 * the copy that produced no sentence would be the one nothing could test.
 *
 * `z.enum(SystemKind)` takes Prisma's generated enum object rather than a retyped array of four
 * strings, so widening §5.2's `SystemKind` — which Task 1 recorded as a real gap, there being no
 * web-app value — cannot leave this endpoint refusing a kind the database accepts.
 *
 * `.max()` on the strings is not the length rule either: it is a **body bound**, an order of
 * magnitude above the real caps, so a megabyte of JSON is refused before `stripControl` runs over
 * the whole of it. The field-level cap is the one that produces a sentence.
 *
 * `z.strictObject`, never `z.object` — one word between refusing a typo and stripping it silently,
 * which this project records as a decision that should not be relitigated.
 */
const BODY_FIELD_MAX = 20_000;
const freeText = z.string().max(BODY_FIELD_MAX);

export const systemCreateBody = z.strictObject({
  key: freeText,
  name: freeText,
  kind: z.enum(SystemKind),
  ownerTeam: freeText,
  description: freeText,
  repoUrl: freeText,
});

/**
 * An edit is a patch: every field optional, and an absent one is not being changed. See
 * {@link SystemPatch} for why — `repoUrl` is the field that decides it.
 */
export const systemUpdateBody = z.strictObject({
  key: freeText.optional(),
  name: freeText.optional(),
  kind: z.enum(SystemKind).optional(),
  ownerTeam: freeText.optional(),
  description: freeText.optional(),
  repoUrl: freeText.optional(),
  isActive: z.boolean().optional(),
});
