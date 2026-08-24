import type { Route } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/can";
import { getPublishedPage, listSpacePages, resolveRedirect } from "@/lib/pages/repo";
import { pageHref } from "@/lib/pages/href";
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

  const routePath = path.join("/");
  const result = await getPublishedPage(viewer, { spaceKey, path: routePath });

  // The redirect lookup lives HERE — inside the miss branch, after the page read has already
  // failed — and nowhere else. Two reasons, and the second is the load-bearing one:
  //
  // - **Cost.** Every page view in the product goes through the line above. A lookup placed
  //   before it, or unconditionally beside it, would add a second round trip to every
  //   successful read to answer a question that is only ever asked about a URL that missed.
  // - **Correctness.** A live page and a `Redirect` row can legitimately occupy the same
  //   path — a redirect goes dormant the moment something is created or moved on top of it,
  //   and Task 10 only reclaims the ones it makes live itself. Looking the redirect up first
  //   would send readers away from a page that exists and renders. The page read wins by
  //   construction, because it is the only one that runs on a hit.
  if (!result) {
    const moved = await resolveRedirect(viewer, { spaceKey, path: routePath });
    // 308, not the spec's 301. Both are permanent and both consolidate link equity; the
    // difference is that 301 has historically licensed intermediaries to rewrite the method
    // to GET on the retry and 308 forbids it, which for a GET-only reader route is a
    // guarantee this route wants and never needs to spend. The deciding constraint is that
    // an RSC redirect is not only an HTTP status: on a client-side navigation Next carries
    // it in the flight payload and the router re-issues it, so a hand-written 301 would need
    // middleware — which this project has deliberately deferred, and which could not run
    // this permission-checked lookup at the edge anyway. Reported as spec §14 drift rather
    // than silently satisfied.
    if (moved) permanentRedirect(pageHref(spaceKey, moved.path));
    // One hop. `resolveRedirect` returns the target's *current* path, so there is never a
    // second hop to follow: see its docstring for why `toPageId` makes a chain impossible
    // to represent rather than merely impolite to follow.
    notFound();
  }

  const { space, page, version } = result;
  const { html, headings } = await renderMarkdown(version.markdown);

  /**
   * The reader-to-editor affordance, and **no query pays for it**.
   *
   * `can()` is pure — it reads the viewer's in-memory memberships and the space's visibility,
   * both of which are already in hand: the viewer came from the cookie and `space` came back
   * from the page read this route had to make anyway. Task 14b's step is explicit that this
   * must not add a second query, and the reason is that the obvious implementations do: a
   * `listEditableSpaces`-style lookup, or a `canEditPage(viewer, page.id)` call, would each
   * re-read a row this render is already holding, on the hottest path in the product.
   *
   * Until this existed, Task 14's "a `VIEWER` sees no edit affordance" assertion was
   * unfalsifiable — there was no affordance for anyone, so the absence was universal rather
   * than role-dependent. That test now means something, and the editor's half of it is
   * asserted beside it.
   */
  const mayEdit = can(viewer, space, "EDIT");

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
          {/*
            In the meta row and NOT in the right rail, and that is a decision rather than a
            placement. `doc.css` hides `.rail-r` entirely below 1180px, so an Edit link in
            `PageInfoCard` would simply not exist on a laptop in a split window — the same
            shape of bug as Phase 1's bug dialog, which was rendered inside `.rail-l` and
            vanished with it below 860px, taking the user's typed text along. `.meta` is
            hidden at no width.

            It carries no page data — not the title, not the path, not the slug — so it cannot
            be the sixth shape of the horizontal-overflow class. The href is built from a cuid.
          */}
          {mayEdit ? (
            <Link className="doc-edit" href={`/edit/${page.id}` as Route}>
              Edit this page
            </Link>
          ) : null}
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
