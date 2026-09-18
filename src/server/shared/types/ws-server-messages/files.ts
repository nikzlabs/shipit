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
  /** content holds a message instead of binary data. */
  isBinary?: boolean;
}

export interface WsFilesChanged {
  type: "files_changed";
  /** Workspace-relative paths. */
  paths: string[];
}
