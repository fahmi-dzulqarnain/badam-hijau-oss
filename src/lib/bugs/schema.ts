import { z } from "zod";

// Postgres rejects NUL outright (22021), turning a legal JSON body into a 500 no retry can
// clear — and this endpoint exists to receive pasted console output, where stray control
// bytes come from. Strip the C0/C1 control block only: newline, tab and carriage return
// carry meaning in a trace, and \p{Cf} (zero-width joiners, bidi marks) is deliberately
// left alone — stripping it silently breaks ZWJ emoji sequences and right-to-left text.
const stripControl = (value: string) =>
  value.replace(/\p{Cc}/gu, (ch) =>
    ch === "\n" || ch === "\t" || ch === "\r" ? ch : "",
  );

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
