import { DocIndex } from "@/components/DocIndex";

/**
 * `/{space}/-/adrs` — spec §11's generated ADR index.
 *
 * Four lines, because everything that could differ between this and `-/rfcs` is data in
 * `src/lib/lifecycle/indexes.ts` and the body is one component. A second copy of that body is how
 * two surfaces come to agree on the day they are written and not afterwards.
 *
 * **`-/` is reserved, not lucky.** `validateSlug` refuses any slug beginning with `-` — its own
 * error code, its own test, and the check runs upstream of both `createPage` and `movePage` — so
 * no page can take the path `-/adrs` and shadow this route, today or after any move. The comment
 * in `validateSlug` names this exact URL, because this is the route it was written for; `-/deleted`
 * has stood on the same guarantee since Phase 2.
 */
export default async function AdrIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { space } = await params;
  const { status } = await searchParams;
  return <DocIndex spaceKey={space} docType="ADR" status={status} />;
}
