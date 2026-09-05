import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { createSpace, spaceCreateBody } from "@/lib/spaces/admin";

/**
 * Create a space — spec §11's `/admin/*`, Phase 7 Task 6. **The first endpoint in this product
 * that inserts a `Space` row.**
 *
 * A translation layer and nothing more, exactly as `api/admin/systems/route.ts` is: `createSpace`
 * owns the permission rule (through `src/lib/admin/gate.ts`), every field rule including
 * `validateSpaceKey`'s route list, the audit row and the discriminated result. **This route states
 * no permission predicate of its own** — it would be the second copy, and the copy no test could
 * be written against.
 *
 * Every refusal that is not a field error is a `404` with the body a nonexistent endpoint
 * produces, never a `403`; `401` for a signed-out caller is the exception and is not a leak,
 * because every write endpoint in this product answers it. `src/lib/admin/gate.ts` carries the
 * argument, and `api/admin/systems/route.ts` carries the longer form of this docstring.
 *
 * `422` and not `400` for a field error: the JSON was well-formed and the right shape, and every
 * message is meant to be rendered against an input. `400` is for a body this endpoint could not
 * read at all.
 */
export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage spaces." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = spaceCreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a space." },
      { status: 400 },
    );
  }

  const result = await createSpace(viewer, parsed.data);

  if (result.ok) {
    return NextResponse.json({ id: result.id, key: result.key }, { status: 201 });
  }

  switch (result.reason) {
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    case "invalid":
      return NextResponse.json({ error: "invalid", errors: result.errors }, { status: 422 });
  }
}
