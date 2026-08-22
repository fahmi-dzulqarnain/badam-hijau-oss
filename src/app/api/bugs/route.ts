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
