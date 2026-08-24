import type { Route } from "next";
import Link from "next/link";
import type { TreeNode } from "@/lib/pages/tree";
import type { BuildInfo } from "@/lib/version/build";
import { pageHref } from "@/lib/pages/href";
import { NavLink } from "./NavLink";
import { RailFoot } from "./RailFoot";

type Props = {
  spaceKey: string;
  spaceName: string;
  tree: TreeNode[];
  build: BuildInfo;
  /**
   * The space-admin link, or `null` for everyone else. The layout decides — it has already
   * resolved the viewer and the space, so `can(viewer, space, "MANAGE_SPACE")` is a pure call
   * on values in hand and costs no query.
   *
   * A prop rather than a permission check inside this component, because `NavRail` is a server
   * component rendered from a layout that holds both halves, and threading a `Viewer` down into
   * a presentational component to re-answer a question its caller already answered is how a
   * permission ends up being decided in two places.
   */
  manageHref: string | null;
};

function NavNode({ spaceKey, node }: { spaceKey: string; node: TreeNode }) {
  const isDraft = node.publishedVersionId === null;
  const href = pageHref(spaceKey, node.path);

  // A draft has no published version, so getPublishedPage would 404 it. Show that the
  // page exists — members should know a draft is in flight — but do not offer a link
  // that cannot work.
  const renderSelf = (title: string) =>
    isDraft ? (
      <span className="navdraft">
        {title}
        <span className="tag-draft">Draft</span>
      </span>
    ) : (
      <NavLink href={href} title={title} />
    );

  if (node.children.length === 0) return renderSelf(node.title);

  return (
    <details className="navgroup" open>
      <summary>{node.title}</summary>
      <div className="navlist">
        {renderSelf("Overview")}
        {node.children.map((child) => (
          <NavNode key={child.id} spaceKey={spaceKey} node={child} />
        ))}
      </div>
    </details>
  );
}

export function NavRail({ spaceKey, spaceName, tree, build, manageHref }: Props) {
  return (
    <div className="rail-l">
      <nav aria-label={`${spaceName} navigation`}>
        {tree.map((node) => (
          <NavNode key={node.id} spaceKey={spaceKey} node={node} />
        ))}
      </nav>
      {/*
        Outside the page navigation, in its own labelled nav: it is not a page in the space and
        listing it among them would put an application route in a tree of documents — and the
        page-navigation landmark is what the e2e suite asserts a deleted page has left.
      */}
      {manageHref ? (
        <nav className="rail-admin" aria-label={`${spaceName} administration`}>
          <Link href={manageHref as Route}>Deleted pages</Link>
        </nav>
      ) : null}
      <RailFoot build={build} />
    </div>
  );
}
