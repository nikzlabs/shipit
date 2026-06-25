// ---- Git types ----

export interface GitCommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
  refs: string[];
}

// ---- File tree types ----

export interface FileTreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
}

// ---- Diff types ----

export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  binary: boolean;
  /**
   * True when this is a binary *image* whose blob could be loaded for preview.
   * When set, `oldContent`/`newContent` hold base64 `data:` URIs (the empty
   * string for a side that doesn't exist — added has no old, deleted has no
   * new) so the diff viewer can render the two variants side by side instead
   * of the "binary file" placeholder. `binary` stays true alongside it.
   */
  image?: boolean;
  oldContent: string;
  newContent: string;
}
