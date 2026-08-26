/**
 * How an attachment may be uploaded and how it must be served. Pure: plain values in, plain
 * values out, nothing imported from Prisma, so every rule here unit-tests without a database.
 *
 * The serving rules are the reason it is safe that the application never sees the bytes. An
 * upload goes straight from the browser to Graph, so there is no point at which magic bytes
 * could be inspected. What makes that acceptable is entirely here: a `Content-Type` drawn from
 * this allowlist, `X-Content-Type-Options: nosniff` at the route, and an inline set that
 * excludes every format a browser will execute.
 */

/** Extension per allowed type. Membership in this map IS the allowlist. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/zip": ".zip",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

/**
 * Served with `Content-Disposition: inline`. Everything else downloads.
 *
 * `image/svg+xml` and `text/html` are deliberately ABSENT while remaining uploadable. An
 * inline SVG is script execution against our own origin — worse than the same file hosted
 * anywhere else, because it inherits the session. Video is present because a browser will not
 * execute an mp4, and `<video>` needs the bytes inline to play them.
 */
const INLINE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
]);

export function isAllowedMime(mimeType: string): boolean {
  return Object.hasOwn(MIME_EXTENSIONS, mimeType);
}

export function isInlineMime(mimeType: string): boolean {
  return INLINE_MIMES.has(mimeType);
}

export function extensionFor(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] ?? "";
}

/**
 * The object key. Sharded on the id's first two characters rather than on the year and month
 * the spec first proposed: `id` and `createdAt` are both database defaults, so neither is
 * known when the key must be computed for the `create` that produces the row. A prefix shard
 * also distributes more evenly than months do.
 */
export function driveKeyFor(attachmentId: string, mimeType: string): string {
  return `${attachmentId.slice(0, 2)}/${attachmentId}${extensionFor(mimeType)}`;
}

/**
 * `Content-Disposition`, safely.
 *
 * A filename is user input on its way into an HTTP header, which is header injection unless
 * something removes CR, LF and the quote that terminates a quoted-string. Both forms are
 * emitted when they differ: `filename=` for the ASCII fallback and RFC 5987 `filename*=` for
 * the real bytes, which is what every current browser prefers.
 */
export function contentDisposition(mimeType: string, filename: string): string {
  const kind = isInlineMime(mimeType) ? "inline" : "attachment";

  // Strip C0/C1 controls, quote and backslash. Everything removed here is either a header
  // terminator or a quoted-string terminator; nothing removed is meaningful in a name.
  const clean = filename.replace(/[\p{Cc}"\\]/gu, "");

  // An all-non-ASCII name reduces the fallback to nothing, and `filename=""` is not a name.
  const ascii = clean.replace(/[^\x20-\x7E]/g, "");
  const fallback = /[^.\s]/.test(ascii) ? ascii : `file${extensionFor(mimeType)}`;

  const header = `${kind}; filename="${fallback}"`;
  // Against `ascii`, NOT against `fallback`. When the name reduces to nothing usable,
  // `fallback` becomes the `file.ext` placeholder, which `clean` can never equal — so
  // comparing to it always fell through and appended a bare, empty `filename*=UTF-8''`.
  // The real question is "does this name carry non-ASCII bytes", and `clean === ascii`
  // asks exactly that. Caught by test 7 during Task 4.
  if (clean === ascii) return header;
  return `${header}; filename*=UTF-8''${encodeRFC5987(clean)}`;
}

/**
 * `encodeURIComponent` leaves `!'()*` unescaped, and RFC 5987's `attr-char` set excludes
 * them. Percent-encoding them by hand is the documented remedy.
 *
 * Two things deliberately NOT done here, established by attacking this function during
 * Task 4 rather than by reasoning about it:
 *
 * - **No length cap.** 255 non-ASCII characters produce a ~1.6KB header, which is well
 *   inside every common proxy limit. The bound lives where it belongs: `beginUploadInput`
 *   in `schema.ts` caps `filename` at 255, so an unbounded name never reaches here.
 * - **`/` is not stripped while `\` is.** That asymmetry is principled, not an oversight:
 *   `\` is the escape character inside a quoted-string, so leaving it in breaks the header's
 *   own syntax. `/` has no syntactic meaning in a header, and browsers sanitise path
 *   separators when writing a download to disk. Do not "fix" the asymmetry by stripping `/`
 *   — it would silently mangle legitimate names for no gain.
 */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
