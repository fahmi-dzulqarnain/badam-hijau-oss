import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { bugTriageBody, setBugStatus } from "@/lib/bugs/admin";

/**
 * Triage one bug report — spec §18.2's `NEW | TRIAGED | CLOSED`, Phase 7 Task 8.
 *
 * A translation layer and nothing more, exactly as `api/admin/systems/[id]/route.ts` is:
 * `setBugStatus` owns the permission rule (through `src/lib/admin/gate.ts`), the audit row and the
 * refusal. **This route states no permission predicate of its own** — it would be the second copy,
 * and the copy no test could be written against.
 *
 * **`PATCH` and not `PUT`**, and here it is not a formality either: a report has thirteen captured
 * columns and exactly one of them is administrable. A `PUT` would describe a replacement of a
 * document this endpoint has no business rewriting — the reporter's own words, and the context
 * their browser was standing in — so the body is one field and the shape says so.
 *
 * There is deliberately **no `DELETE`**, and it is the same call `/admin/spaces` made about a
 * space. A `BugReport` is the only record that somebody hit a problem; `CLOSED` is the state for
 * one that is finished with, and the table's growth is bounded by how often people press a button
 * in the rail. If a retention pass is ever wanted it is `src/lib/git/retention.ts`'s shape — a
 * window, a count shown first, and an audit row — and not a delete button beside each row.
 *
 * A refusal is a `404` with the body a nonexistent endpoint produces, never a `403`; `401` for a
 * signed-out caller is the exception and is not a leak, because every write endpoint in this
 * product answers it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to triage bug reports." },
      { status: 401 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = bugTriageBody.safeParse(body);
  if (!parsed.success) {
    // A `400` and not a `422`: there is no form field for a sentence to sit beside, so there is
    // nothing per-field to report — the body is either one of three words or it is not a triage.
    return NextResponse.json(
      { error: "invalid-body", message: "That is not a bug report status." },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await setBugStatus(viewer, id, parsed.data.status);

  if (!result.ok) {
    // One shape for "no such report" and for "you may not be here" — see `src/lib/admin/gate.ts`.
    return NextResponse.json(
      { error: "not-found", message: "That page does not exist." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      id: result.id,
      status: result.status,
      // Echoed so the surface can say what happened rather than reprinting what it sent — the
      // difference matters when two triagers press at once, and it is the value the audit row
      // records.
      previousStatus: result.previousStatus,
    },
    { status: 200 },
  );
}
