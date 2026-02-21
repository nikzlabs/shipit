/**
 * File and documentation read services — file tree, file content, docs.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { scanFileTree } from "../file-tree.js";
import { findMarkdownFiles } from "../markdown.js";
import { ServiceError } from "./types.js";

/** Get file tree for a directory. */
export async function getFileTree(dir: string) {
  return scanFileTree(dir);
}

/** Get file content with safety checks (path traversal, binary, size). */
export async function getFileContent(
  dir: string,
  filePath: string,
): Promise<{ content: string; isBinary?: boolean }> {
  const safePath = path.resolve(dir, filePath);
  if (!safePath.startsWith(dir + "/")) {
    throw new ServiceError(400, "Invalid path");
  }
  const stat = await fs.stat(safePath);
  if (stat.size > 1_048_576) {
    return {
      content: `File is too large to display (${(stat.size / 1_048_576).toFixed(1)} MB). Maximum supported size is 1 MB.`,
      isBinary: true,
    };
  }
  const buf = await fs.readFile(safePath);
  if (buf.includes(0)) {
    return { content: "Binary file — cannot display.", isBinary: true };
  }
  return { content: buf.toString("utf-8") };
}

/** List markdown documentation files. */
export async function listDocs(dir: string) {
  return findMarkdownFiles(dir);
}

/** Get a single doc file's content. */
export async function getDocContent(
  dir: string,
  docPath: string,
): Promise<string> {
  const safePath = path.resolve(dir, docPath);
  if (!safePath.startsWith(dir + "/")) {
    throw new ServiceError(400, "Invalid path");
  }
  return fs.readFile(safePath, "utf-8");
}
