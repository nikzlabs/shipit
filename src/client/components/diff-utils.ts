import type { FileDiff } from "../../server/shared/types.js";

/** Tree node for the file tree sidebar. */
export interface FileTreeNode {
  name: string;
  /** Full path for leaf (file) nodes. */
  path?: string;
  /** Index into diff.files for leaf nodes. */
  fileIndex?: number;
  /** Child nodes for directory nodes. */
  children?: FileTreeNode[];
  /** Aggregated stats for directories. */
  insertions: number;
  deletions: number;
  /** File status for leaf nodes. */
  status?: FileDiff["status"];
}

/** Propagate insertion/deletion stats up from leaves into directory nodes. */
export function sumStats(node: FileTreeNode): void {
  if (!node.children) return;
  node.insertions = 0;
  node.deletions = 0;
  for (const child of node.children) {
    sumStats(child);
    node.insertions += child.insertions;
    node.deletions += child.deletions;
  }
}

/** Collapse single-child directories (e.g. `src` -> `client` becomes `src/client`). */
export function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.children) {
      node.children = collapse(node.children);
      if (node.children.length === 1 && node.children[0].children) {
        const child = node.children[0];
        return { ...child, name: `${node.name}/${child.name}` };
      }
    }
    return node;
  });
}

/** Build a nested tree from a flat list of FileDiff entries. */
export function buildFileTree(files: FileDiff[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", children: [], insertions: 0, deletions: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const parts = file.path.split("/");
    let current = root;

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isFile = j === parts.length - 1;

      if (isFile) {
        current.children!.push({
          name: part,
          path: file.path,
          fileIndex: i,
          insertions: file.insertions,
          deletions: file.deletions,
          status: file.status,
        });
      } else {
        let dir = current.children!.find((c) => c.children && c.name === part);
        if (!dir) {
          dir = { name: part, children: [], insertions: 0, deletions: 0 };
          current.children!.push(dir);
        }
        current = dir;
      }
    }
  }

  sumStats(root);
  return collapse(root.children!);
}

/** Single-letter status indicator for a file diff entry. */
export function statusIcon(status: FileDiff["status"]): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "renamed": return "R";
  }
}

/** Tailwind text color class for a file diff status. */
export function statusColor(status: FileDiff["status"]): string {
  switch (status) {
    case "added": return "text-(--color-success)";
    case "modified": return "text-(--color-warning)";
    case "deleted": return "text-(--color-error)";
    case "renamed": return "text-(--color-text-link)";
  }
}
