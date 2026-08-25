import type { DocStatus, DocType, Prisma, RelationType } from "@prisma/client";
import { readableSpace } from "@/lib/authz/where";
import { visiblePage } from "@/lib/pages/visible";
import { KEY_FOR_RELATION, type RelationKey } from "@/lib/lifecycle/schema";
import type { Viewer } from "@/lib/authz/types";

/**
 * Turns the page **paths** an author declared in frontmatter into the page **ids** a
 * `PageRelation` row stores.
 *
 * Task 3 validated the shape of those paths without a database; this is the half that needs
 * one. It answers exactly one question per reference — *which page, if any, does this name?* —
 * and answers nothing else. Whether the relation it would create is **legal** is Task 6's
 * question, and the two are kept apart deliberately: see "What this does not judge".
 *
 * ## What it resolves through, and why one hop is enough
 *
 * A reference resolves the way the **reader** resolves a URL: the live path first, and on a
 * miss, the `Redirect` a move left behind. So an author who wrote `decisions/adr-0031` last
 * month still lands on that ADR after someone moved it to `archive/adr-0031`, rather than
 * having their publish refused for a path that was correct when they typed it.
 *
 * One hop, and — as in `resolveRedirect`, whose reasoning this follows rather than restates —
 * the schema is why one hop is enough: `Redirect` stores `toPageId`, not a target path, so a
 * page moved three times has three redirect rows and every one of them reaches it directly. A
 * chain is not merely unfollowed here, it is unrepresentable, and a second lookup would turn a
 * move bug into an infinite loop.
 *
 * **What is recorded is what it resolved *to*.** `ResolvedRelation.page.id` is the identity the
 * relation row gets; `ref` is kept only so a refusal can quote the author's own line and so
 * Phase 5's git mirror can write the frontmatter back out. A relation stored by path would
 * break on the next move, which is the whole reason the plan chose an id.
 *
 * ## Three queries, not one per reference
 *
 * Task 3 capped `MAX_RELATION_TARGETS` at 20 because "each target costs Task 5 a resolution
 * query" inside the publish transaction. An ADR may declare four relation keys, so the cap
 * bounds the work at 80 references — and 80 sequential round trips holding a row lock is the
 * lock-duration problem that cap exists to prevent, not a solution to it.
 *
 * So the references are resolved in batch: one `Page` read for the live paths, one `Redirect`
 * read for whatever missed, one `Page` read for whatever missed *that* (see the probe). Three
 * round trips whatever the reference count, and the second and third do not run at all when
 * nothing missed — which is the common case, because most references are correct.
 *
 * `@@unique([spaceId, path])` is what makes the batching sound: at most one page per path in a
 * space, live or deleted, so the three reads cannot disagree about what a path names.
 *
 * ## The refusals, and which two are deliberately the same answer
 *
 * `not-found` is returned for a reference that names **no page** and for one that names a page
 * in a space this viewer **cannot read**, and those two are the same answer on purpose. This
 * project treats 404-not-403 as a security property and has enforced it in the reader
 * (`getPublishedPage`), the redirect resolver, the editor (`getPageForEditing`), the preview
 * (`canEditPage`), publish, move and delete. A relation is the seventh way to violate it: if an
 * unreadable target were refused with its own message, publishing a one-line ADR would be a
 * probe for the existence of any page in the product, one path at a time. The refusal cannot
 * distinguish them, so it does not try — the permission predicate lives on the query and the
 * miss is the only observable.
 *
 * The other three refusals are each specific, because each is safe to be specific about:
 *
 * - **`deleted`** — reachable only inside a space the viewer can read. See `findDeleted`.
 * - **`self-reference`** — the target is the page doing the referencing. Nothing is disclosed:
 *   the caller is publishing that page.
 * - **`cross-space`** — decided from the reference's own text before any query. Discloses
 *   nothing, because it does not look anything up.
 *
 * ## Cross-space references are refused in Phase 3
 *
 * A reference is space-relative, so the ordinary way to name another space's page is to paste
 * a reader URL: `/handbook/onboarding/day-one`. That form is parsed rather than guessed at
 * (`parseRef`), and refused with its own code — **not** allowed to fall into `not-found`, so
 * that the decision is findable when a later phase wants cross-space relations.
 *
 * The decision itself: `SUPERSEDES` across spaces asks whether publishing in space A may retire
 * a page in space B, which is a permission question with no obvious answer, no seeded case that
 * needs it, and no good place to answer it quietly. Task 8 already has to argue authorization
 * for a cascade *within* a space; crossing spaces would compound that with a target the
 * publisher may not even be able to read.
 *
 * The refusal is **syntactic**: it never checks whether the named space exists or is readable,
 * so `/handbook/x` and `/no-such-space/x` get the same answer. That is not laziness — a
 * cross-space refusal that consulted the `Space` table would be a second way to ask "does this
 * exist", on a table whose readability is a different question again.
 *
 * A `/{ownSpaceKey}/rest` reference resolves normally: it is unambiguous, and refusing it would
 * be refusing the exact string the author copied out of their address bar.
 *
 * ## What this does not judge
 *
 * Not here, and not restated here: `SUPERSEDES` between two doc types (Task 6), `DECIDES` from
 * an ADR to an RFC (Task 6), supersede cycles (Task 6), the `ACCEPTED` precondition on the
 * source (Task 6), the cascade and its authorization (Task 8), and the upsert (Task 7). This
 * returns the resolved page's `id`, `docType` and `status` — which is what Task 6 needs to
 * decide all of the above — and states none of Task 6's rules, because a rule stated in two
 * places is a rule neither statement can be tested for.
 *
 * **Nor does it require the target to be published.** A reference to an unpublished page
 * resolves, carrying `status: DRAFT`, and Task 6 decides whether that is legal for the relation
 * type. It is not a leak: `listSpacePages` already renders unpublished pages in the nav rail
 * of everyone who can read the space, as inert text.
 *
 * **Nor does it deduplicate.** Two references that resolve to the same page — `related:` naming
 * both a page's current and pre-move path, say — come back as two entries. Task 7's
 * `@@unique([fromId, toId, type])` makes the upsert idempotent, and collapsing them here would
 * be this module deciding something about relations rather than about references.
 */

/**
 * Whatever can read pages and redirects. Structural, and for the same reason `AuditClient` is:
 * the publish path passes its **transaction** client, because a reference resolved outside the
 * transaction that writes the relation is resolved against a different snapshot than the one
 * the write commits into — and the editor and the tests pass `db`.
 *
 * The parameter is named `tx` in every signature below, which is also what keeps this module
 * visible to the soft-delete sweep in `src/lib/pages/visible.test.ts`: that sweep matches
 * `db.`/`tx.` delegate calls, and a parameter named `client` would have made a module doing
 * three `Page`-reaching reads invisible to it. Fifth time on this project a guard could not see
 * a whole category — this one avoided by naming the parameter what the guard looks for.
 */
export type RelationClient = Pick<Prisma.TransactionClient, "page" | "redirect">;

/** What a reference resolved to. `page.id` is the identity a `PageRelation` row stores. */
export type ResolvedRelation = {
  type: RelationType;
  /** Verbatim what the author wrote, for the git mirror and for messages. Never the identity. */
  ref: string;
  page: {
    id: string;
    /** Where the page is **now** — which is not necessarily what `ref` says. */
    path: string;
    /** For Task 6. `SUPERSEDES` is same-type-only and `DECIDES` is ADR→RFC. */
    docType: DocType;
    /** For Task 6's `ACCEPTED` precondition and Task 8's cascade transition check. */
    status: DocStatus;
  };
};

export type RelationRefusalCode =
  /**
   * No such page **or** a page in a space this viewer cannot read. Deliberately one code for
   * both — see "The refusals" above. Do not split it.
   */
  | "not-found"
  /** Names a soft-deleted page, in a space the viewer can read. */
  | "deleted"
  /** Resolves to the page doing the referencing. */
  | "self-reference"
  /** Names a page in another space, which Phase 3 does not resolve. */
  | "cross-space";

/**
 * `field` + `key` + `message`, the shape `FrontmatterKeyError` established and for the same
 * reason: frontmatter is one textarea, so `field: "markdown"` can only underline the whole
 * pane, and `key` is what lets Task 11 point at the offending line.
 *
 * A parallel type rather than a widened `FrontmatterKeyError`, exactly as that type is a
 * parallel of `FieldError`: the codes are this module's, and a shared union would let a caller
 * switch on a code it can never see.
 */
export type RelationRefusal = {
  field: "markdown";
  /** The frontmatter key that declared it — `supersedes`, `decides`, `amends`, `related`. */
  key: RelationKey;
  type: RelationType;
  /** The reference as written, so the editor can find the line. */
  ref: string;
  code: RelationRefusalCode;
  message: string;
};

export type RelationResolution =
  | { ok: true; relations: ResolvedRelation[] }
  /**
   * **Every** refusal, not the first — the same choice `validateFrontmatter` made, for the same
   * reason: an author declared these in one pass and fixing them one publish attempt at a time
   * is a bad loop. Non-empty by construction.
   */
  | { ok: false; errors: [RelationRefusal, ...RelationRefusal[]] };

/**
 * A reference's text, split into "which space" and "which path".
 *
 * Space-relative is the documented form and the common one. The absolute form exists because
 * pasting a reader URL is the obvious thing an author does, and it is the **only** form in which
 * a reference can name another space at all — which is what makes `cross-space` a refusal this
 * module can detect rather than a case that silently reads as a missing page.
 *
 * A malformed absolute reference (`/`, `/space`, `//x`) yields an empty path, which the caller
 * turns into `not-found`. That is the honest answer: it names no page, and inventing a fifth
 * refusal code for punctuation would be describing the input rather than the outcome.
 *
 * Parsing is not the same as the trimming `pageRef` refuses. Trimming *discards* characters the
 * author typed and accepts a value they never wrote; this reads the characters as written,
 * against a grammar stated here and tested.
 */
function parseRef(ref: string, ownSpaceKey: string): { path: string } | { otherSpace: string } {
  if (!ref.startsWith("/")) return { path: ref };
  const [, spaceKey = "", ...rest] = ref.split("/");
  const path = rest.join("/");
  if (spaceKey.length === 0 || path.length === 0) return { path: "" };
  if (spaceKey !== ownSpaceKey) return { otherSpace: spaceKey };
  return { path };
}

/** One reference, with its parse already done. */
type Request = {
  type: RelationType;
  key: RelationKey;
  ref: string;
  /** `null` when the reference named another space, so no lookup is owed. */
  path: string | null;
  otherSpace: string | null;
};

const refused = (
  request: Request,
  code: RelationRefusalCode,
  message: string,
): RelationRefusal => ({
  field: "markdown",
  key: request.key,
  type: request.type,
  ref: request.ref,
  code,
  message,
});

/** Identical text for a missing page and for an unreadable one. That is the whole point. */
const notFoundMessage = (ref: string): string =>
  `\`${ref}\` does not name a page here. Write the target's path as it appears in its URL ` +
  "after the space key — `decisions/adr-0031`, not the page's title. A path that named a " +
  "page which has since moved still works; one that names nothing does not.";

type PageFields = { id: string; path: string; docType: DocType; status: DocStatus };

const PAGE_FIELDS = { id: true, path: true, docType: true, status: true } as const;

/**
 * The live, readable page at each of these paths.
 *
 * `visiblePage` owns the top level and `readableSpace` is passed whole as the `space` relation
 * filter — neither is spread, at any depth. `readableSpace` is here and not left to the caller
 * for the rule that governs every query in this project: a query states its own permission
 * predicate and is never guarded by call ordering. It is not redundant even though the publish
 * path has already authorised the *source* page — this function is reachable from anywhere, and
 * "the caller must have checked" is exactly the assumption that turns into a bypass the first
 * time a second caller appears.
 */
async function findLive(
  tx: RelationClient,
  viewer: Viewer,
  spaceId: string,
  paths: string[],
): Promise<Map<string, PageFields>> {
  if (paths.length === 0) return new Map();
  const rows = await tx.page.findMany({
    where: visiblePage({ spaceId, path: { in: paths }, space: readableSpace(viewer) }),
    // Explicit select, never `include`.
    select: PAGE_FIELDS,
  });
  return new Map(rows.map((row) => [row.path, row]));
}

/**
 * Where each of these paths *used* to be a page, resolved to where that page is now.
 *
 * The same shape as `resolveRedirect`, including where the permission predicate sits, and that
 * placement is the part worth not re-deriving. `readableSpace` is stated **once**, on the
 * redirect's own space — the space the reference is relative to, which is the space whose
 * readability is the question. It is deliberately *not* also nested inside the `toPage` filter:
 * `resolveRedirect` carried it in both places as defence in depth, and dropping either copy
 * alone left the entire suite green. Two statements of one predicate make neither testable.
 *
 * `toPage` therefore carries only *shape* constraints, each with its own test: the target must
 * not be soft-deleted, and it must live in the space the reference is relative to — so a
 * `Redirect` row pointing across spaces cannot smuggle in the cross-space relation the
 * syntactic check above refuses.
 */
async function findViaRedirect(
  tx: RelationClient,
  viewer: Viewer,
  spaceId: string,
  paths: string[],
): Promise<Map<string, PageFields>> {
  if (paths.length === 0) return new Map();
  const rows = await tx.redirect.findMany({
    where: {
      fromPath: { in: paths },
      // Neither helper is spread; each is passed whole.
      space: readableSpace(viewer, { id: spaceId }),
      toPage: visiblePage({ spaceId }),
    },
    // Explicit select, never `include`.
    select: { fromPath: true, toPage: { select: PAGE_FIELDS } },
  });
  return new Map(rows.map((row) => [row.fromPath, row.toPage]));
}

/**
 * Which of these paths hold a **soft-deleted** page — the one query here that is looking *for*
 * one, so it carries `readableSpace` and inverts the soft-delete filter instead of applying it.
 * `restorePage` and `listDeletedPages` do the same thing for the same reason; registered in the
 * soft-delete guard as `covered` rather than `exempt`, because the absence is pinned by a test
 * rather than merely allowed.
 *
 * It exists only to turn one `not-found` into a better sentence, and it is the one place a
 * specific refusal could leak — so `readableSpace` is what makes it safe: inside a space the
 * viewer cannot read it matches nothing, and "that page is deleted" collapses back into the
 * shared `not-found`. Inside a space they *can* read there is nothing to protect; a member
 * could have read the page yesterday, and the deletion is what they need to hear about.
 *
 * **Its blind spot, stated rather than fixed:** a page that was moved and *then* deleted is not
 * found here, because the reference names the old path and the deleted row sits at the new one.
 * That reference gets `not-found`. Chasing it would mean a fourth query joining `Redirect` to
 * deleted pages, to improve the wording of a case that needs two separate accidents; the
 * refusal is correct either way.
 */
async function findDeleted(
  tx: RelationClient,
  viewer: Viewer,
  spaceId: string,
  paths: string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const rows = await tx.page.findMany({
    // NOT `visiblePage()`: inverted on purpose, and the inversion is the query. `readableSpace`
    // is passed whole as the `space` relation filter and is not spread.
    where: {
      spaceId,
      path: { in: paths },
      deletedAt: { not: null },
      space: readableSpace(viewer),
    },
    // Explicit select, never `include`. Only the path — the caller needs no more than
    // "yes, that one is deleted".
    select: { path: true },
  });
  return new Set(rows.map((row) => row.path));
}

/**
 * Resolves every reference in a validated frontmatter's `relations`.
 *
 * `args.source` is the page doing the referencing: the caller's own already-authorised row.
 * Passing it rather than re-reading it keeps one query out of the publish transaction, and
 * costs nothing in safety — every query below states its own permission predicate against
 * `source.spaceId` regardless of what the caller believes about it. `spaceKey` is used only for
 * the syntactic cross-space comparison and for messages; no query trusts it.
 *
 * `args.relations` is `ValidatedFrontmatter.relations` — keyed by `RelationType`, with all four
 * keys always present. Iterated in `KEY_FOR_RELATION` order rather than in the object's own key
 * order, so the returned list and the error list are deterministic.
 */
export async function resolveRelations(
  tx: RelationClient,
  viewer: Viewer,
  args: {
    source: { id: string; spaceId: string; spaceKey: string };
    relations: Record<RelationType, string[]>;
  },
): Promise<RelationResolution> {
  const { source } = args;

  const requests: Request[] = [];
  for (const [type, key] of Object.entries(KEY_FOR_RELATION) as [RelationType, RelationKey][]) {
    for (const ref of args.relations[type]) {
      const parsed = parseRef(ref, source.spaceKey);
      requests.push({
        type,
        key,
        ref,
        path: "path" in parsed ? parsed.path : null,
        otherSpace: "otherSpace" in parsed ? parsed.otherSpace : null,
      });
    }
  }

  // Nothing declared is a success with nothing in it, not a special case: Task 7 removes the
  // relations the frontmatter no longer declares, and "declared none" has to reach it as an
  // empty list rather than as an early return the caller has to remember to handle.
  if (requests.length === 0) return { ok: true, relations: [] };

  const wanted = [...new Set(requests.flatMap((r) => (r.path ? [r.path] : [])))];

  const live = await findLive(tx, viewer, source.spaceId, wanted);
  const missed = wanted.filter((path) => !live.has(path));
  const moved = await findViaRedirect(tx, viewer, source.spaceId, missed);
  const stillMissed = missed.filter((path) => !moved.has(path));
  const deleted = await findDeleted(tx, viewer, source.spaceId, stillMissed);

  const relations: ResolvedRelation[] = [];
  const errors: RelationRefusal[] = [];

  for (const request of requests) {
    if (request.otherSpace !== null) {
      errors.push(
        refused(
          request,
          "cross-space",
          `\`${request.ref}\` names a page in the \`${request.otherSpace}\` space. A relation ` +
            "joins two pages in the same space; write the target's path relative to this " +
            "space, without the space key. Relations across spaces are not supported yet.",
        ),
      );
      continue;
    }

    const path = request.path ?? "";
    const page = live.get(path) ?? moved.get(path);

    if (!page) {
      if (deleted.has(path)) {
        errors.push(
          refused(
            request,
            "deleted",
            `\`${request.ref}\` names a page that has been deleted. Restore it first, or point ` +
              "this relation somewhere else — a relation to a deleted page would show readers " +
              "a link that goes nowhere.",
          ),
        );
        continue;
      }
      // Missing and unreadable arrive here together, with the same sentence. See the module
      // docstring: distinguishing them would make publishing an ADR a way to enumerate pages.
      errors.push(refused(request, "not-found", notFoundMessage(request.ref)));
      continue;
    }

    // Checked on the **resolved** page and not by comparing paths, which is what makes it catch
    // the interesting case: a reference to this page's own pre-move path resolves, through the
    // redirect, back to this page. A path comparison would pass it and the relation would be
    // written against itself.
    //
    // Refused for every relation type, not only `SUPERSEDES`. A page relating to itself says
    // nothing under any of the four, and one refusal here is testable where the same rule
    // written again in Task 6 would make neither copy so. Task 6's "a page cannot supersede
    // itself" is subsumed by this — see the report accompanying this task.
    if (page.id === source.id) {
      errors.push(
        refused(
          request,
          "self-reference",
          `\`${request.ref}\` is this page. A relation joins two different pages — if the ` +
            "target moved and this path is now the one you are editing, name the other page's " +
            "current path.",
        ),
      );
      continue;
    }

    relations.push({ type: request.type, ref: request.ref, page });
  }

  const [first, ...rest] = errors;
  if (first !== undefined) return { ok: false, errors: [first, ...rest] };

  return { ok: true, relations };
}
