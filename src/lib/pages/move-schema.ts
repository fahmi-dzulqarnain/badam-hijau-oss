import { z } from "zod";

/**
 * The move request body.
 *
 * Pure: plain values in, plain values out, nothing imported from Prisma, so every rule here
 * unit-tests without a database. The route owns only the HTTP status codes.
 */

/**
 * The largest **declared** body the move endpoint will read, in BYTES.
 *
 * Bytes, not characters, for the reason `MAX_DRAFT_BODY_BYTES` spells out: `Content-Length`
 * counts UTF-8 bytes while every JavaScript length counts UTF-16 units.
 *
 * It is **not** the draft endpoint's constant, and that is a decision rather than an
 * oversight. The preview endpoint imports that one because it carries the same document the
 * next autosave will PUT, so the two limits are genuinely one limit. This body carries no
 * document at all — a cuid and a slug of at most 80 characters — so importing a
 * megabyte-sized cap here would advertise a document-sized body for a two-field form and
 * leave the endpoint reading and parsing a megabyte before Zod threw it away. 4 KB is
 * roughly forty times the largest legal body and still small enough to be uninteresting to
 * buffer.
 */
export const MAX_MOVE_BODY_BYTES = 4096;

/**
 * Shape only. **Every rule about what a slug may contain lives in `validateSlug`**, and
 * restating any of it here would give one rule two answers — the Zod one being strictly
 * worse, because it arrives as a 400 "that could not be read" instead of the sentence
 * `validateSlug` writes for the person who has to fix it ("Slugs are at most 80 characters;
 * this one is 93"). So there is no `.max()` on the slug: the byte cap above bounds the
 * request, and the module decides the slug.
 */
export const movePageInput = z.object({
  /**
   * The new parent, or `null` for the top level of the space.
   *
   * `.nullable()` and deliberately **not** `.optional()`, which mirrors `MovePageInput`'s
   * own signature and the reason it gives: on a field whose whole purpose is to carry
   * `null`, an "omit to keep the current value" reading makes `undefined` and `null` mean
   * different things, and a client that drops an untouched field would silently move the
   * page to the space root. A missing key is a broken client and gets a 400.
   */
  newParentId: z.string().min(1).nullable(),

  /** The new slug. The current one to reparent without renaming. */
  newSlug: z.string(),
});

export type MovePageBody = z.infer<typeof movePageInput>;
