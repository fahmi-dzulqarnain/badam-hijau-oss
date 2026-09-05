/**
 * How an attachment may be uploaded and how it must be served. Pure: plain values in, plain
 * values out, nothing imported from Prisma, so every rule here unit-tests without a database.
 *
 * The serving rules are the reason it is safe that the application never sees the bytes. An
 * upload goes straight from the browser to Graph, so there is no point at which magic bytes
 * could be inspected. What makes that acceptable is entirely here: a `Content-Type` drawn from
 * this allowlist, `X-Content-Type-Options: nosniff` at the route, and an inline set that
 * excludes every format a browser will execute.
 *
 * **The serving rules govern one of two readers, which is why the allowlist carries the weight
 * for executable formats.** The bytes live in a SharePoint document library, and SharePoint's
 * own web UI serves them to anyone with access to the site — with none of this module's
 * headers, no permission predicate of ours, and at a URL we cannot add a header to. Any format
 * a browser will execute therefore has to be refused at the point that governs both readers:
 * whether it may be stored at all. See `image/svg+xml` and `text/html` below.
 */

/** Extension per allowed type. Membership in this map IS the allowlist. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
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
 * **`image/svg+xml` and `text/html` are absent here AND absent from the allowlist above, and
 * both absences are load-bearing.** They were uploadable-but-never-inline first, on the
 * reasoning that an inline SVG is script execution against our own origin while a downloaded
 * one is inert. That reasoning was right about this route and incomplete about the system: the
 * library is also readable through SharePoint's own UI, which applies none of these rules. The
 * upload refusal is what closes that; this set staying narrow is what keeps a row written
 * before the refusal from being served inline now.
 *
 * Video is present because a browser will not execute an mp4, and `<video>` needs the bytes
 * inline to play them.
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
 * The object key, sharded on a HASH of the id rather than a slice of it.
 *
 * Not sharded on the date the spec first proposed, because `id` and `createdAt` are both
 * database defaults: neither is known when the key must be computed for the `create` that
 * produces the row.
 *
 * And **not sharded on `id.slice(0, 2)`**, which is what replaced the date and was worse than
 * what it replaced. A Prisma `cuid()` is `"c" + Date.now().toString(36) + counter + fingerprint
 * + random`, so the first character is the literal `c` and the second is the most significant
 * base-36 digit of a millisecond timestamp — which advances about once every two and a half
 * years. Measured on twelve consecutively minted ids: **one** distinct value for the leading
 * two characters, twelve for the trailing two. Every attachment for years would have landed in
 * one SharePoint folder, and `yyyy/mm` would at least have given twelve buckets a year.
 *
 * Hashing rather than slicing the tail, because the tail is only random by an accident of
 * cuid v1's layout. A hash decorrelates the shard from whatever structure the id scheme
 * happens to carry, so this does not silently collapse again if that scheme ever changes.
 */
export function driveKeyFor(attachmentId: string, mimeType: string): string {
  return `${shardFor(attachmentId)}/${attachmentId}${extensionFor(mimeType)}`;
}

/**
 * FNV-1a, 32-bit, folded to 256 buckets and rendered as two hex characters.
 *
 * Not a security hash and not required to be one — nothing here resists an adversary, and the
 * id is not a secret. Its only job is to destroy any correlation between neighbouring ids, so
 * the bucket cannot track a timestamp. 256 buckets keeps a folder well under SharePoint's
 * 5,000-item view threshold at any volume this platform will see.
 *
 * `Math.imul` because the FNV prime multiply overflows 32 bits, and plain `*` on a JS number
 * silently loses the low bits it is supposed to keep. `>>> 0` converts back to unsigned before
 * the modulo, since the XOR-and-multiply leaves a signed 32-bit value.
 */
function shardFor(attachmentId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < attachmentId.length; i += 1) {
    hash ^= attachmentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 256).toString(16).padStart(2, "0");
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
