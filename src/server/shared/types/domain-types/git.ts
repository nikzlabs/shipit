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
   * True when this file should render as side-by-side image panes rather than a
   * text diff. `oldContent`/`newContent` then hold base64 `data:` URIs, with the
   * empty string for a side that has no image to show — either because it
   * doesn't exist (added has no old, deleted has no new) or because its blob
   * couldn't be loaded (oversized, or unfetchable LFS content).
   *
   * Set for binary image blobs (where `binary` stays true alongside it) and for
   * LFS-tracked images (where `binary` is false — git sees an ASCII pointer stub
   * and calls the diff textual; see `lfs`).
   */
  image?: boolean;
  /**
   * True when either side's committed blob was a Git LFS pointer stub. The
   * contents here are then the *resolved* bytes (a `data:` URI for a raster,
   * source text for an SVG), never the pointer — but resolution is best-effort,
   * so an empty side means "couldn't fetch this version's content", which the
   * viewer labels distinctly from a genuinely absent side.
   */
  lfs?: boolean;
  oldContent: string;
  newContent: string;
}
