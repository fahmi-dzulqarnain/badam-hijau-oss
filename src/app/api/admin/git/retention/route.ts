import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { sweepFinishedJobs } from "@/lib/git/retention";

/**
 * Sweep the finished mirror jobs that are older than the retention window — spec §10, Phase 7
 * Task 7, and the second of Phase 5's three deferred debts.
 *
 * A translation layer and nothing more, exactly as `api/admin/spaces/route.ts` is:
 * `sweepFinishedJobs` owns the permission rule (through `src/lib/admin/gate.ts`), the window, the
 * `DONE`-only predicate, the audit row and the counts. **This route states no permission predicate
 * of its own** — it would be the second copy, and the copy no test could be written against.
 *
 * ## There is no body, and that is the interesting part
 *
 * The window comes from `GIT_JOB_RETENTION_DAYS` and never from the request, so this endpoint
 * reads nothing at all from the caller: no `days`, no cutoff, no id, no list of jobs. A retention
 * policy is a property of a deployment, and a number typed into a browser that then deletes rows
 * is a policy decided by whoever last used the page. Nothing to parse is nothing to validate and
 * nothing a hostile request can widen — the only thing this endpoint can be asked is *"apply the
 * policy"*.
 *
 * `POST` and not `DELETE`: the resource being asked for is the sweep, which is created, and no URL
 * here names the rows it removes. That also keeps the shape every other mutation in this product
 * has, which is what the client's `send` helper expects.
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

  const result = await sweepFinishedJobs(viewer);

  if (!result.ok) {
    return NextResponse.json(
      { error: "not-found", message: "That page does not exist." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      deleted: result.deleted,
      remaining: result.remaining,
      retentionDays: result.retentionDays,
      cutoff: result.cutoff.toISOString(),
    },
    { status: 200 },
  );
}
