import { NextResponse } from "next/server";
import { loadViewer } from "@/lib/auth/viewer";
import { bugReportInput } from "@/lib/bugs/schema";
import { resolveReportContext } from "@/lib/bugs/context";
import { createBugReport } from "@/lib/bugs/create";

export async function POST(request: Request) {
  const viewer = await loadViewer();
  if (!viewer) {
    return NextResponse.json({ error: "Sign in to report a bug." }, { status: 401 });
  }

  // Reject on the declared size before reading the body: request.json() buffers and
  // parses everything first, so a single large POST can exhaust a memory-capped
  // container. A MISSING length is rejected too — a chunked body omits it entirely, and
  // Number(null) is 0, which would otherwise slip under any numeric cap. Real clients
  // send it: a browser fetch with a JSON.stringify body sets Content-Length.
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    return NextResponse.json(
      { error: "A Content-Length header is required." },
      { status: 411 },
    );
  }
  const bytes = Number(declaredLength);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 32_768) {
    return NextResponse.json({ error: "That report is too large." }, { status: 413 });
  }

  const parsed = bugReportInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Add a short description of what happened." },
      { status: 400 },
    );
  }

  const context = await resolveReportContext(viewer, parsed.data.routePath);
  const report = await createBugReport(viewer.id, parsed.data, context);
  return NextResponse.json({ id: report.id }, { status: 201 });
}
