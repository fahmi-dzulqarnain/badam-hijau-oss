export type PageRow = {
  id: string;
  parentId: string | null;
  slug: string;
  path: string;
  title: string;
  status: string;
  docType: string;
  publishedVersionId: string | null;
};

export type TreeNode = PageRow & { children: TreeNode[] };

export function buildTree(rows: PageRow[]): TreeNode[] {
  // Keyed by id, so duplicate rows collapse to one node. Iterating this map rather than
  // `rows` below is what makes that safe: pushing the same node object twice would build
  // a structure a recursive consumer cannot walk.
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) {
      parent.children.push(node);
    } else {
      // No parent, or a parent outside this result set: surface it rather than lose it.
      roots.push(node);
    }
  }

  // Everything reachable by walking down from the roots. The `seen` guard is what makes
  // this terminate on a cyclic graph rather than looping forever.
  const walkFromRoots = (): Set<string> => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      for (const child of node.children) stack.push(child);
    }
    return seen;
  };

  // A parentId cycle leaves every member attached to a parent and none reachable from a
  // root, so without this the function would return an empty tree and the navigation rail
  // would silently disappear.
  let reachable = walkFromRoots();
  for (const node of nodes.values()) {
    if (reachable.has(node.id)) continue;

    // Climb to the cycle blocking this node and cut a member of *that*, rather than
    // promoting this node. Promoting the first unreachable row instead would flatten any
    // healthy subtree hanging below the cycle into extra top-level entries, and which
    // rows got flattened would depend on the query's ordering.
    const climbed = new Set<string>();
    let onCycle = node;
    while (!climbed.has(onCycle.id)) {
      climbed.add(onCycle.id);
      const next = onCycle.parentId === null ? undefined : nodes.get(onCycle.parentId);
      if (!next) break;
      onCycle = next;
    }

    const parent =
      onCycle.parentId === null ? undefined : nodes.get(onCycle.parentId);
    if (parent) {
      parent.children = parent.children.filter((child) => child.id !== onCycle.id);
    }
    roots.push(onCycle);
    reachable = walkFromRoots();
  }

  return roots;
}
