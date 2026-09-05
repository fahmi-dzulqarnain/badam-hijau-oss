import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { createSystem, systemCreateBody } from "@/lib/systems/admin";

/**
 * Add a system to the catalogue — spec §7's "admins manage the list", Phase 7 Task 5.
 *
 * A translation layer and nothing more, like `restore/route.ts`: `createSystem` owns the
 * permission rule (through `src/lib/admin/gate.ts`), every field rule, the audit row and the
 * discriminated result. Nothing here re-decides any of them, and in particular **this route states
 * no permission predicate of its own** — it would be the second copy, and the copy no test could
 * be written against, since the module's refusal already answers first.
 *
 * ## Every refusal that is not a field error is a 404
 *
 * `refuseNonAdmin` answers `{ reason: "not-found" }` for a signed-in non-admin, and this returns
 * `404` with the same body a nonexistent endpoint would produce. Not `403`: on an admin surface a
 * `403` tells an ordinary member that the endpoint exists and that they are the wrong sort of
 * person, which is the shape of the system rather than its contents, and still something they were
 * not entitled to. `src/lib/admin/gate.ts` carries the argument.
 *
 * `401` for a signed-out caller is the exception, and it is not a leak: every write endpoint in
 * this product answers it, so it says nothing about *this* one.
 *
 * ## The body is parsed for shape only
 *
 * `systemCreateBody` is `z.strictObject` — a mistyped `ownerteam:` is refused rather than dropped,
 * which is the decision this project records for `z.strictObject` generally. It bounds each string
 * an order of magnitude above the real caps so a huge body is refused before `stripControl` runs
 * over it; the caps that produce a *sentence* are the module's, and they come back as
 * `errors: [{ field, code, message }]` for the form to render beside each input.
 *
 * There is no `Content-Length` pre-check like `api/bugs`'s, and the difference is who can reach
 * it: that endpoint is unauthenticated by design, this one is behind a session. What a signed-in
 * non-admin can do here is send one bounded body and be told 404.
 */
export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage systems." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = systemCreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a system." },
      { status: 400 },
    );
  }

  const result = await createSystem(viewer, parsed.data);

  if (result.ok) {
    return NextResponse.json({ id: result.id, key: result.key }, { status: 201 });
  }

  switch (result.reason) {
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    // 422 and not 400: the JSON was well-formed and the right shape, and every message here is
    // meant to be rendered against a field rather than logged. `400` above is for a body this
    // endpoint could not read at all.
    case "invalid":
      return NextResponse.json({ error: "invalid", errors: result.errors }, { status: 422 });
  }
}
