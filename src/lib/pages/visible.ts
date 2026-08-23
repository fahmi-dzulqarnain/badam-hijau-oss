import type { Prisma } from "@prisma/client";

/**
 * Every page read must exclude soft-deleted rows. Returns a complete `where`, exactly like
 * `readableSpace` — and like it, **must never be spread**:
 *
 *     where: { ...visiblePage(), OR: [...] }   // WRONG: a sibling OR silently replaces
 *     where: visiblePage({ OR: [...] })        // right
 *
 * Kept as a function rather than a constant so a caller cannot accidentally mutate a shared
 * object, and so the spread form is at least visibly odd.
 */
export function visiblePage(
  ...and: Prisma.PageWhereInput[]
): Prisma.PageWhereInput {
  return { AND: [{ deletedAt: null }, ...and] };
}
