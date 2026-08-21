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
  const nodes = new Map<string, TreeNode>();
  for (const row of rows) {
    nodes.set(row.id, { ...row, children: [] });
  }

  const roots: TreeNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;

    const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
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
  // would silently disappear. Detach one member per cycle and surface it as a root, so the
  // result is always finite and always contains every input row.
  let reachable = walkFromRoots();
  for (const row of rows) {
    if (reachable.has(row.id)) continue;

    const node = nodes.get(row.id);
    if (!node) continue;

    const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
    if (parent) {
      parent.children = parent.children.filter((child) => child.id !== node.id);
    }
    roots.push(node);
    reachable = walkFromRoots();
  }

  return roots;
}
