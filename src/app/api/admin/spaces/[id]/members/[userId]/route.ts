import { NextResponse } from "next/server";
import { memberRoleBody, removeSpaceMember, setSpaceMemberRole } from "@/lib/spaces/admin";
import { loadViewer } from "@/lib/auth/viewer";

/**
 * Change or revoke one person's membership of one space — Phase 7 Task 6.
 *
 * Two handlers on one route because they address the same membership by the same pair of ids, and
 * both are translation layers: `setSpaceMemberRole` and `removeSpaceMember` own the permission
 * rule, the audit rows and the `admins` count that comes back with each.
 *
 * **Both echo `admins`**, the number of `ADMIN` memberships left *after* the write, read inside
 * the same transaction. Zero means nobody in the space can `MANAGE_SPACE` any more — which is a
 * fact and not a lockout, a super admin still being able to, and that is precisely why the last
 * admin is removable rather than refused: refusing would make them unoffboardable.
 *
 * **`DELETE` reads no body.** There is nothing to say beyond "this person, this space".
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage spaces." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = memberRoleBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a role." },
      { status: 400 },
    );
  }

  const { id, userId } = await params;
  const result = await setSpaceMemberRole(viewer, id, userId, parsed.data.role);

  if (result.ok) {
    return NextResponse.json(
      {
        userId: result.userId,
        role: result.role,
        // Null is impossible on this path and is still sent as the module reports it: a surface
        // that inferred "was a VIEWER" from the absence of a key would be reading a shape rather
        // than an answer.
        previousRole: result.previousRole,
        admins: result.admins,
      },
      { status: 200 },
    );
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage spaces." },
      { status: 401 },
    );
  }

  const { id, userId } = await params;
  const result = await removeSpaceMember(viewer, id, userId);

  if (result.ok) {
    return NextResponse.json(
      { userId: result.userId, role: result.role, admins: result.admins },
      { status: 200 },
    );
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
