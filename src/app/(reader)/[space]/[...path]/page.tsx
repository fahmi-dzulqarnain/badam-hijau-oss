import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { getPublishedPage, listSpacePages } from "@/lib/pages/repo";
import { renderMarkdown } from "@/lib/markdown/render";
import { dateFormat } from "@/lib/format";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PageInfoCard } from "@/components/PageInfoCard";
import { Toc } from "@/components/Toc";

export default async function DocPage({
  params,
}: {
  params: Promise<{ space: string; path: string[] }>;
}) {
  const { space: spaceKey, path } = await params;
  // The full path is the right value at this call site, but note it rarely decides the
  // redirect: on a cold load the space layout also runs and its own requireViewer — which
  // has only the space key — will usually redirect first. Passing the full path here is
  // correct rather than effective, and becomes effective if the layout's auth call is ever
  // moved or removed.
  const viewer = await requireViewer(`/${spaceKey}/${path.join("/")}`);

  const result = await getPublishedPage(viewer, {
    spaceKey,
    path: path.join("/"),
  });
  if (!result) notFound();

  const { space, page, version } = result;
  const { html, headings } = await renderMarkdown(version.markdown);

  // Cache hit: the layout already called this with the same viewer object in this render.
  const rows = await listSpacePages(viewer, space.id);
  const byPath = new Map(rows.map((row) => [row.path, row]));

  const segments = page.path.split("/");
  const ancestors = segments.slice(0, -1).map((_, index) => {
    const path = segments.slice(0, index + 1).join("/");
    const row = byPath.get(path);
    return {
      path,
      title: row?.title ?? path.split("/").pop()!.replace(/-/g, " "),
      // An unpublished ancestor would 404, exactly as NavRail's draft entries would —
      // so it is shown as text, not offered as a link.
      isLinkable: row?.publishedVersionId != null,
    };
  });

  return (
    <>
      <main className="doc">
        <Breadcrumbs
          spaceKey={space.key}
          spaceName={space.name}
          ancestors={ancestors}
          title={page.title}
        />
        <h1>{page.title}</h1>

        <div className="meta">
          <span>
            <span className="k">Status</span> {page.status}
          </span>
          <span>
            <span className="k">Published</span>{" "}
            {page.publishedAt ? dateFormat.format(page.publishedAt) : "—"}
          </span>
          <span>
            <span className="k">Commit</span> {version.gitSha ?? "not mirrored yet"}
          </span>
        </div>

        {/* `dangerouslySetInnerHTML` is safe here only because `renderMarkdown` sanitises. If
            that pipeline is ever changed to skip `rehype-sanitize`, this becomes stored XSS —
            the test in Task 5 Step 2 is what guards it. */}
        <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>

      <aside className="rail-r" aria-label="Page information">
        <Toc headings={headings} />
        <PageInfoCard
          ownerName={page.owner?.name ?? null}
          reviewedAt={page.reviewedAt}
          docType={page.docType}
          status={page.status}
          versionCount={page._count.versions}
        />
      </aside>
    </>
  );
}
