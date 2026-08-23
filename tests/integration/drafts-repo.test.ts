import { beforeEach, expect, test } from "vitest";
import { db, resetDb } from "../setup/reset";
import { saveDraft } from "@/lib/drafts/repo";
import type { SaveDraftResult } from "@/lib/drafts/repo";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Every field gets a value nothing else in the fixture shares. Phase 1 learned that a
 * fixture whose fields all default to the same string cannot catch a field mix-up — a
 * `title`/`markdown` swap in the repository would be invisible against `"x"` and `"x"`.
 */
async function fixture(visibility: "MEMBERS" | "ALL_STAFF" = "MEMBERS") {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
  });
  const budi = await db.user.create({
    data: { email: "budi@example.com", name: "Budi S." },
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
      createdById: aisyah.id,
      status: "CURRENT",
    },
  });
  const version = await db.pageVersion.create({
    data: {
      pageId: page.id,
      title: "MQTT contracts",
      markdown: "## Topics\n\nOne namespace.",
      status: "CURRENT",
      authorId: aisyah.id,
    },
  });
  await db.page.update({
    where: { id: page.id },
    data: { publishedVersionId: version.id, publishedAt: new Date() },
  });

  for (const [user, role] of [
    [aisyah, "EDITOR"],
    [budi, "EDITOR"],
  ] as const) {
    await db.spaceMembership.create({
      data: { spaceId: space.id, userId: user.id, role },
    });
  }

  const editor = (user: { id: string }, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: user.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    page,
    version,
    aisyah,
    budi,
    asAisyah: editor(aisyah, "EDITOR"),
    asBudi: editor(budi, "EDITOR"),
  };
}

/** Narrows a result to the success branch, failing with the actual result if it is not. */
function saved(result: SaveDraftResult) {
  if (!result.ok) throw new Error(`expected a save, got ${JSON.stringify(result)}`);
  return result;
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

test("the first save creates the draft and returns the timestamp for the next one", async () => {
  const { page, asAisyah } = await fixture();

  const result = saved(
    await saveDraft(asAisyah, page.id, {
      title: "MQTT contracts, revised",
      markdown: "One namespace, two brokers.",
      seen: null,
    }),
  );

  expect(result.created).toBe(true);
  expect(result.draft.title).toBe("MQTT contracts, revised");
  expect(result.draft.markdown).toBe("One namespace, two brokers.");

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.title).toBe("MQTT contracts, revised");
  expect(row.markdown).toBe("One namespace, two brokers.");
  expect(row.updatedAt.getTime()).toBe(result.draft.updatedAt.getTime());
});

/**
 * The base version is only knowable at the moment the draft is opened; afterwards a publish
 * moves `publishedVersionId` on and the link is gone. Kills a create that leaves it null.
 */
test("a new draft records the published version it departs from", async () => {
  const { page, version, asAisyah } = await fixture();
  await saveDraft(asAisyah, page.id, { title: "T", markdown: "M", seen: null });

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.baseVersionId).toBe(version.id);
  expect(row.updatedById).toBe(asAisyah.id);
});

/**
 * The round trip the whole contract rests on: what a save returns is exactly what the next
 * save must send. Kills a repository that returns a stale timestamp, or the row's
 * `createdAt` in place of its `updatedAt` — either would make the second save conflict.
 */
test("the timestamp a save returns is the one the next save must send", async () => {
  const { page, asAisyah } = await fixture();
  const first = saved(
    await saveDraft(asAisyah, page.id, { title: "One", markdown: "First", seen: null }),
  );

  const second = saved(
    await saveDraft(asAisyah, page.id, {
      title: "Two",
      markdown: "Second",
      seen: first.draft.updatedAt,
    }),
  );

  expect(second.created).toBe(false);
  expect(second.draft.markdown).toBe("Second");
  expect(second.draft.updatedAt.getTime()).toBeGreaterThan(first.draft.updatedAt.getTime());

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.title).toBe("Two");
  expect(row.markdown).toBe("Second");
});

/**
 * The ordinary two-editor case. Kills a comparison that lets a stale `seen` through, and
 * kills any implementation that writes first and reports the conflict afterwards — the row
 * assertion is what proves the refusal happened before the write, not after it.
 */
test("a stale seen is refused with the other editor's name, timestamp and both texts", async () => {
  const { page, asAisyah, asBudi } = await fixture();
  const mine = saved(
    await saveDraft(asAisyah, page.id, {
      title: "Aisyah's title",
      markdown: "Aisyah's paragraph.",
      seen: null,
    }),
  );

  const theirs = saved(
    await saveDraft(asBudi, page.id, {
      title: "Budi's title",
      markdown: "Budi's paragraph.",
      seen: mine.draft.updatedAt,
    }),
  );

  // Aisyah still holds the timestamp from before Budi saved.
  const result = await saveDraft(asAisyah, page.id, {
    title: "Aisyah's second title",
    markdown: "Aisyah's second paragraph.",
    seen: mine.draft.updatedAt,
  });

  expect(result).toEqual({
    ok: false,
    reason: "conflict",
    theirs: {
      title: "Budi's title",
      markdown: "Budi's paragraph.",
      updatedAt: theirs.draft.updatedAt,
      editorName: "Budi S.",
    },
    mine: {
      title: "Aisyah's second title",
      markdown: "Aisyah's second paragraph.",
    },
  });

  // Never silently overwrites: Budi's text is still what the row holds.
  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe("Budi's paragraph.");
});

/**
 * The case the plan singles out, asserted against the database rather than only against
 * `decideSave`. A client that sends no `seen` while a draft exists has lost track; treating
 * that as a first save destroys the other editor's work with no trace.
 *
 * Kills: `decideSave` returning `update` for a null `seen`, and any repository that decides
 * "create or update" from the row's existence instead of from the decision.
 */
test("a missing seen against an existing draft conflicts and leaves the row untouched", async () => {
  const { page, asAisyah, asBudi } = await fixture();
  const existing = saved(
    await saveDraft(asBudi, page.id, {
      title: "Budi's title",
      markdown: "Budi's paragraph.",
      seen: null,
    }),
  );

  const result = await saveDraft(asAisyah, page.id, {
    title: "Overwrite attempt",
    markdown: "Overwrite attempt body.",
    seen: null,
  });

  expect(result.ok).toBe(false);
  if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
  expect(result.theirs?.editorName).toBe("Budi S.");
  expect(result.theirs?.markdown).toBe("Budi's paragraph.");
  expect(result.mine.markdown).toBe("Overwrite attempt body.");

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe("Budi's paragraph.");
  expect(row.title).toBe("Budi's title");
  expect(row.updatedAt.getTime()).toBe(existing.draft.updatedAt.getTime());
});

/**
 * Two saves landing together, asserted on the outcome and never on which one arrived first.
 * Exactly one must win: both winning is the lost update the `updatedAt` predicate exists to
 * prevent, and both losing would mean the endpoint discards work under load.
 *
 * Kills: comparing timestamps with `>=`, which lets the later reader treat a moved-on row as
 * its own and both saves succeed. It does NOT reliably kill a missing `updatedAt` in the
 * update's `where`: the pool staggers the two page reads, so `decideSave` refuses the loser
 * before the predicate is reached. The test below stages that interleaving on purpose.
 */
test("two saves racing on the same seen: exactly one wins and the other conflicts", async () => {
  const { page, asAisyah, asBudi } = await fixture();
  const base = saved(
    await saveDraft(asAisyah, page.id, { title: "Base", markdown: "Base body.", seen: null }),
  );

  const results = await Promise.all([
    saveDraft(asAisyah, page.id, {
      title: "Aisyah",
      markdown: "Aisyah body.",
      seen: base.draft.updatedAt,
    }),
    saveDraft(asBudi, page.id, {
      title: "Budi",
      markdown: "Budi body.",
      seen: base.draft.updatedAt,
    }),
  ]);

  const wins = results.filter((r) => r.ok);
  const losses = results.filter((r) => !r.ok);
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);

  const winner = saved(wins[0]!);
  const loser = losses[0]!;
  if (loser.ok || loser.reason !== "conflict") throw new Error("expected a conflict");

  // The row holds the winner's text, and the loser was handed exactly that text back — so
  // the refusal describes the state that actually won, not a snapshot from before the race.
  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe(winner.draft.markdown);
  expect(loser.theirs?.markdown).toBe(winner.draft.markdown);
  expect(loser.theirs?.updatedAt.getTime()).toBe(winner.draft.updatedAt.getTime());
  expect(loser.mine.markdown).not.toBe(winner.draft.markdown);
});

/**
 * The `Promise.all` test above proves the contract but cannot prove *where* it is enforced:
 * with a real connection pool the two saves reliably stagger, so the loser's page read
 * already sees the winner's timestamp and `decideSave` refuses it before the write predicate
 * is ever consulted. Measured — with `updatedAt` deleted from the update's `where`, that
 * test still passed five runs out of five.
 *
 * So the interleaving the predicate exists for is staged deliberately: another editor's
 * UPDATE takes the row lock and is held open, `saveDraft` then reads the *pre-update* row
 * (MVCC, so the SELECT does not block) and decides "update" on a timestamp that is about to
 * stop being true, and its own UPDATE blocks until the other commits. Postgres re-evaluates
 * the predicate against the new row version at that point, which is the whole guarantee.
 *
 * Kills: dropping `updatedAt` from the update's `where` — without it the unblocked UPDATE
 * matches on `pageId` alone and silently overwrites a commit this save never saw. Also kills
 * a read-then-write implementation, whose re-read would happen before the lock is released.
 *
 * The waits stage the interleaving; nothing is asserted about them. A wait that is too short
 * only makes the test agree with the one above, never makes a broken predicate pass.
 */
test("a save that decided update is still refused if the row changes before its write lands", async () => {
  const { page, asAisyah, budi } = await fixture();
  const base = saved(
    await saveDraft(asAisyah, page.id, { title: "Base", markdown: "Base body.", seen: null }),
  );

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Raw, because this has to hold an uncommitted row lock open — an interactive transaction
  // is the only way to sit between another writer's UPDATE and its COMMIT.
  const other = db.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE "PageDraft"
        SET "markdown" = 'Budi body.', "title" = 'Budi', "updatedById" = ${budi.id},
            "updatedAt" = now()
        WHERE "pageId" = ${page.id}`;
      await held;
    },
    { timeout: 20_000, maxWait: 20_000 },
  );

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  await settle(); // the UPDATE above has taken the row lock

  const racing = saveDraft(asAisyah, page.id, {
    title: "Aisyah",
    markdown: "Aisyah body.",
    seen: base.draft.updatedAt,
  });

  await settle(); // `racing` has read the old row, decided "update", and is now blocked

  release();
  await other;
  const result = await racing;

  expect(result.ok).toBe(false);
  if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
  expect(result.theirs?.editorName).toBe("Budi S.");
  expect(result.theirs?.markdown).toBe("Budi body.");
  expect(result.mine.markdown).toBe("Aisyah body.");

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe("Budi body.");
});

/**
 * The same race on the create path, which gets its atomicity from the primary key rather
 * than from a `where`. Kills a create that swallows the unique violation, and one that lets
 * the exception escape as a 500 instead of the 409 the contract promises.
 */
test("two first saves racing: one creates the draft and the other conflicts", async () => {
  const { page, asAisyah, asBudi } = await fixture();

  const results = await Promise.all([
    saveDraft(asAisyah, page.id, { title: "Aisyah", markdown: "Aisyah body.", seen: null }),
    saveDraft(asBudi, page.id, { title: "Budi", markdown: "Budi body.", seen: null }),
  ]);

  const wins = results.filter((r) => r.ok);
  expect(wins).toHaveLength(1);
  expect(saved(wins[0]!).created).toBe(true);

  const loser = results.find((r) => !r.ok)!;
  if (loser.ok || loser.reason !== "conflict") throw new Error("expected a conflict");
  expect(loser.theirs?.markdown).toBe(saved(wins[0]!).draft.markdown);

  expect(await db.pageDraft.count()).toBe(1);
});

test("a VIEWER cannot save a draft, and nothing is written", async () => {
  const { space, page, budi } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: budi.id } },
    data: { role: "VIEWER" },
  });
  const asViewer: Viewer = {
    id: budi.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  };

  expect(await saveDraft(asViewer, page.id, { title: "T", markdown: "M", seen: null })).toEqual(
    { ok: false, reason: "forbidden" },
  );
  expect(await db.pageDraft.count()).toBe(0);
});

/**
 * 404-not-403 is a security property here, not a preference: a non-member who gets
 * "forbidden" has learned that the page exists. Asserted as `toEqual` against the answer for
 * a page id that was never real, so the two shapes cannot drift apart.
 */
test("a non-member gets the not-found shape, identical to a page that does not exist", async () => {
  const { page } = await fixture("MEMBERS");
  const input = { title: "T", markdown: "M", seen: null };

  const real = await saveDraft(stranger, page.id, input);
  const imaginary = await saveDraft(stranger, "does-not-exist", input);

  expect(real).toEqual({ ok: false, reason: "not-found" });
  expect(real).toEqual(imaginary);
  expect(await db.pageDraft.count()).toBe(0);
});

/**
 * The other half of that rule, and the reason `not-found` cannot simply be returned for
 * every refusal. In an ALL_STAFF space the stranger can already read the page, so
 * "forbidden" tells them nothing they did not know — and answering `not-found` here would
 * be a lie the editor UI cannot act on.
 */
test("a non-member of an all-staff space is forbidden, not not-found", async () => {
  const { page } = await fixture("ALL_STAFF");

  expect(await saveDraft(stranger, page.id, { title: "T", markdown: "M", seen: null })).toEqual(
    { ok: false, reason: "forbidden" },
  );
  expect(await db.pageDraft.count()).toBe(0);
});

test("a super admin who belongs to nothing can save", async () => {
  const { page } = await fixture("MEMBERS");
  const root: Viewer = { id: "", isSuperAdmin: true, memberships: [] };
  const rootUser = await db.user.create({
    data: { email: "efcorporates@gmail.com", name: "Fahmi D.", isSuperAdmin: true },
  });

  const result = saved(
    await saveDraft(
      { ...root, id: rootUser.id },
      page.id,
      { title: "Root", markdown: "Root body.", seen: null },
    ),
  );
  expect(result.created).toBe(true);
});

/**
 * A soft-deleted page is gone for writes as well as reads, and gone in the same shape — an
 * editor who could save it a moment ago now gets exactly what a stranger gets. Kills a
 * `saveDraft` that omits `visiblePage()` from its page lookup.
 */
test("a soft-deleted page is not saveable, and answers not-found even to its editor", async () => {
  const { page, asAisyah } = await fixture();
  const input = { title: "T", markdown: "M", seen: null };
  expect(saved(await saveDraft(asAisyah, page.id, input)).created).toBe(true);
  await db.pageDraft.delete({ where: { pageId: page.id } });

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(await saveDraft(asAisyah, page.id, input)).toEqual({
    ok: false,
    reason: "not-found",
  });
  expect(await db.pageDraft.count()).toBe(0);
});

/**
 * A page soft-deleted while an editor still holds a draft: the update path must refuse it
 * too, not just the create path. Kills a `visiblePage()` applied to the initial lookup but
 * dropped from the write.
 */
test("a soft-deleted page with an existing draft is not updatable", async () => {
  const { page, asAisyah } = await fixture();
  const first = saved(
    await saveDraft(asAisyah, page.id, { title: "Live", markdown: "Live body.", seen: null }),
  );

  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });

  expect(
    await saveDraft(asAisyah, page.id, {
      title: "After",
      markdown: "After body.",
      seen: first.draft.updatedAt,
    }),
  ).toEqual({ ok: false, reason: "not-found" });

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe("Live body.");
});
