import { z } from "zod";
import { stripControl } from "@/lib/text/control";

/**
 * The preview request body.
 *
 * Pure: plain values in, plain values out, nothing imported from Prisma, so every rule here
 * unit-tests without a database. The route owns only the HTTP status codes.
 *
 * There is no size cap in this schema on purpose, for the reason `MAX_DRAFT_BODY_BYTES`
 * spells out at length: `Content-Length` counts UTF-8 bytes while every JavaScript length
 * counts UTF-16 units, so a second cap here would bind at a different size than the one the
 * endpoint advertises. One limit, in one unit, checked in one place — and that place is the
 * route, before the body is read at all.
 */
export const previewInput = z.object({
  /**
   * Which page's space to authorise against. Required, and deliberately so: without a page
   * this route is a Markdown-to-HTML service for anyone with a session.
   */
  pageId: z.string().min(1),

  /**
   * The text to render, control-stripped by the **same function the autosave endpoint
   * strips with** — not a similar regex, the same import.
   *
   * This is not (only) about Postgres, which is what motivates the strip on the write path;
   * nothing here is stored. It is about the preview telling the truth. The draft that gets
   * saved, and therefore the version that gets published, is the stripped text. A preview
   * rendered from the unstripped text would be showing output the reader will never
   * produce, which is the single divergence this whole endpoint exists to make impossible.
   */
  markdown: z.string().transform(stripControl),
});

export type PreviewInput = z.infer<typeof previewInput>;
