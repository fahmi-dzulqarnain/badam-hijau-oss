import { NextResponse } from "next/server";
import { memoryStore, devUploadEnabled } from "@/lib/blob/select";
import { MAX_UPLOAD_BYTES } from "@/lib/attachments/schema";

/**
 * Where the memory store's upload sessions point, and the only unauthenticated write in the
 * application. Treated with the same suspicion as the passwordless test login.
 *
 * It exists because uploads bypass the application: the browser PUTs bytes to whatever URL the
 * store hands it, so for `BLOB_STORE=memory` that URL must be something a test, a Playwright
 * browser and `scripts/smoke.sh` can actually PUT to. Without it the direct-upload path is not
 * exercisable at all and the "runs with no tenant credentials" goal is unreachable.
 *
 * **The folder is `dev-upload`, NOT `_dev-upload`, and that is not cosmetic.** An underscore
 * prefix makes a Next App Router folder *private* — excluded from the route tree entirely — so
 * the underscored version compiled, passed every integration test that imports this module
 * directly, and was absent from `routes-manifest.json`. It answered 307 to a real PUT and had
 * never existed as an endpoint. `npm run smoke` is what caught it, which is the whole reason
 * that script exists.
 *
 * **The URL carries a TOKEN, not a key**, and that is what makes it a capability rather than an
 * open door. `store.ts` documents `UploadSession` as "a write capability for ONE key, for a
 * short time"; the earlier version put the key in the path and honoured none of it — any caller
 * could write any key, and keys are derivable, since the id is visible in
 * `/api/attachments/<id>` and the hash function is in this repository. The session decides which
 * key it writes, so there is no longer a key on this request to validate, and the traversal
 * allowlist this route used to need has nothing left to guard.
 *
 * **`devUploadEnabled()`, not `memoryStoreEnabled()`.** Gating on the memory store alone made
 * this route ON by default in every process where `NODE_ENV` was not the literal string
 * `production` — and Next only DEFAULTS that variable, so `NODE_ENV=staging npx next start`
 * warns and proceeds. That is the inverse of `ALLOW_TEST_LOGIN`, which is off everywhere until
 * someone writes an exact `"1"`. This requires an explicit `ALLOW_DEV_UPLOAD=1` **and** the
 * memory store, so neither flag alone opens a write endpoint.
 *
 * **What the gate does and does not hide.** Every request that could write is a 404. The
 * route's *presence* in a build is still detectable — an earlier version of this comment
 * claimed the 404 was "byte-identical to a route that was never registered", and that was
 * false: Next auto-implements `OPTIONS` from the userland exports, so an unregistered path and
 * a gated one answer differently. The stubs below close that for every verb except the two this
 * route implements. Fingerprinting confers nothing, but a false claim in a security comment is
 * worse than no claim.
 */

function notFound() {
  return NextResponse.json({ error: "not-found" }, { status: 404 });
}

/**
 * `bytes {start}-{end}/{total}`, the form Graph requires and the transport sends. Absent means
 * the body is the whole object, which is what a plain `curl --data-binary` does — the smoke
 * test's own upload leg.
 */
function offsetFrom(header: string | null): number | null {
  if (header === null) return 0;
  const match = header.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return end >= start ? start : null;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!devUploadEnabled()) return notFound();

  // The same guard order the drafts route uses, for the same reason: a missing header is its
  // own rejection because `Number(null)` is 0, so a numeric-only cap waves a chunked body
  // straight through. Without this the fake was strictly MORE permissive than Graph — it
  // buffered an unbounded body into a Map that only `reset()` clears.
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const length = Number(declared);
  if (!Number.isInteger(length) || length < 0 || length > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That upload is too large." },
      { status: 413 },
    );
  }

  const offset = offsetFrom(request.headers.get("content-range"));
  if (offset === null) {
    return NextResponse.json(
      { error: "invalid-range", message: "Content-Range must be `bytes start-end/total`." },
      { status: 400 },
    );
  }

  const { token } = await params;
  const result = await memoryStore().writeChunk(
    token,
    offset,
    new Uint8Array(await request.arrayBuffer()),
  );

  if (result.ok) {
    // Graph's own two answers, imitated because the transport reads them: 202 while a session
    // is still accepting chunks, 201 once the object exists. Both are `response.ok`, which is
    // what `uploadAttachment` branches on.
    return new NextResponse(null, { status: result.complete ? 201 : 202 });
  }

  switch (result.reason) {
    // Indistinguishable from a token that never existed, deliberately — and it is the same
    // 404 the gate returns, so a probe learns nothing from either.
    case "unknown-session":
      return notFound();
    case "expired":
      // 410, not 404: the session was real and is gone. A caller holding a lapsed URL needs to
      // know the difference, because the remedy is to begin a new upload rather than retry.
      return NextResponse.json(
        { error: "session-expired", message: "That upload session has expired." },
        { status: 410 },
      );
    case "overflow":
      return NextResponse.json(
        { error: "overflow", message: "That chunk runs past the size the session declared." },
        { status: 400 },
      );
  }
}

/**
 * What the session still wants, in Graph's `nextExpectedRanges` shape.
 *
 * The transport's resume path reads this after a failed chunk, so without it the fake could
 * not exercise resumption at all — a dropped chunk against the memory store would report "the
 * upload was interrupted" where the real store would recover. An unknown or lapsed token is a
 * 404, the same as every other probe.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  if (!devUploadEnabled()) return notFound();

  const ranges = memoryStore().nextExpectedRanges((await params).token);
  if (ranges === null) return notFound();
  return NextResponse.json({ nextExpectedRanges: ranges });
}

/**
 * Every remaining method, through the same gate.
 *
 * Not dead code: without these, Next auto-implements them — unhandled verbs as 405 and
 * `OPTIONS` as a 204 carrying `Allow: …`, both of which confirm the route module is compiled
 * into the build without ever consulting the gate.
 */
export const POST = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
