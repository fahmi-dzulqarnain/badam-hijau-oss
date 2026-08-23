import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { saveOutcome } from "@/lib/editor/save";
import { editorReducer, initialEditorState } from "@/lib/editor/state";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

/**
 * Every field gets a value nothing else in the fixture shares, so a `title`/`markdown` swap
 * anywhere between the JSON body and the row cannot hide behind two identical strings.
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
  for (const user of [aisyah, budi]) {
    await db.spaceMembership.create({
      data: { spaceId: space.id, userId: user.id, role: "EDITOR" },
    });
  }

  const as = (user: { id: string }, role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: user.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return {
    space,
    page,
    aisyah,
    budi,
    asAisyah: as(aisyah, "EDITOR"),
    asBudi: as(budi, "EDITOR"),
  };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/**
 * Loads the route with a given signed-in viewer. `doUnmock` is not ceremony: `resetModules`
 * clears the module registry but leaves the MOCK registry standing, so without it the one
 * test below that stubs the repository would silently stub it for every test declared after.
 */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doUnmock("@/lib/drafts/repo");
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/drafts/[pageId]/route")).PUT;
}

type Body = { title: string; markdown: string; seen: string | null };

function put(pageId: string, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  const request = new Request(`http://localhost/api/drafts/${pageId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).length),
      ...headers,
    },
    body: payload,
  });
  return [request, { params: Promise.resolve({ pageId }) }] as const;
}

const draft = (over: Partial<Body> = {}): Body => ({
  title: "MQTT contracts, revised",
  markdown: "One namespace, two brokers.",
  seen: null,
  ...over,
});

// --- size and shape, before anything is read -------------------------------------------

/**
 * The rejection a numeric-only cap cannot make. A chunked request omits `Content-Length`
 * entirely and `Number(null)` is 0, which slides under every `> MAX` comparison.
 *
 * Kills: replacing the null check with `Number(request.headers.get("content-length")) > MAX`.
 */
test("411 when no Content-Length is declared", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const [request, ctx] = put(page.id, draft());
  // Request() computes a length for a string body, so strip it to model a chunked send.
  request.headers.delete("content-length");

  expect((await PUT(request, ctx)).status).toBe(411);
  expect(await db.pageDraft.count()).toBe(0);
});

/** The cap is on the DECLARED length, so this is refused without the body being parsed. */
test("413 on an oversized declared length, before the body is read", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const response = await PUT(...put(page.id, draft(), { "content-length": "99999999" }));
  expect(response.status).toBe(413);
  expect(await db.pageDraft.count()).toBe(0);
});

test("413 on a Content-Length that is not a positive integer", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  for (const length of ["-1", "0", "not-a-number", "1e9"]) {
    const response = await PUT(...put(page.id, draft(), { "content-length": length }));
    expect(response.status, `content-length: ${length}`).toBe(413);
  }
});

test("401 when nobody is signed in", async () => {
  const { page } = await fixture();
  const PUT = await routeAs(null);

  expect((await PUT(...put(page.id, draft()))).status).toBe(401);
  expect(await db.pageDraft.count()).toBe(0);
});

test("400 when the body omits seen, rather than reading the omission as null", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const response = await PUT(...put(page.id, { title: "T", markdown: "M" }));
  expect(response.status).toBe(400);
  expect(await db.pageDraft.count()).toBe(0);
});

test("400 on a body that is not JSON at all", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const request = new Request(`http://localhost/api/drafts/${page.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "content-length": "3" },
    body: "{ [",
  });
  const response = await PUT(request, { params: Promise.resolve({ pageId: page.id }) });
  expect(response.status).toBe(400);
});

// --- the happy path, and the round trip the contract rests on ---------------------------

test("201 on the first save, 200 on the next", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const created = await PUT(...put(page.id, draft()));
  expect(created.status).toBe(201);
  const first = await created.json();
  expect(first.title).toBe("MQTT contracts, revised");
  expect(first.markdown).toBe("One namespace, two brokers.");

  const updated = await PUT(
    ...put(page.id, draft({ title: "Second title", markdown: "Second body.", seen: first.updatedAt })),
  );
  expect(updated.status).toBe(200);

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.title).toBe("Second title");
  expect(row.markdown).toBe("Second body.");
  expect(row.updatedById).toBe(asAisyah.id);
});

/**
 * The property everything else in this endpoint rests on: **what a save returns is exactly
 * what the next save has to send.** Chained three deep, because a single hop can pass by
 * accident — a handler echoing the request's own `seen` gets the second save right whenever
 * the first happened to be an update.
 *
 * Kills: returning `parsed.data.seen` instead of `result.draft.updatedAt` (the first
 * response then carries `null`, and the second save conflicts); returning the row's
 * `createdAt`; and any serialisation that loses milliseconds — the column is `TIMESTAMP(3)`
 * and a truncation to whole seconds makes every save after the first a 409.
 */
test("the updatedAt a save returns is exactly what the next save must send", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  let seen: string | null = null;
  const stamps: string[] = [];

  for (const n of ["one", "two", "three"]) {
    const response = await PUT(...put(page.id, draft({ title: n, markdown: `body ${n}`, seen })));
    expect(response.status, `save "${n}" was refused`).toBe(n === "one" ? 201 : 200);

    const body = await response.json();
    expect(typeof body.updatedAt).toBe("string");
    seen = body.updatedAt;
    stamps.push(body.updatedAt as string);
  }

  // Each hop returned a NEW timestamp, so the round trip is carrying the row forward rather
  // than a constant that happens to satisfy the comparison.
  expect(new Set(stamps).size).toBe(3);

  // And the last one names the row's real state, to the millisecond.
  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.updatedAt.toISOString()).toBe(stamps[2]);
  expect(row.markdown).toBe("body three");
});

// --- refusals ---------------------------------------------------------------------------

test("409 on a stale seen, carrying the other editor's work and the caller's own", async () => {
  const { page, asAisyah, asBudi } = await fixture();

  const asAisyahRoute = await routeAs(asAisyah);
  const mine = await (
    await asAisyahRoute(...put(page.id, draft({ title: "Aisyah's title", markdown: "Aisyah's paragraph." })))
  ).json();

  const asBudiRoute = await routeAs(asBudi);
  const theirs = await (
    await asBudiRoute(
      ...put(page.id, draft({ title: "Budi's title", markdown: "Budi's paragraph.", seen: mine.updatedAt })),
    )
  ).json();

  // Aisyah still holds the timestamp from before Budi saved.
  const again = await routeAs(asAisyah);
  const response = await again(
    ...put(page.id, draft({ title: "Aisyah's second title", markdown: "Aisyah's second paragraph.", seen: mine.updatedAt })),
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "conflict",
    theirs: {
      title: "Budi's title",
      markdown: "Budi's paragraph.",
      updatedAt: theirs.updatedAt,
      editorName: "Budi S.",
    },
    mine: {
      title: "Aisyah's second title",
      markdown: "Aisyah's second paragraph.",
    },
  });

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe("Budi's paragraph.");
});

/**
 * The `vanished` sequence end to end through the real repository, which is how Task 9's
 * publish will present it: a draft exists, the editor is holding its `updatedAt`, the row is
 * deleted, and the next autosave arrives carrying the stale receipt.
 *
 * Asserted on the whole body, because the shape is the contract the editor is already built
 * against: `error: "conflict"` with a null `theirs` is what makes it render the one-action
 * banner instead of "Keep mine" / "Load theirs", and `mine` is what makes "your text is
 * below" true.
 *
 * Kills: `decideSave` answering `create` for a null `current` — with that, this is a 201 and
 * a resurrected row, which the final assertion checks for directly.
 */
test("409 with theirs: null for a save whose draft was deleted, and nothing is written", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const created = await PUT(...put(page.id, draft()));
  expect(created.status).toBe(201);
  const { updatedAt } = await created.json();

  // Stands in for Task 9's publish, which deletes the draft inside its transaction.
  await db.pageDraft.delete({ where: { pageId: page.id } });

  const mine = draft({
    title: "Typed after the publish",
    markdown: "Typed after the publish, and never saved.",
    seen: updatedAt,
  });
  const response = await PUT(...put(page.id, mine));

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "conflict",
    theirs: null,
    mine: { title: mine.title, markdown: mine.markdown },
  });
  expect(await db.pageDraft.count()).toBe(0);
});

/**
 * The recovery the editor actually offers, driven by the editor's own modules against the
 * real endpoint. `saveOutcome` and `editorReducer` are pure and unit-tested either side of
 * this, but nothing else joins them to a second real request — and "dismiss, then save"
 * failing is a silent trap: the person keeps typing into a tab that will never store a
 * character again.
 *
 * Kills: a `dismissed` that leaves `seen` in place (every later save 409s forever), and a
 * `vanished` implemented as a permanent refusal for the page rather than a decision about
 * the two values in front of it.
 */
test("the editor's dismiss-and-save path recovers the text into a fresh draft", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const created = await PUT(...put(page.id, draft()));
  const { updatedAt } = await created.json();
  await db.pageDraft.delete({ where: { pageId: page.id } });

  const mine = { title: "Rescued title", markdown: "Rescued paragraph." };
  const refused = await PUT(...put(page.id, { ...mine, seen: updatedAt }));
  expect(refused.status).toBe(409);

  // Exactly what the component does with that response: map it to an action, reduce it, and
  // then reduce the one button the null-`theirs` banner renders.
  const outcome = saveOutcome({ status: refused.status, body: await refused.json(), mine });
  const banner = editorReducer(initialEditorState(updatedAt), outcome);
  expect(banner.conflict?.mine).toEqual(mine);
  const dismissed = editorReducer(banner, { type: "dismissed" });
  expect(dismissed.seen).toBeNull();

  const retried = await PUT(...put(page.id, { ...mine, seen: dismissed.seen }));
  expect(retried.status).toBe(201);

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.title).toBe("Rescued title");
  expect(row.markdown).toBe("Rescued paragraph.");
});

/**
 * The narrower sibling of the test above: `saveDraft` also types the `conflict` branch's
 * `theirs` as nullable, for the row that disappears between the refused write and the read
 * that describes it. Both reasons must reach the wire as the same 409, or the editor would
 * need two banners for one situation.
 *
 * Staged with a stubbed repository rather than a real race, deliberately: that interleaving
 * belongs to Task 9's code, and what is asserted here is only the translation this route
 * owns — the status stays 409, `mine` still comes back so nothing the editor typed is
 * dropped, and the `theirs` KEY is present and null rather than absent, so a client can
 * distinguish "no other draft to load" from a body it failed to parse.
 */
test("409 with theirs: null when the draft vanished mid-save, and mine still comes back", async () => {
  const { page, asAisyah } = await fixture();

  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => asAisyah }));
  vi.doMock("@/lib/drafts/repo", () => ({
    saveDraft: async () => ({
      ok: false,
      reason: "conflict",
      theirs: null,
      mine: { title: "Aisyah's title", markdown: "Aisyah's paragraph." },
    }),
  }));
  const { PUT } = await import("@/app/api/drafts/[pageId]/route");

  const response = await PUT(...put(page.id, draft()));
  expect(response.status).toBe(409);

  const body = await response.json();
  expect(body).toEqual({
    error: "conflict",
    theirs: null,
    mine: { title: "Aisyah's title", markdown: "Aisyah's paragraph." },
  });
  // The key is emitted, not dropped: `{"theirs":null}`, never `{}`.
  expect(Object.keys(body)).toContain("theirs");

  vi.doUnmock("@/lib/drafts/repo");
});

/**
 * 404-not-403 is a security property, and the assertion is on the whole response — status
 * and body — against a page id that was never real. Anything that distinguishes them, down
 * to the wording of the message, tells a stranger that the page exists.
 *
 * Kills: mapping `not-found` to 403 for a page that was found but unreadable, and any
 * "no such page" / "not allowed" split in the message.
 */
test("404 for a page in an unreadable space, identical to a page that does not exist", async () => {
  const { page } = await fixture("MEMBERS");
  const PUT = await routeAs(stranger);

  const real = await PUT(...put(page.id, draft()));
  const imaginary = await PUT(...put("does-not-exist", draft()));

  expect(real.status).toBe(404);
  expect(imaginary.status).toBe(404);
  expect(await real.json()).toEqual(await imaginary.json());
  expect(await db.pageDraft.count()).toBe(0);
});

/**
 * The other half of that rule. In an ALL_STAFF space the caller can already read the page, so
 * 403 tells them nothing new — and 404 would be a lie the editor UI cannot act on.
 */
test("403 for someone who can read the page but not edit it", async () => {
  const { space, page, budi } = await fixture();
  await db.spaceMembership.update({
    where: { spaceId_userId: { spaceId: space.id, userId: budi.id } },
    data: { role: "VIEWER" },
  });
  const PUT = await routeAs({
    id: budi.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role: "VIEWER" }],
  });

  expect((await PUT(...put(page.id, draft()))).status).toBe(403);
  expect(await db.pageDraft.count()).toBe(0);
});

// --- what actually reaches the column ----------------------------------------------------

/**
 * The strip is wired into the route, not only into the schema's own unit tests. A single NUL
 * reaching Postgres raises 22021 and turns every later autosave of that draft into a 500 no
 * retry can clear.
 *
 * The same body carries a ZWJ emoji and a bidi run, which is the half that must SURVIVE:
 * widening the strip to `\p{C}` removes NUL just as well and quietly shreds both. Phase 1
 * shipped that widening once.
 */
test("stores a body with a NUL stripped and its ZWJ emoji and bidi marks intact", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
  const bidi = "\u202Bالعربية\u202C";

  const response = await PUT(
    ...put(page.id, draft({ title: `Team ${family}`, markdown: `A\u0000B ${family} ${bidi}` })),
  );
  expect(response.status).toBe(201);

  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown).toBe(`AB ${family} ${bidi}`);
  expect(row.markdown).not.toContain("\u0000");
  expect(row.markdown).toContain("\u200D");
  expect(row.markdown).toContain("\u202B");
  expect(row.markdown).toContain("\u202C");
  expect(row.title).toBe(`Team ${family}`);
});

/**
 * A full-size document in a three-bytes-per-character script: ~900KB of body for ~300,000
 * characters. Kills a cap re-derived from `markdown.length` — the header this request
 * declares reads 900,000-odd while the string is a third of that.
 */
test("accepts a large document in a multi-byte script", async () => {
  const { page, asAisyah } = await fixture();
  const PUT = await routeAs(asAisyah);

  const cjk = "字".repeat(300_000);
  const response = await PUT(...put(page.id, draft({ markdown: cjk })));

  expect(response.status).toBe(201);
  const row = await db.pageDraft.findUniqueOrThrow({ where: { pageId: page.id } });
  expect(row.markdown.length).toBe(300_000);
});
