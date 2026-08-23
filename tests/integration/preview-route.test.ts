import { beforeEach, expect, test, vi } from "vitest";
import { db, resetDb } from "../setup/reset";
import { renderMarkdown } from "@/lib/markdown/render";
import { stripControl } from "@/lib/text/control";
import { MAX_DRAFT_BODY_BYTES } from "@/lib/drafts/schema";
import type { Viewer } from "@/lib/authz/types";

beforeEach(resetDb);

async function fixture(visibility: "MEMBERS" | "ALL_STAFF" = "MEMBERS") {
  const aisyah = await db.user.create({
    data: { email: "aisyah@example.com", name: "Aisyah R." },
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
  await db.spaceMembership.create({
    data: { spaceId: space.id, userId: aisyah.id, role: "EDITOR" },
  });

  const as = (role: "VIEWER" | "EDITOR" | "ADMIN"): Viewer => ({
    id: aisyah.id,
    isSuperAdmin: false,
    memberships: [{ spaceId: space.id, role }],
  });

  return { space, page, aisyah, asEditor: as("EDITOR"), asViewer: as("VIEWER") };
}

const stranger: Viewer = { id: "u-stranger", isSuperAdmin: false, memberships: [] };

/** Loads the route with a given signed-in viewer. */
async function routeAs(viewer: Viewer | null) {
  vi.resetModules();
  vi.doMock("@/lib/auth/viewer", () => ({ loadViewer: async () => viewer }));
  return (await import("@/app/api/preview/route")).POST;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/api/preview", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).length),
      ...headers,
    },
    body: payload,
  });
}

// --- the one property the endpoint exists for -------------------------------------------

/**
 * **The preview is the reader's own output, byte for byte.**
 *
 * Everything else in this file guards the endpoint; this guards the feature. The whole
 * reason preview renders on the server is that a second pipeline — a client-side
 * approximation, a differently configured `unified` chain, the same chain with one extra
 * plugin — lets the preview and the published page disagree, silently and only for the
 * documents nobody tested.
 *
 * The comparison is against `renderMarkdown` itself rather than a stored expectation,
 * because a stored expectation would have to be updated whenever the pipeline legitimately
 * changes and would then stop testing anything.
 *
 * Kills: any reimplementation of the pipeline in the route; passing an option the reader
 * does not pass; post-processing the HTML on the way out.
 */
test("the HTML is byte-identical to what renderMarkdown gives the reader", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  // Deliberately exercises every plugin in the chain: GFM tables and task lists, a fenced
  // code block for Shiki, a mermaid fence for the extractor, a heading for slug + autolink,
  // and a footnote, whose ids the sanitiser's `clobberPrefix` setting is pinned against.
  const markdown = [
    "# Topic registry",
    "",
    "Text with a [link](https://example.com/a?b=c) and `inline code`.",
    "",
    "| Topic | Retained |",
    "| --- | --- |",
    "| `fuel/+/state` | yes |",
    "",
    "- [x] done",
    "- [ ] not done",
    "",
    "```ts",
    "export const topic = 'fuel/+/state' as const;",
    "```",
    "",
    "```mermaid",
    "graph TD; A-->B;",
    "```",
    "",
    "A footnote reference[^1].",
    "",
    "[^1]: The footnote body.",
    "",
    "> A quote.",
  ].join("\n");

  const response = await POST(post({ pageId: page.id, markdown }));
  expect(response.status).toBe(200);

  const body = await response.json();
  const { html } = await renderMarkdown(markdown);
  expect(body.html).toBe(html);
  expect(Object.keys(body)).toEqual(["html"]);
});

/**
 * The security half of "the same pipeline": `renderMarkdown` sanitises, and the editor drops
 * this HTML straight into the document with `dangerouslySetInnerHTML`, exactly as the reader
 * route does. A route that returned raw HTML would be stored XSS on the author's own screen
 * — reflected off a body the caller supplied.
 */
test("caller-supplied HTML is sanitised, not reflected", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const markdown = [
    '<script>alert("xss")</script>',
    "",
    '<img src="x" onerror="alert(1)">',
    "",
    '[click](javascript:alert(1))',
  ].join("\n");

  const { html } = await (await POST(post({ pageId: page.id, markdown }))).json();
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("javascript:");
  // And it is still the reader's answer, not a second sanitiser's.
  expect(html).toBe((await renderMarkdown(markdown)).html);
});

/**
 * Control characters are stripped **before** rendering, by the same function the save path
 * uses. Without this the preview would render text that can never be stored, so the preview
 * and the published page would differ by exactly the characters nobody can see.
 *
 * Kills: rendering `parsed.data` from a schema without the transform, and any second regex.
 */
test("a NUL in the source does not reach the renderer, and does not fail the request", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const markdown = "## Pasted\u0000 from a terminal\u0007";
  const response = await POST(post({ pageId: page.id, markdown }));
  expect(response.status).toBe(200);

  const { html } = await response.json();
  expect(html).toBe((await renderMarkdown(stripControl(markdown))).html);
  expect(html).toContain("Pasted from a terminal");
});

test("an empty document previews as empty rather than as an error", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const response = await POST(post({ pageId: page.id, markdown: "" }));
  expect(response.status).toBe(200);
  expect((await response.json()).html).toBe("");
});

// --- size and shape, before anything is read --------------------------------------------

/**
 * Task 5's rejection, for Task 5's reason: a chunked request omits `Content-Length`
 * entirely and `Number(null)` is 0, which slides under every `> MAX` comparison.
 *
 * Kills: replacing the null check with a numeric-only cap.
 */
test("411 when no Content-Length is declared", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const request = post({ pageId: page.id, markdown: "hello" });
  // Request() computes a length for a string body, so strip it to model a chunked send.
  request.headers.delete("content-length");

  expect((await POST(request)).status).toBe(411);
});

test("413 on an oversized declared length, before the body is read", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const response = await POST(
    post({ pageId: page.id, markdown: "hello" }, { "content-length": "99999999" }),
  );
  expect(response.status).toBe(413);
});

test("413 on a Content-Length that is not a positive integer", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  for (const length of ["-1", "0", "not-a-number", "1e9"]) {
    const response = await POST(
      post({ pageId: page.id, markdown: "hello" }, { "content-length": String(length) }),
    );
    expect(response.status, `content-length: ${length}`).toBe(413);
  }
});

/**
 * One limit, shared rather than duplicated. The body carried here is the same document the
 * next autosave will PUT, so a preview cap below the save cap would make the largest
 * saveable documents unpreviewable, and one above it would render text that can never be
 * published — a divergence between preview and published output arriving by the back door.
 *
 * Kills: a second literal in the route that drifts from `MAX_DRAFT_BODY_BYTES`.
 */
test("the byte cap is exactly the draft endpoint's, at the boundary in both directions", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const atCap = await POST(
    post({ pageId: page.id, markdown: "ok" }, { "content-length": String(MAX_DRAFT_BODY_BYTES) }),
  );
  expect(atCap.status).toBe(200);

  const overCap = await POST(
    post(
      { pageId: page.id, markdown: "ok" },
      { "content-length": String(MAX_DRAFT_BODY_BYTES + 1) },
    ),
  );
  expect(overCap.status).toBe(413);
});

test("400 on a body that is not JSON at all", async () => {
  const { asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  const request = new Request("http://localhost/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "3" },
    body: "{ [",
  });
  expect((await POST(request)).status).toBe(400);
});

test("400 when the body omits the page id", async () => {
  const { asEditor } = await fixture();
  const POST = await routeAs(asEditor);
  expect((await POST(post({ markdown: "hello" }))).status).toBe(400);
});

// --- who may call it --------------------------------------------------------------------

test("401 when nobody is signed in", async () => {
  const { page } = await fixture();
  const POST = await routeAs(null);
  expect((await POST(post({ pageId: page.id, markdown: "hello" }))).status).toBe(401);
});

/**
 * Without this the route is an open HTML-rendering service for anyone holding a session:
 * arbitrary Markdown in, sanitised-but-server-rendered HTML out, at whatever rate they care
 * to ask for it, and Shiki makes each call expensive.
 *
 * Kills: dropping the `canEditPage` call, and checking READ instead of EDIT.
 */
test("403 for a reader who can see the page but not edit it", async () => {
  const { page, asViewer } = await fixture();
  const POST = await routeAs(asViewer);

  const response = await POST(post({ pageId: page.id, markdown: "# Not mine" }));
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty("html");
});

test("403 for a stranger in an ALL_STAFF space, who can read but not edit", async () => {
  const { page } = await fixture("ALL_STAFF");
  const POST = await routeAs(stranger);
  expect((await POST(post({ pageId: page.id, markdown: "# Not mine" }))).status).toBe(403);
});

/**
 * 404-not-403 is a security property and the assertion is on the whole response — status and
 * body — against a page id that was never real. Anything that distinguishes them, down to
 * the wording, tells a stranger the page exists.
 */
test("404 for a page in an unreadable space, identical to a page that does not exist", async () => {
  const { page } = await fixture("MEMBERS");
  const POST = await routeAs(stranger);

  const real = await POST(post({ pageId: page.id, markdown: "# Probe" }));
  const imaginary = await POST(post({ pageId: "does-not-exist", markdown: "# Probe" }));

  expect(real.status).toBe(404);
  expect(imaginary.status).toBe(404);
  expect(await real.json()).toEqual(await imaginary.json());
});

test("404 for a soft-deleted page, so a deleted page is not a live renderer", async () => {
  const { page, asEditor } = await fixture();
  await db.page.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
  const POST = await routeAs(asEditor);

  expect((await POST(post({ pageId: page.id, markdown: "# Gone" }))).status).toBe(404);
});

/** Rendering is a read. Nothing about a preview may leave a row behind. */
test("previewing writes nothing", async () => {
  const { page, asEditor } = await fixture();
  const POST = await routeAs(asEditor);

  await POST(post({ pageId: page.id, markdown: "# Topics\n\nA paragraph." }));

  expect(await db.pageDraft.count()).toBe(0);
  expect(await db.pageVersion.count()).toBe(0);
  expect(await db.auditLog.count()).toBe(0);
});
