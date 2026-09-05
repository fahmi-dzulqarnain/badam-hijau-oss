import { NextResponse } from "next/server";
import { spaceUpdateBody, updateSpace } from "@/lib/spaces/admin";
import { loadViewer } from "@/lib/auth/viewer";

/**
 * Edit one space — spec §11, Phase 7 Task 6.
 *
 * A translation layer: `updateSpace` owns the permission rule, the field rules, the
 * key-while-empty rule, the audit row and every sentence. None is re-decided or re-worded here.
 *
 * **`PATCH` and not `PUT`.** `SpacePatch` gives the reason and it is not a formality: flipping a
 * space's visibility is one field, and a replacement form would resubmit `key` on every save,
 * which makes "did this request ask for a rename" unanswerable from the request alone — and a
 * rename is the one field change that can be refused.
 *
 * **There is no `DELETE`.** Deliberate, and not an omission this task ran out of time for. A
 * `Space` cascades to `SpaceMembership` and restricts on nothing, but its `Page` rows are the
 * documents themselves — this product has no hard delete for a page and `content/<key>/` is a
 * directory in the git mirror that nothing here could remove — so a space delete would be the
 * largest destructive act in the product arriving with none of the machinery the smallest one has.
 * A space that should stop being used has no state for that yet, which is the honest gap; Task 1's
 * argument for `System.isActive` is the shape a later phase should copy.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage spaces." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = spaceUpdateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a space." },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await updateSpace(viewer, id, parsed.data);

  if (result.ok) {
    return NextResponse.json(
      {
        id: result.id,
        key: result.key,
        // Echoed so the surface can state what happened rather than guessing from what it sent,
        // and so the two consequences that need a number can have one.
        renamedFrom: result.renamedFrom,
        visibilityWas: result.visibilityWas,
        members: result.members,
        pages: result.pages,
      },
      { status: 200 },
    );
  }

  switch (result.reason) {
    // One shape for "no such space" and for "you may not be here".
    case "not-found":
      return NextResponse.json(
        { error: "not-found", message: "That page does not exist." },
        { status: 404 },
      );

    case "invalid":
      return NextResponse.json({ error: "invalid", errors: result.errors }, { status: 422 });
  }
}
