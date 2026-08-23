import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { pageHref } from "@/lib/pages/href";
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
    <main className="doc landing">
      <h1>{space.name}</h1>
      {space.description ? <p>{space.description}</p> : null}

      <h2>Choose a module</h2>
      {modules.length === 0 ? (
        <p className="k">This space has no pages yet.</p>
      ) : (
        <ul>
          {modules.map((module) => (
            <li key={module.id}>
              {/* A draft module has no published version, so getPublishedPage would 404 a
                  link to it — for admins too. Show that it exists, as the nav rail does,
                  but do not offer a link that cannot work. */}
              {module.isDraft ? (
                <span className="landingdraft">
                  {module.title}
                  <span className="tag-draft">Draft</span>
                </span>
              ) : (
                <Link href={pageHref(space.key, module.path)}>{module.title}</Link>
              )}{" "}
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
                  {module.draftCount > 0
                    ? `${module.draftCount} ${module.draftCount === 1 ? "draft" : "drafts"}`
                    : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h2>Recently published</h2>
      {recent.length === 0 ? (
        <p className="k">Nothing has been published in this space yet.</p>
      ) : (
        <ul>
          {recent.map((page) => (
            <li key={page.id}>
              <Link href={pageHref(space.key, page.path)}>{page.title}</Link>{" "}
              <span className="k">
                {/* listRecentlyPublished's `where` requires both publishedVersionId and
                    publishedAt to be non-null, but Prisma types relations and nullable
                    columns from the schema, not from the filter — so these stay optional to
                    the compiler and the render stays total rather than asserting. */}
                {page.publishedVersion?.author.name}
                {page.publishedAt ? ` · ${dateFormat.format(page.publishedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
