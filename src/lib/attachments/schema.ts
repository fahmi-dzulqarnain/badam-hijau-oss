import { z } from "zod";
import { isAllowedMime } from "@/lib/attachments/policy";

/**
 * The begin-upload request body. Pure, like `drafts/schema.ts`: the route owns only the HTTP
 * status codes.
 *
 * Note what this body is NOT: the file. It is four small fields describing a file the browser
 * will send straight to Graph. So unlike the draft endpoint, the `Content-Length` guard at the
 * route is bounding a few hundred bytes of JSON, not a document — the real size limit is
 * `sizeBytes` below, checked before any upload session exists.
 */

/**
 * Ceiling on `MAX_UPLOAD_BYTES`, and the reason the override is validated rather than read.
 * `Attachment.sizeBytes` is a Prisma `Int`, which is a 4-byte Postgres `integer`. A cap above
 * this admits an upload that completes and then cannot be recorded — the worst ordering, since
 * the bytes are already in the library by then.
 */
const INT_MAX = 2_147_483_647;

export function maxUploadBytes(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.MAX_UPLOAD_BYTES;
  if (raw === undefined || raw === "") return 536_870_912;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MAX_UPLOAD_BYTES must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  if (value >= INT_MAX) {
    throw new Error(
      `MAX_UPLOAD_BYTES (${value}) must stay below ${INT_MAX}: Attachment.sizeBytes is an Int`,
    );
  }
  return value;
}

export const MAX_UPLOAD_BYTES = maxUploadBytes();

/** A filename is one line in a download dialog. */
export const FILENAME_MAX_LENGTH = 255;

/**
 * Strips EVERY C0/C1 control character, `\r`/`\n`/`\t` included.
 *
 * This is deliberately not `stripControl` from `@/lib/text/control`: that function keeps
 * newline, tab and carriage return because they are the structure of a Markdown document.
 * A filename has no such structure — it is one line in a download dialog — and `\r`/`\n` in
 * a filename are exactly the classic header/log-injection vector, not content worth
 * preserving. Reusing `stripControl` here would leave them in place.
 */
function stripFilenameControl(value: string): string {
  return value.replace(/\p{Cc}/gu, "");
}

export const beginUploadInput = z.object({
  pageId: z.string().min(1).max(64),

  /**
   * Stripped of control characters on the way in, for the same reason drafts are: Postgres
   * rejects NUL outright, and a filename carrying one turns every read of the row into a
   * 500. `contentDisposition` strips again at the point of use — that is not redundancy, it
   * is the header-injection defence living next to the header.
   */
  filename: z.string().min(1).max(FILENAME_MAX_LENGTH).transform(stripFilenameControl),

  /**
   * Checked against the allowlist HERE rather than at the route, so a rejected type never
   * reaches the store and no upload session is minted for it.
   */
  mimeType: z.string().refine(isAllowedMime, { message: "unsupported file type" }),

  /**
   * DECLARED size. The commit endpoint reads the real size back from the store and refuses a
   * mismatch — this value only decides whether to offer a session at all.
   */
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

export type BeginUploadInput = z.infer<typeof beginUploadInput>;
