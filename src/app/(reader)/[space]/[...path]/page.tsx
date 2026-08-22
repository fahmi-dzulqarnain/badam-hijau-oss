import { notFound } from "next/navigation";
import "@/components/doc.css";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/viewer";
import { getPublishedPage } from "@/lib/pages/repo";
import { renderMarkdown } from "@/lib/markdown/render";
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
  const versionCount = await db.pageVersion.count({ where: { pageId: page.id } });
  const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

  return (
    <>
      <main className="doc">
        <Breadcrumbs spaceKey={space.key} spaceName={space.name} path={page.path} />
        <h1>{page.title}</h1>

        <div className="meta">
          <span>
            <span className="k">Status</span> {page.status}
          </span>
          <span>
            <span className="k">Published</span>{" "}
            {page.publishedAt ? formatter.format(page.publishedAt) : "—"}
          </span>
          <span>
            <span className="k">Commit</span> {version.gitSha ?? "not mirrored yet"}
          </span>
        </div>

        <div className="body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>

      <aside className="rail-r">
        <Toc headings={headings} />
        <PageInfoCard
          ownerName={page.owner?.name ?? null}
          reviewedAt={page.reviewedAt}
          docType={page.docType}
          status={page.status}
          versionCount={versionCount}
        />
      </aside>
    </>
  );
}

// `dangerouslySetInnerHTML` is safe here only because `renderMarkdown` sanitises. If that
// pipeline is ever changed to skip `rehype-sanitize`, this becomes stored XSS — the test in
// Task 5 Step 2 is what guards it.
