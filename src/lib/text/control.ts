/**
 * Strips the C0/C1 control block from text on its way into Postgres.
 *
 * Postgres rejects NUL outright (22021), which turns a legal JSON body into a 500 that no
 * retry can clear — the request is byte-for-byte identical every time. Both surfaces that
 * accept free text hit this: bug reports carry pasted console output, and Markdown carries
 * whatever an editor pasted from a terminal or a Word document.
 *
 * **`\p{Cc}`, never `\p{C}`.** The wider class also matches `\p{Cf}` — zero-width joiners
 * and bidi marks — and stripping those silently breaks ZWJ emoji sequences and right-to-left
 * text. This project shipped `\p{C}` once: a family emoji fell apart into four separate
 * people and Arabic text lost its direction marks, while every NUL test kept passing. That
 * is the failure mode to remember — the fix was too broad, and the damage was invisible to
 * the tests that motivated it.
 *
 * Newline, tab and carriage return are kept: they carry meaning in a stack trace and in
 * Markdown, and they are not what Postgres objects to.
 */
export function stripControl(value: string): string {
  return value.replace(/\p{Cc}/gu, (ch) =>
    ch === "\n" || ch === "\t" || ch === "\r" ? ch : "",
  );
}
