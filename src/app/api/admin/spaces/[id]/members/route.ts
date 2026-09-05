import { NextResponse } from "next/server";
import { addSpaceMember, listSpaceMembers, memberAddBody } from "@/lib/spaces/admin";
import { loadViewer } from "@/lib/auth/viewer";

/**
 * Who belongs to one space, and granting a person access to it — Phase 7 Task 6.
 *
 * **The `GET` is the audited half of this surface's line**, and it is a separate request from the
 * page's own render for exactly the reason `api/admin/systems/[id]/pages` is: the member *count*
 * ships with every row of `/admin/spaces` and writes nothing, while the *names* are fetched when
 * an admin asks for them and write one `space.access` row when they do. Folding them together
 * would audit a page view of the administration index as a read of every private space in the
 * installation, and noise is how an audit table stops being read.
 *
 * A `GET` that writes an audit row, named rather than left to be noticed: the row records a
 * *read*, so the method is honest about what the caller is doing, and the write is
 * `auditSpaceAccess`'s — off the response through `after()` where there is one, and unable to
 * throw either way.
 *
 * **The `POST` is the grant.** It takes an email rather than a user id because that is what an
 * administrator has to hand and the only thing they can check with the person; the module folds
 * it, refuses an address that has never signed in with a sentence saying what to do, and refuses a
 * second membership by catching the unique index rather than pre-checking it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage spaces." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const result = await listSpaceMembers(viewer, id);

  if (!result.ok) {
    return NextResponse.json(
      { error: "not-found", message: "That page does not exist." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { key: result.key, members: result.members, truncated: result.truncated },
    { status: 200 },
  );
}

export async function POST(
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
  const parsed = memberAddBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a membership." },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await addSpaceMember(viewer, id, parsed.data.email, parsed.data.role);

  if (result.ok) {
    return NextResponse.json(
      { userId: result.userId, role: result.role, admins: result.admins },
      { status: 201 },
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
