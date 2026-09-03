import { NextResponse } from "next/server";
import { memoryStore, devUploadEnabled } from "@/lib/blob/select";
import { MAX_UPLOAD_BYTES } from "@/lib/attachments/schema";

/**
 * Where the memory store's upload sessions point, and the only unauthenticated write in the
 * application. Treated with the same suspicion as the passwordless test login.
 *
 * **The folder is `dev-upload`, NOT `_dev-upload`, and that is not cosmetic.** An underscore
 * prefix makes a Next App Router folder *private* — excluded from the route tree entirely — so
 * the underscored version compiled, passed every integration test that imports this module
 * directly, and was absent from `routes-manifest.json`. It answered 307 to a real PUT and had
 * never existed as an endpoint. `npm run smoke` is what caught it, which is the whole reason
 * that script exists. Safety here comes from `devUploadEnabled()` below, never from the name.
 *
 * It exists because uploads bypass the application: the browser PUTs bytes to whatever URL the
 * store hands it, so for `BLOB_STORE=memory` that URL must be something a test, a Playwright
 * browser and `scripts/smoke.sh` can actually PUT to. Without it the direct-upload path is not
 * exercisable at all and the "runs with no tenant credentials" goal is unreachable.
 *
 * **`devUploadEnabled()`, not `memoryStoreEnabled()`, and the difference is the whole safety
 * argument.** Gating on the memory store alone made this route ON by default in every process
 * where `NODE_ENV` was not the literal string `production` — and Next only DEFAULTS that
 * variable, so `NODE_ENV=staging npx next start` warns and proceeds. That is the inverse of
 * `ALLOW_TEST_LOGIN`, which is off everywhere until someone writes an exact `"1"`. Now this
 * matches: it requires an explicit `ALLOW_DEV_UPLOAD=1` **and** the memory store, so neither
 * flag alone opens a write endpoint.
 *
 * **What the gate does and does not hide.** Every request that could write is a 404. The
 * route's *presence* in a build is still detectable — an earlier version of this comment
 * claimed the 404 was "byte-identical to a route that was never registered", and that was
 * false: Next auto-implements `OPTIONS` from the userland exports, so an unregistered path and
 * a gated one answer differently. The stubs below close that by handling every method through
 * the same gate. Fingerprinting confers nothing either way, but a false claim in a security
 * comment is worse than no claim.
 */

/** `{2 hex}/{id}{ext}` — the shape `driveKeyFor` produces, and the only shape accepted. */
const DRIVE_KEY = /^[0-9a-f]{2}\/[a-z0-9]+\.[a-z0-9]+$/;

function notFound() {
  return NextResponse.json({ error: "not-found" }, { status: 404 });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  if (!devUploadEnabled()) return notFound();

  const { key } = await params;
  const joined = key.join("/");

  // Validated against the shape a key is SUPPOSED to have, not by blacklisting `..` segments.
  // The per-segment blacklist was bypassable and its test did not notice: Next decodes
  // catch-all segments AFTER splitting on `/`, so `..%2f..%2fetc%2fpasswd` arrives as ONE
  // element containing real slashes, and a per-segment check never sees a `..` segment.
  // Harmless against the memory store's Map, but `GraphBlobStore` builds
  // `/drives/{id}/root:/{key}:`, where a traversal would walk the drive. An allowlist of the
  // one legal shape cannot be bypassed by an encoding that produces a different one.
  if (!DRIVE_KEY.test(joined)) {
    return NextResponse.json({ error: "invalid-key" }, { status: 400 });
  }

  // The same guard order the drafts route uses, for the same reason: a missing header is its
  // own rejection because `Number(null)` is 0, so a numeric-only cap waves a chunked body
  // straight through. Without this the fake was strictly MORE permissive than Graph — it
  // buffered an unbounded body into a Map that only `reset()` clears, so a large PUT
  // exhausted the heap of the very dev server the tests depend on.
  const declared = request.headers.get("content-length");
  if (declared === null) {
    return NextResponse.json(
      { error: "length-required", message: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declared);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "too-large", message: "That upload is too large." },
      { status: 413 },
    );
  }

  await memoryStore().put(joined, new Uint8Array(await request.arrayBuffer()));
  return new NextResponse(null, { status: 201 });
}

/**
 * Every other method, through the same gate.
 *
 * Not dead code: without these, Next auto-implements them — unhandled verbs as 405 and
 * `OPTIONS` as a 204 carrying `Allow: OPTIONS, PUT`, both of which confirm the route module is
 * compiled into the build without ever consulting the gate. Routing them here makes the 404
 * uniform.
 */
export const GET = notFound;
export const POST = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
