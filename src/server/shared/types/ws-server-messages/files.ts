import type { DocEntry, FileTreeNode } from "../domain-types.js";

export interface WsDocList {
  type: "doc_list";
  docs: DocEntry[];
}

export interface WsDocContent {
  type: "doc_content";
  path: string;
  content: string;
}

export interface WsFileTree {
  type: "file_tree";
  tree: FileTreeNode[];
}

export interface WsFileContent {
  type: "file_content";
  path: string;
  content: string;
  /** When true, the file is binary and `content` contains a human-readable message instead of file data. */
  isBinary?: boolean;
}

// ---- File watcher types ----

export interface WsFilesChanged {
  type: "files_changed";
  /** Relative paths of files that changed in the workspace. */
  paths: string[];
}
