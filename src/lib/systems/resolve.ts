import type { Prisma } from "@prisma/client";

/**
 * Turns the system **keys** an author declared in `systems:` frontmatter into the `System` ids a
 * `PageSystem` row stores — and refuses the publish for a key the catalogue does not have.
 *
 * Phase 3 accepted `systems:`, shape-checked it, and wrote down the failure it was deferring:
 * *"the author writes their systems, publish drops them, and the page ships with an empty facet
 * that nobody can tell apart from a page that declared nothing."* This module is where that
 * becomes reachable, so it is written against that sentence rather than around it.
 *
 * ## Measured before it was decided: the corpus contains no `systems:` at all
 *
 * The rule for an unknown key is a decision about real data, so the data was counted first. In
 * `prisma/seed.ts` no seeded page's markdown has a frontmatter block, and `publishSeedVersion`
 * writes no `frontmatter` column; in the dev database all six published versions carry
 * `frontmatter = {}`, there are no drafts, and `PageSystem` is empty. Every template ships
 * `systems:` with nothing after it, which `listOf` normalises to `[]`.
 *
 * So **no page anywhere declares a system today**, and in particular no page declares one that
 * fails to resolve. That measurement is what makes the strict rule below affordable: nothing has
 * to be migrated, no author has to re-edit a page, and the seed needs no repair. Phase 3's fear —
 * "Phase 7 then arrives to find that every page written in between has to be re-edited" — did not
 * materialise, because nobody wrote one. **Had the corpus held an unresolvable key, the strict
 * rule would have been the wrong one**: it would have made an already-published page
 * unrepublishable until someone edited text they may not own, and "accept and report" would have
 * been the defensible answer. It does not, so it is not.
 *
 * ## An unknown key **refuses the publish**, and the argument against the alternative
 *
 * Phase 3's note lists three options and names two of them: *reject the key*, *ignore it*, and
 * *accept and store it*. "Ignore it" is out — it is the failure the note exists to prevent, and
 * this phase's plan says silently dropping is the one answer that is wrong. That leaves the
 * choice the plan puts to this task: **refuse the publish**, or **accept it and report**.
 *
 * This refuses, for four reasons, in increasing order of how much they decided it:
 *
 * 1. **It is not "reject the key", which is the option Phase 3 declined.** Phase 3 declined
 *    rejecting `systems:` *as a key*, because §7 documents it and Task 4's templates print it —
 *    and that is still true: every template's empty `systems:` publishes, and a page that
 *    declares real systems publishes. What is refused here is a *value that names nothing*,
 *    which is the same thing `supersedes: no-such-page` already gets from `resolveRelations`.
 * 2. **A report on a committed publish is a message nobody has to read.** `publishPage` already
 *    argues this in full for `body-empty`: publish is a single round trip with a boolean outcome,
 *    so "warn" means either a notice with no consequence or a confirm-and-resend handshake, which
 *    is a second control path. `DormantCascade` is not a counterexample — it reports a write that
 *    happened and is correct, not a defect the author still has to fix.
 * 3. **Accept-and-report would make the divergence permanent, not momentary.** Nothing
 *    re-resolves a published version; the facet is rebuilt only when someone republishes. So the
 *    reported key stays missing from `/systems/[key]` for as long as the page lives, and the only
 *    record that it was ever declared is a sentence in a browser tab that has since been closed.
 *    Refusing makes "a published page declares a system that does not exist" **unreachable**,
 *    which is a property of the database rather than a promise about a surface.
 * 4. **It is the same rule Task 1 already chose, and the phase should not answer it twice in
 *    opposite directions.** `PageSystem.systemId` is `onDelete: Restrict` on the argument that
 *    "cascade does not drop a facet; it manufactures a lie" — a document whose text says
 *    `systems: [order-hub]` with no row behind it. Accept-and-report manufactures exactly that
 *    lie, from the authoring side, with one keystroke. A phase that forbids an admin from
 *    creating that state while letting any author create it has not taken a decision, it has
 *    taken half of one.
 *
 * The refusal costs an author nothing they cannot undo: Phase 2's shape is that **a draft accepts
 * what publish refuses**, so every character is kept, and the message carries `key: "systems"`,
 * which `src/lib/editor/publish.ts` already turns into a control that scrolls to and selects the
 * offending line. No new error channel — `PublishFieldError` and `PublishErrorCode` were built to
 * import a module's own codes, and this module's code joins the four already there.
 *
 * ## The author's key is lowercased before the lookup, and that is a decision
 *
 * Task 1's `systems_key_shape` CHECK makes `System.key` lowercase-only, so `systems: [Order-Hub]`
 * cannot match a row **as typed**. Two answers were available: refuse it as a malformed key, or
 * fold the case. This folds it, because on a lowercase-only column `@unique` is *folded*
 * uniqueness — Task 1 says so — and therefore `Order-Hub` can name at most one row and there is
 * nothing to disambiguate. Refusing instead would be this module asserting a second shape rule
 * for a token whose only shape authority is the CHECK, and refusing an author for a capital
 * letter YAML preserved is a poor trade for a guarantee the database already gives.
 *
 * `toLowerCase()` and deliberately **not** `toLocaleLowerCase()`: the latter is locale-dependent,
 * so a Turkish locale would fold `I` to `ı` and two deployments would resolve the same document
 * differently. And deliberately **no trim**: `systemsSchema` already refuses a key with leading
 * or trailing whitespace, so a trim here would be a second normalisation with no case that can
 * reach it — and the `Space.key` lesson is what happens when the same string is normalised in
 * several places by habit. Any fold that leaves a character the CHECK forbids simply matches no
 * row and is refused, which is the honest answer for `systems: [hub core]`.
 *
 * ## Duplicates are collapsed, and an inactive system is still declarable
 *
 * `systems: [order-hub, order-hub]` is not a mistake worth refusing an author for — it is the same
 * statement twice — and it would violate `@@id([pageId, systemId])` on a batch insert. So the
 * keys are deduplicated **after** folding, which is the case that matters:
 * `[Order-Hub, order-hub]` is one system, and a dedupe applied before the fold would not see it.
 * See `replaceSystems` for why `skipDuplicates` is deliberately not the mechanism.
 *
 * **A page may declare a system with `isActive: false`, and that is argued rather than allowed by
 * omission.** `kiosk-bridge` is seeded inactive on purpose, so the case is in the corpus. The
 * lookup is on `key` alone:
 *
 * - The documents that most need the facet are the ones written *about* a retirement. The seeded
 *   ADR `adr-0042-mqtt-topic-naming` already says "Every publisher must be redeployed before the
 *   bridge is removed" — a document that belongs on `/systems/kiosk-bridge` if anything does,
 *   and a decommissioning runbook would be the one page that could not be published.
 * - `isActive` is a **catalogue** state — §7's "active or sunsetting" — not an authoring gate.
 *   Filtering on it here would mean an admin flipping one boolean silently makes every page in
 *   every space that declares that system unpublishable: a catalogue edit with a
 *   permission-shaped consequence, on a table §7 says "carries no permissions of their own".
 * - Rendering the sunsetting state is Task 3's, and it is a presentation question with a page to
 *   put the answer on. This is a resolution question with no surface at all.
 *
 * ## No cap of its own, and the reason is which quantity costs something
 *
 * `relationTargets` is capped at `MAX_RELATION_TARGETS` because each target holds a row lock for
 * the rest of the publish transaction. Nothing here has that shape, and it is worth saying which
 * bound covers which direction rather than adding a constant that bounds neither:
 *
 * - **On success, the work is bounded by the catalogue, not by the document.** Unknown keys are
 *   refused and duplicates are collapsed, so the rows `replaceSystems` writes are at most
 *   `count(System)` — seven today — whatever an author types. A cap of 20 could never bind
 *   before that does.
 * - **On the way in, the input is already bounded.** `MAX_FRONTMATTER_ENTRIES` is 200 across the
 *   whole block and counts *entries*, list items included (Phase 3: "count entries, not keys"),
 *   and `MAX_FRONTMATTER_BYTES` is 16KB. So the widest possible `systems:` is 200 keys, which is
 *   one `IN` list of 200 short strings and one refusal.
 * - **The insert takes a foreign-key `KEY SHARE` lock on each `System` row**, which is the only
 *   lock in this module and conflicts with nothing publish does — no statement in this codebase
 *   takes `FOR UPDATE` on `System`, and Task 5's admin writes are `UPDATE`s outside any publish.
 *
 * `MAX_RELATION_TARGETS`'s docstring is the cautionary tale: two thirds of its stated reasoning
 * went stale and stayed in the file for three tasks. A cap here would have had no reasoning that
 * was true on the day it was written.
 *
 * ## No permission check, stated at the line
 *
 * This module performs **no permission check of any kind**, and the absence is deliberate rather
 * than forgotten — see the notes on `resolveSystems` and `replaceSystems`, each of which says so
 * where the query is. §7: *"Systems are global, not owned by a space, and carry no permissions of
 * their own."* The catalogue is readable by anyone signed in, `PageSystem` is keyed on a page the
 * caller has already authorised under `visiblePage()` and locked, and there is no `Page` row read
 * here for `readableSpace` or `visiblePage` to filter. Phase 5 Task 4 set the precedent that an
 * unexplained exception is how the next reader justifies a second one.
 */

/**
 * Whatever can read the catalogue and write the join. Structural, and the parameter is named
 * `tx` in every signature below for the two reasons `RelationClient` gives: the publish path
 * passes its **transaction** client — resolving against a different snapshot than the write
 * commits into is the bug Phase 5 Task 4 measured — and the sweep in
 * `src/lib/pages/visible.test.ts` matches `db.`/`tx.` delegate calls, so a parameter named
 * `client` would hide three statements from it.
 */
export type SystemClient = Pick<Prisma.TransactionClient, "system" | "pageSystem">;

export type SystemRefusalCode =
  /**
   * A declared key names no row in the catalogue. One code, not one per key: the author wrote one
   * `systems:` line and fixes it in one edit, so every unresolved key travels in a single
   * refusal — see `refusalFor`.
   */
  "unknown-system";

/**
 * `field` + `key` + `code` + `message`, the shape `FrontmatterKeyError` established and
 * `RelationRefusal` follows.
 *
 * `key` is the literal `"systems"` rather than a `string`, because there is exactly one
 * frontmatter key this module can be about, and the narrower type is what lets a caller — and
 * `src/lib/editor/publish.ts`'s line finder — know the value is a key that appears in the
 * document. `field` is `"markdown"` because frontmatter has no input of its own.
 *
 * A parallel type rather than a widened `FrontmatterKeyError`, for the reason that type is a
 * parallel of `FieldError`: the code is this module's, and a shared union would let a caller
 * switch on a code it can never see. It is structurally a `PublishFieldError`, so nothing is
 * mapped on the way through `invalidAll`.
 */
export type SystemRefusal = {
  field: "markdown";
  key: "systems";
  code: SystemRefusalCode;
  /**
   * Every declared key that resolved to nothing, folded as it was looked up and in the order the
   * author wrote them. Carried beside the message for the same reason `RelationRefusal.ref` is:
   * a surface that wants to underline the offending words should not have to parse a sentence.
   */
  unknown: string[];
  message: string;
};

export type SystemResolution =
  | {
      ok: true;
      /**
       * One id per distinct declared system, in the order the author declared them.
       *
       * Deterministic on purpose even though `PageSystem` has no ordering column: a test that
       * asserts the ids can then assert a list rather than a set, and a resolution that started
       * returning the database's arbitrary `findMany` order would be a difference no assertion
       * could name.
       */
      systemIds: string[];
    }
  /**
   * A one-element tuple, and that is not an oversight. The three modules publish already calls
   * return *every* error because an author writes several keys in one pass; `systems:` is **one**
   * key with one fix, so its refusal names every unresolved value in one sentence instead of
   * emitting one error per value — which would also let a 200-key list produce 200 messages.
   * Non-empty by construction, so `invalidAll`'s tuple is satisfied by the compiler.
   */
  | { ok: false; errors: [SystemRefusal] };

/**
 * The author's key as it will be looked up.
 *
 * Exported for its own unit assertions rather than for callers: the fold is a *decision* (see the
 * module docstring) and a decision with no test is a habit. `toLowerCase`, never
 * `toLocaleLowerCase` — the locale-sensitive form would resolve the same document differently in
 * two deployments.
 */
export function foldSystemKey(key: string): string {
  return key.toLowerCase();
}

/**
 * The sentence for keys that named nothing, listing the catalogue so the author can fix it from
 * the message.
 *
 * The available keys are read on the refusal path only — one query over an admin-curated list of
 * deployables, seven rows today — and they are listed rather than linked because `/systems` does
 * not exist until Task 3 and a message must not name a route that answers 404. Inactive systems
 * are listed too, because a page may declare one; that is the same decision the lookup takes.
 */
function refusalFor(unknown: string[], available: string[]): SystemRefusal {
  const plural = unknown.length === 1 ? "is not a system" : "are not systems";
  return {
    field: "markdown",
    key: "systems",
    code: "unknown-system",
    unknown,
    message:
      `${unknown.map((key) => `\`${key}\``).join(", ")} ${plural} in the catalogue. ` +
      `The systems you can declare are: ${available.join(", ")}. ` +
      "System keys are refused rather than ignored, because a dropped system looks exactly " +
      "like one that was never written — the page would ship with an empty facet and nothing " +
      "would say so. Fix the spelling, remove the key, or ask an admin to add the system.",
  };
}

/**
 * Which catalogue rows these declared keys name — spec §9 step 3's *decision* half.
 *
 * Called before anything is written, like every other decision in `publishPage`: a refusal inside
 * `$transaction` is a `return`, and returning **commits**, so a refusal computed after the
 * version insert could only abort by throwing.
 *
 * ## One query, and a second only on a refusal
 *
 * The keys are batched into one `key IN (...)`, which the `@unique` index on `System.key` serves
 * on its own — Task 1's schema says that index is why this table needs no other. There is no
 * per-key round trip to bound, which is half of why this module adds no cap.
 *
 * ## No permission predicate, and no soft-delete filter
 *
 * Neither exists to be stated. `System` has no `spaceId`, no `visibility` and no `deletedAt`;
 * §7 makes it global and permissionless, and Task 1's schema says the table "must never be given
 * the chance to look as if it does" contribute to a permission filter. `readableSpace` and
 * `visiblePage` return complete `where` objects for `Space` and `Page` respectively and there is
 * neither here — so this is not the `resolveRedirect` shape (a predicate stated twice), it is a
 * table with no predicate to state. The readability question `/systems/[key]` has to answer is
 * about the **pages** it lists, and Task 3 answers it there.
 */
export async function resolveSystems(
  tx: SystemClient,
  args: { declared: readonly string[] },
): Promise<SystemResolution> {
  // Folded first, then deduplicated — `[Order-Hub, order-hub]` is one system, and a `Set` built
  // before the fold would not see that. A `Set` preserves insertion order, so the author's own
  // declaration order survives to `systemIds`.
  const wanted = [...new Set(args.declared.map(foldSystemKey))];
  // Not merely an optimisation: with nothing declared there is no `IN` list to build, and this is
  // the common case — every template ships `systems:` empty.
  if (wanted.length === 0) return { ok: true, systemIds: [] };

  const rows = await tx.system.findMany({
    // `key`, and deliberately not `isActive` — a page may declare a sunsetting system, argued in
    // the module docstring. Adding `isActive: true` here is the mutation that decision exists to
    // refuse, and it has a test.
    where: { key: { in: wanted } },
    // Explicit select, never `include`.
    select: { id: true, key: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.id]));

  const systemIds: string[] = [];
  const unknown: string[] = [];
  for (const key of wanted) {
    const id = byKey.get(key);
    if (id === undefined) unknown.push(key);
    else systemIds.push(id);
  }

  if (unknown.length > 0) {
    const available = await tx.system.findMany({
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return { ok: false, errors: [refusalFor(unknown, available.map((row) => row.key))] };
  }

  return { ok: true, systemIds };
}

/**
 * Makes the `PageSystem` rows for this page **exactly** the ones the frontmatter declares — spec
 * §9 step 3's write half.
 *
 * ## Re-resolution, not accumulation, and it is the half that gets forgotten
 *
 * An author who removes a system and republishes is saying the page no longer affects it. Leaving
 * the row would make the frontmatter and the database disagree with no way to tell which is
 * right — and `/systems/[key]` reads the database, so the system's page would go on listing a
 * document that no longer mentions it. That is the same objection Task 1 raised against
 * `onDelete: Cascade`, from the other direction: not a lost label, a manufactured one.
 *
 * Safe to run unconditionally because `ValidatedFrontmatter.systems` always carries a value —
 * `[]` where nothing was declared, never `undefined` — so "declared nothing" and "did not mention
 * the key" are the same input and neither ever means "leave the rows alone".
 *
 * ## Delete-all-then-insert-all, where `replaceRelations` uses a `NOT`
 *
 * The difference is argued rather than copied. `replaceRelations` excludes surviving edges from
 * its delete so that an unchanged row keeps its `createdAt`, which Task 9 renders on a retired
 * page's banner as "superseded on…". **`PageSystem` has no payload at all** — Task 1's schema
 * says it "is exactly its two keys", which is why it has a composite primary key and no surrogate
 * id — so there is nothing a surviving row could preserve, and a delete keyed on `pageId` alone
 * is served by the leading column of that primary key. Task 1 named this statement in as many
 * words: "the `deleteMany({ where: { pageId } })` that Task 2's re-resolve does inside the
 * publish transaction".
 *
 * ## No `skipDuplicates`, deliberately
 *
 * After a delete keyed on `pageId` no row can survive to conflict, and `resolveSystems` has
 * already collapsed the author's duplicates. So `skipDuplicates: true` would guard nothing that
 * can happen — and it would guard the one thing that must not pass silently: with it, deleting
 * the dedupe would leave the suite green, and a test for `[order-hub, order-hub]` would be testing
 * `ON CONFLICT` rather than the dedupe it names. Without it that mutation dies on
 * `@@id([pageId, systemId])`.
 *
 * ## No permission predicate and no soft-delete filter, both deliberate
 *
 * Every statement is keyed on `pageId` — the page `publishPage` has already authorised under
 * `visiblePage({ space: readableSpace(viewer) })` and locked — and every `systemId` came from
 * `resolveSystems`, which read a table that carries no permissions. There is no `Page` row read
 * or written here, and no `page:` relation filter: a `visiblePage()` on either statement would be
 * the `resolveRedirect` mistake, a predicate stated twice with one copy untestable. This is the
 * same argument `src/lib/git/enqueue.ts` makes for the same shape, and it is why this module is
 * registered `reachesPage: false` in `src/lib/pages/visible.test.ts`. The insert does take a
 * foreign-key `KEY SHARE` lock on the `Page` row and on each `System` row, which is not a read:
 * it returns no column and applies no predicate.
 *
 * The publish's own write predicate is what covers a soft delete arriving mid-transaction — the
 * `updateMany` above this call in `publishPage` matches nothing and throws
 * `PageNoLongerPublishable`, rolling these rows back with everything else.
 */
export async function replaceSystems(
  tx: SystemClient,
  args: { pageId: string; systemIds: readonly string[] },
): Promise<void> {
  const { pageId } = args;

  await tx.pageSystem.deleteMany({ where: { pageId } });

  if (args.systemIds.length > 0) {
    await tx.pageSystem.createMany({
      data: args.systemIds.map((systemId) => ({ pageId, systemId })),
    });
  }
}
