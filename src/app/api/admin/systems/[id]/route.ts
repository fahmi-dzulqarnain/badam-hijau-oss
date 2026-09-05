import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { deleteSystem, systemUpdateBody, updateSystem } from "@/lib/systems/admin";

/**
 * Edit or remove one system — spec §7, Phase 7 Task 5.
 *
 * Two handlers on one route because they address the same thing by the same id, and both are
 * translation layers: `updateSystem` and `deleteSystem` own the permission rule (through
 * `src/lib/admin/gate.ts`), the field rules, the rename decision, the audit rows and the refusal
 * sentences. Neither is re-decided or re-worded here.
 *
 * **`PATCH` and not `PUT`, and it is not a formality.** An edit is a patch and `SystemPatch` says
 * why: a replacement form would have to prefill `repoUrl`, which means sending a stored — possibly
 * credentialed — URL to the browser, and undoing Task 3's half of the two-ended fix on the one
 * page whose job is to repair it. It is also what lets the offer beside a refused delete be one
 * field: `{ "isActive": false }`.
 *
 * **`DELETE` reads no body.** There is nothing to say beyond "this system", and the interesting
 * outcome is the refusal `PageSystem.systemId`'s `Restrict` produces, which arrives as `409` with
 * a count and an alternative rather than as a 500 with a constraint name in it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage systems." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = systemUpdateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a system." },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await updateSystem(viewer, id, parsed.data);

  if (result.ok) {
    return NextResponse.json(
      {
        id: result.id,
        key: result.key,
        // Echoed so the surface can say what happened rather than guessing from what it sent —
        // and so a rename's consequence can be stated with the number it applies to.
        renamedFrom: result.renamedFrom,
        references: result.references,
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // One shape for "no such system" and for "you may not be here" — see `src/lib/admin/gate.ts`.
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    case "invalid":
      return NextResponse.json({ error: "invalid", errors: result.errors }, { status: 422 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage systems." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const result = await deleteSystem(viewer, id);

  if (result.ok) return NextResponse.json({ key: result.key }, { status: 200 });

  switch (result.reason) {
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    /*
     * `409 Conflict`, carrying the module's own sentence verbatim plus the two numbers the surface
     * renders controls from.
     *
     * The sentence is not re-worded here for `restore/route.ts`'s reason: that a facet row is a
     * projection of authored frontmatter, and that `isActive` is the verb for a system that should
     * stop appearing, is the one thing about this refusal nobody can guess — so the only
     * explanation that exists should not acquire a second, worse copy at the route.
     */
    case "referenced":
      return NextResponse.json(
        {
          error: "referenced",
          message: result.message,
          key: result.key,
          references: result.references,
          isActive: result.isActive,
        },
        { status: 409 },
      );
  }
}
