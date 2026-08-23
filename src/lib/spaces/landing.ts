import type { TreeNode } from "@/lib/pages/tree";

export type ModuleSummary = {
  id: string;
  title: string;
  path: string;
  /**
   * The module itself has no published version. `getPublishedPage` requires one, so a link
   * to it would 404 for everyone including admins — the landing page renders it as inert
   * text, exactly as the nav rail does.
   */
  isDraft: boolean;
  pageCount: number;
  draftCount: number;
};

function countDescendants(node: TreeNode): { published: number; drafts: number } {
  let published = 0;
  let drafts = 0;

  for (const child of node.children) {
    if (child.publishedVersionId === null) drafts += 1;
    else published += 1;

    const nested = countDescendants(child);
    published += nested.published;
    drafts += nested.drafts;
  }

  return { published, drafts };
}

export function summariseModules(tree: TreeNode[]): ModuleSummary[] {
  return tree.map((module) => {
    const counts = countDescendants(module);
    return {
      id: module.id,
      title: module.title,
      path: module.path,
      isDraft: module.publishedVersionId === null,
      pageCount: counts.published,
      draftCount: counts.drafts,
    };
  });
}
