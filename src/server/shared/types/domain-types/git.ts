export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
  refs: string[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  binary: boolean;
  /** Contents are data URIs; empty sides are absent or unavailable. LFS images can be non-binary. */
  image?: boolean;
  /** Contents resolve pointer stubs; an empty side can mean a failed fetch. */
  lfs?: boolean;
  oldContent: string;
  newContent: string;
}
