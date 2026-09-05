import Link from "next/link";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { pageHref } from "@/lib/pages/href";
import {
  getReadableSpaceByKey,
  listRecentlyPublished,
  listSpacePages,
} from "@/lib/pages/repo";
import { listDueForReview } from "@/lib/pages/review";
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
  const due = await listDueForReview(viewer, space.id);

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

      {/*
        §11's third section, and §12's list: "pages whose owner has not confirmed them within the
        review interval".

        **Measured before this was written: nothing in the seeded corpus is due.** Every seeded
        page carries `reviewedAt = 2026-08-18` and today is 2026-09-05, so under the twelve-month
        default this section renders its empty sentence in both spaces — which is why the empty
        state below is a full sentence naming the interval rather than a blank space, and why no
        test of this feature is allowed to assert emptiness without a due fixture beside it.

        The rows carry no confirm button. The control lives on the page itself: confirming is a
        claim that the document is still correct, and a button here would let the list be cleared
        without opening anything. See `ConfirmReviewButton`.
      */}
      <h2>Due for review</h2>
      {due.rows.length === 0 ? (
        <p className="k">
          Nothing here has gone {due.intervalMonths} months without a review.
        </p>
      ) : (
        <ul>
          {due.rows.map((row) => (
            <li key={row.pageId}>
              <Link href={pageHref(space.key, row.path)}>{row.title}</Link>{" "}
              <span className="k">
                {/* §12's subject is the owner, so the row names them. "Unassigned" and not a
                    blank: `Page.ownerId` is nullable and every page this product creates is
                    unowned, so the common case must read as a fact rather than as a gap. It is
                    the same word `PageInfoCard` uses. */}
                {row.ownerName ?? "Unassigned"}
                {" · "}
                {/* The two tiers of the list, said in words. A page nobody has ever confirmed is
                    not "reviewed a long time ago", and the query orders them first. */}
                {row.reviewedAt
                  ? `reviewed ${dateFormat.format(row.reviewedAt)}`
                  : row.publishedAt
                    ? `never reviewed · published ${dateFormat.format(row.publishedAt)}`
                    : "never reviewed"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {due.truncated ? (
        <p className="k">
          {due.total} pages are due; the {due.rows.length} longest overdue are listed.
        </p>
      ) : null}
    </main>
  );
}
