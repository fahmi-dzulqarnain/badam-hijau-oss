import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { reconcileUnmirrored } from "@/lib/git/reconcile";

/**
 * Queue the versions that predate the mirror — spec §10, Phase 7 Task 7, and the third of Phase
 * 5's deferred debts.
 *
 * A translation layer and nothing more, exactly as `api/admin/git/retention/route.ts` is:
 * `reconcileUnmirrored` owns the permission rule (through `src/lib/admin/gate.ts`), which pages
 * are a gap, the cap on one pass, the enqueue itself and the audit row. **This route states no
 * permission predicate of its own** — it would be the second copy, and the copy no test could be
 * written against.
 *
 * ## No body, and no list of pages
 *
 * The caller chooses nothing: not which pages, not how many, not which space. A repair pass that
 * took a page list from the browser would be an endpoint that enqueues arbitrary mirror work for
 * an arbitrary page id, which is a different feature with a different permission argument — and
 * the reason it is not needed is that the *set* is derived from a predicate the operator was shown
 * the size of. Nothing to parse is nothing to validate.
 *
 * `POST` and not `PUT`: it creates jobs, it is not idempotent in the HTTP sense (a second press
 * queues whatever the first left over), and the response says how many it made and how many are
 * left.
 *
 * A refusal is a `404` with the body a nonexistent endpoint produces, never a `403`; `401` for a
 * signed-out caller is the exception and is not a leak, because every write endpoint in this
 * product answers it.
 */
export async function POST() {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to manage the mirror." },
      { status: 401 },
    );
  }

  const result = await reconcileUnmirrored(viewer);

  if (!result.ok) {
    return NextResponse.json(
      { error: "not-found", message: "That page does not exist." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { queued: result.queued, remaining: result.remaining, cap: result.cap },
    { status: 200 },
  );
}
