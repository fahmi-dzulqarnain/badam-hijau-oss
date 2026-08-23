import { z } from "zod";
import { stripControl } from "@/lib/text/control";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? stripControl(v) : null));

export const bugReportInput = z.object({
  summary: z.string().trim().min(1).max(5000).transform(stripControl),
  expected: optionalText(5000),
  routePath: z.string().min(1).max(2000),
  // No spaceId/pageId/versionId here, deliberately. They are derived server-side from
  // routePath (src/lib/bugs/context.ts). Accepting them from the client would let a
  // reporter tag a report with a page from a space they cannot read, which an admin would
  // then see in the report list.
  appVersion: z.string().min(1).max(64),
  gitSha: optionalText(64),
  userAgent: z.string().min(1).max(1000),
  viewport: z.string().regex(/^\d{1,5}x\d{1,5}$/),
  consoleError: optionalText(5000),
});

export type BugReportInput = z.infer<typeof bugReportInput>;
