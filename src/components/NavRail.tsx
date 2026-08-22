import type { TreeNode } from "@/lib/pages/tree";
import type { BuildInfo } from "@/lib/version/build";
import { NavLink } from "./NavLink";
import { RailFoot } from "./RailFoot";

type Props = {
  spaceKey: string;
  spaceName: string;
  tree: TreeNode[];
  build: BuildInfo;
};

function NavNode({ spaceKey, node }: { spaceKey: string; node: TreeNode }) {
  const self = (
    <NavLink
      href={`/${spaceKey}/${node.path}`}
      title={node.title}
      isDraft={node.publishedVersionId === null}
    />
  );

  if (node.children.length === 0) return self;

  return (
    <details className="navgroup" open>
      <summary>{node.title}</summary>
      <div className="navlist">
        {self}
        {node.children.map((child) => (
          <NavNode key={child.id} spaceKey={spaceKey} node={child} />
        ))}
      </div>
    </details>
  );
}

export function NavRail({ spaceKey, spaceName, tree, build }: Props) {
  return (
    <nav className="rail-l" aria-label={`${spaceName} navigation`}>
      {tree.map((node) => (
        <NavNode key={node.id} spaceKey={spaceKey} node={node} />
      ))}
      <RailFoot build={build} />
    </nav>
  );
}
