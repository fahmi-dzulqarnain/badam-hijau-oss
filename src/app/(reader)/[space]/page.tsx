import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import {
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
} from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { summariseModules } from "@/lib/spaces/landing";
import { dateFormat } from "@/lib/format";

export default async function SpaceLanding({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space: spaceKey } = await params;
  const viewer = await requireViewer(`/${spaceKey}`);

  const space = await getReadableSpaceByKey(viewer, spaceKey);
  if (!space) notFound();

  const modules = summariseModules(buildTree(await listSpacePages(viewer, space.id)));
  const recent = await listRecentlyPublished(viewer, space.id);

  return (
    <main className="doc">
      <h1>{space.name}</h1>
      {space.description ? <p>{space.description}</p> : null}

      <h2>Choose a module</h2>
      <ul>
        {modules.map((module) => (
          <li key={module.id}>
            <Link href={`/${space.key}/${module.path}`}>{module.title}</Link>{" "}
            {module.pageCount > 0 || module.draftCount > 0 ? (
              <span className="k">
                {/* A childless module is just a page — a count of 0 next to a working link
                    reads as "empty section", so it is omitted entirely rather than shown as
                    zero. summariseModules counts descendants, which is correct; this is a
                    presentation decision. */}
                {module.pageCount > 0
                  ? `${module.pageCount} ${module.pageCount === 1 ? "page" : "pages"}`
                  : ""}
                {module.pageCount > 0 && module.draftCount > 0 ? " · " : ""}
                {module.draftCount > 0 ? `${module.draftCount} draft` : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <h2>Recently published</h2>
      <ul>
        {recent.map((page) => (
          <li key={page.id}>
            <Link href={`/${space.key}/${page.path}`}>{page.title}</Link>{" "}
            <span className="k">
              {page.publishedVersion?.author.name}
              {page.publishedAt ? ` · ${dateFormat.format(page.publishedAt)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
