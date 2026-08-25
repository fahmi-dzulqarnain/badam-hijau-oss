import { notFound } from "next/navigation";
import "@/components/shell.css";
import "@/components/doc.css";
import { requireViewer } from "@/lib/auth/viewer";
import { can } from "@/lib/authz/can";
import { getReadableSpaceByKey, listSpacePages } from "@/lib/pages/repo";
import { buildTree } from "@/lib/pages/tree";
import { DOC_INDEXES, indexHref, indexedDocTypes } from "@/lib/lifecycle/indexes";
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

  const rows = await listSpacePages(viewer, space.id);
  const tree = buildTree(rows);
  const build = buildInfo();

  /**
   * The generated indexes this space has anything to show — Task 10, spec §11.
   *
   * **No query pays for it.** `rows` is the listing the tree was already built from and it
   * already selects `docType`, so this is a filter over values in hand — the same rule
   * `manageHref` below follows, and the same rule the page route's Edit affordance follows.
   *
   * Offered only when the space holds at least one page of that type, which is a judgement about
   * navigation rather than about permissions: the index route itself is readable by anyone who can
   * read the space and renders an explanation when empty, so this is not a gate — it is not
   * putting two links to "nothing here yet" in the rail of a space that is all runbooks. A single
   * unpublished ADR is enough, deliberately: the rail already shows that page as an inert draft,
   * and the index lists it the same way.
   */
  const indexes = indexedDocTypes().flatMap((docType) => {
    const meta = DOC_INDEXES[docType];
    if (!meta || !rows.some((row) => row.docType === docType)) return [];
    return [{ href: indexHref(space.key, meta), label: meta.heading }];
  });

  return (
    <>
      <TopBar build={build} />
      <div className="shell">
        <NavRail
          spaceKey={space.key}
          spaceName={space.name}
          tree={tree}
          build={build}
          // Derived above from the rows the tree was built from, so no query pays for it.
          indexes={indexes}
          // Pure, and no query pays for it: `can()` reads the viewer's in-memory memberships
          // and the space's visibility, both already resolved above. Task 14b asks for the
          // reader's affordances to be free, and this is the same rule as the Edit link on the
          // page route — the layout is the one place that holds both halves of the question.
          manageHref={
            can(viewer, space, "MANAGE_SPACE")
              ? `/${encodeURIComponent(space.key)}/-/deleted`
              : null
          }
        />
        {children}
      </div>
    </>
  );
}
