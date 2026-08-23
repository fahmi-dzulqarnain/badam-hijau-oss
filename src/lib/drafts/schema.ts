import { z } from "zod";
import { stripControl } from "@/lib/text/control";

/**
 * The autosave request body, and the two size rules that go with it.
 *
 * Pure: plain values in, plain values out, nothing imported from Prisma, so every rule here
 * unit-tests without a database. The route owns only the HTTP status codes.
 */

/**
 * The largest **declared** body this endpoint will read, in BYTES.
 *
 * Bytes, not characters, and the distinction is the whole reason this constant is written
 * down rather than inlined. `Content-Length` counts UTF-8 bytes while every JavaScript
 * length counts UTF-16 units, so a document of CJK text is roughly 3× its character count —
 * Phase 1's bug endpoint sized its cap from character limits, and a maximum-length report in
 * a 3-bytes-per-unit script was rejected outright.
 *
 * 1 MB is far above any real Markdown document (this repository's longest plan is ~40KB) and
 * far below the hundreds of megabytes that exhaust a memory-capped container, which is the
 * only thing the guard exists to stop. It matters more here than on the bug endpoint: this
 * one fires every two seconds per open editor.
 */
export const MAX_DRAFT_BODY_BYTES = 1_048_576;

/** A page title is one line in a breadcrumb and a nav rail, not a document. */
export const TITLE_MAX_LENGTH = 300;

/**
 * Postgres rejects NUL outright (22021). A draft carrying one turns every subsequent
 * autosave into a 500 that no retry can clear — the editor keeps trying, keeps failing, and
 * the work is stranded in a browser tab. Markdown gets pasted from terminals, PDFs and word
 * processors, all of which carry stray control bytes.
 *
 * Strip the C0/C1 control block ONLY, keeping newline, tab and carriage return because they
 * are the structure of a Markdown document. **Not** `\p{C}`: that also matches `\p{Cf}`, the
 * format characters — zero-width joiners and bidi marks — and stripping those breaks ZWJ
 * emoji sequences into their component glyphs and destroys right-to-left text. Phase 1
 * shipped the `\p{C}` version once and had to fix it; see PROGRESS.md, "reproduce the class,
 * not the instance".
 *
 * The control strip lives in `@/lib/text/control` — one implementation, shared with the
 * bug endpoint, because a rule implemented in two places is not yet a convention.
 */
export const draftSaveInput = z.object({
  /**
   * Not trimmed, and not required to be non-empty. This is a *draft*: an editor who clears
   * the title to retype it must not have their autosave start 400ing mid-keystroke, which
   * is exactly the silent "my work stopped saving" failure the conflict contract exists to
   * prevent. Publish (Task 9) is where a title becomes mandatory.
   */
  title: z.string().max(TITLE_MAX_LENGTH).transform(stripControl),

  /**
   * No length cap here, on purpose. `MAX_DRAFT_BODY_BYTES` already bounds this field, and a
   * second cap counted in UTF-16 units would bind at a *different* size than the one the
   * endpoint advertises: 1 MB of ASCII is ~1,048,576 units while 1 MB of CJK is ~349,000, so
   * any unit cap chosen to admit the former silently rejects nothing while a cap chosen for
   * the latter rejects legal ASCII documents. One limit, in one unit, checked in one place.
   */
  markdown: z.string().transform(stripControl),

  /**
   * The `updatedAt` the client last received, echoed back as the ISO string this endpoint
   * returned. `null` is a positive claim that no draft exists — see `decideSave`, which
   * treats it as a conflict when one does. A **missing** key is neither claim: it is a
   * broken client, and it gets a 400 rather than being read as `null` and racing a save
   * against work it never saw.
   */
  seen: z
    .iso
    .datetime()
    .nullable()
    .transform((value) => (value === null ? null : new Date(value))),
});

export type DraftSaveInput = z.infer<typeof draftSaveInput>;
