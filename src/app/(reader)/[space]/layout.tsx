import { notFound } from "next/navigation";
import "@/components/shell.css";
import { requireViewer } from "@/lib/auth/viewer";
import { getReadableSpaceByKey, listSpacePages } from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { buildInfo } from "@/lib/version/build";
import { NavRail } from "@/components/NavRail";
import { TopBar } from "@/components/TopBar";

export default async function SpaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  // Only the space key is available here, so a signed-out deep link lands on the space
  // root rather than the requested page. Preserving the full path needs middleware, which
  // is the only server-side place with the pathname — deferred because the credentials
  // provider imports Prisma, so it would require splitting this config into edge-safe and
  // node halves. Revisit if cold deep-link visits become common.
  const viewer = await requireViewer(`/${spaceKey}`);

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  // Unreadable and nonexistent are the same answer, so titles do not leak (spec §8).
  if (!space) notFound();

  const tree = buildTree(await listSpacePages(viewer, space.id));
  const build = buildInfo();

  return (
    <>
      <TopBar build={build} />
      <div className="shell">
        <NavRail
          spaceKey={space.key}
          spaceName={space.name}
          tree={tree}
          build={build}
        />
        {children}
      </div>
    </>
  );
}
