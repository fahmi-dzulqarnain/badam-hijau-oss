import { DocIndex } from "@/components/DocIndex";

/**
 * `/{space}/-/rfcs` — spec §11's generated RFC index.
 *
 * The ADR route beside this one carries the argument for why both are four lines and why the `-/`
 * prefix cannot be shadowed by a page.
 */
export default async function RfcIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { space } = await params;
  const { status } = await searchParams;
  return <DocIndex spaceKey={space} docType="RFC" status={status} />;
}
