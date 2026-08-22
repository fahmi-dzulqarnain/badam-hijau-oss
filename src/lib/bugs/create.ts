import { db } from "@/lib/db";
import type { ReportContext } from "./context";
import type { BugReportInput } from "./schema";

export async function createBugReport(
  reporterId: string,
  input: BugReportInput,
  context: ReportContext,
) {
  return db.bugReport.create({
    data: { reporterId, ...input, ...context },
  });
}
