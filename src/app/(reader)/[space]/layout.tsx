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
  // Passing the destination is what makes a deep link from Slack or a ticket survive a
  // cold visit. Without it the callback cookie is the bare origin and the reader lands on
  // the placeholder home page instead of the page they asked for.
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
