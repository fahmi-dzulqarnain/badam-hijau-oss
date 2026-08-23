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

export function NavRail({ spaceKey, spaceName, tree, build }: Props) {
  return (
    <div className="rail-l">
      <nav aria-label={`${spaceName} navigation`}>
        {tree.map((node) => (
          <NavNode key={node.id} spaceKey={spaceKey} node={node} />
        ))}
      </nav>
      <RailFoot build={build} />
    </div>
  );
}
