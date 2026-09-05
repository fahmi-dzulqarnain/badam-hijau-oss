import { Prisma, SpaceRole, SpaceVisibility } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { refuseNonAdmin, type AdminRefusal } from "@/lib/admin/gate";
import { auditSpaceAccess, writeAudit } from "@/lib/audit/log";
import { TITLE_MAX_LENGTH } from "@/lib/drafts/schema";
import { stripControl } from "@/lib/text/control";
import { validateSpaceKey } from "@/lib/spaces/key";
import type { Viewer } from "@/lib/authz/types";

/**
 * `/admin/spaces` — spec §11's `/admin/*`, Phase 7 Task 6. **The first surface in this product
 * that creates a `Space`; until now only the seed did.**
 *
 * Task 5's patterns, copied deliberately rather than re-decided: the refusal comes from
 * `src/lib/admin/gate.ts` and is stated nowhere else; `readableSpace` and `visiblePage` are
 * **absent, at the line, with reasons**; and the audited act is a *listing of what is inside a
 * space*, never a count of it. What is new is everything about memberships, because a
 * `SpaceMembership` row is not a catalogue entry — it is the grant.
 *
 * ## Membership is the only thing that grants anything, so this is the surface that can widen
 *
 * `can()` reduces every permission in this product to two facts: `viewer.isSuperAdmin`, and the
 * `SpaceRole` on a `SpaceMembership` row. Nothing else grants read, edit, publish or manage. Three
 * mutations here therefore change what a named person can see, and a fourth changes what
 * *everyone* can see:
 *
 * - {@link addSpaceMember} grants read to a person who had none.
 * - {@link setSpaceMemberRole} can turn a `VIEWER` into an `ADMIN` — `MANAGE_SPACE` — with no row
 *   created and none deleted.
 * - {@link removeSpaceMember} revokes.
 * - {@link updateSpace} can flip `visibility` from `MEMBERS` to `ALL_STAFF`, which grants read to
 *   **every signed-in person at once without touching a single membership row**, and which is the
 *   one change on this page that no membership audit action would see.
 *
 * Each of the four writes its own audit row, and the visibility flip carries `previousVisibility`
 * because it also *turns off* the `space.access` trail for that space — `needsAccessAudit` fires
 * only for a `MEMBERS` space. See `AuditAction` in `src/lib/audit/log.ts`.
 *
 * The prediction half, which is Task 1's standard applied to access rather than to a delete: the
 * **member count and the page count are on every row before anything is clicked**, so how much a
 * change is about to affect is visible without asking for it.
 *
 * ## The audit line, and it is Task 1's moved one category along
 *
 * Task 1 drew it as *"showing the number needs no audit; showing the titles does"*. Here the line
 * is **the container versus what is inside it**, and the people are inside it:
 *
 * - {@link listSpacesForAdmin} writes **nothing**. It names each space's key, name, visibility and
 *   two integers — the labels on the containers, which a super admin sees on every admin surface
 *   there is and needs in order to administer them at all. Auditing the index of the
 *   administration page would put one row per `MEMBERS` space on every page view, and noise is how
 *   an audit table stops being read.
 * - {@link listSpaceMembers} writes one `space.access` row. *This named person belongs to this
 *   private space* is a fact a `MEMBERS` space keeps to itself, and it is the closest thing on
 *   this surface to the titles-and-paths observable §8 is about. Its own endpoint behind its own
 *   control, exactly as `listBlockingPages` is, so the count can be free and the names can cost.
 *
 * `auditSpaceAccess` owns both the decision (`needsAccessAudit`) and the dedupe, so these are call
 * sites and not a second copy of the rule; the default `"request"` scope is right because this is
 * one act of reading by a person.
 *
 * ## `readableSpace` and `visiblePage` are absent, and both absences are load-bearing
 *
 * - **No `readableSpace`.** It would be inert *and* wrong, which is `src/lib/systems/admin.ts`'s
 *   pair of reasons arriving on the module where the temptation is strongest, because here a
 *   `Space` genuinely is to hand. Inert: `readableSpaceWhere` answers `{}` for a super admin, the
 *   only viewer that gets past `refuseNonAdmin`, so it is the `resolveRedirect` shape — a filter
 *   no test can be written against. Wrong: an installation's administration that could not see a
 *   `MEMBERS` space nobody had thought to add the admin to would be an administration surface with
 *   a blind spot, and the space would be unadministrable by anyone.
 * - **`can(viewer, space, "MANAGE_SPACE")` is not the predicate either**, and Task 5 said this
 *   would be tempting here. A space `ADMIN` administers *a* space; the person who creates spaces,
 *   sets their visibility and decides who is in them administers the installation. Worse, it is
 *   circular for three of the seven entry points: the membership rows this surface writes are what
 *   `can()` reads, so a space with no `ADMIN` — which {@link createSpace} produces every time —
 *   would be one nobody could ever add a member to.
 * - **No `visiblePage`.** The only `Page` this module touches is a `_count`, and it counts **every
 *   row, soft-deleted included** — see {@link AdminSpaceRow.pages}.
 */

/**
 * Longest `Space.description`.
 *
 * `SYSTEM_DESCRIPTION_MAX_LENGTH`'s number and its argument: a catalogue blurb rendered as one
 * paragraph in a list row, bounding a column with nothing underneath it to measure against. The
 * two are not derived from one another because they are two independent judgements that happen to
 * agree — deriving would claim a tie that does not exist, which is the opposite of
 * `SPACE_KEY_MAX_LENGTH`, where the tie is the whole point.
 */
export const SPACE_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Longest `Space.initials`.
 *
 * The column is a chip beside a space's name, so the bound is about rendering rather than storage,
 * and four characters is generous for a two-letter monogram while leaving room for `RONP`. Not
 * derived from `TITLE_MAX_LENGTH`: three hundred characters of "initials" is not a long label, it
 * is a different field.
 */
export const SPACE_INITIALS_MAX_LENGTH = 4;

/**
 * The most members one listing names. `MAX_BLOCKING_PAGES`'s shape and its argument: a rendering
 * bound, with the surface saying the list is short rather than pretending it is whole.
 */
export const MAX_SPACE_MEMBERS = 500;

/** Which input a message is about. The form renders each one against its own field. */
export type SpaceField = "key" | "name" | "initials" | "description" | "visibility" | "email";

export type SpaceFieldError = {
  field: SpaceField;
  code: string;
  message: string;
};

/** A new space, as the create form submits it. Empty strings mean "no value". */
export type SpaceInput = {
  key: string;
  name: string;
  initials: string;
  description: string;
  visibility: SpaceVisibility;
};

/**
 * An edit, and it is a **patch** for `SystemPatch`'s reason turned around.
 *
 * There is no credentialed field to withhold here, so the deciding argument is the other one: the
 * offer beside a refusal, and the single-field change. Flipping a space's visibility is one field
 * and must not resubmit four values the admin never looked at — particularly not `key`, where a
 * replacement form would resend the current key on every save and make "did this request ask for a
 * rename" unanswerable from the request alone.
 */
export type SpacePatch = {
  key?: string;
  name?: string;
  initials?: string;
  description?: string;
  visibility?: SpaceVisibility;
};

/** One space as an admin sees it: what it is, and how much a change to it would affect. */
export type AdminSpaceRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  initials: string;
  visibility: SpaceVisibility;
  /**
   * `SpaceMembership` rows. With `visibility`, this is the whole answer to "who can read this
   * space": `MEMBERS` and `0` means nobody but a super admin, which is the state
   * {@link createSpace} leaves every new space in and which the surface says out loud.
   */
  members: number;
  /**
   * `Page` rows — **every one of them, soft-deleted included**, and this module is registered in
   * `src/lib/pages/visible.test.ts` on that absence rather than in spite of it.
   *
   * It is the number the key rule below refuses over, so it has to count what that rule cares
   * about: a page that ever existed is a URL somebody may have shared and a file the git mirror
   * wrote under this key, and a soft delete undoes neither — `restorePage` brings the page and its
   * mirror file back. It is therefore **not** the number a space's landing page shows, which is
   * smaller.
   */
  pages: number;
};

export type AdminSpacesResult = { ok: true; spaces: AdminSpaceRow[] } | AdminRefusal;

/**
 * Every space in the installation, in key order.
 *
 * **No audit row** — see the module docstring's audit line. This names containers and two
 * integers; {@link listSpaceMembers} is where a name is attached to a private space.
 */
export async function listSpacesForAdmin(viewer: Viewer): Promise<AdminSpacesResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const rows = await db.space.findMany({
    orderBy: { key: "asc" },
    // Explicit select, never `include`.
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      initials: true,
      visibility: true,
      _count: { select: { memberships: true, pages: true } },
    },
  });

  return {
    ok: true,
    spaces: rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      initials: row.initials,
      visibility: row.visibility,
      members: row._count.memberships,
      pages: row._count.pages,
    })),
  };
}

/** One person's membership of one space. Enough to identify them and to change it. */
export type SpaceMember = {
  userId: string;
  name: string;
  email: string;
  role: SpaceRole;
};

export type SpaceMembersResult =
  | { ok: true; key: string; members: SpaceMember[]; truncated: boolean }
  | AdminRefusal;

/**
 * Who belongs to one space — **the audited half of this surface's line.**
 *
 * Its own entry point rather than columns on {@link listSpacesForAdmin}, and the whole design is
 * that split: the count ships with every row and costs nothing, while the names are fetched when
 * an admin asks for them and write a `space.access` row when they do. `listBlockingPages`'s shape,
 * for the same reason — folding the two together would audit a page view of the administration
 * index as a read of every private space in the installation.
 *
 * The row is written when the **space resolves**, not when members come back, which is
 * `getReadableSpaceByKey`'s ordering: reading who is in a space is an access to the space whether
 * or not anybody is in it, and an empty result is itself something the admin now knows.
 *
 * `ADMIN`, then `EDITOR`, then `VIEWER` — `role: "desc"` over `SpaceRole`'s declaration order —
 * then by name, then by id so the cut cannot shuffle between two requests.
 */
export async function listSpaceMembers(
  viewer: Viewer,
  spaceId: string,
): Promise<SpaceMembersResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const space = await db.space.findUnique({
    where: { id: spaceId },
    // Explicit select, never `include`. `visibility` is here for `needsAccessAudit` and `key` so
    // the audit row stays readable after a rekey — `accessDetail`'s reasons, unchanged.
    select: { id: true, key: true, visibility: true },
  });
  // The same answer as "you may not look", byte for byte — one shape for a miss and for a refusal.
  if (space === null) return { ok: false, reason: "not-found" };

  await auditSpaceAccess(viewer, space);

  const rows = await db.spaceMembership.findMany({
    where: { spaceId },
    // One more than the cap, so truncation is known without a second count — `search()`'s shape.
    take: MAX_SPACE_MEMBERS + 1,
    orderBy: [{ role: "desc" }, { user: { name: "asc" } }, { userId: "asc" }],
    select: {
      userId: true,
      role: true,
      user: { select: { name: true, email: true } },
    },
  });

  const truncated = rows.length > MAX_SPACE_MEMBERS;
  return {
    ok: true,
    key: space.key,
    members: rows.slice(0, MAX_SPACE_MEMBERS).map((row) => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      role: row.role,
    })),
    truncated,
  };
}

/** One validated input: the value a column gets, or the sentence a form renders. */
type FieldOutcome<T> = { ok: true; value: T } | { ok: false; error: SpaceFieldError };

/**
 * Free text on its way to a column: control characters out, and **no trim**.
 *
 * `src/lib/systems/admin.ts`'s `clean`, unchanged and for the same two reasons — Postgres rejects
 * NUL outright, and a value the admin never typed is a value nobody can search for.
 */
function clean(value: string): string {
  return stripControl(value);
}

function keyField(raw: string): FieldOutcome<string> {
  const validated = validateSpaceKey(clean(raw));
  return validated.ok ? { ok: true, value: validated.key } : { ok: false, error: validated.error };
}

function requiredText(
  field: "name" | "initials",
  label: string,
  raw: string,
  max: number,
): FieldOutcome<string> {
  const value = clean(raw);
  if (value.trim() === "") {
    return {
      ok: false,
      error: { field, code: "empty", message: `Enter ${label.toLowerCase()}.` },
    };
  }
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
  return { ok: true, value };
}

const nameField = (raw: string) =>
  requiredText("name", "A name", raw, TITLE_MAX_LENGTH);

const initialsField = (raw: string) =>
  requiredText("initials", "Initials", raw, SPACE_INITIALS_MAX_LENGTH);

/** The one nullable text column. An empty string is `null`, not `""`. */
function descriptionField(raw: string): FieldOutcome<string | null> {
  const value = clean(raw);
  if (value.length > SPACE_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        field: "description",
        code: "too-long",
        message:
          `A description is at most ${SPACE_DESCRIPTION_MAX_LENGTH} characters; this one is ` +
          `${value.length}.`,
      },
    };
  }
  return { ok: true, value: value === "" ? null : value };
}

/**
 * The `key` is already taken, as a field error rather than a 500.
 *
 * Caught from Postgres rather than pre-checked, `duplicateKey`'s argument in
 * `src/lib/systems/admin.ts`: a pre-check would restate a rule the unique index already enforces
 * and would still be wrong under a race. The sentence can now promise more than the systems one
 * could — since Task 6 the column is lowercase-only, so `Space_key_key` **is** folded uniqueness
 * and there genuinely is no other spelling.
 */
function duplicateKey(key: string): SpaceFieldError {
  return {
    field: "key",
    code: "key-taken",
    message:
      `A space is already keyed "${key}". Keys are unique — and the column is lowercase-only, so ` +
      "this is its only possible spelling.",
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export type SpaceWriteResult =
  | {
      ok: true;
      id: string;
      key: string;
      /** Null unless this request changed the key. */
      renamedFrom: string | null;
      /** Null unless this request changed the visibility — the widening, named. */
      visibilityWas: SpaceVisibility | null;
      members: number;
      pages: number;
    }
  | { ok: false; reason: "invalid"; errors: SpaceFieldError[] }
  | AdminRefusal;

/**
 * Create a space — the first thing in this product other than the seed that does.
 *
 * Every field is reported at once rather than one per round trip, `createSystem`'s reason: one
 * form, five inputs, and a first-error-wins rule would make an admin correct a five-field row five
 * times.
 *
 * **A new space has no members, and that is left true rather than papered over.** The creating
 * super admin is not inserted as an `ADMIN`: they can already do everything in it (`can()`
 * short-circuits on `isSuperAdmin`), so the row would grant nothing, and it would put a person in
 * the member list who is not a member of the team — which is exactly the fact this surface exists
 * to keep accurate. The consequence is real and the surface states it on the row rather than in a
 * one-shot message that scrolls away: a `MEMBERS` space with zero members is readable by super
 * admins alone.
 */
export async function createSpace(
  viewer: Viewer,
  input: SpaceInput,
): Promise<SpaceWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const key = keyField(input.key);
  const name = nameField(input.name);
  const initials = initialsField(input.initials);
  const description = descriptionField(input.description);

  // One condition rather than four, so TypeScript narrows all four below it — and so the caller
  // gets every sentence at once.
  if (!key.ok || !name.ok || !initials.ok || !description.ok) {
    return {
      ok: false,
      reason: "invalid",
      errors: [key, name, initials, description].flatMap((outcome) =>
        outcome.ok ? [] : [outcome.error],
      ),
    };
  }

  const columns = {
    key: key.value,
    name: name.value,
    initials: initials.value,
    description: description.value,
    visibility: input.visibility,
  };

  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.space.create({
        data: columns,
        // Explicit select, never `include`.
        select: { id: true, key: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        // Populated, unlike every `system.*` row: this is an event about a space, and it is the
        // first row in the space's own audit history.
        spaceId: created.id,
        action: "space.create",
        detail: {
          key: columns.key,
          name: columns.name,
          visibility: columns.visibility,
        },
      });

      // Literals rather than counts of tables nothing has had a chance to write to.
      return {
        ok: true as const,
        id: created.id,
        key: created.key,
        renamedFrom: null,
        visibilityWas: null,
        members: 0,
        pages: 0,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, reason: "invalid", errors: [duplicateKey(columns.key)] };
    }
    throw error;
  }
}

/**
 * The refusal a rename meets once the space holds pages.
 *
 * A field error and not a whole-form one, because it is about the `key` input the admin is looking
 * at and the fix is to put the old value back.
 */
function immutableKey(from: string, to: string, pages: number): SpaceFieldError {
  const count = pages === 1 ? "1 page" : `${pages} pages`;
  return {
    field: "key",
    code: "key-immutable",
    message:
      `"${from}" cannot be renamed to "${to}": ${count} live in this space, and the key is in ` +
      "every one of their URLs and is the directory the git mirror wrote their files into. " +
      "Renaming it here would 404 every link anyone has shared and strand a directory in the " +
      "content repository, with nothing in this product reporting either. A key is editable only " +
      "while the space is empty, which is the case it exists for — a typo noticed before anything " +
      "was written.",
  };
}

/**
 * Edit a space — name, initials, description, visibility, and the key **only while it is safe**.
 *
 * ## The key is mutable until the first page, and then it is not
 *
 * Task 5 allowed a `System.key` rename outright, on the ground that refusing would make a key
 * permanent the moment one page named it with **no escape hatch behind it**, while the breakage it
 * causes is loud, bounded and already has a message. Both halves of that argument invert here, and
 * that is why the answer is different:
 *
 * - **The breakage is silent, not loud.** A system rename is caught by `resolveSystems`, which
 *   refuses the next republish with a sentence naming the fix. A *space* rename breaks every URL
 *   anybody has ever shared — this product writes no space-level `Redirect`, `Redirect` being
 *   per-space and per-path — and it strands `content/<old-key>/` in the mirror, because
 *   `GitJobKind` has `MOVE` for a page and nothing for a directory. Neither is reported anywhere.
 *   Nothing in the product would say the space had lost its links.
 * - **The escape hatch exists, and it is the empty space.** A typo is noticed before anything is
 *   published far more often than after, and while `pages` is zero a rename costs nothing at all:
 *   no URL was shared, no mirror file was written. So the rule is the narrowest one that keeps the
 *   hatch open — and it is Task 1's `Restrict` argument in the same shape, *"deletion is the verb
 *   for a row created in error, and a row created in error has no pages naming it"*.
 *
 * **There is a pre-check here, and Task 5 argued against exactly that** — so the divergence needs
 * its reason. `deleteSystem` has none because the foreign key is the authority: a pre-check would
 * be a second statement of a rule the database already enforces, and deleting it would change
 * nothing an assertion could see. Nothing in this schema expresses "a space with pages keeps its
 * key". This check **is** the rule, it is the only statement of it, and removing it is a mutation
 * that fails a test.
 *
 * The window it cannot close is stated rather than hidden: the count is read inside the
 * transaction, and a page committed by another session between the read and the update is not
 * prevented — READ COMMITTED, and page creation takes no lock on the `Space` row. Losing that race
 * costs one page whose mirror file was written under the old key, which is precisely the
 * discrepancy Task 7's reconciliation pass is the operator surface for. Buying exactness would
 * mean locking `Space` on every publish, which is a real cost on the hot path for a race between
 * two administrators.
 */
export async function updateSpace(
  viewer: Viewer,
  spaceId: string,
  patch: SpacePatch,
): Promise<SpaceWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const errors: SpaceFieldError[] = [];
  const data: Prisma.SpaceUpdateInput = {};

  /**
   * Applies one patched field, or collects its sentence. An absent field is one this request is
   * not changing — see {@link SpacePatch}.
   *
   * The closure keeps the rules stated once: these are the same functions {@link createSpace}
   * calls, so a create and an edit cannot disagree about what a legal key or a legal name is.
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
  apply(patch.initials, initialsField, (value) => {
    data.initials = value;
  });
  apply(patch.description, descriptionField, (value) => {
    data.description = value;
  });
  // `visibility` carries no rule of its own: the wire schema has already refused anything outside
  // `SpaceVisibility`. What it carries instead is a *consequence*, recorded below and stated by
  // the surface — it is the field that widens read access without touching a membership row.
  if (patch.visibility !== undefined) data.visibility = patch.visibility;

  if (errors.length > 0) return { ok: false, reason: "invalid", errors };

  try {
    return await db.$transaction(async (tx) => {
      const before = await tx.space.findUnique({
        where: { id: spaceId },
        // Explicit select, never `include`. The counts are read inside the transaction so the
        // number that refuses a rename and the number in the audit row describe the same instant.
        select: {
          key: true,
          name: true,
          visibility: true,
          _count: { select: { memberships: true, pages: true } },
        },
      });
      // The same answer as "you may not look" — one shape for a miss and for a refusal.
      if (before === null) return { ok: false, reason: "not-found" } as const;

      const renamed = typeof data.key === "string" && data.key !== before.key;
      // The rule, stated once and nowhere else — see the docstring for why this is a pre-check
      // where `deleteSystem` deliberately has none.
      if (renamed && before._count.pages > 0) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          errors: [immutableKey(before.key, data.key as string, before._count.pages)],
        };
      }

      const rewritten =
        data.visibility !== undefined && data.visibility !== before.visibility;

      const updated = await tx.space.update({
        where: { id: spaceId },
        data,
        select: { id: true, key: true, name: true, visibility: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        spaceId,
        action: "space.update",
        detail: {
          key: updated.key,
          name: updated.name,
          visibility: updated.visibility,
          // Which columns this request actually wrote.
          fields: Object.keys(data).sort(),
          // Null and not absent when nothing changed, for `previousKey`'s reason: an omitted key
          // and a null one mean different things to anyone querying the column.
          previousKey: renamed ? before.key : null,
          /*
           * The widening, and the only durable record of when this space's `space.access` trail
           * was switched off — `needsAccessAudit` fires for `MEMBERS` spaces alone, so a flip to
           * `ALL_STAFF` silently ends the §8 trail for every super admin who is not a member.
           */
          previousVisibility: rewritten ? before.visibility : null,
          // What the change reached. On a visibility flip this is the number of documents whose
          // audience changed; on a rename it is zero by construction.
          pages: before._count.pages,
        },
      });

      return {
        ok: true as const,
        id: updated.id,
        key: updated.key,
        renamedFrom: renamed ? before.key : null,
        visibilityWas: rewritten ? before.visibility : null,
        members: before._count.memberships,
        pages: before._count.pages,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        reason: "invalid",
        errors: [duplicateKey(typeof data.key === "string" ? data.key : "")],
      };
    }
    throw error;
  }
}

export type MemberWriteResult =
  | {
      ok: true;
      userId: string;
      role: SpaceRole;
      /** What they were before this request, or null when they were not a member. */
      previousRole: SpaceRole | null;
      /**
       * `ADMIN` memberships **after** this request, read inside the same transaction.
       *
       * Zero means nobody in the space can `MANAGE_SPACE` any more. That is not a lockout — a
       * super admin still can, `can()` short-circuiting on `isSuperAdmin` — which is exactly why
       * the last `ADMIN` is removable at all, and why this is a number the surface reports rather
       * than a refusal. Refusing would make the last admin of a space unoffboardable.
       */
      admins: number;
    }
  | { ok: false; reason: "invalid"; errors: SpaceFieldError[] }
  | AdminRefusal;

/**
 * Grant a person access to a space, by the email they sign in with.
 *
 * ## By email, and the email is folded — which is the opposite of the key rule, on purpose
 *
 * `validateSpaceKey` refuses `" handbook"` rather than trimming it, because a key is **stored**
 * and a value the admin never typed is one nobody can search for. An email here is **not stored**:
 * it is a lookup against `User.email`, which `upsertUserFromProfile` already wrote as
 * `profile.email.toLowerCase()`. So folding it is not a silent correction of a stored value, it is
 * asking the question in the form the column answers — and refusing `Aisyah@Example.com` for
 * having a capital letter would be a refusal about nothing.
 *
 * ## A person this product has never seen cannot be added, and that is the honest refusal
 *
 * `User` rows are created at sign-in by `upsertUserFromProfile` and by nothing else, so there is
 * no row to point a membership at until then. Creating one here would mean inventing an identity
 * the identity provider has not confirmed, against a `@unique` email — and the sign-in gate
 * (`isAllowedSignIn`, and the `email_verified` check behind it) is what decides whether that
 * address is staff at all. That decision is not this form's to pre-empt, so the refusal says what
 * has to happen instead.
 */
export async function addSpaceMember(
  viewer: Viewer,
  spaceId: string,
  email: string,
  role: SpaceRole,
): Promise<MemberWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  const wanted = clean(email).trim().toLowerCase();
  if (wanted === "") {
    return {
      ok: false,
      reason: "invalid",
      errors: [
        {
          field: "email",
          code: "empty",
          message: "Enter the email address this person signs in with.",
        },
      ],
    };
  }

  const space = await db.space.findUnique({ where: { id: spaceId }, select: { id: true } });
  if (space === null) return { ok: false, reason: "not-found" };

  const user = await db.user.findUnique({ where: { email: wanted }, select: { id: true } });
  if (user === null) {
    return {
      ok: false,
      reason: "invalid",
      errors: [
        {
          field: "email",
          code: "no-such-user",
          message:
            `Nobody with the address "${wanted}" has signed in to this product yet, so there is ` +
            "no account to add. Membership is granted to a person the system already knows, and " +
            "it learns about people when they sign in — ask them to sign in once, then add them.",
        },
      ],
    };
  }

  try {
    return await db.$transaction(async (tx) => {
      await tx.spaceMembership.create({
        data: { spaceId, userId: user.id, role },
        // Explicit select, never `include` — and `id` only, because nothing here reads the row.
        select: { id: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        spaceId,
        action: "space.member.add",
        // The subject by id, never by email — see `AuditAction`. `role` is the grant itself.
        detail: { userId: user.id, role },
      });

      const admins = await tx.spaceMembership.count({ where: { spaceId, role: "ADMIN" } });
      return { ok: true as const, userId: user.id, role, previousRole: null, admins };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // `SpaceMembership_spaceId_userId_key`. Not pre-checked, `duplicateKey`'s argument.
      return {
        ok: false,
        reason: "invalid",
        errors: [
          {
            field: "email",
            code: "already-a-member",
            message:
              `"${wanted}" is already a member of this space. Change their role in the list ` +
              "instead — adding them again would not tell you what they had before.",
          },
        ],
      };
    }
    throw error;
  }
}

/**
 * Change what a member may do.
 *
 * The action a membership audit trail would otherwise miss entirely: a `VIEWER` promoted to
 * `ADMIN` gains `MANAGE_SPACE` with no row created and none deleted, so add-and-remove alone would
 * show a membership that never changed.
 *
 * **A request that sets the role a member already has writes nothing**, audit row included, and
 * comes back `previousRole === role`. That is not a swallowed mutation — nothing was mutated — and
 * an audit row saying a role changed from `EDITOR` to `EDITOR` is a row that makes the trail
 * harder to read rather than more complete. The result says which happened, so the surface does
 * not have to guess.
 */
export async function setSpaceMemberRole(
  viewer: Viewer,
  spaceId: string,
  userId: string,
  role: SpaceRole,
): Promise<MemberWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  return db.$transaction(async (tx) => {
    const membership = await tx.spaceMembership.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      select: { role: true },
    });
    // One shape for "no such membership", "no such space" and "you may not be here".
    if (membership === null) return { ok: false, reason: "not-found" } as const;

    if (membership.role !== role) {
      await tx.spaceMembership.update({
        where: { spaceId_userId: { spaceId, userId } },
        data: { role },
        select: { id: true },
      });

      await writeAudit(tx, {
        actorId: viewer.id,
        spaceId,
        action: "space.member.role",
        // `previousRole` is never absent — the distinction `previousKey` draws, for the same
        // reason: this row exists to say what the grant *was*.
        detail: { userId, role, previousRole: membership.role },
      });
    }

    // After the write, inside the same transaction, so it describes the state that resulted.
    const admins = await tx.spaceMembership.count({ where: { spaceId, role: "ADMIN" } });
    return {
      ok: true as const,
      userId,
      role,
      previousRole: membership.role,
      admins,
    };
  });
}

/**
 * Revoke a membership.
 *
 * The row is deleted, so **this audit row is the only record that the person was ever a member**,
 * and it carries the role they held — the same standing `system.delete` has, arriving on the
 * mutation that matters most for an offboarding.
 *
 * Removing the last `ADMIN` is allowed and reported, never refused: see
 * {@link MemberWriteResult.admins}.
 */
export async function removeSpaceMember(
  viewer: Viewer,
  spaceId: string,
  userId: string,
): Promise<MemberWriteResult> {
  const refused = refuseNonAdmin(viewer);
  if (refused !== null) return refused;

  return db.$transaction(async (tx) => {
    const membership = await tx.spaceMembership.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
      select: { role: true },
    });
    if (membership === null) return { ok: false, reason: "not-found" } as const;

    await tx.spaceMembership.delete({
      where: { spaceId_userId: { spaceId, userId } },
      select: { id: true },
    });

    await writeAudit(tx, {
      actorId: viewer.id,
      spaceId,
      action: "space.member.remove",
      detail: { userId, role: membership.role },
    });

    const admins = await tx.spaceMembership.count({ where: { spaceId, role: "ADMIN" } });
    return {
      ok: true as const,
      userId,
      role: membership.role,
      previousRole: membership.role,
      admins,
    };
  });
}

/**
 * The wire shapes, and **shape only** — no rule this module owns is repeated here.
 *
 * `src/lib/systems/admin.ts`'s split, unchanged: Zod answers "is this JSON the right sort of
 * object", the field functions above answer "may this be a space", with a `SpaceFieldError` per
 * input that the form renders beside the field.
 *
 * `z.enum(SpaceVisibility)` and `z.enum(SpaceRole)` take Prisma's generated enum objects rather
 * than retyped string arrays, so widening either enum cannot leave these endpoints refusing a
 * value the database accepts.
 *
 * `z.strictObject`, never `z.object` — one word between refusing a typo and stripping it silently.
 */
const BODY_FIELD_MAX = 20_000;
const freeText = z.string().max(BODY_FIELD_MAX);

export const spaceCreateBody = z.strictObject({
  key: freeText,
  name: freeText,
  initials: freeText,
  description: freeText,
  visibility: z.enum(SpaceVisibility),
});

/** An edit is a patch: every field optional, and an absent one is not being changed. */
export const spaceUpdateBody = z.strictObject({
  key: freeText.optional(),
  name: freeText.optional(),
  initials: freeText.optional(),
  description: freeText.optional(),
  visibility: z.enum(SpaceVisibility).optional(),
});

export const memberAddBody = z.strictObject({
  email: freeText,
  role: z.enum(SpaceRole),
});

export const memberRoleBody = z.strictObject({ role: z.enum(SpaceRole) });
